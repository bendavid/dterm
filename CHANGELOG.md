# Changelog

## 0.10.0

Move all persistent layout state from VS Code's `workspaceState` onto the
daemon.

VS Code Server's `extHostStoragePaths.ts` exclusive-locks the canonical
`workspaceStorage/<hash>/` directory with `vscode.lock` per extension-host
process; concurrent windows on the same workspace fall through to
`<hash>-1/`, `<hash>-2/`, etc. (heartbeat-refreshed lock, 10-minute
staleness threshold, separate `state.vscdb` in each suffixed dir). That
made workspaceState a per-extension-host-instance store on Remote-SSH
rather than the workspace-scoped store we'd been treating it as: writes
from one client window were invisible to other client windows opening
the same workspace, and a single client's writes could even disappear
across its own reload if VS Code Server lock-routed it into a different
suffix the next time. Labels never propagated cross-client; per-client
positions were silently partitioned across whatever subset of
`<hash>-N` dirs that client happened to land on.

Daemon-side storage was the correct model all along: one process per
remote regardless of window count, no lock fragmentation, lifetime
matches scrollback / shell-integration state which already live there.

Architectural changes:

- `Session` on the daemon gains `label?: string` (workspace-shared
  across all clients) and `positions: Map<string, SessionPosition>`
  (keyed by clientId, scoped per-client).
- New top-level `clientSelections: Map<clientId, Map<workspaceTag,
  ClientSelection>>` tracks each client's per-workspace selection
  memory (active session, panel-active, per-editor-column-active).
  Lives outside `Session` so selection survives individual session
  death/recreate within a workspace.
- New protocol messages: `set_session_label`, `set_session_position`,
  `set_client_selection`, `clear_client_layout`,
  `clear_all_layouts`. All daemon-acked via the new `layout_ack`
  reply.
- `list` request gains optional `clientId` + `workspaceTag`
  parameters. When provided, `list_response` includes a `sessions`
  array (each entry = `{ name, label?, position? }` filtered to the
  requesting clientId) and a `selection` object scoped to
  `(clientId, workspaceTag)`. Existing `names` field preserved for
  back-compat with diagnostic-only callers.
- Extension keeps a local `layoutCache` populated at activation /
  reconnect via the augmented `list` RPC. All `getMeta` / `getActive`
  / `getPanelActive` / `getEditorActive` reads come from the cache;
  all setters update the cache synchronously and ship a oneShot RPC
  to the daemon.

Surface-level cleanups:

- `metaKey`, `labelKey`, `activeKey`, `panelActiveKey`,
  `editorActiveKey`, `editorActivePrefix`, `LABEL_KEY_PREFIX`,
  `LABEL_KEY_SUFFIX` -- all removed; nothing keys workspaceState
  anymore.
- `pruneStaleMeta` replaced with `pruneStaleSelection`: only
  selection slots need extension-side pruning since daemon-side
  positions and labels are released automatically when the session
  dies (Session struct + its positions map go with it).
- `clearLayoutState` rewritten to send `clear_client_layout` /
  `clear_all_layouts` to the daemon; the `dterm: Clear persisted
  layout state for...` commands hit the daemon now. Returns the
  daemon's `cleared` count in the status message.
- `dterm.dumpLayoutState` rewritten to pull from the daemon (via
  `loadLayoutFromDaemon`) and show `layoutCache.selection` + each
  session's label / position. Storage-path inspection dropped --
  it was misleading on Remote-SSH anyway (the API-reported path
  didn't disambiguate the `-N` suffix).

Behavioural improvements:

- Labels propagate across concurrent client windows (writes hit the
  daemon, all attached clients see them via `list`).
- Per-client positions survive workspaceStorage lock-routing
  decisions (clientId is stable per laptop because SecretStorage
  proxies to the local OS keystore; positions are keyed on that, not
  on which `<hash>-N` directory VS Code Server happened to lock-route
  the extension host into).
- Selection memory ditto.

No disk persistence on the daemon side. Layout state lives in memory
only and is lost on daemon restart / explicit `dterm: Restart
daemon` -- intentional, matches scrollback. The underlying daemon
sessions tied to the layout state would be killed by the same daemon
restart anyway, so the layout is irrelevant once they're gone.

---

Docs: split internals out of README into ARCHITECTURE.md.

The README's "Architecture" section had grown into a debug-grade
walkthrough of VS Code internals, lifecycle quirks, and design
trade-offs. Moved it (plus expanded sections on shell-integration
state replay, shell-integration nonce coordination, tab-title
template resolution, and the workspaceState-on-Remote-SSH discovery)
into a dedicated `ARCHITECTURE.md` at repo root, following the
rust-analyzer / [matklad](https://matklad.github.io/2021/02/06/ARCHITECTURE.md.html)
convention. README is now ~85 lines of user-facing intro + install +
features + commands + settings + a single cross-link to
ARCHITECTURE.md for contributors and debuggers. `ARCHITECTURE.md` is
not packaged in the VSIX (added to `.vscodeignore`); it lives only
in the repo.

## 0.9.3

Honour `terminal.integrated.tabs.title` for dterm Pseudoterminals.

Previously dterm's visible tabs always showed the foreground process
name verbatim because we fire Api-source titles via `onDidChangeName`
on every daemon-side `process_name` update, and Api-source titles
bypass VS Code's own `TerminalLabelComputer` (the `staticTitle`
short-circuit kicks in). User customizations to
`terminal.integrated.tabs.title` had no effect on dterm terminals.

Now we resolve the user's template ourselves, every time the inputs
change, and feed the result into the same `nameEmitter`.

- `template()` ported verbatim from VS Code's
  `src/vs/base/common/labels.ts` -- same tokeniser, same segment
  model, same "separator collapses when surrounded by an empty"
  filter rule. Behaviourally identical to VS Code for the variables
  both implementations support.
- `resolveTabTitle()` builds the variable map and applies the post-
  processing VS Code does (strip `\n\r\t`, trim, fall back to
  `${process}` when the resolved string is empty).
- Supported variables: `${process}`, `${cwd}`, `${cwdFolder}`,
  `${workspaceFolder}`, `${workspaceFolderName}`, `${workspace}`
  (alias for `vscode.workspace.name` -- dterm-specific extension,
  stable across multi-root), `${session}` (dterm session id, e.g.
  `vscode-myproject-1` -- dterm-specific), `${sequence}`,
  `${separator}`. Variables that don't apply to dterm Pseudoterminals
  (`${task}`, `${local}`, `${shellType}`, `${shellCommand}`,
  `${shellPromptInput}`, `${progress}`, `${fixedDimensions}`)
  resolve to empty strings so the separator-collapsing rule cleans
  up around them.
- New `dterm.tabTitle` setting (blank by default). When non-empty
  it overrides `terminal.integrated.tabs.title` for dterm terminals
  only -- useful for users who want a different template for dterm
  tabs without disturbing their native-terminal customization.
  Blank means inherit from the VS Code setting.

---

New diagnostics for cross-client label-persistence triage.

- `dterm: Dump persisted layout state (diagnostics)` command opens
  a dedicated output channel with: timestamp, hostname, pid, vs
  vscode.env.machineId, dterm clientId, workspaceTag,
  `vscode.workspace.name`, workspaceFolder paths, the extension's
  storageUri + the deduced workspaceStorage directory (where
  state.vscdb lives), the globalStorageUri, every dterm-relevant
  workspaceState key + value, the live daemon sessions for this
  workspace tag and what getMeta() returns for each, plus the open
  VS Code terminals and their current `t.name`.
- `setLabel` now logs every write to the extension log (session,
  resolved label, target key) so the timeline of rename detection
  + persistence is visible in `dterm: Show extension log`.
- `reconnectAll`'s per-session creation log line now includes
  `meta=<json>` and the resolved `labelKey` so it's possible to
  tell at a glance whether the label round-tripped.

Workflow for diagnosing "renames don't survive cross-client reload":
run the dump command on the writing client just before closing the
window, run it again on the reattaching client right after activation,
diff the outputs. Whichever side is missing the `session.<n>.label`
row reveals where the persistence is breaking.
- `${cwdFolder}` follows VS Code's rule: shown when multi-root OR
  when cwd differs from the primary workspace folder; empty
  otherwise.
- `${sequence}` requires daemon-side capture (xterm-headless
  `onTitleChange`) since the public Pseudoterminal API doesn't expose
  VS Code's parser-side sequence-source title. New protocol message
  `sequence_title` is broadcast on every OSC 0 / OSC 2 emission and
  also sent on each reattach so reattached terminals get the latest
  value immediately.
- Re-fires happen on every input change: `process_name` and
  `sequence_title` from the daemon, `onDidEndTerminalShellExecution`
  for `${cwd}` updates, `onDidChangeTerminalShellIntegration` for the
  initial cwd detection and any state change,
  `onDidChangeConfiguration` for live tabs.title / .separator edits,
  `onDidChangeWorkspaceFolders` for `${workspace}` /
  `${workspaceFolder}` updates.
- Name-locked terminals (user inline-rename or restored saved label)
  bypass the template entirely -- same precedence VS Code's
  `staticTitle` gives the user's explicit choice.

User-visible effect: `terminal.integrated.tabs.title: "${process} -
${cwdFolder}"` works in dterm terminals the same way it does in
native VS Code terminals.

## 0.9.2

Preserve full shell-integration state across reattach via xterm-headless
OSC dispatch.

Previously the daemon scanned the raw pty stream for VS Code's one-shot
`HasRichCommandDetection=True` advertisement and replayed only that
sequence at reattach. Other `OSC 633 ; P ; <Key>=<Value>` properties
(notably `Cwd`) were lost on reattach until the next shell prompt re-
emitted them, so the visible Pseudoterminal's
`Terminal.shellIntegration.cwd` was undefined immediately after reload
even though the daemon-side shell was at a perfectly known cwd.

- Daemon now taps xterm-headless's OSC dispatch via
  `parser.registerOscHandler(633, ...)` -- the same hook VS Code's own
  `shellIntegrationAddon` uses internally. xterm.js handles streaming,
  terminator detection (BEL vs `ESC \`), and payload reassembly across
  arbitrary chunk boundaries; the dterm-specific code is just the
  `P;<Key>=<Value>` split plus a switch over the recognized keys.
- Captured properties: `Cwd`, `PromptType`, `ContinuationPrompt`,
  `Prompt`, `IsWindows`, `HasRichCommandDetection`. Per-session state,
  latest-value-wins.
- On reattach, the daemon prepends a serialized burst of OSC 633 ; P
  sequences to the existing visual snapshot replay. Sent before the
  snapshot so flags that affect downstream parser behaviour (notably
  `HasRichCommandDetection`) are active by the time any subsequent live
  A/B/C/D sequences arrive.
- The old byte-scan-for-`RICH_INTEGRATION_OSC` path and the
  `hasShellIntegration: boolean` session flag are removed -- replaced
  by the structured `shellIntegration: ShellIntegrationState` object.
- Round-trip fidelity: the values are stored as the bytes xterm-headless
  hands back from its parser, so any shell-side escaping inside `Cwd`
  values (the bash script's `__vsc_escape_value_fast` handling of `;`,
  `\\`, `\\x07`) is preserved verbatim and the receiving VS Code parser
  un-escapes the same way it would have originally.

User-visible effect: `Terminal.shellIntegration.cwd` is populated the
moment a reattached terminal is selected, so anything that depends on
it (VS Code's "open file from cwd" actions, extensions reading the
property) just works after reload.

## 0.9.1

Reattach now spawns a single shared bootstrap stub instead of one per
session.

Per-session bootstraps on reattach were doing identical work N times:
each captured the same window-scoped EnvironmentVariableCollection
contributions (most importantly the git extension's current
`VSCODE_GIT_IPC_HANDLE`) and fed them to `refreshManagedSockets`,
which is idempotent. Hoist the bootstrap to the top of `reconnectAll`
so one stub spawn refreshes the symlinks for the entire pass; the
per-session reattach path then just creates the Pseudoterminal and
talks to the daemon, with no bootstrap involvement.

- `DtermPseudoterminal` accepts `bootstrap: Promise<BootstrapResult>
  | undefined`. Undefined means reattach; the constructor skips the
  `bootstrap.then()` handler entirely and marks `bootstrapDone = true`
  immediately.
- `reconnectAll` calls `bootstrapShell` once after the live-sessions
  check, awaits it, and runs `refreshManagedSockets` with the
  captured env. On bootstrap failure, falls back to refreshing from
  `process.env` only (`SSH_AUTH_SOCK` and `VSCODE_IPC_HOOK_CLI` are
  there; `VSCODE_GIT_IPC_HANDLE` stays stale until the next
  successful refresh).
- The per-session `bootstrapShell` call in the reattach loop is gone.
- New-session path is unchanged: it still spawns a per-session
  bootstrap because it actually needs the captured env+argv to send
  in the daemon's `open` message.

For a workspace with N reattached sessions, this saves N-1 bootstrap-
stub spawns through VS Code's terminal pipeline (~30-50 ms each, plus
N-1 hidden Terminal allocations and pty-host channels). Reattach
becomes meaningfully faster for workspaces with several sessions.

---

Also in this release: initial Pseudoterminal name now carries the
tag-encoded session ID for restored-label terminals too.

Previously, restored user labels were set as the initial
`TerminalOptions.name` verbatim (no encoding). `snapshotLabels` then
needed two seconds to detect the missing encoding and re-fire via
`applyUserLabel` to put it back. During that window
`getSessionFromTab` had to fall back to strict label-equality matching
instead of decoding the embedded session id.

Now `buildPseudoOptions` uniformly returns `nameWithSession(label ??
'dterm', sessionName)`. Restored-label terminals carry the encoding
from creation time, so:

- Tab-to-session mapping decodes immediately on the first
  `getSessionFromTab` call -- no fallback needed for the restored-label
  path either.
- `snapshotLabels`' `nameMatchesOurSession` check sees t.name as
  already-ours on the first tick and stays in the no-op branch
  instead of taking the user-rename path.
- The encoding is zero-width, so the visible tab text is unchanged
  from the user's perspective.

The strict-label-equality fallback in `getSessionFromTab` is still
present as a defensive measure for the genuine race between a user
inline-rename and the next snapshot tick.

## 0.9.0

Route `code` CLI through the extension-host CLIServer instead of
the per-terminal one. Eliminates the bootstrap-stub keep-alive
entirely.

VS Code provisions two `VSCODE_IPC_HOOK_CLI` sockets: a per-terminal
one minted in `remoteTerminalChannel.ts` (lifetime = pty), and an
extension-host-wide one minted in `extHostExtensionService.ts`
(lifetime = extension host, set on the extension host's own
`process.env`). dterm previously pointed daemon-side shells at the
per-terminal one, which required holding the bootstrap stub's pty
open for the whole session (the per-terminal CLIServer disposes on
`onProcessExit`). We now point at the extension-host one, which is
already kept alive by VS Code for as long as the window is open and
doesn't require any keep-alive trick on our end.

The receiving handler in VS Code (`remoteTerminalBackend.ts`) uses
the per-terminal `persistentProcessId` only as a liveness gate; the
actual `code <file>` dispatch goes through the window's
`commandService` with no pty-derived context. So losing the per-
terminal scope costs nothing observable; window-routing still works
correctly because each VS Code window has its own extension host
with its own CLIServer.

- `MANAGED_SOCKETS` flags `VSCODE_IPC_HOOK_CLI` with `preferProcessEnv:
  true`. `refreshManagedSockets` now reads its upstream from
  `process.env` (the extension host's CLIServer path) instead of from
  the bootstrap-captured value.
- The bootstrap stub no longer needs to be kept alive. `out/stub.js`
  exits immediately after writing its capture payload, and
  `bootstrapShell` disposes the (already-exited) hidden Terminal as
  soon as the payload arrives. No more `setInterval` heartbeat
  (gone in 0.8.2), no more `exec sleep` trick from the launcher
  (now also gone).
- `out/stub-launcher.sh` is removed. `out/shims/{bash,zsh,fish,dterm}`
  symlink directly to `stub.js` again, the way they did before 0.8.2.
  `postcompile.js` defensively `unlink`s any stale launcher file from
  prior builds.
- `DtermPseudoterminal.close()` no longer disposes any kept-alive
  stub Terminal -- there isn't one. The `BootstrapResult.stub` field
  is gone.
- Per-session keep-alive RSS drops from ~1-2 MB (sleep) to ~0 -- the
  hidden Terminal is fully gone after env capture, with no resident
  process at all.

## 0.8.3

Fix shell-integration command-line trust validation in dterm terminals.

Previously, the visible Pseudoterminal didn't pass a
`shellIntegrationNonce` to `vscode.window.createTerminal`, so VS Code
auto-generated one for the parser side. Meanwhile the daemon-side shell
emitted OSC 633 ; E ; <cmd> ; <nonce> sequences using whatever
`VSCODE_NONCE` was captured from the original bootstrap stub's env (a
different value, generated by VS Code's pty-host for the stub's pty).
Mismatch -> the parser silently classified every command line as
untrusted, so `Terminal.shellIntegration.commandLine.isTrusted` was
always `false` for dterm terminals. Command decorations rendered but
any VS Code UX that conditions behaviour on trust (most notably the
"are you sure?" prompt suppression for shell-integration command
rerun) went to the untrusted branch.

- **New sessions** mint a single `crypto.randomUUID()` per session and
  pass it as both `TerminalOptions.shellIntegrationNonce` on the
  bootstrap stub (VS Code injects it into the stub's env as
  `VSCODE_NONCE`, which the stub captures and forwards to the
  daemon-side shell) and `ExtensionTerminalOptions.shellIntegrationNonce`
  on the visible Pseudoterminal. Both endpoints synchronously agree on
  one value; no env-var rewriting in the daemon `open` payload.
- **Reattach** reads `VSCODE_NONCE` from the daemon's stored session env
  via the existing `get_session_env` protocol message and passes it as
  the Pseudoterminal's `shellIntegrationNonce`. Adds ~one local-Unix-
  socket RTT per reattached session (sub-millisecond), dwarfed by the
  bootstrap-stub spawn cost we already pay.
- On `fetchSessionEnv` failure or missing `VSCODE_NONCE` we fall back to
  letting VS Code auto-generate (the prior broken state) -- no
  regression for sessions where the round-trip fails.

## 0.8.2

Drop per-session keep-alive memory ~25-fold by `exec`ing into `sleep`
after env capture instead of holding a node runtime open.

- The bootstrap stub is now launched via a tiny POSIX shell wrapper
  (`out/stub-launcher.sh`) that runs the node-based env capture and
  then `exec`s into `sleep 2147483647`. The kernel-level PID survives
  the `exec`, so VS Code's pty-host continues to see a single long-
  lived persistent process and the per-terminal `VSCODE_IPC_HOOK_CLI`
  CLIServer stays bound. Cross-reload behaviour is unchanged.
- Per-session keep-alive RSS drops from ~30-50 MB (node + V8) to
  ~1-2 MB (sleep). For workflows with many dterm sessions open at
  once the savings are linear in session count.
- `out/shims/{bash,zsh,fish,dterm}` now symlink to
  `stub-launcher.sh` instead of `stub.js`. Shell-integration
  basename detection is unaffected because VS Code keys on the
  symlink's basename, not its target.
- `out/stub.js` no longer holds a `setInterval` heartbeat; it exits
  cleanly after writing the capture payload. The launcher's `exec
  sleep` takes over keep-alive.
- The launcher propagates the capture-process exit status: if
  `out/stub.js` exits non-zero (e.g. bootstrap socket unreachable),
  the launcher exits with the same status before `exec sleep`, so
  the pty dies the same way it did pre-launcher.

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
