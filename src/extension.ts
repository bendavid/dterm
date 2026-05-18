import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as cp from 'child_process';
import * as net from 'net';
import * as os from 'os';
import { ensureDaemon, oneShot, readDaemonLogTail, isDaemonAlive } from './client';
import { agentDir, daemonLogPath, socketPath } from './paths';
import { encode, LineStream, type ClientMessage, type DaemonMessage } from './protocol';

const PROFILE_ID = 'dterm.profile';

// U+200B (zero-width space) appended to every name dterm sets on a terminal:
// the default `name: 'dterm'` for unrenamed sessions in TerminalOptions, and
// every onDidChangeName fire driven by daemon-side process-name polling. Lets
// us distinguish "name dterm set" from "name the user typed" without any race-
// prone comparison against lastFiredName: a t.name carrying the marker is
// ours, a t.name without it is a user inline-rename. Invisible in the UI.
const FG_NAME_MARKER = '​';

let activeCtx: vscode.ExtensionContext | undefined;
let logChannel: vscode.OutputChannel | undefined;
let daemonLogChannel: vscode.OutputChannel | undefined;
let pollTimer: NodeJS.Timeout | undefined;
const pendingFocus = new Set<string>();

// Per-session UI metadata (label, editor-area location, panel order). Stored
// in activeCtx.workspaceState (on the remote in SSH scenarios) under keys
// prefixed with a per-client UUID so two laptops connecting to the same
// remote keep independent terminal layouts. The UUID itself lives in
// SecretStorage, which is the only stable VS Code API that proxies storage
// to the local client side -- different clients get different UUIDs because
// each client's local OS keystore is independent.
interface SessionMeta {
    label?: string;
    viewColumn?: number;
    tabIndex?: number;
    // Position among panel dterm terminals (0 = first). Undefined for editor-area
    // sessions. Used to restore creation order so panel tabs appear as the user
    // arranged them, not alphabetical by session name.
    panelIndex?: number;
}

// Per-client scoping prefix. Minted on first activation, persisted via
// SecretStorage so it survives reloads on the same client. Falls back to
// vscode.env.machineId (remote-side, same across all clients) if SecretStorage
// is unavailable -- degrades to "no per-client distinction" rather than
// failing activation outright.
let clientId: string = vscode.env.machineId;

async function ensureClientId(ctx: vscode.ExtensionContext): Promise<void> {
    const KEY = 'dterm.clientId';
    try {
        let id = await ctx.secrets.get(KEY);
        if (!id) {
            id = crypto.randomUUID();
            await ctx.secrets.store(KEY, id);
            log(`ensureClientId: minted new clientId ${id}`);
        } else {
            log(`ensureClientId: restored clientId ${id}`);
        }
        clientId = id;
    } catch (e) {
        log(`ensureClientId: secrets unavailable (${(e as Error)?.message ?? e}); falling back to machineId ${vscode.env.machineId}`);
    }
}

function metaKey(sessionName: string): string {
    return `client.${clientId}.session.${sessionName}`;
}

function activeKey(): string {
    return `client.${clientId}.active`;
}

// Tracks the most recent panel terminal that was the global active terminal.
// Distinct from activeKey because a panel terminal still has a "selected tab"
// state even when the global active is an editor-area terminal -- reattach
// needs to restore both so the panel reopens at the right tab.
function panelActiveKey(): string {
    return `client.${clientId}.panel-active`;
}

// Per-editor-column active session. Distinct from activeKey because each
// editor group keeps its own selected tab independent of the global active
// terminal -- reattach needs to restore each column to whichever dterm was
// last selected there even when the global focus was elsewhere.
function editorActiveKey(viewColumn: number): string {
    return `client.${clientId}.editor-active.${viewColumn}`;
}

function editorActivePrefix(): string {
    return `client.${clientId}.editor-active.`;
}

function getActive(): string | undefined {
    if (!activeCtx) return undefined;
    return activeCtx.workspaceState.get<string>(activeKey());
}

async function setActive(sessionName: string | undefined): Promise<void> {
    if (!activeCtx) return;
    await activeCtx.workspaceState.update(activeKey(), sessionName);
}

function getPanelActive(): string | undefined {
    if (!activeCtx) return undefined;
    return activeCtx.workspaceState.get<string>(panelActiveKey());
}

async function setPanelActive(sessionName: string | undefined): Promise<void> {
    if (!activeCtx) return;
    await activeCtx.workspaceState.update(panelActiveKey(), sessionName);
}

function getEditorActive(viewColumn: number): string | undefined {
    if (!activeCtx) return undefined;
    return activeCtx.workspaceState.get<string>(editorActiveKey(viewColumn));
}

async function setEditorActive(viewColumn: number, sessionName: string | undefined): Promise<void> {
    if (!activeCtx) return;
    await activeCtx.workspaceState.update(editorActiveKey(viewColumn), sessionName);
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
        const name = t.name;
        // Marker present -> the displayed name came from dterm (our default
        // TerminalOptions.name or an onDidChangeName fire). Whether we're
        // currently locked tells us how to interpret this:
        //   - Locked: user previously inline-renamed, and now the marker
        //     name is back. That can only mean the user cleared the rename
        //     (VS Code fell back from the Api-source title to the
        //     Process-source title, which is our last fire). Unlock so daemon
        //     process_name updates drive the tab again, and drop the saved
        //     label.
        //   - Unlocked: normal dynamic-name operation. Nothing to do.
        if (name.includes(FG_NAME_MARKER)) {
            if (pty.isNameLocked()) {
                pty.unlockName();
                if (current?.label !== undefined) {
                    writes.push(setMeta(sName, { ...current, label: undefined }));
                }
            }
            continue;
        }
        // Empty rename can also resolve directly to '' on some VS Code paths
        // (older behavior; kept as a defensive branch). Same semantics as
        // marker-came-back-while-locked.
        if (name === '') {
            pty.unlockName();
            if (current?.label !== undefined) {
                writes.push(setMeta(sName, { ...current, label: undefined }));
            }
            continue;
        }
        // No marker, non-empty -> user inline-renamed to a custom value.
        if (!pty.detectAndLockUserRename()) continue;
        if (current?.label !== name) {
            writes.push(setMeta(sName, { ...current, label: name }));
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
            // Skip empty-label matches: a freshly-created editor terminal can
            // have tab.label === "" momentarily before its title settles, and
            // a freshly-created panel terminal can have t.name === "" at the
            // same moment. The accidental "" === "" match wrongly classifies
            // the panel terminal as being in this editor group.
            if (!tab.label) continue;
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
        // Freshly-created editor terminals (e.g. from reconnectAll with
        // location: {viewColumn}) take an event-loop tick or two to show up
        // in tabGroups.all. If we just used `target` here, those terminals
        // would temporarily get viewColumn=undefined written (= panel
        // classification), which then makes onDidChangeActiveTerminal wrongly
        // classify the now-active editor terminal as panel and overwrite
        // panel-active. Cross-check creationOptions.location: if the terminal
        // was launched into the editor area, preserve its editor
        // classification until tabGroups picks it up.
        const co = t.creationOptions as vscode.ExtensionTerminalOptions;
        const createdInEditor = typeof co?.location === 'object'
            && co.location !== null
            && 'viewColumn' in co.location
            && typeof co.location.viewColumn === 'number';
        let nextViewColumn: number | undefined;
        let nextTabIndex: number | undefined;
        let nextPanelIndex: number | undefined;
        if (target) {
            nextViewColumn = target.viewColumn;
            nextTabIndex = target.tabIndex;
        } else if (createdInEditor) {
            nextViewColumn = current?.viewColumn ?? (co.location as vscode.TerminalEditorLocationOptions).viewColumn;
            nextTabIndex = current?.tabIndex;
        } else {
            nextPanelIndex = panelOrder.get(sName);
        }
        const next: SessionMeta = {
            ...current,
            viewColumn: nextViewColumn,
            tabIndex: nextTabIndex,
            panelIndex: nextPanelIndex,
        };
        if (!metaEqual(current, next)) {
            writes.push(setMeta(sName, next));
            // If this session transitioned from panel to editor (e.g., user
            // dragged the tab from the terminal panel into the editor area),
            // the panel-active key may still point at it from before the
            // move. Clear it so reattach doesn't try to restore a now-editor
            // session as the panel's active tab.
            if (current?.viewColumn === undefined && next.viewColumn !== undefined
                && getPanelActive() === sName) {
                log(`snapshotLocations: ${sName} moved panel->editor, clearing panel-active`);
                writes.push(setPanelActive(undefined));
            }
            // Mirror: if a session moved out of an editor column (to panel
            // or to a different column), clear the editor-active entry for
            // the column it left.
            if (current?.viewColumn !== undefined
                && current.viewColumn !== next.viewColumn
                && getEditorActive(current.viewColumn) === sName) {
                log(`snapshotLocations: ${sName} left editor col ${current.viewColumn}, clearing editor-active`);
                writes.push(setEditorActive(current.viewColumn, undefined));
            }
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
    const sessionPrefix = `client.${clientId}.session.`;
    for (const key of activeCtx.workspaceState.keys()) {
        if (!key.startsWith(sessionPrefix)) continue;
        const session = key.slice(sessionPrefix.length);
        if (!liveSessionNames.has(session)) {
            void activeCtx.workspaceState.update(key, undefined);
        }
    }
    // Drop the saved-active and panel-active keys if they point at dead
    // sessions, so reattach doesn't try to focus a nonexistent terminal.
    const active = getActive();
    if (active && !liveSessionNames.has(active)) {
        void setActive(undefined);
    }
    const panelActive = getPanelActive();
    if (panelActive && !liveSessionNames.has(panelActive)) {
        void setPanelActive(undefined);
    }
    // Drop per-editor-column active entries that point at dead sessions.
    const editorPrefix = editorActivePrefix();
    for (const key of activeCtx.workspaceState.keys()) {
        if (!key.startsWith(editorPrefix)) continue;
        const value = activeCtx.workspaceState.get<string>(key);
        if (value && !liveSessionNames.has(value)) {
            void activeCtx.workspaceState.update(key, undefined);
        }
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
    // (for new sessions) bootstrap runs in parallel so the user sees a
    // terminal in tens of ms instead of waiting for shell-integration env
    // capture. We can only connect to the daemon after both VS Code has
    // called open() and bootstrap (if any) has resolved.
    private opened = false;
    private bootstrapDone = false;
    private bootstrapResult: BootstrapResult | undefined;
    private closed = false;
    private inputQueue: string[] = [];
    // Bootstrap error buffered until open() so the user actually sees it
    // (writeEmitter.fire before VS Code has subscribed is dropped on the floor).
    private pendingError: string | undefined;
    // For reattach, the daemon-side shell already exists from when the session
    // was first created -- we don't need env / cwd / shell / args, just dims.
    // Tracked so connect() can build the right `open` message.
    private readonly isReattach: boolean;
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
        bootstrap: Promise<BootstrapResult> | undefined,
    ) {
        this.cols = initialDims.cols;
        this.rows = initialDims.rows;
        this.nameLocked = restoredLabel !== undefined;
        this.lastFiredName = restoredLabel;
        this.isReattach = bootstrap === undefined;
        if (bootstrap === undefined) {
            // Reattach -- no env to capture, daemon-side shell already exists.
            this.bootstrapDone = true;
        } else {
            bootstrap.then(
                result => {
                    this.bootstrapResult = result;
                    this.bootstrapDone = true;
                    this.tryConnect();
                },
                (e: Error) => {
                    this.pendingError = `dterm: failed to start shell: ${e.message}\r\n`;
                    if (this.opened) this.flushError();
                },
            );
        }
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

    // Returns true and locks future auto-updates if t.name lacks the U+200B
    // marker dterm appends to every name it sets. Any unmarked value in t.name
    // must have come from a user inline-rename (the only other path that
    // writes to it). No comparison against lastFiredName needed -- the marker
    // is a synchronous, race-free signal.
    detectAndLockUserRename(): boolean {
        if (this.nameLocked) return true;
        if (!this.term) return false;
        if (this.term.name.includes(FG_NAME_MARKER)) return false;
        this.nameLocked = true;
        return true;
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
        // New session: hand over the shell-integration env and argv we
        // captured from the bootstrap stub so the daemon can spawn the shell
        // at the visible terminal's actual dims. shellArgs come from the
        // bootstrap's process.argv (skipping the interpreter + stub script)
        // so we pick up `--init-file` etc. that VS Code injects for shell
        // integration. The shell binary itself comes from extension config /
        // $SHELL -- the stub's argv[0] is `node` (or the shim), not the real
        // shell.
        //
        // Reattach: daemon-side shell already exists; just attach with name +
        // dims. env / cwd / shell / args are omitted (daemon ignores them on
        // existing sessions, so omitting keeps the protocol intent explicit).
        let msg: ClientMessage;
        if (this.isReattach || !this.bootstrapResult) {
            msg = {
                type: 'open',
                name: this.sessionName,
                cols: this.cols,
                rows: this.rows,
            };
        } else {
            const cfg = shellConfig();
            const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            // process.argv = [nodeBinary, stubScript, ...shellArgs]. The
            // stub's argv[0] is the Node interpreter path and argv[1] is
            // the stub script path (or its symlink); slice past both to
            // recover the args VS Code actually passed for the shell.
            const capturedArgs = this.bootstrapResult.args.slice(2);
            // Drop ELECTRON_RUN_AS_NODE -- it was a marker we set for the
            // stub's spawning interpreter, not something the user's shell
            // should inherit. The daemon strips it too as a safety net.
            const env: Record<string, string> = { ...this.bootstrapResult.env };
            delete env.ELECTRON_RUN_AS_NODE;
            delete env.DTERM_BOOTSTRAP_SOCKET;
            delete env.DTERM_SESSION;
            delete env.DTERM_REAL_SHELL;
            msg = {
                type: 'open',
                name: this.sessionName,
                cols: this.cols,
                rows: this.rows,
                cwd,
                env,
                shell: resolveShellBinary(cfg.shell),
                shellArgs: capturedArgs.length > 0 ? capturedArgs : cfg.shellArgs,
            };
        }
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
        if (this.nameLocked) return;
        // Append the marker so detectAndLockUserRename can later tell our
        // fires apart from user inline-renames. The marker is U+200B (zero-
        // width space) so it's invisible in the tab UI.
        const marked = name + FG_NAME_MARKER;
        this.nameEmitter.fire(marked);
        this.lastFiredName = marked;
    }

    // Re-enable dynamic process-name updates after a user clears their custom
    // label (by inline-renaming to empty -- VS Code's only mechanism for this).
    // Immediately re-fires the latest known process name so the tab updates
    // without waiting for the next daemon event.
    unlockName(): void {
        this.nameLocked = false;
        this.lastFiredName = undefined;
        if (this.lastProcessNameSeen) {
            const marked = this.lastProcessNameSeen + FG_NAME_MARKER;
            this.nameEmitter.fire(marked);
            this.lastFiredName = marked;
        }
    }

    // True if the lock that suppresses daemon-driven name updates is currently
    // engaged. Exposed so snapshotLabels can detect "user cleared their inline
    // rename" -- in that case t.name falls back from the user-set Api-source
    // title to our marker-tagged Process-source title, and seeing the marker
    // come back while we were locked is the signal to unlock.
    isNameLocked(): boolean {
        return this.nameLocked;
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

async function connectToDaemon(): Promise<net.Socket> {
    // The bootstrap stub no longer spawns the daemon in this architecture --
    // it only writes captured env to a per-session socket and exits. The
    // extension is responsible for ensuring the daemon is running before
    // any Pseudoterminal tries to attach.
    await ensureDaemon(daemonScriptPath());
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

// Bootstrap captures what VS Code would inject into a real terminal -- the
// resolved env (including shell-integration --init-file path, VSCODE_INJECTION,
// VSCODE_SHELL_INTEGRATION_NONCE, etc.) and the argv that VS Code launched
// the stub with. The visible Pseudoterminal then hands this to the daemon in
// its `open` message so the daemon-side shell spawns with the right env.
interface BootstrapResult {
    env: Record<string, string>;
    args: string[];
}

// Options for the hidden bootstrap stub: a real shell terminal whose only
// purpose is to be spawned through VS Code's normal terminal pipeline so it
// inherits shell-integration env injection. The stub writes the captured env
// + argv to the per-session Unix socket whose path we pass via
// DTERM_BOOTSTRAP_SOCKET and exits. No daemon involvement.
function buildBootstrapStubOptions(
    sessionName: string,
    sockPath: string,
    cwd?: string,
): vscode.TerminalOptions {
    const cfg = shellConfig();
    const shellBinary = resolveShellBinary(cfg.shell);
    const { stubPath, shimName } = stubPathForShell(shellBinary);
    // Symlink overrides for managed sockets so reattached terminals continue
    // to see live SSH_AUTH_SOCK / VSCODE_GIT_IPC_HANDLE. VS Code's env
    // collections would otherwise put the literal current socket path into
    // the stub's env, baking it into the running shell.
    //
    // ELECTRON_RUN_AS_NODE makes process.execPath (VS Code's Electron binary
    // on a local install) behave as plain Node so the stub's shebang resolves.
    // Real Node ignores the var, so this is safe on remote/server hosts where
    // process.execPath is already standalone Node. The daemon strips it
    // before spawning the user's shell.
    const env: { [key: string]: string } = {
        DTERM_SESSION: sessionName,
        DTERM_BOOTSTRAP_SOCKET: sockPath,
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
// forwards stdio. For new sessions, `bootstrap` is a promise resolving to
// the captured env+argv that gets included in the daemon's `open` message
// (so the shell spawns with VS Code's shell-integration env). For reattach,
// pass `undefined` -- the daemon-side shell already exists and we just
// attach with name + dims.
function buildPseudoOptions(
    sessionName: string,
    label: string | undefined,
    viewColumn: number | undefined,
    initialDims: { cols: number; rows: number },
    bootstrap: Promise<BootstrapResult> | undefined,
): vscode.ExtensionTerminalOptions {
    const pty = new DtermPseudoterminal(sessionName, label, initialDims, bootstrap);
    ptyBySession.set(sessionName, pty);
    return {
        // Marker on the default name so the brief window between createTerminal
        // and our first onDidChangeName fire doesn't look like an unmarked
        // user value to detectAndLockUserRename. Restored labels (user-set
        // before) are kept verbatim; the constructor locks on them anyway, so
        // the marker check never runs.
        name: label ?? `dterm${FG_NAME_MARKER}`,
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

// Set up a per-session Unix socket that the bootstrap stub will connect to
// and write its captured env+argv to. Returns the socket path (for handing to
// the stub via DTERM_BOOTSTRAP_SOCKET) and a promise that resolves with the
// parsed payload once the stub has written it. Cleans the socket file +
// closes the server in all exit paths.
function setupBootstrapSocket(sessionName: string): {
    sockPath: string;
    cleanup: () => void;
    payload: Promise<BootstrapResult>;
} {
    if (!activeCtx) throw new Error('dterm: extension not activated');
    const tag = workspaceTag() ?? 'noworkspace';
    const dir = agentDir(tag);
    try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { /* exists */ }
    const sockPath = path.join(
        dir,
        `bootstrap-${sessionName}-${crypto.randomBytes(6).toString('hex')}.sock`,
    );
    try { fs.unlinkSync(sockPath); } catch { /* not there */ }
    const server = net.createServer();
    let serverClosed = false;
    const cleanup = (): void => {
        if (serverClosed) return;
        serverClosed = true;
        try { server.close(); } catch { /* ignore */ }
        try { fs.unlinkSync(sockPath); } catch { /* already gone */ }
    };
    const payload = new Promise<BootstrapResult>((resolve, reject) => {
        let settled = false;
        server.on('connection', conn => {
            let buf = '';
            conn.setEncoding('utf8');
            conn.on('data', chunk => { buf += chunk; });
            conn.on('end', () => {
                if (settled) return;
                settled = true;
                try {
                    const parsed = JSON.parse(buf) as BootstrapResult;
                    resolve(parsed);
                } catch (e) {
                    reject(new Error(`dterm: bootstrap payload parse failed: ${(e as Error).message}`));
                } finally {
                    cleanup();
                }
            });
            conn.on('error', e => {
                if (settled) return;
                settled = true;
                reject(new Error(`dterm: bootstrap connection error: ${e.message}`));
                cleanup();
            });
        });
        server.on('error', e => {
            if (settled) return;
            settled = true;
            reject(new Error(`dterm: bootstrap server error: ${e.message}`));
            cleanup();
        });
        try {
            server.listen(sockPath);
        } catch (e) {
            settled = true;
            reject(new Error(`dterm: bootstrap server listen failed: ${(e as Error).message}`));
            cleanup();
        }
    });
    return { sockPath, cleanup, payload };
}

// Spawn the hidden bootstrap stub through VS Code's terminal pipeline so it
// inherits shell-integration env, wait for it to write the captured env+argv
// to the per-session bootstrap socket, and return the result. The visible
// Pseudoterminal hands this to the daemon as part of its `open` message so
// the daemon-side shell spawns with VS Code's shell-integration env --
// without the stub ever talking to the daemon.
async function bootstrapShell(sessionName: string, cwd?: string): Promise<BootstrapResult> {
    const { sockPath, cleanup, payload } = setupBootstrapSocket(sessionName);
    const stub = vscode.window.createTerminal(buildBootstrapStubOptions(sessionName, sockPath, cwd));
    let resolved = false;
    let rejected = false;
    return new Promise<BootstrapResult>((resolve, reject) => {
        const timeout = setTimeout(() => {
            if (resolved || rejected) return;
            rejected = true;
            disposable.dispose();
            cleanup();
            try { stub.dispose(); } catch { /* already gone */ }
            reject(new Error('dterm: bootstrap timeout'));
        }, 10_000);
        const disposable = vscode.window.onDidCloseTerminal(t => {
            if (t !== stub) return;
            // Stub exit before payload means the socket write failed. The
            // payload promise will reject (or has already), so we let it.
            const code = t.exitStatus?.code ?? 0;
            if (code !== 0 && !resolved && !rejected) {
                rejected = true;
                clearTimeout(timeout);
                disposable.dispose();
                cleanup();
                reject(new Error(`dterm: bootstrap stub exited with code ${code}`));
            }
        });
        payload.then(
            result => {
                if (rejected) return;
                resolved = true;
                clearTimeout(timeout);
                disposable.dispose();
                try { stub.dispose(); } catch { /* already gone */ }
                resolve(result);
            },
            err => {
                if (resolved || rejected) return;
                rejected = true;
                clearTimeout(timeout);
                disposable.dispose();
                try { stub.dispose(); } catch { /* already gone */ }
                reject(err);
            },
        );
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
    // Capture the saved active/panel-active/editor-active BEFORE we start
    // creating terminals. VS Code auto-activates each new terminal as it's
    // created, firing onDidChangeActiveTerminal, which writes those keys to
    // whatever happens to be created last -- destroying the user's intended
    // selection. We use these snapshots later for the show plan; the final
    // shows then rewrite workspaceState back to the intended values.
    const savedActive = getActive();
    const savedPanelActive = getPanelActive();
    const savedEditorActive = new Map<number, string>();
    for (const name of ours) {
        const meta = getMeta(name);
        const col = meta?.viewColumn;
        if (col === undefined) continue;
        if (savedEditorActive.has(col)) continue;
        const saved = getEditorActive(col);
        if (saved) savedEditorActive.set(col, saved);
    }
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
        // No bootstrap on reattach: the daemon-side shell was already spawned
        // (with VS Code's shell-integration env) the first time this session
        // was created. We just attach with name + dims.
        const t = vscode.window.createTerminal(
            buildPseudoOptions(name, meta?.label, meta?.viewColumn, { cols: 80, rows: 24 }, undefined),
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
            let timedOut = false;
            let timer: NodeJS.Timeout | undefined;
            const timeoutPromise = new Promise<void>(resolve => {
                timer = setTimeout(() => { timedOut = true; resolve(); }, timeoutMs);
            });
            await Promise.race([pty.openPromise, timeoutPromise]);
            if (timer) clearTimeout(timer);
            log(`reconnectAll: ${name} ${timedOut ? `open() timed out after ${timeoutMs}ms (continuing)` : 'open() fired'}`);
        }
        created.push({ name, t, isPanel: meta?.viewColumn === undefined });
    }
    // Reattach focus restoration. Two things to set:
    //   - Panel-area: which terminal is the "selected tab" in the panel. The
    //     panel itself needs to be revealed if there are panel terminals, even
    //     if the globally-active terminal was an editor-area one.
    //   - Global active: which terminal vscode.window.activeTerminal points at.
    //     For a saved-editor active, this is distinct from the panel's tab.
    // preserveFocus on .show(true) keeps the active editor focused throughout.
    // Note: we use savedActive/savedPanelActive/savedEditorActive captured
    // BEFORE the creation loop, since the auto-activations VS Code fires
    // during creation overwrite the live workspaceState values.
    const activeEntry = savedActive ? created.find(e => e.name === savedActive) : undefined;
    const panelEntry = (savedPanelActive
        ? created.find(e => e.name === savedPanelActive && e.isPanel)
        : undefined)
        ?? created.find(e => e.isPanel);
    // Per-editor-column saved-active selections. For each editor column we're
    // restoring into, find the saved active session for that column. We show
    // these first so each column ends with its prior selection; subsequent
    // panel and global shows don't change other columns' active tabs.
    const editorEntries: { col: number; entry: typeof created[number] }[] = [];
    const seenCols = new Set<number>();
    for (const entry of created) {
        if (entry.isPanel) continue;
        const meta = getMeta(entry.name);
        const col = meta?.viewColumn;
        if (col === undefined || seenCols.has(col)) continue;
        seenCols.add(col);
        const saved = savedEditorActive.get(col);
        const match = saved ? created.find(e => e.name === saved) : undefined;
        if (match) editorEntries.push({ col, entry: match });
    }
    log(`reconnectAll: created=${JSON.stringify(created.map(e => ({name: e.name, isPanel: e.isPanel})))} savedActive=${savedActive ?? '-'} savedPanelActive=${savedPanelActive ?? '-'} panelEntry=${panelEntry?.name ?? '-'} activeEntry=${activeEntry?.name ?? '-'} editor=${JSON.stringify(editorEntries.map(e => ({col: e.col, name: e.entry.name})))}`);
    // Show each editor column's saved-active first so each column ends with
    // the right tab selected. Skip the activeEntry's column -- the final
    // show on it will set the column's active anyway.
    for (const { entry } of editorEntries) {
        if (entry === activeEntry) continue;
        entry.t.show(true);
    }
    // Show the panel entry next to reveal the panel and select its restored
    // tab. Skip if it's the same as the global active.
    if (panelEntry && panelEntry !== activeEntry) {
        panelEntry.t.show(true);
    }
    // Final show makes the saved-active the globally focused terminal; falls
    // back to the panel entry (or undefined if no terminals at all).
    (activeEntry ?? panelEntry)?.t.show(true);
}

// Diagnostic: compare the env of the active dterm's daemon-side shell to
// what VS Code would inject for a freshly-spawned terminal right now, and
// show the diff. Useful for spotting drift in rotating endpoints
// (CLAUDE_CODE_SSE_PORT, VSCODE_GIT_IPC_HANDLE, VSCODE_IPC_HOOK_CLI,
// VSCODE_SHELL_INTEGRATION_NONCE, ...) that the daemon's long-lived shells
// can't see updates to without a fresh spawn.
async function checkEnvFreshness(): Promise<void> {
    const active = vscode.window.activeTerminal;
    if (!active) {
        vscode.window.showInformationMessage('dterm: no active terminal.');
        return;
    }
    const sessionName = sessionNameOf(active);
    if (!sessionName) {
        vscode.window.showInformationMessage('dterm: active terminal is not a dterm session.');
        return;
    }
    const sessionEnv = await fetchSessionEnv(sessionName);
    if (!sessionEnv) {
        vscode.window.showErrorMessage(`dterm: failed to read env of session ${sessionName}.`);
        return;
    }
    let freshResult: BootstrapResult;
    try {
        freshResult = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'dterm: capturing fresh env...', cancellable: false },
            () => bootstrapShell(`envfresh-${process.pid}-${Date.now()}`),
        );
    } catch (e) {
        vscode.window.showErrorMessage(`dterm: bootstrap capture failed: ${(e as Error).message}`);
        return;
    }
    // The bootstrap stub's process.env carries vars that we inject in
    // buildBootstrapStubOptions purely for the stub's own use
    // (DTERM_BOOTSTRAP_SOCKET so it knows the socket path, ELECTRON_RUN_AS_NODE
    // so its shebang resolves, etc.). The Pseudoterminal strips these before
    // sending env to the daemon, and the daemon strips ELECTRON_RUN_AS_NODE
    // again, so the real shell never sees them. Apply the same stripping here
    // so the diff reflects what a real new shell would actually receive, not
    // the stub's plumbing.
    const freshEnv: Record<string, string> = { ...freshResult.env };
    delete freshEnv.ELECTRON_RUN_AS_NODE;
    delete freshEnv.ELECTRON_NO_ATTACH_CONSOLE;
    delete freshEnv.DTERM_BOOTSTRAP_SOCKET;
    delete freshEnv.DTERM_SESSION;
    delete freshEnv.DTERM_REAL_SHELL;
    const ch = vscode.window.createOutputChannel('dterm: env freshness');
    renderEnvDiff(ch, sessionName, sessionEnv, freshEnv);
    ch.show(true);
}

async function fetchSessionEnv(name: string): Promise<Record<string, string> | undefined> {
    const resp = await oneShot(
        daemonScriptPath(),
        { type: 'get_session_env', name },
        m => m.type === 'session_env_response' || m.type === 'error',
        5000,
    );
    if (!resp || resp.type !== 'session_env_response') return undefined;
    return resp.env;
}

// Keys that rotate or get updated by VS Code / extensions on
// reload/reconnect. We highlight drift on these because they're the ones
// that actually matter for end-user-visible misbehaviour (askpass not
// working, shell-integration nonce mismatch, Claude Code SSE port stale,
// etc.). Anything else that drifts (PATH adjustments by the user's shell
// rc, transient PWD, etc.) is shown under "other" for completeness.
const VOLATILE_ENV_PREFIXES = ['VSCODE_', 'GIT_', 'SSH_', 'CLAUDE_'];
function isVolatileKey(k: string): boolean {
    return VOLATILE_ENV_PREFIXES.some(p => k.startsWith(p))
        || k === 'TERM_PROGRAM'
        || k === 'TERM_PROGRAM_VERSION'
        || k === 'COLORTERM';
}

function renderEnvDiff(
    ch: vscode.OutputChannel,
    sessionName: string,
    sessionEnv: Record<string, string>,
    freshEnv: Record<string, string>,
): void {
    const allKeys = new Set<string>([...Object.keys(sessionEnv), ...Object.keys(freshEnv)]);
    const changed: string[] = [];
    const sessionOnly: string[] = [];
    const freshOnly: string[] = [];
    for (const k of allKeys) {
        const inS = k in sessionEnv;
        const inF = k in freshEnv;
        if (inS && inF) {
            if (sessionEnv[k] !== freshEnv[k]) changed.push(k);
        } else if (inS) {
            sessionOnly.push(k);
        } else {
            freshOnly.push(k);
        }
    }
    const sort = (a: string[]) => a.sort((x, y) => {
        // Volatile keys first, then alphabetical.
        const vx = isVolatileKey(x);
        const vy = isVolatileKey(y);
        if (vx !== vy) return vx ? -1 : 1;
        return x.localeCompare(y);
    });
    sort(changed); sort(sessionOnly); sort(freshOnly);

    ch.appendLine('=== dterm: env freshness ===');
    ch.appendLine(`session: ${sessionName}`);
    ch.appendLine(`captured at: ${new Date().toISOString()}`);
    ch.appendLine('');
    ch.appendLine(`Differs (${changed.length}; values rotated on reconnect or otherwise changed):`);
    if (changed.length === 0) ch.appendLine('  (none)');
    for (const k of changed) {
        const tag = isVolatileKey(k) ? '*' : ' ';
        ch.appendLine(`  ${tag} ${k}`);
        ch.appendLine(`        session: ${truncate(sessionEnv[k], 200)}`);
        ch.appendLine(`        fresh:   ${truncate(freshEnv[k], 200)}`);
    }
    ch.appendLine('');
    ch.appendLine(`Only in session (${sessionOnly.length}; set when session was created, no longer injected):`);
    if (sessionOnly.length === 0) ch.appendLine('  (none)');
    for (const k of sessionOnly) {
        const tag = isVolatileKey(k) ? '*' : ' ';
        ch.appendLine(`  ${tag} ${k}=${truncate(sessionEnv[k], 200)}`);
    }
    ch.appendLine('');
    ch.appendLine(`Only in fresh (${freshOnly.length}; injected now but missing from running session):`);
    if (freshOnly.length === 0) ch.appendLine('  (none)');
    for (const k of freshOnly) {
        const tag = isVolatileKey(k) ? '*' : ' ';
        ch.appendLine(`  ${tag} ${k}=${truncate(freshEnv[k], 200)}`);
    }
    ch.appendLine('');
    ch.appendLine('(* = key likely controlled by VS Code or an extension)');
}

function truncate(s: string, n: number): string {
    return s.length <= n ? s : s.slice(0, n) + `… [${s.length} chars]`;
}

// One-shot dump of tabGroups.all, terminals, and active terminal so we can see
// what the public API actually surfaces -- specifically whether aux-window tab
// groups are visible (with what viewColumn) and how aux-window terminals appear
// in vscode.window.terminals.
function logTabGroupsState(tag: string): void {
    try {
        const groups = vscode.window.tabGroups.all.map(g => ({
            viewColumn: g.viewColumn,
            isActive: g.isActive,
            tabs: g.tabs.map(t => ({
                label: t.label,
                inputType: t.input?.constructor?.name ?? 'undefined',
            })),
        }));
        const terms = vscode.window.terminals.map(t => ({
            name: t.name,
            session: sessionNameOf(t) ?? '-',
        }));
        const active = vscode.window.activeTerminal
            ? { name: vscode.window.activeTerminal.name, session: sessionNameOf(vscode.window.activeTerminal) ?? '-' }
            : null;
        log(`tabGroups[${tag}]: groups=${JSON.stringify(groups)} terminals=${JSON.stringify(terms)} active=${JSON.stringify(active)}`);
    } catch (e) {
        log(`tabGroups[${tag}]: error ${(e as Error).message}`);
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
            log(`activeTerminal changed: name=${active?.name ?? '(none)'} session=${activeName ?? '-'}`);
            if (activeName !== undefined && getActive() !== activeName) {
                void setActive(activeName);
            }
            // Track the most recent panel-area dterm as the "panel active"
            // separately. snapshotLocations classifies panel vs editor by
            // meta.viewColumn; we mirror that here so reattach can restore
            // both the globally-active terminal and the panel's selected tab.
            // Important: require meta to be DEFINED before classifying. During
            // rapid terminal creation, snapshotLocations may not have
            // populated meta yet -- treating "no meta" as "panel" would
            // wrongly overwrite panelActive with editor terminals.
            if (activeName !== undefined) {
                const meta = getMeta(activeName);
                if (meta !== undefined && meta.viewColumn === undefined
                    && getPanelActive() !== activeName) {
                    void setPanelActive(activeName);
                }
                // Mirror logic for per-editor-column active: when an editor-
                // area dterm becomes active, record it as the active tab in
                // its column so reattach can restore the column's selection
                // independently of the global active terminal.
                if (meta?.viewColumn !== undefined
                    && getEditorActive(meta.viewColumn) !== activeName) {
                    void setEditorActive(meta.viewColumn, activeName);
                }
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
        vscode.commands.registerCommand('dterm.checkEnvFreshness', () => checkEnvFreshness()),
    );

    ctx.subscriptions.push(
        vscode.commands.registerCommand('dterm.showDaemonLog', () => {
            // Separate channel from the extension's own log so peeking at the
            // daemon tail doesn't clobber lifecycle/diagnostics output from log().
            if (!daemonLogChannel) daemonLogChannel = vscode.window.createOutputChannel('dterm: daemon log');
            const tail = readDaemonLogTail(64 * 1024);
            daemonLogChannel.clear();
            daemonLogChannel.appendLine(`# daemon log: ${daemonLogPath()}`);
            daemonLogChannel.appendLine('');
            daemonLogChannel.append(tail.length > 0 ? tail : '(log is empty or missing)');
            daemonLogChannel.show(true);
        }),
    );

    ctx.subscriptions.push(
        vscode.commands.registerCommand('dterm.showExtensionLog', () => {
            logChannel?.show(true);
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
        // Resolve clientId BEFORE any code path reads workspaceState -- every
        // key derives from `client.${clientId}.<...>`, so reading with a
        // fallback machineId-based prefix would miss values persisted under
        // the real UUID.
        await ensureClientId(ctx);
        logTabGroupsState('activate');
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
