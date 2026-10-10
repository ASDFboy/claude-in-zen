// Claude Bridge for Zen — background page.
// Connects to the local MCP bridge over ws://127.0.0.1:<port> and executes tool calls
// against tabs the user has shared with Claude.

const DEFAULT_PORT = 18765;
const MAX_SHOT_WIDTH = 1280;

const state = {
  port: DEFAULT_PORT,
  allowAll: false, // let Claude see/control every tab, not just shared ones
  paused: false,   // kill switch: reject all tool calls
  controlled: new Set(),
  lastTab: null,
};
const tabMeta = new Map(); // tabId -> { net: [], tracking: bool }
const meta = (id) => {
  if (!tabMeta.has(id)) tabMeta.set(id, { net: [], tracking: false });
  return tabMeta.get(id);
};

// ------------------------------------------------------------------ connection
let ws = null;
let connected = false;
let retryDelay = 1000;
let retryTimer = null;
let lastCallAt = 0;
let busy = false; // another browser holds the bridge

function connect(takeover = false) {
  clearTimeout(retryTimer);
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  try {
    ws = new WebSocket(`ws://127.0.0.1:${state.port}/ext${takeover ? '?takeover=1' : ''}`);
  } catch {
    scheduleReconnect();
    return;
  }
  ws.onopen = () => {
    connected = true;
    busy = false;
    retryDelay = 1000;
    updateBadge();
    ws.send(JSON.stringify({ type: 'hello', version: browser.runtime.getManifest().version }));
  };
  ws.onmessage = async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type !== 'call') return;
    lastCallAt = Date.now();
    let reply;
    try {
      reply = { type: 'result', id: msg.id, result: await dispatch(msg.tool, msg.args || {}) };
    } catch (e) {
      reply = { type: 'result', id: msg.id, error: friendlyError(e) };
    }
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(reply));
  };
  ws.onclose = (ev) => {
    connected = false;
    ws = null;
    // 4001: another browser already holds the bridge; 4000: it took over from us.
    busy = ev.code === 4001 || ev.code === 4000;
    if (busy) retryDelay = 15000;
    updateBadge();
    scheduleReconnect();
  };
  ws.onerror = () => {};
}

function scheduleReconnect() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connect, retryDelay);
  if (!busy) retryDelay = Math.min(retryDelay * 2, 10000); // cheap: a refused localhost connect costs ~nothing
}

function reconnectNow() {
  retryDelay = 1000;
  busy = false;
  if (ws) { ws.onclose = null; try { ws.close(); } catch {} ws = null; connected = false; }
  connect(true); // explicit user action: take the bridge over from any other browser
}

function updateBadge() {
  const text = state.paused ? '❚❚' : connected ? '' : busy ? '…' : '!';
  browser.browserAction.setBadgeText({ text });
  browser.browserAction.setBadgeBackgroundColor({ color: state.paused ? '#888' : '#b33' });
  browser.browserAction.setTitle({
    title: state.paused ? 'Claude Bridge — paused' : connected ? 'Claude Bridge — connected'
      : busy ? 'Claude Bridge — another browser is connected' : 'Claude Bridge — waiting for Claude',
  });
}

function friendlyError(e) {
  const m = String(e?.message || e);
  if (/Missing host permission|Cannot access contents|privileged|Could not establish connection/i.test(m)) {
    return 'This page can\'t be scripted (browser-internal pages like about:, the new-tab page, addons.mozilla.org and reader view are off-limits). Navigate the tab to a normal website first.';
  }
  return m;
}

// ------------------------------------------------------------------ tab access
function canAccess(tabId) {
  return state.allowAll || state.controlled.has(tabId);
}

async function getTab(tabId) {
  if (tabId == null) {
    tabId = state.lastTab;
    if (tabId == null || !canAccess(tabId)) {
      throw new Error('No tabId given and no current tab. Call tabs_context, or tabs_create to open one.');
    }
  }
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!tab) throw new Error(`Tab ${tabId} doesn't exist (it may have been closed). Call tabs_context.`);
  if (!canAccess(tabId)) {
    throw new Error(`Tab ${tabId} isn't shared with Claude. Use tabs_create, or ask the user to share it from the Claude Bridge toolbar button.`);
  }
  state.lastTab = tabId;
  return tab;
}

async function share(tabId, on) {
  if (on) state.controlled.add(tabId);
  else state.controlled.delete(tabId);
  await persistShared();
  updateEarlyHook();
  try { await cs(tabId, 'indicator', { on: on || state.allowAll }, { inject: on }); } catch {}
}

async function persistShared() {
  // storage.session clears on browser restart, so a recycled tab id can never be shared by accident.
  try { await browser.storage.session.set({ shared: [...state.controlled] }); } catch {}
}

// ------------------------------------------------------------------ content-script plumbing
async function ensureContent(tabId) {
  try {
    const r = await browser.tabs.sendMessage(tabId, { __claudeBridge: true, cmd: 'ping' }, { frameId: 0 });
    if (r && r.result === 'pong') return;
  } catch {}
  await injectScripts(tabId);
}

function injectScripts(tabId) {
  const o = { frameId: 0, runAt: 'document_start' };
  return browser.tabs.executeScript(tabId, { file: '/console-hook.js', ...o })
    .then(() => browser.tabs.executeScript(tabId, { file: '/content.js', ...o }));
}

// ---- early console hook: registered at document_start only for sites open in shared tabs,
// so console output from page load is captured without touching unrelated sites.
let earlyReg = null;
let earlyKey = '';
const pendingPat = new Map(); // tabId -> pattern of a navigation in flight
let earlyChain = Promise.resolve();

function patFor(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? `${u.protocol}//${u.hostname}/*` : null;
  } catch { return null; }
}

function updateEarlyHook() {
  earlyChain = earlyChain.then(async () => {
    const pats = new Set(pendingPat.values());
    for (const id of state.controlled) {
      const t = await browser.tabs.get(id).catch(() => null);
      const p = t && patFor(t.url);
      if (p) pats.add(p);
    }
    const key = [...pats].sort().join(' ');
    if (key === earlyKey) return;
    earlyKey = key;
    if (earlyReg) { await earlyReg.unregister().catch(() => {}); earlyReg = null; }
    if (pats.size) {
      earlyReg = await browser.contentScripts.register({
        matches: [...pats], js: [{ file: '/console-hook.js' }], runAt: 'document_start',
      }).catch(() => null);
    }
  });
  return earlyChain;
}

async function prepareNavigation(tabId, url) {
  const p = patFor(url);
  if (p) { pendingPat.set(tabId, p); await updateEarlyHook(); }
}

async function cs(tabId, cmd, args = {}, { inject = true } = {}) {
  if (inject) await ensureContent(tabId);
  const r = await browser.tabs.sendMessage(tabId, { __claudeBridge: true, cmd, args }, { frameId: 0 });
  if (!r) throw new Error('No response from page script.');
  if (r.error) throw new Error(r.error);
  return r.result;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitForLoad(tabId, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      browser.tabs.onUpdated.removeListener(onUpd);
      clearTimeout(timer);
      resolve();
    };
    const onUpd = (id, info) => { if (id === tabId && info.status === 'complete') finish(); };
    const timer = setTimeout(finish, timeoutMs);
    browser.tabs.onUpdated.addListener(onUpd);
    browser.tabs.get(tabId).then((t) => { if (t.status === 'complete') setTimeout(() => {
      browser.tabs.get(tabId).then((t2) => { if (t2.status === 'complete') finish(); }, finish);
    }, 150); }, finish);
  });
}

// After an input action the page may start navigating; give it a moment and settle.
async function settle(tabId) {
  await sleep(350);
  const t = await browser.tabs.get(tabId).catch(() => null);
  if (t && t.status === 'loading') await waitForLoad(tabId, 10000);
}

const text = (t) => ({ content: [{ type: 'text', text: String(t) }] });

function shotScale(tab) {
  return Math.min(1, MAX_SHOT_WIDTH / Math.max(1, tab.width || MAX_SHOT_WIDTH));
}

// Screenshot coordinates -> CSS pixels in the viewport.
function toCss(tab, coord) {
  if (!Array.isArray(coord) || coord.length !== 2) throw new Error('coordinate must be [x, y].');
  const s = shotScale(tab);
  return { x: coord[0] / s, y: coord[1] / s };
}

// ------------------------------------------------------------------ tools
async function dispatch(tool, a) {
  if (state.paused) {
    throw new Error('The user has paused Claude in the Claude Bridge extension. Ask them to resume it from the toolbar button.');
  }
  switch (tool) {
    case 'tabs_context': return tabsContext();
    case 'tabs_create': return tabsCreate(a);
    case 'tabs_close': return tabsClose(a);
    case 'tabs_select': return tabsSelect(a);
    case 'navigate': return navigate(a);
    case 'computer': return computer(a);
    case 'read_page': {
      const tab = await getTab(a.tabId);
      return text(await cs(tab.id, 'read_page', { filter: a.filter, ref_id: a.ref_id, max_chars: a.max_chars, depth: a.depth }));
    }
    case 'find': {
      const tab = await getTab(a.tabId);
      if (!a.query) throw new Error('query is required.');
      return text(await cs(tab.id, 'find', { query: a.query, limit: a.limit }));
    }
    case 'form_input': {
      const tab = await getTab(a.tabId);
      if (!a.ref) throw new Error('ref is required (get one from read_page or find).');
      const r = await cs(tab.id, 'form_input', { ref: a.ref, value: a.value });
      await settle(tab.id);
      return text(r);
    }
    case 'get_page_text': {
      const tab = await getTab(a.tabId);
      return text(await cs(tab.id, 'text', { max_chars: a.max_chars }));
    }
    case 'javascript_tool': return runJs(a);
    case 'read_console_messages': {
      const tab = await getTab(a.tabId);
      return text(await cs(tab.id, 'console', { pattern: a.pattern, only_errors: a.only_errors, clear: a.clear, limit: a.limit }));
    }
    case 'read_network_requests': return readNetwork(a);
    case 'resize_window': {
      const tab = await getTab(a.tabId);
      const w = await browser.windows.update(tab.windowId, { width: Math.round(a.width), height: Math.round(a.height), state: 'normal' });
      return text(`Window resized to ${w.width}x${w.height}.`);
    }
    default:
      throw new Error(`Unknown tool ${tool}. The extension may be older than the MCP server; update both.`);
  }
}

async function tabsContext() {
  const all = await browser.tabs.query({});
  const tabs = all.filter((t) => canAccess(t.id)).slice(0, 150);
  if (state.lastTab != null && !tabs.some((t) => t.id === state.lastTab)) state.lastTab = null;
  if (!tabs.length) {
    return text('No tabs are shared with Claude yet. Use tabs_create to open one (it is shared automatically), or ask the user to share an existing tab from the Claude Bridge toolbar button.');
  }
  const lines = tabs.map((t) =>
    `- tabId ${t.id}${t.id === state.lastTab ? ' (current)' : ''}${t.active ? ' [visible]' : ''}: ${t.title || '(untitled)'} — ${t.url}`);
  return text(`${state.allowAll ? 'All tabs are accessible.' : 'Tabs shared with Claude:'}\n${lines.join('\n')}`);
}

function normalizeUrl(u) {
  if (!u) return u;
  u = String(u).trim();
  if (/^(https?|file|about|data|view-source):/i.test(u)) return u;
  if (/^localhost(:\d+)?(\/|$)/i.test(u) || /^127\.0\.0\.1/.test(u)) return 'http://' + u;
  return 'https://' + u;
}

async function tabsCreate(a) {
  const url = normalizeUrl(a.url) || 'about:blank';
  checkNavigable(url);
  // Open blank first so the tab is shared before the page commits; that lets the
  // console hook be injected at document_start of the real page.
  const tab = await browser.tabs.create({ url: 'about:blank', active: a.active !== false });
  state.controlled.add(tab.id);
  await persistShared();
  state.lastTab = tab.id;
  if (url !== 'about:blank') {
    await prepareNavigation(tab.id, url);
    await browser.tabs.update(tab.id, { url });
    await sleep(200);
    await waitForLoad(tab.id);
  }
  const t = await browser.tabs.get(tab.id);
  try { await cs(t.id, 'indicator', { on: true }); } catch {}
  return text(`Created tab ${t.id}: ${t.title || ''} — ${t.url}`);
}

function checkNavigable(url) {
  if (/^(about|chrome|resource|moz-extension|view-source|jar):/i.test(url) && url !== 'about:blank') {
    throw new Error(`Extensions aren't allowed to open ${url.split(/[?#]/)[0]} — only normal web pages (http/https/file).`);
  }
}

async function tabsClose(a) {
  if (a.tabId == null) throw new Error('tabId is required.');
  await getTab(a.tabId);
  await browser.tabs.remove(a.tabId);
  return text(`Closed tab ${a.tabId}.`);
}

async function tabsSelect(a) {
  const tab = await getTab(a.tabId);
  await browser.tabs.update(tab.id, { active: true });
  await browser.windows.update(tab.windowId, { focused: true });
  return text(`Tab ${tab.id} is now the visible tab and the current tab for later calls.`);
}

async function navigate(a) {
  const tab = await getTab(a.tabId);
  const where = String(a.url || '').trim();
  if (!where) throw new Error('url is required ("back", "forward" and "reload" also work).');
  if (where === 'back') await browser.tabs.goBack(tab.id);
  else if (where === 'forward') await browser.tabs.goForward(tab.id);
  else if (where === 'reload') await browser.tabs.reload(tab.id);
  else {
    const u = normalizeUrl(where);
    checkNavigable(u);
    await prepareNavigation(tab.id, u);
    await browser.tabs.update(tab.id, { url: u });
  }
  await sleep(200);
  await waitForLoad(tab.id);
  const t = await browser.tabs.get(tab.id);
  return text(`Tab ${t.id} is at ${t.url}\nTitle: ${t.title || ''}`);
}

async function screenshot(tab, region) {
  const scale = shotScale(tab);
  let opts = { format: 'jpeg', quality: 72, scale };
  let note = '';
  if (region) {
    // Zoom: capture a region (given in screenshot coordinates) at full resolution.
    if (!Array.isArray(region) || region.length !== 4) throw new Error('region must be [x0, y0, x1, y1].');
    const vp = await cs(tab.id, 'viewport');
    const [x0, y0, x1, y1] = region.map((v) => v / scale);
    const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
    // Render the crop at up to 3x so small text is legible (capped at ~1568px on the long side).
    const zs = Math.max(Math.min(vp.dpr, 1568 / Math.max(w, h)), Math.min(3, 1568 / Math.max(w, h)));
    opts = { format: 'png', scale: zs, rect: { x: x0 + vp.sx, y: y0 + vp.sy, width: w, height: h } };
    note = `Zoomed view of region [${region.join(', ')}] (screenshot coordinates). Use coordinates from a normal screenshot for clicking, not from this image.`;
  }
  const dataUrl = await browser.tabs.captureTab(tab.id, opts);
  const comma = dataUrl.indexOf(',');
  const mimeType = dataUrl.slice(5, dataUrl.indexOf(';'));
  const w = Math.round(tab.width * scale), h = Math.round(tab.height * scale);
  return {
    content: [
      { type: 'image', data: dataUrl.slice(comma + 1), mimeType },
      { type: 'text', text: note || `Screenshot of tab ${tab.id} (${w}x${h}). Use these image coordinates for clicks. URL: ${tab.url}` },
    ],
  };
}

async function computer(a) {
  const tab = await getTab(a.tabId);
  const act = a.action;
  const coord = () => toCss(tab, a.coordinate);
  let r;
  switch (act) {
    case 'screenshot':
      return screenshot(tab);
    case 'zoom':
      return screenshot(tab, a.region);
    case 'left_click': case 'right_click': case 'double_click': case 'triple_click': case 'middle_click': {
      const button = act === 'right_click' ? 'right' : act === 'middle_click' ? 'middle' : 'left';
      const clickCount = act === 'double_click' ? 2 : act === 'triple_click' ? 3 : 1;
      const mods = a.modifiers ? String(a.modifiers).split('+') : [];
      const target = a.ref ? { ref: a.ref } : coord();
      r = await cs(tab.id, 'click', { ...target, button, clickCount, modifiers: mods });
      break;
    }
    case 'hover':
      r = await cs(tab.id, 'hover', a.ref ? { ref: a.ref } : coord());
      break;
    case 'left_click_drag': {
      const s = toCss(tab, a.start_coordinate), e = coord();
      r = await cs(tab.id, 'drag', { x0: s.x, y0: s.y, x1: e.x, y1: e.y });
      break;
    }
    case 'type':
      if (typeof a.text !== 'string') throw new Error('text is required for type.');
      r = await cs(tab.id, 'type', { text: a.text });
      break;
    case 'key':
      if (!a.text) throw new Error('text is required for key (e.g. "Enter", "ctrl+a", "Tab Tab").');
      r = await cs(tab.id, 'key', { text: a.text, repeat: a.repeat || 1 });
      break;
    case 'scroll': {
      const c = a.coordinate ? coord() : {};
      r = await cs(tab.id, 'scroll', { ...c, direction: a.scroll_direction || 'down', amount: a.scroll_amount ?? 3 });
      break;
    }
    case 'scroll_to':
      if (!a.ref) throw new Error('ref is required for scroll_to.');
      r = await cs(tab.id, 'scroll_to', { ref: a.ref });
      break;
    case 'wait': {
      const s = Math.min(Math.max(Number(a.duration) || 1, 0), 30);
      await sleep(s * 1000);
      return text(`Waited ${s}s.`);
    }
    default:
      throw new Error(`Unknown action "${act}".`);
  }
  await settle(tab.id);
  return text(r);
}

async function runJs(a) {
  const tab = await getTab(a.tabId);
  if (!a.text) throw new Error('text (the JavaScript to run) is required.');
  await ensureContent(tab.id);
  let res;
  try {
    res = await browser.tabs.executeScript(tab.id, { code: a.text, frameId: 0 });
  } catch (e) {
    const m = String(e?.message || e);
    if (/clon/i.test(m)) throw new Error('The result isn\'t serializable. End your script with a plain value, e.g. JSON.stringify(...).');
    throw new Error('Script error: ' + m);
  }
  let v = res && res[0];
  let out;
  if (v === undefined) out = 'undefined';
  else if (typeof v === 'string') out = v;
  else { try { out = JSON.stringify(v, null, 2); } catch { out = String(v); } }
  if (out.length > 30000) out = out.slice(0, 30000) + '\n…truncated';
  return text(out);
}

// ---- network capture: listener only attached while some tab is being tracked (zero idle cost)
let netListening = false;
function onNetDone(d) {
  if (d.tabId < 0) return;
  const m = tabMeta.get(d.tabId);
  if (!m || !m.tracking) return;
  m.net.push({
    method: d.method, url: d.url, status: d.statusCode ?? 0, type: d.type,
    error: d.error, t: Math.round(d.timeStamp),
  });
  if (m.net.length > 400) m.net.shift();
}
function updateNetListener() {
  const any = [...tabMeta.values()].some((m) => m.tracking);
  if (any && !netListening) {
    browser.webRequest.onCompleted.addListener(onNetDone, { urls: ['<all_urls>'] });
    browser.webRequest.onErrorOccurred.addListener(onNetDone, { urls: ['<all_urls>'] });
    netListening = true;
  } else if (!any && netListening) {
    browser.webRequest.onCompleted.removeListener(onNetDone);
    browser.webRequest.onErrorOccurred.removeListener(onNetDone);
    netListening = false;
  }
}

async function readNetwork(a) {
  const tab = await getTab(a.tabId);
  const m = meta(tab.id);
  if (!m.tracking) {
    m.tracking = true;
    updateNetListener();
    return text(`Started recording network requests for tab ${tab.id}. Requests made from now on will be captured — reload the page or repeat the action, then call this tool again.`);
  }
  let items = m.net.slice();
  if (a.url_pattern) items = items.filter((r) => r.url.includes(a.url_pattern));
  items = items.slice(-(a.limit || 100));
  if (a.clear) m.net.length = 0;
  if (!items.length) return text('No requests captured yet.');
  return text(items.map((r) => `${r.method} ${r.error ? 'ERR ' + r.error : r.status} [${r.type}] ${r.url}`).join('\n'));
}

// ------------------------------------------------------------------ lifecycle
browser.tabs.onRemoved.addListener((tabId) => {
  pendingPat.delete(tabId);
  if (state.controlled.delete(tabId)) { persistShared(); updateEarlyHook(); }
  if (tabMeta.delete(tabId)) updateNetListener();
  if (state.lastTab === tabId) state.lastTab = null;
});

// Navigations started by the page (link clicks, redirects) in shared tabs: make sure the
// early console hook covers the destination site.
browser.webNavigation.onBeforeNavigate.addListener(({ tabId, frameId, url }) => {
  if (frameId !== 0 || !state.controlled.has(tabId)) return;
  const p = patFor(url);
  if (p && !earlyKey.split(' ').includes(p)) { pendingPat.set(tabId, p); updateEarlyHook(); }
});

// After each page load in a shared tab, inject the page script and show the indicator border.
browser.webNavigation.onCompleted.addListener(({ tabId, frameId, url }) => {
  if (frameId !== 0 || !state.controlled.has(tabId)) return;
  if (pendingPat.delete(tabId)) updateEarlyHook();
  if (!/^(https?|file):/.test(url)) return;
  injectScripts(tabId).then(() => cs(tabId, 'indicator', { on: true }, { inject: false })).catch(() => {});
});

// Messages from the popup.
browser.runtime.onMessage.addListener(async (msg, sender) => {
  if (!msg || !msg.popup) return;
  switch (msg.popup) {
    case 'status': {
      const [active] = await browser.tabs.query({ active: true, currentWindow: true });
      const shared = (await browser.tabs.query({})).filter((t) => state.controlled.has(t.id))
        .map((t) => ({ id: t.id, title: t.title, url: t.url }));
      return {
        connected, busy, paused: state.paused, allowAll: state.allowAll, port: state.port,
        activeId: active?.id, activeShared: active ? state.controlled.has(active.id) : false,
        activeScriptable: active ? /^(https?|file):/.test(active.url || '') : false,
        shared, lastCallAt,
      };
    }
    case 'share': await share(msg.tabId, msg.on); return true;
    case 'pause':
      state.paused = !!msg.on;
      await browser.storage.local.set({ paused: state.paused });
      updateBadge();
      return true;
    case 'allowAll':
      state.allowAll = !!msg.on;
      await browser.storage.local.set({ allowAll: state.allowAll });
      return true;
    case 'port': {
      const p = parseInt(msg.port, 10);
      if (p > 1024 && p < 65536) {
        state.port = p;
        await browser.storage.local.set({ port: p });
        reconnectNow();
      }
      return true;
    }
    case 'reconnect': reconnectNow(); return true;
    case 'wake': if (!busy) { retryDelay = 1000; connect(); } return true;
  }
});

(async function init() {
  const s = await browser.storage.local.get(['port', 'allowAll', 'paused']);
  try { Object.assign(s, await browser.storage.session.get('shared')); } catch {}
  if (s.port) state.port = s.port;
  state.allowAll = !!s.allowAll;
  state.paused = !!s.paused;
  if (Array.isArray(s.shared)) {
    const live = new Set((await browser.tabs.query({})).map((t) => t.id));
    for (const id of s.shared) if (live.has(id)) state.controlled.add(id);
  }
  updateBadge();
  updateEarlyHook();
  connect();
})();
