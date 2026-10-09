# Claude Lite — notes for agents editing this extension

A lightweight VS Code extension that wraps the `claude` CLI (Claude Code) so the user can chat with their subscription inside a normal editor tab. The extension exists because the official VS Code extension was giving the user trouble; keep this one **small and dependency-free**.

## Files

- `extension.js` - the extension host code. `webviewHtml()` loads the page from `media/` and fills in the CSP source and resource URIs.
- `media/webview.html`, `media/webview.css`, `media/webview.js` - the webview UI (plain files, no templating beyond `{{cspSource}}`, `{{css}}`, `{{js}}`). `install.ps1` lists them explicitly; add new files there.
- `package.json` — manifest: commands, keybinding, `claudeLite.*` settings.
- `install.ps1` — builds the `.vsix` by hand (a zip via .NET, no `vsce`) and runs `code --install-extension --force`.
- `README.md` — user-facing docs. Update it when you change features.

There is **no Node.js on the Windows side**, no `node_modules`, no bundler, no TypeScript. Do not add npm dependencies. If you need a library, find a way to do it with Node built-ins or VS Code APIs (e.g. markdown is rendered with the built-in `markdown.api.render` command).

## Build, install, verify

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1   # then "Developer: Reload Window" in VS Code
```

- Syntax check (Node exists only in WSL):
  `wsl.exe -- bash -lc 'node --check extension.js; node --check media/webview.js'`
- Headless testing: write a throwaway script in the scratchpad/temp dir that stubs `require('vscode')` via `Module._load`, calls `activate()`, grabs a command (e.g. `claudeLite.newChat`) and drives the `ChatSession` by invoking the webview's `onDidReceiveMessage` handler with `{type:'send', text}` etc. Point `claudePath` at `the path to your claude executable` and `chatsDir` at the temp dir, and use `--model haiku`-cheap prompts. This exercises the real CLI end to end. Delete test dirs afterwards.
- You cannot see the webview UI. For layout/CSS changes, say plainly that it was not visually verified.

## Architecture

**One `claude` process per chat tab** (`ChatSession`), long-lived:

```
claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages
       [--model M] [--effort E] [--permission-mode P] [--resume <sessionId> | --resume <forkFrom> --fork-session]
       env MAX_THINKING_TOKENS=<n|0>
```

- `resumeArgs()` decides where a chat continues from (own session, or the fork/rewind source up to `resumeAt`); `start()`, `/btw` and `/fork` all use it. `onJsonLines()` is the one stream-json line reader.
- `spawnClaude(chat, args)` adds the per-chat settings and handles WSL mode (`wsl.exe --cd <cwd> -- bash -lc 'exec claude "$@"'`, passing env through `WSLENV`).
- User turns are written to stdin as `{"type":"user","message":{"role":"user","content":text}}`.
- `handle(ev)` consumes stdout events: `system/init` (session id), `stream_event` (text deltas → throttled re-render), `assistant` (final text / `tool_use` blocks), `user` (`tool_result` → updates the matching tool block), `result` (turn end, `permission_denials`; then a `get_context_usage` request is sent), `control_response` (`ctx` = exact context usage), `rate_limit_event` (5h / 7d utilization). Events with `parent_tool_use_id` (subagents) are ignored on purpose.
- **Changing model/effort/thinking/perms does nothing immediately.** `chat.applied` = the settings the process was last started with (set in `start()`, persisted); `syncPending()` diffs `chat.settings` against it and tells the webview (`pending`) to show "Send + Restart". `send()` kills the process only if they differ (and a process exists); `start()` then respawns with `--resume`. Notes compare against `applied`, not the previous dropdown value, and are cleared when the dropdown returns to the applied value.
- **Stop** sends a stream-json `control_request` `{subtype:"interrupt"}`; hard-kills after 3 s if ignored.
- **Context bar**: exact `totalTokens` / `maxTokens` from the CLI's `get_context_usage` control request, sent on the live process after every turn (`onContextUsage()`). While streaming, `setUsage()` only estimates (`input + cache_creation + cache_read + output` of the latest message) against the last known window; there is no guessed window, so the bar stays empty until the first turn completes.
- **Model list** comes from the CLI itself: `fetchModels()` spawns a process and sends a `control_request` `{subtype:"initialize"}`; the response's `models` array (value, displayName, resolvedModel, supportedEffortLevels…) feeds the dropdown (`fetchModels()` is a `controlRequest()`). **There is deliberately no hardcoded fallback list** — the user wants to see when the fetch fails (button turns into "Models failed - retry", error in tooltip/status). Don't reintroduce one or a cached list.
- `normalizeModel()` maps display names / resolved IDs to CLI values (keeps `[1m]` suffix); `checkDefaults()` / `warnDefaults()` validate the `claudeLite.default*` settings against the fetched list and the UI options, falling back to defaults with a warning.
- **Slash commands handled by the wrapper** (everything else, e.g. `/compact`, is passed to the CLI):
  - `/btw <q>` — one-shot `claude -p --resume <sid> --fork-session --no-session-persistence --tools ""`; answer shown inline, never added to the real session. Allowed while a turn is running.
  - `/fork` — new chat with copied messages and `forkFrom = sessionId`; its first turn uses `--resume <forkFrom> --fork-session`.
  - `/rewind` — truncates `chat.messages`, then the next turn uses `--resume <sid> --fork-session --resume-session-at <resumeAt>`. Files are restored first: every process gets `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=1` (off by default in `-p` mode), each user turn is written to stdin with our own `uuid` (saved on the message), and rewind sends `control_request {subtype:"rewind_files", user_message_id: uuid}` through a short-lived `--resume <sid>` process (`controlRequest()`). Works across restarts and earlier rewinds/forks. Only Edit/Write changes are tracked, not Bash.
- **File links**: `ChatSession.html()` = `render()` + `linkPaths()`, which walks the rendered HTML's text (outside `<a>`) and scheme-less `<a href>`s, and turns paths that `hostPath()` resolves to an existing file into `<a data-file data-line data-col>`. `hostPath()` maps WSL/Git Bash paths to Windows (`/mnt/c`, `/c`, `/home` via `wsl.exe wslpath -w /`, cached) and Windows paths to `/mnt/c` when the host runs on Linux. The webview posts `open` on click.
- **Status line**: left = agent activity only (`agent(text)`; the webview appends the time spent in the current phase while busy), right = everything else (`note(text)`: setting changes, warnings, wrapper errors; cleared on send). Never put non-agent text in `agent()`. Tool calls show `toolLabel()` (`Running Bash: <description>`), subagent events (`parent_tool_use_id`) update only the status line (`onSubagent()`), `system/api_retry` and `system/status` are shown too; otherwise a stuck turn looks frozen. `stop()` and the `result` handler always clear `busy`, so the UI can't stay locked with Send disabled.
- **Background tasks**: a `result` does not mean the agent is finished. `system/background_tasks_changed` keeps `this.bg`; when a task finishes the CLI sends `task_notification` and then starts a new turn by itself (`system/init`, ..., another `result`). `handle()` sets `busy` again when such a turn starts. A pending setting change restarts the process only when the user clicks "Send + Restart", which kills any background tasks.
- Interactive CLI features (permission prompts, `/model` picker, etc.) do not work in `-p` mode. Tools needing approval are denied and reported as an info message.

### Webview protocol (`postMessage`)

- webview → host: `ready`, `send`, `stop`, `setting`, `customModel`, `pickChat`, `refreshModels`, `settings`, `transcript`, `open` (file, line, col)
- host → webview: `init`, `upsert` (idx, role, rendered html), `busy`, `pending` (restart, changes), `ctx`, `agent` (text, since), `note`, `rate`, `setting` (key, value - host-side changes, e.g. model normalized or unsupported effort reset), `models`, `prefill`

Messages are addressed by index in `chat.messages`; `upsert` creates or replaces the element `#m<idx>`.

## Storage

- Default `~/.claude-lite/chats/` (setting `claudeLite.chatsDir`). Per chat: `<id>.json` (source of truth: title, cwd, sessionId, forkFrom, settings, context, messages `{role: user|assistant|tool|info|btw, md}`) and `<id>.md` (regenerated readable transcript, used by Search All Chats).
- Archived chats live in `archive/` under the same dir. Delete removes only these files, never the CLI's own sessions in `~/.claude/projects/`.
- A chat must resume from its original `cwd` and in the same mode (Windows vs WSL), because CLI sessions are stored per project dir and per environment.
- Chat ids use local time: `YYYYMMDD_HHMMSS_xxxx`.

## UI conventions (user preferences — keep them)

- **No emoji or special characters anywhere in UI text** (buttons, status, info messages, transcripts): ASCII only. Use words ("Settings", "(done)", "Error:", "Warning:"), `...` not `…`, `-` not `—`, `|` as separator. No codicons in status bar text either. Exception: QuickPick item buttons (archive/trash/unarchive), which VS Code only allows as icons.
- All corner radii are **5px**.
- Use VS Code theme variables (`--vscode-*`) for every color; dividers use `--vscode-foreground`.
- Top bar (left → right, separated by `.sep` dividers): `Chats` | `Refresh Models` | context group (context bar + 5h/7d usage with "resets in ...") | `Open as .md` | `Settings` (far right). Every top-bar item uses the same 22px height + line-height so text baselines line up — preserve this when adding items. All buttons share one flat style (secondary colors, 22px); selects are 22px too. The log and the bottom panel share one centered column width (`--col`). In the usage text only the `NN%` parts are full foreground color (`.pct`).
- Page layout is a fixed-height flex column: `#top` | `#scroller` (the only scrolling element; wraps `#log`) | `#bottom`. Don't go back to `position: fixed` + padding on the log - that hid the end of long chats behind the bottom panel.
- Bottom bar: one row of dropdowns (model, effort, thinking, perms) with Send/Stop at its right end, above a full-width message box; status line below. The box auto-grows to 10 lines (`autoResize()`); `#grip` on the panel's top edge sets a manual minimum height (the native textarea resize corner is disabled because it can only grow downward).
- Auto-scroll: `stick` is updated on user scroll events; new output and layout changes scroll to the bottom only while `stick` is true.
- Status bar: `ctx NN%` and `5h NN% | resets in ... | 7d ...` (refreshed every minute; usage cached in `globalState`).
- Enter sends, Shift+Enter newline; the tab supports Ctrl+F (`enableFindWidget`).

## Gotchas

- When editing with `sed` from Git Bash, character classes containing multibyte characters (e.g. `[“”]`) match individual bytes and corrupt other UTF-8 text. Prefer the Edit tool for anything non-ASCII.
- The webview script is a plain file now, so regexes need no extra escaping. The page has no host-side `${...}` interpolation; the effort/thinking/perms options come from `CHOICES`/`LABELS` in extension.js via `init` (package.json repeats the values as setting enums).
- Thinking is controlled with `MAX_THINKING_TOKENS` (0 = off); there is no CLI flag for it. Effort uses `--effort low|medium|high|xhigh|max`.
- Check `claude --help` for current flags before relying on new ones; the CLI evolves quickly.
- Bump `version` in `package.json` only if you want a new vsix file name; `install.ps1` uses `--force`, so reinstalling the same version works.
