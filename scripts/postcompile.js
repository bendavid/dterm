#!/usr/bin/env node
// Post-compile: prepare out/stub.js as an executable with shebang, and
// materialize the bash/zsh/fish symlinks VS Code dispatches against.
const fs = require('fs');
const path = require('path');

const outDir = path.join(__dirname, '..', 'out');
const stubPath = path.join(outDir, 'stub.js');

// Shebang carries U+200B in the program name so the kernel sets /proc/<pid>/comm
// to "node​" at exec time. VS Code's 200ms node-pty poll then picks up a
// marker-tagged _processName from the very first tick, so the extension can
// tell daemon-driven tab names apart from user renames with no startup race.
// The extension's activate() ensures a `node​` symlink exists on the
// terminal's PATH so /usr/bin/env can resolve it.
const SHEBANG = '#!/usr/bin/env node\u200B\n';
const existing = fs.readFileSync(stubPath, 'utf8');
const body = existing.startsWith('#!')
    ? existing.slice(existing.indexOf('\n') + 1)
    : existing;
fs.writeFileSync(stubPath, SHEBANG + body);
fs.chmodSync(stubPath, 0o755);

const shimsDir = path.join(outDir, 'shims');
fs.mkdirSync(shimsDir, { recursive: true });
// 'bash', 'zsh', 'fish' get VS Code's automatic shell-integration injection
// (VS Code recognizes the basename). 'dterm' is a generic fallback for shells
// VS Code doesn't recognize — the unrecognized basename means VS Code won't
// inject anything, and DTERM_REAL_SHELL tells the stub which actual binary
// the daemon should spawn.
for (const name of ['bash', 'zsh', 'fish', 'dterm']) {
    const linkPath = path.join(shimsDir, name);
    try { fs.unlinkSync(linkPath); } catch { /* not present */ }
    fs.symlinkSync(path.join('..', 'stub.js'), linkPath);
}
