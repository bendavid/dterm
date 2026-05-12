#!/usr/bin/env node
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import { socketPath, daemonLogPath } from './paths';
import { encode, LineStream } from './protocol';
import type { ClientMessage, DaemonMessage } from './protocol';

const all = process.argv.slice(2);
if (all.length < 1) {
    process.stderr.write('dterm-wrapper: missing executable argument\n');
    process.exit(64);
}
const executable = all[0];
const procArgs = all.slice(1);

function findSessionId(args: string[]): string | undefined {
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if ((a === '--resume' || a === '--session-id') && i + 1 < args.length) return args[i + 1];
        const m = a.match(/^--(?:resume|session-id)=(.+)$/);
        if (m) return m[1];
    }
    return undefined;
}

const HOOK_EVENTS = ['SessionStart', 'Stop', 'SessionEnd'] as const;

function isObj(x: unknown): x is Record<string, unknown> {
    return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function buildHookSettings(name: string): Record<string, unknown> {
    const hookScript = path.join(__dirname, 'hook-client.js');
    const command = (event: string): string =>
        `${JSON.stringify(process.execPath)} ${JSON.stringify(hookScript)} ${JSON.stringify(event)} ${JSON.stringify(name)}`;
    const hooks: Record<string, unknown> = {};
    for (const ev of HOOK_EVENTS) {
        hooks[ev] = [{ hooks: [{ type: 'command', command: command(ev) }] }];
    }
    return { hooks };
}

function readExistingSettings(value: string): Record<string, unknown> | undefined {
    const trimmed = value.trim();
    try {
        if (trimmed.startsWith('{')) return JSON.parse(trimmed);
        return JSON.parse(fs.readFileSync(trimmed, 'utf8'));
    } catch {
        return undefined;
    }
}

function mergeSettings(base: Record<string, unknown>, addon: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...base };
    for (const key of Object.keys(addon)) {
        const a = out[key];
        const b = addon[key];
        if (key === 'hooks' && isObj(a) && isObj(b)) {
            const merged: Record<string, unknown> = { ...a };
            for (const ev of Object.keys(b)) {
                const av = merged[ev];
                const bv = b[ev];
                if (Array.isArray(av) && Array.isArray(bv)) merged[ev] = [...av, ...bv];
                else if (bv !== undefined) merged[ev] = bv;
            }
            out.hooks = merged;
        } else {
            out[key] = b;
        }
    }
    return out;
}

function injectHookSettings(args: string[], name: string): string[] {
    const ours = buildHookSettings(name);
    let existingIdx = -1;
    let existingValue: string | undefined;
    let existingWasEq = false;
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--settings' && i + 1 < args.length) {
            existingIdx = i;
            existingValue = args[i + 1];
            break;
        }
        const m = a.match(/^--settings=(.+)$/);
        if (m) {
            existingIdx = i;
            existingValue = m[1];
            existingWasEq = true;
            break;
        }
    }
    let merged: Record<string, unknown> = ours;
    if (existingValue !== undefined) {
        const base = readExistingSettings(existingValue);
        if (base) merged = mergeSettings(base, ours);
    }
    const inline = JSON.stringify(merged);
    const out = args.slice();
    if (existingIdx < 0) return ['--settings', inline, ...out];
    if (existingWasEq) out[existingIdx] = `--settings=${inline}`;
    else out[existingIdx + 1] = inline;
    return out;
}

const sid = findSessionId(procArgs);
const sessionName = sid ? `claude-${sid}` : `claude-anon-${process.pid}-${Date.now()}`;
const procArgsWithHooks = injectHookSettings(procArgs, sessionName);

async function probeSock(): Promise<boolean> {
    return new Promise(resolve => {
        const s = net.createConnection(socketPath());
        s.once('connect', () => { s.destroy(); resolve(true); });
        s.once('error', () => resolve(false));
    });
}

async function ensureDaemon(): Promise<void> {
    if (await probeSock()) return;
    const daemonScript = path.join(__dirname, 'daemon.js');
    const logPath = daemonLogPath();
    try { fs.mkdirSync(path.dirname(logPath), { recursive: true }); } catch { /* ignore */ }
    let logFd: number;
    try {
        logFd = fs.openSync(logPath, 'a');
        fs.writeSync(logFd, `\n=== ${new Date().toISOString()} dterm-wrapper spawning daemon ${daemonScript} ===\n`);
    } catch (e) {
        throw new Error(`cannot open daemon log ${logPath}: ${(e as Error).message}`);
    }
    try {
        const child = cp.spawn(process.execPath, [daemonScript], {
            detached: true,
            stdio: ['ignore', logFd, logFd],
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        });
        child.unref();
    } finally {
        try { fs.closeSync(logFd); } catch { /* ignore */ }
    }
    for (let i = 0; i < 100; i++) {
        await new Promise(r => setTimeout(r, 50));
        if (await probeSock()) return;
    }
    throw new Error(`daemon failed to start at ${socketPath()}`);
}

(async () => {
    try {
        await ensureDaemon();
    } catch (e) {
        process.stderr.write(`dterm-wrapper: ${(e as Error).message}\n`);
        process.exit(127);
    }

    const sock = net.createConnection(socketPath());
    const parser = new LineStream<DaemonMessage>();
    let opened = false;
    const pendingInput: Buffer[] = [];
    let exiting = false;

    function bye(code: number): void {
        if (exiting) return;
        exiting = true;
        try { sock.end(); } catch { /* ignore */ }
        process.exit(code);
    }

    sock.on('connect', () => {
        const msg: ClientMessage = {
            type: 'open_process',
            name: sessionName,
            executable,
            args: procArgsWithHooks,
            cwd: process.cwd(),
        };
        sock.write(encode(msg));
    });

    sock.on('data', chunk => {
        for (const m of parser.feed(chunk)) {
            switch (m.type) {
                case 'process_opened': {
                    opened = true;
                    for (const b of pendingInput) {
                        sock.write(encode({ type: 'process_input', data: b.toString('base64') }));
                    }
                    pendingInput.length = 0;
                    break;
                }
                case 'process_output': {
                    const buf = Buffer.from(m.data, 'base64');
                    if (m.stream === 'stderr') process.stderr.write(buf);
                    else process.stdout.write(buf);
                    break;
                }
                case 'session_end': {
                    bye(m.exitCode ?? 0);
                    return;
                }
                case 'error': {
                    process.stderr.write(`dterm-wrapper: ${m.message}\n`);
                    break;
                }
            }
        }
    });

    sock.on('error', (e: NodeJS.ErrnoException) => {
        process.stderr.write(`dterm-wrapper: socket error: ${e.message}\n`);
        bye(1);
    });

    sock.on('close', () => {
        bye(0);
    });

    process.stdin.on('data', chunk => {
        if (!opened) {
            pendingInput.push(chunk);
            return;
        }
        sock.write(encode({ type: 'process_input', data: chunk.toString('base64') }));
    });

    // Extension closing stdin = wrapper is being disposed (window reload, etc.).
    // Detach from the daemon but do NOT close the underlying claude's stdin —
    // the daemon keeps the process alive for reattach on the next activation.
    process.stdin.on('end', () => bye(0));

    process.on('SIGINT', () => bye(130));
    process.on('SIGTERM', () => bye(143));
})();
