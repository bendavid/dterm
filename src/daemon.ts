import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
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

interface ProcessSession {
    name: string;
    proc: cp.ChildProcessWithoutNullStreams;
    pid: number;
    exited: boolean;
    clients: Set<Client>;
    stdinClosed: boolean;
    inputLineBuf: string;
    outputLineBuf: string;
    pendingInitRequestIds: Set<string>;
    cachedInitResponse: { type: string; response: Record<string, unknown> } | undefined;
    cachedBridgeState: Record<string, unknown> | undefined;
    cachedRemoteControlResponse: { type: string; response: Record<string, unknown> } | undefined;
    claudeSessionId: string | undefined;
    idleSince: number | undefined;
    ended: boolean;
    sessionEndReason: string | undefined;
}

interface Client {
    socket: net.Socket;
    parser: LineStream<ClientMessage>;
    session?: Session;
    processSession?: ProcessSession;
}

const sessions = new Map<string, Session>();
const processSessions = new Map<string, ProcessSession>();
const sessionLabels = new Map<string, string>();
const sessionLocations = new Map<string, { viewColumn: number; tabIndex: number }>();
const clients = new Set<Client>();
let scrollbackLinesCap = DEFAULT_SCROLLBACK_LINES;
let verboseStdioLog = false;
let idleTimer: NodeJS.Timeout | undefined;

function truncForLog(s: string, max = 800): string {
    return s.length > max ? s.slice(0, max) + '…(' + s.length + 'b)' : s;
}

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

function isObj(x: unknown): x is Record<string, unknown> {
    return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function handleHookEvent(sessionName: string, event: string, payload: unknown): void {
    const session = processSessions.get(sessionName);
    if (!session) {
        log(`hook_event ${event} for unknown session ${sessionName}`);
        return;
    }
    switch (event) {
        case 'SessionStart': {
            const sid = isObj(payload) && typeof payload.session_id === 'string' ? payload.session_id : undefined;
            const source = isObj(payload) && typeof payload.source === 'string' ? payload.source : undefined;
            if (!sid) {
                log(`SessionStart hook for ${session.name} missing session_id`);
                return;
            }
            if (session.claudeSessionId !== sid) session.claudeSessionId = sid;
            const canonical = `claude-${sid}`;
            if (session.name === canonical) {
                log(`SessionStart hook for ${session.name} (source=${source ?? '?'})`);
                return;
            }
            const oldName = session.name;
            const existing = processSessions.get(canonical);
            if (existing && existing !== session) {
                log(`SessionStart rekey conflict: ${oldName} -> ${canonical} already exists; not renaming`);
                return;
            }
            processSessions.delete(oldName);
            session.name = canonical;
            processSessions.set(canonical, session);
            log(`session rekeyed by SessionStart hook: ${oldName} -> ${canonical} (source=${source ?? '?'})`);
            return;
        }
        case 'Stop': {
            session.idleSince = Date.now();
            log(`Stop hook: session ${session.name} idle`);
            return;
        }
        case 'SessionEnd': {
            const reason = isObj(payload) && typeof payload.reason === 'string' ? payload.reason : undefined;
            session.ended = true;
            session.sessionEndReason = reason;
            log(`SessionEnd hook: session ${session.name} reason=${reason ?? '?'}`);
            return;
        }
        default:
            log(`unhandled hook event ${event} for ${session.name}`);
    }
}

function parseStdoutLineForRemoteControlResp(session: ProcessSession, line: string): void {
    if (!line.includes('"session_url"')) return;
    try {
        const obj = JSON.parse(line);
        if (
            obj && obj.type === 'control_response' &&
            obj.response && obj.response.subtype === 'success' &&
            obj.response.response && typeof obj.response.response === 'object' &&
            typeof obj.response.response.session_url === 'string'
        ) {
            session.cachedRemoteControlResponse = obj;
            log(
                `cached remote_control response for ${session.name} session_url=${obj.response.response.session_url}`,
            );
        }
    } catch {
        // not JSON
    }
}

function parseStdoutLineForBridgeState(session: ProcessSession, line: string): void {
    if (!line.includes('"bridge_state"')) return;
    try {
        const obj = JSON.parse(line);
        if (obj && obj.type === 'system' && obj.subtype === 'bridge_state') {
            session.cachedBridgeState = obj;
            log(`cached bridge_state for ${session.name} state=${obj.state ?? '?'}`);
        }
    } catch {
        // not JSON
    }
}

function parseStdoutLineForInit(session: ProcessSession, line: string): void {
    if (!line.includes('"control_response"')) return;
    try {
        const obj = JSON.parse(line);
        if (obj && obj.type === 'control_response' && obj.response && typeof obj.response === 'object') {
            const respId: string | undefined = obj.response.request_id;
            const subtype: string | undefined = obj.response.subtype;
            if (respId && subtype === 'success' && session.pendingInitRequestIds.has(respId)) {
                session.pendingInitRequestIds.delete(respId);
                session.cachedInitResponse = obj;
                log('cached init response for', session.name, 'reqId=', respId);
            }
        }
    } catch {
        // not JSON — fine
    }
}

function logPermissionTraffic(direction: 'claude->client' | 'client->claude', session: ProcessSession, line: string): void {
    if (!line.includes('"can_use_tool"') && !line.includes('"control_response"')) return;
    try {
        const obj = JSON.parse(line);
        if (obj?.type === 'control_request' && obj.request?.subtype === 'can_use_tool') {
            log(`perm ${direction} REQ session=${session.name} reqId=${obj.request_id} tool=${obj.request.tool_name ?? '?'}`);
        } else if (obj?.type === 'control_response' && obj.response) {
            const sub = obj.response.subtype;
            const reqId = obj.response.request_id;
            const inner = obj.response.response;
            const behavior = inner?.behavior;
            log(`perm ${direction} RESP session=${session.name} reqId=${reqId} subtype=${sub} behavior=${behavior ?? '?'}`);
        }
    } catch { /* ignore non-JSON */ }
}

function handleHookCallbackWhenUnattended(session: ProcessSession, line: string): void {
    if (session.clients.size > 0) return;
    if (!line.includes('"hook_callback"')) return;
    try {
        const obj = JSON.parse(line);
        if (obj?.type !== 'control_request') return;
        if (obj.request?.subtype !== 'hook_callback') return;
        const reqId: string | undefined = obj.request_id;
        if (!reqId) return;
        const callbackId = obj.request?.callback_id ?? '?';
        const hookEvent = obj.request?.input?.hook_event_name ?? '?';
        const out =
            JSON.stringify({
                type: 'control_response',
                response: {
                    subtype: 'success',
                    request_id: reqId,
                    response: { continue: true },
                },
            }) + '\n';
        try {
            session.proc.stdin.write(out);
            log(
                `stub hook_callback for ${session.name} reqId=${reqId} callback=${callbackId} event=${hookEvent}`,
            );
        } catch (e) {
            log('failed to write hook stub response', session.name, e);
        }
    } catch {
        // not JSON
    }
}

function handleProcessInputBytes(
    session: ProcessSession,
    data: Buffer,
    originatingClient: Client,
): void {
    session.inputLineBuf += data.toString('utf8');
    const toForward: string[] = [];
    let nl: number;
    while ((nl = session.inputLineBuf.indexOf('\n')) >= 0) {
        const line = session.inputLineBuf.slice(0, nl);
        session.inputLineBuf = session.inputLineBuf.slice(nl + 1);
        if (verboseStdioLog) log(`stdio client->claude session=${session.name} ${truncForLog(line)}`);
        const action = processInputLine(session, line, originatingClient);
        logPermissionTraffic('client->claude', session, line);
        if (action === 'forward') toForward.push(line + '\n');
    }
    if (toForward.length > 0) {
        try {
            session.proc.stdin.write(toForward.join(''));
        } catch (e) {
            log('process_input write failed', session.name, e);
        }
    }
}

function processInputLine(
    session: ProcessSession,
    line: string,
    originatingClient: Client,
): 'forward' | 'intercepted' {
    if (!line.includes('"control_request"')) return 'forward';
    try {
        const msg = JSON.parse(line);
        if (
            msg && msg.type === 'control_request' &&
            msg.request && msg.request.subtype === 'remote_control'
        ) {
            const reqId: string | undefined = msg.request_id;
            const enabled = msg.request.enabled;
            if (enabled === false) {
                // User wants to actually disable — invalidate cache, let claude do the work.
                session.cachedRemoteControlResponse = undefined;
                session.cachedBridgeState = undefined;
                log(`remote_control disable: clearing cache for ${session.name}`);
                return 'forward';
            }
            if (enabled === true && reqId && session.cachedRemoteControlResponse) {
                const cached = session.cachedRemoteControlResponse;
                const synthesized = {
                    type: cached.type,
                    response: {
                        ...cached.response,
                        request_id: reqId,
                    },
                };
                const out = JSON.stringify(synthesized) + '\n';
                send(originatingClient, {
                    type: 'process_output',
                    stream: 'stdout',
                    data: Buffer.from(out, 'utf8').toString('base64'),
                });
                log(`synthesized remote_control response for ${session.name} reqId=${reqId}`);
                if (session.cachedBridgeState) {
                    const bridgeLine = JSON.stringify(session.cachedBridgeState) + '\n';
                    send(originatingClient, {
                        type: 'process_output',
                        stream: 'stdout',
                        data: Buffer.from(bridgeLine, 'utf8').toString('base64'),
                    });
                }
                return 'intercepted';
            }
        }
        if (
            msg && msg.type === 'control_request' &&
            msg.request && msg.request.subtype === 'initialize'
        ) {
            const reqId: string | undefined = msg.request_id;
            if (session.cachedInitResponse) {
                const cached = session.cachedInitResponse;
                const synthesized = {
                    type: cached.type,
                    response: {
                        ...cached.response,
                        request_id: reqId,
                    },
                };
                const out = JSON.stringify(synthesized) + '\n';
                send(originatingClient, {
                    type: 'process_output',
                    stream: 'stdout',
                    data: Buffer.from(out, 'utf8').toString('base64'),
                });
                log('synthesized init response for', session.name, 'reqId=', reqId);
                if (session.cachedBridgeState) {
                    const bridgeLine = JSON.stringify(session.cachedBridgeState) + '\n';
                    send(originatingClient, {
                        type: 'process_output',
                        stream: 'stdout',
                        data: Buffer.from(bridgeLine, 'utf8').toString('base64'),
                    });
                    log(
                        'replayed bridge_state for',
                        session.name,
                        'state=',
                        session.cachedBridgeState.state ?? '?',
                    );
                }
                return 'intercepted';
            } else if (reqId) {
                session.pendingInitRequestIds.add(reqId);
            }
        }
    } catch {
        // not JSON — forward as-is
    }
    return 'forward';
}

function createProcessSession(
    name: string,
    executable: string,
    args: string[],
    opts: { cwd?: string; env?: Record<string, string> },
): ProcessSession {
    const env = buildShellEnv(opts.env);
    const proc = cp.spawn(executable, args, {
        cwd: opts.cwd || env.HOME || '/',
        env: env as NodeJS.ProcessEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
    });

    const session: ProcessSession = {
        name,
        proc,
        pid: proc.pid ?? -1,
        exited: false,
        clients: new Set(),
        stdinClosed: false,
        inputLineBuf: '',
        outputLineBuf: '',
        pendingInitRequestIds: new Set(),
        cachedInitResponse: undefined,
        cachedBridgeState: undefined,
        cachedRemoteControlResponse: undefined,
        claudeSessionId: undefined,
        idleSince: undefined,
        ended: false,
        sessionEndReason: undefined,
    };

    proc.stdout.on('data', (chunk: Buffer) => {
        const msg: DaemonMessage = { type: 'process_output', stream: 'stdout', data: chunk.toString('base64') };
        for (const c of session.clients) send(c, msg);
        session.outputLineBuf += chunk.toString('utf8');
        let nl: number;
        while ((nl = session.outputLineBuf.indexOf('\n')) >= 0) {
            const line = session.outputLineBuf.slice(0, nl);
            session.outputLineBuf = session.outputLineBuf.slice(nl + 1);
            if (verboseStdioLog) log(`stdio claude->client session=${session.name} ${truncForLog(line)}`);
            parseStdoutLineForInit(session, line);
            parseStdoutLineForBridgeState(session, line);
            parseStdoutLineForRemoteControlResp(session, line);
            logPermissionTraffic('claude->client', session, line);
            handleHookCallbackWhenUnattended(session, line);
        }
    });
    proc.stderr.on('data', (chunk: Buffer) => {
        const msg: DaemonMessage = { type: 'process_output', stream: 'stderr', data: chunk.toString('base64') };
        for (const c of session.clients) send(c, msg);
        if (verboseStdioLog) {
            const text = chunk.toString('utf8');
            for (const line of text.split('\n')) {
                if (line) log(`stderr session=${session.name} ${truncForLog(line)}`);
            }
        }
    });
    proc.stdin.on('error', () => {
        session.stdinClosed = true;
    });
    proc.on('exit', (exitCode, signal) => {
        session.exited = true;
        log('process session exit', name, exitCode, signal);
        for (const c of [...session.clients]) {
            send(c, { type: 'session_end', name, exitCode: exitCode ?? undefined, signal: typeof signal === 'string' ? undefined : signal ?? undefined });
            c.processSession = undefined;
        }
        session.clients.clear();
        processSessions.delete(name);
        sessionLabels.delete(name);
        sessionLocations.delete(name);
        scheduleIdleExit();
    });
    proc.on('error', e => {
        log('process spawn error', name, e);
    });

    processSessions.set(name, session);
    log('process session created', name, executable, args.join(' '));
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
            const names = [...sessions.keys(), ...processSessions.keys()];
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
            const ps = processSessions.get(msg.name);
            if (ps) {
                try { ps.proc.kill('SIGTERM'); } catch { /* may already be dead */ }
            }
            send(client, { type: 'killed', name: msg.name });
            return;
        }
        case 'detach': {
            if (client.session) {
                client.session.clients.delete(client);
                client.session = undefined;
            }
            if (client.processSession) {
                client.processSession.clients.delete(client);
                client.processSession = undefined;
            }
            return;
        }
        case 'open_process': {
            cancelIdleExit();
            let session = processSessions.get(msg.name);
            let created = false;
            if (!session) {
                session = createProcessSession(msg.name, msg.executable, msg.args, {
                    cwd: msg.cwd,
                    env: msg.env,
                });
                created = true;
            }
            if (client.processSession && client.processSession !== session) {
                client.processSession.clients.delete(client);
            }
            client.processSession = session;
            session.clients.add(client);
            send(client, { type: 'process_opened', name: msg.name, created, pid: session.pid });
            return;
        }
        case 'process_input': {
            const ps = client.processSession;
            if (!ps || ps.exited || ps.stdinClosed) return;
            handleProcessInputBytes(ps, Buffer.from(msg.data, 'base64'), client);
            return;
        }
        case 'process_close_stdin': {
            const ps = client.processSession;
            if (!ps || ps.stdinClosed) return;
            ps.stdinClosed = true;
            try {
                ps.proc.stdin.end();
            } catch (e) {
                log('process_close_stdin failed', ps.name, e);
            }
            return;
        }
        case 'hook_event': {
            handleHookEvent(msg.sessionName, msg.event, msg.payload);
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
        case 'set_verbose_stdio_log': {
            verboseStdioLog = msg.enabled;
            log('verboseStdioLog set to', msg.enabled);
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
            for (const ps of processSessions.values()) {
                try { ps.proc.kill('SIGTERM'); } catch { /* may already be dead */ }
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
        if (client.processSession) client.processSession.clients.delete(client);
        clients.delete(client);
        log('client gone');
        scheduleIdleExit();
    };
    socket.on('close', onGone);
    socket.on('error', () => { /* swallow */ });
}

function scheduleIdleExit() {
    if (sessions.size > 0 || processSessions.size > 0 || clients.size > 0) return;
    if (idleTimer) return;
    idleTimer = setTimeout(() => {
        if (sessions.size === 0 && processSessions.size === 0 && clients.size === 0) {
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
