# dterm

Persistent terminal sessions for VS Code workspaces, with auto-reattach. Self-contained — no external `tmux` or `screen` required.

## What it does

dterm spawns a small background daemon on first use. The daemon owns the pty for each session you open. When you close a VS Code window and reopen it later — or reload the window, or reconnect over SSH, or upgrade VS Code Server — your terminals come back with the same shells running, the same scrollback, the same working directories, the same labels, and the same editor-area placements.

Unlike VS Code's built-in terminal persistence, dterm sessions survive VS Code Server restarts and version upgrades, because the daemon's lifecycle is independent of VS Code's pty host. (Sessions don't survive dev container rebuilds or host reboots — the daemon lives inside the container or on the host, so anything that wipes that environment wipes the sessions too.)

## Features

- **Persistent shells.** Live processes, working directories, and scrollback all preserved across reloads, restarts, and reconnects.
- **Per-workspace scope.** Sessions are tagged with a hash of the workspace folder path; each workspace has an independent session pool.
- **Multi-client.** Multiple VS Code clients can attach to the same daemon and see the same sessions concurrently (e.g., one window per monitor on the same dev container, or a fresh client reattaching while another is still connected).
- **Editor-area placement preserved.** If you moved a terminal to the editor area, it comes back there on next open. Column and tab-order within a column are remembered, scoped per-client (different laptops connecting to the same remote keep independent layouts, matching VS Code's own per-laptop terminal layout behavior).
- **Custom labels persist.** Right-click → Rename. The label survives reattach (also per-client scoped).
- **Fresh sockets on reattach.** `SSH_AUTH_SOCK`, `VSCODE_GIT_IPC_HANDLE`, and `VSCODE_IPC_HOOK_CLI` are indirected through workspace-scoped symlinks, so reattached terminals always see the *current* VS Code host's sockets, not stale ones from a prior session. This is what keeps `code` CLI (plus the git askpass IPC and SSH agent forwarding) working from a dterm shell after a window reload or SSH reconnect.
- **VS Code shell integration.** dterm terminals are launched via a small stub that VS Code treats as a real shell binary (bash, zsh, or fish), so all of VS Code's automatic shell-integration injection applies: command decorations, command navigation (`Ctrl/Cmd+Up/Down`), recent commands, accurate CWD reporting. Integration persists naturally across reattach — the daemon's shell process keeps running with the scripts already loaded; reattaching just starts a new stub that bridges stdio.
- **Extension-contributed env propagates correctly.** Because the stub is launched by VS Code's normal terminal path, env vars contributed by other extensions (Claude Code's `CLAUDE_CODE_SSE_PORT`, the git extension's `VSCODE_GIT_*`, Python venv activations, etc.) reach the shell automatically — no probe or extra plumbing needed.

## Usage

After installation, open a terminal via the terminal panel's "+" dropdown → **dterm**. To make dterm your default profile:

```jsonc
"terminal.integrated.defaultProfile.linux": "dterm",
"terminal.integrated.defaultProfile.osx": "dterm"
```

Sessions are managed by the daemon — closing a window doesn't kill them. Auto-reattach on workspace open is enabled by default (`dterm.autoReconnect`).

## Recommended companion setting

For the cleanest startup experience:

```jsonc
"terminal.integrated.hideOnStartup": "whenEmpty"
```

This stops VS Code from spawning an unwanted default shell in the terminal panel before dterm has a chance to reattach. dterm reveals the panel automatically once the first session is reconnected, without stealing focus from your editor.

## Commands

| Command | Description |
| --- | --- |
| `dterm: Reattach all workspace sessions` | Reconnect VS Code terminals to live daemon sessions for the current workspace. |
| `dterm: Resync active terminal` | Re-render the current terminal — useful if output looks garbled after concurrent clients edited it. |
| `dterm: List sessions` | Show all live sessions across workspaces. |
| `dterm: Show daemon log` | Open the daemon's log file. |
| `dterm: Show diagnostics` | Print configuration, paths, and daemon state. |
| `dterm: Restart daemon` | Kill the daemon and all live sessions. Use only when something is wedged. |
| `dterm: Push current settings to daemon` | Re-send the current dterm.* settings to the daemon. |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `dterm.autoReconnect` | `true` | On workspace open, recreate VS Code terminals for each live daemon session belonging to this workspace. |
| `dterm.scrollbackLines` | `0` | Daemon-side scrollback retention in lines, replayed on reattach. `0` follows `terminal.integrated.scrollback`. |
| `dterm.shell` | `""` | Override the shell executable. Empty = `$SHELL` or `/bin/bash`. |
| `dterm.shellArgs` | `[]` | Arguments passed to the shell on new sessions. |

## How it compares

- **vs `terminal.integrated.enablePersistentSessions`**: VS Code's built-in persistence relies on the pty host, which is a child of VS Code Server and dies when the server dies. Only the scrollback can be revived afterward, not the live shell. dterm keeps the live shell.
- **vs `tmux` / `screen`**: no external dependency, integrates with VS Code's native terminal UI (icons, colors, labels, tab placement, link detection). Output isn't multiplexed through a tmux pane, so VS Code's shell integration (cwd detection, command decoration) keeps working.

## Platform support

- **Linux** and **macOS** (x64 and arm64).
- **Windows** is not supported.
- Requires a Unix-like host with `$XDG_RUNTIME_DIR` or `/tmp` available for the daemon socket.

## How sessions are scoped

Each workspace is hashed (SHA-1 over the workspace folder paths or `.code-workspace` file path, sliced to 8 hex chars) to produce a workspace tag. Session names are prefixed with this tag, so different workspaces never see each other's sessions even though they share a single user-level daemon.

## Architecture

dterm splits cleanly across three processes plus a small auxiliary one.

### Daemon

A single long-lived Node process per user (started lazily, double-forked off the first extension load). Owns the actual `pty` for each session, the headless xterm.js emulator that buffers scrollback, and the Unix socket that clients connect to. Its lifecycle is independent of VS Code's: VS Code Server can restart, the SSH connection can drop, the VS Code window can reload, and the daemon keeps running with the pty processes alive. Sessions only die if the shell itself exits or the daemon's process tree is wiped (container rebuild, host reboot).

The daemon polls `/proc/<pid>/stat` for the foreground process group of each session and sends `process_name` events to attached clients so tabs can show the current command.

### Extension

The VS Code half. Connects to the daemon over its Unix socket, drives session creation / attach / detach, and owns the visible terminals. Each visible terminal is a `Pseudoterminal` (extension-controlled stdio) that bridges between VS Code's renderer (xterm.js) and the daemon's pty over a dedicated client connection. Output the daemon sends becomes `writeEmitter.fire`; input the user types becomes an `input` message back to the daemon.

On extension activation, `reconnectAll` lists live sessions for the current workspace tag and creates Pseudoterminals for each, in the order recorded in workspaceState. Sequential `t.show(true)` + `await openPromise` between creates ensures every renderer is instantiated while its tab is foreground — required because VS Code never calls `Pseudoterminal.open()` on background editor-area tabs.

### Bootstrap stub

A two-stage hidden shell terminal that VS Code's terminal pipeline sees as a real shell launch. Two purposes:

1. **Env capture.** VS Code's terminal pipeline injects shell-integration env (`--init-file` path, `VSCODE_INJECTION`, `VSCODE_SHELL_INTEGRATION_NONCE`, `VSCODE_NONCE`, etc.) plus every active extension's `EnvironmentVariableCollection` contributions (`VSCODE_GIT_*`, `CLAUDE_CODE_SSE_PORT`, Python venv `PATH` modifications, etc.) when it spawns a terminal. A small Node script (`out/stub.js`) captures all of this from its own `process.env` and writes a `{env, args}` JSON payload to a per-session Unix socket the extension created before spawning it. The extension then forwards that env to the daemon in the `open` message so the daemon-side shell spawns with VS Code's full shell-integration env. Once the payload is written, the node process exits.
2. **IPC socket lifetime.** The stub is launched through a tiny POSIX shell wrapper (`out/stub-launcher.sh`) that runs the node-based capture and then `exec`s into `sleep 2147483647`. Because the kernel-level PID survives across `exec`, VS Code's pty-host sees a single long-lived persistent process and keeps the per-terminal `VSCODE_IPC_HOOK_CLI` Unix socket bound for the lifetime of the dterm session. The daemon-side shell's env points at a workspace-scoped symlink that targets this socket, so `code` CLI invocations from the daemon-side shell follow the symlink to the live IPC socket. When the dterm session ends (or the extension deactivates), the extension calls `Terminal.dispose()` on the stub, VS Code SIGHUPs the pty group, `sleep` exits, and the per-terminal CLIServer is disposed and the socket unlinked. Keep-alive cost per session is ~1–2 MB (sleep) rather than ~30–50 MB (node + V8 runtime) once capture finishes.

The stub is launched through one of the `out/shims/{bash,zsh,fish,dterm}` symlinks, each pointing at `stub-launcher.sh`; VS Code's shell-integration injection is keyed on the basename of `shellPath`, so launching via a symlink named `bash` makes VS Code inject `--init-file` for bash, etc.

### Daemon protocol

Newline-delimited JSON over a Unix socket at `$XDG_RUNTIME_DIR/dterm/daemon.sock` (falls back to `$TMPDIR`). Client → daemon: `open` (attach/create), `input`, `resize`, `detach`, `list`, `kill`, `set_scrollback_lines`, `get_session_env`, `shutdown`, `version`. Daemon → client: `opened`, `output`, `process_name`, `session_end`, `list_response`, `killed`, `session_env_response`, `version_response`, `error`. Output is base64-wrapped to stay binary-safe.

### Persistence model

Two layers, each scoped intentionally:

- **Daemon side**: in-memory map of sessions, plus the `xterm-headless` emulator's scrollback buffer per session. Survives extension reload and VS Code restart; lost on daemon restart (which only happens on explicit `dterm: Restart daemon` or daemon process kill).
- **Extension side**: per-(workspace, client) layout metadata in `workspaceState` (label, viewColumn, tabIndex, panelIndex, active terminal, panel-active, per-column active). Keys are prefixed with a per-client UUID minted into VS Code's `SecretStorage` on first activation — `SecretStorage` is the only stable VS Code API that proxies values to the local client's OS keystore even for workspace-kind extensions, so each laptop connecting to the same remote workspace gets an independent layout slice. The `client.<uuid>.session.<name>` keys can be cleared via `dterm: Clear persisted layout state for this client` or for all clients.

### Tab-to-session mapping

A long-standing source of fragility is identifying which `vscode.Tab` corresponds to which dterm session — VS Code's `Tab` API exposes a label and a group but no reference back to the `Terminal`. dterm encodes the session id directly into the terminal name as a sequence of Unicode tag characters (U+E0020–U+E007E) appended after a U+200B marker. The visible portion of the name shows the foreground process ("bash", "top", etc.) verbatim; the marker + encoded id are zero-width and don't affect display.

`getSessionFromTab(tab)` decodes the encoded id from `tab.label` on first observation and caches the mapping in a `WeakMap<Tab, sessionName>`. Renames preserve the encoding: when a user inline-renames a tab to "myterm", `snapshotLabels` re-fires `onDidChangeName` with `"myterm" + marker + encoded session id` so the tab continues to carry our identifier (the visible "myterm" is unchanged). Survives drags between editor groups, drags from panel to editor, multiple terminals showing the same process name, and user renames to colliding labels — none of which the old "match `tab.label === t.name`" loop handled correctly.

### Managed-socket indirection

`SSH_AUTH_SOCK`, `VSCODE_GIT_IPC_HANDLE`, and `VSCODE_IPC_HOOK_CLI` all rotate on every VS Code window reload, SSH reconnect, or extension restart. Daemon-side shells are long-lived, so the raw paths they were spawned with go stale.

dterm maintains a workspace-scoped symlink for each (`<agentDir>/{ssh-auth,vscode-git-ipc,vscode-ipc}.sock`) and substitutes the symlink path into the env it sends to the daemon for the shell spawn. On every bootstrap (new session OR reattach), the symlink target is retargeted to the current upstream socket captured from the stub's env. Running shells keep the same symlink path baked in; the next time they call `connect()` on that path, they follow the symlink to the current bound socket. `code`, `git`, `ssh-add`, etc. all survive reload transparently.

For `CLAUDE_CODE_SSE_PORT` (a TCP port, not symlinkable), dterm overrides `TERM_PROGRAM=dterm` in the daemon-side shell's env. Claude Code's CLI detects this and falls back to its lock-file-based discovery (`~/.claude/ide/<port>.lock`) instead of trusting the inherited env var, which gives cross-reload freshness for `claude` invocations without any proxy.

### Title and rename handling

For Pseudoterminal-backed terminals, every name dterm sets — both the initial `TerminalOptions.name` and every `onDidChangeName` fire driven by daemon-side process-name events — routes to VS Code's `TitleEventSource.Api` (the same source as user inline-rename). So our fires take effect at the highest priority and update tab titles immediately, but a user inline-rename is a last-writer-wins update that overrides ours. `snapshotLabels` detects this by checking whether `t.name` still decodes to our session id; if not, the user has renamed, and we re-fire with the user's visible value plus the encoded id appended.

## License

MIT
