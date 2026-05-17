import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as cp from 'child_process';
import * as os from 'os';
import { oneShot, readDaemonLogTail, isDaemonAlive } from './client';
import { agentDir, daemonLogPath, socketPath } from './paths';

const PROFILE_ID = 'dterm.profile';

let activeCtx: vscode.ExtensionContext | undefined;
let logChannel: vscode.OutputChannel | undefined;
let daemonLogChannel: vscode.OutputChannel | undefined;
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

// Marker the stub appends to process.title (U+200B / zero-width space). When
// VS Code's /proc/<pid>/comm poll picks up the name and uses it as the tab
// title, the marker is invisible to the user but lets snapshotLabels tell
// daemon-driven names apart from user-typed renames.
const FG_NAME_MARKER = '​';

// Tab-title values to ignore as "not a user rename." The stub's interpreter
// usually shows up here briefly between exec() and our `process.title` setter
// firing: "env" from `/usr/bin/env node` shebang resolution (the kernel
// initially exec's /usr/bin/env), then "node" once env resolves its second
// argument. /proc/comm is set from the basename in execve, so even with
// ELECTRON_RUN_AS_NODE active and the resolved binary being VS Code's
// Electron, the kernel still records "node" (not "electron"). Neither
// value is something a user would meaningfully type as a tab label.
const PROC_NAME_BLACKLIST = new Set(['env', 'node']);

function snapshotLabels(): Promise<void> {
    const writes: Promise<void>[] = [];
    for (const t of vscode.window.terminals) {
        const sName = sessionNameOf(t);
        if (!sName) continue;
        const current = getMeta(sName);
        const name = t.name;
        // Empty rename -- VS Code's inline tab rename to "" -- means the user
        // wants the dynamic name back. Drop any saved label.
        if (name === '') {
            if (current?.label !== undefined) {
                writes.push(setMeta(sName, { ...current, label: undefined }));
            }
            continue;
        }
        // Stub-driven names carry the U+200B marker. They follow the
        // foreground process and shouldn't be persisted as user labels.
        if (name.includes(FG_NAME_MARKER)) continue;
        // Stub interpreter names that briefly leak through /proc/comm before
        // process.title takes effect. Not user input -- don't persist.
        if (PROC_NAME_BLACKLIST.has(name)) continue;
        // Anything else is a real user rename (sticky via TitleEventSource.Api).
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
// (anything other than bash/zsh/fish), we use the `dterm` shim -- the
// unrecognized basename means VS Code skips injection entirely, and
// DTERM_REAL_SHELL tells the stub which binary the daemon should actually
// spawn.
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

// Build the VS Code terminal options for the visible dterm shell. We launch
// our stub (out/shims/<bash|zsh|fish|dterm>) as shellPath; VS Code's built-in
// terminal pipeline handles spawning it, injecting shell-integration env,
// and polling /proc/<pid>/comm for the tab title. The stub connects to the
// daemon, opens or attaches a session, and bridges stdio. Tab title flows:
// daemon tracks foreground process -> sends process_name -> stub does
// process.title -> /proc/comm updates -> VS Code's polling refreshes the tab.
function buildShellOptions(
    sessionName: string,
    cwd: string | undefined,
    label: string | undefined,
    viewColumn: number | undefined,
): vscode.TerminalOptions {
    const cfg = shellConfig();
    const shellBinary = resolveShellBinary(cfg.shell);
    const { stubPath, shimName } = stubPathForShell(shellBinary);
    // Symlink overrides for managed sockets so reattached terminals continue
    // to see live SSH_AUTH_SOCK / VSCODE_GIT_IPC_HANDLE. VS Code's env
    // collections would otherwise put the literal current socket path into
    // the stub's env, baking it into the shell on first spawn.
    //
    // ELECTRON_RUN_AS_NODE makes process.execPath (VS Code's Electron binary
    // on a local install) behave as plain Node so the stub's `#!/usr/bin/env
    // node` shebang resolves correctly. Real Node ignores the var, so it's
    // safe on remote/server hosts where process.execPath is already
    // standalone Node. The daemon strips it before spawning the user's shell.
    const env: { [key: string]: string } = {
        DTERM_SESSION: sessionName,
        ELECTRON_RUN_AS_NODE: '1',
        ...refreshManagedSockets(),
    };
    if (shimName === 'dterm' || path.basename(shellBinary) !== shimName) {
        env.DTERM_REAL_SHELL = shellBinary;
    }
    return {
        // Setting name when restoring a user-saved label makes VS Code mark
        // the title as TitleEventSource.Api, which is sticky and bypasses
        // /proc/comm polling. Leaving it unset for fresh sessions lets the
        // ${process} template pick up the stub's process.title.
        name: label,
        shellPath: stubPath,
        shellArgs: cfg.shellArgs,
        cwd,
        env,
        // isTransient: true blocks VS Code's native persistence from
        // double-creating dterm tabs as default-bash "imposters" on reload.
        // The cost is the pty host lazy-spawns the shell only for the
        // active tab in each editor group at creation time -- if rapid
        // create calls steal the active slot from each other, in-flight
        // spawns get canceled. reconnectAll mitigates by creating editor-
        // area terminals sequentially with `await Terminal.processId`
        // between each, letting each spawn complete before the next
        // creation displaces it.
        isTransient: true,
        iconPath: activeCtx
            ? {
                  light: vscode.Uri.joinPath(activeCtx.extensionUri, 'icons', 'dterm-tab-light.svg'),
                  dark: vscode.Uri.joinPath(activeCtx.extensionUri, 'icons', 'dterm-tab-dark.svg'),
              }
            : new vscode.ThemeIcon('plug'),
        color: new vscode.ThemeColor('terminal.ansiCyan'),
        location: viewColumn !== undefined ? { viewColumn } : undefined,
    };
}


function sessionNameOf(t: vscode.Terminal): string | undefined {
    // For shell-binary terminals (TerminalOptions), creationOptions carries
    // the env we injected DTERM_SESSION into. ExtensionTerminalOptions
    // (Pseudoterminals) doesn't expose env this way -- we no longer use that
    // path, but the early returns keep this safe even if a non-dterm terminal
    // somehow lacks creationOptions.env.
    const co = t.creationOptions as vscode.TerminalOptions;
    const v = co.env?.DTERM_SESSION;
    return typeof v === 'string' ? v : undefined;
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
        const t = vscode.window.createTerminal(buildShellOptions(name, cwd, meta?.label, meta?.viewColumn));
        created.push({ name, t, isPanel: meta?.viewColumn === undefined });
        // For editor-area terminals only: VS Code's pty host lazy-spawns
        // when isTransient is true, scheduling the spawn for the terminal
        // that's active in the group. Rapid sibling creations within the
        // same group steal active status and cancel in-flight spawns -- so
        // wait for this terminal's shell to actually spawn (or time out)
        // before creating the next. Panel terminals don't have this
        // problem; they all spawn eagerly regardless of activation order.
        if (meta?.viewColumn !== undefined) {
            const pid = await waitForSpawn(t);
            log(`reconnectAll: ${name} spawn ${pid !== undefined ? `pid=${pid}` : 'TIMEOUT'}`);
        }
    }
    // Focus the saved-active terminal if it exists in this restore set;
    // otherwise fall back to the first panel terminal so the panel pops open.
    // preserveFocus on .show(true) keeps the active editor focused.
    const savedActive = getActive();
    const activeEntry = savedActive ? created.find(e => e.name === savedActive) : undefined;
    const finalShow = activeEntry ?? created.find(e => e.isPanel);
    log(`reconnectAll: created=${JSON.stringify(created.map(e => ({name: e.name, isPanel: e.isPanel})))} savedActive=${savedActive ?? '-'} willFinalShow=${finalShow?.name ?? '-'}`);
    finalShow?.t.show(true);
}

// Race Terminal.processId against a timeout. Returns the resolved PID, or
// undefined if the shell hasn't started within timeoutMs (which on an
// isTransient editor-area terminal that lost active-tab status before the
// pty host got around to spawning means it's stuck and won't recover).
function waitForSpawn(t: vscode.Terminal, timeoutMs = 3000): Promise<number | undefined> {
    return Promise.race([
        Promise.resolve(t.processId),
        new Promise<undefined>(r => setTimeout(() => r(undefined), timeoutMs)),
    ]);
}

// One-shot dump of tabGroups.all, terminals, and active terminal so we can see
// what the public API actually surfaces -- specifically whether aux-window tab
// groups are visible (with what viewColumn) and how aux-window terminals appear
// in vscode.window.terminals. Helps diagnose the aux-window restoration puzzle.
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
                log(`profile: provideTerminalProfile invoked`);
                const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                const allocated = await allocateSessionName();
                const sessionName = allocated ?? `vscode-noworkspace-${process.pid}-${Date.now()}`;
                if (!allocated) log(`profile: allocating fallback session ${sessionName}`);
                else log(`profile: allocated session ${sessionName}`);
                pendingFocus.add(sessionName);
                return new vscode.TerminalProfile(buildShellOptions(sessionName, cwd, undefined, undefined));
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
        }),
        vscode.window.onDidOpenTerminal(t => {
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
