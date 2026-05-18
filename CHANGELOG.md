# Changelog

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
