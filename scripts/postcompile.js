#!/usr/bin/env node
// Post-compile: prepare out/stub.js as an executable with shebang,
// materialize the bash/zsh/fish/dterm symlinks VS Code dispatches against,
// and stamp out/build-info.json with the current git commit so an installed
// extension can report what it was built from (the VSIX doesn't ship .git).
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const repoDir = path.join(__dirname, '..');
const outDir = path.join(repoDir, 'out');
const stubPath = path.join(outDir, 'stub.js');

function gitCmd(args) {
    try {
        const r = cp.spawnSync('git', args, {
            cwd: repoDir,
            encoding: 'utf8',
            timeout: 2000,
        });
        if (r.status !== 0) return undefined;
        return (r.stdout || '').trim();
    } catch { return undefined; }
}

// Stamp out/build-info.json. Tolerates a non-git source tree (released
// source archive, etc) -- the fields just come out as undefined and the
// extension's diagnostics print "(unknown)".
const buildInfo = {
    commit: gitCmd(['rev-parse', 'HEAD']),
    commitShort: gitCmd(['rev-parse', '--short=12', 'HEAD']),
    commitDate: gitCmd(['log', '-1', '--format=%cI']),
    // `git status --porcelain` is empty iff the working tree is clean.
    dirty: (() => {
        const out = gitCmd(['status', '--porcelain']);
        if (out === undefined) return undefined;
        return out.length > 0;
    })(),
    builtAt: new Date().toISOString(),
};
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
    path.join(outDir, 'build-info.json'),
    JSON.stringify(buildInfo, null, 2) + '\n',
);

const SHEBANG = '#!/usr/bin/env node\n';
const existing = fs.readFileSync(stubPath, 'utf8');
const body = existing.startsWith('#!')
    ? existing.slice(existing.indexOf('\n') + 1)
    : existing;
fs.writeFileSync(stubPath, SHEBANG + body);
fs.chmodSync(stubPath, 0o755);

// Defensive cleanup: prior versions (0.8.2) emitted a stub-launcher.sh that
// kept the per-terminal CLIServer's socket bound via `exec sleep` after env
// capture. We don't depend on the per-terminal CLIServer anymore (we route
// `code` CLI through the extension-host's VSCODE_IPC_HOOK_CLI socket via
// MANAGED_SOCKETS), so the launcher is gone and the stub exits immediately
// after writing the bootstrap payload. Drop any stale file from prior builds
// so it doesn't ship in the VSIX or confuse local repros.
const stalePath = path.join(outDir, 'stub-launcher.sh');
try { fs.unlinkSync(stalePath); } catch { /* not present */ }

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
