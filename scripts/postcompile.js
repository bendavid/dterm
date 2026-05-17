#!/usr/bin/env node
// Post-compile: prepare out/stub.js as an executable with shebang, and
// materialize the bash/zsh/fish symlinks VS Code dispatches against.
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

const shimsDir = path.join(outDir, 'shims');
fs.mkdirSync(shimsDir, { recursive: true });
// 'bash', 'zsh', 'fish' get VS Code's automatic shell-integration injection
// (VS Code recognizes the basename and adds --init-file / ZDOTDIR /
// --init-command plus VSCODE_INJECTION + VSCODE_SHELL_INTEGRATION_NONCE env).
// The bootstrap stub then forwards that env to the daemon so the daemon-side
// shell loads the integration script. 'dterm' is a generic fallback for
// shells VS Code doesn't recognize -- the unrecognized basename means no
// injection happens; DTERM_REAL_SHELL tells the stub which binary to use.
for (const name of ['bash', 'zsh', 'fish', 'dterm']) {
    const linkPath = path.join(shimsDir, name);
    try { fs.unlinkSync(linkPath); } catch { /* not present */ }
    fs.symlinkSync(path.join('..', 'stub.js'), linkPath);
}
