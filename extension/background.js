/*
 * Foxlatch background page: wires core.js (who may drive this profile)
 * and page.js (what runs in a page) to Firefox and to the native host.
 *
 * The host sends four kinds of message:
 *   {type: 'hello', profile, deny, protect, exclusive, approvals, approvalsError?}  once per connection
 *   {type: 'opened'|'closed', sessionId, project} an agent session came or went
 *   {type: 'remembered', approvals, did, error?} the approvals file after a remember or forget
 *   {id, sessionId, method, params}             a tool call; answered with {id, ok, result|error}
 * sessionId is attached by the host from the socket connection, never taken
 * from the caller's params. The add-on sends the host, besides answers,
 * {type: 'hello', build, scripts} once per connection (which build this is,
 * for the registry agents read), and {type: 'remember'|'forget', entry},
 * only for the add-on's own pages: a tool call can never cause one.
 */

/* global createCore, pageScript, SCRIPT_TOOLS */

const HOST = 'foxlatch';
const EXT_BASE = browser.runtime.getURL('');
const NAV_TIMEOUT_MS = 30000;
const WAIT_MAX_MS = 60000; // mcp/server.py waits longer, so a wait always returns its own answer
const POLL_MS = 250;
// A wait's last check can start with almost no time left and lose its race
// to the deadline; that is not the page failing to answer. In live use, 26
// of 39 misses said "the page did not answer" for this reason alone.
const CUT_OFF_MS = 1000;
const CUT_OFF = Symbol('cut off');
const SLEEP_MAX_MS = 30000;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const nonce = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');

const core = createCore({
  makeCode: () => {
    const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
    return String(n).padStart(6, '0').replace(/(\d{3})(\d{3})/, '$1 $2');
  },
});

let port = null;
// Why this add-on's host serves no session (another Foxlatch add-on in this
// profile already runs one), from the host's hello; null when it serves.
let hostRefused = null;
let retryMs = 1000;
const waiters = new Map(); // 'claim:<sessionId>', 'req:<id>' or 'lease:<sessionId>' -> [wake]
// Pages that ask the user something, open in one of their own windows:
// 'claim:<sessionId>' -> confirm.html, 'req:<id>' -> ask.html. The value is
// null while the tab is being created, so a second caller does not open another.
const ownerTabs = new Map();

/* One of the add-on's own files, as its package holds it. */
async function own(name) {
  const res = await fetch(browser.runtime.getURL(name));
  if (!res.ok) throw new Error(`${name} is not in the package`);
  return new Uint8Array(await res.arrayBuffer());
}

/* Which build this is, from what the package holds. eval, define, call and
 * await_question are the personal package's scripts.js, loaded before this
 * file, which defines SCRIPT_TOOLS; the public package (Mozilla's policy on
 * remote code), and the tree's extension/, have no such file and no code that
 * runs a session's script (foxlatch/build.py). */
const SCRIPTS = typeof SCRIPT_TOOLS === 'undefined' ? null : SCRIPT_TOOLS;
const BUILD = SCRIPTS ? { build: 'personal', scripts: true } : { build: 'public', scripts: false };
const SCRIPT_METHODS = ['eval', 'define', 'await_question', 'call'];
async function noScripts() {
  throw new Error('this Foxlatch build runs no scripts: eval, define and call are not available. Use snapshot, click, type and text instead');
}

/* A file as the digest reads it (build.py _digested): manifest.json as its
 * JSON with keys sorted and no spacing, since Mozilla's signing writes that
 * file out again laid out its own way; every other file byte for byte. */
function digested(name, bytes) {
  if (name !== 'manifest.json') return bytes;
  const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]`
    : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`
      : JSON.stringify(v));
  return new TextEncoder().encode(canon(JSON.parse(new TextDecoder().decode(bytes))));
}

/* What this add-on runs, for mcp/server.py to compare with the code it
 * expects (foxlatch/build.py package_digest for this build): the version,
 * the build, and a digest of every file the package ships, as files.json
 * lists them (an add-on cannot list its own directory; tests check the list
 * against what install.sh packages). code is null if they cannot be read. */
const addonCode = (async () => {
  const { version } = browser.runtime.getManifest();
  const { build, scripts } = BUILD;
  try {
    const parts = [];
    for (const name of JSON.parse(new TextDecoder().decode(await own('files.json')))) {
      parts.push(new TextEncoder().encode(`${name}\0`), digested(name, await own(name)), new Uint8Array([0]));
    }
    const all = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
    parts.reduce((at, x) => { all.set(x, at); return at + x.length; }, 0);
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', all));
    return { version, build, scripts, code: [...hash].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16) };
  } catch {
    return { version, build, scripts, code: null };
  }
})().catch(() => null);

/* ---------- native host ---------- */

function connect() {
  const p = browser.runtime.connectNative(HOST);
  port = p;
  // Each message is answered through the port it came on, never a later one:
  // a new host numbers its requests from 0 again, so an answer to a stopped
  // host's request could reach another session's call.
  p.onMessage.addListener((msg) => onHostMessage(msg, p));
  // The host lists this build in its registry, so an agent knows before it connects whether scripts exist here.
  toHost({ type: 'hello', build: BUILD.build, scripts: BUILD.scripts });
  port.onDisconnect.addListener(() => {
    port = null;
    hostRefused = null;
    // Nothing asked of it will be answered: a forget it did not confirm failed.
    core.forgetsLost('the Foxlatch host stopped before it confirmed this; it may still be in the file');
    // The host is gone, and every session's connection with it: fail closed.
    for (const { sessionId } of core.view().pending) {
      core.release(sessionId, 'the Foxlatch host stopped');
      closeOwnerTab(`claim:${sessionId}`);
      wake(`claim:${sessionId}`);
    }
    core.revokeAll('the Foxlatch host stopped');
    settleRequests();
    refreshBadge();
    setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 60000);
  });
}

async function onHostMessage(msg, from) {
  retryMs = 1000;
  if (msg.type === 'hello') {
    hostRefused = msg.refused ? String(msg.refused).slice(0, 400) : null;
    core.configure({ profile: msg.profile, deny: msg.deny || [], protect: msg.protect || [], exclusive: msg.exclusive || [], configError: msg.configError ?? null });
    // A forget the last host never wrote is asked of this one.
    for (const entry of core.hostApprovals(msg.approvals || [])) toHost({ type: 'forget', entry });
    if (msg.approvalsError) {
      core.note(`Earlier remembered approvals could not be read, so none stand: ${msg.approvalsError}. Sessions will be asked again.`);
    }
    refreshBadge();
    return;
  }
  if (msg.type === 'remembered') {
    core.hostApprovals(msg.approvals || [], msg.did ?? null, msg.error ?? null);
    return;
  }
  if (msg.type === 'opened') {
    // The label is core's, made from the project; the host sends none.
    core.opened(msg.sessionId, msg.project);
    return;
  }
  if (msg.type === 'closed') {
    const label = core.labelOf(msg.sessionId);
    const windowId = core.closed(msg.sessionId);
    if (windowId !== null) markWindow(windowId, `Foxlatch (ended) · ${label} — `);
    closeOwnerTab(`claim:${msg.sessionId}`);
    wake(`claim:${msg.sessionId}`);
    settleRequests();
    refreshBadge();
    return;
  }
  const reply = (body) => {
    if (port !== from) return; // that host stopped; its caller learnt so from it
    try { from.postMessage({ id: msg.id, ...body }); } catch { /* disconnected meanwhile */ }
  };
  try {
    const fn = Object.hasOwn(TOOLS, msg.method) ? TOOLS[msg.method] : null;
    if (!fn) throw new Error(`unknown method ${msg.method}`);
    reply({ ok: true, result: await fn(msg.sessionId, msg.params || {}) });
  } catch (e) {
    reply({ ok: false, error: String(e?.message || e) });
  }
}

function toHost(msg) {
  try {
    if (!port) return false;
    port.postMessage(msg);
    return true;
  } catch {
    return false;
  }
}

/* ---------- asking the user ---------- */

function wake(key) {
  for (const fn of waiters.get(key) || []) fn();
  waiters.delete(key);
}

/* Resolves when wake(key) runs; forget() drops the hook once it is not needed. */
function onWake(key) {
  let fn;
  const woken = new Promise((resolve) => { fn = resolve; });
  waiters.set(key, [...(waiters.get(key) || []), fn]);
  const forget = () => {
    const rest = (waiters.get(key) || []).filter((f) => f !== fn);
    if (rest.length) waiters.set(key, rest);
    else waiters.delete(key);
  };
  return { woken, forget };
}

function waitFor(key, ms) {
  const w = onWake(key);
  let timer;
  return Promise.race([w.woken, new Promise((resolve) => { timer = setTimeout(resolve, ms); })])
    .finally(() => { clearTimeout(timer); w.forget(); });
}

/* For a wait or a sleep: or(p) settles with p, or throws "not connected" as
 * soon as the session's lease ends, so a page that never answers or a long
 * pause does not hold the call. Call forget() when done. */
function leaseEnd(sessionId) {
  const w = onWake(`lease:${sessionId}`);
  const ended = w.woken.then(() => {
    core.authorize(sessionId);
    throw new Error('not connected: control ended while waiting');
  });
  ended.catch(() => {});
  return { or: (p) => Promise.race([p, ended]), forget: w.forget };
}

/* When a session's control ends, its requests still waiting are cancelled in
 * core; wake their callers, and its waits and sleeps, so they report it now
 * rather than at timeout. A question that is no longer waiting (answered,
 * expired or cancelled) loses its tab, whether or not a call waits on it. */
function settleRequests() {
  const driving = new Set(core.view().leases.map((l) => l.sessionId));
  for (const key of new Set([...waiters.keys(), ...ownerTabs.keys()])) {
    if (key.startsWith('lease:')) {
      if (!driving.has(key.slice(6))) wake(key);
      continue;
    }
    if (!key.startsWith('req:')) continue;
    const r = core.requestOf(key.slice(4));
    if (!r || r.status !== 'pending') { closeOwnerTab(key); wake(key); }
  }
}

/* A pairing request opens as a tab in one of the user's own windows of this
 * profile, beside its tabs, bookmarks and theme, so they can see which profile
 * is asking; a floating window looks the same from every profile. A question
 * from a session that already drives the profile opens at the front of that
 * session's own window, where the user is watching it work. The session cannot
 * touch the tab either way: it is not one of its tabs, and it cannot load
 * add-on pages. */
async function openOwnerTab(key, path, sessionWindow = null) {
  if (ownerTabs.has(key)) return;
  ownerTabs.set(key, null);
  const url = browser.runtime.getURL(path);
  const agentWindows = new Set(core.agentWindows());
  const all = await browser.windows.getAll({ windowTypes: ['normal'] });
  const normal = all.filter((w) => !agentWindows.has(w.id));
  const target = all.find((w) => w.id === sessionWindow)
    || normal.find((w) => w.focused) || normal.sort((a, b) => b.id - a.id)[0];
  let tab;
  if (target) {
    tab = await browser.tabs.create({ windowId: target.id, url, active: true });
    browser.windows.update(target.id, { focused: true, drawAttention: true }).catch(() => {});
  } else {
    tab = (await browser.windows.create({ url, focused: true })).tabs[0];
  }
  // Answered or cancelled while the tab was being created: it has no question left.
  if (ownerTabs.get(key) !== null) { browser.tabs.remove(tab.id).catch(() => {}); return; }
  ownerTabs.set(key, tab.id);
  notify(key);
}

/* A system notification for a question that just opened its tab, for when
 * the user is in another app: in live use, 3 of 19 script questions and 2
 * pairings ran out unseen. It names the session and what it asks, never the code,
 * a page's content or a pairing code (the system keeps a history of them). A click
 * only brings the question's tab forward; answering stays on that page. */
function notify(key) {
  let title, message;
  if (key.startsWith('claim:')) {
    const p = core.view().pending.find((x) => x.sessionId === key.slice(6));
    if (!p) return;
    title = 'An agent session asks to drive Firefox';
    message = `${p.label} on ${core.profile.name}. Check its code in Firefox.`;
  } else {
    const r = core.requestOf(key.slice(4));
    if (r?.status !== 'pending') return;
    const host = (u) => { try { return new URL(u).hostname || 'a page'; } catch { return 'a page'; } };
    const subject = r.kind === 'site' ? null : JSON.parse(r.subject);
    title = `${r.label} is waiting for you`;
    message = r.kind === 'site' ? `It asks to use ${r.subject}.`
      : r.kind === 'function' ? `It asks to define a function on ${host(subject.url)}.`
        : `It asks to run a script on ${host(subject.url)}.`;
    message += ` You have ${REQUEST_TTL_MS / 1000} s.`;
  }
  browser.notifications.create(key, { type: 'basic', title, message }).catch(() => {});
}

browser.notifications.onClicked.addListener(async (key) => {
  const id = ownerTabs.get(key);
  if (typeof id !== 'number') return;
  const tab = await browser.tabs.update(id, { active: true }).catch(() => null);
  if (tab) browser.windows.update(tab.windowId, { focused: true }).catch(() => {});
});

/* A pairing that is no longer waiting (answered, expired, refused) loses its
 * tab and notification. */
function endedClaim(sessionId) {
  if (core.claimStatus(sessionId) === 'pending') return;
  closeOwnerTab(`claim:${sessionId}`);
  refreshBadge();
}

function closeOwnerTab(key) {
  const id = ownerTabs.get(key);
  ownerTabs.delete(key);
  browser.notifications.clear(key).catch(() => {});
  if (typeof id === 'number') browser.tabs.remove(id).catch(() => {});
}

/* Puts a question to the user in Firefox and returns its id at once. Its tab
 * closes when it stops waiting: when they answer, when it expires (a timer,
 * since no call may be waiting on it), or when control ends. */
async function putQuestion(sessionId, kind, subject, extra = {}) {
  const id = core.ask(sessionId, kind, subject, extra);
  const key = `req:${id}`;
  refreshBadge();
  if (!ownerTabs.has(key)) { // the same pending question asked again already has its tab and timer
    const timer = setTimeout(() => { settleRequests(); refreshBadge(); }, core.requestOf(id).created + REQUEST_TTL_MS - Date.now() + 500);
    timer?.unref?.(); // no call waits on it, so under node (the tests) it does not hold the process open; Firefox has no unref
  }
  await openOwnerTab(key, `ask.html#${encodeURIComponent(id)}`, core.windowOf(sessionId));
  return id;
}

/* Waits up to ms for the user's answer to this session's question, then reads
 * it: { status: 'pending' } while they have not answered, else the settled
 * request, read once. */
async function answerOf(sessionId, id, ms) {
  const key = `req:${id}`;
  let out = core.settle(sessionId, id);
  if (out.status === 'pending' && ms > 0) {
    await waitFor(key, Math.min(ms, core.requestOf(id).created + REQUEST_TTL_MS - Date.now() + 500));
    out = core.settle(sessionId, id);
  }
  if (out.status !== 'pending') {
    closeOwnerTab(key);
    refreshBadge();
  }
  return out;
}

/* A settled request if the user allowed it; otherwise throws what they said. */
function allowed(sessionId, kind, subject, out) {
  const what = kind === 'site' ? `this session on ${subject}` : kind === 'function' ? 'that function' : 'that script';
  switch (out.status) {
    case 'approved': return out;
    case 'denied': throw new Error(`The user did not allow ${what}. Do not ask again unless they tell you to.`);
    case 'expired': throw new Error(`The user did not answer within 100 s about ${what}. Ask them in chat before trying again.`);
    default: core.authorize(sessionId); throw new Error(`the request about ${what} was cancelled`);
  }
}

/* Asks the user in Firefox and waits for their answer. Returns the settled
 * request ({ subject, fnId? }); throws if they say no, does not answer, or
 * control ends meanwhile. */
async function askUser(sessionId, kind, subject) {
  const id = await putQuestion(sessionId, kind, subject);
  return allowed(sessionId, kind, subject, await answerOf(sessionId, id, REQUEST_TTL_MS + 500));
}

browser.windows.onRemoved.addListener((windowId) => core.windowRemoved(windowId));

// Closing a question's tab without choosing is a refusal.
browser.tabs.onRemoved.addListener((tabId) => {
  for (const [key, id] of ownerTabs) {
    if (id !== tabId) continue;
    ownerTabs.delete(key);
    browser.notifications.clear(key).catch(() => {});
    if (key.startsWith('claim:')) {
      const sessionId = key.slice(6);
      const pending = core.view().pending.find((p) => p.sessionId === sessionId);
      if (pending) core.decide(sessionId, pending.code, false);
    } else {
      core.answer(key.slice(4), false);
    }
    wake(key);
    refreshBadge();
  }
});

/* Messages from the add-on's own pages (confirm, ask, toolbar popup).
 * Anything else (a content script, the agent's page scripts) is ignored. */
browser.runtime.onMessage.addListener((msg, sender) => {
  // An action's own page script, waiting to dispatch, asks whether its lease
  // still holds (see act). It learns that and nothing else, and only for
  // the random token it was given, from the tab it was given it in, while
  // the session may still be on the page it is in (Forget can take a site
  // away from a lease that holds).
  if (msg?.type === 'alive' && sender?.id === browser.runtime.id && sender.tab) {
    const a = actLeases.get(String(msg.lease ?? ''));
    return Promise.resolve(Boolean(a) && a.tabId === sender.tab.id && stillLeased(a) && mayStay(a.sessionId, sender.url));
  }
  if (!core.trustedSender(sender, browser.runtime.id, EXT_BASE)) return undefined;
  switch (msg?.type) {
    case 'view': // scripts: whether this build has eval, define and call, for the pairing page
      return Promise.resolve({ ...core.view(), scripts: BUILD.scripts, hostRefused });
    case 'decide': { // approvalsDigest: the remembered approvals the page listed
      const result = core.decide(msg.sessionId, msg.code, msg.approve === true, msg.approvalsDigest);
      if (result.ok) {
        wake(`claim:${msg.sessionId}`);
        refreshBadge();
        closeOwnerTab(`claim:${msg.sessionId}`); // from the confirm tab or the toolbar popup alike
      }
      return Promise.resolve(result);
    }
    case 'answer': {
      const { remember, ...result } = core.answer(String(msg.id), msg.approve === true, { remember: msg.remember === true });
      // Not standing until the host answers that it wrote it (see onHostMessage).
      if (remember && !toHost({ type: 'remember', entry: remember })) {
        core.note(`Not remembered: the Foxlatch host is not running. The session that asked still has it; later sessions will be asked.`);
      }
      settleRequests(); // closes the question's tab, and wakes a call waiting on it
      refreshBadge();
      return Promise.resolve(result);
    }
    case 'forget': { // from the popup: out of use here at once, and pending until the host confirms it
      const entry = core.forget(msg.entry);
      if (!entry) return Promise.resolve({ ok: false, error: 'not a remembered approval' });
      if (toHost({ type: 'forget', entry })) return Promise.resolve({ ok: true, status: 'pending' });
      const error = 'the Foxlatch host is not running, so it is still in the file';
      core.forgetFailed(entry, error);
      return Promise.resolve({ ok: true, status: 'failed', error });
    }
    case 'dismiss': // a notice in the popup, read
      core.dismiss(String(msg.id ?? ''));
      return Promise.resolve({ ok: true });
    case 'revoke': { // one session, named by the popup's Stop button
      const sessionId = String(msg.sessionId ?? '');
      if (core.revoke(sessionId)) {
        const windowId = core.windowOf(sessionId);
        if (windowId !== null) markWindow(windowId, 'Foxlatch (stopped) — ');
      }
      settleRequests();
      refreshBadge();
      return Promise.resolve({ ok: true });
    }
    default:
      return undefined;
  }
});

function refreshBadge() {
  const { leases, pending, requests, configError } = core.view();
  if (configError) {
    browser.browserAction.setBadgeText({ text: '!' });
    browser.browserAction.setBadgeBackgroundColor({ color: '#b91c1c' });
    browser.browserAction.setTitle({ title: `Foxlatch: config.json is broken, so no session can drive this profile: ${configError}` });
    return;
  }
  if (hostRefused) {
    browser.browserAction.setBadgeText({ text: '!' });
    browser.browserAction.setBadgeBackgroundColor({ color: '#b91c1c' });
    browser.browserAction.setTitle({ title: `Foxlatch: no session can drive this profile through this add-on: ${hostRefused}` });
    return;
  }
  const asking = pending.length + requests.length;
  browser.browserAction.setBadgeText({ text: asking ? '?' : leases.length ? String(leases.length) : '' });
  browser.browserAction.setBadgeBackgroundColor({ color: asking ? '#b45309' : '#047857' });
  browser.browserAction.setTitle({
    title: asking ? 'Foxlatch: a session is asking you something'
      : leases.length ? `Foxlatch: driving this profile: ${leases.map((l) => l.label).join(', ')}`
        : 'Foxlatch: no session is driving this profile',
  });
}

const labelOf = (sessionId) => core.view().leases.find((l) => l.sessionId === sessionId)?.label ?? '';

/* ---------- tabs and windows ---------- */

function markWindow(windowId, preface) {
  browser.windows.update(windowId, { titlePreface: preface }).catch(() => {});
}

// When each tab last started a load and last committed a top-frame document,
// on one counter, so a wait can ask for one that came after an action.
// Subframe commits are kept per tab for the frames of its current document.
let tick = 0;
const loadStarts = new Map(); // tabId -> tick
const commits = new Map(); // tabId -> tick
const frameCommits = new Map(); // tabId -> Map frameId -> tick
const committed = (d) => {
  if (d.frameId === 0) { commits.set(d.tabId, ++tick); return; }
  if (!frameCommits.has(d.tabId)) frameCommits.set(d.tabId, new Map());
  frameCommits.get(d.tabId).set(d.frameId, ++tick);
};
// Every document any frame of a tab commits, top or sub, counted per tab and
// never reset while the tab lives: a frame that goes elsewhere and back, or
// one that comes and goes, leaves the same frames but not the same count.
const frameGenerations = new Map(); // tabId -> commits in any of its frames
const frameGeneration = (tabId) => frameGenerations.get(tabId) ?? 0;
browser.webNavigation.onCommitted.addListener((d) => {
  frameGenerations.set(d.tabId, frameGeneration(d.tabId) + 1);
  if (d.frameId === 0) {
    frameCommits.delete(d.tabId); // a new document has none of the old one's frames
    core.framesGone(d.tabId);
    // One restored from the page cache has its frames already, and they may
    // never commit: read them now. A late answer can only hold a lock longer.
    browser.webNavigation.getAllFrames({ tabId: d.tabId }).then((frames) => {
      for (const f of frames || []) if (f.frameId !== 0) core.frameAt(d.tabId, f.frameId, f.url);
    }, () => {});
  } else core.frameAt(d.tabId, d.frameId, d.url); // a frame on a locked site keeps its lock
  committed(d);
});
browser.webNavigation.onReferenceFragmentUpdated.addListener(committed); // a #fragment: same document, new place

/* Which document a frame shows, as the ticks of the tab's last top-frame
 * commit and, for a frame, of its own: a reload, or leaving and coming back
 * to the same URL, is another document. */
const documentOf = (tabId, frameId) => [commits.get(tabId) ?? null, frameId === 0 ? null : frameCommits.get(tabId)?.get(frameId) ?? null];

browser.tabs.onRemoved.addListener((tabId) => {
  core.tabRemoved(tabId);
  openedBy.delete(tabId);
  loadStarts.delete(tabId);
  stopped.delete(tabId);
  created.delete(tabId);
  commits.delete(tabId);
  frameCommits.delete(tabId);
  frameGenerations.delete(tabId);
  for (const key of lastDoc.keys()) if (key.startsWith(`${tabId}:`)) lastDoc.delete(key);
});
// Where each owned tab is, so a site lock ends once its holder's tabs leave.
browser.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url) core.tabAt(tabId, info.url);
  if (info.status === 'loading') loadStarts.set(tabId, ++tick);
});

// A page in an agent tab that opens a new tab (target=_blank, window.open)
// hands that tab to the session that owns the opener, while it drives. The
// action that caused it reports the new tab (see landing).
const openedBy = new Map(); // tabId -> { opener, at }
// Tabs onCreated has handled: only one it has not yet may be handed over by
// its first load (guardLoad), never a tab the user opened while no session drove.
const created = new Set();
function adopt(tab) {
  if (tab.openerTabId === undefined || core.ownerOf(tab.id)) return core.ownerOf(tab.id);
  const owner = core.view().leases.find((l) => core.tabsOf(l.sessionId).includes(tab.openerTabId));
  if (!owner) return null;
  core.ownTab(tab.id, owner.sessionId);
  if (tab.url) core.tabAt(tab.id, tab.url);
  openedBy.set(tab.id, { opener: tab.openerTabId, at: Date.now() });
  return owner.sessionId;
}
browser.tabs.onCreated.addListener((tab) => { created.add(tab.id); adopt(tab); });
// A popup window (window.open with features) may carry no openerTabId.
browser.webNavigation.onCreatedNavigationTarget.addListener((d) => adopt({ id: d.tabId, openerTabId: d.sourceTabId, url: d.url }));

/* Every load in a session's tab, top document or frame, redirects included,
 * is checked before Firefox sends it: open and navigate ask first (gate), but
 * a link, a form, a redirect or the page's own script moves a tab with no
 * tool call. A refused site, a protected one this session was not allowed
 * on, or a site another session holds never loads (a frame may still show a
 * protected site, which no script of the session's can reach); one that may
 * load takes or refreshes this session's lock on it. The next report on the
 * tab says what was stopped. The user's own tabs are never touched. */
const stopped = new Map(); // tabId -> { url, why }
function guardLoad(d) {
  if (d.tabId < 0) return {};
  const sessionId = core.ownerOf(d.tabId);
  if (sessionId) return checkLoad(sessionId, d);
  // A tab a page just opened may load before onCreated hands it over.
  if (d.type !== 'main_frame' || created.has(d.tabId) || !core.view().leases.length) return {};
  return browser.tabs.get(d.tabId).then((tab) => {
    const owner = adopt(tab);
    return owner ? checkLoad(owner, d) : {};
  }, () => ({}));
}
function checkLoad(sessionId, d) {
  try { core.authorize(sessionId); } catch { return {}; } // control has ended: the tab is the user's again
  const top = d.type === 'main_frame';
  const why = top ? core.urlRefusal(d.url, sessionId) : core.hardRefusal(d.url) || core.lockRefusal(d.url, sessionId);
  if (why) {
    // A stopped page is news; a stopped frame does not hide it.
    if (top || !stopped.has(d.tabId)) stopped.set(d.tabId, { url: d.url, why, frame: !top, at: ++tick });
    if (top) wake(`stopped:${d.tabId}`);
    return { cancel: true };
  }
  // Takes or refreshes the lock where the session may act. A frame on a
  // protected site it was not allowed on loads without one (enter refuses,
  // and that is ignored on purpose): no tool reaches that frame, and a lock
  // here would let any page with a sign-in widget hold the sign-in.
  core.enter(sessionId, d.url);
  return {};
}
/* The page cache restores a document (back, forward) with no request, so
 * guardLoad never sees it: a top document that appears in a session's tab on
 * a page the session may not be on is sent away as soon as it is there. */
function guardCommit(d) {
  if (d.frameId !== 0 || !/^https?:/i.test(String(d.url))) return;
  const sessionId = core.ownerOf(d.tabId);
  if (!sessionId) return;
  try { core.authorize(sessionId); } catch { return; }
  const why = core.urlRefusal(d.url, sessionId);
  if (!why) {
    core.enter(sessionId, d.url); // as a requested load does: the restored page takes or refreshes its lock
    return;
  }
  stopped.set(d.tabId, { url: d.url, why, frame: false, at: ++tick });
  wake(`stopped:${d.tabId}`);
  browser.tabs.update(d.tabId, { url: 'about:blank' }).catch(() => {});
}
browser.webNavigation.onCommitted.addListener(guardCommit);
browser.webRequest.onBeforeRequest.addListener(guardLoad, { urls: ['http://*/*', 'https://*/*'], types: ['main_frame', 'sub_frame', 'object'] }, ['blocking']);

/* Resolves true if it gave up waiting. With `after` (a tick taken before
 * the caller sent the tab somewhere), only a load that started after it
 * counts: the page before, or the blank tab open starts with, finishing is
 * not the new page. A page the load guard stopped ends the wait at once. */
function waitLoaded(tabId, timeoutMs = NAV_TIMEOUT_MS, after = null) {
  return new Promise((resolve) => {
    let timer;
    const stop = onWake(`stopped:${tabId}`);
    const done = (timedOut) => {
      browser.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      stop.forget();
      resolve(timedOut);
    };
    const ours = () => after === null || (loadStarts.get(tabId) ?? -1) > after;
    const halted = stopped.get(tabId); // stopped before this wait began listening
    if (after !== null && halted && !halted.frame && halted.at > after) { resolve(false); stop.forget(); return; }
    // The blank page open starts from may report its own load late, after
    // the real one began: a load that ends on about:blank is not the page.
    const listener = (id, info, tab) => { if (id === tabId && info.status === 'complete' && tab?.url !== 'about:blank' && ours()) done(false); };
    timer = setTimeout(() => done(true), timeoutMs);
    stop.woken.then(() => done(false));
    browser.tabs.onUpdated.addListener(listener);
    browser.tabs.get(tabId).then((t) => { if (t.status === 'complete' && t.url !== 'about:blank' && ours()) done(false); }, () => done(false));
  });
}

/* A tab on a page the session may not use reports its URL only: titles of
 * mail and account pages carry addresses and unread counts. */
async function describe(sessionId, tabId, timedOut = false) {
  const t = await browser.tabs.get(tabId);
  // A call that waited on a load can outlive its lease: the tab is the
  // user's by now, and where they took it is not the session's to hear.
  core.checkTab(sessionId, tabId);
  const refusal = t.url === 'about:blank' ? null : core.urlRefusal(t.url, sessionId);
  const notes = [];
  if (timedOut) notes.push(`still loading after ${NAV_TIMEOUT_MS / 1000}s`);
  const stop = stopped.get(tabId);
  if (stop) {
    stopped.delete(tabId);
    notes.push(`Foxlatch stopped ${stop.frame ? 'a frame of this tab' : 'this tab'} from loading ${stop.url}: ${stop.why}`);
  }
  if (refusal) notes.push(`${refusal}; until then this tab can only be navigated or closed`);
  return { tabId: t.id, url: t.url, ...(refusal ? {} : { title: t.title }), loading: t.status !== 'complete', ...(notes.length ? { note: notes.join('; ') } : {}) };
}

/* Lease and ownership, then the page the tab is showing right now; acting
 * there takes or refreshes this session's lock on a locked site. */
async function usableTab(sessionId, tabId) {
  core.checkTab(sessionId, tabId);
  const tab = await browser.tabs.get(tabId);
  core.tabAt(tabId, tab.url);
  const refusal = core.enter(sessionId, tab.url);
  if (refusal) throw new Error(refusal);
  return tab;
}

/* Before open or navigate: a site another session holds is refused before
 * the user is asked anything; a protected site this session has not been
 * allowed on waits for their answer; then the session takes the site's lock. */
async function gate(sessionId, url) {
  const early = core.hardRefusal(url) || core.lockRefusal(url, sessionId);
  if (early) throw new Error(early);
  const site = core.protectedSite(url);
  if (site && !core.granted(sessionId, site)) await askUser(sessionId, 'site', site);
  const refusal = core.enter(sessionId, url);
  if (refusal) throw new Error(refusal);
}

/* Runs PAGE[name] in a frame. `url` is the page the caller checked: the
 * script re-checks its host before doing anything (see pageScript). The
 * session must still hold the tab as the script goes in and as its result
 * comes out: Stop can land while the caller waits on Firefox, and the tab is
 * then the user's, whatever page they take it to. */
async function inFrame(sessionId, tabId, frameId, name, args, url) {
  core.checkTab(sessionId, tabId);
  try {
    const [result] = await browser.tabs.executeScript(tabId, { code: pageScript(name, args, new URL(url).hostname), frameId });
    core.checkTab(sessionId, tabId);
    return result;
  } catch (e) {
    // Firefox's own refusal on its restricted domains (addons.mozilla.org,
    // accounts.firefox.com and the like): no add-on may run there.
    if (/Missing host permission/i.test(String(e?.message))) {
      throw new Error(`Firefox does not let add-ons read or act on ${new URL(url).hostname} (it keeps addons.mozilla.org, `
        + 'Mozilla account pages and its own pages from every add-on); the user must do this part themselves');
    }
    throw e;
  }
}

/* A ref names its document's tag, then the element: "ae3"; one from a
 * frame other than the top one starts with its frame: "f12:ae3". A ref
 * without a tag ("e3") is taken to mean the frame's last snapshot. Tags are
 * letters without e and f, so a ref reads one way only. */
function parseRef(ref) {
  const m = /^(?:f(\d+):)?([a-df-z]*)(e\d+)$/.exec(String(ref || ''));
  if (!m) throw new Error(`bad ref ${ref}; use a ref as snapshot lists it, like ae12 or f3:ae12`);
  return { frameId: m[1] ? Number(m[1]) : 0, doc: m[2] || null, ref: m[3] };
}

/* Every snapshot gives the documents it reads a tag no snapshot had before;
 * a document keeps the first it is given (PAGE.snapshot), so no two
 * documents ever share one, and a ref from one is refused in any other. */
const TAG_LETTERS = 'abcdghijklmnopqrstuvwxyz';
let snapshots = 0;
const newTag = () => {
  let t = '';
  for (let n = ++snapshots; n > 0; n = Math.floor((n - 1) / TAG_LETTERS.length)) t = TAG_LETTERS[(n - 1) % TAG_LETTERS.length] + t;
  return t;
};
const lastDoc = new Map(); // 'tabId:frameId' -> the tag of the document its last snapshot read
const docOf = (tabId, target) => target.doc ?? lastDoc.get(`${tabId}:${target.frameId}`);

/* A whole number from lo to hi; anything that is not a finite number is the default. */
function count(value, lo, hi, fallback) {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(hi, Math.max(lo, n));
}

function parseFrame(frame) {
  if (frame === undefined || frame === null || frame === '') return 0;
  const m = /^f?(\d+)$/.exec(String(frame));
  if (!m) throw new Error(`bad frame ${frame}; frames look like f12`);
  return Number(m[1]);
}

/* The URL of a frame the session may use, or throws. */
async function frameUsable(sessionId, tab, frameId) {
  if (frameId === 0) return tab.url;
  const frame = await browser.webNavigation.getFrame({ tabId: tab.id, frameId }).catch(() => null);
  if (!frame) throw new Error(`frame f${frameId} is gone; take a new snapshot`);
  const refusal = core.enter(sessionId, frame.url);
  if (refusal) throw new Error(refusal);
  return frame.url;
}

/* Every frame of a tab as [frameId, url], or throws if one shows a page
 * this session may not see: refused, protected and not allowed to it, or
 * held by another session. A frame with no address of its own (about:blank,
 * srcdoc, data:) shows what its parent put there; a blob: frame is its
 * creator's origin. */
async function framesShown(sessionId, tabId) {
  const frames = await browser.webNavigation.getAllFrames({ tabId });
  if (!frames) throw new Error('the tab\'s frames could not be listed, so no screenshot was taken');
  const shown = frames.map((f) => [f.frameId, String(f.url)]).sort((a, b) => a[0] - b[0]);
  for (const [frameId, url] of shown) {
    if (/^(about:(blank|srcdoc)([?#]|$)|data:)/.test(url)) continue;
    const refusal = core.urlRefusal(url.startsWith('blob:') ? url.slice(5) : url, sessionId);
    if (refusal) throw new Error(`no screenshot: ${frameId === 0 ? 'the page' : `frame f${frameId} (${url})`} may not be shown: ${refusal}`);
  }
  return shown;
}

/* ---------- waiting ---------- */

/* Whether href contains pattern, where * in pattern stands for any run of
 * characters. No regex: this runs in the background page, where one
 * pathological pattern would stall every session. Taking each piece at its
 * earliest place after the last leaves the most room for the rest, so one
 * pass decides it. */
function urlContains(pattern) {
  const parts = pattern.split('*');
  return (href) => {
    let at = 0;
    for (const part of parts) {
      const i = href.indexOf(part, at);
      if (i < 0) return false;
      at = i + part.length;
    }
    return true;
  };
}

/* What wait_for, or an action's waitFor, waits on, checked before anything
 * runs: text or selector in the top frame, url (a substring of the tab's
 * URL, where * matches any run of characters), load (the tab finished
 * loading). Every condition given must hold; gone waits for text, selector
 * and url to stop matching. */
function condition(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('waitFor is an object: {text|selector|url|load, gone, timeoutMs}');
  const text = spec.text ? String(spec.text) : null;
  const selector = spec.selector ? String(spec.selector) : null;
  const url = spec.url ? String(spec.url) : null;
  const load = spec.load === true;
  const gone = spec.gone === true;
  if (!text && !selector && !url && !load) throw new Error('pass text, selector, url or load: true');
  if (url && url.length > 2000) throw new Error('keep url under 2000 characters');
  const urlMatch = url ? urlContains(url) : null;
  // The server and host budget their own wait from the same number; one
  // they would read differently (NaN, "0xEA60", [60000]) is refused here.
  const ms = spec.timeoutMs === undefined ? 15000 : spec.timeoutMs;
  if (typeof ms !== 'number' || !Number.isFinite(ms)) throw new Error(`timeoutMs is a number of milliseconds, 0 to ${WAIT_MAX_MS}`);
  const named = [text && `text ${JSON.stringify(text)}`, selector && `selector ${selector}`, url && `url ${url}`].filter(Boolean);
  return {
    text, selector, urlMatch, load, gone,
    timeoutMs: Math.max(0, Math.min(ms, WAIT_MAX_MS)),
    label: [named.length && `${named.join(' and ')}${gone ? ' gone' : ''}`, load && 'loaded'].filter(Boolean).join(', '),
  };
}

/* Waits for cond from here, injecting one short check per poll, so a
 * navigation or reload between polls only means the next poll runs on the
 * new page. Every poll re-checks the lease, the tab and the page it shows,
 * as usableTab does: a tab that moves to a page this session may not use
 * ends the wait, and nothing runs there; the lease ending stops it at once.
 * `after` holds ticks a load (load) or a top-frame commit (commit) in the
 * tab must come after before cond counts. Returns { met, ms, why }. */
async function waitUntil(sessionId, tabId, cond, after = {}) {
  const start = Date.now();
  const deadline = start + cond.timeoutMs;
  const end = leaseEnd(sessionId);
  // Why the last check the page answered did not meet cond, and in which
  // document: a reason from a page the tab has since left says nothing.
  let answered = null;
  try {
    for (;;) {
      core.authorize(sessionId);
      const tab = await browser.tabs.get(tabId).catch(() => null);
      if (!tab) throw new Error(`tab ${tabId} was closed while waiting`);
      core.checkTab(sessionId, tabId);
      core.tabAt(tabId, tab.url);
      const blank = tab.url === 'about:blank'; // a new tab before its first page commits
      const refusal = blank ? null : core.enter(sessionId, tab.url);
      if (refusal) throw new Error(`stopped waiting: tab ${tabId} moved to ${tab.url}. ${refusal}`);
      const why = await end.or(unmet(sessionId, tab, cond, blank, deadline, after));
      if (!why) return { met: true, ms: Date.now() - start };
      if (why !== CUT_OFF) answered = { why, document: commits.get(tabId) };
      const left = deadline - Date.now();
      if (left <= 0) {
        const same = answered && answered.document === commits.get(tabId);
        const told = why !== CUT_OFF ? why : same ? answered.why : 'the last check was cut off at the deadline';
        return { met: false, ms: Date.now() - start, why: told };
      }
      await end.or(pause(Math.min(POLL_MS, left)));
    }
  } finally {
    end.forget();
  }
}

/* Why cond does not hold on the tab right now, or '' when it does. A check
 * that cannot run (the page is mid-navigation) is a miss, retried next poll;
 * one that hangs (a dialog) is cut off at the deadline. A page still loading
 * has not yet rendered what it will show, so it cannot meet gone. */
async function unmet(sessionId, tab, cond, blank, deadline, after) {
  if (after.commit !== undefined && !(commits.get(tab.id) > after.commit)) return 'the new page has not committed yet';
  if (cond.load && tab.status !== 'complete') return 'the tab is still loading';
  if (cond.load && after.load !== undefined && !(loadStarts.get(tab.id) > after.load)) return 'no load has started since the action';
  if (cond.urlMatch && cond.urlMatch(tab.url) === cond.gone) return `the tab is at ${tab.url}`;
  if (!cond.text && !cond.selector) return '';
  if (blank) return 'no page has loaded yet';
  if (cond.gone && tab.status !== 'complete') return 'the page is still loading';
  let seen;
  const budget = Math.max(0, deadline - Date.now());
  try {
    seen = await Promise.race([
      inFrame(sessionId, tab.id, 0, 'present', { text: cond.text, selector: cond.selector }, tab.url),
      pause(budget).then(() => null),
    ]);
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg.startsWith('bad selector')) throw e;
    return `the page could not be checked: ${msg}`;
  }
  // A check given under CUT_OFF_MS that lost the race says nothing about the
  // page; only one that had time and still got no answer means it is stuck.
  if (!seen) return budget < CUT_OFF_MS ? CUT_OFF : 'the page did not answer (it may be showing a dialog)';
  if (cond.text && seen.text === cond.gone) return cond.gone ? 'the text is still there' : 'the text is not on the page';
  if (cond.selector && seen.selector === cond.gone) return cond.gone ? 'the selector still matches' : 'nothing matches the selector';
  return '';
}

const outcome = (cond, r) => `${cond.label} ${r.met ? 'met' : 'not met'} after ${(r.ms / 1000).toFixed(1)}s${r.met ? '' : ` (${r.why})`}`;

/* Tabs a tab's page opened since `at` (target=_blank, window.open) that
 * onCreated handed to this session. */
const openedSince = (sessionId, tabId, at) => [...openedBy]
  .filter(([id, o]) => o.opener === tabId && o.at >= at && core.tabsOf(sessionId).includes(id)).map(([id]) => id);

/* Where a tab is now, and any tab its page opened since `at`. */
async function landing(sessionId, tabId, at) {
  const here = await describe(sessionId, tabId);
  const opened = [];
  for (const id of openedSince(sessionId, tabId, at)) {
    const d = await describe(sessionId, id).catch(() => null);
    if (d) opened.push(d);
  }
  return { ...here, ...(opened.length ? { opened } : {}) };
}

/* The moment an action starts: its time, for the tabs it opens, and its
 * tick, for the loads it starts. */
const mark = () => ({ at: Date.now(), tick });

/* After an action ran (`did` says what it did): let the page react, wait
 * for the caller's condition or else for a load the action started, then
 * say where the tab is. load waits for a load that started after the
 * action. A url or load condition after an action that opened exactly one
 * tab is about that tab; when the action opened any, the result says which
 * tab the condition was checked on. */
async function settle(sessionId, tabId, cond, since, did) {
  await pause(150);
  let waited = null;
  let on = tabId;
  try {
    if (cond) {
      const fresh = cond.text || cond.selector ? [] : openedSince(sessionId, tabId, since.at);
      if (fresh.length === 1) [on] = fresh;
      // A tab the action opened had no load before it; only the acting tab can show a stale one.
      waited = outcome(cond, await waitUntil(sessionId, on, cond, on === tabId ? { load: since.tick } : {}));
    } else if ((await browser.tabs.get(tabId)).status === 'loading') await waitLoaded(tabId, 15000);
  } catch (e) {
    throw new Error(`${did}, then ${String(e?.message || e)}`);
  }
  const at = await landing(sessionId, tabId, since.at);
  if (waited && on !== tabId) waited += `, checked on tab ${on}, which the action opened`;
  else if (waited && at.opened) waited += `, checked on tab ${tabId}, where the action ran`;
  return { ...(waited ? { waitFor: waited } : {}), ...at };
}

function report(out, { waitFor, url, title, loading, note, opened = [] }) {
  const parts = [out];
  if (waitFor) parts.push(waitFor);
  parts.push(`now at ${url}${title ? ` (${title})` : ''}`);
  if (loading) parts.push('still loading');
  if (note) parts.push(note);
  for (const t of opened) parts.push(`opened tab ${t.tabId} at ${t.url}${t.title ? ` (${t.title})` : ''}${t.loading ? ', still loading' : ''}`);
  return parts.join('; ');
}

/* An action that waits for its element (up to 2 s, in the page) asks before
 * each later try whether its lease still holds: the token names this action,
 * its session and tab, and the lease it started under. */
const actLeases = new Map(); // token -> { sessionId, tabId, since }
const leaseSince = (sessionId) => core.view().leases.find((l) => l.sessionId === sessionId)?.since ?? null;
function mayStay(sessionId, url) {
  try { return core.urlRefusal(String(url), sessionId) === null; } catch { return false; }
}
function stillLeased(a) {
  try { core.checkTab(a.sessionId, a.tabId); } catch { return false; }
  return leaseSince(a.sessionId) === a.since;
}

async function act(sessionId, { tabId, ref, waitFor, ...rest }, action) {
  const tab = await usableTab(sessionId, tabId);
  const cond = waitFor == null ? null : condition(waitFor);
  const target = ref ? parseRef(ref) : { frameId: 0, ref: undefined };
  const url = await frameUsable(sessionId, tab, target.frameId);
  const since = mark();
  const lease = nonce();
  actLeases.set(lease, { sessionId, tabId, since: leaseSince(sessionId) });
  let out;
  try {
    out = await inFrame(sessionId, tabId, target.frameId, 'act', { ...rest, ref: target.ref, doc: ref ? docOf(tabId, target) : undefined, lease, action }, url);
  } finally {
    actLeases.delete(lease);
  }
  return report(out, await settle(sessionId, tabId, cond, since, out));
}

/* ---------- tools ---------- */

const TOOLS = {
  /* Pairing: these four work without a lease. */
  async status(sessionId) {
    const v = core.view();
    return {
      profile: v.profile,
      drivers: v.leases.map((l) => ({ label: l.label, since: l.since, you: l.sessionId === sessionId })),
      claim: core.claimStatus(sessionId),
    };
  },

  async claim(sessionId) {
    const result = core.claim(sessionId);
    if (result.status === 'refused') {
      // The user looks for the pairing page; it says why there is nothing to allow.
      await openOwnerTab(`claim:${sessionId}`, `confirm.html#${encodeURIComponent(sessionId)}`);
      refreshBadge();
      throw new Error(result.error);
    }
    if (result.status === 'pending') {
      if (result.fresh) {
        // An unanswered pairing expires with no call waiting on it; its tab
        // and notification go then, so a later request opens its own.
        const timer = setTimeout(() => endedClaim(sessionId), CLAIM_TTL_MS + 500);
        timer?.unref?.(); // see putQuestion
      }
      await openOwnerTab(`claim:${sessionId}`, `confirm.html#${encodeURIComponent(sessionId)}`);
    }
    refreshBadge();
    // Reading its own files takes a moment at startup; a connect never waits on it for long.
    let timer;
    const addon = await Promise.race([addonCode, new Promise((resolve) => { timer = setTimeout(() => resolve(null), 2000); })]);
    clearTimeout(timer);
    return { ...result, profile: core.profile.name, addon };
  },

  async await_claim(sessionId, { timeoutMs = 90000 }) {
    if (core.claimStatus(sessionId) === 'pending') await waitFor(`claim:${sessionId}`, Math.min(timeoutMs, 110000));
    const status = core.claimStatus(sessionId);
    endedClaim(sessionId);
    if (status === 'granted') {
      const windowId = core.windowOf(sessionId);
      if (windowId !== null) markWindow(windowId, `Foxlatch · ${labelOf(sessionId)} — `);
    }
    return { status, profile: core.profile.name };
  },

  async release(sessionId) {
    const windowId = core.windowOf(sessionId);
    const released = core.release(sessionId, 'released by the session');
    if (released && windowId !== null) markWindow(windowId, 'Foxlatch (released) — ');
    closeOwnerTab(`claim:${sessionId}`);
    wake(`claim:${sessionId}`);
    settleRequests();
    refreshBadge();
    return released ? 'released' : 'this session was not driving the profile';
  },

  /* Everything below requires this session's lease. */
  async tabs(sessionId) {
    core.authorize(sessionId);
    return Promise.all(core.tabsOf(sessionId).map((id) => describe(sessionId, id)));
  },

  async open(sessionId, { url }) {
    core.authorize(sessionId);
    await gate(sessionId, String(url));
    let windowId = core.windowOf(sessionId);
    let tab = null;
    // Blank first, and the session's before it loads anything, so the load
    // guard sees every request of the page, its redirects included.
    if (windowId !== null) tab = await browser.tabs.create({ windowId, url: 'about:blank', active: true }).catch(() => null);
    if (!tab) {
      const win = await browser.windows.create({ url: 'about:blank', focused: true });
      windowId = win.id;
      core.setWindow(sessionId, windowId);
      tab = win.tabs[0];
    }
    markWindow(windowId, `Foxlatch · ${labelOf(sessionId)} — `);
    core.ownTab(tab.id, sessionId); // throws if control ended while the tab was made: it is the user's
    const since = tick;
    await browser.tabs.update(tab.id, { url }); // where it lands reaches core through onUpdated
    return describe(sessionId, tab.id, await waitLoaded(tab.id, NAV_TIMEOUT_MS, since));
  },

  async navigate(sessionId, { tabId, url, waitFor }) {
    core.checkTab(sessionId, tabId);
    const cond = waitFor == null ? null : condition(waitFor);
    const history = { back: 'goBack', forward: 'goForward', reload: 'reload' };
    let since;
    if (Object.hasOwn(history, url)) {
      // Reloading a locked site another session holds would act on it; a
      // step back or forward could land on one, and where is unknown until it has.
      const held = url === 'reload' ? core.lockRefusal((await browser.tabs.get(tabId)).url, sessionId) : core.historyRefusal(sessionId);
      if (held) throw new Error(held);
      core.checkTab(sessionId, tabId); // control may have ended while Firefox answered
      since = tick;
      await browser.tabs[history[url]](tabId);
    } else {
      await gate(sessionId, String(url));
      core.checkTab(sessionId, tabId); // control may have ended while the user was asked
      since = tick;
      await browser.tabs.update(tabId, { url });
    }
    await pause(250);
    if (!cond) return describe(sessionId, tabId, await waitLoaded(tabId, NAV_TIMEOUT_MS, url === 'reload' || !Object.hasOwn(history, url) ? since : null));
    // Until the new document commits, the tab still shows the old one, which may meet cond.
    const waited = outcome(cond, await waitUntil(sessionId, tabId, cond, { commit: since }));
    return { ...(await describe(sessionId, tabId)), waitFor: waited };
  },

  async close(sessionId, { tabId }) {
    core.checkTab(sessionId, tabId);
    await browser.tabs.remove(tabId);
    return 'closed';
  },

  async show(sessionId, { tabId }) {
    core.checkTab(sessionId, tabId);
    const tab = await browser.tabs.update(tabId, { active: true });
    await browser.windows.update(tab.windowId, { focused: true, drawAttention: true });
    return 'shown';
  },

  async snapshot(sessionId, { tabId, max = 300, filter }) {
    const tab = await usableTab(sessionId, tabId);
    const frames = (await browser.webNavigation.getAllFrames({ tabId })) || [{ frameId: 0, url: tab.url }];
    const out = [];
    const near = []; // when a filter matches nothing: the closest lines, from every frame
    let budget = Math.max(1, Math.min(max, 2000));
    let skipped = 0;
    let top = null;
    for (const f of frames.sort((a, b) => a.frameId - b.frameId)) {
      const url = f.frameId === 0 ? tab.url : f.url;
      if (f.frameId !== 0 && core.enter(sessionId, url)) continue; // refused, protected or held hosts, about:blank, data:
      let snap;
      try {
        snap = await inFrame(sessionId, tabId, f.frameId, 'snapshot', { max: budget, filter, doc: newTag() }, url);
      } catch (e) {
        if (f.frameId === 0) throw e; // the page itself: say why, never show it as empty
        continue; // a subframe navigated away mid-snapshot, or forbids scripts
      }
      if (!snap) continue;
      if (snap.doc) lastDoc.set(`${tabId}:${f.frameId}`, snap.doc);
      if (f.frameId === 0) top = snap;
      else if (snap.lines.length) out.push(`-- frame f${f.frameId}: ${snap.url}`);
      const prefix = (f.frameId === 0 ? '' : `f${f.frameId}:`) + (snap.doc || '');
      out.push(...snap.lines.map((l) => (/^e\d+ /.test(l) ? prefix + l : l)));
      near.push(...(snap.near || []).map((n) => ({ score: n.score, line: prefix + n.line })));
      budget -= snap.lines.length;
      skipped += snap.skipped;
      if (budget <= 0) break;
    }
    let elements = out.join('\n');
    if (filter && !out.length && near.length) {
      const best = near.sort((a, b) => b.score - a.score).slice(0, 10).map((n) => n.line);
      elements = `no element matches "${filter}"; the nearest lines, as suggestions:\n${best.join('\n')}`;
    }
    return {
      title: top?.title ?? '', url: top?.url ?? '', scroll: top?.scroll ?? '',
      elements: elements + (skipped ? `\n(${skipped} more not shown; raise max or use filter)` : ''),
    };
  },

  /* Elements matching every criterion, across the frames snapshot reads
   * (or inside one ref's element), as snapshot lines with refs. */
  async find(sessionId, { tabId, role, name, text, within, max = 20 }) {
    const tab = await usableTab(sessionId, tabId);
    const given = (v) => (v === undefined || v === null || v === '' ? undefined : String(v));
    const criteria = { role: given(role), name: given(name), text: given(text) };
    if (!criteria.role && !criteria.name && !criteria.text) throw new Error('pass role, name or text');
    const limit = count(max, 1, 200, 20);
    const lines = [];
    let matches = 0;
    const take = (frameId, found) => {
      if (found.doc) lastDoc.set(`${tabId}:${frameId}`, found.doc);
      const prefix = (frameId === 0 ? '' : `f${frameId}:`) + (found.doc || '');
      lines.push(...found.lines.map((l) => (/^e\d+ /.test(l) ? prefix + l : l)));
      matches += found.matches;
    };
    if (within) {
      const target = parseRef(within);
      const url = await frameUsable(sessionId, tab, target.frameId);
      take(target.frameId, await inFrame(sessionId, tabId, target.frameId, 'find',
        { ...criteria, within: target.ref, doc: docOf(tabId, target), tag: newTag(), max: limit }, url));
      return { matches, lines };
    }
    const frames = (await browser.webNavigation.getAllFrames({ tabId })) || [{ frameId: 0, url: tab.url }];
    for (const f of frames.sort((a, b) => a.frameId - b.frameId)) {
      const url = f.frameId === 0 ? tab.url : f.url;
      if (f.frameId !== 0 && core.enter(sessionId, url)) continue; // as snapshot: refused, protected or held hosts, about:blank, data:
      let found;
      try {
        found = await inFrame(sessionId, tabId, f.frameId, 'find', { ...criteria, tag: newTag(), max: Math.max(0, limit - lines.length) }, url);
      } catch (e) {
        if (f.frameId === 0) throw e;
        continue; // the frame navigated away mid-find, or forbids scripts
      }
      if (found) take(f.frameId, found);
    }
    return { matches, lines };
  },

  /* A structured read of one scope in one frame: a table, form, list or
   * text blocks, paged by offset and max. */
  async read(sessionId, { tabId, ref, selector, frame, offset = 0, max = 50 }) {
    const tab = await usableTab(sessionId, tabId);
    if (ref && selector) throw new Error('pass ref or selector, not both');
    const target = ref ? parseRef(ref) : { frameId: parseFrame(frame), ref: undefined };
    if (ref && frame !== undefined && frame !== null && frame !== '' && parseFrame(frame) !== target.frameId) {
      throw new Error(`ref ${ref} is in frame f${target.frameId}, not ${frame}`);
    }
    const url = await frameUsable(sessionId, tab, target.frameId);
    const { doc, ...out } = await inFrame(sessionId, tabId, target.frameId, 'read', {
      ref: target.ref, doc: ref ? docOf(tabId, target) : undefined, selector: selector ? String(selector) : undefined,
      tag: newTag(), offset: count(offset, 0, Number.MAX_SAFE_INTEGER, 0), max: count(max, 1, 200, 50),
    }, url);
    if (doc) lastDoc.set(`${tabId}:${target.frameId}`, doc);
    const prefix = (target.frameId === 0 ? '' : `f${target.frameId}:`) + (doc || '');
    for (const unit of [...(out.rows || []), ...(out.items || [])]) unit.refs = unit.refs.map((r) => ({ ...r, ref: prefix + r.ref }));
    for (const field of out.fields || []) field.ref = prefix + field.ref;
    return out;
  },

  async text(sessionId, { tabId, max = 20000, offset = 0, frame }) {
    const tab = await usableTab(sessionId, tabId);
    const frameId = parseFrame(frame);
    const url = await frameUsable(sessionId, tab, frameId);
    return inFrame(sessionId, tabId, frameId, 'text', { offset: count(offset, 0, Number.MAX_SAFE_INTEGER, 0), max: count(max, 1, 200000, 20000) }, url);
  },

  click: (s, p) => act(s, p, 'click'),
  hover: (s, p) => act(s, p, 'hover'),
  type: (s, p) => act(s, { clear: true, ...p }, 'type'),
  select: (s, p) => act(s, p, 'select'),
  key: (s, p) => act(s, p, 'key'),
  scroll: (s, p) => act(s, p, 'scroll'),

  /* waitUntil checks the tab and its page on every poll, so a tab still at
   * about:blank (one a page just opened) is waited on, not refused. */
  async wait_for(sessionId, { tabId, ...spec }) {
    core.checkTab(sessionId, tabId);
    const cond = condition(spec);
    const r = await waitUntil(sessionId, tabId, cond);
    return report(outcome(cond, r), await describe(sessionId, tabId));
  },

  /* A plain pause, so a session never waits on text that will not appear. */
  async sleep(sessionId, { ms }) {
    core.authorize(sessionId);
    const asked = ms;
    if (typeof asked !== 'number' || !Number.isFinite(asked) || asked < 0) throw new Error(`pass ms, 0 to ${SLEEP_MAX_MS}`);
    const slept = Math.min(asked, SLEEP_MAX_MS);
    const end = leaseEnd(sessionId);
    try {
      await end.or(pause(slept));
    } finally {
      end.forget();
    }
    core.authorize(sessionId);
    return `slept ${slept} ms${asked > SLEEP_MAX_MS ? ` (capped at ${SLEEP_MAX_MS}; wait_for waits on the page itself)` : ''}`;
  },

  /* Only in the personal build (scripts.js); refused in any other. */
  ...Object.fromEntries(SCRIPT_METHODS.map((m) => [m, SCRIPTS?.[m] ?? noScripts])),

  /* A picture shows every frame of the tab, so each one must be a page this
   * session may see, before the capture and after it; an image taken while
   * any frame changed is discarded: a different frame list, or any commit in
   * any frame between the two checks, even one that ended where it began. */
  async screenshot(sessionId, { tabId, ref }) {
    const tab = await usableTab(sessionId, tabId);
    const generation = frameGeneration(tabId);
    const before = await framesShown(sessionId, tabId);
    await browser.tabs.update(tabId, { active: true });
    const opts = { format: 'png', scale: 1 };
    if (ref) {
      const target = parseRef(ref);
      if (target.frameId !== 0) throw new Error('element screenshots work in the top frame only; screenshot the whole tab');
      opts.rect = await inFrame(sessionId, tabId, 0, 'rect', { ref: target.ref, doc: docOf(tabId, target) }, tab.url);
    }
    const image = await browser.tabs.captureTab(tab.id, opts);
    let after;
    try {
      core.checkTab(sessionId, tabId);
      after = await framesShown(sessionId, tabId);
    } catch (e) {
      throw new Error(`the screenshot was discarded: ${String(e?.message || e)}`);
    }
    if (frameGeneration(tabId) !== generation || JSON.stringify(after) !== JSON.stringify(before)) {
      throw new Error('the screenshot was discarded: the tab\'s page or one of its frames changed while it was taken; take it again');
    }
    return image;
  },
};

connect();
refreshBadge();
