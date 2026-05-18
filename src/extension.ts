import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as cp from 'child_process';
import * as net from 'net';
import * as os from 'os';
import { oneShot, readDaemonLogTail, isDaemonAlive } from './client';
import { agentDir, daemonLogPath, socketPath } from './paths';
import { encode, LineStream, type ClientMessage, type DaemonMessage } from './protocol';

const PROFILE_ID = 'dterm.profile';

let activeCtx: vscode.ExtensionContext | undefined;
let logChannel: vscode.OutputChannel | undefined;
let pollTimer: NodeJS.Timeout | undefined;
const pendingFocus = new Set<string>();

// Per-session UI metadata (label, editor-area location, panel order). Stored
// in workspaceState under a client-specific key derived from vscode.env.machineId
// so two laptops connecting to the same remote get independent layouts --
// matching how VS Code's built-in terminal layout is local-to-client.
interface SessionMeta {
    label?: string;
    viewColumn?: number;
    tabIndex?: number;
    // Position among panel dterm terminals (0 = first). Undefined for editor-area
    // sessions. Used to restore creation order so panel tabs appear as the user
    // arranged them, not alphabetical by session name.
    panelIndex?: number;
}

function metaKey(sessionName: string): string {
    return `client.${vscode.env.machineId}.session.${sessionName}`;
}

// Separate key for the focused-terminal session. Not per-session because at most
// one terminal is active at a time; storing as a flat key avoids churn-y meta
// updates across every session.
function activeKey(): string {
    return `client.${vscode.env.machineId}.active`;
}

function getActive(): string | undefined {
    if (!activeCtx) return undefined;
    return activeCtx.workspaceState.get<string>(activeKey());
}

async function setActive(sessionName: string | undefined): Promise<void> {
    if (!activeCtx) return;
    await activeCtx.workspaceState.update(activeKey(), sessionName);
}

function getMeta(sessionName: string): SessionMeta | undefined {
    if (!activeCtx) return undefined;
    return activeCtx.workspaceState.get<SessionMeta>(metaKey(sessionName));
}

async function setMeta(sessionName: string, meta: SessionMeta | undefined): Promise<void> {
    if (!activeCtx) return;
    const empty = !meta || (
        meta.label === undefined
        && meta.viewColumn === undefined
        && meta.panelIndex === undefined
    );
    await activeCtx.workspaceState.update(metaKey(sessionName), empty ? undefined : meta);
}

function metaEqual(a: SessionMeta | undefined, b: SessionMeta | undefined): boolean {
    return (a?.label === b?.label)
        && (a?.viewColumn === b?.viewColumn)
        && (a?.tabIndex === b?.tabIndex)
        && (a?.panelIndex === b?.panelIndex);
}

function log(line: string): void {
    if (logChannel) logChannel.appendLine(`[${new Date().toISOString()}] ${line}`);
}

// Terminals dterm owns are Pseudoterminal-backed (extension-controlled stdio).
// vscode.Terminal's creationOptions for ExtensionTerminalOptions doesn't carry
// the env we used to encode the session name into, so we maintain side maps.
// terminalToSession is queried by all the snapshot/disposal handlers; the
// reverse map ptyBySession is used to update name-lock state when we detect
// user renames during polling.
const terminalToSession = new WeakMap<vscode.Terminal, string>();
const ptyBySession = new Map<string, DtermPseudoterminal>();

function snapshotLabels(): Promise<void> {
    const writes: Promise<void>[] = [];
    for (const t of vscode.window.terminals) {
        const sName = sessionNameOf(t);
        if (!sName) continue;
        const pty = ptyBySession.get(sName);
        if (!pty) continue;
        const current = getMeta(sName);
        // Inline tab rename to empty resolves t.name to '' for Pseudoterminals
        // (because _processName -- the empty-rename fallback -- stays empty
        // for extension-controlled terminals). Treat that as "user cleared
        // the label": unlock the Pseudoterminal so daemon process_name updates
        // drive the tab name again, and drop any saved label.
        if (t.name === '') {
            pty.unlockName();
            if (current?.label !== undefined) {
                writes.push(setMeta(sName, { ...current, label: undefined }));
            }
            continue;
        }
        if (!pty.detectAndLockUserRename()) continue;
        if (current?.label !== t.name) {
            writes.push(setMeta(sName, { ...current, label: t.name }));
        }
    }
    return Promise.all(writes).then(() => undefined);
}

function snapshotLocations(): Promise<void> {
    // Find editor-area terminals via tabGroups. Terminals in the panel are absent
    // from tabGroups entirely and end up with viewColumn=undefined.
    const inEditor = new Map<string, { viewColumn: number; tabIndex: number }>();
    for (const group of vscode.window.tabGroups.all) {
        for (let i = 0; i < group.tabs.length; i++) {
            const tab = group.tabs[i];
            if (!(tab.input instanceof vscode.TabInputTerminal)) continue;
            for (const t of vscode.window.terminals) {
                const sName = sessionNameOf(t);
                if (!sName) continue;
                if (tab.label === t.name) {
                    inEditor.set(sName, { viewColumn: group.viewColumn, tabIndex: i });
                    break;
                }
            }
        }
    }
    // Walk vscode.window.terminals in order; it reflects creation order plus
    // any user drag-reorder in the panel. Assign panelIndex to each dterm
    // panel terminal (those not in inEditor) in encounter order. Non-dterm
    // terminals interleave but we filter them out, so panelIndex is dense
    // within dterm-only order.
    const panelOrder = new Map<string, number>();
    let nextPanelIdx = 0;
    for (const t of vscode.window.terminals) {
        const sName = sessionNameOf(t);
        if (!sName) continue;
        if (inEditor.has(sName)) continue;
        panelOrder.set(sName, nextPanelIdx++);
    }
    const writes: Promise<void>[] = [];
    for (const t of vscode.window.terminals) {
        const sName = sessionNameOf(t);
        if (!sName) continue;
        const target = inEditor.get(sName);
        const current = getMeta(sName);
        const next: SessionMeta = {
            ...current,
            viewColumn: target?.viewColumn,
            tabIndex: target?.tabIndex,
            panelIndex: target ? undefined : panelOrder.get(sName),
        };
        if (!metaEqual(current, next)) {
            writes.push(setMeta(sName, next));
        }
    }
    // Active terminal -- a flat workspaceState key, not per-session.
    const active = vscode.window.activeTerminal;
    const activeName = active ? sessionNameOf(active) : undefined;
    if (getActive() !== activeName) {
        writes.push(setActive(activeName));
    }
    return Promise.all(writes).then(() => undefined);
}

function ensurePolling(): void {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
        const hasAny = vscode.window.terminals.some(t => sessionNameOf(t) !== undefined);
        if (!hasAny) {
            clearInterval(pollTimer!);
            pollTimer = undefined;
            return;
        }
        void snapshotLabels();
        void snapshotLocations();
    }, 2000);
    pollTimer.unref?.();
}

function pruneStaleMeta(liveSessionNames: Set<string>): void {
    if (!activeCtx) return;
    const prefix = `client.${vscode.env.machineId}.session.`;
    for (const key of activeCtx.workspaceState.keys()) {
        if (!key.startsWith(prefix)) continue;
        const session = key.slice(prefix.length);
        if (!liveSessionNames.has(session)) {
            void activeCtx.workspaceState.update(key, undefined);
        }
    }
    // Drop the saved-active key too if it points at a dead session, so reattach
    // doesn't try to focus a nonexistent terminal.
    const active = getActive();
    if (active && !liveSessionNames.has(active)) {
        void setActive(undefined);
    }
}

function workspaceTag(): string | undefined {
    const wsFile = vscode.workspace.workspaceFile?.fsPath;
    const folders = vscode.workspace.workspaceFolders;
    let basis: string;
    let label: string;
    if (wsFile && !wsFile.startsWith('untitled:')) {
        basis = wsFile;
        label = path.basename(wsFile, path.extname(wsFile));
    } else if (folders && folders.length > 0) {
        basis = folders.map(f => f.uri.fsPath).sort().join('|');
        label = path.basename(folders[0].uri.fsPath);
    } else {
        return undefined;
    }
    const hash = crypto.createHash('sha1').update(basis).digest('hex').slice(0, 8);
    const safe = label.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24) || 'workspace';
    return `${safe}-${hash}`;
}

interface DaemonSessions {
    names: string[];
}

async function fetchDaemonSessions(): Promise<DaemonSessions | undefined> {
    const resp = await oneShot(
        daemonScriptPath(),
        { type: 'list' },
        m => m.type === 'list_response',
    );
    if (!resp || resp.type !== 'list_response') return undefined;
    return { names: resp.names };
}

async function allocateSessionName(): Promise<string | undefined> {
    const tag = workspaceTag();
    if (!tag) return undefined;
    const prefix = `vscode-${tag}-`;
    const live = await fetchDaemonSessions();
    const used = new Set<string>(live?.names ?? []);
    for (const t of vscode.window.terminals) {
        const n = sessionNameOf(t);
        if (n) used.add(n);
    }
    let n = 1;
    for (const name of used) {
        if (!name.startsWith(prefix)) continue;
        const idx = parseInt(name.slice(prefix.length), 10);
        if (Number.isFinite(idx) && idx >= n) n = idx + 1;
    }
    return `${prefix}${n}`;
}

function daemonScriptPath(): string {
    if (!activeCtx) throw new Error('dterm: extension not activated');
    return path.join(activeCtx.extensionPath, 'out', 'daemon.js');
}

async function pushScrollbackLines(): Promise<void> {
    const lines = effectiveScrollbackLines();
    log(`config: pushing scrollbackLines=${lines}`);
    await oneShot(
        daemonScriptPath(),
        { type: 'set_scrollback_lines', lines },
        () => true,
        500,
    );
}

async function pushAllDaemonSettings(): Promise<void> {
    await pushScrollbackLines();
}

function effectiveScrollbackLines(): number {
    const explicit = vscode.workspace.getConfiguration('dterm').get<number>('scrollbackLines', 0);
    if (explicit > 0) return Math.floor(explicit);
    const xterm = vscode.workspace
        .getConfiguration('terminal.integrated')
        .get<number>('scrollback', 1000);
    return Math.max(1, Math.floor(xterm));
}

function shellConfig() {
    const cfg = vscode.workspace.getConfiguration('dterm');
    const shell = (cfg.get<string>('shell', '') || '').trim();
    return {
        shell: shell.length > 0 ? shell : undefined,
        shellArgs: cfg.get<string[]>('shellArgs', []) ?? [],
        scrollbackLines: effectiveScrollbackLines(),
    };
}

function resolveShellBinary(configured: string | undefined): string {
    if (configured && configured.length > 0) return configured;
    return process.env.SHELL || '/bin/bash';
}

interface ManagedSocket {
    envVar: string;
    linkName: string;
}

// VS Code-managed Unix sockets that go stale across server restarts / client
// reconnects. We expose a per-workspace symlink path to the shell and re-point
// it whenever the upstream value in process.env changes -- running shells keep
// the same env values but transparently start using the new target on the
// next connect().
//
// SSH_AUTH_SOCK is standard SSH agent forwarding; VSCODE_GIT_IPC_HANDLE is
// the askpass/credential IPC the git extension exports into terminals. We
// don't track VSCODE_IPC_HOOK_CLI -- VS Code doesn't actually inject it into
// standard terminals (the `code` CLI uses its own discovery), so our override
// here was always a no-op.
const MANAGED_SOCKETS: ManagedSocket[] = [
    { envVar: 'SSH_AUTH_SOCK',         linkName: 'ssh-auth.sock' },
    { envVar: 'VSCODE_GIT_IPC_HANDLE', linkName: 'vscode-git-ipc.sock' },
];

function updateSymlinkAtomic(target: string, linkPath: string): boolean {
    const tmp = `${linkPath}.tmp.${process.pid}.${Date.now()}`;
    try {
        fs.symlinkSync(target, tmp);
    } catch (e) {
        log(`symlink create failed: ${linkPath} -> ${target}: ${(e as Error).message}`);
        return false;
    }
    try {
        fs.renameSync(tmp, linkPath);
        return true;
    } catch (e) {
        log(`symlink rename failed: ${linkPath}: ${(e as Error).message}`);
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        return false;
    }
}

function refreshManagedSockets(): Record<string, string> {
    const overrides: Record<string, string> = {};
    const tag = workspaceTag();
    if (!tag) return overrides;
    const dir = agentDir(tag);
    let dirEnsured = false;
    for (const m of MANAGED_SOCKETS) {
        const upstream = process.env[m.envVar];
        if (!upstream) continue;
        if (!dirEnsured) {
            try {
                fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
                dirEnsured = true;
            } catch (e) {
                log(`failed to create agent dir ${dir}: ${(e as Error).message}`);
                return overrides;
            }
        }
        const linkPath = path.join(dir, m.linkName);
        let currentTarget: string | undefined;
        try { currentTarget = fs.readlinkSync(linkPath); } catch { /* absent */ }
        if (currentTarget !== upstream) {
            if (updateSymlinkAtomic(upstream, linkPath)) {
                log(`symlink: ${m.envVar} -> ${upstream}`);
            }
        }
        overrides[m.envVar] = linkPath;
    }
    return overrides;
}

// Pick a stub symlink whose basename matches the shell. VS Code's shell-
// integration injection is keyed on the basename of shellPath, so launching
// via `out/shims/bash` makes VS Code inject `--init-file` and friends for the
// real bash that the daemon spawns. For shells VS Code doesn't recognize
// (anything other than bash/zsh/fish), we use the `dterm` shim — the
// unrecognized basename means VS Code skips injection entirely, and
// DTERM_REAL_SHELL tells the stub which binary the daemon should actually
// spawn.
// Pseudoterminal that connects directly to the daemon over its Unix socket and
// bridges stdio for the user-facing terminal. The bootstrap stub has already
// captured shell-integration env and handed it to the daemon by the time we
// instantiate; here we just attach as a client and forward.
class DtermPseudoterminal implements vscode.Pseudoterminal {
    private writeEmitter = new vscode.EventEmitter<string>();
    private closeEmitter = new vscode.EventEmitter<number | void>();
    private nameEmitter = new vscode.EventEmitter<string>();

    onDidWrite = this.writeEmitter.event;
    onDidClose = this.closeEmitter.event;
    onDidChangeName = this.nameEmitter.event;

    private sock: net.Socket | undefined;
    private parser = new LineStream<DaemonMessage>();
    private cols: number;
    private rows: number;
    private term: vscode.Terminal | undefined;
    // Last name we pushed via onDidChangeName. If t.name diverges from this we
    // know a user rename happened (VS Code exposes no rename event).
    private lastFiredName: string | undefined;
    // Locked once a user rename is observed (or once we restore a saved label).
    // While locked, daemon process_name updates do not override the visible name.
    private nameLocked: boolean;
    // The latest foreground process name the daemon reported, regardless of
    // whether the name is currently locked. Used to re-fire onDidChangeName
    // immediately when unlocking, so the user doesn't have to wait for the
    // next daemon process_name event for the tab to update.
    private lastProcessNameSeen: string | undefined;
    // Async-attach state. The visible terminal is shown immediately and
    // bootstrap runs in parallel so the user sees a terminal in tens of ms
    // instead of waiting for daemon+shell-integration setup. We can only
    // connect after both VS Code has called open() and bootstrap has acked.
    private opened = false;
    private bootstrapDone = false;
    private closed = false;
    private inputQueue: string[] = [];
    // Bootstrap error buffered until open() so the user actually sees it
    // (writeEmitter.fire before VS Code has subscribed is dropped on the floor).
    private pendingError: string | undefined;
    // Resolved the first time VS Code calls our open() callback. reconnectAll
    // awaits this between creates so each tab's renderer is instantiated while
    // it's the active tab in its group, before the next sibling steals active
    // status and pushes it to the background. The previous unworkable failure
    // mode was that multi-tab editor groups left every tab except the last-
    // created one hanging because open() never fires on a tab that was
    // background at creation time.
    private openResolve?: () => void;
    readonly openPromise: Promise<void> = new Promise(r => { this.openResolve = r; });

    constructor(
        public readonly sessionName: string,
        restoredLabel: string | undefined,
        initialDims: { cols: number; rows: number },
        bootstrapPromise: Promise<void>,
    ) {
        this.cols = initialDims.cols;
        this.rows = initialDims.rows;
        this.nameLocked = restoredLabel !== undefined;
        this.lastFiredName = restoredLabel;
        bootstrapPromise.then(
            () => {
                this.bootstrapDone = true;
                this.tryConnect();
            },
            (e: Error) => {
                this.pendingError = `dterm: failed to start shell: ${e.message}\r\n`;
                if (this.opened) this.flushError();
            },
        );
    }

    private flushError(): void {
        if (!this.pendingError) return;
        this.writeEmitter.fire(this.pendingError);
        this.pendingError = undefined;
        this.closeEmitter.fire(1);
    }

    private tryConnect(): void {
        if (this.closed || this.sock || !this.opened || !this.bootstrapDone) return;
        void this.connect();
    }

    attachTerminal(t: vscode.Terminal): void {
        this.term = t;
    }

    // Returns true and locks future auto-updates if t.name has diverged from
    // the last value we fired (or from the restored label). Called from
    // handleProcessName and from snapshotLabels' polling loop.
    detectAndLockUserRename(): boolean {
        if (this.nameLocked) return true;
        if (!this.term) return false;
        if (this.lastFiredName !== undefined && this.term.name !== this.lastFiredName) {
            this.nameLocked = true;
            return true;
        }
        return false;
    }

    open(initialDimensions: vscode.TerminalDimensions | undefined): void {
        if (initialDimensions) {
            this.cols = initialDimensions.columns;
            this.rows = initialDimensions.rows;
        }
        this.opened = true;
        this.openResolve?.();
        this.openResolve = undefined;
        if (this.pendingError) {
            this.flushError();
            return;
        }
        this.tryConnect();
    }

    private async connect(): Promise<void> {
        try {
            this.sock = await connectToDaemon();
        } catch (e) {
            this.writeEmitter.fire(`dterm: failed to connect to daemon: ${(e as Error).message}\r\n`);
            this.closeEmitter.fire(1);
            return;
        }
        this.sock.on('data', (chunk: Buffer) => this.handleData(chunk));
        this.sock.on('close', () => this.closeEmitter.fire(0));
        this.sock.on('error', e => {
            this.writeEmitter.fire(`\r\ndterm: socket error: ${e.message}\r\n`);
            this.closeEmitter.fire(1);
        });
        // Bootstrap already created/confirmed the session; just attach.
        // env/shell/shellArgs/cwd are ignored by the daemon on existing sessions.
        const msg: ClientMessage = {
            type: 'open',
            name: this.sessionName,
            cols: this.cols,
            rows: this.rows,
        };
        this.sock.write(encode(msg));
        // Flush any input the user typed while waiting for connect.
        if (this.inputQueue.length > 0) {
            for (const data of this.inputQueue) {
                this.sock.write(encode({
                    type: 'input',
                    data: Buffer.from(data, 'utf8').toString('base64'),
                }));
            }
            this.inputQueue.length = 0;
        }
    }

    private handleData(chunk: Buffer): void {
        for (const m of this.parser.feed(chunk)) {
            switch (m.type) {
                case 'output':
                    // Daemon ships pty output as base64 (binary-safe). xterm.js
                    // accepts UTF-8 strings via writeEmitter.fire so we decode.
                    // Includes the shell's own OSC sequences and any synthetic
                    // OSC the daemon replays for late attaches (e.g., the
                    // one-shot HasRichCommandDetection advertisement).
                    this.writeEmitter.fire(Buffer.from(m.data, 'base64').toString('utf8'));
                    break;
                case 'process_name':
                    this.handleProcessName(m.name);
                    break;
                case 'session_end':
                    this.closeEmitter.fire(m.exitCode ?? 0);
                    break;
                case 'error':
                    this.writeEmitter.fire(`\r\ndterm: ${m.message}\r\n`);
                    break;
            }
        }
    }

    private handleProcessName(name: string): void {
        this.lastProcessNameSeen = name;
        if (this.detectAndLockUserRename()) return;
        this.nameEmitter.fire(name);
        this.lastFiredName = name;
    }

    // Re-enable dynamic process-name updates after a user clears their custom
    // label (by inline-renaming to empty -- VS Code's only mechanism for this).
    // Immediately re-fires the latest known process name so the tab updates
    // without waiting for the next daemon event.
    unlockName(): void {
        this.nameLocked = false;
        this.lastFiredName = undefined;
        if (this.lastProcessNameSeen) {
            this.nameEmitter.fire(this.lastProcessNameSeen);
            this.lastFiredName = this.lastProcessNameSeen;
        }
    }

    handleInput(data: string): void {
        if (!this.sock?.writable) {
            // Queue input typed during the bootstrap-then-connect window so
            // we don't drop keystrokes from a user typing into a still-blank
            // terminal. Flushed in connect() once the socket is up.
            this.inputQueue.push(data);
            return;
        }
        const buf = Buffer.from(data, 'utf8');
        this.sock.write(encode({ type: 'input', data: buf.toString('base64') }));
    }

    setDimensions(dims: vscode.TerminalDimensions): void {
        this.cols = dims.columns;
        this.rows = dims.rows;
        if (this.sock?.writable) {
            this.sock.write(encode({ type: 'resize', cols: this.cols, rows: this.rows }));
        }
    }

    close(): void {
        this.closed = true;
        if (this.sock) {
            try { this.sock.write(encode({ type: 'detach' })); } catch { /* ignore */ }
            try { this.sock.end(); } catch { /* ignore */ }
            this.sock = undefined;
        }
    }
}

function connectToDaemon(): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
        const s = net.createConnection(socketPath());
        s.once('connect', () => resolve(s));
        s.once('error', reject);
    });
}

function stubPathForShell(shellBinary: string): { stubPath: string; shimName: string } {
    if (!activeCtx) throw new Error('dterm: extension not activated');
    const base = path.basename(shellBinary);
    const recognized = new Set(['bash', 'zsh', 'fish']);
    const shimName = recognized.has(base) ? base : 'dterm';
    return {
        stubPath: path.join(activeCtx.extensionPath, 'out', 'shims', shimName),
        shimName,
    };
}

// Options for the hidden bootstrap stub: a real shell terminal whose only
// purpose is to be spawned through VS Code's normal terminal pipeline so it
// inherits shell-integration env injection (--init-file, VSCODE_INJECTION,
// VSCODE_SHELL_INTEGRATION_NONCE, etc.). The stub forwards that env to the
// daemon as part of `open`, daemon spawns the actual shell with it, then the
// stub exits -- whereupon the visible Pseudoterminal takes over display.
function buildBootstrapStubOptions(sessionName: string, cwd?: string): vscode.TerminalOptions {
    const cfg = shellConfig();
    const shellBinary = resolveShellBinary(cfg.shell);
    const { stubPath, shimName } = stubPathForShell(shellBinary);
    // Symlink overrides for managed sockets so reattached terminals continue
    // to see live SSH_AUTH_SOCK / VSCODE_IPC_HOOK_CLI / VSCODE_GIT_IPC_HANDLE.
    // VS Code's env collections would otherwise put the literal current socket
    // path into the stub's env, baking it into the running shell.
    //
    // ELECTRON_RUN_AS_NODE makes process.execPath (VS Code's Electron binary
    // on a local install) behave as plain Node so the stub's shebang resolves.
    // Real Node ignores the var, so this is safe on remote/server hosts where
    // process.execPath is already standalone Node. The daemon strips it before
    // spawning the user's shell.
    const env: { [key: string]: string } = {
        DTERM_SESSION: sessionName,
        ELECTRON_RUN_AS_NODE: '1',
        ...refreshManagedSockets(),
    };
    if (shimName === 'dterm' || path.basename(shellBinary) !== shimName) {
        env.DTERM_REAL_SHELL = shellBinary;
    }
    return {
        name: `dterm-bootstrap:${sessionName}`,
        shellPath: stubPath,
        shellArgs: cfg.shellArgs,
        cwd,
        env,
        hideFromUser: true,
        isTransient: true,
    };
}

// Options for the visible Pseudoterminal-backed terminal that the user
// interacts with. Connects directly to the daemon via a Unix socket and
// forwards stdio. The bootstrap stub must have already returned a successful
// `opened` ack from the daemon before this is created -- otherwise the
// `open` message here would create a session without shell-integration env.
function buildPseudoOptions(
    sessionName: string,
    label: string | undefined,
    viewColumn: number | undefined,
    initialDims: { cols: number; rows: number },
    bootstrapPromise: Promise<void>,
): vscode.ExtensionTerminalOptions {
    const pty = new DtermPseudoterminal(sessionName, label, initialDims, bootstrapPromise);
    ptyBySession.set(sessionName, pty);
    return {
        name: label ?? 'dterm',
        pty,
        iconPath: activeCtx
            ? {
                  light: vscode.Uri.joinPath(activeCtx.extensionUri, 'icons', 'dterm-tab-light.svg'),
                  dark: vscode.Uri.joinPath(activeCtx.extensionUri, 'icons', 'dterm-tab-dark.svg'),
              }
            : new vscode.ThemeIcon('plug'),
        color: new vscode.ThemeColor('terminal.ansiCyan'),
        location: viewColumn !== undefined ? { viewColumn } : undefined,
        isTransient: true,
    };
}

// Spawn the hidden bootstrap stub, wait for it to exit (signals the daemon-side
// shell is ready), and resolve. Used by both new-session creation and reattach
// so the path is identical -- on reattach the daemon's `open` handler is a
// no-op for the shell (existing session), but the env-refresh hook stays
// available for future use.
async function bootstrapShell(sessionName: string, cwd?: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const stub = vscode.window.createTerminal(buildBootstrapStubOptions(sessionName, cwd));
        const timeout = setTimeout(() => {
            disposable.dispose();
            try { stub.dispose(); } catch { /* already gone */ }
            reject(new Error('dterm: bootstrap timeout'));
        }, 10_000);
        const disposable = vscode.window.onDidCloseTerminal(t => {
            if (t !== stub) return;
            clearTimeout(timeout);
            disposable.dispose();
            const code = t.exitStatus?.code ?? 0;
            if (code === 0) resolve();
            else reject(new Error(`dterm: bootstrap stub exited with code ${code}`));
        });
    });
}

function sessionNameOf(t: vscode.Terminal): string | undefined {
    return terminalToSession.get(t);
}

async function listLiveSessions(): Promise<string[] | undefined> {
    const resp = await oneShot(
        daemonScriptPath(),
        { type: 'list' },
        m => m.type === 'list_response',
    );
    if (!resp || resp.type !== 'list_response') return undefined;
    return resp.names;
}

async function daemonKill(name: string): Promise<boolean> {
    const resp = await oneShot(
        daemonScriptPath(),
        { type: 'kill', name },
        m => m.type === 'killed',
    );
    return !!resp;
}

async function fetchDaemonVersion(): Promise<string | undefined> {
    const resp = await oneShot(
        daemonScriptPath(),
        { type: 'version' },
        m => m.type === 'version_response',
    );
    if (!resp || resp.type !== 'version_response') return undefined;
    return resp.version;
}

async function checkDaemonVersion(ctx: vscode.ExtensionContext): Promise<{ restarted: boolean }> {
    const expected = ctx.extension.packageJSON?.version as string | undefined;
    if (!expected) return { restarted: false };
    if (!(await isDaemonAlive())) {
        log('version check: no daemon running, skipping');
        return { restarted: false };
    }
    const actual = await fetchDaemonVersion();
    if (actual === expected) {
        log(`version check: match (v${actual})`);
        return { restarted: false };
    }
    const label = actual ?? 'an older version (no version handler)';
    log(`version mismatch: daemon=${actual ?? 'pre-version-handler'}, extension=v${expected}`);
    const choice = await vscode.window.showInformationMessage(
        `dterm: daemon is running ${actual ? `v${actual}` : label}, but the extension is v${expected}. Restart the daemon to load the new code? This will terminate all running sessions.`,
        'Restart daemon',
        'Later',
    );
    if (choice === 'Restart daemon') {
        await vscode.commands.executeCommand('dterm.restartDaemon');
        return { restarted: true };
    }
    return { restarted: false };
}

async function reconnectAll(
    _ctx: vscode.ExtensionContext,
    opts?: { interactive?: boolean },
): Promise<void> {
    refreshManagedSockets();
    const tag = workspaceTag();
    if (!tag) {
        if (opts?.interactive) {
            vscode.window.showInformationMessage(
                'dterm: no workspace folders open — nothing to reattach.',
            );
        }
        return;
    }
    const prefix = `vscode-${tag}-`;
    const live = await fetchDaemonSessions();
    log(`reconnectAll: live=${live === undefined ? 'undefined (daemon unreachable)' : JSON.stringify(live.names)}`);
    if (live === undefined) {
        if (opts?.interactive) {
            vscode.window.showErrorMessage(
                'dterm: daemon unreachable. Check "dterm: Show daemon log".',
            );
        }
        return;
    }
    const ours = live.names.filter(n => n.startsWith(prefix));
    pruneStaleMeta(new Set(ours));
    if (ours.length === 0) {
        if (opts?.interactive) {
            vscode.window.showInformationMessage(
                'dterm: no live sessions for this workspace.',
            );
        }
        return;
    }
    const alreadyOpen = new Set(
        vscode.window.terminals.map(sessionNameOf).filter((n): n is string => Boolean(n)),
    );
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    // Sort to control creation order:
    //   - Panel sessions first, ordered by panelIndex so reattach preserves
    //     the user's panel tab order (or whatever they drag-reordered to).
    //   - Editor-area sessions follow, sorted by (viewColumn, tabIndex). VS Code
    //     appends new terminals at the end of the target group, so creation
    //     order preserves relative position within each column.
    //   - Tie-break by session name so sessions without a panelIndex (e.g.,
    //     created very recently and not yet snapshotted) are deterministic.
    const sortedOurs = ours.slice().sort((a, b) => {
        const la = getMeta(a);
        const lb = getMeta(b);
        const aIsEditor = la?.viewColumn !== undefined;
        const bIsEditor = lb?.viewColumn !== undefined;
        if (aIsEditor && bIsEditor) {
            if (la!.viewColumn !== lb!.viewColumn) return la!.viewColumn! - lb!.viewColumn!;
            return (la!.tabIndex ?? 0) - (lb!.tabIndex ?? 0);
        }
        if (aIsEditor) return 1;
        if (bIsEditor) return -1;
        const ai = la?.panelIndex ?? Number.MAX_SAFE_INTEGER;
        const bi = lb?.panelIndex ?? Number.MAX_SAFE_INTEGER;
        if (ai !== bi) return ai - bi;
        return a.localeCompare(b);
    });
    const created: { name: string; t: vscode.Terminal; isPanel: boolean }[] = [];
    for (const name of sortedOurs) {
        if (alreadyOpen.has(name)) {
            // Reload (not full window close+reopen) keeps existing dterm tabs
            // alive; just acknowledge them, don't recreate.
            const t = vscode.window.terminals.find(t => sessionNameOf(t) === name);
            log(`reconnectAll: already open ${name}`);
            if (t) {
                const meta = getMeta(name);
                created.push({ name, t, isPanel: meta?.viewColumn === undefined });
            }
            continue;
        }
        const meta = getMeta(name);
        log(`reconnectAll: creating terminal for ${name} (${meta?.viewColumn !== undefined ? `col ${meta.viewColumn} idx ${meta.tabIndex ?? 0}` : `panel idx ${meta?.panelIndex ?? '?'}`})`);
        // Start bootstrap in the background; create the visible terminal
        // immediately so the user sees it without waiting for daemon + shell-
        // integration setup. The Pseudoterminal queues input until the
        // bootstrap completes and the daemon connection is up.
        const bootstrapPromise = bootstrapShell(name, cwd).catch(e => {
            log(`reconnectAll: bootstrap failed for ${name}: ${(e as Error).message}`);
            throw e;
        });
        const t = vscode.window.createTerminal(
            buildPseudoOptions(name, meta?.label, meta?.viewColumn, { cols: 80, rows: 24 }, bootstrapPromise),
        );
        terminalToSession.set(t, name);
        const pty = ptyBySession.get(name);
        pty?.attachTerminal(t);
        // Sequential show-then-wait. Each terminal is made the active tab in
        // its target group at creation time, then we wait for VS Code to call
        // our Pseudoterminal.open() before creating the next sibling. This
        // ensures every tab's renderer is instantiated while the tab is
        // foreground; subsequent sibling creates push it to background only
        // after open() has fired. preserveFocus keeps editor focus.
        t.show(true);
        if (pty) {
            const timeoutMs = 5000;
            await Promise.race([
                pty.openPromise,
                new Promise<void>(resolve => setTimeout(() => {
                    log(`reconnectAll: open() did not fire within ${timeoutMs}ms for ${name}; continuing anyway`);
                    resolve();
                }, timeoutMs)),
            ]);
            log(`reconnectAll: open() fired (or timed out) for ${name}`);
        }
        created.push({ name, t, isPanel: meta?.viewColumn === undefined });
    }
    // Re-focus the saved-active terminal at the end so it wins over the
    // last-created tab in each group, which the sequential show loop left
    // active. Falls back to the first panel terminal so the panel pops open.
    const savedActive = getActive();
    const activeEntry = savedActive ? created.find(e => e.name === savedActive) : undefined;
    if (activeEntry) {
        activeEntry.t.show(true);
    } else {
        const firstPanel = created.find(e => e.isPanel);
        firstPanel?.t.show(true);
    }
}

async function probeNodePty(ctx: vscode.ExtensionContext): Promise<{ ok: boolean; message: string }> {
    return new Promise(resolve => {
        const child = cp.spawn(
            process.execPath,
            ['-e', "try{require('node-pty');console.log('OK')}catch(e){console.error('ERR:'+(e.message||e))}"],
            {
                cwd: ctx.extensionPath,
                env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
                stdio: ['ignore', 'pipe', 'pipe'],
            },
        );
        let out = '';
        let err = '';
        child.stdout.on('data', d => { out += d.toString(); });
        child.stderr.on('data', d => { err += d.toString(); });
        child.on('error', e => resolve({ ok: false, message: `spawn error: ${e.message}` }));
        child.on('close', () => {
            if (out.includes('OK')) resolve({ ok: true, message: 'loaded' });
            else resolve({ ok: false, message: (err || out).trim().slice(0, 500) });
        });
    });
}

async function rebuildNodePty(ctx: vscode.ExtensionContext): Promise<boolean> {
    return vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'dterm: rebuilding node-pty for this platform…',
            cancellable: false,
        },
        () => new Promise<boolean>(resolve => {
            const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
            const child = cp.spawn(
                npmCmd,
                ['rebuild', 'node-pty', '--no-audit', '--no-fund'],
                {
                    cwd: ctx.extensionPath,
                    env: { ...process.env, XDG_CACHE_HOME: os.tmpdir() },
                    stdio: ['ignore', 'pipe', 'pipe'],
                },
            );
            let tail = '';
            child.stdout.on('data', d => { tail = (tail + d.toString()).slice(-2000); });
            child.stderr.on('data', d => { tail = (tail + d.toString()).slice(-2000); });
            child.on('error', e => {
                vscode.window.showErrorMessage(`dterm: cannot run npm rebuild — ${e.message}`);
                resolve(false);
            });
            child.on('close', code => {
                if (code === 0) {
                    resolve(true);
                } else {
                    vscode.window.showErrorMessage(
                        `dterm: rebuild failed (exit ${code}). Last output: ${tail.trim().slice(-500)}`,
                    );
                    resolve(false);
                }
            });
        }),
    );
}

async function ensureNodePty(ctx: vscode.ExtensionContext): Promise<boolean> {
    const probe = await probeNodePty(ctx);
    if (probe.ok) return true;
    const choice = await vscode.window.showInformationMessage(
        `dterm: node-pty native module isn't loadable on this machine (${process.platform}-${process.arch}, Node ${process.version}). Rebuild now? Required for terminal sessions to work.`,
        'Rebuild',
        'Later',
    );
    if (choice !== 'Rebuild') return false;
    const ok = await rebuildNodePty(ctx);
    if (!ok) return false;
    const reload = await vscode.window.showInformationMessage(
        'dterm: rebuild complete. Reload window to activate?',
        'Reload Window',
        'Later',
    );
    if (reload === 'Reload Window') {
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
    return true;
}

export function activate(ctx: vscode.ExtensionContext): void {
    activeCtx = ctx;
    void ensureNodePty(ctx);

    ctx.subscriptions.push(
        vscode.window.registerTerminalProfileProvider(PROFILE_ID, {
            async provideTerminalProfile() {
                const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                const allocated = await allocateSessionName();
                const sessionName = allocated ?? `vscode-noworkspace-${process.pid}-${Date.now()}`;
                if (!allocated) log(`profile: allocating fallback session ${sessionName}`);
                else log(`profile: allocated session ${sessionName}`);
                pendingFocus.add(sessionName);
                // Bootstrap runs in parallel with VS Code rendering the visible
                // terminal. Returns immediately so the user sees the terminal
                // within tens of ms; the Pseudoterminal queues input until the
                // bootstrap+daemon attach completes.
                const bootstrapPromise = bootstrapShell(sessionName, cwd).catch(e => {
                    log(`profile: bootstrap failed for ${sessionName}: ${(e as Error).message}`);
                    throw e;
                });
                return new vscode.TerminalProfile(
                    buildPseudoOptions(sessionName, undefined, undefined, { cols: 80, rows: 24 }, bootstrapPromise),
                );
            },
        }),
    );

    ctx.subscriptions.push(
        vscode.window.tabGroups.onDidChangeTabs(() => void snapshotLocations()),
        vscode.window.tabGroups.onDidChangeTabGroups(() => void snapshotLocations()),
        vscode.window.onDidChangeActiveTerminal(() => {
            void snapshotLabels();
            // Capture the focused dterm session promptly so reload restores
            // focus to the same terminal even if it happened seconds before
            // the next polling tick.
            const active = vscode.window.activeTerminal;
            const activeName = active ? sessionNameOf(active) : undefined;
            if (activeName !== undefined && getActive() !== activeName) {
                void setActive(activeName);
            }
        }),
        vscode.window.onDidOpenTerminal(t => {
            // Wire session mapping for Pseudoterminals VS Code created from
            // our profile provider's TerminalProfile -- the provider returns a
            // config, not the Terminal itself, so we couldn't register the
            // mapping at construction time.
            const co = t.creationOptions as vscode.ExtensionTerminalOptions;
            const pty = co.pty;
            if (pty instanceof DtermPseudoterminal) {
                terminalToSession.set(t, pty.sessionName);
                pty.attachTerminal(t);
            }
            const name = sessionNameOf(t);
            if (name && pendingFocus.delete(name)) {
                t.show();
            }
            void snapshotLabels();
            // Snapshot order on every create -- otherwise a fresh terminal
            // doesn't get its panelIndex until the next 2s poll, and a close
            // before that loses the new index.
            void snapshotLocations();
            ensurePolling();
        }),
        vscode.window.onDidChangeTerminalState(() => void snapshotLabels()),
    );

    ctx.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async e => {
            if (
                e.affectsConfiguration('dterm.scrollbackLines') ||
                e.affectsConfiguration('terminal.integrated.scrollback')
            ) {
                const lines = effectiveScrollbackLines();
                log(`config: pushing scrollbackLines=${lines}`);
                await oneShot(daemonScriptPath(), { type: 'set_scrollback_lines', lines }, () => true, 500);
            }
        }),
    );

    void pushAllDaemonSettings();

    if (vscode.window.terminals.some(t => sessionNameOf(t) !== undefined)) {
        ensurePolling();
    }

    ctx.subscriptions.push(
        vscode.window.onDidCloseTerminal(async t => {
            const name = sessionNameOf(t);
            if (!name) return;
            const reason = t.exitStatus?.reason;
            log(`close: ${name} reason=${reason} t.name="${t.name}"`);
            // Drop the Pseudoterminal instance from our map so a subsequent
            // recreate of the same session gets a fresh DtermPseudoterminal.
            ptyBySession.delete(name);
            if (reason === vscode.TerminalExitReason.User) {
                await daemonKill(name);
                await setMeta(name, undefined);
                return;
            }
            // Window close / extension reload / process exit -- snapshot
            // both label and the (now-shifted) panel order before we go down.
            await Promise.all([snapshotLabels(), snapshotLocations()]);
        }),
    );

    ctx.subscriptions.push(
        vscode.commands.registerCommand('dterm.reconnect', () =>
            reconnectAll(ctx, { interactive: true }),
        ),
    );

    ctx.subscriptions.push(
        vscode.commands.registerCommand('dterm.resyncActive', () => {
            // Resync re-renders an existing terminal by re-attaching to its
            // daemon session. With the stub architecture the daemon connection
            // is owned by the stub process, not the extension, so we have to
            // ask the user to close & reopen the terminal manually for now.
            vscode.window.showInformationMessage(
                'dterm: resync currently requires closing and reopening the terminal tab (a daemon-side resync command is planned).',
            );
        }),
    );

    logChannel = vscode.window.createOutputChannel('dterm');
    ctx.subscriptions.push(logChannel);
    log(`activate: extensionPath=${ctx.extensionPath}`);
    log(`activate: workspaceTag=${workspaceTag() ?? '(none)'}`);
    refreshManagedSockets();

    ctx.subscriptions.push(
        vscode.commands.registerCommand('dterm.restartDaemon', async () => {
            log('restartDaemon: sending shutdown');
            await oneShot(daemonScriptPath(), { type: 'shutdown' }, () => true, 500);
            for (let i = 0; i < 40; i++) {
                await new Promise(r => setTimeout(r, 100));
                try { fs.statSync(socketPath()); } catch { break; }
            }
            await pushAllDaemonSettings();
            const live = await listLiveSessions();
            if (live !== undefined) {
                vscode.window.showInformationMessage(`dterm: daemon restarted (live sessions: ${live.length}).`);
            } else {
                vscode.window.showWarningMessage('dterm: daemon did not respond after restart.');
            }
        }),
    );

    ctx.subscriptions.push(
        vscode.commands.registerCommand('dterm.pushDaemonSettings', async () => {
            await pushAllDaemonSettings();
            vscode.window.showInformationMessage('dterm: pushed all settings to daemon.');
        }),
    );

    ctx.subscriptions.push(
        vscode.commands.registerCommand('dterm.showDiagnostics', async () => {
            const ch = logChannel!;
            const sock = socketPath();
            let sockExists = false;
            try { fs.statSync(sock); sockExists = true; } catch { /* not there */ }
            const live = await fetchDaemonSessions();
            const tag = workspaceTag() ?? '(none)';
            const openTerms = vscode.window.terminals.map(t => ({
                name: t.name,
                session: sessionNameOf(t),
            }));
            ch.appendLine('--- dterm diagnostics ---');
            ch.appendLine(`workspaceTag: ${tag}`);
            ch.appendLine(`socket: ${sock} exists=${sockExists}`);
            ch.appendLine(`live sessions: ${live === undefined ? '(daemon unreachable)' : JSON.stringify(live.names)}`);
            ch.appendLine(`open terminals: ${JSON.stringify(openTerms)}`);
            ch.appendLine(`daemon log: ${daemonLogPath()}`);
            ch.appendLine('---');
            ch.show(true);
        }),
    );

    ctx.subscriptions.push(
        vscode.commands.registerCommand('dterm.showDaemonLog', () => {
            const ch = logChannel!;
            const tail = readDaemonLogTail(64 * 1024);
            ch.clear();
            ch.appendLine(`# daemon log: ${daemonLogPath()}`);
            ch.appendLine('');
            ch.append(tail.length > 0 ? tail : '(log is empty or missing)');
            ch.show(true);
        }),
    );

    ctx.subscriptions.push(
        vscode.commands.registerCommand('dterm.listSessions', async () => {
            const live = await fetchDaemonSessions();
            if (live === undefined) {
                vscode.window.showErrorMessage('dterm: daemon unreachable.');
                return;
            }
            const tag = workspaceTag();
            const prefix = tag ? `vscode-${tag}-` : undefined;
            const ours: string[] = [];
            const others: string[] = [];
            for (const n of live.names) {
                if (prefix && n.startsWith(prefix)) ours.push(n);
                else others.push(n);
            }
            const fmt = (n: string): string => {
                const lbl = getMeta(n)?.label;
                return lbl ? `${n}  (${lbl})` : n;
            };
            const lines: string[] = [];
            for (const n of ours) lines.push(`● ${fmt(n)}`);
            if (others.length) {
                if (lines.length) lines.push('—');
                for (const n of others) lines.push(`· ${fmt(n)}`);
            }
            vscode.window.showInformationMessage(
                lines.length ? lines.join('\n') : 'dterm: no sessions.',
                { modal: true },
            );
        }),
    );

    void (async () => {
        const { restarted } = await checkDaemonVersion(ctx);
        if (restarted) return;
        if (vscode.workspace.getConfiguration('dterm').get<boolean>('autoReconnect', true)) {
            await reconnectAll(ctx);
        }
    })();
}

export async function deactivate(): Promise<void> {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = undefined;
    }
    // Await so that workspaceState writes for label/location/active flush
    // before VS Code releases the workspace state on shutdown -- otherwise
    // the next workspace load sees stale data.
    try {
        await Promise.all([snapshotLabels(), snapshotLocations()]);
    } catch (e) {
        log(`deactivate: snapshot flush failed: ${(e as Error).message}`);
    }
    activeCtx = undefined;
}
