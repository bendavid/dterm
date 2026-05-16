import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { socketPath } from './paths';
import { LineStream, encode } from './protocol';
import type { ClientMessage, DaemonMessage } from './protocol';

import type * as ptyTypes from 'node-pty';
import { Terminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';

process.on('uncaughtException', e => {
    console.error('uncaughtException:', e?.stack ?? e);
    process.exit(2);
});
process.on('unhandledRejection', e => {
    console.error('unhandledRejection:', e);
});

let pty: typeof ptyTypes;
try {
    pty = require('node-pty') as typeof ptyTypes;
} catch (e) {
    console.error('failed to load node-pty:', (e as Error).message ?? e);
    console.error('node:', process.version, 'modules:', process.versions.modules, 'platform:', process.platform, process.arch);
    try {
        const ntpDir = path.dirname(require.resolve('node-pty'));
        const candidates = [
            path.join(ntpDir, '..', 'build', 'Release', 'pty.node'),
            path.join(ntpDir, '..', 'build', 'Debug', 'pty.node'),
            path.join(ntpDir, '..', 'prebuilds', `${process.platform}-${process.arch}`, 'pty.node'),
        ];
        for (const c of candidates) {
            try {
                require(c);
                console.error('  candidate loaded:', c);
            } catch (err) {
                console.error('  candidate failed:', c, '|', (err as Error).message ?? err);
            }
        }
    } catch (probeErr) {
        console.error('  candidate probe error:', (probeErr as Error).message ?? probeErr);
    }
    process.exit(3);
}

const IDLE_EXIT_MS = 30_000;
const DEFAULT_SCROLLBACK_LINES = 1000;

const DAEMON_VERSION: string = (() => {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'));
        return typeof pkg.version === 'string' ? pkg.version : 'unknown';
    } catch {
        return 'unknown';
    }
})();

interface Session {
    name: string;
    pty: ptyTypes.IPty;
    pid: number;
    emulator: Terminal;
    serializeAddon: SerializeAddon;
    linesCap: number;
    cols: number;
    rows: number;
    clients: Set<Client>;
    exited: boolean;
    lastProcessName: string;
    processPoller?: NodeJS.Timeout;
}

interface Client {
    socket: net.Socket;
    parser: LineStream<ClientMessage>;
    session?: Session;
}

const sessions = new Map<string, Session>();
const sessionLabels = new Map<string, string>();
const sessionLocations = new Map<string, { viewColumn: number; tabIndex: number }>();
const clients = new Set<Client>();
let scrollbackLinesCap = DEFAULT_SCROLLBACK_LINES;
let idleTimer: NodeJS.Timeout | undefined;

function log(...parts: unknown[]) {
    console.error(`[${new Date().toISOString()}]`, ...parts);
}

function send(client: Client, msg: DaemonMessage) {
    if (!client.socket.writable) return;
    client.socket.write(encode(msg));
}

function snapshotEmulatorState(session: Session): Buffer {
    const serialized = session.serializeAddon.serialize({
        scrollback: session.linesCap,
        excludeAltBuffer: true,
    });
    return Buffer.from(serialized, 'utf8');
}

function readForegroundProcessName(pid: number): string | undefined {
    if (process.platform !== 'linux') return undefined;
    try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const closeParen = stat.lastIndexOf(')');
        if (closeParen < 0) {
            log('proc: no close paren in stat for pid', pid);
            return undefined;
        }
        const fields = stat.slice(closeParen + 2).split(' ');
        const tpgid = parseInt(fields[5], 10);
        if (!Number.isFinite(tpgid) || tpgid <= 0) {
            log('proc: invalid tpgid for pid', pid, 'fields[5]=', fields[5]);
            return undefined;
        }
        return fs.readFileSync(`/proc/${tpgid}/comm`, 'utf8').trim();
    } catch (e) {
        log('proc: read failed for pid', pid, (e as Error).message);
        return undefined;
    }
}

function pollProcessName(session: Session): void {
    if (session.exited) return;
    const name = readForegroundProcessName(session.pid);
    if (!name) return;
    if (name === session.lastProcessName) return;
    log('process_name change', session.name, 'pid=', session.pid, 'name=', name);
    session.lastProcessName = name;
    const msg: DaemonMessage = { type: 'process_name', name };
    for (const c of session.clients) send(c, msg);
}

function buildShellEnv(extra: Record<string, string> | undefined): NodeJS.ProcessEnv {
    // When the client provides env, use it verbatim — the daemon survives across
    // VS Code restarts so its own process.env is stale and would leak old VS Code
    // IPC handles, ASKPASS paths, etc. into the new session. Fall back to the
    // daemon's env only if the client didn't send one (legacy callers).
    const env: NodeJS.ProcessEnv = extra !== undefined ? { ...extra } : { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_NO_ATTACH_CONSOLE;
    return env;
}

function createSession(
    name: string,
    cols: number,
    rows: number,
    opts: { cwd?: string; env?: Record<string, string>; shell?: string; shellArgs?: string[] },
): Session {
    const shell =
        opts.shell || process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/bash');
    const shellArgs = opts.shellArgs ?? [];
    const env = buildShellEnv(opts.env);
    const ptyProc = pty.spawn(shell, shellArgs, {
        name: 'xterm-256color',
        cols: Math.max(1, cols),
        rows: Math.max(1, rows),
        cwd: opts.cwd || env.HOME || (process.platform === 'win32' ? env.USERPROFILE : '/') || '/',
        env: env as { [k: string]: string },
    });

    const emulator = new Terminal({
        cols: Math.max(1, cols),
        rows: Math.max(1, rows),
        scrollback: scrollbackLinesCap,
        allowProposedApi: true,
    });
    const serializeAddon = new SerializeAddon();
    emulator.loadAddon(serializeAddon as unknown as Parameters<Terminal['loadAddon']>[0]);

    const session: Session = {
        name,
        pty: ptyProc,
        pid: ptyProc.pid,
        emulator,
        serializeAddon,
        linesCap: scrollbackLinesCap,
        cols,
        rows,
        clients: new Set(),
        exited: false,
        lastProcessName: '',
    };
    session.processPoller = setInterval(() => pollProcessName(session), 750);
    session.processPoller.unref?.();

    ptyProc.onData(data => {
        session.emulator.write(data);
        const buf = Buffer.from(data, 'utf8');
        const msg: DaemonMessage = { type: 'output', data: buf.toString('base64') };
        for (const c of session.clients) send(c, msg);
    });

    ptyProc.onExit(({ exitCode, signal }) => {
        session.exited = true;
        if (session.processPoller) {
            clearInterval(session.processPoller);
            session.processPoller = undefined;
        }
        log('session exit', name, exitCode, signal);
        for (const c of [...session.clients]) {
            send(c, { type: 'session_end', name, exitCode, signal });
            c.session = undefined;
        }
        session.clients.clear();
        sessions.delete(name);
        sessionLabels.delete(name);
        sessionLocations.delete(name);
        try { session.emulator.dispose(); } catch { /* ignore */ }
        scheduleIdleExit();
    });

    sessions.set(name, session);
    log('session created', name, shell, shellArgs.join(' '));
    return session;
}

function handleMessage(client: Client, msg: ClientMessage) {
    switch (msg.type) {
        case 'open': {
            cancelIdleExit();
            let session = sessions.get(msg.name);
            let created = false;
            if (!session) {
                session = createSession(msg.name, msg.cols, msg.rows, {
                    cwd: msg.cwd,
                    env: msg.env,
                    shell: msg.shell,
                    shellArgs: msg.shellArgs,
                });
                created = true;
            } else {
                if (msg.cols !== session.cols || msg.rows !== session.rows) {
                    try {
                        session.pty.resize(Math.max(1, msg.cols), Math.max(1, msg.rows));
                        session.emulator.resize(Math.max(1, msg.cols), Math.max(1, msg.rows));
                        session.cols = msg.cols;
                        session.rows = msg.rows;
                    } catch (e) {
                        log('resize failed', msg.name, e);
                    }
                }
            }
            if (client.session && client.session !== session) {
                client.session.clients.delete(client);
            }
            client.session = session;
            session.clients.add(client);
            send(client, { type: 'opened', name: msg.name, cols: session.cols, rows: session.rows, created });
            if (!created) {
                const snap = snapshotEmulatorState(session);
                if (snap.length > 0) {
                    send(client, { type: 'output', data: snap.toString('base64') });
                }
            }
            pollProcessName(session);
            if (session.lastProcessName) {
                send(client, { type: 'process_name', name: session.lastProcessName });
            }
            return;
        }
        case 'input': {
            if (!client.session || client.session.exited) return;
            const data = Buffer.from(msg.data, 'base64').toString('utf8');
            try {
                client.session.pty.write(data);
            } catch (e) {
                log('write failed', client.session.name, e);
            }
            return;
        }
        case 'resize': {
            if (!client.session || client.session.exited) return;
            try {
                client.session.pty.resize(Math.max(1, msg.cols), Math.max(1, msg.rows));
                client.session.emulator.resize(Math.max(1, msg.cols), Math.max(1, msg.rows));
                client.session.cols = msg.cols;
                client.session.rows = msg.rows;
            } catch (e) {
                log('resize failed', client.session.name, e);
            }
            return;
        }
        case 'list': {
            const names = [...sessions.keys()];
            const nameSet = new Set(names);
            const labels: Record<string, string> = {};
            for (const [name, label] of sessionLabels) {
                if (nameSet.has(name)) labels[name] = label;
            }
            const locations: Record<string, { viewColumn: number; tabIndex: number }> = {};
            for (const [name, loc] of sessionLocations) {
                if (nameSet.has(name)) locations[name] = loc;
            }
            send(client, { type: 'list_response', names, labels, locations });
            return;
        }
        case 'kill': {
            const s = sessions.get(msg.name);
            if (s) {
                try { s.pty.kill(); } catch { /* may already be dead */ }
            }
            send(client, { type: 'killed', name: msg.name });
            return;
        }
        case 'detach': {
            if (client.session) {
                client.session.clients.delete(client);
                client.session = undefined;
            }
            return;
        }
        case 'set_scrollback_lines': {
            const n = Math.max(1, Math.floor(msg.lines));
            scrollbackLinesCap = n;
            for (const s of sessions.values()) {
                s.linesCap = n;
                try { s.emulator.options.scrollback = n; } catch (e) { log('scrollback resize failed', s.name, e); }
            }
            return;
        }
        case 'set_label': {
            if (msg.label === undefined || msg.label === '') {
                if (sessionLabels.delete(msg.name)) {
                    log('label cleared', msg.name);
                }
            } else {
                if (sessionLabels.get(msg.name) !== msg.label) {
                    sessionLabels.set(msg.name, msg.label);
                    log('label set', msg.name, '=', msg.label);
                }
            }
            return;
        }
        case 'set_location': {
            if (msg.viewColumn === undefined || msg.tabIndex === undefined) {
                if (sessionLocations.delete(msg.name)) {
                    log('location cleared', msg.name);
                }
            } else {
                const prev = sessionLocations.get(msg.name);
                if (!prev || prev.viewColumn !== msg.viewColumn || prev.tabIndex !== msg.tabIndex) {
                    sessionLocations.set(msg.name, { viewColumn: msg.viewColumn, tabIndex: msg.tabIndex });
                    log('location set', msg.name, '= col', msg.viewColumn, 'idx', msg.tabIndex);
                }
            }
            return;
        }
        case 'shutdown': {
            log('shutdown requested');
            for (const s of sessions.values()) {
                try { s.pty.kill(); } catch { /* may already be dead */ }
            }
            setTimeout(() => process.exit(0), 100);
            return;
        }
        case 'version': {
            send(client, { type: 'version_response', version: DAEMON_VERSION });
            return;
        }
    }
}

function handleConnection(socket: net.Socket) {
    cancelIdleExit();
    const client: Client = { socket, parser: new LineStream<ClientMessage>() };
    clients.add(client);
    log('client connect');
    socket.on('data', chunk => {
        for (const msg of client.parser.feed(chunk)) {
            try {
                handleMessage(client, msg);
            } catch (e) {
                log('handler error', e);
                send(client, { type: 'error', message: String(e) });
            }
        }
    });
    const onGone = () => {
        if (client.session) client.session.clients.delete(client);
        clients.delete(client);
        log('client gone');
        scheduleIdleExit();
    };
    socket.on('close', onGone);
    socket.on('error', () => { /* swallow */ });
}

function scheduleIdleExit() {
    if (sessions.size > 0 || clients.size > 0) return;
    if (idleTimer) return;
    idleTimer = setTimeout(() => {
        if (sessions.size === 0 && clients.size === 0) {
            log('idle exit');
            process.exit(0);
        }
    }, IDLE_EXIT_MS);
    idleTimer.unref?.();
}

function cancelIdleExit() {
    if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
    }
}

async function probeRunning(sockPath: string): Promise<boolean> {
    return new Promise(resolve => {
        const s = net.createConnection(sockPath);
        const done = (r: boolean) => { try { s.destroy(); } catch {} resolve(r); };
        s.once('connect', () => done(true));
        s.once('error', () => done(false));
    });
}

async function main() {
    const sockPath = socketPath();
    if (process.platform !== 'win32') {
        fs.mkdirSync(path.dirname(sockPath), { recursive: true });
    }
    if (await probeRunning(sockPath)) {
        process.exit(0);
    }
    if (process.platform !== 'win32') {
        try { fs.unlinkSync(sockPath); } catch { /* not there */ }
    }

    const server = net.createServer(handleConnection);
    server.listen(sockPath, () => {
        if (process.platform !== 'win32') {
            try { fs.chmodSync(sockPath, 0o600); } catch { /* ignore */ }
        }
        log('listening', sockPath);
    });
    server.on('error', (e: NodeJS.ErrnoException) => {
        log('listen error', e);
        process.exit(1);
    });

    try { process.stdin.destroy(); } catch { /* not always present */ }

    // Survive parent exit (VS Code/Electron tends to SIGTERM its descendants on quit
    // even with detached:true). Graceful shutdown goes through the `shutdown` control
    // message; force-kill with SIGKILL if you really mean it.
    process.on('SIGTERM', () => log('SIGTERM ignored (use shutdown control message or SIGKILL)'));
    process.on('SIGHUP', () => log('SIGHUP ignored'));
    process.on('SIGINT', () => log('SIGINT ignored'));

    scheduleIdleExit();
}

main().catch(e => {
    log('fatal', e);
    process.exit(1);
});
