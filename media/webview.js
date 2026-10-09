const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);
const log = $('log'), input = $('input');
const fmt = n => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n);
const scroller = $('scroller');
// Follow new output only while the view is at the bottom. Updated on user scrolls; content growth
// doesn't fire scroll events, so this keeps its value until the user scrolls away.
let stick = true;
const atBottom = () => scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 30;
const toBottom = () => { scroller.scrollTop = scroller.scrollHeight; };
scroller.addEventListener('scroll', () => { stick = atBottom(); });
// The log area shrinks when the message box grows; stay pinned if we were at the bottom.
new ResizeObserver(() => { if (stick) toBottom(); }).observe(scroller);

// Message box: grows with its content up to 10 lines; the top-edge grip sets a manual minimum height.
let manualH = 0;
function autoResize() {
  const lh = parseFloat(getComputedStyle(input).lineHeight);
  const chrome = input.offsetHeight - input.clientHeight + 12; // border + 6px padding top/bottom
  const top = scroller.scrollTop; // the momentary 'auto' height can clamp the log's scroll position
  input.style.height = 'auto';
  const want = Math.min(input.scrollHeight + chrome - 12, 10 * lh + chrome);
  input.style.height = Math.max(want, manualH) + 'px';
  scroller.scrollTop = top;
}
input.addEventListener('input', () => { autoResize(); syncSend(); });
const grip = $('grip');
grip.addEventListener('pointerdown', e => {
  e.preventDefault();
  grip.setPointerCapture(e.pointerId);
  grip.classList.add('drag');
  const y0 = e.clientY, h0 = input.offsetHeight;
  const move = ev => { manualH = Math.max(0, Math.min(h0 + y0 - ev.clientY, window.innerHeight * 0.7)); autoResize(); };
  const up = () => { grip.classList.remove('drag'); grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', up);
});
grip.addEventListener('dblclick', () => { manualH = 0; autoResize(); });

function upsert(m) {
  let el = $('m' + m.idx);
  if (!el) { el = document.createElement('div'); el.id = 'm' + m.idx; log.appendChild(el); }
  const open = el.querySelector('details')?.open;
  el.className = 'msg ' + m.role;
  el.innerHTML = m.html;
  if (open) { const d = el.querySelector('details'); if (d) d.open = true; }
  if (stick) toBottom();
}
// File links (data-file is set by the host only for paths that exist) open in an editor beside the chat.
log.addEventListener('click', e => {
  const a = e.target.closest('a[data-file]');
  if (!a) return;
  e.preventDefault();
  vscode.postMessage({ type: 'open', file: a.dataset.file, line: +a.dataset.line || 1, col: +a.dataset.col || 1 });
});
// During a turn, Send stays usable only for /btw (which runs alongside it).
let busy = false;
const isBtw = () => input.value.trim().startsWith('/btw ');
const syncSend = () => { $('send').disabled = busy && !isBtw(); };
function setBusy(b) { busy = b; $('stop').disabled = !b; syncSend(); showAgent(); }
// Status line: the agent's current activity (left; plus how long it has been at it while busy) and other notes (right).
let agentMsg = { text: 'Ready', since: Date.now() };
const elapsed = ms => { const s = Math.floor(ms / 1000); return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's'; };
function showAgent() {
  $('stat').textContent = $('stat').title = agentMsg.text + (busy ? ' | ' + elapsed(Date.now() - agentMsg.since) : '');
}
setInterval(() => { if (busy) showAgent(); }, 1000);
const setNote = text => { $('note').textContent = $('note').title = text; };
function setCtx(c) {
  const pct = Math.min(100, 100 * c.used / c.window);
  $('fill').style.width = pct + '%';
  $('fill').style.background = pct < 50 ? 'var(--vscode-charts-green)' : pct < 80 ? 'var(--vscode-charts-yellow)' : 'var(--vscode-charts-red)';
  $('ctxlabel').textContent = fmt(c.used) + ' / ' + fmt(c.window) + ' (' + pct.toFixed(0) + '%)';
  $('ctxwrap').title = (c.model || '') + ' - ' + c.used.toLocaleString() + ' tokens';
}
// Usage text with the "NN%" parts highlighted (odd split() items are the captured percentages).
function setRate({ text, title }) {
  const el = $('rate');
  el.replaceChildren(...text.split(/(\d+%)/).map((s, i) => {
    if (!(i % 2)) return s;
    const b = document.createElement('span'); b.className = 'pct'; b.textContent = s; return b;
  }));
  el.title = title;
}

window.addEventListener('message', ({ data: m }) => {
  switch (m.type) {
    case 'init':
      vscode.setState({ chatId: m.chatId });
      for (const [k, opts] of Object.entries(m.options)) {
        $(k).replaceChildren(...opts.map(([v, label]) => new Option(label, v)));
        $(k).value = m.settings[k] ?? '';
      }
      setModel(m.settings.model || '');
      log.innerHTML = '';
      m.messages.forEach(upsert);
      setBusy(m.busy);
      stick = true; toBottom();
      break;
    case 'upsert': upsert(m); break;
    case 'busy': setBusy(m.busy); break;
    case 'prefill': input.value = m.text; autoResize(); syncSend(); input.focus(); break;
    case 'ctx': setCtx(m); break;
    case 'agent': agentMsg = m; showAgent(); break;
    case 'note': setNote(m.text); break;
    case 'rate': setRate(m); break;
    case 'setting': if (m.key === 'model') setModel(m.value); else $(m.key).value = m.value; break;
    case 'models': buildModels(m); break;
  }
});

// Model dropdown: exactly what the CLI reported (no fallback list) + any custom ID + "Custom...".
let curModel = '', models = null;
function buildModels({ state, list, error }) {
  models = list;
  const btn = $('refreshModels');
  btn.disabled = state === 'loading';
  btn.textContent = state === 'loading' ? 'Loading models...' : state === 'error' ? 'Models failed - retry' : 'Refresh Models';
  btn.className = state === 'error' ? 'warn' : '';
  btn.title = state === 'error' ? 'Model list fetch failed: ' + error : state === 'ok' ? list.length + ' models from the CLI - click to re-fetch' : 'Asking the CLI for its model list...';
  if (state === 'error') setNote('Could not fetch model list: ' + error);
  const sel = $('model');
  sel.innerHTML = '';
  if (state !== 'ok') sel.add(new Option(state === 'loading' ? 'Loading models...' : 'Model list unavailable', ''));
  for (const m of list) {
    const o = new Option(m.displayName || m.value, m.value === 'default' ? '' : m.value); // "default" = no --model flag
    o.title = [m.description, m.resolvedModel].filter(Boolean).join(' - ');
    sel.add(o);
  }
  sel.add(new Option('Custom...', '__custom'));
  setModel(curModel);
}
function setModel(v) {
  const sel = $('model');
  if (![...sel.options].some(o => o.value === v)) {
    const base = v.replace(/\[1m\]$/i, ''), pinned = models?.find(m => m.resolvedModel === base);
    const label = pinned ? pinned.displayName + ' (pinned ' + v + ')' : v + ' (custom)';
    sel.insertBefore(new Option(label, v), sel.querySelector('[value="__custom"]'));
  }
  sel.value = curModel = v;
  sel.title = sel.selectedOptions[0]?.title || '';
  // Grey out effort levels the chosen model doesn't support.
  const info = models?.find(m => (m.value === 'default' ? '' : m.value) === v);
  for (const o of $('effort').options)
    o.disabled = !!(o.value && info && (!info.supportsEffort || (info.supportedEffortLevels && !info.supportedEffortLevels.includes(o.value))));
}
$('model').addEventListener('change', () => {
  const v = $('model').value;
  if (v === '__custom') { $('model').value = curModel; vscode.postMessage({ type: 'customModel' }); return; }
  setModel(v);
  vscode.postMessage({ type: 'setting', key: 'model', value: v });
});
// Scroll wheel over a dropdown steps through its options (skipping disabled ones and "Custom...").
// The host is told once the wheel settles, since each setting change restarts the claude process.
const wheelTimers = {};
for (const k of ['model', 'effort', 'thinking', 'permissionMode']) {
  const sel = $(k);
  sel.addEventListener('wheel', e => {
    e.preventDefault();
    const opts = [...sel.options].filter(o => o.value !== '__custom' && !o.disabled);
    const i = opts.findIndex(o => o.value === sel.value) + Math.sign(e.deltaY);
    if (!e.deltaY || i < 0 || i >= opts.length) return;
    if (k === 'model') setModel(opts[i].value); else sel.value = opts[i].value;
    clearTimeout(wheelTimers[k]);
    wheelTimers[k] = setTimeout(() => vscode.postMessage({ type: 'setting', key: k, value: sel.value.trim() }), 400);
  }, { passive: false });
}

function send() {
  if (!input.value.trim() || $('send').disabled) return;
  vscode.postMessage({ type: 'send', text: input.value });
  input.value = '';
  autoResize();
  syncSend();
}
$('send').onclick = send;
$('stop').onclick = () => vscode.postMessage({ type: 'stop' });
$('md').onclick = () => vscode.postMessage({ type: 'transcript' });
$('chats').onclick = () => vscode.postMessage({ type: 'pickChat' });
$('refreshModels').onclick = () => vscode.postMessage({ type: 'refreshModels' });
$('settings').onclick = () => vscode.postMessage({ type: 'settings' });
input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
for (const k of ['effort', 'thinking', 'permissionMode'])
  $(k).addEventListener('change', () => vscode.postMessage({ type: 'setting', key: k, value: $(k).value.trim() }));
vscode.postMessage({ type: 'ready' });
autoResize();
input.focus();
