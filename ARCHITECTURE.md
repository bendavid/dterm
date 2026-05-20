# dterm architecture

This document describes the internal structure of dterm: process model, lifecycles, protocols, and the non-obvious design decisions behind the trickier parts. The intended audience is contributors, future maintainers, and anyone debugging a tricky issue. End-user docs live in [README.md](README.md).

## Process model

dterm splits cleanly across three processes, plus a transient auxiliary one.

### Daemon

A single long-lived Node process per user, started lazily and double-forked off the first extension load. It owns:

- The real `pty` for each session (via `node-pty`).
- The headless [`xterm.js`](https://xtermjs.org/) emulator that buffers scrollback per session.
- The Unix socket at `$XDG_RUNTIME_DIR/dterm/daemon.sock` (falling back to `$TMPDIR`) that all clients connect to.
- Per-session persistent layout state — label, per-client positions, per-client selection memory — see [Persistence model](#persistence-model).

Its lifecycle is independent of VS Code's: VS Code Server can restart, the SSH connection can drop, the VS Code window can reload, the extension host can be killed — the daemon keeps running with the pty processes alive. Sessions only die if the shell itself exits or the daemon's process tree is wiped (container rebuild, host reboot).

The daemon polls `/proc/<pid>/stat` for the foreground process group of each session and sends `process_name` events to attached clients so tabs can show the current command.

It also taps `xterm-headless`'s OSC 633 dispatch via `parser.registerOscHandler(633, ...)` — the same hook VS Code's own `shellIntegrationAddon` uses — to track shell-integration property state (`Cwd`, `HasRichCommandDetection`, `PromptType`, etc.) so it can re-emit them at every reattach replay. Without this, `Terminal.shellIntegration.cwd` and friends would be empty for reattached terminals until the next shell prompt. xterm-headless's `onTitleChange` event captures OSC 0/2 sequence titles for `${sequence}` substitution in tab-title templates.

### Extension

The VS Code half. Connects to the daemon over its Unix socket, drives session creation / attach / detach, and owns the visible terminals.

Each visible terminal is a `Pseudoterminal` (extension-controlled stdio) that bridges between VS Code's renderer (xterm.js) and the daemon's pty over a dedicated client connection. Output the daemon sends becomes `writeEmitter.fire`; input the user types becomes an `input` message back to the daemon.

On extension activation, `reconnectAll` lists live sessions for the current workspace tag and creates Pseudoterminals for each, in the order recorded in the layout cache. Sequential `t.show(true)` + `await openPromise` between creates ensures every renderer is instantiated while its tab is foreground — required because VS Code never calls `Pseudoterminal.open()` on background editor-area tabs.

### Bootstrap stub

A small Node script (`out/stub.js`) that VS Code launches as a hidden terminal purely for env capture. VS Code's terminal pipeline injects shell-integration env (`--init-file` path, `VSCODE_INJECTION`, `VSCODE_SHELL_INTEGRATION_NONCE`, `VSCODE_NONCE`, etc.) plus every active extension's `EnvironmentVariableCollection` contributions (`VSCODE_GIT_*`, `CLAUDE_CODE_SSE_PORT`, Python venv `PATH` modifications, etc.) when it spawns a terminal. The stub captures all of this from its own `process.env`, writes a `{env, args}` JSON payload to a per-session Unix socket the extension created before spawning it, and exits. The extension forwards that env to the daemon in the `open` message so the daemon-side shell spawns with VS Code's full shell-integration env.

No keep-alive: the stub exits as soon as the payload write completes, and the hidden Terminal is `dispose()`d. dterm doesn't depend on the per-terminal `VSCODE_IPC_HOOK_CLI` socket VS Code provisions for the stub — `code` CLI from the daemon-side shell reaches VS Code through the extension-host-wide CLIServer instead, indirected through a workspace-scoped symlink (see [Managed-socket indirection](#managed-socket-indirection) below).

The stub is launched through one of the `out/shims/{bash,zsh,fish,dterm}` symlinks, all of which point at `out/shim-launcher.sh` — a tiny POSIX-sh script that `exec`s `$DTERM_NODE_BIN $DTERM_STUB_JS "$@"`. The extension sets `DTERM_NODE_BIN` to `process.execPath` (VS Code Server's bundled node on Remote-SSH / dev containers, or the Electron binary on desktop with `ELECTRON_RUN_AS_NODE=1`) and `DTERM_STUB_JS` to the absolute path of `out/stub.js` in `TerminalOptions.env`. This indirection avoids requiring a system `node` on `PATH` — minimal dev-container images (Alpine, minimal AlmaLinux/RHEL, etc.) often don't have one even though VS Code Server is happily running on the same machine. `/bin/sh` is universally present on every Unix VS Code runs on.

VS Code's shell-integration injection is keyed on `basename(shellPath)`, so launching via a symlink named `bash` makes VS Code inject `--init-file` for bash, regardless of what the symlink resolves to. The launcher's `"$@"` forwards that injected argv into `stub.js`, which captures it in `process.argv` and forwards it to the daemon for the real shell to consume.

On reattach, a single shared bootstrap stub is spawned at the top of `reconnectAll` purely to refresh the workspace-scoped managed-socket symlinks against current EVC-contributed values (`VSCODE_GIT_IPC_HANDLE` in particular, since it isn't in the extension host's own `process.env`). The N session reattaches in the loop don't each spawn their own bootstrap — they'd capture the same window-scoped env and do identical work.

## Daemon protocol

Newline-delimited JSON over the Unix socket. Client → daemon messages:

| Message | Purpose |
| --- | --- |
| `open` | Attach to or create a session. |
| `input` | Bytes typed by the user. |
| `resize` | Pty dim change. |
| `detach` | This client is leaving without killing the session. |
| `list` | Enumerate live sessions (optionally with clientId+workspaceTag for layout-scoped response). |
| `kill` | Kill a session. |
| `set_scrollback_lines` | Push scrollback config change. |
| `get_session_env` | Read the daemon-side shell's `/proc/<pid>/environ`. |
| `set_session_label` | Set a session's workspace-shared label. |
| `set_session_position` | Set this client's position record for a session. |
| `set_client_selection` | Update this client's active / panel-active / editor-active selection in a workspace. |
| `clear_client_layout` | Wipe one client's layout state for a workspace. |
| `clear_all_layouts` | Wipe every client's layout state + workspace-shared labels for a workspace. |
| `shutdown` | Daemon-wide shutdown. |
| `version` | Daemon version query (used to detect mismatched daemons after upgrade). |

Daemon → client:

| Message | Purpose |
| --- | --- |
| `opened` | Attach succeeded. |
| `output` | Pty bytes (base64 wrapped to stay binary-safe). |
| `process_name` | Foreground process name change. |
| `sequence_title` | Shell-set OSC 0/2 title (feeds `${sequence}` in tab-title templates). |
| `list_response` | Reply to `list`. Carries `names[]` plus optional layout-scoped `sessions[]` + `selection`. |
| `killed` | Kill confirmation. |
| `session_end` | Shell exited / pty closed. |
| `version_response` | Daemon version reply. |
| `session_env_response` | Env-read reply. |
| `layout_ack` | Generic ack for layout-mutating RPCs. Carries `cleared` count for the clear-layout commands. |
| `error` | Error reply (RPC failure, unknown session, etc.). |

## Persistence model

All persistent layout state lives on the daemon. Two layers:

- **Daemon-side session data**: in-memory `Session` map plus the `xterm-headless` emulator's scrollback buffer per session. Survives extension reload, window reload, VS Code Server restart, SSH reconnect. Lost on daemon restart (which only happens on explicit `dterm: Restart daemon` or daemon process kill / system shutdown).
- **Daemon-side layout state**: `Session.label` (workspace-shared, one value per session), `Session.positions: Map<clientId, Position>` (per-client position records), and a top-level `Map<clientId, Map<workspaceTag, ClientSelection>>` for per-(client, workspace) selection memory (active session, panel-active, per-editor-column-active). Same lifetime as session data. No disk persistence — the underlying sessions would die with a daemon restart anyway, making the layout state irrelevant after the same event.

The extension keeps a `layoutCache` populated at activation / reconnect from a single `list` RPC. Reads (`getMeta`, `getActive`, etc.) come from the cache; writes update the cache synchronously and ship a oneShot RPC to the daemon.

### Why not VS Code's `workspaceState`?

dterm initially used `workspaceState` for layout (per-client positions, labels, selection). On Remote-SSH this turned out not to be a workspace-scoped store at all: VS Code Server's [`extHostStoragePaths.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/api/node/extHostStoragePaths.ts) exclusive-locks the canonical `workspaceStorage/<hash>/` directory per extension-host process via a heartbeat-refreshed `vscode.lock` file. Concurrent windows on the same workspace fall through to `<hash>-1/`, `<hash>-2/`, etc., each with a separate `state.vscdb`. The result: cross-client writes were invisible, and a single client could even lose its own layout state across its own reload if VS Code Server lock-routed it into a different suffix.

The daemon — one process per remote regardless of window count, no lock fragmentation — was the correct store all along. clientId from `SecretStorage` (which is the only stable VS Code API on Remote-SSH because it proxies to the local OS keystore) provides per-laptop identity for the per-client scoping.

## Tab-to-session mapping

A long-standing source of fragility is identifying which `vscode.Tab` corresponds to which dterm session — VS Code's `Tab` API exposes a label and a group but no reference back to the `Terminal`. dterm encodes the session id directly into the terminal name as a sequence of Unicode tag characters (U+E0020–U+E007E) appended after a U+200B marker. The visible portion of the name shows the foreground process ("bash", "top", etc.) verbatim; the marker + encoded id are zero-width and don't affect display.

`getSessionFromTab(tab)` decodes the encoded id from `tab.label` on first observation and caches the mapping in a `WeakMap<Tab, sessionName>`. Renames preserve the encoding: when a user inline-renames a tab to "myterm", `snapshotLabels` re-fires `onDidChangeName` with `"myterm" + marker + encoded session id` so the tab continues to carry our identifier (the visible "myterm" is unchanged). Survives drags between editor groups, drags from panel to editor, multiple terminals showing the same process name, and user renames to colliding labels — none of which the old "match `tab.label === t.name`" loop handled correctly.

## Managed-socket indirection

`SSH_AUTH_SOCK`, `VSCODE_GIT_IPC_HANDLE`, and `VSCODE_IPC_HOOK_CLI` all rotate on every VS Code window reload, SSH reconnect, or extension restart. Daemon-side shells are long-lived, so the raw paths they were spawned with go stale.

dterm maintains a workspace-scoped symlink for each (`<agentDir>/{ssh-auth,vscode-git-ipc,vscode-ipc}.sock`) and substitutes the symlink path into the env it sends to the daemon for the shell spawn. On every bootstrap (new session OR reattach), the symlink target is retargeted to the current upstream value. For `SSH_AUTH_SOCK` and `VSCODE_GIT_IPC_HANDLE` the upstream comes from the bootstrap-captured env (the values are extension-contributed at terminal-spawn time and don't appear in the extension host's own `process.env`). For `VSCODE_IPC_HOOK_CLI` the upstream comes from the extension host's `process.env`, which is set by VS Code's `extHostExtensionService` to point at the per-extension-host CLIServer (one per window, lifetime = extension host). This avoids depending on the per-terminal CLIServer that VS Code provisions for individual terminal spawns, so the bootstrap stub doesn't need to be kept alive. Running shells keep the same symlink path baked in; the next time they call `connect()` on that path, they follow the symlink to the current bound socket. `code`, `git`, `ssh-add`, etc. all survive reload transparently.

For `CLAUDE_CODE_SSE_PORT` (a TCP port, not symlinkable), dterm overrides `TERM_PROGRAM=dterm` in the daemon-side shell's env. Claude Code's CLI detects this and falls back to its lock-file-based discovery (`~/.claude/ide/<port>.lock`) instead of trusting the inherited env var, which gives cross-reload freshness for `claude` invocations without any proxy.

## Shell-integration state replay

When a session is reattached, the visible Pseudoterminal's parser state is fresh — it has seen no OSC 633 sequences yet. xterm-headless's `SerializeAddon` reproduces the visual scrollback but strips OSC control sequences from the replay, so `Terminal.shellIntegration.{cwd, hasRichCommandDetection, ...}` would stay undefined until the shell emitted them again (typically on the next prompt).

The daemon taps `parser.registerOscHandler(633, ...)` on every session's xterm-headless instance and tracks the latest value for each `OSC 633 ; P ; <Key>=<Value>` property (`Cwd`, `PromptType`, `ContinuationPrompt`, `Prompt`, `IsWindows`, `HasRichCommandDetection`). At reattach replay time, it prepends a serialized burst of those properties to the visual snapshot before the bytes flow to the client. The receiving VS Code parser sees them as if they'd just been emitted, populating `shellIntegration` immediately.

`HasRichCommandDetection=True` is sent first in the replay burst so the parser is already in the rich-detection state when any subsequent live `A`/`B`/`C`/`D` sequences from the shell arrive after the snapshot.

## Shell-integration nonce coordination

Every new dterm session mints a UUID at the profile-provider call site and passes it both to the bootstrap stub's `TerminalOptions.shellIntegrationNonce` (VS Code injects it as `VSCODE_NONCE` in the stub's env, which the stub captures and forwards to the daemon-side shell verbatim, per VS Code's `terminalEnvironment.ts` `envMixin['VSCODE_NONCE']`) and to the visible Pseudoterminal's `ExtensionTerminalOptions.shellIntegrationNonce`. Both endpoints agree on a single nonce synchronously; no env-rewriting in the daemon `open` payload.

On reattach the daemon-side shell already has `VSCODE_NONCE` baked into its env from the original session's bootstrap and can't be changed for a running shell. The reattach path fetches it via the existing `get_session_env` protocol message before `createTerminal` and threads it into the new Pseudoterminal's `shellIntegrationNonce`. The reattach bootstrap stub's own nonce is irrelevant — we already know the actual daemon-side value.

Without this, the visible Pseudoterminal's parser would auto-generate its own nonce that wouldn't match the daemon-side shell's OSC 633 ; E emissions, and `Terminal.shellIntegration.commandLine.isTrusted` would silently be `false` for every command.

## Title and rename handling

For Pseudoterminal-backed terminals, every name dterm sets — both the initial `TerminalOptions.name` and every `onDidChangeName` fire driven by daemon-side process-name events — routes to VS Code's `TitleEventSource.Api` (the same source as user inline-rename). So our fires take effect at the highest priority and update tab titles immediately, but a user inline-rename is a last-writer-wins update that overrides ours. `snapshotLabels` detects this by checking whether `t.name` still decodes to our session id; if not, the user has renamed, and we re-fire with the user's visible value plus the encoded id appended.

## Tab-title template resolution

VS Code's `terminal.integrated.tabs.title` template (and the `terminal.integrated.tabs.separator` it references) is honoured by dterm Pseudoterminals via a re-implementation of VS Code's own [`template()`](https://github.com/microsoft/vscode/blob/main/src/vs/base/common/labels.ts) helper. VS Code's `TerminalLabelComputer` only consults the template when the title source is `Process` (auto-detected process name) or `Sequence` (OSC 0/2); Api-source fires — which is what dterm produces every time we update the name — bypass it via the `staticTitle` short-circuit. So we substitute the template ourselves and feed the result back through `onDidChangeName`.

`template()` is ported verbatim — same tokeniser, same segment model (TEXT, VARIABLE, SEPARATOR), same "separator collapses when surrounded by an empty value" filter rule. Behaviourally identical to VS Code's resolver for the variables both support.

Supported variables: `${process}`, `${cwd}`, `${cwdFolder}` (VS Code's rule: shown only when multi-root OR cwd ≠ workspace folder), `${workspaceFolder}`, `${workspaceFolderName}`, `${workspace}` (alias for `vscode.workspace.name`, dterm-specific), `${session}` (dterm session id, dterm-specific), `${sequence}` (shell-set OSC 0/2 title, daemon-side captured), `${separator}`. Variables that don't apply to Pseudoterminals (`${task}`, `${local}`, `${shellType}`, `${shellCommand}`, `${shellPromptInput}`, `${progress}`, `${fixedDimensions}`) resolve to empty so the separator-collapse rule cleans up around them.

The `dterm.tabTitle` setting overrides `terminal.integrated.tabs.title` for dterm terminals only when non-empty.

Re-fires happen on every input change: `process_name` and `sequence_title` from the daemon, `onDidEndTerminalShellExecution` for `${cwd}` updates, `onDidChangeTerminalShellIntegration` for the initial cwd detection, `onDidChangeConfiguration` for live template / separator edits, `onDidChangeWorkspaceFolders` for `${workspace}` updates. Name-locked terminals (user inline-rename or restored saved label) bypass the template entirely — same precedence VS Code's `staticTitle` gives the user's explicit choice for native terminals.

## Daemon spawn strategy

Two paths, chosen at spawn time:

- **`systemd-run --user`** (default on Linux when user-systemd is available). The daemon runs as a transient `--user` service named `dterm-daemon[-<inst>]` (stable per `(user, instance)` — the daemon is a singleton and `--collect` auto-removes the unit on exit, so no random suffix is needed). `StandardOutput`/`StandardError` are appended to the same log file the legacy path uses, so `dterm: Show daemon log` works uniformly. Benefits: the daemon is reparented to user-systemd rather than init, survives logind's `KillUserProcesses=yes`, and is visible via `systemctl --user status dterm-daemon` and `journalctl --user -u dterm-daemon`.
- **Double-fork** (fallback on non-Linux, when user-systemd isn't running, or when `dterm.useSystemdRun` is `false`). An intermediate `node -e <code>` child spawns the real daemon `detached: true` and exits; the daemon reparents to PID 1 and is no longer a descendant of the Electron extension host (so Electron's child-tree kill on quit can't reach it).

Strategy selection happens in two stages.

**At activation (sync)**: `dterm.useSystemdRun` is `"auto" | "always" | "never"`. `never` short-circuits to double-fork. `always` checks user-systemd availability (`$XDG_RUNTIME_DIR/systemd/private` socket + `systemctl --user is-system-running` reporting `running`/`degraded`/`starting`). `auto` does that *plus* queries logind's `KillUserProcesses` property over DBus (`busctl get-property org.freedesktop.login1 /org/freedesktop/login1 ... KillUserProcesses`) and only proceeds when it's `true` — that's the only case where the double-fork's reparent-to-PID-1 strategy actually fails (logind walks every cgroup in the user slice on session end and kills it, init-parent or not). On the much more common `KillUserProcesses=no` configurations, double-fork is already fully durable and we don't bother.

**At spawn (async)**: with the env var set, `client.ts` checks `/var/lib/systemd/linger/<user>` existence. If lingering isn't enabled, it calls back through a hook the extension registered at activate, which surfaces a `vscode.window.showInformationMessage` prompt asking the user to enable it. Choosing **Enable lingering** runs `loginctl enable-linger` (polkit allows this without password on most desktops); choosing **Use double-fork** falls back. The decision is cached for the lifetime of the extension host (so subsequent spawns don't re-prompt). Lingering is load-bearing: without it user-systemd terminates on the user's last session end, which on Remote-SSH means SSH disconnect kills the daemon — defeating dterm's whole purpose. The double-fork survives session end unconditionally, so it's the safe fallback whenever lingering isn't there.

If `systemd-run` itself returns non-zero at spawn (rare — would mean a misconfigured user manager or an unsupported `--property` value), the spawn falls through to double-fork in the same call; the failure is appended to the daemon log so it's visible in `dterm: Show daemon log`.

## Instance namespacing

A single dterm-instance string is threaded through every shared resource so the marketplace install and a development build can coexist without fighting over the same daemon. When the instance is `""` (default), paths are `…/dterm/daemon.sock`, `…/dterm-<uid>.log`, `…/dterm/agent/<tag>`, and sessions are named `vscode-<tag>-N`. When the instance is `<inst>`, every leaf gets an `-<inst>` infix: socket `…/dterm-<inst>/daemon.sock`, log `…/dterm-<inst>-<uid>.log`, agent dir `…/dterm-<inst>/agent/<tag>`, sessions `vscode-<inst>-<tag>-N`.

Resolution order in `extension.ts`'s `activate`: `dterm.instanceId` setting if non-empty, else `ctx.extensionMode === Development ? 'dev' : ''`. The resolved value is stamped into `process.env.DTERM_INSTANCE` before any path helper runs; the daemon inherits it through the double-fork spawn in `client.ts` and reads it via the same `paths.ts` helpers, so both sides agree on the leaf names without an explicit handshake. Changing the setting at runtime requires a window reload — there's no live re-migration of an attached daemon, on purpose, since "switch which daemon I'm talking to" mid-session would orphan all currently-open terminals.
