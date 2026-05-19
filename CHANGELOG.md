# Changelog

## 0.8.1

CI maintenance only -- no extension behaviour change.

- Bump the workflow's GitHub-action wrappers to Node-24 majors
  (`checkout@v6`, `setup-node@v6`, `upload-artifact@v7`,
  `download-artifact@v8`) to clear the Node-20 deprecation warning
  ahead of GitHub's 2026-06-02 forced switchover. The runtime Node
  used to compile/rebuild node-pty stays on 20 to match the VS Code
  Electron runtime.

## 0.8.0

User-set session labels are now workspace-shared across clients.
Renaming a terminal on one laptop carries over to other laptops
connecting to the same remote workspace.

- Labels are stored in a workspace-shared keyspace
  (`session.<name>.label`), not under the per-client `client.<uuid>.`
  prefix. Positions (viewColumn / tabIndex / panelIndex) remain per-
  client so each laptop keeps its own monitor/screen-real-estate
  arrangement.
- Last-write-wins on concurrent edits. Cross-client visibility shows
  up at the other client's next window reload; there is no live
  cross-extension-host change notification.
- Position and label writes are routed through separate setters
  (`setPosition` / `setLabel` / `clearMeta`) so the 2s position-snapshot
  poll on one client cannot silently clobber a concurrent rename on
  another client. Each VS Code extension host has its own in-memory
  `workspaceState` copy and never observes another host's writes during
  runtime, so a combined `setMeta` with a `{ ...current, viewColumn }`
  spread would have written stale label values back to the shared store
  on every position change.
- "dterm: Clear persisted layout state for all clients" now also
  clears the shared `session.*.label` keys. The per-client variant is
  unchanged.
- No backwards-compatibility migration: labels persisted under the old
  per-client layout (0.7.x and earlier) are no longer read. Reapply
  any inline renames you want to keep.

## 0.7.1

- New command "dterm: Clear persisted layout state for this client"
  wipes all workspaceState keys prefixed with `client.<this-client-id>.`
  in the current workspace. Other laptops connecting to the same
  remote workspace are unaffected.
- New command "dterm: Clear persisted layout state for all clients"
  wipes every `client.*` key in the current workspace, regardless of
  which client wrote it.

Both commands prompt for confirmation with a summary of how many
entries / clients / session labels will be cleared. The effect is
visible after the next window reload; existing terminals continue to
function and daemon sessions are not affected (use "dterm: Restart
daemon" for that).

## 0.7.0

`code` and `claude` CLIs now work in dterm shells across VS Code
window reloads. Substantial improvements to tab/session mapping,
managed-socket plumbing, and a new diagnostic command.

- The bootstrap stub stays alive for the lifetime of the dterm
  session instead of exiting after capturing env. This keeps VS
  Code's per-terminal IPC socket (`VSCODE_IPC_HOOK_CLI`) bound, so
  the `code` CLI can connect to its parent VS Code window from
  within a dterm shell. Each dterm session now has one extra hidden
  `pty-host` child process (small memory cost; see below).
- `VSCODE_IPC_HOOK_CLI` is now in the managed-sockets list. The
  daemon-side shell's env uses a stable workspace-scoped symlink
  path; on every bootstrap (new session AND reattach) the symlink
  target is updated to the current keep-alive stub's IPC socket. As
  long as a stub is alive for the session, `code` CLI continues to
  work across window reloads, SSH reconnects, and VS Code Server
  restarts.
- Reattach now also spawns a fresh bootstrap stub purely to hold a
  fresh IPC socket bound for the reattached session. The captured
  env's `VSCODE_GIT_IPC_HANDLE`, `SSH_AUTH_SOCK`, and
  `VSCODE_IPC_HOOK_CLI` are all symlink-refreshed so existing daemon-
  side shells transparently resolve to the current sockets.
- `TERM_PROGRAM` is set to `dterm` in the daemon-side shell's env
  (overriding VS Code's default `vscode`). This routes the `claude`
  CLI into its lock-file-based IDE discovery path (reading
  `~/.claude/ide/<port>.lock`) rather than relying on the inherited
  `CLAUDE_CODE_SSE_PORT` env var which goes stale on every reload.
  `claude` now works in dterm shells across reload without further
  plumbing.
- Tab-to-session mapping is now driven by an invisible session ID
  encoded directly in the terminal name (Unicode tag characters
  appended after a `U+200B` marker). `getSessionFromTab` decodes the
  embedded id at first observation and caches in a `WeakMap<Tab,
  sessionName>`. Fixes the long-standing class of layout bugs where
  multiple terminals sharing the same process name (e.g. several
  unrenamed terminals all showing `bash`) caused
  editor/panel-misclassification on reattach.
- User inline-renamed tabs also carry the session encoding: when a
  rename is detected, dterm re-fires `onDidChangeName` with the
  user's visible value plus the marker+encoded id appended (the
  visible portion is preserved verbatim). Cross-reload mapping
  stays reliable even when users rename multiple tabs to similar
  names.
- Editor/panel misclassification fix: the `creationOptions.location`
  cross-check used to stick permanently, so a user dragging a
  reconnect-spawned editor terminal back to the panel had the move
  silently ignored. Now gated on `everSeenInEditor` so the cross-
  check only applies before the first successful tabGroups match,
  and drags propagate correctly.
- Managed-socket symlinks now actually reach the daemon-side shell.
  Previously the `Object.assign(env, refreshManagedSockets())` in
  `buildBootstrapStubOptions` was a no-op because VS Code applies
  `EnvironmentVariableCollection` mutators after `TerminalOptions.env`
  -- the Remote-SSH and git extensions' Replace mutators silently
  overwrote our symlink paths with raw upstream values. The override
  now runs in `DtermPseudoterminal.connect()` after bootstrap
  capture, before sending env to the daemon, where nothing can clobber
  it. `SSH_AUTH_SOCK` and `VSCODE_GIT_IPC_HANDLE` symlink indirection
  now genuinely works as the README always claimed.
- New `dterm: Check env freshness` command. Reads the daemon-side
  shell's current env from `/proc/<pid>/environ` and diffs it against
  a freshly-captured bootstrap env. Useful for spotting drift in
  rotating endpoints after a reconnect.

## 0.6.0

Architecture overhaul: Pseudoterminal-backed visible terminals, direct
env capture, and per-client layout scoping via SecretStorage. No
user-facing behaviour changes; reattach is meaningfully cheaper.

- The visible terminal is once again a Pseudoterminal owned by the
  extension. A sequential show-then-wait pattern in `reconnectAll`
  fixes the original blocker (background editor-area tabs never
  receiving `Pseudoterminal.open()`): each terminal is made the
  active tab in its target group at creation time and we wait for
  `open()` to fire before creating the next sibling. The renderer
  is therefore instantiated while the tab is foreground; subsequent
  siblings only push it to background after the writeEmitter is
  wired up.
- The bootstrap stub no longer talks to the daemon. The extension
  creates a per-session Unix socket before spawning the (still
  hidden) stub, the stub captures VS Code's injected env + argv,
  writes them to the socket as JSON, and exits. The Pseudoterminal
  then sends a single `open` message to the daemon carrying that
  env + the visible terminal's real dims, so the daemon-side shell
  spawns at the right size with full shell-integration env and no
  spawn-then-resize-then-snapshot-replay dance.
- Reattach skips the bootstrap entirely. The daemon-side shell was
  spawned with the right env when the session was first created;
  on reattach the Pseudoterminal just connects with name + dims.
  Stub spawn cost is now paid only for genuinely new sessions.
- Per-client scoping of layout state via a UUID minted into
  SecretStorage on first activation. SecretStorage is the only
  stable VS Code API that proxies storage to the local client side,
  so each laptop connecting to the same remote workspace gets a
  distinct UUID and therefore an independent slice of the (still
  remote-side) workspaceState. Falls back to `vscode.env.machineId`
  if the local OS keyring is unavailable (rare on macOS/Windows;
  on Linux without a keyring service VS Code falls back to a
  basic plaintext store automatically).
- Process-name tracking is now race-free. Every name we set on a
  Pseudoterminal carries a trailing U+200B (zero-width space) so
  the snapshot polling loop can synchronously tell our values from
  user inline-renames: marker present means "ours, ignore", marker
  absent means "user value, lock and persist as label". The
  previous `t.name`/`lastFiredName` comparison was racing against
  VS Code's async title propagation and intermittently locking
  out future updates after a fresh attach.
- Inline-renaming a tab to empty (or via any path that drops the
  user's Api-source title) restores automatic process-name
  tracking: the marker reappearing on `t.name` is detected and
  the lock is released.
- `dterm.resyncActive` still requires close-and-reopen for now
  (the daemon connection is owned by the Pseudoterminal, and the
  resync command predates the new architecture).

## 0.5.0

Layout restoration improvements and a major revert of the underlying
terminal architecture.

- Visible terminal is once again a shell-binary stub launched via VS Code's
  normal pty pipeline, after a Pseudoterminal-based attempt was found to
  hang on reattach for background tabs in editor groups (VS Code's
  `Pseudoterminal.open()` is never called for non-active editor-area tabs).
- Reattach now restores not only the globally-active terminal but also the
  selected tab in the terminal panel and the selected tab in each editor
  column independently.
- Editor-area terminals are created sequentially on reattach with
  per-terminal spawn-await, working around a pty-host lazy-spawn race
  where simultaneous creations in the same column could cancel each other.
- Daemon protocol: `cols`/`rows` are now optional on `open` for reattach,
  letting clients defer reporting dims until VS Code provides the real
  layout dimensions and avoiding a spurious resize on every reconnect.
- New command "dterm: Show extension log"; the daemon-log dump now uses
  its own output channel so peeking at it no longer clears the extension
  log.

## 0.4.2

Initial public release.
