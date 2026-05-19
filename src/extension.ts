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

// Encode an ASCII session name into Unicode tag characters (U+E0020-U+E007E),
// which map U+0020-U+007E one-to-one to invisible code points. Appended after
// FG_NAME_MARKER on every name we set, so tab.label carries the session ID
// directly -- snapshotLocations can then decode it and identify which dterm
// session a tab represents without any name-collision-prone label matching.
function encodeSessionTag(s: string): string {
    let out = '';
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c >= 0x20 && c <= 0x7E) {
            out += String.fromCodePoint(0xE0000 + c);
        }
    }
    return out;
}

function decodeSessionTag(s: string): string {
    let out = '';
    for (const ch of s) {
        const cp = ch.codePointAt(0);
        if (cp !== undefined && cp >= 0xE0020 && cp <= 0xE007E) {
            out += String.fromCharCode(cp - 0xE0000);
        }
    }
    return out;
}

function nameWithSession(visible: string, sessionName: string): string {
    return `${visible}${FG_NAME_MARKER}${encodeSessionTag(sessionName)}`;
}

// "Did dterm produce this name?" Returns true if the value's invisible tag-
// encoded portion decodes to the given session name. Used in preference to
// a bare marker-presence check because the marker character (U+200B) alone
// is not a unique-to-us signal -- a user could paste a string containing
// one and we'd misidentify it as ours. Decoding to exactly this session's
// id is a strong signal that only our nameWithSession()-emitting paths
// could have produced.
function nameMatchesOurSession(value: string, sessionName: string): boolean {
    return decodeSessionTag(value) === sessionName;
}

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

// Session names that snapshotLocations has confirmed in tabGroups (i.e.
// resolved to an editor-area tab via getSessionFromTab) at least once. The
// creationOptions.location-based cross-check is only used while this set
// doesn't yet contain the session -- otherwise a user dragging a previously
// editor-area terminal into the panel would forever stay classified as
// editor (creationOptions never updates).
const everSeenInEditor = new Set<string>();

// Stable mapping from editor-area Tab to dterm session name. Populated by
// getSessionFromTab on first observation (decoding the tag-encoded session
// ID embedded in the name we set on the terminal). Once cached, survives
// renames, drags between editor columns, and process-name changes -- the
// Tab object reference is stable across all of these, and a user inline-
// rename only wipes the encoding from t.name / tab.label, not the cached
// mapping. WeakMap so closed-tab entries clean up automatically.
const tabToSession = new WeakMap<vscode.Tab, string>();

function getSessionFromTab(tab: vscode.Tab): string | undefined {
    const cached = tabToSession.get(tab);
    if (cached !== undefined) return cached;
    if (!(tab.input instanceof vscode.TabInputTerminal)) return undefined;
    // Primary mechanism: decode the tag-encoded session ID we appended to
    // the name. Works for every dterm-owned terminal that hasn't been
    // user-renamed since creation (the encoding is wiped from t.name /
    // tab.label by Api-source title overrides).
    const decoded = decodeSessionTag(tab.label);
    if (decoded) {
        tabToSession.set(tab, decoded);
        everSeenInEditor.add(decoded);
        return decoded;
    }
    // Defensive fallback: tab.label has no encoding. With the user-rename
    // override path (Pseudoterminal.applyUserLabel), this should be rare --
    // a window of at most one snapshotLabels tick between a user pressing
    // Enter on inline-rename and our re-fire that puts the encoded session
    // id back. The strict label-equality match handles this window. No
    // normalization: an unrenamed dterm terminal currently showing the
    // process name "bash" has t.name = "bash​<encoded>", which will
    // not strict-equal "bash", so a user renaming a different terminal to
    // "bash" can't cross-match an unrenamed sibling.
    for (const t of vscode.window.terminals) {
        const sName = sessionNameOf(t);
        if (!sName) continue;
        if (tab.label === t.name) {
            tabToSession.set(tab, sName);
            everSeenInEditor.add(sName);
            return sName;
        }
    }
    return undefined;
}

function snapshotLabels(): Promise<void> {
    const writes: Promise<void>[] = [];
    for (const t of vscode.window.terminals) {
        const sName = sessionNameOf(t);
        if (!sName) continue;
        const pty = ptyBySession.get(sName);
        if (!pty) continue;
        const current = getMeta(sName);
        const name = t.name;
        // Empty name -> user cleared their inline-rename. Drop the lock so
        // daemon-driven process-name updates take over again, and clear the
        // persisted label.
        if (name === '') {
            pty.unlockName();
            if (current?.label !== undefined) {
                writes.push(setMeta(sName, { ...current, label: undefined }));
            }
            continue;
        }
        // Decodes to our session id -> we produced this value (either an
        // auto-process-name fire or our applied user-label override). Nothing
        // to do; the tab still carries our identity.
        if (nameMatchesOurSession(name, sName)) continue;
        // Else: user inline-renamed to a custom value (or pasted something
        // unrelated). Apply the override: re-fire with the user's visible
        // value but our marker + encoded session id appended, so the tab
        // continues to carry the session id for tab-to-session mapping. The
        // visible portion is preserved verbatim from what the user typed.
        // Locks daemon-driven updates as a side effect, preserving the
        // user's expressed preference.
        pty.applyUserLabel(name);
        if (current?.label !== name) {
            writes.push(setMeta(sName, { ...current, label: name }));
        }
    }
    return Promise.all(writes).then(() => undefined);
}

function snapshotLocations(): Promise<void> {
    // Find editor-area terminals via tabGroups. Terminals in the panel are
    // absent from tabGroups entirely and end up with viewColumn=undefined.
    // Mapping from tab to session is done via getSessionFromTab, which
    // decodes the tag-encoded session ID we embed in every name we set --
    // no name-collision-prone label iteration. The WeakMap inside
    // getSessionFromTab caches the mapping so renames don't break it.
    const inEditor = new Map<string, { viewColumn: number; tabIndex: number }>();
    for (const group of vscode.window.tabGroups.all) {
        for (let i = 0; i < group.tabs.length; i++) {
            const tab = group.tabs[i];
            const sName = getSessionFromTab(tab);
            if (sName) {
                inEditor.set(sName, { viewColumn: group.viewColumn, tabIndex: i });
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
        // in tabGroups.all. Without compensation, those terminals would
        // briefly get viewColumn=undefined written (= panel classification),
        // which lets onDidChangeActiveTerminal misclassify the now-active
        // editor terminal as panel and overwrite panel-active.
        //
        // Cross-check: if the terminal was launched into the editor area AND
        // we've never confirmed it via a tabGroups label-match, preserve the
        // editor classification this tick (and the next, etc.) until
        // tabGroups picks it up. The everSeenInEditor gate keeps this from
        // sticking forever -- once a label-match has happened at least once
        // for the session, subsequent absence from tabGroups means the user
        // dragged it out (to the panel or a different surface), so we let it
        // fall through to panel classification.
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
        } else if (createdInEditor && !everSeenInEditor.has(sName)) {
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
// it whenever the upstream value rotates -- running shells keep the same env
// values but transparently start using the new target on the next connect().
//
// SSH_AUTH_SOCK is standard SSH agent forwarding.
//
// VSCODE_GIT_IPC_HANDLE is the askpass/credential IPC the git extension
// exports into terminals.
//
// VSCODE_IPC_HOOK_CLI is the per-VS-Code-terminal socket that the `code` CLI
// connects to. Rotates per terminal spawn (each terminal gets its own
// socket, alive only while that terminal's pty-host process is alive). Our
// keep-alive bootstrap stub holds one bound for the lifetime of each dterm
// session; updating this symlink on each bootstrap (new + reattach) points
// daemon-side shells at the current stub's socket, which keeps `code` CLI
// working across VS Code window reload.
const MANAGED_SOCKETS: ManagedSocket[] = [
    { envVar: 'SSH_AUTH_SOCK',         linkName: 'ssh-auth.sock' },
    { envVar: 'VSCODE_GIT_IPC_HANDLE', linkName: 'vscode-git-ipc.sock' },
    { envVar: 'VSCODE_IPC_HOOK_CLI',   linkName: 'vscode-ipc.sock' },
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

// Refresh the workspace-scoped symlinks that indirect rotating client sockets
// (SSH_AUTH_SOCK, VSCODE_GIT_IPC_HANDLE) so daemon-side shells stay valid
// across reconnect. Reads upstream values from the supplied envSource and
// falls back to process.env if a value isn't there.
//
// At activation / reconnectAll time, only process.env is available -- it's
// sufficient for SSH_AUTH_SOCK (set by sshd on the extension host) but not
// for VSCODE_GIT_IPC_HANDLE (contributed by the git extension's
// EnvironmentVariableCollection, which only applies at terminal-spawn time
// and never lands in the extension host's own env). At new-session spawn
// time, the bootstrap stub's captured env carries the EVC contributions, so
// passing it in lets us pick up VSCODE_GIT_IPC_HANDLE and similar EVC-only
// values.
function refreshManagedSockets(envSource?: Record<string, string>): Record<string, string> {
    const overrides: Record<string, string> = {};
    const tag = workspaceTag();
    if (!tag) return overrides;
    const dir = agentDir(tag);
    let dirEnsured = false;
    for (const m of MANAGED_SOCKETS) {
        const upstream = envSource?.[m.envVar] ?? process.env[m.envVar];
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
    // The user's clean inline-renamed value (no marker, no encoding) when a
    // rename is active. Stored so we can re-apply it via applyUserLabel after
    // any event that wipes our enriched value out of Api source (notably the
    // user typing a fresh rename). Distinct from lastFiredName, which carries
    // the enriched marker+encoding.
    private userLabel: string | undefined;
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

    // Held so close() can dispose the kept-alive stub Terminal whenever the
    // bootstrap promise resolves -- including the case where close() is
    // called before the bootstrap finishes (rapid create-then-close).
    private readonly bootstrapPromise: Promise<BootstrapResult>;

    constructor(
        public readonly sessionName: string,
        restoredLabel: string | undefined,
        initialDims: { cols: number; rows: number },
        bootstrap: Promise<BootstrapResult>,
        isReattach: boolean,
    ) {
        this.cols = initialDims.cols;
        this.rows = initialDims.rows;
        this.nameLocked = restoredLabel !== undefined;
        this.lastFiredName = restoredLabel;
        this.isReattach = isReattach;
        this.bootstrapPromise = bootstrap;
        if (isReattach) {
            // Daemon-side shell already exists; don't gate connect on the
            // bootstrap. We still hold the promise so close() can dispose
            // the kept-alive stub Terminal once it spawns.
            this.bootstrapDone = true;
        }
        bootstrap.then(
            result => {
                this.bootstrapResult = result;
                // Update the workspace-scoped managed-socket symlinks to
                // point at the values just captured by this bootstrap. For
                // new sessions, the env we'll send to the daemon (with the
                // symlink paths) is built in connect() below; for reattach,
                // existing daemon-side shells already have the symlink paths
                // baked in their env, and updating the symlink target here
                // is what makes their `code` CLI / git-askpass / ssh-agent
                // resolve to the current (post-reload) sockets without any
                // env refresh on the shell side. Idempotent if the bootstrap
                // for a new session already triggered an identical update
                // via connect().
                refreshManagedSockets(result.env);
                if (!isReattach) {
                    this.bootstrapDone = true;
                    this.tryConnect();
                }
                // For reattach, bootstrapResult is recorded so close() can
                // dispose result.stub; we don't use the captured env or args
                // beyond the managed-socket refresh above.
            },
            (e: Error) => {
                if (!isReattach) {
                    this.pendingError = `dterm: failed to start shell: ${e.message}\r\n`;
                    if (this.opened) this.flushError();
                } else {
                    // Reattach without a fresh stub just means no live IPC
                    // socket for `code` CLI; the dterm session itself
                    // continues to work via the existing daemon connection.
                    log(`bootstrap (reattach) failed for ${this.sessionName}: ${e.message}`);
                }
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

    // Record a user-typed label and re-fire with the encoded session ID
    // appended so the tab continues to carry our identity for tab-to-session
    // mapping. The visible portion ("myterm") is preserved verbatim; only
    // invisible characters (marker + tag-encoded session id) are added.
    // Suppresses subsequent daemon-driven process-name updates by locking,
    // which preserves the user's expressed intent.
    applyUserLabel(label: string): void {
        this.userLabel = label;
        this.nameLocked = true;
        const enriched = nameWithSession(label, this.sessionName);
        this.nameEmitter.fire(enriched);
        this.lastFiredName = enriched;
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
            // Apply our workspace-scoped symlink indirection for managed
            // sockets (SSH_AUTH_SOCK, VSCODE_GIT_IPC_HANDLE). We can't rely
            // on TerminalOptions.env to deliver these to the spawned shell
            // because VS Code applies EnvironmentVariableCollection mutators
            // *after* TerminalOptions.env, and the Remote-SSH / git extensions
            // contribute Replace mutators that overwrite our values with the
            // raw rotating upstream paths. By applying here -- after capture,
            // before sending to the daemon -- we get the symlink paths into
            // the actual shell's env so they stay valid across reconnects
            // (refreshManagedSockets keeps the symlink target updated to the
            // current upstream).
            //
            // Pass the bootstrap-captured env as the upstream source so
            // values that only show up in EVC contributions (e.g.,
            // VSCODE_GIT_IPC_HANDLE -- the git extension contributes it via
            // EVC, and it never lands in the extension host's process.env)
            // can also be symlink-indirected.
            Object.assign(env, refreshManagedSockets(this.bootstrapResult.env));
            // Override TERM_PROGRAM so consumers that key off it (notably
            // Claude Code's CLI) don't assume they're inside a freshly-spawned
            // VS Code terminal whose CLAUDE_CODE_SSE_PORT env var is fresh.
            // Claude Code's auto-connect logic falls back to lock-file based
            // discovery (~/.claude/ide/<port>.lock) when TERM_PROGRAM is
            // anything other than "vscode", which gives us cross-reload
            // freshness for free -- the lock files are written by Claude
            // Code's extension on each activation and the CLI reads them
            // at invocation time.
            env.TERM_PROGRAM = 'dterm';
            const dtermVersion = activeCtx?.extension.packageJSON?.version as string | undefined;
            if (dtermVersion) env.TERM_PROGRAM_VERSION = dtermVersion;
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
        // Append the marker AND the tag-encoded session ID. The encoded ID
        // lets getSessionFromTab recover which dterm session this tab
        // represents without relying on label matching (which would collide
        // for unrenamed terminals all showing the same process name). The
        // marker is the visible-vs-encoded delimiter. Both are invisible in
        // the tab UI.
        const marked = nameWithSession(name, this.sessionName);
        this.nameEmitter.fire(marked);
        this.lastFiredName = marked;
    }

    // Re-enable dynamic process-name updates after a user clears their custom
    // label (by inline-renaming to empty -- VS Code's only mechanism for this).
    // Immediately re-fires the latest known process name so the tab updates
    // without waiting for the next daemon event.
    unlockName(): void {
        this.nameLocked = false;
        this.userLabel = undefined;
        this.lastFiredName = undefined;
        if (this.lastProcessNameSeen) {
            const marked = nameWithSession(this.lastProcessNameSeen, this.sessionName);
            this.nameEmitter.fire(marked);
            this.lastFiredName = marked;
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
        // Dispose the kept-alive bootstrap stub. Resolving via the stored
        // promise handles both cases: bootstrap already completed (dispose
        // immediately) and bootstrap still in flight (dispose when it
        // resolves, so a fast close-during-bootstrap doesn't leak).
        void this.bootstrapPromise.then(
            result => {
                try { result.stub.dispose(); } catch { /* already gone */ }
            },
            () => { /* bootstrap failed; no stub to dispose */ },
        );
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
// the stub with. The visible Pseudoterminal hands this to the daemon in its
// `open` message so the daemon-side shell spawns with the right env.
//
// Also carries the stub Terminal itself. The stub is kept alive (no longer
// exits after writing its payload) so VS Code's per-terminal IPC socket --
// whose path is captured in env.VSCODE_IPC_HOOK_CLI -- remains bound for the
// lifetime of the dterm session. The Pseudoterminal disposes the stub in its
// close() handler.
interface BootstrapResult {
    env: Record<string, string>;
    args: string[];
    stub: vscode.Terminal;
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
    // The stub only needs enough env to know where to write its captured
    // payload (DTERM_BOOTSTRAP_SOCKET), to behave as Node when launched via
    // Electron (ELECTRON_RUN_AS_NODE), and to know which real shell binary
    // the daemon should spawn (DTERM_REAL_SHELL, when the shim basename
    // doesn't match the configured shell). The managed-socket symlink
    // indirection (SSH_AUTH_SOCK, VSCODE_GIT_IPC_HANDLE) is applied later,
    // in the Pseudoterminal's connect() before the env is sent to the
    // daemon, because TerminalOptions.env doesn't reliably override values
    // contributed by other extensions' EnvironmentVariableCollections.
    const env: { [key: string]: string } = {
        DTERM_SESSION: sessionName,
        DTERM_BOOTSTRAP_SOCKET: sockPath,
        ELECTRON_RUN_AS_NODE: '1',
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
// forwards stdio. `bootstrap` is always provided: for new sessions, its
// captured env+argv get included in the daemon's `open` message; for
// reattach, only its kept-alive stub Terminal is used (to keep the
// per-session VS Code IPC socket bound) -- the captured env/argv go
// unused because the daemon-side shell already exists. `isReattach`
// tells the Pseudoterminal which of the two it is.
function buildPseudoOptions(
    sessionName: string,
    label: string | undefined,
    viewColumn: number | undefined,
    initialDims: { cols: number; rows: number },
    bootstrap: Promise<BootstrapResult>,
    isReattach: boolean,
): vscode.ExtensionTerminalOptions {
    const pty = new DtermPseudoterminal(sessionName, label, initialDims, bootstrap, isReattach);
    ptyBySession.set(sessionName, pty);
    return {
        // Default name carries the marker + tag-encoded session ID so the
        // brief window between createTerminal and our first onDidChangeName
        // fire still has tab.label carrying our identifier. Without it, a
        // snapshotLocations call inside that window would fail to map the
        // tab via getSessionFromTab (no encoding present, fallback label
        // match would have nothing to match against). Restored user labels
        // are kept verbatim; the constructor locks on them, and the
        // getSessionFromTab fallback handles them via strict label match.
        name: label ?? nameWithSession('dterm', sessionName),
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
// to the per-session bootstrap socket, and return the result -- including
// the stub Terminal itself, which stays alive after the payload is captured.
// The Pseudoterminal owns the stub from that point and disposes it on close.
// Keeping the stub alive preserves the bind on VS Code's per-terminal IPC
// socket (VSCODE_IPC_HOOK_CLI) for the lifetime of the dterm session.
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
            // Stub exit before payload means the socket write failed (or
            // the stub crashed). The payload promise will reject (or has
            // already), so we let it -- the reject() below handles cleanup.
            // After payload is received, we transfer ownership of the stub
            // Terminal to the Pseudoterminal; if it dies unexpectedly later
            // the session's `code` CLI just degrades to non-functional, but
            // the rest of the dterm session keeps working.
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
                // Do NOT dispose the stub -- caller takes ownership and
                // disposes it when the Pseudoterminal closes.
                resolve({ ...result, stub });
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
        // Reattach: the daemon-side shell already exists, so we don't need
        // env/argv from the bootstrap. We still spawn one (and keep it
        // alive for the duration of the Pseudoterminal) purely to hold a
        // bound VS Code per-session IPC socket via VSCODE_IPC_HOOK_CLI --
        // the daemon-side shell's env isn't refreshed to point at it (a
        // future symlink-managed handoff would be needed for that), but
        // having the stub alive is the precondition for any such future
        // freshness mechanism.
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const bootstrap = bootstrapShell(name, cwd).catch(e => {
            log(`reconnectAll: bootstrap (reattach) failed for ${name}: ${(e as Error).message}`);
            throw e;
        });
        const t = vscode.window.createTerminal(
            buildPseudoOptions(name, meta?.label, meta?.viewColumn, { cols: 80, rows: 24 }, bootstrap, /*isReattach=*/true),
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
    // Defer a tab-state dump so onDidChangeTabs has a chance to settle after
    // the final show() calls above. Useful for confirming what tab.label
    // looks like for dterm editor-area tabs (e.g. whether the U+200B marker
    // we fire on names survives into tab.label).
    setTimeout(() => logTabGroupsState('post-reconnect'), 500);
}

// Delete all workspaceState keys starting with the given prefix. Used by the
// dterm.clearLayout commands to wipe layout state either for the current
// client only (prefix `client.${clientId}.`) or for every client that has
// touched this workspace (prefix `client.`). Note: clearing layout state
// doesn't dispose existing dterm terminals or kill daemon sessions; the
// effect is visible on the next reload, when reconnectAll rebuilds layout
// from scratch without the previously-saved meta.
async function clearLayoutState(prefix: string, scopeLabel: string): Promise<void> {
    if (!activeCtx) return;
    // Enumerate matching keys + collect summary stats for the confirm dialog.
    const matching: string[] = [];
    const clientIds = new Set<string>();
    const sessions = new Set<string>();
    for (const key of activeCtx.workspaceState.keys()) {
        if (!key.startsWith(prefix)) continue;
        matching.push(key);
        const m = key.match(/^client\.([^.]+)\.(.+)$/);
        if (m) {
            clientIds.add(m[1]);
            const sessionMatch = m[2].match(/^session\.(.+)$/);
            if (sessionMatch) sessions.add(sessionMatch[1]);
        }
    }
    if (matching.length === 0) {
        vscode.window.showInformationMessage(`dterm: no persisted layout state for ${scopeLabel} in this workspace.`);
        return;
    }
    const detail = `${matching.length} entries (${clientIds.size} client${clientIds.size === 1 ? '' : 's'}, ${sessions.size} session label${sessions.size === 1 ? '' : 's'})`;
    const choice = await vscode.window.showWarningMessage(
        `dterm: clear persisted layout state for ${scopeLabel} in this workspace?`,
        {
            modal: true,
            detail: `${detail}. Existing terminals continue to work; the effect of clearing shows up on the next window reload, when reconnectAll rebuilds layout without the saved meta. Daemon sessions are not affected -- use "dterm: Restart daemon" if you also want to terminate live sessions.`,
        },
        'Clear',
    );
    if (choice !== 'Clear') return;
    for (const key of matching) {
        await activeCtx.workspaceState.update(key, undefined);
    }
    log(`clearLayoutState: cleared ${matching.length} entries for ${scopeLabel} (prefix=${JSON.stringify(prefix)})`);
    vscode.window.showInformationMessage(`dterm: cleared ${detail} for ${scopeLabel}. Reload window to see effect.`);
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
    // Mirror the override we apply in Pseudoterminal.connect() before
    // sending env to the daemon: the visible terminal's spawn replaces
    // the raw upstream socket paths (SSH_AUTH_SOCK, VSCODE_GIT_IPC_HANDLE)
    // with our workspace-scoped symlink paths so reattached shells stay
    // valid across reconnect. Pass freshResult.env so EVC-only contributions
    // (like VSCODE_GIT_IPC_HANDLE from the git extension) get picked up;
    // without that, refreshManagedSockets would skip them and the diagnostic
    // would report them as drift.
    Object.assign(freshEnv, refreshManagedSockets(freshResult.env));
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
function hexCodepoints(s: string): string {
    return Array.from(s).map(c => c.codePointAt(0)!.toString(16).padStart(4, '0')).join(' ');
}

function logTabGroupsState(tag: string): void {
    try {
        const groups = vscode.window.tabGroups.all.map(g => ({
            viewColumn: g.viewColumn,
            isActive: g.isActive,
            tabs: g.tabs.map(t => ({
                label: t.label,
                labelHex: hexCodepoints(t.label),
                inputType: t.input?.constructor?.name ?? 'undefined',
            })),
        }));
        const terms = vscode.window.terminals.map(t => ({
            name: t.name,
            nameHex: hexCodepoints(t.name),
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
                    buildPseudoOptions(sessionName, undefined, undefined, { cols: 80, rows: 24 }, bootstrapPromise, /*isReattach=*/false),
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
            // Drop the "have we seen this in editor" flag so a re-created
            // session starts fresh (its first snapshot may need the
            // creationOptions cross-check while tabGroups updates).
            everSeenInEditor.delete(name);
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
        vscode.commands.registerCommand('dterm.clearLayoutForCurrentClient',
            () => clearLayoutState(`client.${clientId}.`, 'current client')),
        vscode.commands.registerCommand('dterm.clearLayoutForAllClients',
            () => clearLayoutState('client.', 'all clients')),
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
