#!/usr/bin/env node
// dterm bootstrap stub.
//
// Spawned by the extension as a hidden real terminal (hideFromUser: true) for
// the sole purpose of capturing VS Code's automatic shell-integration env
// injection (--init-file path, VSCODE_INJECTION, VSCODE_SHELL_INTEGRATION_*,
// etc.) and handing it to the dterm daemon, which spawns the actual shell.
// The stub does NOT bridge stdio for the user-facing terminal -- a
// Pseudoterminal in the extension owns that, connecting to the daemon
// directly.
//
// Lifecycle:
//   1. Connect to daemon socket (double-fork-spawn the daemon if absent).
//   2. Send `open` with env, shell, args.
//   3. Wait for `opened` ack from daemon.
//   4. Exit cleanly. The hidden VS Code terminal closes, extension's
//      onDidCloseTerminal listener observes our exit code and proceeds with
//      the Pseudoterminal connection.

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

    const sock = await connectWithRetry();
    const stream = new LineStream<DaemonMessage>();

    let settled = false;
    const finish = (code: number): never => {
        if (!settled) {
            settled = true;
            try { sock.end(); } catch { /* already gone */ }
        }
        process.exit(code);
    };

    sock.on('data', (chunk: Buffer) => {
        for (const m of stream.feed(chunk)) {
            if (m.type === 'opened') {
                finish(0);
            } else if (m.type === 'error') {
                process.stderr.write(`dterm-stub: ${m.message}\n`);
                finish(1);
            }
            // Other message types are not interesting to the bootstrap stub.
        }
    });
    sock.on('close', () => finish(settled ? 0 : 1));
    sock.on('error', e => {
        process.stderr.write(`dterm-stub: socket: ${e.message}\n`);
        finish(1);
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

    // Safety: bound the wait. If the daemon never acks, drop the hidden
    // terminal so the extension's onDidCloseTerminal hook fires with a
    // non-zero exit code.
    setTimeout(() => {
        if (!settled) {
            process.stderr.write('dterm-stub: daemon opened-ack timeout\n');
            finish(1);
        }
    }, 5000);
}

main().catch(e => {
    process.stderr.write(`dterm-stub: ${(e as Error).message}\n`);
    process.exit(1);
});
