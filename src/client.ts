import * as net from 'net';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { LineStream, encode } from './protocol';
import type { ClientMessage, DaemonMessage } from './protocol';
import { socketPath, daemonLogPath } from './paths';

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

async function spawnDaemon(daemonScript: string): Promise<void> {
    if (spawnPromise) return spawnPromise;
    spawnPromise = (async () => {
        const sockPath = socketPath();
        if (await probeSocket(sockPath)) return;
        const logPath = daemonLogPath();
        try {
            fs.mkdirSync(path.dirname(logPath), { recursive: true });
        } catch { /* ignore */ }
        // Double-fork: spawn an intermediate node that spawns the daemon and exits.
        // After the intermediate exits, the daemon is reparented to init and is no
        // longer a descendant of the calling Electron process, so Electron's tree
        // walk on quit can't reach it.
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
        try {
            const intermediate = cp.spawn(process.execPath, ['-e', intermediateCode], {
                detached: true,
                stdio: 'ignore',
                env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
            });
            intermediate.unref();
        } catch (e) {
            throw new Error(`spawn intermediate failed: ${(e as Error).message}`);
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
