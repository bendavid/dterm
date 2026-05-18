#!/usr/bin/env node
// dterm bootstrap stub.
//
// Launched as a hidden terminal by the main extension via VS Code's shellPath.
// Captures VS Code's automatic shell-integration env injection (--init-file,
// VSCODE_INJECTION, VSCODE_SHELL_INTEGRATION_NONCE, etc.) plus our argv, and
// ships them back to the extension via a per-session Unix socket the extension
// creates before spawning us.
//
// After writing the payload, the stub STAYS ALIVE -- it does not exit. This
// keeps VS Code's per-terminal IPC socket (path captured in our env above,
// pointed at by VSCODE_IPC_HOOK_CLI) bound, so the daemon-side shell can use
// the `code` CLI through that socket for the lifetime of the dterm session.
// The extension calls Terminal.dispose() on us when the corresponding
// Pseudoterminal closes; that's what eventually kills us.
//
// The socket path is passed in via DTERM_BOOTSTRAP_SOCKET. We write a single
// JSON payload {env, args} and then sit idle indefinitely.

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
// Don't exit on socket 'close' -- the extension has the payload now, but VS
// Code's IPC socket needs us alive to stay bound.

// Keep the event loop alive indefinitely. Terminal.dispose() from the
// extension will SIGHUP us and the process will exit normally.
setInterval(() => { /* heartbeat */ }, 60_000);
