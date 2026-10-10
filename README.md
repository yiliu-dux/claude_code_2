# Claude Lite

Minimal VS Code wrapper around the `claude` CLI (uses your logged-in subscription). Zero dependencies, no build step.

- **Chat tab**: a normal editor tab; responses render as markdown; `Ctrl+F` searches it.
- **Top bar**: Chats, Refresh Models (the list is fetched from the CLI on start), a DeepSeek on/off toggle, a live context-usage bar, 5h/7d rate-limit usage, and Open as .md (the chat's transcript).
- **Tool calls** (Bash, Read, Grep, ...) show their start time in the left margin (like user messages), and the duration once finished, e.g. `Bash ... (done, 3.2s)`.
- **Status line** (under the message box): on the left, only what the agent is doing (e.g. `Running Bash: Run the tests | 12s`, `Agent "Find tests": running Grep: ...`, background tasks still running after a turn). Claude continues on its own when a background task finishes, and the chat shows as busy again. Other messages (setting changes, warnings) appear right-aligned on the same line.
- **Bottom bar**: model / effort / thinking budget / permission mode dropdowns (scroll the mouse wheel over any of them to step through the options) and Send / Stop.
- **Message box**: grows with what you type up to 10 lines; drag the top edge of the bottom panel to make it taller (double-click the edge to reset). The chat follows new output only while you are scrolled to the bottom.
- **Slash commands**: `/btw <question>` (side question, not added to the chat), `/fork` (copy the chat into a new tab), `/rewind` (drop a message and everything after it, and undo the file edits Claude made with Edit/Write since then; changes made through Bash commands are not tracked). Other commands such as `/compact` go to the CLI.
- **File links**: file paths in the output (relative, absolute, `~/`, with optional `:line[:col]` or `#L<line>`) become links that open the file beside the chat at that line. Only files that exist are linked; WSL paths (`/mnt/c/...`, `/home/...`) and Git Bash paths (`/c/...`) are mapped to Windows ones.
- **History**: every chat is saved to `~/.claude-lite/chats/<id>.json` + `<id>.md`. Use `Claude Lite: Open Chat…`, `Search All Chats…`, or open the `.md` directly.

## Install
```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```
Then reload the VS Code window and run **Claude Lite: New Chat** (`Ctrl+Alt+N`).

## How it works
Each chat tab runs one `claude -p --input-format stream-json --output-format stream-json` process in the chat's cwd.
Changing a setting does nothing until you send: if the settings differ from what the running process was started with, the Send button turns into "Send + Restart" and the process is restarted with `--resume <session>` (the conversation carries over; background tasks are killed). The status note shows the setting that was actually in use, e.g. `Model: Opus -> Haiku`, and disappears if you change back.
Thinking budget is passed via `MAX_THINKING_TOKENS`. Set `claudeLite.useWsl` to run claude inside WSL.

On startup the extension compares `claude --version` with the newest published version (npm registry, using the CLI's `autoUpdatesChannel`, `latest` in WSL mode) and warns if it is out of date. It never updates on its own: the warning's **Run claude update** button runs `claude update` in a terminal. Turn the check off with `claudeLite.checkForUpdates`.

Permission prompts can't be answered in this mode: tools that need approval are denied and reported, so pick `auto`, `acceptEdits` or `bypass` in the bottom bar.

## DeepSeek mode

The **DeepSeek** button in the top bar (to the right of Refresh Models) switches the whole window between Anthropic and [DeepSeek's Anthropic-compatible API](https://api-docs.deepseek.com/guides/anthropic_api). It is the `claudeLite.deepseek.enabled` setting and is global: it applies to every chat, not per tab. Switching re-points each open chat's model to that provider's default and shows **Send + Restart**; the running process is replaced, resuming the same session, on the next send.

In DeepSeek mode every `claude` process is started with:

| setting | env var | default |
| --- | --- | --- |
| `claudeLite.deepseek.baseUrl` | `ANTHROPIC_BASE_URL` | `https://api.deepseek.com/anthropic` |
| `claudeLite.deepseek.authToken` | `ANTHROPIC_AUTH_TOKEN` | *(empty - set your DeepSeek key)* |
| the chat's model | `ANTHROPIC_MODEL` | `deepseek-flash[1m]` |
| `claudeLite.deepseek.autoCompactWindow` | `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | `786432` |

The model dropdown then lists `claudeLite.deepseek.models` (comma-separated, default `deepseek-flash[1m]`) and the Refresh Models button becomes **Reload Models**. It works that way because the CLI cannot enumerate DeepSeek's models: asked for its list it replies with Anthropic's built-ins plus your env model echoed back as "Custom model". Edit the setting and press Reload Models to change the choices. A model whose ID already ends in `[1m]` is used as written (no suffix is appended).

The auth token is stored in `settings.json` in plain text (and synced if Settings Sync is on); it is only ever handed to the base URL above. With no model chosen in Claude mode the CLI's own default applies, so if your `~/.claude/settings.json` pins a DeepSeek model, pick a Claude model in the dropdown for Claude mode.

In WSL mode the token and the other DeepSeek vars are forwarded through `WSLENV`. Note that `bash -lc` sources your shell profile, so an `ANTHROPIC_*` exported there would win over what the extension passes.
