import * as net from 'net';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { LineStream, encode } from './protocol';
import type { ClientMessage, DaemonMessage } from './protocol';
import { socketPath, daemonLogPath, instanceId } from './paths';

export function readDaemonLogTail(maxBytes = 4096): string {
    const p = daemonLogPath();
    try {
        const stat = fs.statSync(p);
        const start = Math.max(0, stat.size - maxBytes);
        const fd = fs.openSync(p, 'r');
        try {
            const buf = Buffer.alloc(stat.size - start);
            fs.readSync(fd, buf, 0, buf.length, start);
            return buf.toString('utf8');
        } finally {
            fs.closeSync(fd);
        }
    } catch {
        return '';
    }
}

async function probeSocket(sockPath: string): Promise<boolean> {
    return new Promise(resolve => {
        const s = net.createConnection(sockPath);
        const done = (r: boolean) => { try { s.destroy(); } catch {} resolve(r); };
        s.once('connect', () => done(true));
        s.once('error', () => done(false));
    });
}

export async function isDaemonAlive(): Promise<boolean> {
    return probeSocket(socketPath());
}

let spawnPromise: Promise<void> | undefined;

// Cheap probe: $XDG_RUNTIME_DIR/systemd/private socket existence. Filters
// out non-Linux, non-systemd, and "no user manager running" cases without
// spawning anything.
function userSystemdSocketPresent(): boolean {
    if (process.platform !== 'linux') return false;
    const runtime = process.env.XDG_RUNTIME_DIR;
    if (!runtime) return false;
    try {
        return fs.statSync(path.join(runtime, 'systemd', 'private')).isSocket();
    } catch { return false; }
}

// Strong probe: `systemctl --user is-system-running` reports a state where
// the user manager will accept new units (running / degraded / starting).
// "offline" / "stopping" / non-zero unexpected output / missing binary all
// disqualify.
function userSystemdAcceptsUnits(): boolean {
    if (!userSystemdSocketPresent()) return false;
    try {
        const r = cp.spawnSync('systemctl', ['--user', 'is-system-running'], {
            encoding: 'utf8',
            timeout: 2000,
        });
        const state = (r.stdout || '').trim();
        return state === 'running' || state === 'degraded' || state === 'starting';
    } catch { return false; }
}

// Linger marker file -- system-wide truth source for whether user-systemd
// keeps running past the user's last session. `loginctl enable-linger`
// creates this file; `disable-linger` removes it. Checking the file
// directly avoids a DBus round-trip.
export function userSystemdLingering(): boolean {
    if (process.platform !== 'linux') return false;
    const uname = process.env.USER || process.env.LOGNAME;
    if (!uname) return false;
    try {
        return fs.statSync(path.join('/var/lib/systemd/linger', uname)).isFile();
    } catch { return false; }
}

// Query logind for the manager-level KillUserProcesses property. This is
// the runtime value (config + drop-ins applied), not the on-disk default,
// so it correctly reflects systems that override the upstream default
// either direction. Returns true/false, or undefined if we couldn't get a
// definite answer (no busctl, no logind, parse failure).
export function killUserProcessesEnabled(): boolean | undefined {
    if (process.platform !== 'linux') return undefined;
    try {
        const r = cp.spawnSync('busctl', [
            '--no-pager',
            'get-property',
            'org.freedesktop.login1',
            '/org/freedesktop/login1',
            'org.freedesktop.login1.Manager',
            'KillUserProcesses',
        ], { encoding: 'utf8', timeout: 2000 });
        if (r.status !== 0) return undefined;
        const out = (r.stdout || '').trim();
        if (out === 'b true') return true;
        if (out === 'b false') return false;
        return undefined;
    } catch { return undefined; }
}

// Aggregate: would systemd-run --user produce a usable daemon at all?
// Doesn't check linger -- that's a separate dimension handled at spawn
// time with a user prompt.
export function userSystemdAvailable(): boolean {
    return userSystemdAcceptsUnits();
}

// Hook the extension registers at activate to handle the "user-systemd is
// available but linger isn't set" case. Called once per session when the
// first systemd-run spawn would otherwise proceed without lingering;
// should prompt the user, optionally run `loginctl enable-linger`, and
// resolve to true if lingering is (now) enabled, false otherwise.
let lingerPromptHook: (() => Promise<boolean>) | undefined;
let lingerDecisionCache: boolean | undefined;

export function setSystemdRunLingerPrompt(cb: (() => Promise<boolean>) | undefined): void {
    lingerPromptHook = cb;
    lingerDecisionCache = undefined;
}

// systemd-run path: launch the daemon as a transient `--user` service so it
// reparents to user-systemd (not init) and survives logind's
// KillUserProcesses=yes. The unit name is stable per (user, instance) --
// the daemon is a singleton, --collect auto-removes the unit when it
// exits (failed or not), and we probe the socket before spawning, so a
// fixed name is sufficient and gives easy journalctl/systemctl access.
// StandardError=append routes the daemon's own console.error log lines
// into the same file the double-fork path uses, so `dterm: Show daemon
// log` keeps working uniformly.
function spawnViaSystemdRun(daemonScript: string, logPath: string): void {
    const inst = instanceId();
    const instSfx = inst ? `-${inst}` : '';
    const unitName = `dterm-daemon${instSfx}`;
    const args = [
        '--user',
        '--collect',
        `--unit=${unitName}`,
        '--description=dterm persistent terminal daemon',
        '--setenv=ELECTRON_RUN_AS_NODE=1',
        `--property=StandardOutput=append:${logPath}`,
        `--property=StandardError=append:${logPath}`,
    ];
    if (inst) args.push(`--setenv=DTERM_INSTANCE=${inst}`);
    // Preserve XDG_RUNTIME_DIR so the daemon resolves the same socket
    // path we just probed. user-systemd inherits these in most setups,
    // but pass it explicitly to be safe (the dbus/runtime-dir vars are
    // also what paths.ts depends on).
    if (process.env.XDG_RUNTIME_DIR) {
        args.push(`--setenv=XDG_RUNTIME_DIR=${process.env.XDG_RUNTIME_DIR}`);
    }
    args.push(process.execPath, daemonScript);
    try {
        fs.appendFileSync(logPath,
            `\n=== ${new Date().toISOString()} systemd-run spawn (unit=${unitName}) ===\n`);
    } catch { /* best-effort */ }
    const r = cp.spawnSync('systemd-run', args, { stdio: 'pipe', encoding: 'utf8' });
    if (r.status !== 0) {
        const err = (r.stderr || '').trim();
        throw new Error(`systemd-run failed (status=${r.status}): ${err || '(no stderr)'}`);
    }
}

// Legacy double-fork: spawn an intermediate node that spawns the daemon and
// exits. After the intermediate exits, the daemon is reparented to init and
// is no longer a descendant of the calling Electron process, so Electron's
// tree walk on quit can't reach it.
function spawnViaDoubleFork(daemonScript: string, logPath: string): void {
    const intermediateCode =
        'const cp=require("child_process");const fs=require("fs");' +
        `try{fs.mkdirSync(${JSON.stringify(path.dirname(logPath))},{recursive:true})}catch{}` +
        'let logFd="ignore";' +
        `try{logFd=fs.openSync(${JSON.stringify(logPath)},"a");` +
        'fs.writeSync(logFd,"\\n=== "+new Date().toISOString()+" double-fork spawn ===\\n")}catch{}' +
        `const env=Object.assign({},process.env,{ELECTRON_RUN_AS_NODE:"1"});` +
        `const child=cp.spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(daemonScript)}],` +
        `{detached:true,stdio:["ignore",logFd,logFd],env});` +
        'child.unref();' +
        'if(typeof logFd==="number")try{fs.closeSync(logFd)}catch{};' +
        'process.exit(0);';
    const intermediate = cp.spawn(process.execPath, ['-e', intermediateCode], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    intermediate.unref();
}

async function spawnDaemon(daemonScript: string): Promise<void> {
    if (spawnPromise) return spawnPromise;
    spawnPromise = (async () => {
        const sockPath = socketPath();
        if (await probeSocket(sockPath)) return;
        const logPath = daemonLogPath();
        try {
            fs.mkdirSync(path.dirname(logPath), { recursive: true });
        } catch { /* ignore */ }

        // Choose spawn strategy.
        //   DTERM_USE_SYSTEMD_RUN != '1' (or user-systemd unavailable): straight
        //   to double-fork.
        //   Otherwise: confirm lingering is enabled (prompt the user if not)
        //   before invoking systemd-run; if either the prompt declines or the
        //   systemd-run invocation itself errors, fall back to double-fork.
        const wantSystemd = process.env.DTERM_USE_SYSTEMD_RUN === '1'
            && userSystemdAvailable();
        let useSystemd = false;
        if (wantSystemd) {
            if (userSystemdLingering()) {
                useSystemd = true;
            } else if (lingerDecisionCache !== undefined) {
                useSystemd = lingerDecisionCache;
            } else if (lingerPromptHook) {
                useSystemd = await lingerPromptHook();
                lingerDecisionCache = useSystemd;
            }
            // No hook registered -> conservative: don't surprise the user
            // by running an unprotected systemd-run unit, fall through to
            // double-fork.
        }
        if (useSystemd) {
            try {
                spawnViaSystemdRun(daemonScript, logPath);
            } catch (e) {
                const systemdError = (e as Error).message;
                try {
                    fs.appendFileSync(logPath,
                        `\n=== ${new Date().toISOString()} systemd-run failed: ${systemdError} — falling back to double-fork ===\n`);
                } catch { /* best-effort */ }
                spawnViaDoubleFork(daemonScript, logPath);
            }
        } else {
            spawnViaDoubleFork(daemonScript, logPath);
        }

        for (let i = 0; i < 100; i++) {
            await new Promise(r => setTimeout(r, 50));
            if (await probeSocket(sockPath)) return;
        }
        const tail = readDaemonLogTail();
        const trimmed = tail.trim();
        throw new Error(
            `daemon failed to start at ${sockPath}.\nLog (${logPath}):\n${trimmed || '(empty)'}`,
        );
    })().finally(() => { spawnPromise = undefined; });
    return spawnPromise;
}

export class DaemonConnection extends EventEmitter {
    private socket: net.Socket | undefined;
    private parser = new LineStream<DaemonMessage>();
    private connected = false;
    private closed = false;

    async connect(daemonScript: string): Promise<void> {
        if (this.connected) return;
        const sockPath = socketPath();
        if (!(await probeSocket(sockPath))) {
            await spawnDaemon(daemonScript);
        }
        await new Promise<void>((resolve, reject) => {
            const s = net.createConnection(sockPath);
            s.once('connect', () => {
                this.socket = s;
                this.connected = true;
                s.on('data', chunk => {
                    for (const msg of this.parser.feed(chunk)) {
                        this.emit('message', msg);
                    }
                });
                s.on('close', () => {
                    this.connected = false;
                    if (!this.closed) this.emit('close');
                });
                s.on('error', () => { /* surfaced via close */ });
                resolve();
            });
            s.once('error', err => reject(err));
        });
    }

    send(msg: ClientMessage): void {
        if (!this.socket || !this.connected) return;
        this.socket.write(encode(msg));
    }

    close(): void {
        this.closed = true;
        if (this.socket) {
            try { this.socket.destroy(); } catch { /* ignore */ }
            this.socket = undefined;
        }
        this.connected = false;
    }

    isConnected(): boolean {
        return this.connected;
    }
}

// Ensure the daemon is running. Probes the socket and double-fork-spawns the
// daemon if it isn't reachable. Resolves once the socket becomes connectable
// (or rejects on timeout). Used by callers that need to connect a long-lived
// socket directly (the Pseudoterminal-backed terminals) without going through
// the request-response `oneShot` path.
export async function ensureDaemon(daemonScript: string): Promise<void> {
    const sockPath = socketPath();
    if (await probeSocket(sockPath)) return;
    await spawnDaemon(daemonScript);
}

export async function oneShot(
    daemonScript: string,
    send: ClientMessage,
    waitFor: (msg: DaemonMessage) => boolean,
    timeoutMs = 3000,
): Promise<DaemonMessage | undefined> {
    const conn = new DaemonConnection();
    try {
        await conn.connect(daemonScript);
    } catch {
        return undefined;
    }
    return new Promise<DaemonMessage | undefined>(resolve => {
        const timer = setTimeout(() => {
            conn.close();
            resolve(undefined);
        }, timeoutMs);
        conn.on('message', (msg: DaemonMessage) => {
            if (waitFor(msg)) {
                clearTimeout(timer);
                conn.close();
                resolve(msg);
            }
        });
        conn.on('close', () => {
            clearTimeout(timer);
            resolve(undefined);
        });
        conn.send(send);
    });
}
