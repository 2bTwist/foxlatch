// A stand-in Firefox profile for end-to-end tests. Loads the package's real
// background scripts (core.js, page.js, the personal build's scripts.js and
// background.js, as its manifest lists them) with a fake `browser` API, and starts the real
// host.py as Firefox would. Page scripts cannot run without a DOM, so
// executeScript answers with canned results and logs every call; each tab
// has a page (its text and the selectors that match) that `present`, the
// wait poll, reads, and that a navigation replaces.
//
// Usage: node firefox.js <profile name> <profile dir>
//   env FOXLATCH_STATE_DIR must point at a temporary directory;
//   FOXLATCH_EXTENSION_DIR, if set, is the unpacked package to load (a
//   personal build, say), else the tree's extension/ (the public build).
// Control on stdin, one JSON object per line:
//   {"cmd": "decide", "sessionId", "approve"}   as the user, from the confirm tab
//   {"cmd": "spoof", "sessionId", "approve"}    as a page's content script
//   {"cmd": "closeConfirm", "sessionId"}        the user closes the confirm tab
//   {"cmd": "revoke", "sessionId"}              the user clicks Stop on one session in the popup
//   {"cmd": "answer", "id", "approve", "remember"?}  as the user, from a question tab (ask.html)
//   {"cmd": "forget", "entry"}                  the user clicks Forget on a remembered approval in the popup
//   {"cmd": "spoofAnswer", "id"}                a page's content script tries to answer yes
//   {"cmd": "closeAsk", "id"}                   the user closes a question tab
//   {"cmd": "pageNavigates", "tabId", "url", "text"?, "selectors"?, "loadMs"?}
//                                               the page moves itself (link, redirect, reload), not the add-on;
//                                               its script context and content are replaced; loading for loadMs
//   {"cmd": "pageOpensTab", "tabId", "url"}     the page opens a new tab (target=_blank, window.open)
//   {"cmd": "setPage", "tabId", "text"?, "selectors"?, "hang"?}  the page changes in place; hang: its
//                                               scripts never answer (a modal dialog)
//   {"cmd": "onNavigate", "tabId", "commitMs"?, "text"?, "selectors"?, "loadMs"?}
//                                               how the add-on's next navigate in that tab goes: the old
//                                               document stays until the new one commits commitMs later
//   {"cmd": "onAct", "tabId", "navigate"?: {url, text, selectors, loadMs}, "openTab"?: url}
//                                               what the next action in that tab makes the page do, just after it
//   {"cmd": "timeScale", "scale"}               the add-on's timers run at this fraction of their delay
//   {"cmd": "view"} | {"cmd": "scripts"} | {"cmd": "titles"}
//   {"cmd": "asking"}                           ids of the questions whose tab (ask.html) is still open
//   {"cmd": "restartHost"}                      the host process dies; the add-on reconnects
// Events on stdout: {"event": "ready"}, {"event": "confirm", "sessionId", "code"},
//   {"event": "ask", "id", "kind", "subject", "inUsersWindow", "inSessionWindow"}, {"reply": ...}

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const readline = require('node:readline');

const [, , profileName, profileDir] = process.argv;
const ROOT = path.resolve(__dirname, '..', '..');
const EXT_DIR = process.env.FOXLATCH_EXTENSION_DIR || path.join(ROOT, 'extension');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'));
const EXT_ID = MANIFEST.browser_specific_settings.gecko.id;
const BASE = 'moz-extension://test-uuid/';

const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

function events() {
  const set = new Set();
  return { addListener: (f) => set.add(f), removeListener: (f) => set.delete(f), hasListener: (f) => set.has(f), fire: (...a) => [...set].map((f) => f(...a)) };
}

/* ---------- native port to the real host ---------- */

let hostProc = null;
function connectNative() {
  const onMessage = events();
  const onDisconnect = events();
  hostProc = spawn(process.env.PYTHON || 'python3', [path.join(ROOT, 'host', 'host.py')], {
    env: { ...process.env, FOXLATCH_PROFILE: `${profileName}\t${profileDir}` },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const proc = hostProc;
  let buf = Buffer.alloc(0);
  proc.stdout.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      const msg = JSON.parse(buf.subarray(4, 4 + len).toString('utf8'));
      buf = buf.subarray(4 + len);
      onMessage.fire(msg);
      if (msg.type === 'hello') emit({ event: 'ready', pid: proc.pid });
    }
  });
  proc.on('exit', () => onDisconnect.fire());
  return {
    onMessage,
    onDisconnect,
    postMessage(msg) {
      const body = Buffer.from(JSON.stringify(msg));
      const head = Buffer.alloc(4);
      head.writeUInt32LE(body.length, 0);
      if (!proc.stdin.destroyed) proc.stdin.write(Buffer.concat([head, body]));
    },
  };
}

/* ---------- fake windows and tabs ---------- */

let nextId = 100;
const windows = new Map(); // id -> {id, type, titlePreface}
const tabs = new Map(); // id -> {id, windowId, url, title, status}
const scripts = []; // {tabId, frameId, fn}
const pages = new Map(); // tabId -> { text, selectors }
const effects = new Map(); // tabId -> what the next action there makes the page do
const navs = new Map(); // tabId -> how the add-on's next navigation there goes
const argsOf = new Map(); // injected code -> the args background.js gave pageScript
let timeScale = 1;
const confirmTabOf = new Map(); // sessionId -> tabId
const askTabOf = new Map(); // request id -> tabId
const T = {
  tabs: { onRemoved: events(), onCreated: events(), onUpdated: events() },
  windows: { onRemoved: events() },
  runtime: { onMessage: events() },
  nav: { onCommitted: events(), onReferenceFragmentUpdated: events() },
  request: events(),
};

/* Firefox asks webRequest before it sends a load; a cancelled one never
 * moves the tab. Resolves whether it was sent. */
async function sends(tabId, url, type = 'main_frame') {
  const answers = await Promise.all(T.request.fire({ tabId, url, type }));
  return !answers.some((a) => a?.cancel);
}

function newTab(windowId, url) {
  const tab = { id: nextId++, windowId, url, title: `Title of ${url}`, status: 'complete' };
  tabs.set(tab.id, tab);
  pages.set(tab.id, { text: 'page text', selectors: [] });
  return tab;
}

/* A new document commits in a tab: it starts loading, as Firefox reports
 * every load, and finishes loadMs later. */
function pageMoves(tabId, { url, title, text = 'page text', selectors = [], loadMs = 0 }) {
  const t = Object.assign(tabs.get(tabId), { url, title: title ?? `Title of ${url}`, status: 'loading' });
  pages.set(tabId, { text, selectors });
  T.nav.onCommitted.fire({ tabId, frameId: 0, url });
  T.tabs.onUpdated.fire(t.id, { url, status: 'loading' }, { ...t });
  const complete = () => {
    if (tabs.get(tabId) !== t || t.url !== url) return;
    t.status = 'complete';
    T.tabs.onUpdated.fire(t.id, { status: 'complete' }, { ...t });
  };
  if (loadMs) setTimeout(complete, loadMs);
  else complete();
  return t;
}

/* The add-on navigates a tab: the old document stays until the new one
 * commits, as onNavigate armed it (at once, with a fresh page, if not). */
function addonNavigates(tabId, url) {
  const nav = navs.get(tabId) || {};
  navs.delete(tabId);
  const t = tabs.get(tabId);
  setTimeout(async () => { if (tabs.get(tabId) === t && await sends(tabId, url)) pageMoves(tabId, { ...nav, url }); }, nav.commitMs || 0);
}

function pageOpensTab(tabId, url) {
  const t = newTab(tabs.get(tabId).windowId, 'about:blank');
  T.tabs.onCreated.fire({ ...t, openerTabId: tabId });
  sends(t.id, url).then((ok) => { if (ok && tabs.get(t.id) === t) pageMoves(t.id, { url }); });
  return t.id;
}

/* the user's own window in this profile, where confirmations should appear. */
const usersWindow = { id: nextId++, type: 'normal', titlePreface: '', focused: true };
windows.set(usersWindow.id, usersWindow);
newTab(usersWindow.id, 'https://example.org/users-own-tab');

async function noticeConfirm(tab) {
  if (tab.url.startsWith(`${BASE}ask.html#`)) {
    const id = decodeURIComponent(tab.url.split('#')[1]);
    askTabOf.set(id, tab.id);
    const r = (await trusted({ type: 'view' }, tab)).requests.find((q) => q.id === id);
    const sessionWindow = [...tabs.values()].some((t) => t.windowId === tab.windowId && t.id !== tab.id && !t.url.startsWith(BASE)) && tab.windowId !== usersWindow.id;
    emit({ event: 'ask', id, kind: r?.kind, subject: r?.subject, inUsersWindow: tab.windowId === usersWindow.id, inSessionWindow: sessionWindow });
    return;
  }
  if (!tab.url.startsWith(`${BASE}confirm.html#`)) return;
  const sessionId = decodeURIComponent(tab.url.split('#')[1]);
  confirmTabOf.set(sessionId, tab.id);
  const v = await trusted({ type: 'view' }, tab);
  emit({ event: 'confirm', sessionId, code: v.pending.find((p) => p.sessionId === sessionId)?.code, windowId: tab.windowId, inUsersWindow: tab.windowId === usersWindow.id });
}

const browser = {
  runtime: {
    id: EXT_ID,
    getURL: (p) => BASE + p,
    getManifest: () => JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8')),
    connectNative,
    onMessage: T.runtime.onMessage,
  },
  windows: {
    async create({ url, type }) {
      const win = { id: nextId++, type: type || 'normal', titlePreface: '', focused: true };
      windows.set(win.id, win);
      const tab = newTab(win.id, url);
      await noticeConfirm(tab);
      return { ...win, tabs: [{ ...tab }] };
    },
    async getAll({ windowTypes } = {}) {
      return [...windows.values()].filter((w) => !windowTypes || windowTypes.includes(w.type)).map((w) => ({ ...w }));
    },
    async remove(id) {
      if (!windows.delete(id)) throw new Error('no window');
      for (const [tid, t] of tabs) if (t.windowId === id) { tabs.delete(tid); T.tabs.onRemoved.fire(tid); }
      T.windows.onRemoved.fire(id);
    },
    async update(id, props) {
      const w = windows.get(id);
      if (!w) throw new Error('no window');
      Object.assign(w, props);
      return { ...w };
    },
    onRemoved: T.windows.onRemoved,
  },
  tabs: {
    async create({ windowId, url }) {
      if (!windows.has(windowId)) throw new Error('no window');
      const tab = newTab(windowId, url);
      await noticeConfirm(tab);
      return { ...tab };
    },
    async get(id) {
      const t = tabs.get(id);
      if (!t) throw new Error(`Invalid tab ID: ${id}`);
      return { ...t };
    },
    async update(id, props) {
      const t = tabs.get(id);
      if (!t) throw new Error(`Invalid tab ID: ${id}`);
      if (props.url) addonNavigates(id, props.url);
      return { ...t };
    },
    async remove(id) {
      tabs.delete(id);
      pages.delete(id);
      T.tabs.onRemoved.fire(id);
    },
    async goBack() {}, async goForward() {},
    async reload(id) { addonNavigates(id, tabs.get(id).url); },
    async executeScript(tabId, { code, frameId }) {
      const t = tabs.get(tabId);
      if (!t) throw new Error(`Invalid tab ID: ${tabId}`);
      const fn = /return \((?:async )?function (\w+)/.exec(code)?.[1];
      const args = argsOf.get(code) || {};
      // background.js prefixes every script with a check of the page's host,
      // which a real page runs before the function itself.
      const expect = /location\.hostname !== ("[^"]*")/.exec(code);
      if (!expect) throw new Error('script without a host check');
      if (new URL(t.url).hostname !== JSON.parse(expect[1])) throw new Error('the page changed before the action ran; snapshot again');
      scripts.push({ tabId, frameId, fn, url: t.url, code });
      const page = pages.get(tabId);
      switch (fn) {
        case 'snapshot': {
          const lines = ['  # Heading', 'e1 button "Request indexing"'];
          // A filter that matches nothing: the page offers its nearest line instead.
          if (args.filter && !lines.some((l) => l.toLowerCase().includes(args.filter.toLowerCase()))) {
            return [{ url: t.url, title: t.title, scroll: '0 of 0px', lines: [], skipped: 0, near: [{ line: lines[1], score: 1 }] }];
          }
          return [{ url: t.url, title: t.title, scroll: '0 of 0px', lines, skipped: 0 }];
        }
        case 'text': {
          const to = Math.min(page.text.length, args.offset + args.max);
          return [{ url: t.url, title: t.title, text: page.text.slice(args.offset, to), offset: args.offset, total: page.text.length, ...(to < page.text.length ? { next: to } : {}) }];
        }
        case 'find': return [{ doc: args.tag, matches: 1, lines: ['e1 button "Request indexing"'] }];
        case 'read': return [{ doc: args.tag, kind: 'table', headers: ['Member', 'Status'], rows: [{ cells: ['101', 'Paid'], refs: [{ ref: 'e1', role: 'button', name: 'Edit' }] }], total: 2, next: 1 }];
        case 'act': {
          const effect = effects.get(tabId);
          effects.delete(tabId);
          if (effect) {
            setTimeout(() => {
              if (effect.navigate) sends(tabId, effect.navigate.url).then((ok) => { if (ok) pageMoves(tabId, effect.navigate); });
              if (effect.openTab) pageOpensTab(tabId, effect.openTab);
            }, 30);
          }
          return [args.action === 'type' ? 'typed' : args.action === 'key' ? `pressed ${args.key}` : args.action === 'select' ? `selected "${args.option}"` : 'clicked'];
        }
        case 'present': if (page.hang) await new Promise(() => {}); return [{
          ...(args.selector ? { selector: page.selectors.includes(args.selector) } : {}),
          ...(args.text ? { text: page.text.includes(args.text) } : {}),
        }];
        case 'canEval': return [true];
        case 'markDocument': return [args.token];
        case 'evalInPage': return [42];
        case 'rect': return [{ x: 0, y: 0, width: 10, height: 10 }];
        default: throw new Error(`unexpected script ${fn}`);
      }
    },
    async captureTab() { return 'data:image/png;base64,iVBORw0KGgo='; },
    onRemoved: T.tabs.onRemoved,
    onCreated: T.tabs.onCreated,
    onUpdated: T.tabs.onUpdated,
  },
  webNavigation: {
    async getAllFrames({ tabId }) { return [{ frameId: 0, url: tabs.get(tabId)?.url }]; },
    async getFrame({ tabId, frameId }) { return frameId === 0 ? { frameId: 0, url: tabs.get(tabId)?.url } : null; },
    onCommitted: T.nav.onCommitted,
    onReferenceFragmentUpdated: T.nav.onReferenceFragmentUpdated,
    onCreatedNavigationTarget: events(),
  },
  webRequest: { onBeforeRequest: { addListener: (f) => T.request.addListener(f) } },
  browserAction: { setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {} },
  notifications: { async create() {}, async clear() {}, onClicked: { addListener() {} } },
};

/* The add-on's own files, as Firefox serves them from its package. */
async function fetchOwn(url) {
  if (!String(url).startsWith(BASE)) throw new Error(`the harness serves only the add-on's own files, not ${url}`);
  const bytes = fs.readFileSync(path.join(EXT_DIR, String(url).slice(BASE.length)));
  return { ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) };
}

/* Sends a runtime message as one of the add-on's own pages. */
async function trusted(msg, tab) {
  const sender = tab
    ? { id: EXT_ID, url: tab.url, envType: 'addon_child', tab: { id: tab.id, windowId: tab.windowId, url: tab.url } }
    : { id: EXT_ID, url: `${BASE}popup.html`, envType: 'addon_child' };
  const results = await Promise.all(T.runtime.onMessage.fire(msg, sender));
  return results.find((r) => r !== undefined);
}

/* ---------- load the add-on ---------- */

const context = vm.createContext({
  browser, crypto: globalThis.crypto, console, URL, Promise, Object, clearTimeout, TextEncoder, TextDecoder, fetch: fetchOwn,
  setTimeout: (fn, ms, ...rest) => setTimeout(fn, (ms || 0) * timeScale, ...rest),
});
// The package's own list, as Firefox loads it: the personal one adds scripts.js.
for (const file of MANIFEST.background.scripts) {
  vm.runInContext(fs.readFileSync(path.join(EXT_DIR, file), 'utf8'), context, { filename: file });
  if (file === 'page.js') {
    // Remember what each injected script was asked to do, as a page would see it.
    const real = context.pageScript;
    context.pageScript = (name, args, host) => {
      const code = real(name, args, host);
      argsOf.set(code, args);
      return code;
    };
  }
}

/* ---------- control ---------- */

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const c = JSON.parse(line);
  let reply;
  try {
    switch (c.cmd) {
      case 'decide': {
        const v = await trusted({ type: 'view' });
        const p = v.pending.find((q) => q.sessionId === c.sessionId);
        const tab = tabs.get(confirmTabOf.get(c.sessionId));
        // As the pairing page does: the Allow carries the list of remembered approvals it showed.
        reply = await trusted({ type: 'decide', sessionId: c.sessionId, code: c.code ?? p?.code, approve: c.approve, approvalsDigest: p?.approvalsDigest }, tab);
        if (reply) reply.confirmTabOpen = tabs.has(confirmTabOf.get(c.sessionId));
        break;
      }
      case 'spoof': {
        const v = await trusted({ type: 'view' });
        const p = v.pending.find((q) => q.sessionId === c.sessionId);
        const sender = { id: EXT_ID, url: 'https://evil.test/', envType: 'content_child', tab: { id: 1, windowId: 1, url: 'https://evil.test/' } };
        const results = await Promise.all(T.runtime.onMessage.fire({ type: 'decide', sessionId: c.sessionId, code: p?.code, approve: true }, sender));
        reply = results.find((r) => r !== undefined) ?? null;
        break;
      }
      case 'closeConfirm': await browser.tabs.remove(confirmTabOf.get(c.sessionId)); reply = 'closed'; break;
      case 'revoke': reply = await trusted({ type: 'revoke', sessionId: c.sessionId }); break;
      case 'answer': {
        const tab = tabs.get(askTabOf.get(c.id));
        reply = await trusted({ type: 'answer', id: c.id, approve: c.approve, ...(c.remember ? { remember: true } : {}) }, tab);
        break;
      }
      case 'forget': reply = await trusted({ type: 'forget', entry: c.entry }); break;
      case 'spoofAnswer': {
        const sender = { id: EXT_ID, url: 'https://evil.test/', envType: 'content_child', tab: { id: 1, windowId: 1, url: 'https://evil.test/' } };
        const results = await Promise.all(T.runtime.onMessage.fire({ type: 'answer', id: c.id, approve: true }, sender));
        reply = results.find((r) => r !== undefined) ?? null;
        break;
      }
      case 'closeAsk': await browser.tabs.remove(askTabOf.get(c.id)); reply = 'closed'; break;
      case 'pageNavigates':
        pageMoves(c.tabId, { title: 'Inbox (3) - user@example.test', ...c });
        reply = 'moved';
        break;
      case 'pageOpensTab': reply = pageOpensTab(c.tabId, c.url); break;
      case 'setPage': Object.assign(pages.get(c.tabId), { ...(c.text !== undefined ? { text: c.text } : {}), ...(c.selectors ? { selectors: c.selectors } : {}), ...(c.hang !== undefined ? { hang: c.hang } : {}) }); reply = 'set'; break;
      case 'onNavigate': navs.set(c.tabId, { commitMs: c.commitMs, text: c.text, selectors: c.selectors, loadMs: c.loadMs }); reply = 'armed'; break;
      case 'onAct': effects.set(c.tabId, { navigate: c.navigate, openTab: c.openTab }); reply = 'armed'; break;
      case 'timeScale': timeScale = c.scale; reply = timeScale; break;
      case 'view': reply = await trusted({ type: 'view' }); break;
      case 'scripts': reply = scripts; break;
      case 'titles': reply = [...windows.values()].map((w) => w.titlePreface); break;
      case 'asking': reply = [...askTabOf].filter(([, tabId]) => tabs.has(tabId)).map(([id]) => id); break;
      case 'restartHost': hostProc.kill('SIGKILL'); reply = 'killed'; break;
      default: reply = `unknown ${c.cmd}`;
    }
  } catch (e) {
    reply = { error: String(e.message || e) };
  }
  emit({ reply });
});

process.on('SIGTERM', () => { hostProc?.kill(); process.exit(0); });
