#!/usr/bin/env node
// dterm bootstrap stub.
//
// Launched as a hidden terminal by the main extension via VS Code's shellPath.
// Its only job is to capture VS Code's automatic shell-integration env
// injection (--init-file, VSCODE_INJECTION, VSCODE_SHELL_INTEGRATION_NONCE,
// etc.) plus our argv, and ship them back to the extension via a per-session
// Unix socket the extension creates before spawning us.
//
// The socket path is passed in via DTERM_BOOTSTRAP_SOCKET. We write a single
// JSON payload {env, args} and exit. The extension uses what we captured to
// drive the daemon's shell spawn directly from the visible Pseudoterminal,
// so the stub never touches the daemon or bridges stdio.

import * as net from 'net';

const sockPath = process.env.DTERM_BOOTSTRAP_SOCKET;
if (!sockPath) {
    process.stderr.write('dterm-stub: DTERM_BOOTSTRAP_SOCKET not set\n');
    process.exit(2);
}

const payload = JSON.stringify({ env: process.env, args: process.argv });

const sock = net.createConnection(sockPath);
sock.on('connect', () => {
    sock.write(payload, () => sock.end());
});
sock.on('error', e => {
    process.stderr.write(`dterm-stub: socket error: ${e.message}\n`);
    process.exit(3);
});
sock.on('close', () => process.exit(0));
