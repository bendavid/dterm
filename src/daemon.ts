import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { sessionPrefix, socketPath } from './paths';
import { LineStream, encode } from './protocol';
import type { ClientMessage, DaemonMessage, SessionLayoutInfo, SessionPosition, ClientSelection } from './protocol';

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

// State conveyed via VS Code's `OSC 633 ; P ; <Key>=<Value>` shell-integration
// property protocol. These values are emitted by the shell-integration init
// script (bash/zsh/fish/pwsh) at load time or on each prompt and represent
// session-durable state -- as opposed to the per-command lifecycle events
// (OSC 633 ; A/B/C/D/E) which are not replayable.
//
// We tap xterm-headless's existing OSC 633 dispatch via parser.registerOsc
// Handler (same hook VS Code's own shellIntegrationAddon uses internally),
// remember the latest value per key, and re-emit all known properties at the
// start of every late-attach replay. Without this, late-attaching or
// reattaching clients miss the initial one-shot emissions and
// Terminal.shellIntegration.{cwd, ...} stays empty until the next prompt.
interface ShellIntegrationState {
    cwd?: string;
    promptType?: string;
    continuationPrompt?: string;
    prompt?: string;
    isWindows?: boolean;
    hasRichCommandDetection?: boolean;
}

function applyOsc633Property(payload: string, state: ShellIntegrationState): void {
    // payload is e.g. "P;Cwd=/some/dir" or "A" or "D;0" or "E;ls -la;<nonce>".
    // We only track P (Property) sub-commands; the others are events with no
    // durable state to replay.
    const semi = payload.indexOf(';');
    const sub = semi < 0 ? payload : payload.slice(0, semi);
    if (sub !== 'P') return;
    const rest = payload.slice(semi + 1);
    const eq = rest.indexOf('=');
    if (eq < 0) return;
    const key = rest.slice(0, eq);
    const value = rest.slice(eq + 1);
    switch (key) {
        case 'Cwd':                     state.cwd = value; break;
        case 'PromptType':              state.promptType = value; break;
        case 'ContinuationPrompt':      state.continuationPrompt = value; break;
        case 'Prompt':                  state.prompt = value; break;
        case 'IsWindows':               state.isWindows = value === 'True'; break;
        case 'HasRichCommandDetection': state.hasRichCommandDetection = value === 'True'; break;
        // Other keys (Task, etc.) are silently ignored.
    }
}

function serializeShellIntegrationState(s: ShellIntegrationState): string {
    const out: string[] = [];
    // HasRichCommandDetection first so VS Code's parser already trusts the
    // rich-detection path for any subsequent live A/B/C/D sequences from the
    // shell that arrive after the snapshot.
    if (s.hasRichCommandDetection) out.push('\x1b]633;P;HasRichCommandDetection=True\x07');
    if (s.isWindows === true)      out.push('\x1b]633;P;IsWindows=True\x07');
    if (s.promptType !== undefined)        out.push(`\x1b]633;P;PromptType=${s.promptType}\x07`);
    if (s.continuationPrompt !== undefined) out.push(`\x1b]633;P;ContinuationPrompt=${s.continuationPrompt}\x07`);
    if (s.prompt !== undefined)             out.push(`\x1b]633;P;Prompt=${s.prompt}\x07`);
    if (s.cwd !== undefined)                out.push(`\x1b]633;P;Cwd=${s.cwd}\x07`);
    return out.join('');
}

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
    // Captured via parser.registerOscHandler in createSession. Values update
    // continuously as the shell emits OSC 633 ; P sequences; the latest is
    // re-emitted at every reattach replay.
    shellIntegration: ShellIntegrationState;
    // Latest title set by the shell via OSC 0/2 (\x1b]0;<title>\x07 or
    // \x1b]2;<title>\x07). Captured via xterm-headless's onTitleChange
    // event. Surfaced to the extension via a sequence_title message so
    // ${sequence} in tabs.title templates can substitute correctly even
    // though VS Code's Pseudoterminal parser doesn't expose its own
    // sequence-source title via the public API.
    sequenceTitle: string;
    // Persistent layout state moved off VS Code workspaceState. VS Code
    // Server's workspaceStorage gets a -N suffix per concurrent window
    // (extHostStoragePaths.ts), so workspaceState wasn't actually a
    // workspace-shared store on Remote-SSH -- each client window got its
    // own isolated state.vscdb. The daemon is the natural source of truth
    // since it's one process per remote regardless of window count.
    //
    // label: workspace-shared. One value per session, latest writer wins
    //        across clients.
    // positions: per-client. clientId is the per-laptop UUID stored in
    //        the extension's SecretStorage (genuinely stable per local
    //        machine even on Remote-SSH).
    label?: string;
    positions: Map<string, SessionPosition>;
}

// Per-(clientId, workspaceTag) selection memory: which session is "active"
// for this client in this workspace, which is the panel-active selection,
// and which is the editor-active selection per editor column. Lives outside
// the Session struct because the selected session changes over time, and
// the selection memory should survive across individual session deaths and
// creates within the same workspace. Daemon process lifetime only -- no
// disk persistence, same lifetime guarantee as scrollback.
const clientSelections = new Map<string, Map<string, ClientSelection>>();

function getClientSelection(clientId: string, workspaceTag: string): ClientSelection {
    let perClient = clientSelections.get(clientId);
    if (!perClient) {
        perClient = new Map<string, ClientSelection>();
        clientSelections.set(clientId, perClient);
    }
    let selection = perClient.get(workspaceTag);
    if (!selection) {
        selection = {};
        perClient.set(workspaceTag, selection);
    }
    return selection;
}

interface Client {
    socket: net.Socket;
    parser: LineStream<ClientMessage>;
    session?: Session;
}

const sessions = new Map<string, Session>();
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
    // Defense-in-depth: also strip the bootstrap-internal shim-launcher
    // plumbing. The extension already drops these before sending env, but
    // a misbehaving / older client could leave them set and we don't want
    // them in the user's interactive shell env.
    delete env.DTERM_NODE_BIN;
    delete env.DTERM_STUB_JS;
    delete env.DTERM_BOOTSTRAP_SOCKET;
    delete env.DTERM_SESSION;
    delete env.DTERM_REAL_SHELL;
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

    const shellIntegration: ShellIntegrationState = {};
    // Tap xterm-headless's OSC dispatch for identifier 633. xterm-headless
    // handles all the byte-level streaming, terminator detection (BEL vs
    // ESC \), and payload reassembly across arbitrary chunk boundaries --
    // we just receive the parsed payload and pick out the P-subcommand
    // property values. Returning false leaves any other handlers (none in
    // practice) free to run; xterm-headless itself doesn't act on OSC 633.
    emulator.parser.registerOscHandler(633, payload => {
        applyOsc633Property(payload, shellIntegration);
        return false;
    });

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
        shellIntegration,
        sequenceTitle: '',
        positions: new Map<string, SessionPosition>(),
    };

    // Capture OSC 0/2 shell-set titles (e.g., bash PROMPT_COMMAND doing
    // `echo -ne "\033]0;$USER@$HOSTNAME:$PWD\007"`). xterm-headless's
    // onTitleChange already filters OSC 1 (icon-only) and dispatches only
    // for title-setting variants. Broadcast each change to attached
    // clients so ${sequence} in tabs.title templates can substitute it.
    emulator.onTitleChange(title => {
        if (session.sequenceTitle === title) return;
        session.sequenceTitle = title;
        const msg: DaemonMessage = { type: 'sequence_title', title };
        for (const c of session.clients) send(c, msg);
    });
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
            send(client, {
                type: 'opened',
                name: msg.name,
                cols: session.cols,
                rows: session.rows,
                created,
            });
            if (!created) {
                // Re-emit the latest OSC 633 ; P ; <Key>=<Value> sequences
                // we've observed from the shell-integration script.
                // SerializeAddon strips OSC sequences from the scrollback
                // snapshot, so without this, Terminal.shellIntegration.{cwd,
                // hasRichCommandDetection, ...} on the visible Pseudoterminal
                // would be empty until the next prompt re-emits them. Sent
                // before the visual snapshot so HasRichCommandDetection (and
                // similar flags that affect downstream parser behaviour) is
                // active by the time any subsequent live A/B/C/D sequences
                // arrive. For brand-new sessions (created=true) we let the
                // shell's own emission flow naturally to the client.
                const integration = serializeShellIntegrationState(session.shellIntegration);
                if (integration.length > 0) {
                    send(client, {
                        type: 'output',
                        data: Buffer.from(integration, 'utf8').toString('base64'),
                    });
                }
                const snap = snapshotEmulatorState(session);
                if (snap.length > 0) {
                    send(client, { type: 'output', data: snap.toString('base64') });
                }
            }
            pollProcessName(session);
            if (session.lastProcessName) {
                send(client, { type: 'process_name', name: session.lastProcessName });
            }
            if (session.sequenceTitle) {
                send(client, { type: 'sequence_title', title: session.sequenceTitle });
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
            // Layout-aware variant: when the client passes its UUID (and
            // optionally the workspace tag), include each session's label
            // and that-client's-position, plus the client's selection state
            // for the workspace. Old single-arg callers (diagnostic
            // command-line list) get just the names array.
            const wantsLayout = msg.clientId !== undefined;
            if (!wantsLayout) {
                send(client, { type: 'list_response', names });
                return;
            }
            const cid = msg.clientId!;
            const wsPrefix = msg.workspaceTag ? sessionPrefix(msg.workspaceTag) : '';
            const sessionsInfo: SessionLayoutInfo[] = [];
            for (const [name, s] of sessions) {
                if (wsPrefix && !name.startsWith(wsPrefix)) continue;
                const position = s.positions.get(cid);
                sessionsInfo.push({
                    name,
                    label: s.label,
                    position,
                });
            }
            const selection = msg.workspaceTag
                ? clientSelections.get(cid)?.get(msg.workspaceTag)
                : undefined;
            send(client, {
                type: 'list_response',
                names,
                sessions: sessionsInfo,
                selection: selection ? { ...selection } : undefined,
            });
            return;
        }
        case 'set_session_label': {
            const s = sessions.get(msg.name);
            if (!s) {
                send(client, { type: 'error', message: `unknown session ${msg.name}` });
                return;
            }
            s.label = msg.label === null ? undefined : msg.label;
            send(client, { type: 'layout_ack' });
            return;
        }
        case 'set_session_position': {
            const s = sessions.get(msg.name);
            if (!s) {
                send(client, { type: 'error', message: `unknown session ${msg.name}` });
                return;
            }
            if (msg.position === null) {
                s.positions.delete(msg.clientId);
            } else {
                s.positions.set(msg.clientId, msg.position);
            }
            send(client, { type: 'layout_ack' });
            return;
        }
        case 'set_client_selection': {
            const sel = getClientSelection(msg.clientId, msg.workspaceTag);
            // Partial update: each provided key overwrites, including
            // explicit undefineds (to clear a slot).
            if ('active' in msg.selection) sel.active = msg.selection.active;
            if ('panelActive' in msg.selection) sel.panelActive = msg.selection.panelActive;
            if ('editorActive' in msg.selection) sel.editorActive = msg.selection.editorActive;
            send(client, { type: 'layout_ack' });
            return;
        }
        case 'clear_client_layout': {
            // Wipes everything this client has stored for the given
            // workspace (or for all workspaces if workspaceTag is omitted):
            // selection state plus per-session positions filtered by the
            // workspace prefix.
            let cleared = 0;
            const wsPrefix = msg.workspaceTag ? sessionPrefix(msg.workspaceTag) : '';
            const perClient = clientSelections.get(msg.clientId);
            if (perClient) {
                if (msg.workspaceTag) {
                    if (perClient.delete(msg.workspaceTag)) cleared++;
                } else {
                    cleared += perClient.size;
                    perClient.clear();
                }
            }
            for (const [name, s] of sessions) {
                if (wsPrefix && !name.startsWith(wsPrefix)) continue;
                if (s.positions.delete(msg.clientId)) cleared++;
            }
            send(client, { type: 'layout_ack', cleared });
            return;
        }
        case 'clear_all_layouts': {
            // Wipes every client's layout state for the given workspace
            // (or globally if workspaceTag is omitted). Labels are
            // workspace-shared so they go with the workspace too.
            let cleared = 0;
            const wsPrefix = msg.workspaceTag ? sessionPrefix(msg.workspaceTag) : '';
            for (const perClient of clientSelections.values()) {
                if (msg.workspaceTag) {
                    if (perClient.delete(msg.workspaceTag)) cleared++;
                } else {
                    cleared += perClient.size;
                    perClient.clear();
                }
            }
            for (const [name, s] of sessions) {
                if (wsPrefix && !name.startsWith(wsPrefix)) continue;
                cleared += s.positions.size;
                s.positions.clear();
                if (s.label !== undefined) { s.label = undefined; cleared++; }
            }
            send(client, { type: 'layout_ack', cleared });
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
        case 'get_pid': {
            send(client, { type: 'pid_response', pid: process.pid });
            return;
        }
        case 'get_session_env': {
            // Read the current env of the daemon-side shell from
            // /proc/<pid>/environ. Used by the extension's
            // dterm.checkEnvFreshness diagnostic to detect drift between the
            // env this shell was spawned with and what VS Code would inject
            // for a freshly-spawned terminal now.
            const session = sessions.get(msg.name);
            if (!session) {
                send(client, { type: 'error', message: `unknown session ${msg.name}` });
                return;
            }
            const env: Record<string, string> = {};
            try {
                const raw = fs.readFileSync(`/proc/${session.pid}/environ`);
                for (const entry of raw.toString('utf8').split('\0')) {
                    if (!entry) continue;
                    const eq = entry.indexOf('=');
                    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
                }
            } catch (e) {
                send(client, { type: 'error', message: `failed to read environ for pid ${session.pid}: ${(e as Error).message}` });
                return;
            }
            send(client, { type: 'session_env_response', name: msg.name, env });
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
        log('listening', sockPath, 'instance=' + (process.env.DTERM_INSTANCE || '(default)'));
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
