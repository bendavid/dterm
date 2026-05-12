import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as cp from 'child_process';
import * as os from 'os';
import { DtermPseudoterminal } from './pty';
import { oneShot, readDaemonLogTail, isDaemonAlive } from './client';
import { daemonLogPath, socketPath } from './paths';

const PROFILE_ID = 'dterm.profile';
const KEY_SESSIONS = 'dterm.sessions';
const KEY_NEXT_INDEX = 'dterm.nextIndex';
const KEY_WORKSPACE_TAG = 'dterm.workspaceTag';
const KEY_LABELS = 'dterm.labels';

let activeCtx: vscode.ExtensionContext | undefined;
let logChannel: vscode.OutputChannel | undefined;
let pollTimer: NodeJS.Timeout | undefined;
const pendingWrites = new Set<Promise<unknown>>();
const pendingFocus = new Set<string>();

function log(line: string): void {
    if (logChannel) logChannel.appendLine(`[${new Date().toISOString()}] ${line}`);
}

function updateState<T>(
    ctx: vscode.ExtensionContext,
    key: string,
    value: T,
): Promise<void> {
    const p = Promise.resolve(ctx.workspaceState.update(key, value));
    pendingWrites.add(p);
    p.finally(() => pendingWrites.delete(p));
    return p.then(() => undefined);
}

function defaultLabelFor(sessionName: string): string {
    return `dterm: ${sessionName}`;
}

function getLabels(ctx: vscode.ExtensionContext): Record<string, string> {
    return ctx.workspaceState.get<Record<string, string>>(KEY_LABELS, {});
}

async function setLabel(
    ctx: vscode.ExtensionContext,
    sessionName: string,
    label: string | undefined,
): Promise<void> {
    const labels = { ...getLabels(ctx) };
    if (label === undefined || label === defaultLabelFor(sessionName)) {
        if (labels[sessionName] === undefined) return;
        delete labels[sessionName];
    } else {
        if (labels[sessionName] === label) return;
        labels[sessionName] = label;
    }
    await updateState(ctx, KEY_LABELS, labels);
}

function ptyOf(t: vscode.Terminal): DtermPseudoterminal | undefined {
    const co = t.creationOptions as vscode.ExtensionTerminalOptions & { pty?: unknown };
    return co.pty instanceof DtermPseudoterminal ? co.pty : undefined;
}

function snapshotLabels(ctx: vscode.ExtensionContext): void {
    const labels = getLabels(ctx);
    let next: Record<string, string> | undefined;
    for (const t of vscode.window.terminals) {
        const sName = sessionNameOf(t);
        if (!sName) continue;
        const pty = ptyOf(t);
        const current = t.name;
        const isDefault = current === defaultLabelFor(sName);
        const isOscFired = pty?.lastFiredTitle !== undefined && current === pty.lastFiredTitle;
        const isUserOverride = !isDefault && !isOscFired;

        if (pty) pty.suppressTitleUpdates = isUserOverride;

        const stored = labels[sName];
        if (isUserOverride) {
            if (stored !== current) {
                next = next ?? { ...labels };
                next[sName] = current;
                log(`snapshot: ${sName} label="${current}" (was ${stored === undefined ? 'unset' : `"${stored}"`})`);
            }
        } else if (stored !== undefined) {
            next = next ?? { ...labels };
            delete next[sName];
            log(`snapshot: ${sName} cleared (was "${stored}", current="${current}", default=${isDefault}, osc=${isOscFired})`);
        }
    }
    if (next) void updateState(ctx, KEY_LABELS, next);
}

function ensurePolling(ctx: vscode.ExtensionContext): void {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
        const hasAny = vscode.window.terminals.some(t => sessionNameOf(t) !== undefined);
        if (!hasAny) {
            clearInterval(pollTimer!);
            pollTimer = undefined;
            return;
        }
        snapshotLabels(ctx);
    }, 2000);
    pollTimer.unref?.();
}

function workspaceTag(ctx: vscode.ExtensionContext): string | undefined {
    const cached = ctx.workspaceState.get<string>(KEY_WORKSPACE_TAG);
    if (cached) return cached;

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
    const tag = `${safe}-${hash}`;
    void updateState(ctx, KEY_WORKSPACE_TAG, tag);
    return tag;
}

function allocateSessionName(ctx: vscode.ExtensionContext): string | undefined {
    const tag = workspaceTag(ctx);
    if (!tag) return undefined;
    const used = new Set(ctx.workspaceState.get<string[]>(KEY_SESSIONS, []));
    let n = ctx.workspaceState.get<number>(KEY_NEXT_INDEX, 1);
    let name = `vscode-${tag}-${n}`;
    while (used.has(name)) {
        n += 1;
        name = `vscode-${tag}-${n}`;
    }
    void updateState(ctx, KEY_NEXT_INDEX, n + 1);
    return name;
}

function rememberSession(ctx: vscode.ExtensionContext, name: string): Promise<void> {
    const sessions = ctx.workspaceState.get<string[]>(KEY_SESSIONS, []);
    if (sessions.includes(name)) return Promise.resolve();
    return updateState(ctx, KEY_SESSIONS, [...sessions, name]);
}

async function forgetSession(ctx: vscode.ExtensionContext, name: string): Promise<void> {
    const sessions = ctx.workspaceState.get<string[]>(KEY_SESSIONS, []);
    if (sessions.includes(name)) {
        await updateState(ctx, KEY_SESSIONS, sessions.filter(s => s !== name));
    }
    await setLabel(ctx, name, undefined);
}

function daemonScriptPath(): string {
    if (!activeCtx) throw new Error('dterm: extension not activated');
    return path.join(activeCtx.extensionPath, 'out', 'daemon.js');
}

async function pushVerboseStdioLog(): Promise<void> {
    const enabled = vscode.workspace.getConfiguration('dterm').get<boolean>('verboseStdioLog', false);
    log(`config: pushing verboseStdioLog=${enabled}`);
    await oneShot(
        daemonScriptPath(),
        { type: 'set_verbose_stdio_log', enabled },
        () => true,
        500,
    );
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
    await pushVerboseStdioLog();
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

function buildOptions(
    sessionName: string,
    cwd?: string,
    label?: string,
): vscode.ExtensionTerminalOptions {
    const cfg = shellConfig();
    const pty = new DtermPseudoterminal({
        sessionName,
        daemonScript: daemonScriptPath(),
        cwd,
        shell: cfg.shell,
        shellArgs: cfg.shellArgs,
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
    ctx: vscode.ExtensionContext,
    opts?: { interactive?: boolean },
): Promise<void> {
    const persisted = ctx.workspaceState.get<string[]>(KEY_SESSIONS, []);
    log(`reconnectAll: persisted=${JSON.stringify(persisted)}`);
    if (persisted.length === 0) return;

    const live = await listLiveSessions();
    log(`reconnectAll: live=${live === undefined ? 'undefined (daemon unreachable)' : JSON.stringify(live)}`);
    if (live === undefined) {
        const msg = `dterm: ${persisted.length} session(s) persisted, but daemon is unreachable. Check "dterm: Show daemon log".`;
        if (opts?.interactive) {
            vscode.window.showErrorMessage(msg);
        } else {
            vscode.window.showWarningMessage(msg);
        }
        return;
    }
    const liveSet = new Set(live);
    const stillThere = persisted.filter(n => liveSet.has(n));
    const dropped = persisted.filter(n => !liveSet.has(n));
    if (dropped.length > 0) {
        log(`reconnectAll: dropping dead sessions ${JSON.stringify(dropped)}`);
    }
    if (stillThere.length !== persisted.length) {
        await updateState(ctx, KEY_SESSIONS, stillThere);
    }

    const alreadyOpen = new Set(
        vscode.window.terminals.map(sessionNameOf).filter((n): n is string => Boolean(n)),
    );
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const labels = getLabels(ctx);
    for (const name of stillThere) {
        if (alreadyOpen.has(name)) {
            log(`reconnectAll: already open: ${name}`);
            continue;
        }
        log(`reconnectAll: creating terminal for ${name}`);
        vscode.window.createTerminal(buildOptions(name, cwd, labels[name]));
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
            provideTerminalProfile() {
                const name = allocateSessionName(ctx);
                const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if (!name) {
                    const fallback = `vscode-noworkspace-${process.pid}-${Date.now()}`;
                    log(`profile: allocating fallback session ${fallback}`);
                    pendingFocus.add(fallback);
                    return new vscode.TerminalProfile(buildOptions(fallback, cwd));
                }
                log(`profile: allocated session ${name}`);
                void rememberSession(ctx, name);
                pendingFocus.add(name);
                return new vscode.TerminalProfile(buildOptions(name, cwd));
            },
        }),
    );

    ctx.subscriptions.push(
        vscode.window.onDidChangeActiveTerminal(() => snapshotLabels(ctx)),
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
            snapshotLabels(ctx);
            ensurePolling(ctx);
        }),
        vscode.window.onDidChangeTerminalState(() => snapshotLabels(ctx)),
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
            if (e.affectsConfiguration('dterm.verboseStdioLog')) {
                await pushVerboseStdioLog();
            }
        }),
    );

    void pushAllDaemonSettings();

    if (vscode.window.terminals.some(t => sessionNameOf(t) !== undefined)) {
        ensurePolling(ctx);
    }

    ctx.subscriptions.push(
        vscode.window.onDidCloseTerminal(async t => {
            const name = sessionNameOf(t);
            if (!name) return;
            const reason = t.exitStatus?.reason;
            log(`close: ${name} reason=${reason} t.name="${t.name}"`);
            if (reason === vscode.TerminalExitReason.User) {
                await daemonKill(name);
                await forgetSession(ctx, name);
                return;
            }
            const pty = ptyOf(t);
            const isOscFired = pty?.lastFiredTitle !== undefined && t.name === pty.lastFiredTitle;
            const isDefault = t.name === defaultLabelFor(name);
            if (!isOscFired && !isDefault) {
                log(`close: persisting label "${t.name}" for ${name}`);
                await setLabel(ctx, name, t.name);
            } else {
                log(`close: clearing label for ${name} (default=${isDefault}, oscFired=${isOscFired}, lastFired="${pty?.lastFiredTitle ?? ''}")`);
                await setLabel(ctx, name, undefined);
            }
        }),
    );

    ctx.subscriptions.push(
        vscode.commands.registerCommand('dterm.reconnect', () =>
            reconnectAll(ctx, { interactive: true }),
        ),
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
            await forgetSession(ctx, name);
            t?.dispose();
            vscode.window.showInformationMessage(
                ok ? `dterm: killed ${name}.` : `dterm: kill request sent for ${name}.`,
            );
        }),
    );

    ctx.subscriptions.push(
        vscode.commands.registerCommand('dterm.forgetSession', async () => {
            const t = vscode.window.activeTerminal;
            const name = t ? sessionNameOf(t) : undefined;
            if (!name) {
                vscode.window.showInformationMessage('dterm: active terminal is not a dterm session.');
                return;
            }
            await forgetSession(ctx, name);
            vscode.window.showInformationMessage(
                `dterm: forgot ${name} (still running; use Kill to terminate).`,
            );
        }),
    );

    logChannel = vscode.window.createOutputChannel('dterm');
    ctx.subscriptions.push(logChannel);
    log(`activate: extensionPath=${ctx.extensionPath}`);
    log(`activate: workspaceTag=${workspaceTag(ctx) ?? '(none)'}`);
    log(`activate: persisted KEY_SESSIONS=${JSON.stringify(ctx.workspaceState.get<string[]>(KEY_SESSIONS, []))}`);

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
            const live = await listLiveSessions();
            const persisted = ctx.workspaceState.get<string[]>(KEY_SESSIONS, []);
            const labels = getLabels(ctx);
            const tag = workspaceTag(ctx) ?? '(none)';
            const openTerms = vscode.window.terminals.map(t => ({
                name: t.name,
                session: sessionNameOf(t),
            }));
            ch.appendLine('--- dterm diagnostics ---');
            ch.appendLine(`workspaceTag: ${tag}`);
            ch.appendLine(`socket: ${sock} exists=${sockExists}`);
            ch.appendLine(`live sessions: ${live === undefined ? '(daemon unreachable)' : JSON.stringify(live)}`);
            ch.appendLine(`persisted sessions: ${JSON.stringify(persisted)}`);
            ch.appendLine(`labels: ${JSON.stringify(labels)}`);
            ch.appendLine(`open terminals: ${JSON.stringify(openTerms)}`);
            ch.appendLine(`daemon log: ${daemonLogPath()}`);
            ch.appendLine('---');
            ch.show(true);
        }),
    );

    ctx.subscriptions.push(
        vscode.commands.registerCommand('dterm.installClaudeWrapper', async () => {
            const wrapperPath = path.join(ctx.extensionPath, 'out', 'dterm-wrapper');
            try {
                fs.chmodSync(wrapperPath, 0o755);
            } catch (e) {
                vscode.window.showErrorMessage(`dterm: cannot chmod wrapper at ${wrapperPath}: ${(e as Error).message}`);
                return;
            }
            const hasWorkspace = (vscode.workspace.workspaceFolders ?? []).length > 0;
            const target = hasWorkspace
                ? vscode.ConfigurationTarget.Workspace
                : vscode.ConfigurationTarget.Global;
            const scopeLabel = hasWorkspace
                ? `this workspace${vscode.env.remoteName ? ` (remote: ${vscode.env.remoteName})` : ''}`
                : 'global user settings';
            const cfg = vscode.workspace.getConfiguration('claudeCode');
            const inspect = cfg.inspect<string>('claudeProcessWrapper');
            const currentInScope = hasWorkspace
                ? inspect?.workspaceValue
                : inspect?.globalValue;
            if (currentInScope === wrapperPath) {
                vscode.window.showInformationMessage(
                    `dterm: already set as claudeProcessWrapper for ${scopeLabel}.`,
                );
                return;
            }
            const action = currentInScope
                ? await vscode.window.showWarningMessage(
                      `dterm: claudeCode.claudeProcessWrapper for ${scopeLabel} is currently "${currentInScope}". Overwrite with "${wrapperPath}"?`,
                      'Overwrite',
                      'Cancel',
                  )
                : 'Overwrite';
            if (action !== 'Overwrite') return;
            await cfg.update('claudeProcessWrapper', wrapperPath, target);
            vscode.window.showInformationMessage(
                `dterm: installed as claudeProcessWrapper for ${scopeLabel}. Reload the Claude Code extension for it to take effect.`,
            );
        }),
    );

    ctx.subscriptions.push(
        vscode.commands.registerCommand('dterm.uninstallClaudeWrapper', async () => {
            const cfg = vscode.workspace.getConfiguration('claudeCode');
            const inspect = cfg.inspect<string>('claudeProcessWrapper');
            const hasWorkspace = (vscode.workspace.workspaceFolders ?? []).length > 0;
            const target = hasWorkspace
                ? vscode.ConfigurationTarget.Workspace
                : vscode.ConfigurationTarget.Global;
            const scopeLabel = hasWorkspace
                ? `this workspace${vscode.env.remoteName ? ` (remote: ${vscode.env.remoteName})` : ''}`
                : 'global user settings';
            const currentInScope = hasWorkspace
                ? inspect?.workspaceValue
                : inspect?.globalValue;
            if (!currentInScope) {
                vscode.window.showInformationMessage(
                    `dterm: claudeProcessWrapper is already unset for ${scopeLabel}.`,
                );
                return;
            }
            await cfg.update('claudeProcessWrapper', undefined, target);
            vscode.window.showInformationMessage(
                `dterm: cleared claudeProcessWrapper for ${scopeLabel} (was "${currentInScope}").`,
            );
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
            const persisted = ctx.workspaceState.get<string[]>(KEY_SESSIONS, []);
            const live = await listLiveSessions();
            if (live === undefined) {
                vscode.window.showErrorMessage('dterm: daemon unreachable.');
                return;
            }
            const liveSet = new Set(live);
            const persistedSet = new Set(persisted);
            const lines: string[] = [];
            for (const n of persisted) lines.push(`${liveSet.has(n) ? '●' : '○'} ${n}`);
            const others = live.filter(n => !persistedSet.has(n));
            if (others.length) {
                if (lines.length) lines.push('—');
                for (const n of others) lines.push(`· ${n}`);
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
    if (activeCtx) {
        snapshotLabels(activeCtx);
    }
    if (pendingWrites.size > 0) {
        await Promise.allSettled([...pendingWrites]);
    }
    activeCtx = undefined;
}
