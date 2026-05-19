#!/usr/bin/env node
// Post-compile: prepare out/stub.js as an executable with shebang, emit
// out/stub-launcher.sh, and materialize the bash/zsh/fish/dterm symlinks
// VS Code dispatches against.
const fs = require('fs');
const path = require('path');

const outDir = path.join(__dirname, '..', 'out');
const stubPath = path.join(outDir, 'stub.js');

const SHEBANG = '#!/usr/bin/env node\n';
const existing = fs.readFileSync(stubPath, 'utf8');
const body = existing.startsWith('#!')
    ? existing.slice(existing.indexOf('\n') + 1)
    : existing;
fs.writeFileSync(stubPath, SHEBANG + body);
fs.chmodSync(stubPath, 0o755);

// stub-launcher.sh runs node-based env capture once, then exec's into sleep so
// the keep-alive process is ~1-2 MB (sleep) instead of ~30-50 MB (node+V8).
// The kernel-level PID survives the exec, so VS Code's pty-host sees a single
// long-lived persistent process and keeps the per-terminal CLIServer bound
// until Terminal.dispose() SIGHUPs us. DTERM_STUB_PATH is set by the
// extension to the absolute path of stub.js. If env capture fails we exit
// with its status so the pty dies (matches pre-launcher behaviour).
//
// `sleep 2147483647` (max int32 seconds, ~68 years) is portable across
// glibc and BSD sleep; `sleep infinity` is a GNU extension and rejected by
// macOS BSD sleep on older releases.
const launcherPath = path.join(outDir, 'stub-launcher.sh');
const LAUNCHER = `#!/bin/sh
# dterm bootstrap stub launcher -- runs env capture, then exec's into sleep
# so the keep-alive cost drops from a full node runtime to a tiny sleep.
# See scripts/postcompile.js for full rationale.
node "$DTERM_STUB_PATH" "$@" || exit $?
exec sleep 2147483647
`;
fs.writeFileSync(launcherPath, LAUNCHER);
fs.chmodSync(launcherPath, 0o755);

const shimsDir = path.join(outDir, 'shims');
fs.mkdirSync(shimsDir, { recursive: true });
// 'bash', 'zsh', 'fish' get VS Code's automatic shell-integration injection
// (VS Code recognizes the basename and adds --init-file / ZDOTDIR /
// --init-command plus VSCODE_INJECTION + VSCODE_SHELL_INTEGRATION_NONCE env).
// The bootstrap stub then forwards that env to the daemon so the daemon-side
// shell loads the integration script. 'dterm' is a generic fallback for
// shells VS Code doesn't recognize -- the unrecognized basename means no
// injection happens; DTERM_REAL_SHELL tells the stub which binary to use.
//
// Symlinks point at stub-launcher.sh (not stub.js directly) so the launcher's
// exec-sleep handoff applies regardless of which shell basename VS Code
// dispatches us on.
for (const name of ['bash', 'zsh', 'fish', 'dterm']) {
    const linkPath = path.join(shimsDir, name);
    try { fs.unlinkSync(linkPath); } catch { /* not present */ }
    fs.symlinkSync(path.join('..', 'stub-launcher.sh'), linkPath);
}
