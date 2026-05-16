import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as cp from 'child_process';
import * as os from 'os';
import { DtermPseudoterminal } from './pty';
import { oneShot, readDaemonLogTail, isDaemonAlive } from './client';
import { agentDir, daemonLogPath, socketPath } from './paths';

const PROFILE_ID = 'dterm.profile';

let activeCtx: vscode.ExtensionContext | undefined;
let logChannel: vscode.OutputChannel | undefined;
let pollTimer: NodeJS.Timeout | undefined;
const pendingPushes = new Set<Promise<unknown>>();
const pendingFocus = new Set<string>();
// Tracks the last label value we pushed to the daemon for each session, so
// snapshotLabels doesn't re-send the same value on every tick.
const pushedLabels = new Map<string, string | undefined>();
// Same idea for terminal locations (viewColumn + tabIndex when moved to the
// editor area; undefined means panel).
interface TerminalLocation { viewColumn: number; tabIndex: number }
const pushedLocations = new Map<string, TerminalLocation | undefined>();

function locationsEqual(a: TerminalLocation | undefined, b: TerminalLocation | undefined): boolean {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return a.viewColumn === b.viewColumn && a.tabIndex === b.tabIndex;
}

function log(line: string): void {
    if (logChannel) logChannel.appendLine(`[${new Date().toISOString()}] ${line}`);
}

function defaultLabelFor(sessionName: string): string {
    return `dterm: ${sessionName}`;
}

async function pushLabel(name: string, label: string | undefined): Promise<void> {
    if (pushedLabels.get(name) === label) return;
    pushedLabels.set(name, label);
    log(`pushLabel ${name} -> ${label === undefined ? '(clear)' : `"${label}"`}`);
    const p = oneShot(
        daemonScriptPath(),
        { type: 'set_label', name, label },
        () => true,
        500,
    );
    pendingPushes.add(p);
    p.finally(() => pendingPushes.delete(p));
    await p;
}

async function pushLocation(name: string, loc: TerminalLocation | undefined): Promise<void> {
    if (locationsEqual(pushedLocations.get(name), loc)) return;
    pushedLocations.set(name, loc);
    log(`pushLocation ${name} -> ${loc === undefined ? '(panel)' : `col ${loc.viewColumn} idx ${loc.tabIndex}`}`);
    const p = oneShot(
        daemonScriptPath(),
        {
            type: 'set_location',
            name,
            viewColumn: loc?.viewColumn,
            tabIndex: loc?.tabIndex,
        },
        () => true,
        500,
    );
    pendingPushes.add(p);
    p.finally(() => pendingPushes.delete(p));
    await p;
}

function ptyOf(t: vscode.Terminal): DtermPseudoterminal | undefined {
    const co = t.creationOptions as vscode.ExtensionTerminalOptions & { pty?: unknown };
    return co.pty instanceof DtermPseudoterminal ? co.pty : undefined;
}

function snapshotLabels(): void {
    for (const t of vscode.window.terminals) {
        const sName = sessionNameOf(t);
        if (!sName) continue;
        const pty = ptyOf(t);
        const current = t.name;
        const isDefault = current === defaultLabelFor(sName);
        const isOscFired = pty?.lastFiredTitle !== undefined && current === pty.lastFiredTitle;
        const isUserOverride = !isDefault && !isOscFired;

        if (pty) pty.suppressTitleUpdates = isUserOverride;

        const target = isUserOverride ? current : undefined;
        if (pushedLabels.get(sName) !== target) {
            log(`snapshot: ${sName} -> ${target === undefined ? '(clear)' : `"${target}"`} (current="${current}", default=${isDefault}, osc=${isOscFired})`);
            void pushLabel(sName, target);
        }
    }
}

function snapshotLocations(): void {
    // Build map of session name -> {viewColumn, tabIndex} for terminals
    // currently in the editor area. Terminals in the panel are absent.
    const inEditor = new Map<string, TerminalLocation>();
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
        if (!locationsEqual(pushedLocations.get(sName), target)) {
            void pushLocation(sName, target);
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
    labels: Record<string, string>;
    locations: Record<string, TerminalLocation>;
}

async function fetchDaemonSessions(): Promise<DaemonSessions | undefined> {
    const resp = await oneShot(
        daemonScriptPath(),
        { type: 'list' },
        m => m.type === 'list_response',
    );
    if (!resp || resp.type !== 'list_response') return undefined;
    return {
        names: resp.names,
        labels: resp.labels ?? {},
        locations: resp.locations ?? {},
    };
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

function currentExtensionHostEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (typeof v === 'string') env[k] = v;
    }
    for (const [k, v] of Object.entries(refreshManagedSockets())) env[k] = v;
    return env;
}

function buildOptions(
    sessionName: string,
    cwd?: string,
    label?: string,
    viewColumn?: number,
): vscode.ExtensionTerminalOptions {
    const cfg = shellConfig();
    const pty = new DtermPseudoterminal({
        sessionName,
        daemonScript: daemonScriptPath(),
        cwd,
        shell: cfg.shell,
        shellArgs: cfg.shellArgs,
        env: currentExtensionHostEnv(),
        scrollbackLines: cfg.scrollbackLines,
        suppressTitleUpdates: label !== undefined,
        log,
    });
    return {
        name: label ?? defaultLabelFor(sessionName),
        pty,
        isTransient: true,
        iconPath: new vscode.ThemeIcon('plug'),
        color: new vscode.ThemeColor('terminal.ansiCyan'),
        location: viewColumn !== undefined ? { viewColumn } : undefined,
    };
}

function sessionNameOf(t: vscode.Terminal): string | undefined {
    const co = t.creationOptions as vscode.ExtensionTerminalOptions & { pty?: unknown };
    if (co.pty instanceof DtermPseudoterminal) return co.pty.sessionName;
    return undefined;
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
    if (ours.length === 0) {
        if (opts?.interactive) {
            vscode.window.showInformationMessage(
                'dterm: no live sessions for this workspace.',
            );
        }
        return;
    }
    // Prime label cache with the daemon's current value so snapshotLabels
    // doesn't immediately re-push the same value.
    for (const n of ours) {
        pushedLabels.set(n, live.labels[n]);
        pushedLocations.set(n, live.locations[n]);
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
        const la = live.locations[a];
        const lb = live.locations[b];
        if (la && lb) {
            if (la.viewColumn !== lb.viewColumn) return la.viewColumn - lb.viewColumn;
            return la.tabIndex - lb.tabIndex;
        }
        if (la) return 1;
        if (lb) return -1;
        return a.localeCompare(b);
    });
    let panelShown = false;
    for (const name of sortedOurs) {
        if (alreadyOpen.has(name)) {
            const t = vscode.window.terminals.find(t => sessionNameOf(t) === name);
            const pty = t ? ptyOf(t) : undefined;
            if (pty?.ready) {
                log(`reconnectAll: resync already-open ${name}`);
                pty.resync();
            } else {
                log(`reconnectAll: already open but not ready: ${name}`);
            }
            if (t && !panelShown && !live.locations[name]) {
                // preserveFocus avoids stealing focus from the active editor.
                t.show(true);
                panelShown = true;
            }
            continue;
        }
        const loc = live.locations[name];
        log(`reconnectAll: creating terminal for ${name} (${loc ? `col ${loc.viewColumn} idx ${loc.tabIndex}` : 'panel'})`);
        const t = vscode.window.createTerminal(buildOptions(name, cwd, live.labels[name], loc?.viewColumn));
        if (!panelShown && !loc) {
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
            if (name && pendingFocus.has(name)) {
                const pty = ptyOf(t);
                if (pty?.ready) {
                    pendingFocus.delete(name);
                    t.show();
                } else if (pty) {
                    const sub = pty.onDidReady(() => {
                        sub.dispose();
                        if (pendingFocus.delete(name)) t.show();
                    });
                    setTimeout(() => {
                        sub.dispose();
                        pendingFocus.delete(name);
                    }, 10000);
                } else {
                    pendingFocus.delete(name);
                    t.show();
                }
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
                pushedLabels.delete(name);
                pushedLocations.delete(name);
                return;
            }
            const pty = ptyOf(t);
            const isOscFired = pty?.lastFiredTitle !== undefined && t.name === pty.lastFiredTitle;
            const isDefault = t.name === defaultLabelFor(name);
            const target = (!isOscFired && !isDefault) ? t.name : undefined;
            log(`close: pushing label ${target === undefined ? '(clear)' : `"${target}"`} for ${name} (default=${isDefault}, oscFired=${isOscFired}, lastFired="${pty?.lastFiredTitle ?? ''}")`);
            await pushLabel(name, target);
        }),
    );

    ctx.subscriptions.push(
        vscode.commands.registerCommand('dterm.reconnect', () =>
            reconnectAll(ctx, { interactive: true }),
        ),
    );

    ctx.subscriptions.push(
        vscode.commands.registerCommand('dterm.resyncActive', () => {
            const t = vscode.window.activeTerminal;
            if (!t) {
                vscode.window.showInformationMessage('dterm: no active terminal.');
                return;
            }
            const pty = ptyOf(t);
            if (!pty) {
                vscode.window.showInformationMessage('dterm: active terminal is not a dterm session.');
                return;
            }
            if (!pty.ready) {
                vscode.window.showInformationMessage('dterm: session is still connecting.');
                return;
            }
            log(`resyncActive: ${pty.sessionName}`);
            pty.resync();
        }),
    );

    ctx.subscriptions.push(
        vscode.commands.registerCommand('dterm.killSession', async () => {
            const t = vscode.window.activeTerminal;
            const name = t ? sessionNameOf(t) : undefined;
            if (!name) {
                vscode.window.showInformationMessage('dterm: active terminal is not a dterm session.');
                return;
            }
            const ok = await daemonKill(name);
            pushedLabels.delete(name);
            pushedLocations.delete(name);
            t?.dispose();
            vscode.window.showInformationMessage(
                ok ? `dterm: killed ${name}.` : `dterm: kill request sent for ${name}.`,
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
            pushedLabels.clear();
            pushedLocations.clear();
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
            ch.appendLine(`daemon labels: ${live === undefined ? '(daemon unreachable)' : JSON.stringify(live.labels)}`);
            ch.appendLine(`daemon locations: ${live === undefined ? '(daemon unreachable)' : JSON.stringify(live.locations)}`);
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
                const lbl = live.labels[n];
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
    if (pendingPushes.size > 0) {
        await Promise.allSettled([...pendingPushes]);
    }
    activeCtx = undefined;
}
