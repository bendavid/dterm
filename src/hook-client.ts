#!/usr/bin/env node
import * as net from 'net';
import { socketPath } from './paths';

const event = process.argv[2];
const sessionName = process.argv[3];

function bye(): never {
    process.exit(0);
}

if (!event || !sessionName) bye();

let stdinBuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d: string) => { stdinBuf += d; });
process.stdin.on('end', () => {
    let payload: unknown = null;
    if (stdinBuf.length > 0) {
        try { payload = JSON.parse(stdinBuf); } catch { /* non-JSON stdin — ignore */ }
    }

    const sock = net.createConnection(socketPath());
    const finish = (): void => {
        try { sock.destroy(); } catch { /* ignore */ }
        bye();
    };
    sock.once('connect', () => {
        try {
            sock.write(JSON.stringify({ type: 'hook_event', event, sessionName, payload }) + '\n');
        } catch { /* ignore */ }
        sock.end();
    });
    sock.once('error', finish);
    sock.once('close', finish);
});

setTimeout(bye, 2000);
