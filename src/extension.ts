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
let pollTimer: NodeJS.Timeout | undefined;
const pendingFocus = new Set<string>();

// Per-session UI metadata (label, editor-area location). Stored in workspaceState
// under a client-specific key derived from vscode.env.machineId so two laptops
// connecting to the same remote get independent layouts — matching how VS Code's
// built-in terminal layout is local-to-client.
interface SessionMeta {
    label?: string;
    viewColumn?: number;
    tabIndex?: number;
}

function metaKey(sessionName: string): string {
    return `client.${vscode.env.machineId}.session.${sessionName}`;
}

function getMeta(sessionName: string): SessionMeta | undefined {
    if (!activeCtx) return undefined;
    return activeCtx.workspaceState.get<SessionMeta>(metaKey(sessionName));
}

async function setMeta(sessionName: string, meta: SessionMeta | undefined): Promise<void> {
    if (!activeCtx) return;
    const empty = !meta || (meta.label === undefined && meta.viewColumn === undefined);
    await activeCtx.workspaceState.update(metaKey(sessionName), empty ? undefined : meta);
}

function metaEqual(a: SessionMeta | undefined, b: SessionMeta | undefined): boolean {
    return (a?.label === b?.label)
        && (a?.viewColumn === b?.viewColumn)
        && (a?.tabIndex === b?.tabIndex);
}

function log(line: string): void {
    if (logChannel) logChannel.appendLine(`[${new Date().toISOString()}] ${line}`);
}

// The stub appends U+200B to process.title for every daemon-driven foreground
// name change. node-pty propagates that into _processName, which feeds the
// ${process} tab template, which surfaces as t.name. The marker is the only
// way to tell those ephemeral updates apart from user renames -- VS Code
// exposes no rename event and the two arrive through the same property.
//
// The same marker is also baked into /proc/<pid>/comm at exec time via a
// `node\u200B` symlink invoked from the stub's shebang (see ensureNodeShim), so
// the marker is present from the very first node-pty poll -- no startup race.
const FG_NAME_MARKER = '\u200B';

function snapshotLabels(): void {
    for (const t of vscode.window.terminals) {
        const sName = sessionNameOf(t);
        if (!sName) continue;
        // Marker-tagged names are always daemon-driven (from process.title or
        // the shebang trick at startup) -- skip. Bare names mean either a user
        // rename or a restored terminal whose TerminalOptions.name locked in
        // Api-source title (which bypasses the template, so the marker can't
        // appear). Both should be persisted as labels.
        if (t.name.endsWith(FG_NAME_MARKER)) continue;
        const current = getMeta(sName);
        if (current?.label !== t.name) {
            void setMeta(sName, { ...current, label: t.name });
        }
    }
}

function snapshotLocations(): void {
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
    for (const t of vscode.window.terminals) {
        const sName = sessionNameOf(t);
        if (!sName) continue;
        const target = inEditor.get(sName);
        const current = getMeta(sName);
        const next: SessionMeta = {
            ...current,
            viewColumn: target?.viewColumn,
            tabIndex: target?.tabIndex,
        };
        if (!metaEqual(current, next)) {
            void setMeta(sName, next);
        }
    }
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
        snapshotLabels();
        snapshotLocations();
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

// Directory we prepend to the stub's PATH so /usr/bin/env can find `node​`.
// Kept separate from out/shims (which holds bash/zsh/fish/dterm) so we don't
// expose those shell shims on the user's shell PATH where they could shadow
// the real bash/zsh/fish.
function nodeShimDir(): string {
    if (!activeCtx) throw new Error('dterm: extension not activated');
    return path.join(activeCtx.extensionPath, 'out', 'nodeShim');
}

// Ensure out/nodeShim/node​ points at VS Code's current node. The stub's
// shebang is `#!/usr/bin/env node​`, so /usr/bin/env will look up the
// marker-tagged name in PATH; resolving it via this symlink makes the kernel
// set /proc/<stub-pid>/comm to "node​" (basename of the path execve was
// called with), which VS Code's 200ms node-pty poll picks up as the initial
// _processName -- marker present from the very first tick.
function ensureNodeShim(): void {
    const dir = nodeShimDir();
    const link = path.join(dir, 'node\u200B');
    const target = process.execPath;
    try {
        fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
        log(`nodeShim: mkdir failed: ${(e as Error).message}`);
        return;
    }
    let current: string | undefined;
    try { current = fs.readlinkSync(link); } catch { /* not there */ }
    if (current === target) return;
    try { fs.unlinkSync(link); } catch { /* not there */ }
    try {
        fs.symlinkSync(target, link);
        log(`nodeShim: ${link} -> ${target}`);
    } catch (e) {
        log(`nodeShim: symlink failed: ${(e as Error).message}`);
    }
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
// it whenever the upstream value in process.env changes — running shells keep
// the same SSH_AUTH_SOCK / VSCODE_IPC_HOOK_CLI / VSCODE_GIT_IPC_HANDLE in their
// env but transparently start using the new target on the next connect().
const MANAGED_SOCKETS: ManagedSocket[] = [
    { envVar: 'SSH_AUTH_SOCK',         linkName: 'ssh-auth.sock' },
    { envVar: 'VSCODE_IPC_HOOK_CLI',   linkName: 'vscode-ipc.sock' },
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

function buildOptions(
    sessionName: string,
    cwd?: string,
    label?: string,
    viewColumn?: number,
): vscode.TerminalOptions {
    const cfg = shellConfig();
    const shellBinary = resolveShellBinary(cfg.shell);
    const { stubPath, shimName } = stubPathForShell(shellBinary);
    // Symlink overrides for managed sockets so reattached terminals continue
    // to see live SSH_AUTH_SOCK / VSCODE_IPC_HOOK_CLI / VSCODE_GIT_IPC_HANDLE.
    // VS Code's env collections would otherwise put the literal current
    // socket path into the stub's env, baking it into the running shell.
    //
    // PATH is prepended with nodeShimDir so /usr/bin/env in the stub's shebang
    // resolves `node​` to our symlink -- which makes /proc/<stub-pid>/comm
    // start out marker-tagged. The user's PATH is preserved as the tail.
    //
    // ELECTRON_RUN_AS_NODE makes process.execPath (typically VS Code's Electron
    // binary on a local install) behave as plain Node. Real Node ignores the
    // var, so this is safe on remote/server hosts where process.execPath is
    // already a standalone node. The daemon strips it before spawning shells.
    const env: { [key: string]: string } = {
        DTERM_SESSION: sessionName,
        PATH: `${nodeShimDir()}:${process.env.PATH ?? ''}`,
        ELECTRON_RUN_AS_NODE: '1',
        ...refreshManagedSockets(),
    };
    // If the shim basename doesn't match the actual shell (always true for
    // the `dterm` fallback shim, and possibly true if user pointed `bash`
    // shim at a custom bash build), tell the stub which real binary the
    // daemon should spawn. Otherwise the stub falls back to PATH lookup.
    if (shimName === 'dterm' || path.basename(shellBinary) !== shimName) {
        env.DTERM_REAL_SHELL = shellBinary;
    }
    return {
        // Only set name when restoring a user-defined label. Setting it via
        // TerminalOptions makes the title TitleEventSource.Api, which makes
        // _staticTitle sticky and bypasses the ${process} template -- so the
        // stub's process.title updates would stop reaching the tab. Leaving
        // it unset lets the template surface the daemon-tracked process name.
        name: label,
        shellPath: stubPath,
        shellArgs: cfg.shellArgs,
        cwd,
        env,
        // VS Code's persistence for editor-area terminals drops the launch
        // config and falls back to default-profile on revival (see
        // TerminalInputSerializer). For panel terminals persistence preserves
        // launch config but adds no value over dterm's own restoration. Mark
        // transient and let reconnectAll + workspaceState-stored metadata
        // handle placement consistently for both cases.
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
    // Panel sessions first so we can pop the panel via .show(true) on the
    // first one as soon as it exists, rather than waiting for the full loop.
    // Editor-area sessions follow, sorted by (viewColumn, tabIndex) — VS Code
    // appends new terminals at the end of the target group, so creation order
    // preserves relative position within each column.
    const sortedOurs = ours.slice().sort((a, b) => {
        const la = getMeta(a);
        const lb = getMeta(b);
        if (la?.viewColumn !== undefined && lb?.viewColumn !== undefined) {
            if (la.viewColumn !== lb.viewColumn) return la.viewColumn - lb.viewColumn;
            return (la.tabIndex ?? 0) - (lb.tabIndex ?? 0);
        }
        if (la?.viewColumn !== undefined) return 1;
        if (lb?.viewColumn !== undefined) return -1;
        return a.localeCompare(b);
    });
    let panelShown = false;
    for (const name of sortedOurs) {
        if (alreadyOpen.has(name)) {
            // Reload (not full window close+reopen) keeps existing dterm tabs
            // alive; just acknowledge them, don't recreate.
            const t = vscode.window.terminals.find(t => sessionNameOf(t) === name);
            log(`reconnectAll: already open ${name}`);
            if (t && !panelShown) {
                // preserveFocus avoids stealing focus from the active editor.
                t.show(true);
                panelShown = true;
            }
            continue;
        }
        const meta = getMeta(name);
        log(`reconnectAll: creating terminal for ${name} (${meta?.viewColumn !== undefined ? `col ${meta.viewColumn} idx ${meta.tabIndex ?? 0}` : 'panel'})`);
        const t = vscode.window.createTerminal(buildOptions(name, cwd, meta?.label, meta?.viewColumn));
        if (!panelShown && meta?.viewColumn === undefined) {
            t.show(true);
            panelShown = true;
        }
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
    ensureNodeShim();

    ctx.subscriptions.push(
        vscode.window.registerTerminalProfileProvider(PROFILE_ID, {
            async provideTerminalProfile() {
                const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                const name = await allocateSessionName();
                if (!name) {
                    const fallback = `vscode-noworkspace-${process.pid}-${Date.now()}`;
                    log(`profile: allocating fallback session ${fallback}`);
                    pendingFocus.add(fallback);
                    return new vscode.TerminalProfile(buildOptions(fallback, cwd));
                }
                log(`profile: allocated session ${name}`);
                pendingFocus.add(name);
                return new vscode.TerminalProfile(buildOptions(name, cwd));
            },
        }),
    );

    ctx.subscriptions.push(
        vscode.window.tabGroups.onDidChangeTabs(() => snapshotLocations()),
        vscode.window.tabGroups.onDidChangeTabGroups(() => snapshotLocations()),
        vscode.window.onDidChangeActiveTerminal(() => snapshotLabels()),
        vscode.window.onDidOpenTerminal(t => {
            const name = sessionNameOf(t);
            if (name && pendingFocus.delete(name)) {
                // For stub terminals there's no ready-state to wait on —
                // the stub is starting up and will produce output as the
                // shell prints its first prompt. Showing now is fine.
                t.show();
            }
            snapshotLabels();
            ensurePolling();
        }),
        vscode.window.onDidChangeTerminalState(() => snapshotLabels()),
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
            // Window close / extension reload / process exit — snapshot the
            // current label one last time so any rename done since the last
            // poll tick is persisted before we go down.
            snapshotLabels();
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
    snapshotLabels();
    snapshotLocations();
    activeCtx = undefined;
}
