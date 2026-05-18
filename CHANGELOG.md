# Changelog

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
