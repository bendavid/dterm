#!/usr/bin/env node
// dterm bootstrap stub -- env capture only.
//
// Launched by VS Code as a hidden terminal via shellPath = out/shims/<basename>
// (each shim is a symlink to this file). We inherit VS Code's per-terminal env
// injection (--init-file path in argv, VSCODE_INJECTION,
// VSCODE_SHELL_INTEGRATION_NONCE, VSCODE_NONCE, the per-terminal
// VSCODE_IPC_HOOK_CLI, plus every active extension's
// EnvironmentVariableCollection contributions), serialize it as {env, args}
// JSON, send it over the per-session Unix socket at DTERM_BOOTSTRAP_SOCKET,
// and exit. No keep-alive -- dterm routes `code` CLI through the extension-
// host's VSCODE_IPC_HOOK_CLI socket (via the workspace-scoped symlink in
// MANAGED_SOCKETS), so the per-terminal CLIServer that VS Code provisions
// for this stub is unused and we don't need to hold its pty open.

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
// Process exits naturally after the socket 'end' callback drains and the
// connection closes.
