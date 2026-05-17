#!/usr/bin/env node
// dterm stub -- bridges a VS Code-launched real terminal to the dterm daemon.
//
// VS Code launches this binary via the `shellPath` of a terminal profile or
// configured profile. The basename of shellPath (one of bash/zsh/fish via
// `out/shims/<name>` symlinks; `dterm` as the generic fallback) drives VS
// Code's automatic shell-integration injection -- `--init-file` for bash,
// `ZDOTDIR` for zsh, etc. The stub forwards the resulting env + args to the
// daemon, which spawns the real shell, so all of VS Code's shell-integration
// flows through the daemon's pty without dterm reimplementing it.
//
//   - Connects to the dterm daemon (spawning it via double-fork if absent).
//   - Opens or attaches a session named via DTERM_SESSION env.
//   - Forwards stdin -> daemon, daemon output -> stdout.
//   - Tracks resize events and forwards them.
//   - Tracks the daemon's foreground-process notifications and writes them
//     into process.title (with a U+200B marker) so VS Code's /proc/<pid>/comm
//     polling drives the tab title.
//   - Exits when the session ends or the socket disconnects.

import * as cp from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { encode, LineStream, type DaemonMessage } from './protocol';

function userTag(): string {
    const info = os.userInfo();
    if (typeof info.uid === 'number' && info.uid >= 0) return String(info.uid);
    return info.username || 'user';
}

function socketPath(): string {
    const runtime = process.env.XDG_RUNTIME_DIR;
    if (runtime) return path.join(runtime, 'dterm', 'daemon.sock');
    return path.join(os.tmpdir(), `dterm-${userTag()}`, 'daemon.sock');
}

function daemonScriptPath(): string {
    // process.argv[1] is the symlinked path VS Code launched, e.g.
    // /path/to/extension/out/shims/bash. The real daemon lives one level up.
    const invokedAs = process.argv[1];
    if (!invokedAs) throw new Error('dterm-stub: process.argv[1] missing');
    return path.join(path.dirname(path.dirname(invokedAs)), 'daemon.js');
}

function shellBasename(): string {
    return path.basename(process.argv[1] || 'bash');
}

const FG_NAME_MARKER = '​';
const FG_NAME_MAX_BYTES = 15 - Buffer.byteLength(FG_NAME_MARKER);  // TASK_COMM_LEN - null - marker

function setForegroundName(name: string): void {
    // Append U+200B so the extension can distinguish this daemon-driven name
    // (ephemeral, follows the foreground process) from a user-typed rename
    // (which lands in t.name without our marker, plus VS Code marks the
    // titleSource as Api). Trim by byte length so the kernel's TASK_COMM_LEN
    // truncation can't clip the marker off a multi-byte name.
    let safe = name.replace(/[\x00-\x1f\x7f]/g, '');
    while (Buffer.byteLength(safe) > FG_NAME_MAX_BYTES) {
        safe = safe.slice(0, -1);
    }
    if (safe.length === 0) return;
    process.title = `${safe}${FG_NAME_MARKER}`;
}

function resolveShellBinary(name: string): string {
    // The stub was invoked via a symlink whose basename mimics the shell.
    // The real binary needs to be on PATH. Prefer explicit override.
    const override = process.env.DTERM_REAL_SHELL;
    if (override && override.length > 0) return override;
    for (const dir of (process.env.PATH || '').split(':')) {
        if (!dir) continue;
        const candidate = path.join(dir, name);
        try {
            if (fs.statSync(candidate).isFile()) return candidate;
        } catch { /* try next */ }
    }
    return `/bin/${name}`;
}

function spawnDaemonDetached(): void {
    // Double-fork: spawn an intermediate node that spawns the daemon and exits.
    // Same approach as the extension-side client uses.
    const logPath = path.join(os.tmpdir(), `dterm-${userTag()}.log`);
    const daemon = daemonScriptPath();
    const exe = process.execPath;
    const intermediate =
        'const cp=require("child_process");const fs=require("fs");' +
        `const logFd=fs.openSync(${JSON.stringify(logPath)},"a");` +
        'try{fs.writeSync(logFd,"\\n=== "+new Date().toISOString()+" stub spawn ===\\n")}catch{}' +
        'const env={...process.env};' +
        `const child=cp.spawn(${JSON.stringify(exe)},[${JSON.stringify(daemon)}],` +
        '{detached:true,stdio:["ignore",logFd,logFd],env});' +
        'child.unref();' +
        'process.exit(0);';
    const proc = cp.spawn(exe, ['-e', intermediate], {
        detached: true,
        stdio: 'ignore',
    });
    proc.unref();
}

function connectOnce(): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
        const s = net.createConnection(socketPath());
        s.once('connect', () => resolve(s));
        s.once('error', reject);
    });
}

async function connectWithRetry(maxAttempts = 30): Promise<net.Socket> {
    for (let i = 0; i < maxAttempts; i++) {
        try {
            return await connectOnce();
        } catch {
            if (i === 0) spawnDaemonDetached();
            await new Promise(r => setTimeout(r, 100));
        }
    }
    throw new Error('dterm-stub: daemon unreachable after retries');
}

function stripStubInternals(env: NodeJS.ProcessEnv): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
        if (typeof v !== 'string') continue;
        if (k === 'DTERM_SESSION' || k === 'DTERM_REAL_SHELL') continue;
        out[k] = v;
    }
    return out;
}

async function main(): Promise<void> {
    const sessionName = process.env.DTERM_SESSION;
    if (!sessionName) {
        process.stderr.write('dterm-stub: DTERM_SESSION not set\n');
        process.exit(2);
    }

    // Pre-set process.title to the shell basename ASAP so VS Code's /proc/comm
    // poll catches a marker-tagged name as soon as possible. Without this the
    // first poll typically lands on "env" (from the shebang resolver) or
    // "node" (the interpreter), which the extension blacklists from being
    // persisted as a user label but is briefly visible in the tab.
    setForegroundName(shellBasename());

    // Inject HasRichCommandDetection -- the bash/zsh shell-integration scripts
    // emit this once at script-load time, so on reattach (where the script
    // has long since loaded) the new TerminalInstance would otherwise stay at
    // "basic" shell integration. Emit it directly so the visible terminal
    // tooltip reads "rich" immediately. Harmless for shells without
    // integration: VS Code only surfaces "rich" once a CommandDetection-bearing
    // OSC 633 ; A actually arrives too.
    process.stdout.write('\x1b]633;P;HasRichCommandDetection=True\x07');

    const sock = await connectWithRetry();
    const stream = new LineStream<DaemonMessage>();

    let exitCode = 0;
    let exited = false;
    const exit = (code: number): never => {
        if (!exited) {
            exited = true;
            exitCode = code;
        }
        process.exit(exitCode);
    };

    sock.on('data', (chunk: Buffer) => {
        for (const m of stream.feed(chunk)) {
            switch (m.type) {
                case 'output': {
                    // Daemon ships pty output as base64 (binary-safe).
                    process.stdout.write(Buffer.from(m.data, 'base64'));
                    break;
                }
                case 'process_name':
                    // Propagate the daemon's foreground-process tracking into
                    // our own process.title so VS Code's /proc/<pid>/comm
                    // poll picks it up and updates the tab title.
                    setForegroundName(m.name);
                    break;
                case 'session_end':
                    exit(m.exitCode ?? 0);
                    break;
                case 'error':
                    process.stderr.write(`dterm-stub: ${m.message}\n`);
                    break;
                // 'opened' is informational, ignored.
            }
        }
    });
    sock.on('close', () => exit(exitCode));
    sock.on('error', e => {
        process.stderr.write(`dterm-stub: socket: ${e.message}\n`);
        exit(1);
    });

    // Stdio passthrough. xterm.js handles line discipline on the VS Code side
    // and the real shell's pty handles it on the daemon side; the outer pty
    // VS Code gave us should be transparent. setRawMode kills echo/canonical
    // mode in case the runtime defaults bit us.
    process.stdin.setRawMode?.(true);
    process.stdin.on('data', (chunk: Buffer) => {
        sock.write(encode({ type: 'input', data: chunk.toString('base64') }));
    });
    process.stdin.on('end', () => exit(exitCode));

    process.stdout.on('resize', () => {
        const cols = process.stdout.columns || 80;
        const rows = process.stdout.rows || 24;
        sock.write(encode({ type: 'resize', cols, rows }));
    });

    const shellName = shellBasename();
    const shellBinary = resolveShellBinary(shellName);

    sock.write(encode({
        type: 'open',
        name: sessionName,
        cols: process.stdout.columns || 80,
        rows: process.stdout.rows || 24,
        cwd: process.cwd(),
        env: stripStubInternals(process.env),
        shell: shellBinary,
        shellArgs: process.argv.slice(2),
    }));
}

main().catch(e => {
    process.stderr.write(`dterm-stub: ${(e as Error).message}\n`);
    process.exit(1);
});
