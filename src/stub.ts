#!/usr/bin/env node
// dterm bootstrap stub -- env capture only.
//
// Invoked by out/stub-launcher.sh, which is in turn launched by VS Code as a
// hidden terminal via shellPath = out/shims/<basename>. We inherit VS Code's
// per-terminal env injection (--init-file path in argv, VSCODE_INJECTION,
// VSCODE_SHELL_INTEGRATION_NONCE, VSCODE_NONCE, the per-terminal
// VSCODE_IPC_HOOK_CLI, plus every active extension's
// EnvironmentVariableCollection contributions), serialize it as {env, args}
// JSON, send it over the per-session Unix socket at DTERM_BOOTSTRAP_SOCKET,
// and exit.
//
// The pty stays bound after we exit because the launcher's next line is
// `exec sleep <large>`. sleep replaces the launcher in-place, the kernel-
// level PID does not change, so VS Code's pty-host continues to see the
// same persistent process and the per-terminal CLIServer for
// VSCODE_IPC_HOOK_CLI remains bound until Terminal.dispose() SIGHUPs us.
// Keep-alive cost drops from ~30-50 MB (node + V8 runtime) to ~1-2 MB
// (sleep) once we exit here.

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
// Process exits naturally after the socket 'end' callback drains. The
// launcher then execs into sleep to keep the pty bound for the session's
// lifetime.
