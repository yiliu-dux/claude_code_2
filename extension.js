// Claude Lite - a thin VS Code wrapper around `claude -p --input-format stream-json`.
const vscode = require('vscode');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const https = require('https');

const cfg = () => vscode.workspace.getConfiguration('claudeLite');
let statusItem;

// ---------- storage: one <id>.json (source of truth) + <id>.md (readable/greppable) per chat ----------

function chatsDir() {
  const d = cfg().get('chatsDir') || path.join(os.homedir(), '.claude-lite', 'chats');
  fs.mkdirSync(d, { recursive: true });
  return d;
}
const chatFile = (id, ext) => path.join(chatsDir(), `${id}.${ext}`);

function newChat() {
  const d = new Date(), p2 = n => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  return {
    id: `${ts}_${crypto.randomBytes(2).toString('hex')}`,
    title: 'New chat',
    cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir(),
    sessionId: null,
    created: Date.now(),
    updated: Date.now(),
    settings: checkDefaults().settings,
    context: null,
    messages: [], // { role: 'user'|'assistant'|'tool'|'info'|'btw', md }
  };
}

function archiveDir() {
  const d = path.join(chatsDir(), 'archive');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function loadChat(id, dir = chatsDir()) {
  return JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));
}

function listChats(dir = chatsDir()) {
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => { try { return loadChat(f.slice(0, -5), dir); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => b.updated - a.updated);
}

function saveChat(chat) {
  chat.updated = Date.now();
  fs.writeFileSync(chatFile(chat.id, 'json'), JSON.stringify(chat, null, 1));
  fs.writeFileSync(chatFile(chat.id, 'md'), toMarkdown(chat));
}

function toMarkdown(chat) {
  const head = `# ${chat.title}\n\n_${new Date(chat.created).toLocaleString()} | cwd \`${chat.cwd}\` | session \`${chat.sessionId || '-'}\`_\n`;
  const body = chat.messages.map(m =>
    m.role === 'user' ? `## You\n\n${m.md}` :
    m.role === 'assistant' ? `## Claude\n\n${m.md}` : m.md);
  return [head, ...body].join('\n\n') + '\n';
}

// ---------- markdown helpers ----------

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const trunc = (s, n) => (s.length > n ? s.slice(0, n) + `\n... (${s.length - n} more chars)` : s);
function fence(lang, s) {
  let t = '```';
  while (s.includes(t)) t += '`';
  return `${t}${lang}\n${s}\n${t}`;
}

async function render(md) {
  try { return await vscode.commands.executeCommand('markdown.api.render', md); }
  catch { return `<pre>${esc(md)}</pre>`; }
}

// ---------- clickable file paths in rendered output ----------

// A path (Windows, UNC, POSIX, ~/, ./ or relative) followed by an optional :line[:col] or #L<line>[C<col>].
const PATH = String.raw`(?:[A-Za-z]:[\\/]|\\\\|~?/|\.{1,2}[\\/])?(?:[\w.@+-]+[\\/])*[\w.@+-]*[\w@+-]`;
const LOC = String.raw`(?::(\d+)(?::(\d+))?|#L(\d+)(?:C(\d+))?)?`;
const PATH_RE = new RegExp(String.raw`(?<![\w/\\.~:-])(${PATH})${LOC}`, 'g');
const HREF_RE = new RegExp(`^(${PATH})${LOC}$`);

let wslCache;
function wslInfo() { // { root: '\\wsl.localhost\<distro>\', home: '/home/<user>' }, or null
  if (wslCache === undefined) try {
    const [root, home] = cp.execFileSync('wsl.exe', ['--', 'sh', '-c', 'wslpath -w /; echo "$HOME"'],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim().split(/\r?\n/);
    wslCache = { root, home };
  } catch { wslCache = null; }
  return wslCache;
}

// Maps a path as the agent wrote it to an existing file this extension host can open, else null.
// Covers Windows, Git Bash (/c/...), WSL (/mnt/c/..., /home/... via \\wsl.localhost) and Windows paths seen from Linux.
function hostPath(p, cwd) {
  if (process.platform !== 'win32') {
    const m = /^([a-z]):[\\/](.*)/i.exec(p);
    if (m) p = `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
    else if (p.startsWith('~')) p = os.homedir() + p.slice(1);
  } else {
    const useWsl = cfg().get('useWsl'), drive = (useWsl ? /^\/mnt\/([a-z])(?=\/|$)/i : /^\/(?:mnt\/)?([a-z])(?=\/|$)/i).exec(p);
    if (drive) p = `${drive[1]}:${p.slice(drive[0].length) || '/'}`;
    else if (useWsl && /^[~/]/.test(p)) {
      const w = wslInfo();
      if (!w) return null;
      p = path.join(w.root, p.startsWith('~') ? w.home + p.slice(1) : p);
    } else if (p.startsWith('~')) p = os.homedir() + p.slice(1);
  }
  const abs = path.resolve(cwd, p);
  return fs.statSync(abs, { throwIfNoEntry: false })?.isFile() ? abs : null;
}

// Turns file paths in rendered HTML (text and scheme-less <a href>s) into links the webview opens via `open`.
function linkPaths(html, cwd) {
  const attrs = (p, l1, c1, l2, c2) => {
    const file = hostPath(p, cwd);
    return file && `data-file="${esc(file)}" data-line="${l1 || l2 || ''}" data-col="${c1 || c2 || ''}" title="${esc(file)}"`;
  };
  let inLink = false;
  return html.split(/(<[^>]*>)/).map((s, i) => {
    if (i % 2) { // tag
      if (/^<\/a>/i.test(s)) inLink = false;
      if (!/^<a\b/i.test(s)) return s;
      inLink = true;
      const href = /\bhref="([^"]*)"/.exec(s)?.[1];
      if (!href || /^[a-z][\w+.-]+:/i.test(href)) return s;
      let m;
      try { m = HREF_RE.exec(decodeURIComponent(href)); } catch { return s; }
      const a = m && attrs(...m.slice(1));
      return a ? `<a ${a}>` : s;
    }
    if (inLink) return s;
    return s.replace(PATH_RE, (all, ...g) => {
      if (!/[\\/.]/.test(g[0])) return all; // plain words: not worth a filesystem check
      const a = attrs(...g.slice(0, 5));
      return a ? `<a ${a}>${all}</a>` : all;
    });
  }).join('');
}

function toolMd(block, result, isErr) {
  const i = block.input || {};
  const sum = String(i.command || i.file_path || i.pattern || i.url || i.query || i.description || i.prompt || '').split('\n')[0];
  let body;
  if (i.old_string != null && i.new_string != null) {
    const pre = (s, p) => s.split('\n').map(l => p + l).join('\n');
    body = fence('diff', trunc(pre(i.old_string, '- ') + '\n' + pre(i.new_string, '+ '), 4000));
  } else if (i.command) body = fence('sh', i.command);
  else if (i.content != null) body = fence('', trunc(String(i.content), 4000));
  else body = fence('json', trunc(JSON.stringify(i, null, 2), 4000));
  const mark = result == null ? ' (running)' : isErr ? ' (error)' : ' (done)';
  let md = `<details><summary><b>${esc(block.name)}</b> <code>${esc(sum.slice(0, 100))}</code>${mark}</summary>\n\n${body}\n`;
  if (result != null) md += `\n**${isErr ? 'Error' : 'Result'}**\n\n${fence('', trunc(result, 3000))}\n`;
  return md + '\n</details>';
}

const resultText = c => typeof c === 'string' ? c
  : Array.isArray(c) ? c.map(x => (x.type === 'text' ? x.text : `[${x.type}]`)).join('\n') : '';

// ---------- spawning claude (Windows or WSL) with the chat's model settings ----------

const STREAM_ARGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];

function spawnClaude(chat, args) {
  const c = cfg(), s = chat.settings;
  args = [...args];
  if (s.model) args.push('--model', s.model);
  if (s.effort) args.push('--effort', s.effort);
  if (s.permissionMode) args.push('--permission-mode', s.permissionMode);
  args.push(...c.get('extraArgs'));

  // File checkpointing is off by default in -p mode; /rewind needs it to restore files via `rewind_files`.
  const env = { ...process.env, CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: '1' };
  if (s.thinking === 'off') env.MAX_THINKING_TOKENS = '0';
  else if (/^\d+$/.test(s.thinking || '')) env.MAX_THINKING_TOKENS = s.thinking;

  let cmd = c.get('claudePath') || 'claude', cwd = chat.cwd;
  if (c.get('useWsl')) {
    args = ['--cd', cwd, '--', 'bash', '-lc', 'exec claude "$@"', 'claude', ...args];
    cmd = 'wsl.exe';
    cwd = undefined;
    env.WSLENV = [env.WSLENV, 'MAX_THINKING_TOKENS', 'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING'].filter(Boolean).join(':');
  }
  const p = cp.spawn(cmd, args, { cwd, env, windowsHide: true });
  p.stdout.setEncoding('utf8'); // decodes multi-byte characters split across chunks
  p.stderr.setEncoding('utf8');
  p.stdin.on('error', () => { /* process gone; reported by its 'error' / 'close' handlers */ });
  return p;
}

// Calls onEvent for each JSON line of a stream; other lines are skipped.
function onJsonLines(stream, onEvent) {
  let buf = '';
  stream.on('data', d => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      onEvent(ev);
    }
  });
}

// One stream-json control request against a short-lived process; resolves to the response payload or throws.
function controlRequest(chat, args, request, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const p = spawnClaude(chat, [...STREAM_ARGS, ...args]);
    let errTail = '';
    const done = (err, res) => { clearTimeout(timer); try { p.kill(); } catch { /* gone */ } err ? reject(new Error(err)) : resolve(res); };
    const timer = setTimeout(() => done(`timed out after ${timeoutMs / 1000}s`), timeoutMs);
    p.stderr.on('data', d => { errTail = (errTail + d).slice(-500); });
    onJsonLines(p.stdout, ev => {
      if (ev.type !== 'control_response' || ev.response?.request_id !== 'req') return;
      if (ev.response.subtype === 'error') done(ev.response.error || 'error');
      else done(null, ev.response.response || {});
    });
    p.on('error', e => done(`could not start claude: ${e.message}`));
    p.on('close', code => done(`claude exited (code ${code}) ${errTail.trim()}`.trim()));
    p.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'req', request }) + '\n');
  });
}

// ---------- model list: asked from the CLI itself (same data as its /model picker) ----------

// No fallback list on purpose: if the fetch fails the UI says so.
let models = { state: 'loading', list: [], error: '' }, modelFetch = null;

// Maps an alias / ID / display name ("Opus 5.5") to the CLI's value. ok=null means "can't tell yet".
function normalizeModel(v) {
  v = (v || '').trim();
  if (!v) return { value: '', ok: true, info: models.list.find(x => x.value === 'default') };
  if (models.state !== 'ok') return { value: v, ok: null };
  const base = v.replace(/\[1m\]$/i, ''), suffix = v.slice(base.length).toLowerCase();
  const eq = s => s && s.toLowerCase() === base.toLowerCase();
  const m = models.list.find(x => eq(x.value)) || models.list.find(x => eq(x.displayName));
  if (m) return { value: m.value === 'default' ? '' : m.value + suffix, ok: true, info: m };
  // A pinned full ID (e.g. claude-opus-5-5) stays pinned rather than becoming a floating alias.
  const r = models.list.find(x => eq(x.resolvedModel));
  return r ? { value: r.resolvedModel + suffix, ok: true, info: r } : { value: v, ok: false };
}
const supportsEffort = (info, level) => !!info.supportsEffort && (!info.supportedEffortLevels || info.supportedEffortLevels.includes(level));

function postModels(target) {
  for (const s of target ? [target] : ChatSession.sessions.values()) s.post({ type: 'models', ...models });
}

// Fetched on every activation and on "Refresh Models"; resolves to the list, or null on failure.
function fetchModels() {
  if (modelFetch) return modelFetch;
  models = { ...models, state: 'loading', error: '' };
  postModels();
  return modelFetch = (async () => {
    try {
      const r = await controlRequest({ cwd: os.homedir(), settings: {} }, [], { subtype: 'initialize' });
      if (!r.models?.length) throw new Error('CLI returned no models');
      models = { state: 'ok', list: r.models, error: '' };
    } catch (e) {
      models = { state: 'error', list: [], error: e.message };
    }
    modelFetch = null;
    postModels();
    if (models.state !== 'ok') return null;
    // Fix up chats whose settings were made before the list was known (e.g. "Opus 5.5" -> "opus").
    for (const s of ChatSession.sessions.values()) {
      const m = normalizeModel(s.chat.settings.model), renamed = m.ok && m.value !== s.chat.settings.model;
      if (m.ok === false) s.status(`Warning: model "${s.chat.settings.model}" isn't in the CLI's model list`);
      if (renamed) s.chat.settings.model = m.value;
      const effortFix = s.checkEffort();
      if (effortFix) s.status(effortFix);
      if (renamed || effortFix) saveChat(s.chat);
      s.post({ type: 'setting', key: 'model', value: s.chat.settings.model });
    }
    warnDefaults();
    return models.list;
  })();
}

// ---------- validating user defaults against what the CLI / this UI actually support ----------

// Dropdown values (the first one is the fallback for an invalid default) and their labels where they differ.
// package.json repeats the values as the enums of the claudeLite.default* settings.
const CHOICES = {
  effort: ['', 'low', 'medium', 'high', 'xhigh', 'max'],
  thinking: ['default', 'off', '4000', '16000', '32000', '64000'],
  permissionMode: ['auto', 'acceptEdits', 'manual', 'dontAsk', 'plan', 'bypassPermissions'],
};
const LABELS = { '': 'default', 4000: '4k', 16000: '16k', 32000: '32k', 64000: '64k', bypassPermissions: 'bypass' };
const label = v => LABELS[v] ?? v;
const OPTIONS = Object.fromEntries(Object.entries(CHOICES).map(([k, vs]) => [k, vs.map(v => [v, label(v)])]));
const SETTING_NAMES = { model: 'Model', effort: 'Effort', thinking: 'Thinking', permissionMode: 'Permissions' };

// Returns sanitized defaults plus a list of problems (invalid values fall back to the CLI default).
function checkDefaults() {
  const c = cfg(), problems = [];
  const s = { model: c.get('defaultModel'), effort: c.get('defaultEffort'), thinking: c.get('defaultThinking'), permissionMode: c.get('defaultPermissionMode') };
  const m = normalizeModel(s.model);
  if (m.ok === false) { problems.push(`Default model "${s.model}" isn't in the CLI's model list`); s.model = ''; }
  else s.model = m.value;
  for (const [k, list] of Object.entries(CHOICES)) {
    if (!list.includes(s[k] ?? '')) { problems.push(`Default ${k} "${s[k]}" isn't one of: ${list.filter(Boolean).join(', ')}`); s[k] = list[0]; }
  }
  if (s.effort && m.info && !supportsEffort(m.info, s.effort)) {
    problems.push(`${m.info.displayName} doesn't support effort "${s.effort}"`);
    s.effort = '';
  }
  return { settings: s, problems };
}

async function warnDefaults() {
  const { problems } = checkDefaults();
  if (!problems.length) return;
  const pick = await vscode.window.showWarningMessage(`Claude Lite: ${problems.join('; ')}. Using the CLI default instead.`, 'Open Settings');
  if (pick) vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local.claude-lite');
}

// ---------- CLI update check (check only; `claude update` itself installs, so it only runs when the user clicks) ----------

function claudeCmd(cliArgs) {
  return cfg().get('useWsl')
    ? ['wsl.exe', ['--', 'bash', '-lc', 'exec claude "$@"', 'claude', ...cliArgs]]
    : [cfg().get('claudePath') || 'claude', cliArgs];
}

function installedVersion() {
  const [cmd, args] = claudeCmd(['--version']);
  return new Promise((resolve, reject) => cp.execFile(cmd, args, { windowsHide: true, timeout: 30_000 }, (err, out) => {
    const v = /\d+\.\d+\.\d+/.exec(out || '');
    if (v) resolve(v[0]); else reject(err || new Error(`unexpected output: ${out}`));
  }));
}

// The CLI's update channel ("latest" or "stable"); only readable from the Windows-side settings file.
function updateChannel() {
  if (cfg().get('useWsl')) return 'latest';
  try {
    const ch = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8')).autoUpdatesChannel;
    return ch === 'stable' ? 'stable' : 'latest';
  } catch { return 'latest'; }
}

function publishedVersion(channel) {
  return new Promise((resolve, reject) => {
    const req = https.get('https://registry.npmjs.org/-/package/@anthropic-ai/claude-code/dist-tags', { timeout: 15_000 }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          const v = JSON.parse(body)[channel];
          if (v) resolve(v); else reject(new Error(`no "${channel}" version in registry response`));
        } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('registry request timed out')));
    req.on('error', reject);
  });
}

const olderThan = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
};

async function checkForUpdate() {
  if (!cfg().get('checkForUpdates')) return;
  const channel = updateChannel();
  let have, want;
  try {
    [have, want] = await Promise.all([installedVersion(), publishedVersion(channel)]);
  } catch (e) {
    console.warn(`Claude Lite: update check failed - ${e.message}`);
    return;
  }
  if (!olderThan(have, want)) return;
  const pick = await vscode.window.showWarningMessage(
    `Claude Lite: Claude Code ${have} is out of date (${channel}: ${want}).`, 'Run claude update', 'Disable Check');
  if (pick === 'Run claude update') {
    const [cmd, args] = claudeCmd(['update']);
    const term = vscode.window.createTerminal({ name: 'claude update', shellPath: cmd, shellArgs: args });
    term.show();
  } else if (pick === 'Disable Check') {
    cfg().update('checkForUpdates', false, vscode.ConfigurationTarget.Global);
  }
}

// ---------- 5h / weekly usage (account-wide, so it lives in the status bar) ----------

let usageItem, globalState, lastUsage;

function relIn(resetsAt) {
  const m = Math.max(0, Math.round((resetsAt * 1000 - Date.now()) / 60000));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m % 60}m` : `${m}m`;
}

// Re-renders the usage everywhere (status bar + every chat tab). Called on new data and every minute.
function showUsage(w) {
  if (w) lastUsage = w;
  if (!lastUsage || !usageItem) return;
  const parts = [['5h', lastUsage.five_hour], ['7d', lastUsage.seven_day]].map(([k, x]) =>
    !x ? `${k} ?` :
    x.resetsAt && x.resetsAt * 1000 <= Date.now() ? `${k} 0% (reset)` :
    `${k} ${Math.round(x.utilization * 100)}% (resets in ${x.resetsAt ? relIn(x.resetsAt) : '?'})`);
  const text = parts.join(' | ');
  const at = x => (x?.resetsAt ? new Date(x.resetsAt * 1000).toLocaleString() : '?');
  const title = `Claude plan usage (updated after each turn)\n5-hour window resets ${at(lastUsage.five_hour)}\nWeekly window resets ${at(lastUsage.seven_day)}`;
  usageItem.text = text;
  usageItem.tooltip = title;
  usageItem.show();
  for (const s of ChatSession.sessions.values()) s.post({ type: 'rate', text, title });
}

// ---------- a chat tab bound to one claude process ----------

class ChatSession {
  static sessions = new Map(); // chatId -> ChatSession
  static active = null;

  static open(chat, panel) {
    const existing = ChatSession.sessions.get(chat.id);
    if (existing && !panel) { existing.panel.reveal(); return existing; }
    panel ??= vscode.window.createWebviewPanel('claudeLite.chat', chat.title, vscode.ViewColumn.Active,
      { ...webviewOptions(), enableFindWidget: true, retainContextWhenHidden: true });
    const s = new ChatSession(chat, panel);
    ChatSession.sessions.set(chat.id, s);
    return s;
  }

  constructor(chat, panel) {
    this.chat = chat;
    this.panel = panel;
    panel.iconPath = vscode.Uri.file(path.join(__dirname, 'icon.png'));
    this.proc = null;
    this.busy = false;
    this.streamIdx = null;
    this.tools = new Map(); // tool_use_id -> { idx, block }
    this.renderTimers = new Map();
    this.renderSeq = new Map(); // idx -> latest render request, so a slow older render can't overwrite a newer one
    this.disposed = false;
    panel.title = chat.title;
    panel.webview.options = webviewOptions();
    panel.webview.html = webviewHtml(panel.webview);
    panel.webview.onDidReceiveMessage(m => this.onMessage(m));
    panel.onDidChangeViewState(() => { if (panel.active) { ChatSession.active = this; this.updateStatusBar(); } });
    panel.onDidDispose(() => {
      this.disposed = true; // late async work (/btw answers, file restores) must not save or post anymore
      this.kill();
      ChatSession.sessions.delete(chat.id);
      if (ChatSession.active === this) { ChatSession.active = null; statusItem.hide(); }
    });
    if (panel.active || !ChatSession.active) ChatSession.active = this; // restored background tabs don't take over
  }

  post(m) { if (!this.disposed) this.panel.webview.postMessage(m); }
  status(text) { this.post({ type: 'status', text }); }
  async html(md) { return linkPaths(await render(md), this.chat.cwd); }

  async onMessage(m) {
    switch (m.type) {
      case 'ready': {
        const messages = await Promise.all(this.chat.messages.map(async (msg, idx) => ({ idx, role: msg.role, html: await this.html(msg.md) })));
        this.post({ type: 'init', chatId: this.chat.id, settings: this.chat.settings, options: OPTIONS, messages, busy: this.busy });
        this.postContext();
        showUsage();
        postModels(this);
        break;
      }
      case 'pickChat': vscode.commands.executeCommand('claudeLite.openChat'); break;
      case 'refreshModels': fetchModels(); break;
      case 'settings': vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local.claude-lite'); break;
      case 'send': this.send(m.text); break;
      case 'stop': this.stop(); break;
      case 'setting': this.applySetting(m.key, m.value); break;
      case 'customModel': {
        const v = await vscode.window.showInputBox({ prompt: 'Model alias or full ID', value: this.chat.settings.model || '', placeHolder: 'e.g. claude-opus-5-5 or opus[1m]' });
        if (v === undefined) break;
        const m = normalizeModel(v);
        this.post({ type: 'setting', key: 'model', value: m.value });
        this.applySetting('model', m.value);
        if (m.ok === false) this.status(`Warning: "${m.value}" isn't in the CLI's model list - the next message may fail`);
        break;
      }
      case 'transcript': openTranscript(this.chat); break;
      case 'open': {
        const pos = new vscode.Position(Math.max(0, m.line - 1), Math.max(0, m.col - 1));
        vscode.commands.executeCommand('vscode.open', vscode.Uri.file(m.file), { viewColumn: vscode.ViewColumn.Beside, selection: new vscode.Range(pos, pos) })
          .then(undefined, e => this.status(`Error: could not open ${m.file}: ${e.message}`));
        break;
      }
    }
  }

  applySetting(key, value) {
    this.chat.settings[key] = value;
    const effortFix = key === 'model' ? this.checkEffort() : '';
    saveChat(this.chat);
    // Model/effort/etc are CLI flags: restart the process (it resumes the same session) on the next turn.
    if (this.busy) this.pendingRestart = true; else this.kill();
    this.status(`${SETTING_NAMES[key]} -> ${label(value)} (applies to next message)${effortFix ? ' | ' + effortFix : ''}`);
  }

  // Resets an effort level the chat's model doesn't support; returns a note for the status line, or ''.
  checkEffort() {
    const { model, effort } = this.chat.settings, info = normalizeModel(model).info;
    if (!effort || !info || supportsEffort(info, effort)) return '';
    this.chat.settings.effort = '';
    this.post({ type: 'setting', key: 'effort', value: '' });
    return `${info.displayName} doesn't support effort ${effort} - reset to default`;
  }

  push(msg) {
    const idx = this.chat.messages.push(msg) - 1;
    this.upsert(idx);
    return idx;
  }

  async upsert(idx) {
    const m = this.chat.messages[idx];
    if (!m) return;
    const seq = (this.renderSeq.get(idx) || 0) + 1;
    this.renderSeq.set(idx, seq);
    const html = await this.html(m.md);
    if (this.renderSeq.get(idx) === seq) this.post({ type: 'upsert', idx, role: m.role, html });
  }

  scheduleUpsert(idx) {
    if (this.renderTimers.has(idx)) return;
    this.renderTimers.set(idx, setTimeout(() => { this.renderTimers.delete(idx); this.upsert(idx); }, 120));
  }

  setBusy(b) { this.busy = b; this.post({ type: 'busy', busy: b }); }

  send(text) {
    text = text.trim();
    // Slash commands the CLI's print mode doesn't support are emulated here.
    const slash = text.match(/^\/(btw|fork|rewind)\b\s*([\s\S]*)$/);
    if (slash?.[1] === 'btw') return slash[2] ? this.btw(slash[2]) : this.status('Usage: /btw <question>');
    if (slash?.[1] === 'fork') return this.fork();
    if (slash?.[1] === 'rewind') return this.rewind();
    if (!text || this.busy) return;
    if (this.chat.title === 'New chat') {
      this.chat.title = text.replace(/\s+/g, ' ').slice(0, 60);
      this.panel.title = this.chat.title;
    }
    // uuid = the CLI's file-checkpoint key for this turn (used by /rewind to restore files).
    const uuid = crypto.randomUUID();
    this.push({ role: 'user', md: text, uuid, resumeAt: this.chat.lastUuid || null });
    saveChat(this.chat);
    if (!this.proc) this.start();
    if (!this.proc) return;
    this.setBusy(true);
    this.status('Sending...');
    this.proc.stdin.write(JSON.stringify({ type: 'user', uuid, message: { role: 'user', content: text } }) + '\n');
  }

  // Side question: a throwaway, tool-less fork of the session. Never touches the main conversation.
  btw(question) {
    const resume = this.resumeArgs(true);
    if (!resume) return this.push({ role: 'info', md: '> /btw needs an existing conversation - send a message first.' });
    const head = `**btw:** ${question}`, msg = { role: 'btw', md: `${head}\n\n_Thinking..._` };
    this.push(msg);
    const p = spawnClaude(this.chat, ['-p', ...resume, '--no-session-persistence', '--tools', '', '--output-format', 'json']);
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err = (err + d).slice(-2000); });
    p.on('error', e => { err = e.message; });
    p.on('close', () => {
      // Found by identity: a /rewind meanwhile may have removed it or shifted the indexes.
      const idx = this.chat.messages.indexOf(msg);
      if (idx < 0 || this.disposed) return;
      let answer;
      try { answer = JSON.parse(out).result; } catch { answer = `/btw failed\n\n${fence('', (err || out).trim() || '(no output)')}`; }
      msg.md = `${head}\n\n${answer}`;
      this.upsert(idx);
      saveChat(this.chat);
    });
    p.stdin.end(`(Side question - answer briefly from the conversation so far; do not use tools.)\n\n${question}`);
  }

  // Rewind: drop a user message and everything after it. The CLI session is resumed (as a fork) only up to the
  // last assistant message before it. Files changed by Edit/Write since that message are restored through the
  // CLI's file checkpoints (changes made via Bash are not tracked).
  async rewind() {
    if (this.busy) return this.status('Wait for the current turn to finish before rewinding');
    const users = this.chat.messages.map((m, idx) => ({ m, idx })).filter(x => x.m.role === 'user');
    if (!users.length) return this.status('Nothing to rewind');
    const pick = await vscode.window.showQuickPick(users.reverse().map(({ m, idx }) => ({
      label: m.md.replace(/\s+/g, ' ').slice(0, 80),
      description: m.resumeAt === undefined ? 'cannot rewind (saved before /rewind support)' : '',
      idx,
    })), { placeHolder: 'Rewind the conversation and Claude\'s file edits (Edit/Write) to just before this message' });
    if (!pick || this.busy) return;
    const target = this.chat.messages[pick.idx];
    if (target.resumeAt === undefined) return this.status('This message predates /rewind support');
    this.kill();
    const sid = this.chat.sessionId || this.chat.forkFrom;
    let files = 'Files were not restored (message saved before file rewind support).';
    if (target.uuid && sid) {
      this.status('Restoring files...');
      this.restoring = true; // Stop is ignored meanwhile: unlocking the UI here would allow sending mid-rewind
      this.setBusy(true);
      try {
        const r = await controlRequest(this.chat, ['--resume', sid], { subtype: 'rewind_files', user_message_id: target.uuid });
        files = r.error ? `Warning: files partly restored: ${r.error}` : 'Files edited since then were restored.';
      } catch (e) {
        files = `Warning: files were not restored: ${e.message}`;
      }
      this.restoring = false;
      this.setBusy(false);
      this.status('');
      if (this.disposed) return; // tab closed (or chat deleted) meanwhile
    }
    this.chat.messages.length = pick.idx;
    this.chat.messages.push({ role: 'info', md: `> Rewound to before: "${target.md.replace(/\s+/g, ' ').slice(0, 60)}"\n>\n> ${files}` });
    this.chat.lastUuid = target.resumeAt;
    this.chat.sessionId = null;
    this.chat.forkFrom = target.resumeAt ? sid : null;
    this.chat.resumeAt = target.resumeAt;
    this.chat.context = null;
    this.tools.clear();
    this.streamIdx = null;
    saveChat(this.chat);
    await this.onMessage({ type: 'ready' });
    this.post({ type: 'prefill', text: target.md });
  }

  // Fork: new chat tab whose first turn resumes this session with --fork-session.
  fork() {
    if (this.busy) return this.status('Wait for the current turn to finish before forking');
    if (!this.resumeArgs()) return this.push({ role: 'info', md: '> /fork needs an existing conversation - send a message first.' });
    saveChat(this.chat);
    const c = this.chat, f = Object.assign(newChat(), {
      title: `Fork: ${c.title}`.slice(0, 70),
      cwd: c.cwd,
      settings: { ...c.settings },
      context: c.context && { ...c.context },
      // Not sent anything yet (fresh fork / after a rewind)? Then fork from the same point this chat would.
      forkFrom: c.sessionId || c.forkFrom,
      resumeAt: c.sessionId ? null : c.resumeAt,
      lastUuid: c.lastUuid,
      messages: [...JSON.parse(JSON.stringify(c.messages)), { role: 'info', md: `> Forked from "${c.title}"` }],
    });
    saveChat(f);
    ChatSession.open(f);
  }

  // Where this chat's conversation continues from: its own session, or (before its first turn) the session it was
  // forked/rewound from, up to resumeAt. null = new conversation. fork=true never writes to an existing session.
  resumeArgs(fork = false) {
    const c = this.chat;
    if (c.sessionId) return ['--resume', c.sessionId, ...(fork ? ['--fork-session'] : [])];
    if (!c.forkFrom) return null;
    return ['--resume', c.forkFrom, '--fork-session', ...(c.resumeAt ? ['--resume-session-at', c.resumeAt] : [])];
  }

  start() {
    const p = spawnClaude(this.chat, [...STREAM_ARGS, '--include-partial-messages', ...(this.resumeArgs() || [])]);
    this.proc = p;
    const cmd = cfg().get('useWsl') ? 'wsl.exe' : cfg().get('claudePath') || 'claude';
    let errTail = '';
    onJsonLines(p.stdout, ev => { try { this.handle(ev); } catch (e) { console.error('[claude-lite]', e); } });
    p.stderr.on('data', d => { errTail = (errTail + d).slice(-3000); });
    p.on('error', err => {
      if (this.proc !== p) return;
      this.proc = null;
      this.push({ role: 'info', md: `> **Error:** Failed to start \`${cmd}\`: ${err.message}` });
      this.setBusy(false);
    });
    // 'close' (not 'exit'): fires only after stdout is drained, so a final result event is handled first.
    p.on('close', code => {
      if (this.proc !== p) return; // intentional kill
      this.proc = null;
      if (this.busy) {
        this.push({ role: 'info', md: `> **Error:** claude exited (code ${code})\n\n${fence('', errTail.trim() || '(no stderr)')}` });
        this.setBusy(false);
        saveChat(this.chat);
      }
    });
  }

  kill() {
    const p = this.proc;
    this.proc = null;
    if (p) try { p.kill(); } catch { /* already gone */ }
  }

  stop() {
    if (!this.busy || this.restoring) return;
    if (!this.proc) return this.setBusy(false); // nothing left to interrupt - never leave the UI locked
    this.interrupted = true;
    this.proc.stdin.write(JSON.stringify({ type: 'control_request', request_id: `int_${Date.now()}`, request: { subtype: 'interrupt' } }) + '\n');
    const p = this.proc;
    setTimeout(() => { // hard fallback if the interrupt is ignored
      if (this.busy && this.proc === p) {
        this.kill();
        this.interrupted = false;
        this.push({ role: 'info', md: '> Stopped' });
        this.setBusy(false);
        saveChat(this.chat);
      }
    }, 3000);
  }

  handle(ev) {
    if (ev.parent_tool_use_id) return; // subagent traffic - keep the main transcript clean
    switch (ev.type) {
      case 'system':
        if (ev.subtype === 'init') { this.chat.sessionId = ev.session_id; this.status(`${ev.model} | ${ev.permissionMode || ''}`); }
        else if (ev.subtype === 'status' && ev.status) this.status(ev.status);
        else if (ev.subtype === 'compact_boundary') this.push({ role: 'info', md: '> Context compacted' });
        else if (ev.subtype === 'api_retry') {
          const why = ev.error_status ? `${ev.error_status} ${ev.error || ''}` : (ev.error || 'no response');
          this.status(`API error (${String(why).trim()}) - retry ${ev.attempt}/${ev.max_retries} in ${Math.round((ev.retry_delay_ms || 0) / 1000)}s | Stop to give up`);
        }
        break;
      case 'rate_limit_event': {
        const w = ev.rate_limit_info?.unifiedWindows;
        if (w) { globalState?.update('usage', w); showUsage(w); }
        break;
      }
      case 'stream_event': this.onStream(ev.event); break;
      case 'assistant':
        if (ev.uuid) this.chat.lastUuid = ev.uuid;
        this.onAssistant(ev.message);
        break;
      case 'user': this.onToolResults(ev.message); break;
      case 'result':
        try { this.onResult(ev); } finally { if (this.busy) this.setBusy(false); } // the turn is over no matter what
        break;
    }
  }

  onStream(e) {
    switch (e.type) {
      case 'message_start': this.setUsage(e.message.usage, e.message.model); break;
      case 'message_delta': this.setUsage(e.usage); break;
      case 'content_block_start': {
        const b = e.content_block;
        if (b.type === 'text') { this.streamIdx = this.push({ role: 'assistant', md: '' }); this.status('Writing...'); }
        else if (b.type === 'thinking') this.status('Thinking...');
        else if (b.type === 'tool_use') this.status(`Running ${b.name}...`);
        break;
      }
      case 'content_block_delta':
        if (e.delta.type === 'text_delta' && this.streamIdx != null) {
          this.chat.messages[this.streamIdx].md += e.delta.text;
          this.scheduleUpsert(this.streamIdx);
        }
        break;
    }
  }

  onAssistant(msg) {
    for (const b of msg.content || []) {
      if (b.type === 'text') {
        if (this.streamIdx != null) {
          this.chat.messages[this.streamIdx].md = b.text;
          this.upsert(this.streamIdx);
          this.streamIdx = null;
        } else this.push({ role: 'assistant', md: b.text });
      } else if (b.type === 'tool_use') {
        this.tools.set(b.id, { idx: this.push({ role: 'tool', md: toolMd(b) }), block: b });
      }
    }
  }

  onToolResults(msg) {
    if (!Array.isArray(msg.content)) return;
    for (const b of msg.content) {
      const t = b.type === 'tool_result' && this.tools.get(b.tool_use_id);
      if (!t) continue;
      this.chat.messages[t.idx].md = toolMd(t.block, resultText(b.content), b.is_error);
      this.upsert(t.idx);
    }
  }

  onResult(ev) {
    const windows = Object.values(ev.modelUsage || {}).map(u => u.contextWindow).filter(Boolean);
    if (windows.length && this.chat.context) { this.chat.context.window = Math.max(...windows); this.postContext(); }
    if (this.interrupted) {
      this.interrupted = false;
      this.push({ role: 'info', md: '> Interrupted' });
    } else if (ev.is_error || (ev.subtype && ev.subtype !== 'success')) {
      this.push({ role: 'info', md: `> **Error:** ${ev.subtype}: ${ev.result || (ev.errors || []).join('; ') || 'error'}` });
    }
    if (ev.permission_denials?.length) {
      const names = [...new Set(ev.permission_denials.map(d => d.tool_name))].join(', ');
      this.push({ role: 'info', md: `> Permission denied for: **${names}** - change the permission mode (bottom bar) and ask again.` });
    }
    this.status(`Done | ${((ev.duration_ms || 0) / 1000).toFixed(1)}s | ${ev.num_turns ?? '?'} turns`);
    this.streamIdx = null;
    this.setBusy(false);
    saveChat(this.chat);
    if (this.pendingRestart) { this.pendingRestart = false; this.kill(); }
  }

  setUsage(u, model) {
    if (!u) return;
    const used = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0);
    const guess = /\[1m\]/i.test(this.chat.settings.model || '') ? 1_000_000 : 200_000;
    this.chat.context = { used, window: this.chat.context?.window || guess, model: model || this.chat.context?.model };
    this.postContext();
  }

  postContext() {
    if (this.chat.context) this.post({ type: 'ctx', ...this.chat.context });
    this.updateStatusBar();
  }

  updateStatusBar() {
    if (ChatSession.active !== this) return;
    const c = this.chat.context;
    statusItem.text = c ? `ctx ${Math.round((100 * c.used) / c.window)}%` : 'ctx -';
    statusItem.tooltip = c ? `${c.used.toLocaleString()} / ${c.window.toLocaleString()} tokens` : 'Claude Lite';
    statusItem.show();
  }
}

// ---------- commands ----------

function openTranscript(chat) {
  saveChat(chat);
  vscode.window.showTextDocument(vscode.Uri.file(chatFile(chat.id, 'md')), { viewColumn: vscode.ViewColumn.Beside, preview: false });
}

function moveChat(id, from, to) {
  for (const ext of ['json', 'md']) {
    const src = path.join(from, `${id}.${ext}`);
    if (fs.existsSync(src)) fs.renameSync(src, path.join(to, `${id}.${ext}`));
  }
}

// Chat picker with per-row archive/delete buttons and a title-bar toggle for the archive.
function pickChat() {
  const icon = (id, tooltip) => ({ iconPath: new vscode.ThemeIcon(id), tooltip });
  const B = { archive: icon('archive', 'Archive'), unarchive: icon('reply', 'Unarchive'), del: icon('trash', 'Delete permanently') };
  const qp = vscode.window.createQuickPick();
  qp.matchOnDescription = qp.matchOnDetail = true;
  let archived = false;
  const refresh = () => {
    const dir = archived ? archiveDir() : chatsDir();
    qp.title = archived ? 'Archived chats' : 'Chats';
    qp.placeholder = archived ? 'Select to unarchive and open' : 'Open a saved chat';
    qp.buttons = [archived ? icon('list-flat', 'Show active chats') : icon('archive', 'Show archived chats')];
    qp.items = listChats(dir).map(c => ({
      label: c.title,
      description: `${new Date(c.updated).toLocaleString()} | ${path.basename(c.cwd)}`,
      detail: `${c.messages.length} messages | ${c.settings.model || 'default model'}`,
      id: c.id,
      buttons: archived ? [B.unarchive, B.del] : [B.archive, B.del],
    }));
  };
  // An open tab would re-save the chat, so close it before moving/deleting.
  const closeTab = id => ChatSession.sessions.get(id)?.panel.dispose();
  qp.onDidTriggerButton(() => { archived = !archived; refresh(); });
  qp.onDidTriggerItemButton(async ({ item, button }) => {
    const dir = archived ? archiveDir() : chatsDir();
    if (button === B.del) {
      qp.ignoreFocusOut = true;
      const ok = await vscode.window.showWarningMessage(`Delete "${item.label}"? This cannot be undone.`, { modal: true }, 'Delete');
      qp.ignoreFocusOut = false;
      if (ok) {
        closeTab(item.id);
        for (const ext of ['json', 'md']) fs.rmSync(path.join(dir, `${item.id}.${ext}`), { force: true });
      }
      qp.show();
    } else {
      closeTab(item.id);
      archived ? moveChat(item.id, archiveDir(), chatsDir()) : moveChat(item.id, chatsDir(), archiveDir());
    }
    refresh();
  });
  qp.onDidAccept(() => {
    const pick = qp.selectedItems[0];
    if (!pick) return;
    if (archived) moveChat(pick.id, archiveDir(), chatsDir());
    qp.hide();
    ChatSession.open(loadChat(pick.id));
  });
  qp.onDidHide(() => qp.dispose());
  refresh();
  qp.show();
}

async function searchChats() {
  const q = await vscode.window.showInputBox({ prompt: 'Search text in all saved chats' });
  if (!q) return;
  const needle = q.toLowerCase(), items = [];
  for (const c of listChats()) {
    let text;
    try { text = fs.readFileSync(chatFile(c.id, 'md'), 'utf8'); } catch { continue; }
    const hits = text.split('\n').filter(l => l.toLowerCase().includes(needle));
    if (hits.length) items.push({ label: c.title, description: `${hits.length} hits | ${new Date(c.updated).toLocaleDateString()}`, detail: hits[0].trim().slice(0, 200), id: c.id });
  }
  if (!items.length) return vscode.window.showInformationMessage(`No chats contain "${q}"`);
  const pick = await vscode.window.showQuickPick(items, { placeHolder: `Chats containing "${q}"`, matchOnDetail: true });
  if (pick) ChatSession.open(loadChat(pick.id));
}

function activate(context) {
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = 'claudeLite.openChat';
  usageItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  usageItem.command = 'claudeLite.openChat';
  globalState = context.globalState;
  showUsage(globalState.get('usage'));
  fetchModels(); // fetched fresh on every VS Code start (no tokens used); validates defaults when done
  checkForUpdate(); // compares `claude --version` with the npm registry; never installs on its own
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    if (['defaultModel', 'defaultEffort', 'defaultThinking', 'defaultPermissionMode'].some(k => e.affectsConfiguration(`claudeLite.${k}`))) warnDefaults();
  }));
  const ticker = setInterval(() => showUsage(), 60_000); // keep "resets in" current
  context.subscriptions.push(
    statusItem, usageItem, { dispose: () => clearInterval(ticker) },
    vscode.commands.registerCommand('claudeLite.newChat', () => ChatSession.open(newChat())),
    vscode.commands.registerCommand('claudeLite.openChat', pickChat),
    vscode.commands.registerCommand('claudeLite.refreshModels', async () => {
      const list = await fetchModels();
      if (list) vscode.window.showInformationMessage(`Claude Lite: ${list.length} models loaded`);
      else vscode.window.showErrorMessage(`Claude Lite: could not fetch the model list - ${models.error}`);
    }),
    vscode.commands.registerCommand('claudeLite.searchChats', searchChats),
    vscode.commands.registerCommand('claudeLite.openTranscript', () => {
      if (ChatSession.active) openTranscript(ChatSession.active.chat);
      else vscode.window.showInformationMessage('No active Claude Lite chat.');
    }),
    vscode.commands.registerCommand('claudeLite.openChatsFolder', () =>
      vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(chatsDir()))),
    vscode.window.registerWebviewPanelSerializer('claudeLite.chat', {
      async deserializeWebviewPanel(panel, state) {
        try { ChatSession.open(loadChat(state.chatId), panel); } catch { panel.dispose(); }
      },
    }),
  );
}

function deactivate() {
  for (const s of ChatSession.sessions.values()) s.kill();
}

// ---------- webview ----------
// The page lives in media/ (html + css + js); only the resource URIs are filled in here.
const mediaDir = () => vscode.Uri.file(path.join(__dirname, 'media'));
const webviewOptions = () => ({ enableScripts: true, localResourceRoots: [mediaDir()] });

function webviewHtml(webview) {
  const uri = f => webview.asWebviewUri(vscode.Uri.joinPath(mediaDir(), f)).toString();
  return fs.readFileSync(path.join(__dirname, 'media', 'webview.html'), 'utf8')
    .replace(/\{\{cspSource\}\}/g, webview.cspSource)
    .replace('{{css}}', uri('webview.css'))
    .replace('{{js}}', uri('webview.js'));
}

module.exports = { activate, deactivate };
