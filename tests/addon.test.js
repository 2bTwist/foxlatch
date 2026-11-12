// The add-on's background page and toolbar popup, loaded as Firefox loads
// them (plain scripts sharing one global scope) into a vm with a fake
// `browser` API and, for the popup, a minimal DOM. No real Firefox.
// Run: node --test tests/addon.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const source = (f) => fs.readFileSync(path.join(__dirname, '..', 'extension', f), 'utf8');
// The personal build's script path, which only its package holds (foxlatch/build.py).
const SCRIPTS_JS = path.join(__dirname, '..', 'extension-personal', 'scripts.js');

function ev() {
  const s = new Set();
  return { addListener: (f) => s.add(f), removeListener: (f) => s.delete(f), fire: (...a) => [...s].map((f) => f(...a)) };
}

/* ---------- the package's own text ---------- */

// 2026-11-07: an edit tool turned a typed escape into the live character,
// putting bidi controls into ask.js, the page that shows the user the code. A
// source can name these characters only by escape or code point.
test('no file the add-on ships holds a zero-width or bidi control character', () => {
  const ranges = [[0x200b, 0x200f], [0x202a, 0x202e], [0x2066, 0x2069], [0xfeff, 0xfeff]];
  const hidden = new Set(ranges.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => String.fromCharCode(a + i))));
  const found = [];
  const files = [...JSON.parse(source('files.json')).map((n) => [n, source(n)]), ['scripts.js', fs.readFileSync(SCRIPTS_JS, 'utf8')]];
  for (const [name, text] of files) {
    text.split('\n').forEach((line, i) => {
      for (const ch of line) if (hidden.has(ch)) found.push(`${name}:${i + 1} U+${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
    });
  }
  assert.deepEqual(found, []);
});

/* ---------- background.js ---------- */

/* Two driving sessions on Profile 4, with benefits.example.gov exclusive. Tabs
 * keep one step of history, so back loads the page before. A tab may hold
 * iframes (frames: tabId -> Map frameId -> url); a new top document has none
 * of the old one's, and each commit is reported to webNavigation. ran lists
 * every injected script with the frame and the URL it ran on; hangEval makes
 * an eval's page promise never settle. Each document has its own
 * content-script sandbox, which a commit replaces: markDocument and
 * evalInPage run there as injected, guards and all, and executed lists the
 * code that reached the page's eval. beforeScript runs as a script is
 * injected, before it runs; onCapture during a screenshot. scripts: the
 * personal package, which loads scripts.js before background.js, unless a
 * test asks for the public one, which has no such file. */
function background({ scripts = true } = {}) {
  let next = 100;
  const tabs = new Map();
  const history = new Map(); // tabId -> the URL before
  const frames = new Map();
  const calls = [];
  const ran = [];
  // csp: the page forbids eval. present: { text, ms, hang } makes a wait's
  // page check answer that after ms, or never.
  const state = { hangEval: false, csp: false, present: null, beforeScript: null, onCapture: null, redirects: {} };
  const executed = [];
  const captured = [];
  const sandboxes = new Map(); // 'tabId:frameId' -> the content-script sandbox of the document there
  const argsOf = new Map(); // injected code -> the args background.js gave pageScript
  const sandbox = (tabId, frameId, url) => {
    const key = `${tabId}:${frameId}`;
    if (!sandboxes.has(key)) {
      const u = new URL(url);
      const g = vm.createContext({ location: { hostname: u.hostname, origin: u.origin, href: u.href } });
      g.window = g;
      g.wrappedJSObject = { eval: (c) => { executed.push(c); return 'ok'; }, JSON };
      sandboxes.set(key, g);
    }
    return sandboxes.get(key);
  };
  const dropSandboxes = (tabId, frameId = null) => {
    for (const key of [...sandboxes.keys()]) if (key === `${tabId}:${frameId}` || (frameId === null && key.startsWith(`${tabId}:`))) sandboxes.delete(key);
  };
  const notes = new Map(); // notification id -> { title, message } while shown
  const posted = []; // what the add-on sent the host
  // Each connectNative is a new host process with its own port; a port that
  // has disconnected throws on postMessage, as Firefox's does.
  const ports = [];
  const newPort = () => {
    const p = { sent: [], gone: false, onMessage: ev(), onDisconnect: ev(),
      postMessage: (m) => { if (p.gone) throw new Error('Attempt to postMessage on disconnected port'); p.sent.push(m); posted.push(m); } };
    ports.push(p);
    return p;
  };
  let port = null;
  const E = { removed: ev(), created: ev(), updated: ev(), winRemoved: ev(), msg: ev(), committed: ev(), noteClicked: ev(), request: ev() };
  // A load in a tab, as Firefox asks webRequest before it sends it: the
  // add-on's answer, which cancels it or lets it go.
  const load = async (tabId, url, type = 'main_frame') => {
    if (!/^https?:/.test(url)) return 'sent'; // the add-on's filter names http and https only
    const answers = await Promise.all(E.request.fire({ tabId, url, type }));
    return answers.some((a) => a?.cancel) ? 'cancelled' : 'sent';
  };
  const newTab = (windowId, url) => { const t = { id: next++, windowId, url, title: url, status: 'complete' }; tabs.set(t.id, t); return t; };
  // kept: the frames a page restored from the cache comes back with, none of which commits.
  const go = (id, url, kept = null) => {
    const t = tabs.get(id);
    history.set(id, t.url);
    t.url = url;
    if (kept) frames.set(id, new Map(kept)); else frames.delete(id);
    dropSandboxes(id);
    E.committed.fire({ tabId: id, frameId: 0, url });
    E.updated.fire(id, { url, status: 'loading' }, { ...t });
    E.updated.fire(id, { status: 'complete' }, { ...t });
  };
  const frameGoes = (tabId, frameId, url) => {
    if (!frames.has(tabId)) frames.set(tabId, new Map());
    frames.get(tabId).set(frameId, url);
    dropSandboxes(tabId, frameId);
    E.committed.fire({ tabId, frameId, url });
  };
  const browser = {
    runtime: { id: 'x', getURL: (p) => `moz-extension://u/${p}`, onMessage: E.msg,
      connectNative: () => (port = newPort()) },
    windows: {
      async create({ url }) { const id = next++; return { id, tabs: [{ ...newTab(id, url) }] }; },
      async getAll() { return [{ id: 1, focused: true, type: 'normal' }]; },
      async update() {}, onRemoved: E.winRemoved,
    },
    tabs: {
      async create({ windowId, url }) { return { ...newTab(windowId, url) }; },
      async get(id) { const t = tabs.get(id); if (!t) throw new Error('no tab'); return { ...t }; },
      async update(id, p) {
        if (p.url && state.stuck) throw new Error('the tab could not be moved'); // Firefox refused the navigation
        // A redirect is another load of the same tab, asked again (state.redirects: url -> where it sends).
        const run = async () => {
          let url = p.url;
          while (await load(id, url) === 'sent') {
            if (!state.redirects[url]) { go(id, url); break; }
            if (state.lateBlank) { // the page's load begins, then the blank tab's own load reports, late
              E.updated.fire(id, { status: 'loading' }, { ...tabs.get(id) });
              E.updated.fire(id, { status: 'complete' }, { ...tabs.get(id), url: 'about:blank' });
            }
            url = state.redirects[url];
          }
        };
        // As Firefox does, a load runs after update has answered when state.later is set.
        if (p.url) { if (state.later) setTimeout(run, 10); else await run(); }
        return { ...tabs.get(id) };
      },
      async remove(id) { tabs.delete(id); E.removed.fire(id); },
      async goBack(id) { calls.push(['goBack', id]); if (history.has(id)) go(id, history.get(id)); },
      async goForward(id) { calls.push(['goForward', id]); },
      async reload(id) { calls.push(['reload', id]); go(id, tabs.get(id).url); },
      async executeScript(id, { code, frameId = 0 }) {
        const fn = /return \((?:async )?function (\w+)/.exec(code)?.[1];
        const args = argsOf.get(code) || {};
        await state.beforeScript?.({ tabId: id, frameId, fn, args });
        const url = frameId === 0 ? tabs.get(id).url : frames.get(id)?.get(frameId);
        calls.push(['executeScript', id, tabs.get(id).url]);
        ran.push({ tabId: id, frameId, url, fn, args });
        if (fn === 'evalInPage' && state.hangEval) await new Promise(() => {});
        if (fn === 'markDocument' || fn === 'evalInPage') return [await vm.runInContext(code, sandbox(id, frameId, url))];
        if (fn === 'snapshot') return [{ doc: args.doc, url, title: url, scroll: '0 of 0px', lines: ['e1 button "Save"'], skipped: 0 }];
        // A document keeps the tag it was first given; here every one is new.
        if (fn === 'find') return [{ doc: args.tag, matches: 1, lines: ['e1 button "Save"'] }];
        if (fn === 'read') return [{ doc: args.tag, kind: 'table', headers: ['Member'], rows: [{ cells: ['Save'], refs: [{ ref: 'e1', role: 'button', name: 'Save' }, { ref: 'e2', role: 'button', name: 'Delete' }] }], total: 1 }];
        if (fn === 'canEval') { await state.onCanEval?.(); return [!state.csp]; }
        if (fn === 'present' && state.present) {
          await new Promise((r) => setTimeout(r, state.present.ms));
          if (state.present.hang) await new Promise(() => {});
          return [{ text: state.present.text }];
        }
        return ['ok'];
      },
      async captureTab(id) { await state.onCapture?.(); captured.push(id); return 'data:image/png;base64,iVBORw0KGgo='; },
      onRemoved: E.removed, onCreated: E.created, onUpdated: E.updated,
    },
    webNavigation: {
      async getAllFrames({ tabId }) {
        return [{ frameId: 0, url: tabs.get(tabId).url }, ...[...(frames.get(tabId) ?? [])].map(([frameId, url]) => ({ frameId, url }))];
      },
      async getFrame({ tabId, frameId }) {
        if (frameId === 0) return { frameId: 0, url: tabs.get(tabId).url };
        const url = frames.get(tabId)?.get(frameId);
        return url ? { frameId, url } : null;
      },
      onCommitted: E.committed, onReferenceFragmentUpdated: ev(), onCreatedNavigationTarget: ev(),
    },
    webRequest: { onBeforeRequest: { addListener: (f, filter, extra) => { assert.equal(JSON.stringify([filter.types, extra]), '[["main_frame","sub_frame","object"],["blocking"]]'); E.request.addListener(f); } } },
    browserAction: { setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {} },
    notifications: {
      async create(id, { title, message }) { notes.set(id, { title, message }); return id; },
      async clear(id) { return notes.delete(id); },
      onClicked: E.noteClicked,
    },
  };
  // The add-on's own files as its package serves them.
  const fetch = async (url) => {
    const name = String(url).slice('moz-extension://u/'.length);
    const bytes = fs.readFileSync(name === 'scripts.js' ? SCRIPTS_JS : path.join(__dirname, '..', 'extension', name));
    return { ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) };
  };
  const ctx = vm.createContext({ browser, crypto: globalThis.crypto, console, setTimeout, clearTimeout, URL, TextDecoder, TextEncoder, fetch, skew: 0 });
  vm.runInContext('{ const real = Date.now; Date.now = () => real() + globalThis.skew; }', ctx);
  for (const f of ['core.js', 'page.js', ...(scripts ? ['scripts.js'] : []), 'background.js']) {
    vm.runInContext(f === 'scripts.js' ? fs.readFileSync(SCRIPTS_JS, 'utf8') : source(f), ctx, { filename: f });
    if (f === 'page.js') {
      const real = ctx.pageScript;
      ctx.pageScript = (name, args, ...rest) => { const code = real(name, args, ...rest); argsOf.set(code, args); return code; };
    }
  }
  const { core, TOOLS, condition } = vm.runInContext('({ core, TOOLS, condition })', ctx);
  core.configure({ profile: { name: 'Profile 4' }, exclusive: ['benefits.example.gov'] });
  // Labels are core's, from the project (F1): these read acme · aaaa and billing · bbbb.
  for (const [id, project] of [[A, '/home/user/projects/acme'], [B, '/home/user/Projects/billing']]) {
    core.opened(id, project);
    core.decide(id, core.claim(id).code, true);
  }
  const tabAt = (url) => [...tabs.values()].find((t) => t.url === url).id;
  const trusted = (id) => ({ id: 'x', url: `moz-extension://u/ask.html#${id}`, envType: 'addon_child' });
  const answer = async (id, approve = true) => { await Promise.all(E.msg.fire({ type: 'answer', id, approve }, trusted(id))); };
  const evals = () => ran.filter((r) => r.fn === 'evalInPage');
  // A runtime message from one of the add-on's pages (ask.html, popup.html) or from a page's content script.
  const PAGES = {
    ask: { id: 'x', url: 'moz-extension://u/ask.html#r1', envType: 'addon_child' },
    popup: { id: 'x', url: 'moz-extension://u/popup.html', envType: 'addon_child' },
    content: { id: 'x', url: 'https://evil.test/', envType: 'content_child', tab: { id: 1, windowId: 1, url: 'https://evil.test/' } },
  };
  const from = async (page, m) => (await Promise.all(E.msg.fire(m, PAGES[page]))).find((r) => r !== undefined);
  return {
    posted, hostSays: (m) => Promise.all(port.onMessage.fire(m)), hostGone: () => { port.gone = true; port.onDisconnect.fire(); }, ports, from, load, newTab,
    createdTab: (id) => Promise.all(E.created.fire({ ...tabs.get(id) })),
    browser, core, TOOLS, condition, tabs, calls, tabAt, msg: E.msg, advance: (ms) => { ctx.skew += ms; },
    frames, frameGoes, go, ran, evals, state, answer, notes, clickNote: (id) => Promise.all(E.noteClicked.fire(id)),
    executed, captured, fromContent: (m, tabId) => Promise.all(E.msg.fire(m, { id: 'x', url: tabs.get(tabId).url, envType: 'content_child', tab: { id: tabId, windowId: 1, url: tabs.get(tabId).url } })),
  };
}

// reload was checked against the lock; back and forward were not, so a
// session walked its tab back into a portal another session was working in.
test('history: back and forward are refused while another session holds a locked site, before the tab moves', async () => {
  const { TOOLS, tabs, calls, tabAt, advance } = background();
  await TOOLS.open(B, { url: 'https://benefits.example.gov/portal/claims' }); // B was here first
  const bTab = tabAt('https://benefits.example.gov/portal/claims');
  await TOOLS.navigate(B, { tabId: bTab, url: 'https://example.com/' }); // B leaves; the lock frees
  advance(31_000); // past LOCK_GRACE_MS
  await TOOLS.open(A, { url: 'https://benefits.example.gov/portal/claims' });
  for (const step of ['back', 'forward']) {
    await assert.rejects(TOOLS.navigate(B, { tabId: bTab, url: step }),
      /back and forward are refused while acme · aaaa holds benefits\.example\.gov.*navigate by URL instead/);
  }
  assert.deepEqual(calls.filter(([k]) => k === 'goBack' || k === 'goForward'), [], 'a history step ran');
  assert.equal(tabs.get(bTab).url, 'https://example.com/');
  // The holder itself, and anyone once the lock is gone, may step back.
  const aTab = tabAt('https://benefits.example.gov/portal/claims');
  await TOOLS.navigate(A, { tabId: aTab, url: 'https://example.com/a' });
  await TOOLS.navigate(A, { tabId: aTab, url: 'back' });
  assert.equal(tabs.get(aTab).url, 'https://benefits.example.gov/portal/claims');
});

// A wait that ran out reported "the page did not answer (it may be showing a
// dialog)" on 26 of 39 live misses (3-6 Nov): its last check ran with almost
// no time left and lost the race, hiding the reason every earlier check gave.
test('a wait that runs out says why the page missed, not that a page that answered is stuck', async () => {
  const { TOOLS, tabAt, state } = background();
  await TOOLS.open(A, { url: 'https://example.com/claims' });
  const tab = tabAt('https://example.com/claims');
  state.present = { text: false, ms: 20 };
  for (const timeoutMs of [600, 700, 1100]) {
    const out = await TOOLS.wait_for(A, { tabId: tab, text: 'Saved', timeoutMs });
    assert.match(out, /^text "Saved" not met after [\d.]+s \(the text is not on the page\)/, `timeoutMs ${timeoutMs}: ${out}`);
  }
  // A page that never answers a check given time still says so.
  state.present = { hang: true, ms: 0 };
  assert.match(await TOOLS.wait_for(A, { tabId: tab, text: 'Saved', timeoutMs: 1500 }), /not met after [\d.]+s \(the page did not answer/);
});

// 1 in 6 live evals (3-6 Nov) was refused by the page's CSP only after
// the user had read and allowed it.
test('a page that forbids eval refuses eval and define before the user is asked', async () => {
  const { TOOLS, core, tabAt, state, evals, notes } = background();
  await TOOLS.open(A, { url: 'https://example.com/' });
  const tab = tabAt('https://example.com/');
  state.csp = true;
  for (const call of [TOOLS.eval(A, { tabId: tab, code: '1' }), TOOLS.define(A, { tabId: tab, code: '(n) => n' })]) {
    const out = await outcomeOf(call);
    assert.match(out.error ?? '', /Content Security Policy forbids eval, so the user was not asked/);
  }
  assert.deepEqual(plain(core.view().requests), [], 'the user was asked anyway');
  assert.equal(notes.size, 0);
  assert.equal(evals().length, 0);
  state.csp = false;
  assert.equal((await TOOLS.eval(A, { tabId: tab, code: '1' })).status, 'pending');
});

// 3 of 19 script questions and 2 pairings ran out unseen on 3-6 Nov while
// the user was in another app.
test('a question and a pairing notify the user without the code, and the notice goes when they stop waiting', async () => {
  const { TOOLS, core, tabAt, answer, notes, clickNote } = background();
  await TOOLS.open(A, { url: 'https://example.com/claims' });
  const tab = tabAt('https://example.com/claims');
  const code = 'document.title = "SECRET-CODE-7"';
  const q = await TOOLS.eval(A, { tabId: tab, code });
  const note = notes.get(`req:${q.question}`);
  assert.ok(note, 'no notification for the question');
  assert.match(`${note.title} ${note.message}`, /acme · aaaa.*run a script on example\.com/);
  assert.doesNotMatch(JSON.stringify(note), /SECRET-CODE-7|claims/, 'the notification shows the code or the page');
  await clickNote(`req:${q.question}`); // only brings the tab forward
  assert.equal(core.requestOf(q.question).status, 'pending', 'clicking the notification answered the question');
  await answer(q.question);
  assert.equal(notes.has(`req:${q.question}`), false, 'the notification outlived the question');
  // A pairing names the session and profile, never its code.
  const C = 'c'.repeat(32);
  core.opened(C, '/home/user/Projects/gym-app');
  const claim = await TOOLS.claim(C);
  const pairing = notes.get(`claim:${C}`);
  assert.match(`${pairing.title} ${pairing.message}`, /gym-app · cccc on Profile 4/);
  assert.equal(JSON.stringify(pairing).includes(claim.code), false, 'the notification shows the pairing code');
  await TOOLS.release(C);
  assert.equal(notes.has(`claim:${C}`), false);
});

test('a script question carries the session\'s one-line purpose and the notes on its code, for the page that asks', async () => {
  const { TOOLS, core, tabAt } = background();
  await TOOLS.open(A, { url: 'https://example.com/' });
  const tab = tabAt('https://example.com/');
  await TOOLS.eval(A, { tabId: tab, code: 'fetch("/x")', purpose: 'Checks\nthe totals‮' + 'x'.repeat(300) });
  await TOOLS.define(A, { tabId: tab, code: '(id) => document.getElementById(id).click()' });
  const [script, fn] = plain(core.view().requests);
  assert.equal(JSON.parse(script.subject).purpose, `Checks the totals ${'x'.repeat(182)}`);
  assert.deepEqual(script.notes.map((n) => n.kind), ['network']);
  assert.equal(JSON.parse(fn.subject).purpose, '', 'a define without a purpose');
  assert.deepEqual(fn.notes.map((n) => n.kind), ['reads', 'changes']);
});

/* Found by attacking the change above (2026-11-07). */

test('a pairing that expires unanswered loses its tab and notification, and a new request notifies again', async () => {
  const { CLAIM_TTL_MS } = require('../extension/core.js');
  const { TOOLS, core, notes, advance } = background();
  const C = 'c'.repeat(32);
  core.opened(C, '/home/user/Projects/gym-app');
  await TOOLS.claim(C);
  assert.ok(notes.has(`claim:${C}`));
  advance(CLAIM_TTL_MS + 1000);
  assert.equal((await TOOLS.await_claim(C, { timeoutMs: 0 })).status, 'expired');
  assert.equal(notes.has(`claim:${C}`), false, 'the notification outlived the expired pairing');
  await TOOLS.claim(C);
  assert.ok(notes.has(`claim:${C}`), 'a new request after expiry was not notified');
});

test('the script check before asking has a deadline, and stops when control ends', async () => {
  const { TOOLS, core, tabAt, state } = background();
  await TOOLS.open(A, { url: 'https://example.com/' });
  const tab = tabAt('https://example.com/');
  state.onCanEval = () => new Promise(() => {}); // a page stuck on an alert
  const stuck = await outcomeOf(TOOLS.eval(A, { tabId: tab, code: '1' }));
  assert.match(stuck.error ?? '', /did not answer within 3 s whether it allows scripts .* so the user was not asked/);
  const ending = outcomeOf(TOOLS.define(A, { tabId: tab, code: '(n) => n' }));
  await turn();
  core.revoke(A);
  await TOOLS.release(A);
  const out = await Promise.race([ending, new Promise((r) => setTimeout(() => r('HUNG'), 1000))]);
  assert.match(out.error ?? String(out), /not connected/);
  assert.deepEqual(plain(core.view().requests), []);
});

test('an eval question binds the page and document as they are after the script check', async () => {
  const { TOOLS, tabs, tabAt, state, go, answer, evals } = background();
  await TOOLS.open(A, { url: 'https://example.com/a' });
  const tab = tabAt('https://example.com/a');
  state.onCanEval = async () => { state.onCanEval = null; go(tab, 'https://example.com/b'); };
  const q = await TOOLS.eval(A, { tabId: tab, code: '1' });
  tabs.get(tab).url = 'https://example.com/a'; // replaceState back, no new document
  await answer(q.question);
  const out = await outcomeOf(TOOLS.await_question(A, { id: q.question, timeoutMs: 1000 }));
  assert.match(out.error ?? JSON.stringify(out), /moved to https:\/\/example\.com\/a after the user allowed the script/);
  assert.equal(evals().length, 0, 'ran in a document the user was never shown');
});

test('a wait cut off on a new page does not give the old page\'s reason', async () => {
  const { TOOLS, tabAt, state, go } = background();
  await TOOLS.open(A, { url: 'https://example.com/a' });
  const tab = tabAt('https://example.com/a');
  state.present = { text: false, ms: 20 };
  setTimeout(() => { state.present = { hang: true, ms: 0 }; go(tab, 'https://example.com/b'); }, 150);
  const out = await TOOLS.wait_for(A, { tabId: tab, text: 'Saved', timeoutMs: 1100 });
  assert.doesNotMatch(out, /the text is not on the page/, out);
  assert.match(out, /not met after [\d.]+s \((the last check was cut off at the deadline|the page did not answer)/);
});

// Since F1 the session says only its project, from which core makes the
// label: a project that is not one plain line is no project.
test('a session label is one line of plain text on the user\'s pages and notifications', async () => {
  const { TOOLS, core, notes } = background();
  const C = 'c'.repeat(32);
  core.opened(C, '/home/user/billing\n· cccc‮​gnp.exe');
  await TOOLS.claim(C);
  const { label, project } = core.view().pending.find((p) => p.sessionId === C);
  assert.deepEqual([label, project], ['no project · cccc', '']);
  assert.match(notes.get(`claim:${C}`).message, /^no project · cccc on /);
});

// A JavaScript regex ran in the background page, where a pathological
// pattern would stall every session's calls.
test('wait url: a substring, or a glob where * matches any run; never a regex', () => {
  const { condition } = background();
  const url = (pattern) => condition({ url: pattern }).urlMatch;
  assert.equal(url('/claims\\/\\d+$/')('https://example.com/claims/42'), false, 'a /regex/ is plain text now');
  assert.equal(url('/claims\\/\\d+$/')('https://example.com/claims\\/\\d+$/'), true);
  assert.equal(url('/(/')('https://example.com/'), false, 'no regex syntax to be bad');
  assert.equal(url('/claims/')('https://example.com/claims/42'), true);
  assert.equal(url('example.com/claims/*/edit')('https://example.com/claims/42/edit?x=1'), true);
  assert.equal(url('example.com/claims/*/edit')('https://example.com/claims/edit'), false);
  assert.equal(url('*claims*42*')('https://example.com/claims/42'), true);
  assert.equal(url('claims*43')('https://example.com/claims/42'), false);
  assert.equal(url('*')('https://example.com/'), true);
  const started = Date.now();
  assert.equal(url('/(a+)+b/')(`https://x.test/${'a'.repeat(40)}`), false);
  assert.equal(url(`${'*a'.repeat(250)}*b`)(`https://x.test/${'a'.repeat(100_000)}`), false);
  assert.ok(Date.now() - started < 500, `matching took ${Date.now() - started} ms`);
  assert.throws(() => url('x'.repeat(2001)), /under 2000 characters/);
});

// eval returns before the user answers, so no call is left waiting to close
// the question's tab when it times out or control ends.
test('a question no call is waiting on still closes its tab when it expires or control ends', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { REQUEST_TTL_MS } = require('../extension/core.js');
  const { TOOLS, tabs, tabAt, advance } = background();
  await TOOLS.open(A, { url: 'https://example.com/' });
  const tab = tabAt('https://example.com/');
  const asking = () => [...tabs.values()].filter((x) => x.url.includes('ask.html#')).map((x) => x.url.split('#')[1]);
  const ask = (code) => Promise.race([TOOLS.eval(A, { tabId: tab, code }), new Promise((r) => setImmediate(() => r('eval waited for the user')))]);

  const first = await ask('1');
  assert.equal(first.status, 'pending', first);
  assert.deepEqual(asking(), [first.question]);
  advance(REQUEST_TTL_MS + 1);
  t.mock.timers.tick(REQUEST_TTL_MS + 1000);
  assert.deepEqual(asking(), [], 'the expired question\'s tab stayed open');

  const second = await ask('2');
  assert.deepEqual(asking(), [second.question]);
  await TOOLS.release(A);
  assert.deepEqual(asking(), [], 'the cancelled question\'s tab stayed open');
});

// settleRequests wakes waits and sleeps whose lease ended; one question
// ending must not reach another question, or another call, of either session.
test('a question that expires or is refused leaves every other question and call alone', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { REQUEST_TTL_MS } = require('../extension/core.js');
  const { TOOLS, core, tabs, tabAt, msg, advance } = background();
  const later = (ms) => { advance(ms); t.mock.timers.tick(ms); };
  await TOOLS.open(A, { url: 'https://example.com/a' });
  await TOOLS.open(B, { url: 'https://example.com/b' });
  const [aTab, bTab] = [tabAt('https://example.com/a'), tabAt('https://example.com/b')];
  const asking = () => [...tabs.values()].filter((x) => x.url.includes('ask.html#')).map((x) => x.url.split('#')[1]).sort();
  const track = (p) => { const s = { done: false }; p.then((v) => { s.done = true; s.value = v; }, (e) => { s.done = true; s.error = String(e.message); }); return s; };
  const flush = () => new Promise((r) => setImmediate(r));

  const q1 = (await TOOLS.eval(A, { tabId: aTab, code: '1' })).question;
  later(75_000);
  const q2 = (await TOOLS.define(A, { tabId: aTab, code: '() => 2' })).question;
  const q3 = (await TOOLS.eval(B, { tabId: bTab, code: '3' })).question;
  const calls = {
    aAwait: track(TOOLS.await_question(A, { id: q2, timeoutMs: 110_000 })),
    bAwait: track(TOOLS.await_question(B, { id: q3, timeoutMs: 110_000 })),
    bSleep: track(TOOLS.sleep(B, { ms: 30_000 })),
  };
  await flush();

  later(REQUEST_TTL_MS - 75_000 + 1000); // q1's own timer: it expires
  await flush();
  assert.equal(core.requestOf(q1).status, 'expired');
  assert.deepEqual(asking(), [q2, q3].sort());
  assert.deepEqual([core.requestOf(q2).status, core.requestOf(q3).status], ['pending', 'pending']);
  assert.deepEqual(Object.entries(calls).filter(([, c]) => c.done).map(([k]) => k), [], 'q1 expiring woke another call');

  const trusted = { id: 'x', url: `moz-extension://u/ask.html#${q2}`, envType: 'addon_child' };
  await Promise.all(msg.fire({ type: 'answer', id: q2, approve: false }, trusted));
  await flush();
  assert.match(calls.aAwait.error, /did not allow that function/);
  assert.deepEqual(asking(), [q3]);
  assert.equal(core.requestOf(q3).status, 'pending');
  assert.equal(calls.bAwait.done || calls.bSleep.done, false, 'refusing q2 woke a call of the other session');
  assert.equal(core.view().leases.length, 2);
});

/* ---------- an Allow is for what the user was shown ---------- */

const outcomeOf = (p) => p.then((v) => ({ ok: v }), (e) => ({ error: String(e.message) }));
const turn = () => new Promise((r) => setImmediate(r));
const plain = (x) => JSON.parse(JSON.stringify(x)); // out of the vm's realm, for deepEqual
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// The URL was compared only for the top frame, so an iframe that navigated
// between Allow and collection got the script on a page the user never saw.
test('a frame script the user allowed does not run once the frame shows another page, or its page another document', async () => {
  const { TOOLS, frameGoes, evals, tabAt, answer } = background();
  await TOOLS.open(A, { url: 'https://example.com/page' });
  const tab = tabAt('https://example.com/page');
  frameGoes(tab, 7, 'https://widget.example/a');
  const q = await TOOLS.eval(A, { tabId: tab, frame: 'f7', code: 'document.body.innerHTML' });
  assert.equal(q.status, 'pending');
  await answer(q.question);
  frameGoes(tab, 7, 'https://other.example/b'); // a link in it, or its parent sets src
  const moved = await outcomeOf(TOOLS.await_question(A, { id: q.question, timeoutMs: 1000 }));
  assert.match(moved.error ?? '', /frame f7 moved to https:\/\/other\.example\/b after the user allowed the script; it did not run/);

  frameGoes(tab, 7, 'https://widget.example/a');
  const again = await TOOLS.eval(A, { tabId: tab, frame: 'f7', code: 'document.body.innerHTML' });
  await answer(again.question);
  frameGoes(tab, 7, 'https://widget.example/a'); // the frame reloads: same URL, another document
  const reloaded = await outcomeOf(TOOLS.await_question(A, { id: again.question, timeoutMs: 1000 }));
  assert.match(reloaded.error ?? '', /page in frame f7 was reloaded or replaced after the user allowed the script/);
  assert.deepEqual(evals(), [], 'the approved script ran in a frame the user was not shown');

  const shown = await TOOLS.eval(A, { tabId: tab, frame: 'f7', code: '1' });
  await answer(shown.question);
  assert.equal((await TOOLS.await_question(A, { id: shown.question, timeoutMs: 1000 })).value, 'ok');
  assert.deepEqual(evals().map((r) => [r.frameId, r.url]), [[7, 'https://widget.example/a']]);
});

// ask.html showed "On page <top page>" for a script that runs in an iframe.
test('a frame script\'s question records the frame it runs in and the page around it', async () => {
  const { TOOLS, core, frameGoes, tabAt } = background();
  await TOOLS.open(A, { url: 'https://example.com/page' });
  const tab = tabAt('https://example.com/page');
  frameGoes(tab, 7, 'https://widget.example/a');
  const q = await TOOLS.eval(A, { tabId: tab, frame: 'f7', code: '1' });
  const subject = JSON.parse(core.requestOf(q.question).subject); // what ask.js shows
  assert.equal(subject.url, 'https://widget.example/a', `ask.html tells the user the script runs "On page ${subject.url}"`);
  assert.equal(subject.top, 'https://example.com/page');
  assert.equal(subject.frameId, 7);
});

// The top-frame check compared URLs only: leaving and coming back to the
// same URL (a new document, perhaps other content) passed, and an Allow
// held for an hour was still redeemable.
test('an Allow is for the document shown: a new document at the same URL, much later, does not run it', async () => {
  const { TOOLS, evals, tabAt, answer, advance } = background();
  await TOOLS.open(A, { url: 'https://example.com/claims/1' });
  const tab = tabAt('https://example.com/claims/1');
  const q = await TOOLS.eval(A, { tabId: tab, code: 'submitAll()' });
  await answer(q.question);
  await TOOLS.navigate(A, { tabId: tab, url: 'https://example.com/claims/2' });
  await TOOLS.navigate(A, { tabId: tab, url: 'https://example.com/claims/1' }); // a new document, same URL
  advance(60 * 60 * 1000); // an hour later, same lease
  const out = await outcomeOf(TOOLS.await_question(A, { id: q.question, timeoutMs: 1000 }));
  assert.equal(evals().length, 0, `the script approved for the first document ran in a later one an hour on (${JSON.stringify(out)})`);
});

test('an Allow is for the document shown: a reload at the same URL does not run it', async () => {
  const { TOOLS, evals, tabAt, answer, go } = background();
  await TOOLS.open(A, { url: 'https://example.com/claims/1' });
  const tab = tabAt('https://example.com/claims/1');
  const q = await TOOLS.eval(A, { tabId: tab, code: 'submitAll()' });
  await answer(q.question);
  go(tab, 'https://example.com/claims/1');
  const out = await outcomeOf(TOOLS.await_question(A, { id: q.question, timeoutMs: 1000 }));
  assert.match(out.error ?? '', /the page was reloaded or replaced after the user allowed the script, though its URL is the same; it did not run/);
  assert.equal(evals().length, 0);
});

test('an Allow nobody collects lapses: the script never runs and the function is gone', async () => {
  const { COLLECT_TTL_MS } = require('../extension/core.js');
  const { TOOLS, core, evals, tabAt, answer, advance } = background();
  await TOOLS.open(A, { url: 'https://example.com/' });
  const tab = tabAt('https://example.com/');
  const script = await TOOLS.eval(A, { tabId: tab, code: '1' });
  const fn = await TOOLS.define(A, { tabId: tab, code: '(n) => n' });
  await answer(script.question);
  await answer(fn.question);
  advance(COLLECT_TTL_MS - 1000);
  assert.equal(core.requestOf(script.question).status, 'approved', 'it lapsed early');
  advance(2000);
  for (const q of [script, fn]) {
    const out = await outcomeOf(TOOLS.await_question(A, { id: q.question, timeoutMs: 1000 }));
    assert.match(out.error ?? '', /no call collected it within 100 s of their answer, so the Allow lapsed and nothing ran/);
  }
  assert.equal(evals().length, 0);
  assert.deepEqual(plain(core.view().leases.find((l) => l.sessionId === A).functions), [], 'a lapsed function stays callable');
});

/* ---------- a question collected once ---------- */

// A retry the agent sent while the first await was still waiting: the
// script ran once, which is right, but the other call was told the request
// "was cancelled", inviting the agent to ask the user again.
test('two awaits on one question: the script runs once, and the other call is told it is taken, not cancelled', async () => {
  const { TOOLS, evals, tabAt, answer } = background();
  await TOOLS.open(A, { url: 'https://example.com/' });
  const tab = tabAt('https://example.com/');
  const q = await TOOLS.eval(A, { tabId: tab, code: 'submit()' });
  const first = outcomeOf(TOOLS.await_question(A, { id: q.question, timeoutMs: 5000 }));
  const second = outcomeOf(TOOLS.await_question(A, { id: q.question, timeoutMs: 5000 }));
  await turn();
  await answer(q.question);
  const results = await Promise.all([first, second]);
  assert.equal(evals().length, 1, 'ran other than once');
  const misreport = results.find((r) => /cancelled/.test(r.error ?? ''));
  assert.equal(misreport, undefined, `one call says "${misreport?.error}" while the script ran for the other`);
  assert.deepEqual(results.map((r) => r.ok?.status).sort(), ['done', 'running']);
  assert.deepEqual(plain(await TOOLS.await_question(A, { id: q.question, timeoutMs: 1000 })), { status: 'ran', question: q.question, kind: 'eval' });
});

// evalInPage awaits the page's promise with no limit, and the server gives
// up at wait + 40 s; the retry was told to ask again while it still ran.
test('a retry while the approved script still runs is told it is running, not to ask again', async () => {
  const { TOOLS, state, tabAt, answer, evals } = background();
  await TOOLS.open(A, { url: 'https://example.com/' });
  const tab = tabAt('https://example.com/');
  const q = await TOOLS.eval(A, { tabId: tab, code: 'fetch("/submit", {method: "POST"})' });
  await answer(q.question);
  state.hangEval = true;
  TOOLS.await_question(A, { id: q.question, timeoutMs: 1000 }).catch(() => {}); // the server gives up on this one
  await turn();
  assert.equal(evals().length, 1, 'the first collection is running the script');
  const retry = await outcomeOf(TOOLS.await_question(A, { id: q.question, timeoutMs: 1000 }));
  assert.doesNotMatch(String(retry.error ?? JSON.stringify(retry.ok)), /asks a new one/,
    'the retry is told to ask again while the approved script is still running');
  assert.deepEqual(plain(retry.ok), { status: 'running', question: q.question, kind: 'eval' });
  assert.equal(evals().length, 1);
});

// askUser always settled (deleted) its request; a question its session
// never collected stayed in core for the life of the add-on, code and all.
test('a session\'s questions are forgotten when its control ends, waiting or allowed and not collected', async () => {
  const { TOOLS, core, tabAt, answer } = background();
  await TOOLS.open(A, { url: 'https://example.com/' });
  const tab = tabAt('https://example.com/');
  const waiting = await TOOLS.eval(A, { tabId: tab, code: 'x'.repeat(19_000) });
  const allowed = await TOOLS.eval(A, { tabId: tab, code: '2' });
  await answer(allowed.question);
  await TOOLS.release(A);
  for (const q of [waiting, allowed]) {
    assert.equal(core.requestOf(q.question), null,
      `request ${q.question} is still held after control ended (status ${core.requestOf(q.question)?.status}, ${core.requestOf(q.question)?.subject?.length} chars)`);
  }
});

/* ---------- remembered approvals ---------- */

/* Sessions from two projects, paired through the host's own opened message. */
async function remembering() {
  const env = background();
  const ids = { C: 'c'.repeat(32), D: 'd'.repeat(32), E: 'e'.repeat(32) };
  for (const [id, project] of [[ids.C, BILLING], [ids.D, BILLING], [ids.E, '/home/user/Projects/gym-app']]) {
    await env.hostSays({ type: 'opened', sessionId: id, project });
    env.core.decide(id, env.core.claim(id).code, true);
  }
  // the user pairs a session again, allowing the remembered approvals its page lists.
  const repair = (id) => {
    env.core.release(id, 'r');
    env.core.claim(id);
    const p = env.core.view().pending.find((q) => q.sessionId === id);
    assert.equal(env.core.decide(id, p.code, true, p.approvalsDigest).ok, true);
  };
  return { ...env, ...ids, repair };
}
const BILLING = '/home/user/Projects/billing';
const asksOf = (posted, type) => posted.filter((m) => m.type === type);

test('an Allow with Remember asks the host to write it, and a function stands for its project only once the host says it wrote it', async () => {
  const { sha256 } = require('../extension/core.js');
  const { TOOLS, core, tabAt, from, posted, hostSays, evals, C, D, E, repair } = await remembering();
  const code = '(row) => document.querySelectorAll("tr")[row].innerText';
  await TOOLS.open(C, { url: 'https://example.com/c' });
  const q = await TOOLS.define(C, { tabId: tabAt('https://example.com/c'), code, purpose: 'Reads a row.' });
  assert.equal((await from('ask', { type: 'answer', id: q.question, approve: true, remember: true })).ok, true);
  const [ask] = asksOf(posted, 'remember');
  assert.deepEqual({ ...ask.entry, added: 0 },
    { project: BILLING, kind: 'function', origin: 'https://example.com', sha256: sha256(code), added: 0, label: 'billing · cccc' });
  assert.equal(JSON.stringify(ask).includes('Reads a row'), false, 'the session\'s words went into the file');

  for (const id of [D, E]) await TOOLS.open(id, { url: `https://example.com/${id[0]}` });
  const page = { [D]: 'https://example.com/d', [E]: 'https://example.com/e' };
  const define = (id, c = code) => TOOLS.define(id, { tabId: tabAt(page[id]), code: c });
  assert.equal((await define(D)).status, 'pending', 'standing before the host wrote it');
  await hostSays({ type: 'remembered', approvals: [ask.entry], did: ask });
  assert.equal((await define(D)).status, 'pending', 'a lease from before the remember got it (F1b)');
  repair(D); // paired again, with the function listed; its old tab is the user's now
  page[D] = 'https://example.com/d2';
  await TOOLS.open(D, { url: page[D] });
  const done = await define(D);
  assert.deepEqual({ ...done, fn: 'f' }, { status: 'done', kind: 'function', fn: 'f', origin: 'https://example.com' });
  assert.equal(await TOOLS.call(D, { tabId: tabAt(page[D]), fn: done.fn, args: [2] }), 'ok');
  assert.equal(evals().length, 1);
  assert.equal((await define(E)).status, 'pending', 'another project');
  assert.equal((await define(D, `${code};`)).status, 'pending', 'a changed byte');
  assert.equal(asksOf(posted, 'remember').length, 1);
  // A host that fails the write leaves it as it was: nothing new stands.
  const other = { ...ask.entry, origin: 'https://other.example' };
  await hostSays({ type: 'remembered', approvals: [ask.entry], did: { type: 'remember', entry: other }, error: 'could not save: disk full' });
  assert.deepEqual(plain(core.view().approvals), plain([ask.entry]));
});

test('a remembered site skips the question for its project once the host wrote it; an eval is never remembered', async () => {
  const { TOOLS, core, tabAt, from, posted, hostSays, advance, C, D, E, repair } = await remembering();
  const opening = TOOLS.open(C, { url: 'https://mail.google.com/mail/u/0/' });
  await turn();
  const [r] = plain(core.view().requests);
  await from('ask', { type: 'answer', id: r.id, approve: true, remember: true });
  await opening;
  const [ask] = asksOf(posted, 'remember');
  assert.deepEqual({ ...ask.entry, added: 0 }, { project: BILLING, kind: 'site', site: 'mail.google.com', added: 0, label: 'billing · cccc' });
  await TOOLS.navigate(C, { tabId: tabAt('https://mail.google.com/mail/u/0/'), url: 'https://example.com/' }); // C leaves; its lock frees
  advance(31_000);
  assert.equal(core.granted(D, 'mail.google.com'), false, 'standing before the host wrote it');
  await hostSays({ type: 'remembered', approvals: [ask.entry], did: ask });
  assert.equal(core.granted(D, 'mail.google.com'), false, 'a lease from before the remember got it (F1b)');
  repair(D);
  const opened = await Promise.race([TOOLS.open(D, { url: 'https://mail.google.com/mail/u/1/' }), turn().then(() => turn()).then(() => 'ASKED')]);
  assert.equal(opened.url, 'https://mail.google.com/mail/u/1/');
  assert.deepEqual(plain(core.view().requests), [], 'D was asked');
  assert.equal(core.granted(E, 'mail.google.com'), false, 'another project');
  // An eval answered with remember is allowed once and remembered never.
  const q = await TOOLS.eval(D, { tabId: tabAt('https://mail.google.com/mail/u/1/'), code: '1' });
  await from('ask', { type: 'answer', id: q.question, approve: true, remember: true });
  assert.equal(asksOf(posted, 'remember').length, 1);
});

test('forget from the popup ends a remembered approval at once; a host started later is asked again to drop it', async () => {
  const { TOOLS, core, tabAt, from, posted, hostSays, D, repair } = await remembering();
  const code = '(n) => n';
  const entry = { project: BILLING, kind: 'function', origin: 'https://example.com', sha256: require('../extension/core.js').sha256(code), added: 5, label: 'billing · cccc' };
  await hostSays({ type: 'hello', profile: { name: 'Profile 4' }, deny: [], approvals: [entry] });
  repair(D); // a hello comes before any lease; this one was paired before it
  await TOOLS.open(D, { url: 'https://example.com/d' });
  const tab = tabAt('https://example.com/d');
  const { fn } = await TOOLS.define(D, { tabId: tab, code });
  assert.deepEqual(plain(await from('popup', { type: 'forget', entry })), { ok: true, status: 'pending' });
  assert.deepEqual(plain(asksOf(posted, 'forget')), [{ type: 'forget', entry }]);
  assert.deepEqual(plain(core.view().approvals), []);
  await assert.rejects(TOOLS.call(D, { tabId: tab, fn, args: [] }), /no approved function/, 'a function approved through it outlived the forget');
  assert.equal((await TOOLS.define(D, { tabId: tab, code })).status, 'pending');
  // The host restarts before it wrote the forget: the new one still lists it.
  await hostSays({ type: 'hello', profile: { name: 'Profile 4' }, deny: [], approvals: [entry] });
  assert.deepEqual(plain(core.view().approvals), []);
  assert.deepEqual(asksOf(posted, 'forget').length, 2);
  assert.deepEqual(plain(core.view().forgets).map((f) => f.status), ['pending']);
});

test('a session cannot remember or forget: no tool does it, and a page\'s content script is not heard', async () => {
  const { core, from, posted, hostSays } = await remembering();
  const entry = { project: BILLING, kind: 'site', site: 'mail.google.com', added: 5, label: 'billing · cccc' };
  for (const method of ['remember', 'forget', 'answer', 'hostApprovals', '__proto__', 'constructor']) {
    await hostSays({ id: 9, sessionId: 'c'.repeat(32), method, params: { entry, id: 'r1', approve: true, remember: true } });
  }
  // Besides answers, the add-on sends the host only its build's hello at start.
  const sent = () => posted.filter((m) => m.type !== 'hello');
  assert.deepEqual(sent().map((m) => [m.id, m.ok, /unknown method/.test(m.error)]), Array(6).fill([9, false, true]));
  await hostSays({ type: 'remembered', approvals: [entry], did: { type: 'remember', entry } });
  assert.equal(await from('content', { type: 'forget', entry }), undefined);
  assert.equal(await from('content', { type: 'answer', id: 'r1', approve: true, remember: true }), undefined);
  assert.deepEqual(plain(core.view().approvals), [entry]);
  assert.equal(sent().some((m) => m.type), false, 'a remember or forget reached the host');
});

/* ---------- popup.js ---------- */

class Node {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.kids = [];
    this.attrs = {};
    this.dataset = {};
    this.listeners = {};
    this.className = '';
    this.disabled = false;
    this.own = '';
    const names = () => this.className.split(' ').filter(Boolean);
    this.classList = {
      add: (c) => { if (!names().includes(c)) this.className = [...names(), c].join(' '); },
      remove: (c) => { this.className = names().filter((n) => n !== c).join(' '); },
      contains: (c) => names().includes(c),
    };
  }

  set textContent(t) { this.own = String(t); this.kids = []; }
  get textContent() { return this.own + this.kids.map((k) => (typeof k === 'string' ? k : k.textContent)).join(''); }
  get children() { return this.kids.filter((k) => typeof k !== 'string'); }
  append(...kids) { this.kids.push(...kids); }
  replaceChildren(...kids) { this.own = ''; this.kids = [...kids]; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  click() { if (!this.disabled) for (const fn of this.listeners.click || []) fn(); }
  all() { return [this, ...this.children.flatMap((c) => c.all())]; }
  querySelectorAll(sel) {
    return this.all().slice(1).filter((n) => (sel.startsWith('.') ? n.className.split(' ').includes(sel.slice(1)) : n.tagName === sel.toUpperCase()));
  }
}

/* popup.html's sections, with a clock that only moves when the test says. */
function popup(view) {
  const ids = Object.fromEntries(['profile', 'status', 'pending', 'remembered', 'deny'].map((id) => [id, new Node('section')]));
  const document = {
    getElementById: (id) => ids[id],
    createElement: (tag) => new Node(tag),
    querySelectorAll: (sel) => Object.values(ids).flatMap((n) => n.querySelectorAll(sel)),
  };
  const sent = [];
  let clock = 1_000_000;
  let timers = [];
  let nextTimer = 0;
  const later = (fn, ms, every) => { const id = ++nextTimer; timers.push({ id, at: clock + ms, fn, every }); return id; };
  const cancel = (id) => { timers = timers.filter((t) => t.id !== id); };
  const ctx = vm.createContext({
    document, window: { close() {} },
    browser: { runtime: { sendMessage: async (msg) => { sent.push(msg); return msg.type === 'view' ? structuredClone(view.current) : { ok: true }; } } },
    setTimeout: (fn, ms) => later(fn, ms), clearTimeout: cancel,
    setInterval: (fn, ms) => later(fn, ms, ms), clearInterval: cancel,
    Number, JSON, String, Math,
  });
  ctx.Date = class extends Date { static now() { return clock; } };
  const settle = () => new Promise((r) => setImmediate(r));
  const advance = async (ms) => {
    const until = clock + ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      clock = due.at;
      cancel(due.id);
      if (due.every) timers.push({ ...due, at: clock + due.every });
      due.fn();
      await settle();
    }
    clock = until;
    await settle();
  };
  for (const f of ['ui.js', 'popup.js']) vm.runInContext(source(f), ctx, { filename: f });
  const armMs = vm.runInContext('typeof ARM_MS === "number" ? ARM_MS : 1200', ctx);
  const allows = () => ids.pending.querySelectorAll('button').filter((b) => b.textContent === 'Allow');
  return { ids, advance, settle, armMs, allows, sent };
}

const pending = (sessionId, label, code, approvals = []) => ({ sessionId, label, project: 'acme', code, created: 1_000_000, expires: 1_180_000, approvals });
// As background.js answers a page's view in the personal build (scripts: true).
const emptyView = () => ({ profile: { name: 'Profile 4' }, deny: [], leases: [], pending: [], requests: [], approvals: [],
  builtIn: require('../extension/core.js').createCore().view().builtIn, protectAdded: [], scripts: true });

// A row that shifts under the pointer (another request arrives above it)
// must not take a second quick click meant for the row that was there.
test('popup: Allow arms after the confirm page\'s delay, and every Allow re-arms when the pending list changes', async () => {
  const view = { current: { ...emptyView(), pending: [pending(A, 'acme · aaaa', '111 111')] } };
  const p = popup(view);
  await p.settle();
  assert.equal(p.allows().length, 1);
  assert.equal(p.allows()[0].disabled, true, 'Allow is live the moment the popup opens');
  await p.advance(p.armMs - 1);
  assert.equal(p.allows()[0].disabled, true);
  await p.advance(1);
  assert.equal(p.allows()[0].disabled, false);

  view.current = { ...view.current, pending: [pending(B, 'billing · bbbb', '222 222'), ...view.current.pending] };
  await p.advance(5000 - p.armMs); // to the popup's own refresh, 5 s after it opened
  assert.equal(p.allows().length, 2);
  assert.deepEqual(p.allows().map((b) => b.disabled), [true, true], 'the list changed under the pointer and Allow stayed live');
  await p.advance(p.armMs);
  assert.deepEqual(p.allows().map((b) => b.disabled), [false, false]);
  await p.advance(5000); // nothing changed: nothing re-arms
  assert.deepEqual(p.allows().map((b) => b.disabled), [false, false]);
});

test('popup: a function question reads as approving a function, a script as running one', async () => {
  const ask = (id, kind) => ({ id, sessionId: A, label: 'acme · aaaa', kind, subject: '{}', created: 1_000_000, expires: 1_100_000 });
  const p = popup({ current: { ...emptyView(), requests: [ask('r1', 'function'), ask('r2', 'eval')] } });
  await p.settle();
  const lines = p.ids.pending.querySelectorAll('.who').map((n) => n.textContent);
  assert.deepEqual(lines, ['acme · aaaa asks to approve a function', 'acme · aaaa asks to run a script']);
});

/* ---------- ask.js ---------- */

/* ask.html with one question in the view; returns its elements once shown. */
async function askPage(request, extra = {}) {
  const ids = Object.fromEntries(['profile', 'label', 'title', 'target-k', 'target', 'code', 'explain', 'allow-label',
    'expires', 'hold-hint', 'outcome', 'allow', 'deny', 'said', 'purpose', 'seen', 'notes', 'remember-row', 'remember', 'remember-label']
    .map((id) => [id, new Node(id === 'allow' || id === 'deny' ? 'button' : 'span')]));
  const document = {
    getElementById: (id) => ids[id], createElement: (tag) => new Node(tag), addEventListener() {}, visibilityState: 'visible', title: '',
  };
  const view = { profile: { name: 'Profile 4' }, requests: [{ ...request, expires: Date.now() + 100_000 }], ...extra };
  const sent = [];
  const ctx = vm.createContext({
    document, location: { hash: `#${request.id}` }, URL, JSON, Math, Date, String, Boolean,
    browser: { runtime: { sendMessage: async (msg) => { sent.push(msg); return msg.type === 'view' ? structuredClone(view) : { ok: true }; } } },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
  });
  for (const f of ['ui.js', 'ask.js']) vm.runInContext(source(f), ctx, { filename: f });
  await turn();
  const out = Object.fromEntries(Object.entries(ids).map(([k, n]) => [k, n.textContent]));
  return Object.assign(out, { $: ids, sent, run: (js) => vm.runInContext(js, ctx) });
}

test('ask.js: a frame script shows the frame it runs in, in a frame of its page; a top-frame script shows the page', async () => {
  const subject = (frameId, url) => JSON.stringify({ tabId: 1, frameId, url, top: 'https://example.com/page', document: [1, 2], code: '1' });
  const frame = await askPage({ id: 'r1', sessionId: A, label: 'acme · aaaa', kind: 'eval', subject: subject(7, 'https://widget.example/a') });
  assert.equal(frame.target, 'widget.example/a');
  assert.equal(frame['target-k'], 'In a frame of example.com');
  assert.match(frame.title, /in a frame/);
  const top = await askPage({ id: 'r2', sessionId: A, label: 'acme · aaaa', kind: 'eval', subject: subject(0, 'https://example.com/page') });
  assert.equal(top.target, 'example.com/page');
  assert.equal(top['target-k'], 'On page');
});

const approval = (kind, extra) => ({ project: 'acme', kind, added: 1_000_000, label: 'acme · aaaa', ...extra });
const SITE_OK = approval('site', { site: 'mail.google.com' });
const FN_OK = approval('function', { origin: 'https://portal.acme.example', sha256: 'ab12cd34'.repeat(8) });

test('popup: remembered approvals are listed by project, and Forget sends that entry', async () => {
  const other = { ...SITE_OK, project: 'billing', site: 'acme.example' };
  const p = popup({ current: { ...emptyView(), approvals: [SITE_OK, FN_OK, other] } });
  await p.settle();
  assert.equal(p.ids.remembered.hidden, false);
  const rows = p.ids.remembered.querySelectorAll('li');
  assert.deepEqual(rows.map((r) => r.textContent), ['sitemail.google.comForget', 'functionportal.acme.exampleab12cd34Forget', 'siteacme.exampleForget']);
  rows[1].children.at(-1).click();
  await p.settle();
  const forgot = p.sent.filter((m) => m.type === 'forget');
  assert.deepEqual(plain(forgot), [{ type: 'forget', entry: FN_OK }]);
  const none = popup({ current: emptyView() });
  await none.settle();
  assert.equal(none.ids.remembered.hidden, true);
});

// Pairing is also allowed from the popup, so it lists what Allow gives too.
test('popup: a pairing request lists the remembered approvals it would get', async () => {
  const p = popup({ current: { ...emptyView(), pending: [pending(A, 'acme · aaaa', '111 111', [SITE_OK, FN_OK])] } });
  await p.settle();
  const text = p.ids.pending.textContent;
  assert.match(text, /Gets without asking, remembered for acme:.*mail\.google\.com.*portal\.acme\.example/);
});

test('ask.js: a script shows the session\'s purpose as its words, or that it gave none, and the notes, with a warning for dynamic code', async () => {
  const subject = (purpose) => JSON.stringify({ tabId: 1, url: 'https://example.com/a', code: 'x', purpose });
  const notes = [{ kind: 'reads', label: 'Reads the page' }, { kind: 'dynamic', label: 'Builds names or code as it runs, so this list may miss things' }];
  const said = await askPage({ id: 'r1', sessionId: A, label: 'acme · aaaa', project: 'acme', kind: 'eval', subject: subject('Reads the totals.'), notes });
  assert.equal(said.$.said.hidden, false);
  assert.equal(said.purpose, 'Reads the totals.');
  assert.equal(said.$.seen.hidden, false);
  assert.deepEqual(said.$.notes.children.map((n) => [n.textContent, n.className]), [['Reads the page', ''], [notes[1].label, 'warn']]);
  assert.equal(said.$['remember-row'].hidden, true, 'an eval offered Remember');
  const silent = await askPage({ id: 'r2', sessionId: A, label: 'acme · aaaa', project: 'acme', kind: 'function', subject: subject(''), notes: [] });
  assert.equal(silent.purpose, 'It gave no purpose.');
  assert.match(silent.$.purpose.className, /none/);
  assert.equal(silent.$.seen.hidden, true, 'an empty list shows something');
  assert.equal(silent.notes, '');
});

test('ask.js: Remember is offered for a site or a function with a project, and sent only when ticked on an Allow', async () => {
  const fn = { id: 'r1', sessionId: A, label: 'acme · aaaa', project: 'acme', kind: 'function', subject: JSON.stringify({ tabId: 1, url: 'https://example.com/a', code: 'x', purpose: '' }), notes: [] };
  const page = await askPage(fn);
  assert.equal(page.$['remember-row'].hidden, false);
  assert.equal(page['remember-label'], 'Also allow this function on https://example.com for every later session from acme, until you forget it in the toolbar.');
  await page.run('decide(true)');
  const plainAllow = await askPage(fn);
  plainAllow.$.remember.checked = true;
  await plainAllow.run('decide(false)');
  const ticked = await askPage(fn);
  ticked.$.remember.checked = true;
  await ticked.run('decide(true)');
  const answers = [page, plainAllow, ticked].map((x) => plain(x.sent.find((m) => m.type === 'answer')));
  assert.deepEqual(answers, [{ type: 'answer', id: 'r1', approve: true }, { type: 'answer', id: 'r1', approve: false }, { type: 'answer', id: 'r1', approve: true, remember: true }]);
  const site = await askPage({ id: 'r3', sessionId: A, label: 'acme · aaaa', project: 'acme', kind: 'site', subject: 'mail.google.com' });
  assert.equal(site.$['remember-row'].hidden, false);
  const noProject = await askPage({ ...fn, project: '' });
  assert.equal(noProject.$['remember-row'].hidden, true);
  noProject.$.remember.checked = true;
  await noProject.run('decide(true)');
  assert.equal(noProject.sent.find((m) => m.type === 'answer').remember, undefined);
});

/* confirm.html with one pairing in the view; timers run only when the test says. */
async function confirmPage(view) {
  const ids = Object.fromEntries(['profile', 'label', 'project', 'tiles', 'expires', 'outcome', 'others', 'allow', 'deny', 'standing', 'standing-k', 'standing-list', 'scope', 'asks', 'denied-row', 'denied']
    .map((id) => [id, new Node(id === 'allow' || id === 'deny' ? 'button' : 'span')]));
  ids.allow.disabled = true;
  const document = { getElementById: (id) => ids[id], createElement: (tag) => new Node(tag), addEventListener() {}, visibilityState: 'visible', title: '' };
  const timers = [];
  const sent = [];
  const ctx = vm.createContext({
    document, location: { hash: `#${A}` }, JSON, Math, Date, String,
    browser: { runtime: { sendMessage: async (msg) => { sent.push(msg); return msg.type === 'view' ? structuredClone(view.current) : (view.answer?.(msg) ?? { ok: true }); } } },
    setTimeout: (fn) => timers.push(fn), clearTimeout() {}, setInterval: () => 0, clearInterval() {},
  });
  for (const f of ['ui.js', 'confirm.js']) vm.runInContext(source(f), ctx, { filename: f });
  await turn();
  return { ids, sent, armNow: () => { for (const fn of timers.splice(0)) fn(); }, refresh: async () => { vm.runInContext('refresh()', ctx); await turn(); },
    run: async (js) => { await vm.runInContext(js, ctx); await turn(); } };
}

test('confirm.js: the pairing page lists every remembered approval Allow gives, and a list that changes re-arms Allow', async () => {
  const view = { current: { ...emptyView(), pending: [pending(A, 'acme · aaaa', '111 111', [SITE_OK])] } };
  const page = await confirmPage(view);
  assert.equal(page.ids.standing.hidden, false);
  // The project has its own line, always shown, since F7.
  assert.equal(page.ids['standing-k'].textContent, 'Remembered for this project: it gets these without asking');
  assert.equal(page.ids.project.textContent, 'acme');
  assert.deepEqual(page.ids['standing-list'].children.map((r) => r.textContent), ['sitemail.google.com']);
  assert.match(page.ids.asks.textContent, /, and each script, except what is remembered above\. /, 'the page still says it asks before every protected site');
  page.armNow();
  assert.equal(page.ids.allow.disabled, false);
  view.current = { ...view.current, pending: [pending(A, 'acme · aaaa', '111 111', [SITE_OK, FN_OK])] };
  await page.refresh();
  assert.equal(page.ids['standing-list'].children.length, 2);
  assert.equal(page.ids.allow.disabled, true, 'Allow stayed live while the list changed under it');
  page.armNow();
  assert.equal(page.ids.allow.disabled, false);
  const none = await confirmPage({ current: { ...emptyView(), pending: [pending(A, 'acme · aaaa', '111 111')] } });
  assert.equal(none.ids.standing.hidden, true);
  assert.match(none.ids.asks.textContent, /, and each script\. /);
});

// Public release (Phase 3a): the page said "Gmail, Acme, Google account
// pages" whatever this profile protected, and nothing of where page content
// goes. It shows the effective lists, and says plainly who receives it.
test('confirm.js: the pairing page shows the protected and refused sites this profile has, and where what the session reads goes', async () => {
  const { createCore: make } = require('../extension/core.js');
  const core = make({ makeCode: () => '111 111' });
  core.configure({ profile: { name: 'Profile 4' }, protect: ['portal.example.com'], deny: ['claims.example.org', 'billing.example.net'] });
  const view = { current: { ...core.view(), scripts: true, pending: [pending(A, 'acme · aaaa', '111 111')] } };
  const page = await confirmPage(view);
  const asks = page.ids.asks.textContent;
  assert.match(asks, /^Sign-in, account and mail pages of Google, Microsoft and Apple, portal\.example\.com, and each script\. /);
  assert.doesNotMatch(asks, /Acme|Gmail/);
  const all = page.ids.asks.querySelectorAll('details')[0];
  assert.match(all.textContent, /^All 23 sites/);
  for (const host of ['mail.google.com', 'outlook.office.com', 'account.apple.com', 'portal.example.com']) assert.ok(all.textContent.includes(host), host);
  assert.equal(page.ids['denied-row'].hidden, false);
  assert.equal(page.ids.denied.textContent, 'claims.example.org, billing.example.net');
  const plain = await confirmPage({ current: { ...emptyView(), pending: [pending(A, 'acme · aaaa', '111 111')] } });
  assert.equal(plain.ids['denied-row'].hidden, true, 'an empty refused list still shows');
  const html = source('confirm.html');
  assert.match(html, /goes to your agent and its model provider/);
  assert.doesNotMatch(html, /Claude|Acme|Gmail/);
});

// Two builds (2026-11-07): the public build has no scripts, so its pairing
// page must not promise to ask before each one.
test('confirm.js: the public build\'s pairing page asks about sites only, never "each script"', async () => {
  const view = { current: { ...emptyView(), scripts: false, pending: [pending(A, 'acme · aaaa', '111 111')] } };
  const page = await confirmPage(view);
  assert.match(page.ids.asks.textContent, /^Sign-in, account and mail pages of Google, Microsoft and Apple\. /);
  assert.doesNotMatch(page.ids.asks.textContent, /each script/);
  const remembered = await confirmPage({ current: { ...emptyView(), scripts: false, pending: [pending(A, 'acme · aaaa', '111 111', [SITE_OK])] } });
  assert.match(remembered.ids.asks.textContent, /Apple, except what is remembered above\. /);
});

/* ---------- two builds ---------- */

// The public build (Mozilla's remote-code policy) must not run agent code:
// eval, define, call and their questions are refused before any page or
// question is touched, whatever the server lists. Its package has no
// scripts.js, and that alone makes it the public build.
test('the public build refuses eval, define, call and await_question before a page is touched or a question put', async () => {
  const { TOOLS, tabAt, ran, core, posted, from } = background({ scripts: false });
  await TOOLS.open(A, { url: 'https://example.com/a' });
  const tab = tabAt('https://example.com/a');
  const before = ran.length;
  for (const [name, args] of [['eval', { tabId: tab, code: '1' }], ['define', { tabId: tab, code: '(n) => n' }],
    ['call', { tabId: tab, fn: 'f1', args: [] }], ['await_question', { id: 'r1', timeoutMs: 10 }]]) {
    await assert.rejects(TOOLS[name](A, args), /this Foxlatch build runs no scripts/, name);
  }
  assert.deepEqual(plain(ran.slice(before)), [], 'a script reached the page');
  assert.deepEqual(plain(core.view().requests), [], 'the user was asked');
  assert.deepEqual(plain(posted.find((m) => m.type === 'hello')), { type: 'hello', build: 'public', scripts: false }, 'the host was told otherwise');
  assert.equal((await from('popup', { type: 'view' })).scripts, false);
});

test('the personal build tells the host and its pages that it has scripts, and runs them', async () => {
  const { TOOLS, tabAt, posted, from, answer, evals } = background();
  assert.deepEqual(plain(posted.find((m) => m.type === 'hello')), { type: 'hello', build: 'personal', scripts: true });
  assert.equal((await from('popup', { type: 'view' })).scripts, true);
  await TOOLS.open(A, { url: 'https://example.com/a' });
  const q = await TOOLS.eval(A, { tabId: tabAt('https://example.com/a'), code: '1' });
  await answer(q.question);
  assert.equal((await TOOLS.await_question(A, { id: q.question, timeoutMs: 1000 })).status, 'done');
  assert.equal(evals().length, 1);
});

/* ---------- remembered approvals, fixed (attack on remembered approvals, 2026-11-07) ---------- */

// F1: the host passed on a label the session chose apart from its project.
test('a session is named by its project, whatever label the host\'s opened carries', async () => {
  const { TOOLS, core, hostSays, notes } = background();
  const X = 'e'.repeat(32);
  await hostSays({ type: 'opened', sessionId: X, label: 'scratch · eeee', project: '/home/user/Projects/billing' });
  await TOOLS.claim(X);
  const p = plain(core.view().pending.find((q) => q.sessionId === X));
  assert.deepEqual([p.label, p.project], ['billing · eeee', '/home/user/Projects/billing']);
  assert.match(notes.get(`claim:${X}`).message, /^billing · eeee on /);
});

// F5, Forget answered ok at once, though the host might never write it.
test('Forget is pending until the host confirms it; one the host failed, or that had no host, is failed, and Retry asks again', async () => {
  const { core, from, posted, hostSays, hostGone } = background();
  const entry = { project: '/home/user/Projects/billing', kind: 'site', site: 'mail.google.com', added: 5, label: 'billing · cccc' };
  await hostSays({ type: 'hello', profile: { name: 'Profile 4' }, deny: [], approvals: [entry] });
  const status = () => plain(core.view().forgets).map((f) => [f.status, f.error ?? null]);
  assert.deepEqual(plain(await from('popup', { type: 'forget', entry })), { ok: true, status: 'pending' });
  assert.deepEqual(status(), [['pending', null]]);
  assert.deepEqual(plain(core.view().approvals), [], 'a forget waiting for the host still counted');
  await hostSays({ type: 'remembered', approvals: [entry], did: { type: 'forget', entry }, error: 'could not save: disk full' });
  assert.deepEqual(status(), [['failed', 'could not save: disk full']]);
  assert.deepEqual(plain(await from('popup', { type: 'forget', entry })), { ok: true, status: 'pending' }, 'Retry');
  assert.equal(asksOf(posted, 'forget').length, 2);
  hostGone();
  const [[gone, why]] = status();
  assert.equal(gone, 'failed');
  assert.match(why, /stopped/);
  const unsent = plain(await from('popup', { type: 'forget', entry }));
  assert.deepEqual([unsent.ok, unsent.status], [true, 'failed']);
  assert.match(unsent.error, /not running/);
  assert.equal(asksOf(posted, 'forget').length, 2, 'sent to no host');
});

// a reply went out through whichever port was current, so
// a call from a host that had stopped answered into its replacement, which
// numbers its requests from 0 again and would hand it to another session.
test('a call from a host that stopped never answers into the host that replaced it', async () => {
  const { TOOLS, hostSays, hostGone, ports, tabAt, state } = background();
  await TOOLS.open(A, { url: 'https://example.com/claims' });
  const tab = tabAt('https://example.com/claims');
  let release;
  state.beforeScript = () => new Promise((r) => { release = r; });
  const call = hostSays({ id: 1, method: 'text', sessionId: A, params: { tabId: tab } });
  while (!release) await pause(5);
  hostGone();
  while (ports.length < 2) await pause(50); // the add-on connects to a new host
  state.beforeScript = null;
  release();
  await call;
  assert.deepEqual(ports[1].sent.filter((m) => 'id' in m), [], 'the old call answered the new host');
});

test('a hello saying the approvals file could not be read leaves one notice, until the popup dismisses it', async () => {
  const { core, hostSays, from } = background();
  await hostSays({ type: 'hello', profile: { name: 'Profile 4' }, deny: [], approvalsError: 'it is not valid JSON; moved aside to abc.json.bad-20261107T120000Z' });
  const [n] = plain(core.view().notices);
  assert.match(n.text, /could not be read.*abc\.json\.bad-20261107T120000Z/);
  await from('popup', { type: 'dismiss', id: n.id });
  assert.deepEqual(plain(core.view().notices), []);
  await from('content', { type: 'dismiss', id: n.id });
});

// F1: the popup listed only the sites a session was asked about.
test('popup: a driving session\'s row shows its project path and every site and function it holds, remembered ones included', async () => {
  const lease = { sessionId: A, label: 'acme · aaaa', project: '/home/user/projects/acme', since: 1_000_000,
    sites: ['acme.example'], functions: ['https://example.com'], locks: [], standing: [SITE_OK, FN_OK] };
  const p = popup({ current: { ...emptyView(), leases: [lease] } });
  await p.settle();
  const text = p.ids.status.textContent;
  for (const want of ['/home/user/projects/acme', 'acme.example', 'https://example.com', 'mail.google.com', 'portal.acme.example', 'ab12cd34']) {
    assert.ok(text.includes(want), `${want} is missing from: ${text}`);
  }
});

test('popup: a forget waiting for the host reads as such, and one that failed stays, with its error and Retry', async () => {
  const failed = { ...SITE_OK, site: 'acme.example' };
  const p = popup({ current: { ...emptyView(), approvals: [SITE_OK],
    forgets: [{ entry: FN_OK, status: 'pending' }, { entry: failed, status: 'failed', error: 'could not save: disk full' }] } });
  await p.settle();
  const rows = p.ids.remembered.querySelectorAll('li');
  assert.deepEqual(rows.map((r) => r.textContent),
    ['sitemail.google.comForget', 'functionportal.acme.exampleab12cd34Forgetting…', 'siteacme.exampleNot forgotten: could not save: disk fullRetry']);
  assert.equal(rows[1].children.at(-1).disabled, true);
  rows[2].children.at(-1).click();
  await p.settle();
  assert.deepEqual(plain(p.sent.filter((m) => m.type === 'forget')), [{ type: 'forget', entry: failed }]);
});

test('popup: a notice about remembered approvals shows until dismissed', async () => {
  const p = popup({ current: { ...emptyView(), notices: [{ id: 'n1', text: 'Earlier remembered approvals could not be read.' }] } });
  await p.settle();
  assert.equal(p.ids.remembered.hidden, false);
  assert.match(p.ids.remembered.textContent, /could not be read/);
  p.ids.remembered.querySelectorAll('button').find((b) => b.textContent === 'Dismiss').click();
  await p.settle();
  assert.deepEqual(plain(p.sent.filter((m) => m.type === 'dismiss')), [{ type: 'dismiss', id: 'n1' }]);
});

// F7: the pairing page showed the project only inside the remembered list.
test('confirm.js: the pairing page always shows the full project path, and Allow carries the list it showed, read again if it changed', async () => {
  const project = '/home/user/projects/acme';
  const view = { current: { ...emptyView(), pending: [{ ...pending(A, 'acme · aaaa', '111 111'), project, approvalsDigest: 'd0' }] } };
  const page = await confirmPage(view);
  assert.equal(page.ids.project.textContent, project);
  assert.equal(page.ids.standing.hidden, true);
  page.armNow();
  view.answer = (m) => (m.type === 'decide' ? { ok: false, changed: true, error: 'The remembered approvals changed while you read them.' } : undefined);
  await page.run('decide(true)');
  assert.deepEqual(plain(page.sent.filter((m) => m.type === 'decide')), [{ type: 'decide', sessionId: A, code: '111 111', approve: true, approvalsDigest: 'd0' }]);
  assert.equal(page.ids.allow.disabled, true, 'Allow stayed live after the list changed');
  assert.notEqual(page.ids.outcome.hidden, false, 'a changed list ended the page');
  page.armNow();
  assert.equal(page.ids.allow.disabled, false);
  const none = await confirmPage({ current: { ...emptyView(), pending: [{ ...pending(A, 'x · aaaa', '111 111'), project: '' }] } });
  assert.match(none.ids.project.textContent, /no project/i);
});

// F3: with Remember offered, the page said only that this session could act.
test('ask.js: Remember says plainly that it allows every later session from the project, and a function shows its full origin', async () => {
  const project = '/home/user/projects/acme';
  const site = { id: 'r3', sessionId: A, label: 'acme · aaaa', project, kind: 'site', subject: 'mail.google.com' };
  assert.equal((await askPage(site))['remember-label'], `Also allow mail.google.com for every later session from ${project}, until you forget it in the toolbar.`);
  const fn = await askPage({ id: 'r1', sessionId: A, label: 'acme · aaaa', project, kind: 'function',
    subject: JSON.stringify({ tabId: 1, url: 'https://example.com:8443/a?x=1', code: 'x', purpose: '' }), notes: [] });
  assert.equal(fn.target, 'https://example.com:8443');
  assert.equal(fn['remember-label'], `Also allow this function on https://example.com:8443 for every later session from ${project}, until you forget it in the toolbar.`);
  const full = await askPage(site, { approvalsFull: true });
  assert.equal(full.$.remember.disabled, true);
  assert.match(full['remember-label'], /full/);
  full.$.remember.checked = true;
  await full.run('decide(true)');
  assert.equal(full.sent.find((m) => m.type === 'answer').remember, undefined);
});

/* ---------- Phase 1 (2026-11-07 release review) ---------- */

// The background page checked the approved origin, then injected a script
// that compared the host alone.
test('call: an approved function does not run if the page leaves its origin between the check and the injection', async () => {
  const { TOOLS, tabAt, answer, state, go, executed } = background();
  await TOOLS.open(A, { url: 'https://example.com/app' });
  const tab = tabAt('https://example.com/app');
  const q = await TOOLS.define(A, { tabId: tab, code: '(n) => n * 2' });
  await answer(q.question);
  const { fn } = await TOOLS.await_question(A, { id: q.question, timeoutMs: 1000 });
  assert.equal(await TOOLS.call(A, { tabId: tab, fn, args: [21] }), 'ok');
  assert.equal(executed.length, 1);
  state.beforeScript = ({ fn: name }) => { if (name === 'evalInPage') { state.beforeScript = null; go(tab, 'http://example.com/app'); } };
  const out = await outcomeOf(TOOLS.call(A, { tabId: tab, fn, args: [21] }));
  assert.match(out.error ?? JSON.stringify(out), /no longer on the origin the function was approved for; it did not run/);
  assert.equal(executed.length, 1, 'the function ran on an origin the user did not approve');
});

// The background page compared navigation counters, then injected; a reload
// at the same URL in between ran the Allow in a document the user never saw.
test('eval: an Allow does not run in a document that replaced the one shown after the last check, and nothing makes a new mark', async () => {
  const { TOOLS, tabAt, answer, state, go, executed, ran } = background();
  await TOOLS.open(A, { url: 'https://example.com/claims/1' });
  const tab = tabAt('https://example.com/claims/1');
  const q = await TOOLS.eval(A, { tabId: tab, code: 'submitAll()' });
  assert.deepEqual(ran.filter((r) => r.fn === 'markDocument').map((r) => r.url), ['https://example.com/claims/1'], 'the shown document was not marked when asked');
  await answer(q.question);
  state.beforeScript = ({ fn }) => { if (fn === 'evalInPage') { state.beforeScript = null; go(tab, 'https://example.com/claims/1'); } };
  const out = await outcomeOf(TOOLS.await_question(A, { id: q.question, timeoutMs: 1000 }));
  assert.match(out.error ?? JSON.stringify(out), /reloaded or replaced before the script ran, though its URL is the same; it did not run/);
  assert.deepEqual(executed, [], 'ran in a document the user was not shown');
  assert.equal(ran.filter((r) => r.fn === 'markDocument').length, 1, 'collecting marked a document');
  await outcomeOf(TOOLS.await_question(A, { id: q.question, timeoutMs: 1000 }));
  assert.deepEqual(executed, [], 'a second collection ran it');
  // The document shown, unchanged: it runs, once.
  const shown = await TOOLS.eval(A, { tabId: tab, code: 'submitAll()' });
  await answer(shown.question);
  assert.equal((await TOOLS.await_question(A, { id: shown.question, timeoutMs: 1000 })).value, 'ok');
  assert.deepEqual(executed, ['submitAll()']);
});

// Each eval question marked the document with a new token, kept there for
// good however the question ended; the document's own mark is set once.
test('eval: every question asked in one document records that document\'s one mark, and a reload at the same URL has another', async () => {
  const { TOOLS, core, tabAt, answer, go, executed } = background();
  await TOOLS.open(A, { url: 'https://example.com/claims/1' });
  const tab = tabAt('https://example.com/claims/1');
  const marks = [];
  for (const code of ['a()', 'b()', 'c()']) {
    const q = await TOOLS.eval(A, { tabId: tab, code });
    marks.push(core.requestOf(q.question).token);
    await answer(q.question, false); // denied: the document keeps no more than it had
  }
  assert.match(marks[0], /^[0-9a-f]{32}$/);
  assert.deepEqual(marks, [marks[0], marks[0], marks[0]], 'questions in one document carried different marks');
  go(tab, 'https://example.com/claims/1');
  const q = await TOOLS.eval(A, { tabId: tab, code: 'd()' });
  assert.notEqual(core.requestOf(q.question).token, marks[0], 'a reloaded document had the old one\'s mark');
  await answer(q.question);
  assert.equal((await TOOLS.await_question(A, { id: q.question, timeoutMs: 1000 })).value, 'ok');
  assert.deepEqual(executed, ['d()']);
});

// Only the top-level URL was checked, so a refused or protected page in an
// iframe was captured with the rest.
test('screenshot: refused while any frame shows a page the session may not see, and discarded if a frame changes during it', async () => {
  const { TOOLS, core, tabAt, frameGoes, state, captured, answer } = background();
  await TOOLS.open(A, { url: 'https://example.com/inbox' });
  const tab = tabAt('https://example.com/inbox');
  frameGoes(tab, 5, 'https://widget.example/a');
  frameGoes(tab, 6, 'about:blank');
  assert.match(await TOOLS.screenshot(A, { tabId: tab }), /^data:image\/png/);
  frameGoes(tab, 7, 'https://mail.google.com/mail/u/0/');
  const refused = await outcomeOf(TOOLS.screenshot(A, { tabId: tab }));
  assert.match(refused.error ?? 'returned the image', /no screenshot: frame f7 \(https:\/\/mail\.google\.com\/mail\/u\/0\/\) may not be shown: .*protected/);
  assert.equal(captured.length, 1, 'the tab was captured with a protected frame in it');
  frameGoes(tab, 7, 'blob:https://mail.google.com/0f9a');
  assert.match((await outcomeOf(TOOLS.screenshot(A, { tabId: tab, ref: 'e1' }))).error ?? '', /no screenshot: frame f7/, 'a blob frame is its creator\'s origin');
  frameGoes(tab, 7, 'https://widget.example/b');
  for (const to of ['https://widget.example/c', 'https://mail.google.com/mail/u/0/']) {
    state.onCapture = () => { state.onCapture = null; frameGoes(tab, 7, to); };
    const out = await outcomeOf(TOOLS.screenshot(A, { tabId: tab }));
    assert.match(out.error ?? 'returned the image', /the screenshot was discarded/, to);
    frameGoes(tab, 7, 'https://widget.example/b');
  }
  // A protected frame this session was allowed on may be shown.
  const site = core.ask(A, 'site', 'mail.google.com');
  await answer(site);
  frameGoes(tab, 7, 'https://mail.google.com/mail/u/0/');
  assert.match(await TOOLS.screenshot(A, { tabId: tab }), /^data:image\/png/);
});

// The frame check compared frame ids and URLs before and after the capture,
// so a frame that went allowed -> protected -> allowed around it matched both.
test('screenshot: discarded when a frame navigates away and back during the capture, or a frame comes and goes', async () => {
  const { TOOLS, tabAt, frames, frameGoes, state, captured } = background();
  await TOOLS.open(A, { url: 'https://example.com/inbox' });
  const tab = tabAt('https://example.com/inbox');
  frameGoes(tab, 7, 'https://widget.example/b');
  assert.match(await TOOLS.screenshot(A, { tabId: tab }), /^data:image\/png/);
  state.onCapture = () => {
    state.onCapture = null;
    frameGoes(tab, 7, 'https://mail.google.com/mail/u/0/');
    frameGoes(tab, 7, 'https://widget.example/b');
  };
  const back = await outcomeOf(TOOLS.screenshot(A, { tabId: tab }));
  assert.match(back.error ?? 'returned the image', /the screenshot was discarded/, 'a frame that went protected and back was captured');
  // A protected frame added and removed while the capture ran: the frame list matches, the commit does not.
  state.onCapture = () => {
    state.onCapture = null;
    frameGoes(tab, 9, 'https://mail.google.com/mail/u/0/');
    frames.get(tab).delete(9);
  };
  const passing = await outcomeOf(TOOLS.screenshot(A, { tabId: tab }));
  assert.match(passing.error ?? 'returned the image', /the screenshot was discarded/, 'a frame that came and went was captured');
  assert.equal(captured.length, 3);
  assert.match(await TOOLS.screenshot(A, { tabId: tab }), /^data:image\/png/, 'a quiet tab is refused after a discard');
});

// A config.json that did not parse, or held a wrong type, became empty
// lists: every deny, protect and exclusive rule was dropped without a word.
test('a broken config.json refuses claims and tool calls, and the pairing page and the popup say what is wrong', async () => {
  const { TOOLS, core, hostSays, tabs } = background();
  await hostSays({ type: 'hello', profile: { name: 'Profile 4' }, deny: [], configError: 'it is not valid JSON (Expecting value: line 1 column 1)' });
  const C = 'c'.repeat(32);
  core.opened(C, '/home/user/Projects/gym-app');
  const claim = await outcomeOf(TOOLS.claim(C));
  assert.match(claim.error ?? 'claimed', /refuses control of Profile 4: config\.json is broken: it is not valid JSON/);
  assert.ok([...tabs.values()].some((t) => t.url === `moz-extension://u/confirm.html#${C}`), 'no pairing page says why');
  assert.match((await outcomeOf(TOOLS.tabs(A))).error ?? 'listed', /config\.json is broken/, 'a session driving before the hello still acts');
  const view = { current: { ...emptyView(), configError: core.view().configError } };
  const page = await confirmPage(view);
  assert.equal(page.ids.outcome.hidden, false);
  assert.match(page.ids.outcome.textContent, /No session can drive this profile: config\.json is broken: it is not valid JSON/);
  assert.equal(page.ids.allow.disabled, true);
  const pop = popup(view);
  await pop.settle();
  assert.match(pop.ids.status.textContent, /config\.json is broken, so no session can drive this profile: it is not valid JSON/);
  // An entry that is not a host name is a broken file too.
  await hostSays({ type: 'hello', profile: { name: 'Profile 4' }, deny: ['claims.example.org/login'] });
  assert.match((await outcomeOf(TOOLS.claim(C))).error ?? 'claimed', /"deny" entry "claims\.example\.org\/login" is not a host name/);
});

// only open and navigate were checked, so a link, a form,
// a redirect or a page's own script could load a refused site, or a sign-in
// another session held, in a session's tab.
test('every load in a session\'s tab is checked before it is sent; the user\'s own tabs never are', async () => {
  const { TOOLS, core, hostSays, load, newTab, createdTab, tabAt, tabs, from } = background();
  await hostSays({ type: 'hello', profile: { name: 'Profile 4' }, deny: ['claims.example.org'], exclusive: ['benefits.example.gov'] });
  for (const id of [A, B]) core.decide(id, core.claim(id).code, true);
  await TOOLS.open(A, { url: 'https://example.com/a' });
  await TOOLS.open(B, { url: 'https://example.com/b' });
  const [a, b] = [tabAt('https://example.com/a'), tabAt('https://example.com/b')];
  // Refused, for the top document and any frame.
  assert.equal(await load(a, 'https://claims.example.org/'), 'cancelled');
  assert.equal(await load(a, 'https://claims.example.org/embed', 'sub_frame'), 'cancelled');
  assert.equal(await load(a, 'https://claims.example.org/doc.pdf', 'object'), 'cancelled');
  const said = await TOOLS.navigate(A, { tabId: a, url: 'reload' });
  // The stopped page is reported, not hidden by the frames stopped after it.
  assert.match(said.note ?? '', /Foxlatch stopped this tab from loading https:\/\/claims\.example\.org\/: refused: claims\.example\.org is on the user's deny list/);
  assert.equal((await TOOLS.navigate(A, { tabId: a, url: 'reload' })).note, undefined, 'said once');
  // A free exclusive site loads and takes the lock; the other session's tab may then not load it at all.
  assert.equal(await load(a, 'https://benefits.example.gov/portal'), 'sent');
  assert.equal(await load(b, 'https://benefits.example.gov/portal/logout'), 'cancelled');
  assert.equal(await load(b, 'https://benefits.example.gov/widget', 'sub_frame'), 'cancelled');
  await assert.rejects(TOOLS.open(B, { url: 'https://benefits.example.gov/portal' }), /in use by acme · aaaa/);
  // A protected site the session was not allowed on: the page may not take it there, but may frame it.
  assert.equal(await load(a, 'https://accounts.google.com/o/oauth2/auth'), 'cancelled');
  assert.equal(await load(a, 'https://accounts.google.com/gsi/iframe', 'sub_frame'), 'sent');
  // A tab the page opened, loading before onCreated handed it over, is the session's and is checked.
  const child = newTab(1, 'about:blank');
  tabs.get(child.id).openerTabId = a;
  assert.equal(await load(child.id, 'https://claims.example.org/'), 'cancelled');
  assert.equal(core.ownerOf(child.id), A);
  // The user's own tab, and a session's tab once control ended, are the user's.
  const mine = newTab(1, 'about:blank');
  assert.equal(await load(mine.id, 'https://claims.example.org/'), 'sent');
  // Attack 2026-11-09: a tab the user opened from a session's tab while it had
  // no lease was handed to it on its next load once it was allowed again.
  await from('popup', { type: 'revoke', sessionId: B });
  const theirs = newTab(1, 'about:blank');
  tabs.get(theirs.id).openerTabId = b;
  await createdTab(theirs.id); // onCreated: B drives nothing, so it stays the user's
  core.decide(B, core.claim(B).code, true);
  assert.equal(await load(theirs.id, 'https://example.com/bank'), 'sent');
  assert.equal(core.ownerOf(theirs.id), null, 'a tab the user opened while B was stopped became B\'s');
  await from('popup', { type: 'revoke', sessionId: A });
  assert.equal(await load(a, 'https://claims.example.org/'), 'sent');
});

// after Stop a session's tabs are the user's for good. A
// session allowed again got them back, with whatever they had browsed to since.
test('a session that is stopped and allowed again has none of its old tabs, and opens in a new window', async () => {
  const { TOOLS, core, from, tabAt, tabs } = background();
  await TOOLS.open(A, { url: 'https://example.com/a' });
  const old = tabAt('https://example.com/a');
  const oldWindow = tabs.get(old).windowId;
  await from('popup', { type: 'revoke', sessionId: A });
  assert.equal(core.ownerOf(old), null, 'a stopped session still owned its tab');
  core.decide(A, core.claim(A).code, true);
  assert.deepEqual(plain(await TOOLS.tabs(A)), []);
  await assert.rejects(TOOLS.text(A, { tabId: old }), /not one of this session's tabs/);
  await TOOLS.open(A, { url: 'https://example.com/new' });
  assert.notEqual(tabs.get(tabAt('https://example.com/new')).windowId, oldWindow, 'it opened in the window that is the user\'s now');
});

// Live 2026-11-09: a page's own history.back() restored a cached page with no
// request, so a session's tab came back to a site another session now held.
test('a page that appears in a session\'s tab with no request (a cached back) is sent away if the session may not be there', async () => {
  const { TOOLS, tabAt, tabs, go, advance } = background();
  await TOOLS.open(A, { url: 'https://benefits.example.gov/portal' });
  const a = tabAt('https://benefits.example.gov/portal');
  await TOOLS.navigate(A, { tabId: a, url: 'https://example.com/a' });
  advance(31_000); // A's lock lapses
  await TOOLS.open(B, { url: 'https://benefits.example.gov/portal' });
  go(a, 'https://benefits.example.gov/portal'); // restored from the page cache: committed, never requested
  await pause(20);
  assert.equal(tabs.get(a).url, 'about:blank');
  const said = await TOOLS.navigate(A, { tabId: a, url: 'https://example.com/again' });
  assert.match(said.note ?? '', /Foxlatch stopped this tab from loading https:\/\/benefits\.example\.gov\/portal: .*in use by billing · bbbb/);
  // A page the session may be on is left alone.
  go(a, 'https://example.com/back');
  await pause(20);
  assert.equal(tabs.get(a).url, 'https://example.com/back');
});

// Live 2026-11-09: open starts on about:blank so the guard sees its first
// load; it returned on the blank page's own load, and when the guard stopped
// a redirect it waited out the whole 30 s for a load that would never end.
test('open waits for its own page, and returns at once saying so when a redirect is stopped', async () => {
  const { TOOLS, hostSays, core, state } = background();
  await hostSays({ type: 'hello', profile: { name: 'Profile 4' }, deny: ['claims.example.org'] });
  core.decide(A, core.claim(A).code, true);
  state.redirects['https://example.com/go'] = 'https://example.com/there';
  const went = await TOOLS.open(A, { url: 'https://example.com/go' });
  assert.equal(went.url, 'https://example.com/there');
  state.redirects['https://example.com/r'] = 'https://claims.example.org/';
  for (const later of [false, true]) {
    Object.assign(state, { later, lateBlank: later });
    const t0 = Date.now();
    const out = await TOOLS.open(A, { url: 'https://example.com/r' });
    assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
    assert.match(out.note ?? '', /Foxlatch stopped this tab from loading https:\/\/claims\.example\.org\/: refused/, `later ${later}`);
  }
});

// with both builds in one profile, the second host now
// refuses to serve; its add-on must say why rather than look idle.
test('a host that refuses to serve because another add-on holds the profile: the popup says why and how to fix it', async () => {
  const { from, hostSays } = background();
  const why = 'another Foxlatch add-on already serves Profile 4 (are both the public and the personal build installed?): keep one, remove the other in about:addons, then restart Firefox';
  await hostSays({ type: 'hello', profile: { name: 'Profile 4' }, deny: [], refused: why });
  const v = plain(await from('popup', { type: 'view' }));
  assert.equal(v.hostRefused, why);
  const pop = popup({ current: v });
  await pop.settle();
  assert.match(pop.ids.status.textContent, /No session can drive this profile through this add-on: another Foxlatch add-on .*about:addons/);
  await hostSays({ type: 'hello', profile: { name: 'Profile 4' }, deny: [] });
  assert.equal(plain(await from('popup', { type: 'view' })).hostRefused, null, 'a host that serves clears it');
});

// An action waiting for its element kept trying after Stop.
test('an action\'s page script hears whether its lease holds: only for its own token, from its own tab, until control ends', async () => {
  const { TOOLS, tabAt, state, fromContent, msg } = background();
  await TOOLS.open(A, { url: 'https://example.com/a' });
  await TOOLS.open(B, { url: 'https://example.com/b' });
  const [tab, other] = [tabAt('https://example.com/a'), tabAt('https://example.com/b')];
  const heard = [];
  const ask = async (lease, from = tab) => (await fromContent({ type: 'alive', lease }, from)).find((r) => r !== undefined);
  state.beforeScript = async ({ fn, args }) => {
    if (fn !== 'act') return;
    heard.push(['live', await ask(args.lease)], ['guessed', await ask('0'.repeat(32))], ['other tab', await ask(args.lease, other)]);
    await Promise.all(msg.fire({ type: 'revoke', sessionId: A }, { id: 'x', url: 'moz-extension://u/popup.html', envType: 'addon_child' }));
    heard.push(['after Stop', await ask(args.lease)]);
  };
  // Stopped mid-action: the tab is the user's, so the call reports nothing of it (2026-11-10).
  await assert.rejects(TOOLS.click(A, { tabId: tab, ref: 'e1' }), /not connected/);
  assert.deepEqual(heard, [['live', true], ['guessed', false], ['other tab', false], ['after Stop', false]]);
});

// an action waiting for its element checked the lease
// and the tab, not the site, so it dispatched after Forget took the site away.
test('an action waiting to dispatch hears no once Forget ends the remembered site it is on', async () => {
  const { TOOLS, core, tabAt, from, hostSays, fromContent, state, D, repair } = await remembering();
  const entry = { project: BILLING, kind: 'site', site: 'mail.google.com', added: 5, label: 'billing · cccc' };
  await hostSays({ type: 'hello', profile: { name: 'Profile 4' }, deny: [], approvals: [entry] });
  repair(D);
  await TOOLS.open(D, { url: 'https://mail.google.com/mail/u/0/' });
  const tab = tabAt('https://mail.google.com/mail/u/0/');
  const heard = [];
  state.beforeScript = async ({ fn, args }) => {
    if (fn !== 'act') return;
    const ask = async () => (await fromContent({ type: 'alive', lease: args.lease }, tab)).find((r) => r !== undefined);
    heard.push(['before', await ask()]);
    await from('popup', { type: 'forget', entry });
    assert.equal(core.granted(D, 'mail.google.com'), false);
    heard.push(['after Forget', await ask()]);
  };
  await TOOLS.click(D, { tabId: tab, ref: 'e1' });
  assert.deepEqual(heard, [['before', true], ['after Forget', false]]);
});

// Refs restart at e1 in every new document, so e1 from the last page named
// whatever the new one numbered first.
test('refs carry the document they came from, and an action passes it to the page, which refuses a ref from another', async () => {
  const { TOOLS, tabAt, ran, go, frameGoes } = background();
  await TOOLS.open(A, { url: 'https://example.com/a' });
  const tab = tabAt('https://example.com/a');
  frameGoes(tab, 3, 'https://widget.example/');
  const first = (await TOOLS.snapshot(A, { tabId: tab })).elements;
  const refs = [...first.matchAll(/^(\S+) button/gm)].map((m) => m[1]);
  assert.equal(refs.length, 2, first);
  assert.match(refs[0], /^[a-df-z]+e1$/);
  assert.match(refs[1], /^f3:[a-df-z]+e1$/);
  const second = [...(await TOOLS.snapshot(A, { tabId: tab })).elements.matchAll(/^(\S+) button/gm)].map((m) => m[1]);
  assert.notEqual(second[0], refs[0], 'two snapshots gave one tag');
  const acted = () => ran.filter((r) => r.fn === 'act').at(-1).args;
  await TOOLS.click(A, { tabId: tab, ref: refs[0] });
  assert.equal(acted().doc, refs[0].slice(0, -2));
  assert.equal(acted().ref, 'e1');
  await TOOLS.click(A, { tabId: tab, ref: refs[1] });
  assert.equal(acted().doc, refs[1].slice(3, -2));
  // A ref without its tag means the frame's last snapshot; one the session made up is not passed off as another.
  await TOOLS.click(A, { tabId: tab, ref: 'e1' });
  assert.equal(acted().doc, second[0].slice(0, -2));
  await TOOLS.click(A, { tabId: tab, ref: refs[0], doc: 'zz' });
  assert.equal(acted().doc, refs[0].slice(0, -2), 'the session chose the document');
  await assert.rejects(TOOLS.click(A, { tabId: tab, ref: 'e1x' }), /bad ref e1x/);
  go(tab, 'https://example.com/b');
  await TOOLS.click(A, { tabId: tab, ref: 'e1' });
  assert.equal(acted().doc, second[0].slice(0, -2), 'a bare ref after a navigation is not checked against the last snapshot\'s document, which the page refuses');
});

/* ---------- Phase 4: find and read ---------- */

// find and read are reads like snapshot: they may reach exactly the frames
// and sites snapshot reaches, under the same checks, and no other.
test('find skips, and read and find within refuse, a frame that is refused or protected and not allowed to the session; nothing is injected there', async () => {
  const { TOOLS, core, tabAt, frameGoes, ran, answer } = background();
  core.configure({ profile: { name: 'Profile 4' }, exclusive: ['benefits.example.gov'], deny: ['claims.example.org'] });
  await TOOLS.open(A, { url: 'https://example.com/a' });
  const tab = tabAt('https://example.com/a');
  frameGoes(tab, 3, 'https://widget.example/');
  frameGoes(tab, 5, 'https://mail.google.com/mail/u/0/');
  frameGoes(tab, 6, 'https://claims.example.org/list');
  const reads = () => ran.filter((r) => r.fn === 'find' || r.fn === 'read').map((r) => r.frameId);
  const found = await TOOLS.find(A, { tabId: tab, role: 'button' });
  assert.deepEqual(reads(), [0, 3]);
  assert.equal(found.matches, 2);
  assert.match(found.lines[0], /^[a-df-z]+e1 button "Save"$/);
  assert.match(found.lines[1], /^f3:[a-df-z]+e1 button "Save"$/);
  for (const [frame, why] of [['f5', /mail\.google\.com is protected/], ['f6', /claims\.example\.org is on the user's deny list/]]) {
    await assert.rejects(TOOLS.read(A, { tabId: tab, frame }), why, frame);
    await assert.rejects(TOOLS.read(A, { tabId: tab, ref: `${frame}:ae1` }), why, frame);
    await assert.rejects(TOOLS.find(A, { tabId: tab, text: 'x', within: `${frame}:ae1` }), why, frame);
  }
  assert.deepEqual(reads(), [0, 3], 'a refused frame was read');
  // Once the user allows this session on the protected site, its frame is read like any other.
  await answer(core.ask(A, 'site', 'mail.google.com'));
  assert.equal((await TOOLS.find(A, { tabId: tab, role: 'button' })).matches, 3);
  assert.deepEqual(reads().slice(2), [0, 3, 5]);
  await TOOLS.read(A, { tabId: tab, frame: 'f5' });
  assert.deepEqual(reads().at(-1), 5);
  await assert.rejects(TOOLS.read(A, { tabId: tab, frame: 'f6' }), /deny list/);
});

test('find and read refuse a tab whose page moved to a protected site the session was not allowed on, before injecting anything', async () => {
  const { TOOLS, tabAt, go, ran, state } = background();
  await TOOLS.open(A, { url: 'https://example.com/a' });
  const tab = tabAt('https://example.com/a');
  state.stuck = true; // and the add-on could not send the tab away: the tools are the last defence
  go(tab, 'https://mail.google.com/mail/u/0/'); // the page went there itself
  const before = ran.length;
  for (const [tool, args] of [['find', { role: 'button' }], ['read', {}], ['text', {}], ['snapshot', {}]]) {
    await assert.rejects(TOOLS[tool](A, { tabId: tab, ...args }), /mail\.google\.com is protected/, tool);
  }
  await assert.rejects(TOOLS.find(B, { tabId: tab, role: 'button' }), /not one of this session's tabs/);
  assert.equal(ran.length, before, 'a script ran on the protected page');
});

test('find and read give refs with their frame and document tag, which click accepts; the session chooses neither tag nor document', async () => {
  const { TOOLS, tabAt, frameGoes, ran } = background();
  await TOOLS.open(A, { url: 'https://example.com/a' });
  const tab = tabAt('https://example.com/a');
  frameGoes(tab, 3, 'https://widget.example/');
  await assert.rejects(TOOLS.find(A, { tabId: tab }), /pass role, name or text/);
  await assert.rejects(TOOLS.find(A, { tabId: tab, role: '', name: '' }), /pass role, name or text/);
  assert.deepEqual(ran.filter((r) => r.fn === 'find'), [], 'a find with no criterion reached a page');
  const out = await TOOLS.read(A, { tabId: tab, frame: 'f3', doc: 'zz', tag: 'zz', offset: -4, max: 10 ** 6 });
  const args = ran.at(-1).args;
  assert.notEqual(args.tag, 'zz');
  assert.equal(args.doc, undefined);
  assert.deepEqual([args.offset, args.max], [0, 200], 'offset and max are clamped');
  assert.equal(out.doc, undefined, 'the tag is in the refs, not beside them');
  assert.deepEqual(out.rows[0].refs.map((r) => [r.ref, r.name]), [[`f3:${args.tag}e1`, 'Save'], [`f3:${args.tag}e2`, 'Delete']]);
  await TOOLS.click(A, { tabId: tab, ref: out.rows[0].refs[1].ref });
  const acted = ran.filter((r) => r.fn === 'act').at(-1);
  assert.deepEqual([acted.frameId, acted.args.doc, acted.args.ref], [3, args.tag, 'e2']);
  // within passes the ref's own document to the page, which refuses one from another.
  await TOOLS.find(A, { tabId: tab, name: 'Save', within: out.rows[0].refs[0].ref, doc: 'zz' });
  const within = ran.at(-1);
  assert.deepEqual([within.frameId, within.args.within, within.args.doc], [3, 'e1', args.tag]);
  await assert.rejects(TOOLS.read(A, { tabId: tab, ref: out.rows[0].refs[0].ref, frame: 'f0' }), /ref .* is in frame f3, not f0/);
  // A bare ref means the frame's last read, as it means its last snapshot.
  await TOOLS.click(A, { tabId: tab, ref: 'f3:e1' });
  assert.equal(ran.filter((r) => r.fn === 'act').at(-1).args.doc, within.args.tag);
});

test('a page Firefox keeps from add-ons (addons.mozilla.org) is named, never read as an empty page', async () => {
  // Firefox refuses executeScript on its restricted domains with "Missing
  // host permission for the tab"; snapshot swallowed it and showed nothing.
  const { TOOLS, tabAt, state } = background();
  await TOOLS.open(A, { url: 'https://addons.mozilla.org/en-US/developers/addons' });
  const tab = tabAt('https://addons.mozilla.org/en-US/developers/addons');
  state.beforeScript = () => { throw new Error('Missing host permission for the tab'); };
  for (const [name, args] of [['snapshot', {}], ['find', { name: 'Submit' }], ['text', {}], ['read', {}]]) {
    await assert.rejects(TOOLS[name](A, { tabId: tab, ...args }), /Firefox does not let add-ons .*addons\.mozilla\.org/, name);
  }
});

// a review full review #5, 2026-11-09: a locked site in a frame of an ordinary
// page lost its lock after the grace, and another session walked in.
test('a locked site in a frame of a session\'s tab keeps its lock while the frame is there', async () => {
  const { TOOLS, tabAt, load, frameGoes, go, advance } = background();
  await TOOLS.open(A, { url: 'https://example.com/host' });
  const a = tabAt('https://example.com/host');
  assert.equal(await load(a, 'https://benefits.example.gov/widget', 'sub_frame'), 'sent');
  frameGoes(a, 7, 'https://benefits.example.gov/widget');
  advance(31_000); // past LOCK_GRACE_MS
  await assert.rejects(TOOLS.open(B, { url: 'https://benefits.example.gov/portal' }), /in use by acme · aaaa/);
  go(a, 'https://example.com/next'); // the page, and its frame with it, is replaced
  assert.equal((await TOOLS.open(B, { url: 'https://benefits.example.gov/portal' })).url, 'https://benefits.example.gov/portal');
});

/* ---------- attack on the day's changes, 2026-11-10 ---------- */

test('a tab or window made while Stop lands is the user\'s: the session allowed again does not get it', async () => {
  const { TOOLS, core, from, browser, go } = background();
  const create = browser.windows.create;
  let made;
  browser.windows.create = async (o) => {
    const w = await create(o);
    made = w.tabs[0].id;
    await from('popup', { type: 'revoke', sessionId: A }); // Stop while the window is being made
    return w;
  };
  assert.match((await outcomeOf(TOOLS.open(A, { url: 'https://example.com/a' }))).error ?? '', /not connected/);
  assert.equal(core.ownerOf(made), null);
  go(made, 'https://bank.example/statement'); // the user, in their tab
  core.decide(A, core.claim(A).code, true);
  assert.deepEqual(plain(await TOOLS.tabs(A)), []);
  assert.deepEqual(plain(core.agentWindows()), []);
  await assert.rejects(TOOLS.text(A, { tabId: made }), /not one of this session's tabs/);
});

test('a call still waiting on a load when Stop lands does not report where the user then takes the tab', async () => {
  const { TOOLS, from, browser, tabs, go, tabAt } = background();
  await TOOLS.open(A, { url: 'https://example.com/a' });
  const a = tabAt('https://example.com/a');
  const update = browser.tabs.update;
  browser.tabs.update = async (id, p) => (p.url === 'https://slow.example/' ? { ...tabs.get(id) } : update(id, p)); // a load that never ends
  const call = outcomeOf(TOOLS.navigate(A, { tabId: a, url: 'https://slow.example/' }));
  await pause(50);
  await from('popup', { type: 'revoke', sessionId: A });
  tabs.get(a).title = 'Statement - acct 12345';
  go(a, 'https://bank.example/statement'); // the user, in their tab
  const out = await call;
  assert.match(out.error ?? '', /not connected/, JSON.stringify(out));
});

// A read checked the tab, then waited on Firefox; Stop landed and the user
// took the tab to another page on the same host, and the read ran there.
test('a read waiting on Firefox when Stop lands runs nothing in the tab the user now has', async () => {
  for (const [tool, args] of [['snapshot', {}], ['find', { name: 'Save' }], ['read', { ref: 'e1' }], ['text', {}], ['click', { ref: 'e1' }]]) {
    const { TOOLS, from, browser, go, tabAt, ran } = background();
    await TOOLS.open(A, { url: 'https://example.com/a' });
    const a = tabAt('https://example.com/a');
    await TOOLS.snapshot(A, { tabId: a });
    // Stop lands during the first call the tool makes to Firefox, whichever it is.
    let stopped = false;
    const stopFirst = (real) => async (...q) => {
      if (!stopped) {
        stopped = true;
        await from('popup', { type: 'revoke', sessionId: A });
        go(a, 'https://example.com/statement'); // the user, in their tab
      }
      return real(...q);
    };
    for (const [api, name] of [[browser.webNavigation, 'getAllFrames'], [browser.webNavigation, 'getFrame'], [browser.tabs, 'get']]) {
      api[name] = stopFirst(api[name]);
    }
    const out = await outcomeOf(TOOLS[tool](A, { tabId: a, ...args }));
    assert.match(out.error ?? '', /not connected/, `${tool}: ${JSON.stringify(out)}`);
    assert.deepEqual(ran.filter((r) => r.url === 'https://example.com/statement').map((r) => r.fn), [], tool);
  }
});

test('a reload waiting on Firefox when Stop lands does not reload the tab the user now has', async () => {
  const { TOOLS, from, browser, tabAt, calls } = background();
  await TOOLS.open(A, { url: 'https://example.com/a' });
  const a = tabAt('https://example.com/a');
  const get = browser.tabs.get;
  browser.tabs.get = async (id) => { await from('popup', { type: 'revoke', sessionId: A }); return get(id); };
  const out = await outcomeOf(TOOLS.navigate(A, { tabId: a, url: 'reload' }));
  assert.match(out.error ?? '', /not connected/, JSON.stringify(out));
  assert.deepEqual(calls.filter(([c]) => c === 'reload'), []);
});

test('what a script read while Stop landed is not returned', async () => {
  for (const [tool, args] of [['snapshot', {}], ['find', { name: 'Save' }], ['read', { ref: 'e1' }], ['text', {}]]) {
    const { TOOLS, from, tabAt, state } = background();
    await TOOLS.open(A, { url: 'https://example.com/a' });
    const a = tabAt('https://example.com/a');
    await TOOLS.snapshot(A, { tabId: a });
    state.beforeScript = () => from('popup', { type: 'revoke', sessionId: A });
    const out = await outcomeOf(TOOLS[tool](A, { tabId: a, ...args }));
    assert.match(out.error ?? '', /not connected/, `${tool}: ${JSON.stringify(out)}`);
  }
});

test('a cached page restored onto a free locked site takes its lock, as a requested load does', async () => {
  const { TOOLS, core, tabAt, go, advance } = background();
  await TOOLS.open(A, { url: 'https://benefits.example.gov/portal' });
  const a = tabAt('https://benefits.example.gov/portal');
  await TOOLS.navigate(A, { tabId: a, url: 'https://example.com/a' });
  advance(31_000); // A's lock lapses
  await TOOLS.open(B, { url: 'https://benefits.example.gov/portal' }); // B takes the site, then leaves it
  const b = tabAt('https://benefits.example.gov/portal');
  await TOOLS.navigate(B, { tabId: b, url: 'https://example.com/b' });
  advance(31_000);
  go(a, 'https://benefits.example.gov/portal'); // A goes back, from the page cache: committed, never requested
  await pause(20);
  await assert.rejects(TOOLS.navigate(B, { tabId: b, url: 'https://benefits.example.gov/portal' }), /in use by acme · aaaa/);
});

// A page restored from the cache comes back with its frames in place, and
// Firefox may commit only its top document: the frames are read then.
test('a page that comes back with a locked site already in a frame keeps that site\'s lock', async () => {
  const { TOOLS, tabAt, go, advance } = background();
  await TOOLS.open(A, { url: 'https://example.com/host' });
  const a = tabAt('https://example.com/host');
  await TOOLS.navigate(A, { tabId: a, url: 'https://example.com/next' });
  go(a, 'https://example.com/host', [[7, 'https://benefits.example.gov/widget']]); // back, from the page cache, frame and all
  await pause(20);
  await TOOLS.find(A, { tabId: a, name: 'x' }); // A reads the frame: takes the lock
  advance(31_000);
  await assert.rejects(TOOLS.open(B, { url: 'https://benefits.example.gov/portal' }), /in use by acme · aaaa/);
});
