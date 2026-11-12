// Rules for who may drive a profile, checked against core.js directly.
// Run: node --test tests/

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createCore, scriptNotes, MAX_APPROVALS, CLAIM_TTL_MS, REQUEST_TTL_MS, COLLECT_TTL_MS, ENDED_GRACE_MS, DENY_COOLDOWN_MS, LOCK_GRACE_MS,
} = require('../extension/core.js');

// the user asked (2026-11-07) for each script explained simply where they approve it.
test('script notes name what a script visibly reaches for, and admit when it builds names or code', () => {
  const kinds = (code) => scriptNotes(code).map((n) => n.kind);
  assert.deepEqual(kinds('[...document.querySelectorAll("tr")].map((r) => r.innerText)'), ['reads']);
  assert.deepEqual(kinds('document.getElementById("go").click(); form.requestSubmit()'), ['reads', 'changes', 'submits']);
  assert.deepEqual(kinds('fetch("/api", { method: "POST" })'), ['network']);
  assert.deepEqual(kinds('sessionStorage.setItem("plan", data); location.href = "/next"'), ['navigates', 'storage']);
  for (const hidden of ['window["fe" + "tch"]("/x")', 'globalThis[name]()', 'new Function(src)()', 'setTimeout("go()", 1)']) {
    assert.ok(kinds(hidden).includes('dynamic'), hidden);
  }
  // Comparisons and array reads are not changes, nor hiding anything.
  assert.deepEqual(kinds('if (x.value == 3 && rows[i] === 2) total += rows[i]'), []);
});

// The dynamic pattern backtracked quadratically: one 20 KB script of "[" took
// ~170 ms, and view() reran every pending script's notes on every call, so a
// session could stall the background page for everyone (attack, 2026-11-07).
test('script notes take linear time on any script, and view() does not recompute them', () => {
  const ms = (fn) => { const t = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t) / 1e6; };
  const nasty = ['['.repeat(20000), '+"'.repeat(10000), '["'.repeat(10000), '[ "'.repeat(6600), `+ '${'a'.repeat(19990)}`];
  for (const code of nasty) {
    const took = ms(() => scriptNotes(code));
    assert.ok(took < 20, `${JSON.stringify(code.slice(0, 6))}... took ${took.toFixed(1)} ms`);
  }
  // Still found where it was before.
  for (const hidden of ['obj[a + "b"]()', 'obj["a" + b]()', 'x[c + d + "e"]', 'x[a + "b" + c]']) {
    assert.ok(scriptNotes(hidden).some((n) => n.kind === 'dynamic'), hidden);
  }
  const { core } = setup();
  grant(core, A);
  for (const code of nasty) core.ask(A, 'eval', JSON.stringify({ url: 'https://example.com/', code }));
  const took = ms(() => { for (let i = 0; i < 20; i++) core.view(); });
  assert.ok(took < 50, `20 views of ${nasty.length} pending scripts took ${took.toFixed(1)} ms`);
  assert.equal(core.view().requests.length, nasty.length);
  assert.ok(core.view().requests.every((r) => Array.isArray(r.notes)));
});

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const C = 'c'.repeat(32);
const MAIL = 'https://mail.google.com/mail/u/0/';
// Projects are full paths (F7); the labels the user reads are their last part and the short id.
const PROJECT = '/home/user/projects/acme';
const BENEFITS = 'https://benefits.example.gov/portal/claims';

function setup() {
  let t = 1_000_000;
  let n = 0;
  const core = createCore({ now: () => t, makeCode: () => `00${n++}`.slice(-3) + ' 000' });
  core.configure({ profile: { name: 'Profile 4', dir: '/p4' } });
  core.opened(A, PROJECT);
  core.opened(B, '/home/user/Projects/billing');
  return { core, advance: (ms) => { t += ms; }, time: () => t };
}

const grant = (core, id) => {
  const { code } = core.claim(id);
  const shown = core.view().pending.find((p) => p.sessionId === id)?.approvalsDigest;
  assert.deepEqual(core.decide(id, code, true, shown), { ok: true, status: 'granted' });
};

/* ---------- remembered approvals ---------- */

// The hash is a remembered function's identity: checked against node's own SHA-256.
test('sha256 is SHA-256 of the UTF-8 code, and no two strings share a hash input', () => {
  const { createHash } = require('node:crypto');
  const { sha256 } = require('../extension/core.js');
  let x = 7;
  const rand = (n) => { x = (x * 1103515245 + 12345) % 2147483648; return Math.floor((x / 2147483648) * n); };
  const pieces = ['a', ' ', '\n', 'é', '€', '😀', '"', '\\', 'Z', String.fromCharCode(0xfb01), String.fromCharCode(0xfffd)];
  for (const len of [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 1000, 20000]) {
    for (let k = 0; k < 3; k++) {
      const text = Array.from({ length: len }, () => pieces[rand(pieces.length)]).join('');
      assert.equal(sha256(text), createHash('sha256').update(text, 'utf8').digest('hex'), `length ${len}`);
    }
  }
  // UTF-8 encoders turn every lone surrogate into U+FFFD, so these would collide.
  const lone = [String.fromCharCode(0xd800), String.fromCharCode(0xdc00), String.fromCharCode(0xfffd)];
  assert.equal(new Set(lone.map((c) => sha256(`"${c}"`))).size, 3);
});

/* A paired session per project: A and B from acme, C from billing. */
function projects() {
  const env = setup();
  env.core.opened(A, PROJECT);
  env.core.opened(B, PROJECT);
  env.core.opened(C, '/home/user/Projects/billing');
  for (const id of [A, B, C]) grant(env.core, id);
  return env;
}
const FN = '(row) => document.querySelectorAll("tr")[row].innerText';
const fnSubject = (url = 'https://portal.acme.example/claims', code = FN) => JSON.stringify({ tabId: 1, url, code, purpose: '' });

const BILLING = '/home/user/Projects/billing';
const X = 'e'.repeat(32);
/* The pending pairing of a session, as the pairing page reads it. */
const pairing = (core, id) => core.view().pending.find((p) => p.sessionId === id);
/* the user allows a pairing with the list the page showed them. */
const allowShown = (core, id) => {
  core.claim(id);
  const p = pairing(core, id);
  return core.decide(id, p.code, true, p.approvalsDigest);
};

/* the user allows a question with Remember ticked, and the host confirms the write. */
function remember(core, id, kind, subject) {
  const q = core.ask(id, kind, subject);
  const out = core.answer(q, true, { remember: true });
  assert.equal(out.ok, true);
  return out.remember;
}

// Rewritten for F1/F1b (2026-11-07): a remembered approval reaches only
// pairings after it, never a lease from before.
test('a remembered site stands only once the host confirms it, then for later pairings of its project only, and only under a lease', () => {
  const { core } = projects();
  const D = 'd'.repeat(32);
  core.opened(D, PROJECT);
  const entry = remember(core, A, 'site', 'mail.google.com');
  assert.deepEqual({ ...entry, added: 0 }, { project: PROJECT, kind: 'site', site: 'mail.google.com', added: 0, label: 'acme · aaaa' });
  assert.equal(core.urlRefusal(MAIL, A), null, 'the Allow applies to the session that asked at once');
  core.claim(D);
  assert.deepEqual(pairing(core, D).approvals, [], 'listed before the host wrote it');
  core.hostApprovals([entry], { type: 'remember', entry });
  assert.deepEqual(pairing(core, D).approvals.map((e) => e.site), ['mail.google.com']);
  grant(core, D);
  assert.equal(core.granted(D, 'mail.google.com'), true);
  assert.match(core.urlRefusal(MAIL, B), /protected/, 'a lease from before the remember got it');
  assert.equal(core.granted(C, 'mail.google.com'), false, 'another project got it');
  assert.equal(core.granted(D, 'accounts.google.com'), false, 'another site of the same lock group');
  assert.equal(core.enter(A, MAIL), null);
  assert.match(core.enter(D, MAIL) ?? '', /in use by acme · aaaa/, 'a remembered site lifts the lock');
  core.release(A, 'done');
  core.release(D, 'r');
  assert.equal(core.granted(D, 'mail.google.com'), false, 'without a lease');
  assert.match(core.urlRefusal(MAIL, D), /protected/);
  // A new pairing from the project gets it again; the user saw it listed first.
  core.claim(D);
  assert.deepEqual(pairing(core, D).approvals.map((e) => e.site), ['mail.google.com']);
  assert.deepEqual(core.view().pending.length, 1);
  grant(core, D);
  assert.equal(core.granted(D, 'mail.google.com'), true);
  // The deny list is a refusal no approval lifts.
  core.configure({ deny: ['mail.google.com'] });
  assert.match(core.urlRefusal(MAIL, D), /deny list/);
});

test('a session without a project, and an eval, are never remembered', () => {
  const { core } = projects();
  const D = 'd'.repeat(32);
  core.opened(D); // a server that declares none
  grant(core, D);
  assert.equal(remember(core, D, 'site', 'mail.google.com'), undefined);
  assert.equal(remember(core, A, 'eval', JSON.stringify({ tabId: 1, url: 'https://example.com/', code: '1' })), undefined);
  assert.equal(core.answer(core.ask(A, 'site', 'acme.example'), true).remember, undefined, 'remembered without the tick');
  // Entries for a project nobody has do not stand for a session with none.
  core.hostApprovals([{ project: '', kind: 'site', site: 'accounts.google.com', added: 1, label: 'x' }]);
  assert.equal(core.granted(D, 'accounts.google.com'), false);
});

test('a remembered function approves only its exact code, on its origin, for later pairings of its project; it ends with the lease', () => {
  const { core } = projects();
  const D = 'd'.repeat(32);
  core.opened(D, PROJECT);
  const entry = remember(core, A, 'function', fnSubject());
  assert.equal(entry.origin, 'https://portal.acme.example');
  assert.match(entry.sha256, /^[0-9a-f]{64}$/);
  core.hostApprovals([entry], { type: 'remember', entry });
  assert.equal(core.rememberedFunction(B, 'https://portal.acme.example/a', FN), null, 'a lease from before the remember got it');
  grant(core, D);
  const got = core.rememberedFunction(D, 'https://portal.acme.example/other?x=1', FN);
  assert.deepEqual(got && { ...got, fnId: 'f' }, { fnId: 'f', origin: 'https://portal.acme.example' });
  assert.equal(core.approvedFunction(D, got.fnId).code, FN);
  for (const changed of [`${FN} `, FN.replace('tr', 'td'), FN.replace('"', "'")]) {
    assert.equal(core.rememberedFunction(D, 'https://portal.acme.example/a', changed), null, `changed code: ${changed}`);
  }
  assert.equal(core.rememberedFunction(D, 'http://portal.acme.example/a', FN), null, 'another origin');
  assert.equal(core.rememberedFunction(C, 'https://portal.acme.example/a', FN), null, 'another project');
  core.revoke(D);
  assert.throws(() => core.approvedFunction(D, got.fnId), /not connected/);
  assert.throws(() => core.rememberedFunction(D, 'https://portal.acme.example/a', FN), /not connected/);
  grant(core, D);
  assert.equal(core.approvedFunction(D, got.fnId), null, 'a new lease revived it');
});

test('forget applies at once, to every session, and a stale answer from the host never brings it back', () => {
  const { core } = projects();
  const site = remember(core, A, 'site', 'mail.google.com');
  const fn = remember(core, A, 'function', fnSubject());
  core.hostApprovals([site], { type: 'remember', entry: site });
  core.hostApprovals([site, fn], { type: 'remember', entry: fn });
  core.release(B, 'r');
  grant(core, B); // paired again, with both listed
  const viaFn = core.rememberedFunction(B, 'https://portal.acme.example/a', FN).fnId;

  // A third remember is in flight when the user forgets the site and the function.
  const other = remember(core, C, 'site', 'acme.example');
  const D = 'd'.repeat(32);
  core.opened(D, PROJECT);
  grant(core, D);
  const late = remember(core, D, 'site', 'mail.google.com'); // the same site, ticked again by another session before the forget
  assert.ok(core.forget(site));
  assert.ok(core.forget(fn));
  assert.equal(core.granted(B, 'mail.google.com'), false, 'forget waited for the host');
  assert.equal(core.approvedFunction(B, viaFn), null, 'a function approved through the entry outlived it');
  assert.equal(core.granted(A, 'mail.google.com'), true, 'the Allow the user gave the asking session is its own, until its lease ends');
  core.hostApprovals([site, fn, other], { type: 'remember', entry: other }); // written before the forgets
  core.hostApprovals([site, fn, other], { type: 'remember', entry: late }); // a duplicate, asked before the forget
  assert.equal(core.granted(C, 'mail.google.com'), false);
  assert.equal(core.view().approvals.some((e) => e.site === 'mail.google.com'), false, 'a stale answer revived a forgotten site');
  assert.equal(core.rememberedFunction(B, 'https://portal.acme.example/a', FN), null, 'a stale answer revived a forgotten function');
  assert.deepEqual(core.view().approvals.map((e) => e.site ?? e.origin), ['acme.example']);
  // The host fails to write one forget: it stays forgotten here.
  core.hostApprovals([fn, other], { type: 'forget', entry: site });
  core.hostApprovals([fn, other], { type: 'forget', entry: fn }, 'could not save: disk full');
  assert.equal(core.rememberedFunction(B, 'https://portal.acme.example/a', FN), null, 'a failed forget brought it back');
  // A host started later still lists it: the add-on is told to ask again.
  assert.deepEqual(core.hostApprovals([fn, other]), [fn]);
  assert.equal(core.rememberedFunction(B, 'https://portal.acme.example/a', FN), null);
  // Remembered again, and confirmed, it stands again for the next pairing.
  const again = remember(core, B, 'site', 'mail.google.com');
  core.hostApprovals([fn, other, again], { type: 'remember', entry: again });
  assert.equal(core.granted(C, 'mail.google.com'), false);
  assert.equal(core.granted(A, 'mail.google.com'), true);
  core.release(A, 'r');
  grant(core, A);
  assert.equal(core.granted(A, 'mail.google.com'), true, 'remembered anew');
  assert.equal(core.forget({ kind: 'eval', project: 'x' }), null);
  assert.equal(core.forget({ kind: 'site', project: PROJECT }), null);
});

test('the project a lease gets approvals under is the one the user saw at pairing', () => {
  const { core } = projects();
  const entry = remember(core, A, 'site', 'mail.google.com');
  core.hostApprovals([entry], { type: 'remember', entry });
  const D = 'd'.repeat(32);
  core.opened(D, '/home/user/Projects/billing');
  core.claim(D);
  assert.deepEqual(pairing(core, D).approvals, []);
  core.opened(D, PROJECT); // the server says otherwise after the page was shown
  grant(core, D);
  assert.equal(core.granted(D, 'mail.google.com'), false);
});

/* ---------- remembered approvals, fixed (attack on remembered approvals, 2026-11-07) ---------- */


// F1: a session chose its label and its project apart, so it paired as
// "scratch · eeee" while declaring project billing.
test('a session\'s label is its project\'s last part and its short id; it cannot pair under a name that hides its project', () => {
  const { core } = setup();
  core.opened(X, BILLING);
  core.claim(X);
  assert.deepEqual([pairing(core, X).label, pairing(core, X).project], ['billing · eeee', BILLING]);
  // Anything but a plain absolute path is no project: nothing is remembered for it.
  for (const bad of ['billing', 'scratch · eeee', '', `${BILLING}\n`, '/home/user/‮billing', '/Users/x​/billing', `/${'x'.repeat(500)}`, 42, null]) {
    core.release(X, 'r');
    core.opened(X, bad);
    core.claim(X);
    assert.deepEqual([pairing(core, X).label, pairing(core, X).project], ['no project · eeee', ''], JSON.stringify(bad));
  }
});

// F1, F1b: remembered approvals were looked up at every call, so one
// remembered after a session paired flowed into its lease unseen.
test('an approval remembered after a session paired reaches only later pairings, which list it before Allow', () => {
  const { core } = setup();
  core.opened(A, BILLING);
  core.opened(X, BILLING);
  for (const id of [A, X]) assert.equal(allowShown(core, id).ok, true);
  const site = remember(core, A, 'site', 'mail.google.com');
  core.hostApprovals([site], { type: 'remember', entry: site });
  const fn = remember(core, A, 'function', fnSubject());
  core.hostApprovals([site, fn], { type: 'remember', entry: fn });
  assert.equal(core.granted(X, 'mail.google.com'), false, 'a session paired before the remember got Gmail without being asked');
  assert.match(core.urlRefusal(MAIL, X), /protected/);
  assert.equal(core.rememberedFunction(X, 'https://portal.acme.example/a', FN), null, 'a session paired before the remember got the function');
  assert.deepEqual(core.view().leases.find((l) => l.sessionId === X).standing, []);
  // Paired again, the page lists both, and Allow with that list gives both.
  core.release(X, 'r');
  core.claim(X);
  assert.deepEqual(pairing(core, X).approvals.map((e) => e.site ?? e.origin), ['mail.google.com', 'https://portal.acme.example']);
  assert.equal(allowShown(core, X).ok, true);
  assert.equal(core.granted(X, 'mail.google.com'), true);
  assert.ok(core.rememberedFunction(X, 'https://portal.acme.example/a', FN));
  assert.deepEqual(core.view().leases.find((l) => l.sessionId === X).standing.map((e) => e.site ?? e.origin), ['mail.google.com', 'https://portal.acme.example']);
});

test('Allow is tied to the list the pairing page showed: a list that changed since refuses it, and the pairing stays to be read again', () => {
  const { core } = setup();
  core.opened(A, BILLING);
  core.opened(X, BILLING);
  assert.equal(allowShown(core, A).ok, true);
  core.claim(X);
  const shown = pairing(core, X);
  assert.deepEqual(shown.approvals, []);
  const site = remember(core, A, 'site', 'mail.google.com');
  core.hostApprovals([site], { type: 'remember', entry: site });
  for (const digest of [shown.approvalsDigest, undefined, 'x']) {
    const r = core.decide(X, shown.code, true, digest);
    assert.equal(r.ok, false, `allowed with ${digest} after the list changed`);
    assert.match(r.error, /changed/);
    assert.equal(core.claimStatus(X), 'pending');
  }
  const now = pairing(core, X);
  assert.notEqual(now.approvalsDigest, shown.approvalsDigest);
  assert.equal(core.decide(X, now.code, true, now.approvalsDigest).ok, true);
  assert.equal(core.granted(X, 'mail.google.com'), true);
  // Forget ends it for every lease at once; remembered again, it stays out of leases from before.
  core.forget(site);
  assert.equal(core.granted(X, 'mail.google.com'), false);
  core.hostApprovals([], { type: 'forget', entry: site });
  const again = remember(core, A, 'site', 'mail.google.com');
  core.hostApprovals([again], { type: 'remember', entry: again });
  assert.equal(core.granted(X, 'mail.google.com'), false, 'a forgotten approval came back into a lease from before');
  // Refusing needs no list.
  core.release(X, 'r');
  core.claim(X);
  assert.equal(core.decide(X, pairing(core, X).code, false).ok, true);
});

// F4: the forgets in flight were a set, so Forget, Remember, Forget let the
// first confirmation clear the key and the remember's answer revive it.
test('forgets are counted: Forget, Remember, Forget with a slow host keeps it forgotten until the last forget is written', () => {
  const { core } = projects();
  const site = remember(core, A, 'site', 'mail.google.com');
  core.hostApprovals([site], { type: 'remember', entry: site });
  core.forget(site);
  const again = remember(core, B, 'site', 'mail.google.com');
  core.forget(site);
  core.hostApprovals([], { type: 'forget', entry: site });
  core.hostApprovals([again], { type: 'remember', entry: again });
  assert.deepEqual(core.view().approvals, [], 'the remember answered before the second forget revived it');
  core.release(C, 'r');
  core.claim(C);
  assert.deepEqual(pairing(core, C).approvals, []);
  core.hostApprovals([], { type: 'forget', entry: again });
  assert.deepEqual(core.view().approvals, []);
  assert.deepEqual(core.view().forgets, []);
});

// F5: Forget read as done at once, so one the host never wrote came back
// after a restart without a word.
test('a forget is pending until the host confirms it; one that failed, or never reached a host, stays failed until retried', () => {
  const { core } = projects();
  const site = remember(core, A, 'site', 'mail.google.com');
  const fn = remember(core, A, 'function', fnSubject());
  core.hostApprovals([site, fn], { type: 'remember', entry: fn });
  const status = () => core.view().forgets.map((f) => [f.entry.site ?? f.entry.origin, f.status, f.error ?? null]);
  core.forget(site);
  assert.deepEqual(status(), [['mail.google.com', 'pending', null]]);
  assert.deepEqual(core.view().approvals.map((e) => e.origin), ['https://portal.acme.example'], 'a pending forget still counted');
  core.hostApprovals([site, fn], { type: 'forget', entry: site }, 'could not save: disk full');
  assert.deepEqual(status(), [['mail.google.com', 'failed', 'could not save: disk full']]);
  assert.equal(core.view().approvals.some((e) => e.site), false, 'a failed forget brought it back here');
  core.forget(site); // Retry
  assert.deepEqual(status(), [['mail.google.com', 'pending', null]]);
  core.hostApprovals([fn], { type: 'forget', entry: site });
  assert.deepEqual(status(), []);
  // Two forgets in flight: the first fails, the later one is written, so it is done.
  const again = remember(core, B, 'site', 'mail.google.com');
  core.hostApprovals([fn, again], { type: 'remember', entry: again });
  core.forget(again);
  core.forget(again);
  core.hostApprovals([fn, again], { type: 'forget', entry: again }, 'could not save: disk full');
  assert.deepEqual(status(), [['mail.google.com', 'pending', null]]);
  core.hostApprovals([fn], { type: 'forget', entry: again });
  assert.deepEqual(status(), [], 'a forget the host wrote still shows as failed');
  // No host to send it to, or the host stopped before answering: failed, never done.
  core.forget(fn);
  core.forgetFailed(fn, 'the Firefox Driver host is not running');
  assert.deepEqual(status(), [['https://portal.acme.example', 'failed', 'the Firefox Driver host is not running']]);
  core.forget(fn);
  core.forgetsLost('the host stopped before it saved this');
  assert.deepEqual(status(), [['https://portal.acme.example', 'failed', 'the host stopped before it saved this']]);
  // A new host that still lists it is asked again; one that does not settles it.
  assert.deepEqual(core.hostApprovals([fn]), [fn]);
  assert.deepEqual(status(), [['https://portal.acme.example', 'pending', null]]);
  core.forgetsLost('the host stopped before it saved this');
  assert.deepEqual(core.hostApprovals([]), []);
  assert.deepEqual(status(), []);
});

test('Remember stops at the cap: the Allow still applies, nothing is remembered, and the user is told why', () => {
  const { core } = projects();
  const many = Array.from({ length: MAX_APPROVALS }, (_, i) => ({ project: '/home/user/Projects/other', kind: 'site', site: `s${i}.example`, added: 1, label: 'other · ffff' }));
  core.hostApprovals(many);
  assert.equal(core.view().approvalsFull, true);
  const out = core.answer(core.ask(A, 'site', 'mail.google.com'), true, { remember: true });
  assert.equal(out.ok, true);
  assert.equal(out.remember, undefined, 'remembered past the cap');
  assert.equal(core.granted(A, 'mail.google.com'), true);
  assert.match(core.view().notices.map((n) => n.text).join(), /not remembered.*500/i);
  const [notice] = core.view().notices;
  core.dismiss(notice.id);
  assert.deepEqual(core.view().notices, []);
});

test('a claim grants nothing until the matching code is approved', () => {
  const { core } = setup();
  const r = core.claim(A);
  assert.equal(r.status, 'pending');
  assert.throws(() => core.authorize(A), /not connected/);
  assert.equal(core.decide(A, 'wrong', true).ok, false);
  assert.throws(() => core.authorize(A), /not connected/);
  assert.equal(core.decide(A, r.code, true).ok, true);
  core.authorize(A);
});

test('claiming again while pending returns the same code; after a refusal a new one comes only after a cooldown that doubles', () => {
  const { core, advance } = setup();
  const first = core.claim(A);
  const again = core.claim(A);
  assert.equal(again.code, first.code);
  assert.equal(again.fresh, false);
  core.decide(A, first.code, false);
  assert.equal(core.claimStatus(A), 'denied');
  assert.deepEqual(core.claim(A), { status: 'denied', retryAfterS: DENY_COOLDOWN_MS / 1000 });
  advance(DENY_COOLDOWN_MS);
  const third = core.claim(A);
  assert.notEqual(third.code, first.code);
  assert.equal(third.fresh, true);
  core.decide(A, third.code, false);
  advance(DENY_COOLDOWN_MS);
  assert.equal(core.claim(A).status, 'denied', 'the second refusal waits twice as long');
  advance(DENY_COOLDOWN_MS);
  assert.equal(core.claim(A).status, 'pending');
  assert.equal(core.view().pending.length, 1, 'a refused session never shows a request while cooling down');
});

test('two sessions drive at once; approving the second displaces nobody', () => {
  const { core } = setup();
  grant(core, A);
  const b = core.claim(B);
  assert.deepEqual(b.others, ['acme · aaaa'], 'who else drives, as information');
  assert.throws(() => core.authorize(B), /not connected/, 'B waits for its own code');
  core.decide(B, b.code, true);
  core.authorize(A);
  core.authorize(B);
  core.ownTab(10, A);
  core.ownTab(20, B);
  core.checkTab(A, 10);
  core.checkTab(B, 20);
  assert.throws(() => core.checkTab(B, 10), /not one of this session's tabs/);
  assert.deepEqual(core.view().leases.map((l) => l.label), ['acme · aaaa', 'billing · bbbb']);
  assert.equal(core.claim(A).status, 'granted');
});

test('ending one session leaves the other\'s lease, grants, functions, questions and tabs intact', () => {
  for (const end of [(c) => c.release(A, 'r'), (c) => c.revoke(A), (c) => c.closed(A)]) {
    const { core } = setup();
    grant(core, A);
    grant(core, B);
    core.ownTab(20, B);
    core.answer(core.ask(B, 'site', 'mail.google.com'), true);
    const f = core.ask(B, 'function', JSON.stringify({ tabId: 20, url: 'https://example.com/a', code: '(n) => n' }));
    core.answer(f, true);
    const { fnId } = core.settle(B, f);
    const q = core.ask(B, 'eval', '1');
    core.answer(core.ask(A, 'site', 'mail.google.com'), true);
    end(core);
    assert.throws(() => core.authorize(A), /not connected/);
    core.authorize(B);
    core.checkTab(B, 20);
    assert.equal(core.urlRefusal(MAIL, B), null);
    assert.ok(core.approvedFunction(B, fnId));
    assert.equal(core.settle(B, q).status, 'pending');
    assert.deepEqual(core.view().leases.map((l) => l.sessionId), [B]);
  }
});

test('a code approves only its own session', () => {
  const { core } = setup();
  const a = core.claim(A);
  core.claim(B);
  assert.equal(core.decide(B, a.code, true).ok, false);
  assert.throws(() => core.authorize(B));
});

test('a pending request expires after the TTL and cannot then be approved', () => {
  const { core, advance } = setup();
  const r = core.claim(A);
  advance(CLAIM_TTL_MS + 1);
  assert.equal(core.claimStatus(A), 'expired');
  assert.equal(core.decide(A, r.code, true).ok, false);
  assert.throws(() => core.authorize(A));
});

test('ending, releasing or revoking ends control, with the reason', () => {
  for (const [end, reason] of [
    [(c) => c.closed(A), /session ended/],
    [(c) => c.release(A, 'released by the session'), /released by the session/],
    [(c) => c.revoke(A), /revoked in Firefox/],
    [(c) => c.revokeAll('Firefox Driver host stopped'), /host stopped/],
  ]) {
    const { core } = setup();
    grant(core, A);
    end(core);
    assert.deepEqual(core.view().leases, []);
    assert.throws(() => core.authorize(A), reason);
  }
});

test('revoking names one session; revokeAll ends every lease', () => {
  const { core } = setup();
  grant(core, A);
  grant(core, B);
  assert.equal(core.revoke(C), false);
  assert.equal(core.revoke(B), true);
  core.authorize(A);
  grant(core, B);
  assert.equal(core.revokeAll('Firefox Driver host stopped'), 2);
  assert.throws(() => core.authorize(A), /host stopped/);
  assert.throws(() => core.authorize(B), /host stopped/);
});

test('a session that ends while pending leaves nothing approvable', () => {
  const { core } = setup();
  const r = core.claim(A);
  core.closed(A);
  assert.equal(core.view().pending.length, 0);
  assert.equal(core.decide(A, r.code, true).ok, false);
});

test('a session may use only tabs it opened, and only while it drives', () => {
  const { core } = setup();
  grant(core, A);
  core.ownTab(10, A);
  assert.throws(() => core.ownTab(20, B), /not connected/, 'a session that does not drive owns nothing');
  core.checkTab(A, 10);
  assert.throws(() => core.checkTab(A, 20), /not one of this session's tabs/);
  assert.throws(() => core.checkTab(A, 30), /not one of this session's tabs/);
  assert.throws(() => core.checkTab(B, 20), /not connected/);
  core.tabRemoved(10);
  assert.throws(() => core.checkTab(A, 10));
});

test('URL rules: built-in and configured hosts, subdomains, and non-web schemes are refused', () => {
  const { core } = setup();
  core.configure({ deny: ['claims.example.org', '  Portal.Test  '] });
  const refused = [
    'https://mail.google.com/mail/u/0/', 'https://MAIL.GOOGLE.COM./x', 'https://outlook.office.com/mail/', 'http://appleid.apple.com',
    'https://claims.example.org/a', 'https://deep.portal.test/', 'javascript:alert(1)', 'about:config', 'about:blank',
    'file:///etc/passwd', 'moz-extension://abc/confirm.html', 'data:text/html,hi', 'view-source:https://a.com', 'not a url',
  ];
  const allowed = ['https://search.google.com/search-console', 'https://acme.example/', 'https://github.com/login', 'https://www.apple.com/', 'https://mail.google.com.evil.test/', 'http://localhost:4321/'];
  for (const u of refused) assert.ok(core.urlRefusal(u), `should refuse ${u}`);
  for (const u of allowed) assert.equal(core.urlRefusal(u), null, `should allow ${u}`);
});

test('configuration cannot remove the built-in protected sites', () => {
  const { core } = setup();
  core.configure({ deny: [] });
  assert.ok(core.urlRefusal('https://mail.google.com/'));
  assert.ok(core.urlRefusal('https://login.microsoftonline.com/'));
  assert.ok(core.urlRefusal('https://account.apple.com/'));
});

// Public release: the built-ins are the account, sign-in
// and web mail pages of Google, Microsoft and Apple (iCloud Mail and Drive
// included, 2026-11-07), one lock per provider.
// A work portal and GitHub (its login is github.com itself) are
// not built in; config.json adds them.
test('built-in protected sites: account, sign-in and mail pages of Google, Microsoft and Apple, one lock each', () => {
  const { core } = setup();
  const BUILT_IN = {
    'google sign-in': ['accounts.google.com', 'myaccount.google.com', 'mail.google.com', 'takeout.google.com', 'script.google.com', 'admin.google.com'],
    'microsoft sign-in': ['login.microsoftonline.com', 'login.microsoft.com', 'login.live.com', 'account.microsoft.com', 'account.live.com',
      'myaccount.microsoft.com', 'mysignins.microsoft.com', 'outlook.live.com', 'outlook.office.com', 'outlook.office365.com', 'outlook.cloud.microsoft'],
    'apple sign-in': ['account.apple.com', 'appleid.apple.com', 'idmsa.apple.com', 'iforgot.apple.com', 'www.icloud.com'],
  };
  for (const [group, hosts] of Object.entries(BUILT_IN)) {
    for (const host of hosts) {
      assert.equal(core.protectedSite(`https://${host}/x`), host, `${host} is not protected`);
      assert.equal(core.lockedSite(`https://${host}/x`), group, `${host} is not under the ${group} lock`);
    }
  }
  for (const u of ['https://acme.example/', 'https://x.acme.net/', 'https://github.com/login', 'https://www.microsoft.com/']) {
    assert.equal(core.protectedSite(u), null, `${u} is built in`);
    assert.equal(core.lockedSite(u), null, `${u} is locked`);
  }
  assert.deepEqual(core.view().protect.sort(), Object.values(BUILT_IN).flat().sort(), 'the built-ins are exactly these');
});

test('only the add-on\'s own pages are trusted to approve', () => {
  const { core } = setup();
  const id = 'foxlatch-personal@localhost';
  const base = 'moz-extension://1234/';
  const confirmPage = { id, url: `${base}confirm.html#x`, envType: 'addon_child', tab: { id: 5, url: `${base}confirm.html#x` } };
  const popup = { id, url: `${base}popup.html`, envType: 'addon_child' };
  const contentScript = { id, url: 'https://evil.test/', envType: 'content_child', tab: { id: 6, url: 'https://evil.test/' } };
  const lyingContent = { id, url: `${base}confirm.html`, envType: 'content_child', tab: { id: 6, url: 'https://evil.test/' } };
  const otherAddon = { ...confirmPage, id: 'other@addon' };
  assert.equal(core.trustedSender(confirmPage, id, base), true);
  assert.equal(core.trustedSender(popup, id, base), true);
  for (const s of [contentScript, lyingContent, otherAddon, undefined, {}]) assert.equal(core.trustedSender(s, id, base), false);
});

test('a protected site opens only for the session the user allowed it to, and only that site', () => {
  const { core } = setup();
  grant(core, A);
  assert.match(core.urlRefusal(MAIL, A), /protected/);
  const id = core.ask(A, 'site', core.protectedSite(MAIL));
  assert.equal(core.view().requests.length, 1);
  assert.equal(core.urlRefusal(MAIL, A) !== null, true, 'nothing opens while the question is pending');
  assert.deepEqual(core.answer(id, true), { ok: true, status: 'approved' });
  assert.equal(core.urlRefusal(MAIL, A), null);
  assert.equal(core.urlRefusal('https://MAIL.google.com./other', A), null);
  assert.match(core.urlRefusal('https://account.apple.com/', A), /protected/);
  assert.match(core.urlRefusal(MAIL, B), /protected/);
  assert.deepEqual(core.view().leases[0].sites, ['mail.google.com']);
});

test('grants end with control: release, revoke, revokeAll and session end', () => {
  for (const end of [(c) => c.release(A, 'r'), (c) => c.revoke(A), (c) => c.revokeAll(), (c) => c.closed(A)]) {
    const { core } = setup();
    grant(core, A);
    core.answer(core.ask(A, 'site', 'mail.google.com'), true);
    end(core);
    grant(core, A); // a fresh lease for A
    assert.match(core.urlRefusal(MAIL, A) ?? 'still allowed', /protected/, 'a new lease starts with no grants');
  }
});

test('a pending question ends with its session\'s control, is forgotten, and cannot be answered after', () => {
  const { core } = setup();
  grant(core, A);
  const id = core.ask(A, 'eval', 'document.title');
  grant(core, B);
  assert.equal(core.settle(A, id).status, 'pending', 'another session connecting cancels nothing');
  core.revoke(A);
  assert.equal(core.answer(id, true).ok, false);
  assert.equal(core.settle(A, id).status, 'none');
  assert.equal(core.requestOf(id), null);
  assert.equal(core.view().requests.length, 0);
});

test('questions: only drivers ask, unanswered ones expire, an approved script\'s code is handed out once', () => {
  const { core, advance } = setup();
  assert.throws(() => core.ask(A, 'site', 'mail.google.com'), /not connected/);
  grant(core, A);
  const id = core.ask(A, 'eval', 'x');
  assert.equal(core.ask(A, 'eval', 'x'), id, 'the same pending question is not asked twice');
  assert.equal(core.settle(A, id).status, 'pending');
  advance(REQUEST_TTL_MS + 1);
  assert.equal(core.answer(id, true).ok, false);
  assert.equal(core.settle(A, id).status, 'expired');
  const next = core.ask(A, 'eval', 'x');
  core.answer(next, true);
  assert.deepEqual(core.settle(A, next), { status: 'approved', subject: 'x' });
  assert.deepEqual(core.settle(A, next), { status: 'running' }, 'a second read gets the state, never the code');
  assert.equal(core.urlRefusal(MAIL, A) !== null, true, 'an approved script grants no site');
});

// eval and define return before the user answers, so a question now waits for
// its session to come back for the answer; ids are sequential and guessable.
test('a question and its answer are read only by the session that asked', () => {
  const { core } = setup();
  grant(core, A);
  grant(core, B);
  const id = core.ask(A, 'eval', JSON.stringify({ tabId: 1, frameId: 0, url: 'https://example.com/', code: '1' }));
  assert.equal(core.settle(B, id).status, 'none', 'another session sees no such question');
  assert.equal(core.settle(A, id).status, 'pending');
  core.answer(id, true);
  assert.equal(core.settle(B, id).status, 'none', 'another session cannot collect the answer');
  assert.equal(core.settle(A, id).status, 'approved', 'and its attempt did not use it up');
  assert.equal(core.settle(A, id).status, 'running', 'read once');
  assert.equal(core.settle(B, id).status, 'none', 'nor its state');
});

test('an answer not yet collected ends with the lease, and a new lease does not revive it', () => {
  for (const end of [(c) => c.release(A, 'r'), (c) => c.revoke(A), (c) => c.closed(A)]) {
    const { core } = setup();
    grant(core, A);
    const script = core.ask(A, 'eval', JSON.stringify({ tabId: 1, frameId: 0, url: 'https://example.com/', code: '1' }));
    const fn = core.ask(A, 'function', JSON.stringify({ tabId: 1, url: 'https://example.com/', code: '() => 1' }));
    core.answer(script, true);
    core.answer(fn, true);
    end(core);
    core.opened(A, 'acme · aaaa');
    grant(core, A);
    assert.equal(core.settle(A, script).status, 'none', 'an approved script would run under a lease the user did not give it to');
    assert.equal(core.settle(A, fn).status, 'none');
    assert.equal(core.requestOf(script), null);
  }
});

// Two awaits on one question, or a retry while the script still runs: the
// second call must hear that the script is taken, never that nothing is there.
test('a collected script reads running, then ran or refused, until its lease ends', () => {
  const { core, advance } = setup();
  grant(core, A);
  const script = (code) => core.ask(A, 'eval', JSON.stringify({ tabId: 1, frameId: 0, url: 'https://example.com/', code }));
  const ran = script('1');
  core.answer(ran, true);
  assert.equal(core.settle(A, ran).status, 'approved');
  assert.deepEqual(core.settle(A, ran), { status: 'running' });
  assert.equal(core.view().requests.length, 0, 'a running script is not a question to the user');
  advance(24 * 60 * 60 * 1000); // a page promise that never settles holds it as long as it likes
  assert.deepEqual(core.settle(A, ran), { status: 'running' });
  core.finished(ran);
  assert.deepEqual(core.settle(A, ran), { status: 'ran' });
  const refused = script('2');
  core.answer(refused, true);
  core.settle(A, refused);
  core.finished(refused, 'the tab moved');
  assert.deepEqual(core.settle(A, refused), { status: 'refused', reason: 'the tab moved' });
  core.finished(ran, 'late'); // only a running script finishes
  assert.deepEqual(core.settle(A, ran), { status: 'ran' });
  assert.equal(JSON.stringify(core.requestOf(ran)).includes('code'), false, 'a collected script keeps its code');
  const fn = core.ask(A, 'function', JSON.stringify({ tabId: 1, url: 'https://example.com/a', code: '(n) => n' }));
  core.answer(fn, true);
  const { fnId } = core.settle(A, fn);
  assert.deepEqual(core.settle(A, fn), { status: 'collected', fnId, origin: 'https://example.com' }, 'every caller learns its id');
  core.release(A, 'r');
  for (const id of [ran, refused, fn]) assert.equal(core.requestOf(id), null, `${id} outlived the lease`);
});

// eval and define no longer settle their own question, so one its session
// never collects was held, code and all, for the life of the add-on.
test('a question that ended without running anything is told to every caller for ENDED_GRACE_MS, then forgotten', () => {
  const { core, advance } = setup();
  grant(core, A);
  const denied = core.ask(A, 'eval', 'd');
  core.answer(denied, false);
  assert.deepEqual(core.settle(A, denied), { status: 'denied' });
  assert.deepEqual(core.settle(A, denied), { status: 'denied' }, 'a second caller hears the no too');
  assert.equal(core.requestOf(denied).subject, undefined, 'an ended question keeps its code');
  advance(ENDED_GRACE_MS);
  assert.equal(core.settle(A, denied).status, 'denied');
  advance(1);
  assert.equal(core.settle(A, denied).status, 'none');
  assert.equal(core.requestOf(denied), null);

  const expired = core.ask(A, 'eval', 'e');
  advance(REQUEST_TTL_MS + ENDED_GRACE_MS - 1000);
  assert.deepEqual(core.settle(A, expired), { status: 'expired' }, 'its grace counts from when it expired, not from when it was read');
  advance(1001);
  core.view(); // forgetting is lazy, on the next operation (ask.html polls view every second)
  assert.equal(core.requestOf(expired), null);
});

// An Allow was tied to a URL and never expired: one collected an hour later
// still ran.
test('an approved script or function nobody collects lapses COLLECT_TTL_MS after the answer', () => {
  const { core, advance } = setup();
  grant(core, A);
  const script = core.ask(A, 'eval', JSON.stringify({ tabId: 1, frameId: 0, url: 'https://example.com/', code: '1' }));
  const fn = core.ask(A, 'function', JSON.stringify({ tabId: 1, url: 'https://example.com/', code: '() => 1' }));
  advance(REQUEST_TTL_MS - 1000); // answered just before the question expired
  core.answer(script, true);
  core.answer(fn, true);
  const { fnId } = core.requestOf(fn);
  assert.ok(core.approvedFunction(A, fnId));
  advance(COLLECT_TTL_MS);
  core.view();
  assert.equal(core.requestOf(script).status, 'approved', 'it lapsed counting from the question, not the answer');
  advance(1);
  assert.deepEqual(core.settle(A, script), { status: 'lapsed' });
  assert.deepEqual(core.settle(A, fn), { status: 'lapsed' });
  assert.equal(core.approvedFunction(A, fnId), null, 'the function its session never learned stays callable');
  advance(ENDED_GRACE_MS + 1);
  core.view();
  assert.equal(core.requestOf(script), null);
});

test('a claim that once succeeded reads ended, not granted, after control is lost', () => {
  const { core } = setup();
  grant(core, A);
  core.revoke(A);
  assert.equal(core.claimStatus(A), 'ended');
  grant(core, A);
  grant(core, B);
  assert.equal(core.claimStatus(A), 'granted');
  core.closed(A);
  assert.equal(core.claimStatus(A), 'ended');
});

test('the deny list is a refusal no approval lifts', () => {
  const { core } = setup();
  core.configure({ deny: ['claims.example.org'], protect: ['portal.test'] });
  grant(core, A);
  assert.match(core.hardRefusal('https://claims.example.org/'), /deny list/);
  assert.equal(core.hardRefusal(MAIL), null);
  core.answer(core.ask(A, 'site', 'claims.example.org'), true);
  assert.match(core.urlRefusal('https://claims.example.org/', A), /deny list/);
  assert.equal(core.protectedSite('https://x.portal.test/'), 'portal.test');
});

test('property: across random operation sequences, each operation touches only its own session, and each lock group has at most one live holder; a remembered site stands for the later pairings of its project once written, and never once forgotten', (t) => {
  // The model, written out by hand rather than derived from core.js: which
  // lock group and which protected site each URL falls under. Sibling hosts
  // share a group (the Google sign-in, the Microsoft one), and the config overlaps
  // (example.gov over benefits.example.gov) and spans two hosts (a portal and its sign-in).
  const URLS = {
    [MAIL]: ['google sign-in', 'mail.google.com'],
    'https://accounts.google.com/signin': ['google sign-in', 'accounts.google.com'],
    'https://login.live.com/': ['microsoft sign-in', 'login.live.com'],
    'https://x.outlook.office.com/': ['microsoft sign-in', 'outlook.office.com'],
    [BENEFITS]: ['example.gov', null],
    'https://www.example.gov/': ['example.gov', null],
    'https://portal.test/claims': ['portal.test + login.idp.test', null],
    'https://login.idp.test/': ['portal.test + login.idp.test', null],
    'https://search.google.com/': [null, null],
    'https://example.com/': [null, null],
  };
  const urls = Object.keys(URLS);
  const GROUPS = [...new Set(Object.values(URLS).map(([g]) => g).filter(Boolean))];
  const SITES = [...new Set(Object.values(URLS).map(([, p]) => p).filter(Boolean))];
  let steps = 0;
  let attempts = 0; // enters by a driving session
  let contended = 0; // of those, onto a group another session holds
  let carried = 0; // checks where a site was open to a session only through a remembered approval
  for (let seed = 1; seed <= 200; seed++) {
    let x = seed;
    // The high bits: this generator's low bits repeat with a short period.
    const rand = (n) => { x = (x * 1103515245 + 12345) % 2147483648; return Math.floor((x / 2147483648) * n); };
    const pick = (list) => list[rand(list.length)];
    const { core, advance, time } = setup();
    core.configure({ exclusive: ['benefits.example.gov', 'example.gov', ['portal.test', 'login.idp.test']] });
    const ids = [A, B, C];
    // A and B come from one project, so a site the user remembers for one is listed when the other pairs next.
    const project = { [A]: PROJECT, [B]: PROJECT, [C]: '/home/user/Projects/third' };
    for (const id of ids) core.opened(id, project[id]);
    // The host's file, the writes asked of it and not yet answered (in order),
    // and the sites the user forgot whose forget it has not yet written.
    let file = [];
    const asked = [];
    const forgetting = new Set();
    const said = (pr, site) => `${pr} ${site}`;
    // What each lease was given at pairing: the remembered sites of its
    // project that stood then (written, with no forget waiting), less any
    // forgotten since; one remembered after reaches only the next pairing.
    const frozen = new Map();
    const stands = () => new Set(file.map((e) => said(e.project, e.site)).filter((k) => !forgetting.has(k)));
    const standing = (s, site) => leased.has(s) && Boolean(frozen.get(s)?.has(said(project[s], site)));
    // Who holds a lease, which protected sites the user allowed each session
    // during its current lease, where each owned tab is, and who last
    // entered each group.
    const leased = new Set();
    const allowed = new Map(ids.map((id) => [id, new Set()]));
    const tabs = new Map(); // tabId -> { owner, url }
    const entered = new Map(); // group -> { s, at }
    let nextTab = 1;
    const inGroup = (s, g) => [...tabs.values()].some((tab) => tab.owner === s && URLS[tab.url]?.[0] === g);
    const holder = (g) => {
      const e = entered.get(g);
      return e && leased.has(e.s) && (time() - e.at < LOCK_GRACE_MS || inGroup(e.s, g)) ? e.s : null;
    };
    const end = (s) => {
      leased.delete(s);
      frozen.delete(s);
      allowed.get(s).clear();
      for (const [g, e] of entered) if (e.s === s) entered.delete(g);
      // Its tabs are the user's from here: allowed again, it has none.
      for (const [id, tab] of tabs) if (tab.owner === s) tabs.delete(id);
    };
    const tabOf = (s) => { const own = [...tabs].filter(([, tab]) => tab.owner === s); return own.length ? pick(own)[0] : null; };
    // Half the time, a URL (any host) in a group another session holds, so
    // sessions meet inside a group often enough to test the lock.
    const target = (s) => {
      const held = urls.filter((u) => { const g = URLS[u][0]; const h = g && holder(g); return h && h !== s; });
      return held.length && rand(2) ? pick(held) : pick(urls);
    };
    const fingerprint = (id) => {
      const v = core.view();
      const l = v.leases.find((q) => q.sessionId === id);
      return JSON.stringify([l && [l.since, l.sites, l.functions, l.locks], core.tabsOf(id),
        v.requests.filter((r) => r.sessionId === id).map((r) => r.id), v.pending.filter((p) => p.sessionId === id)]);
    };
    // What enter must answer, by the model; on success the session takes the group.
    const expectEnter = (s, url, where) => {
      const [g, site] = URLS[url];
      const h = g && holder(g);
      const got = core.enter(s, url);
      attempts++;
      if (h && h !== s) {
        contended++;
        assert.match(got ?? 'entered', /is in use by/, `${where}: ${s[0]} entered ${g} held by ${h[0]}`);
      } else if (site && !allowed.get(s).has(site) && !standing(s, site)) {
        assert.match(got ?? 'entered', /protected/, where);
      } else {
        assert.equal(got, null, where);
        if (g) entered.set(g, { s, at: time() });
      }
      return got === null;
    };

    for (let step = 0; step < 150; step++) {
      steps++;
      // Weighted so that two or three sessions usually drive at once and
      // meet inside a group; ending a lease is the rarest operation. Going
      // onto a page is mostly tried by a driving session.
      const op = pick([1, 1, 3, 4, 5, 6, 7, 7, 7, 7, 8, 9, 10, 10, 10, 10, 10, 11, 11, 11, 11, 12, 0, 2, 13]);
      // One slot for remembered approvals, so the lock ops keep their share: remember, forget, or the host answering.
      const sub = op === 13 ? pick([13, 14, 15, 15]) : op;
      const s = [7, 10, 11].includes(op) && leased.size && rand(4) ? pick([...leased]) : pick(ids);
      const others = ids.filter((id) => id !== s);
      const before = others.map(fingerprint);
      let global = false; // the clock and revokeAll may change every session
      const where = `seed ${seed} step ${step}`;
      switch (sub) {
        case 0: core.claim(s); break;
        case 1: {
          core.claim(s);
          const p = core.view().pending.find((q) => q.sessionId === s);
          const code = p && rand(4) ? p.code : 'nope';
          const ok = core.decide(s, code, true, p?.approvalsDigest).ok;
          if (code === 'nope') assert.equal(ok, false, `${where}: a wrong code approved`);
          if (ok) {
            leased.add(s);
            frozen.set(s, new Set([...stands()].filter((k) => k.startsWith(`${project[s]} `))));
          }
          break;
        }
        case 2: {
          const p = core.view().pending.find((q) => q.sessionId === s);
          if (p) core.decide(s, p.code, false);
          break;
        }
        case 3: {
          const how = rand(4);
          if (how === 0 && core.release(s, 'r')) end(s);
          if (how === 1) { core.closed(s); end(s); core.opened(s, project[s]); }
          if (how === 2 && core.revoke(s)) end(s);
          if (how === 3) { global = true; core.revokeAll(); for (const id of ids) end(id); }
          break;
        }
        case 4: global = true; advance(pick([1000, 10_000, LOCK_GRACE_MS, CLAIM_TTL_MS + 1])); break;
        case 5: try { core.ask(s, 'site', pick(SITES)); } catch { /* not driving */ } break;
        case 6: {
          const r = core.view().requests.find((q) => q.sessionId === s);
          if (r && core.answer(r.id, true).ok) allowed.get(s).add(r.subject);
          break;
        }
        case 7: { // open: the gate enters first, then the new tab reports its URL
          if (!leased.has(s)) break;
          const url = target(s);
          if (!expectEnter(s, url, where)) break;
          const id = nextTab++;
          core.ownTab(id, s);
          core.tabAt(id, url);
          tabs.set(id, { owner: s, url });
          break;
        }
        case 8: { // a link, redirect or history step moves a tab with no check
          const id = tabOf(s);
          if (id === null) break;
          const url = rand(5) ? pick(urls) : 'about:blank';
          core.tabAt(id, url);
          tabs.get(id).url = url;
          break;
        }
        case 9: { // close
          const id = tabOf(s);
          if (id === null) break;
          core.tabRemoved(id);
          tabs.delete(id);
          break;
        }
        case 10: { // act on a page, or the check before a navigation
          const url = target(s);
          if (!leased.has(s)) { assert.throws(() => core.enter(s, url), /not connected/, where); break; }
          expectEnter(s, url, where);
          break;
        }
        case 11: { // navigate: enter, then the tab reports where it went
          const id = tabOf(s);
          if (id === null || !leased.has(s)) break;
          const url = target(s);
          if (!expectEnter(s, url, where)) break;
          core.tabAt(id, url);
          tabs.get(id).url = url;
          break;
        }
        case 12: { // back or forward
          const held = GROUPS.some((g) => { const h = holder(g); return h && h !== s; });
          assert.equal(core.historyRefusal(s) !== null, held, `${where}: history for ${s[0]}`);
          break;
        }
        case 13: { // the user allows a site question with Remember ticked; the host is asked to write it
          // Not global: until the host writes it, it changes nothing for another session.
          const site = pick(SITES);
          let q;
          try { q = core.ask(s, 'site', site); } catch { break; }
          const out = core.answer(q, true, { remember: true });
          if (!out.ok) break;
          allowed.get(s).add(site);
          assert.equal(out.remember.project, project[s], where);
          asked.push({ type: 'remember', entry: out.remember });
          break;
        }
        case 14: { // the user clicks Forget in the popup on a remembered site
          const shown = core.view().approvals;
          if (!shown.length) break;
          global = true;
          const e = pick(shown);
          assert.ok(core.forget(e), where);
          forgetting.add(said(e.project, e.site));
          for (const keys of frozen.values()) keys.delete(said(e.project, e.site));
          asked.push({ type: 'forget', entry: e });
          break;
        }
        case 15: { // the host writes the oldest asked change and answers
          const did = asked.shift();
          if (!did) break;
          global = true;
          const key = said(did.entry.project, did.entry.site);
          if (did.type === 'remember' && !file.some((e) => said(e.project, e.site) === key)) file = [...file, did.entry];
          if (did.type === 'forget') {
            file = file.filter((e) => said(e.project, e.site) !== key);
            // Settled once no later forget of it is still waiting.
            if (!asked.some((a) => a.type === 'forget' && said(a.entry.project, a.entry.site) === key)) forgetting.delete(key);
          }
          core.hostApprovals(file.map((e) => ({ ...e })), did);
          for (const keys of frozen.values()) for (const k of [...keys]) if (!stands().has(k)) keys.delete(k);
          break;
        }
      }
      if (!global) assert.deepEqual(others.map(fingerprint), before, `${where}: an operation by ${s[0]} changed another session`);
      const authorized = ids.filter((id) => { try { core.authorize(id); return true; } catch { return false; } });
      assert.deepEqual(authorized, ids.filter((id) => leased.has(id)), where);
      for (const g of GROUPS) {
        const holders = core.view().leases.filter((l) => l.locks.includes(g)).map((l) => l.sessionId);
        assert.ok(holders.length <= 1, `${where}: ${holders.length} holders of ${g}`);
        assert.equal(holders[0] ?? null, holder(g), `${where}: holder of ${g}`);
      }
      for (const id of ids) {
        for (const url of urls) {
          const [g, site] = URLS[url];
          const h = g && holder(g);
          const open = (!site || allowed.get(id).has(site) || standing(id, site)) && (!h || h === id);
          if (site && !allowed.get(id).has(site) && standing(id, site)) carried++;
          assert.equal(core.urlRefusal(url, id) === null, open, `${where}: ${url} open for ${id[0]}`);
        }
      }
    }
  }
  const share = contended / steps;
  t.diagnostic(`lock contention: ${contended} of ${steps} steps (${(share * 100).toFixed(1)}%), and ${contended} of ${attempts} `
    + `enters (${((contended / attempts) * 100).toFixed(1)}%), were a session refused by another's lock`);
  assert.ok(share > 0.05, `contention too rare to test the lock: ${(share * 100).toFixed(1)}%`);
  t.diagnostic(`remembered: ${carried} checks found a site open to a session only through a remembered approval`);
  assert.ok(carried > 500, `remembered approvals too rarely in force to test: ${carried}`);
});

test('an approved function belongs to its session and its lease, and ends with that lease only', () => {
  const { core } = setup();
  grant(core, A);
  const id = core.ask(A, 'function', JSON.stringify({ tabId: 1, url: 'https://example.com/a', code: '(n) => n' }));
  core.answer(id, true);
  const { fnId } = core.settle(A, id);
  assert.deepEqual(core.approvedFunction(A, fnId), { code: '(n) => n', origin: 'https://example.com' });
  assert.equal(core.approvedFunction(A, 'f999'), null);
  grant(core, B);
  assert.equal(core.approvedFunction(B, fnId), null, 'another session never inherits it');
  assert.ok(core.approvedFunction(A, fnId), 'another session connecting ends nothing');
  core.revoke(A);
  assert.throws(() => core.approvedFunction(A, fnId), /not connected/);
});

/* ---------- site locks ---------- */

function locking() {
  const env = setup();
  env.core.configure({ exclusive: ['Benefits.Example.gov.'] });
  grant(env.core, A);
  grant(env.core, B);
  return env;
}

test('site lock: one session at a time on a locked site; the other is refused with the holder\'s label', () => {
  const { core } = locking();
  core.ownTab(10, A);
  core.ownTab(20, B);
  assert.equal(core.enter(A, BENEFITS), null);
  core.tabAt(10, BENEFITS);
  assert.equal(core.enter(B, 'https://www.benefits.example.gov/other'),
    'benefits.example.gov is in use by acme · aaaa; one session at a time on this site. Wait for it to finish, or ask the user.');
  assert.match(core.urlRefusal(BENEFITS, B), /in use by acme · aaaa/, 'the pure check sees the lock too');
  assert.match(core.lockRefusal(BENEFITS, B), /in use by/);
  assert.equal(core.urlRefusal(BENEFITS, A), null);
  assert.equal(core.enter(A, BENEFITS), null, 'the holder enters again');
  assert.equal(core.enter(B, 'https://example.com/'), null, 'other sites stay open to B');
  core.checkTab(B, 20);
  assert.deepEqual(core.view().leases.map((l) => l.locks), [['benefits.example.gov'], []]);
});

test('site lock: frees once the holder\'s tabs leave the site, then the next session takes it', () => {
  const { core, advance } = locking();
  core.ownTab(10, A);
  core.ownTab(11, A);
  core.enter(A, BENEFITS);
  core.tabAt(10, BENEFITS);
  core.tabAt(11, BENEFITS);
  core.tabAt(30, BENEFITS); // a tab A does not own keeps nothing alive
  advance(LOCK_GRACE_MS + 1);
  assert.match(core.enter(B, BENEFITS) ?? 'entered', /in use/, 'a tab still on the site keeps the lock');
  core.tabAt(10, 'https://example.com/');
  assert.match(core.enter(B, BENEFITS) ?? 'entered', /in use/, 'one tab of two left');
  core.tabRemoved(11);
  assert.equal(core.enter(B, BENEFITS), null);
  assert.match(core.enter(A, BENEFITS) ?? 'entered', /in use by billing · bbbb/);
});

test('site lock: held for LOCK_GRACE_MS after entering, while the page is still loading', () => {
  const { core, advance } = locking();
  core.enter(A, BENEFITS); // no tab reports the site yet
  advance(LOCK_GRACE_MS - 1);
  assert.match(core.enter(B, BENEFITS) ?? 'entered', /in use/);
  advance(1);
  assert.equal(core.enter(B, BENEFITS), null);
});

test('site lock: ends with its session\'s lease and is not revived by a new lease', () => {
  for (const end of [(c) => c.release(A, 'r'), (c) => c.revoke(A), (c) => c.closed(A), (c) => c.revokeAll()]) {
    const { core } = locking();
    core.ownTab(10, A);
    core.enter(A, BENEFITS);
    core.tabAt(10, BENEFITS); // A's tab stays on the site throughout
    end(core);
    grant(core, A);
    if (core.claimStatus(B) !== 'granted') grant(core, B);
    assert.deepEqual(core.view().leases.find((l) => l.sessionId === A).locks, []);
    assert.equal(core.enter(B, BENEFITS), null);
  }
});

test('site lock: a protected site is locked too, and a lock is never a grant', () => {
  const { core } = locking();
  assert.match(core.enter(A, MAIL), /protected/, 'no lock, and no entry, without the user\'s Allow');
  assert.deepEqual(core.view().leases[0].locks, []);
  core.answer(core.ask(A, 'site', 'mail.google.com'), true);
  core.answer(core.ask(B, 'site', 'mail.google.com'), true);
  assert.equal(core.enter(A, MAIL), null);
  assert.match(core.enter(B, MAIL), /^mail\.google\.com is in use by acme · aaaa/);
  core.release(A, 'r');
  assert.equal(core.enter(B, MAIL), null);
  assert.throws(() => core.enter(C, 'https://example.com/'), /not connected/, 'only a driving session enters');
});

test('exclusive config adds locked sites and cannot unlock a protected one', () => {
  const { core } = setup();
  core.configure({ exclusive: ['portal.test'], protect: [] });
  grant(core, A);
  grant(core, B);
  assert.equal(core.lockedSite('https://x.portal.test/a'), 'portal.test');
  assert.equal(core.lockedSite('https://outlook.live.com/'), 'microsoft sign-in', 'Microsoft sign-in and mail are one lock');
  assert.equal(core.lockedSite('https://example.com/'), null);
  assert.equal(core.urlRefusal('https://portal.test/', B), null, 'exclusive is not protected: no Allow needed');
  assert.equal(core.enter(A, 'https://portal.test/'), null);
  assert.match(core.enter(B, 'https://x.portal.test/'), /portal\.test is in use/);
  core.answer(core.ask(A, 'site', 'login.live.com'), true);
  core.answer(core.ask(B, 'site', 'login.live.com'), true);
  assert.equal(core.enter(A, 'https://login.live.com/'), null);
  assert.match(core.enter(B, 'https://login.live.com/'), /login\.live\.com is in use/);
  assert.deepEqual(core.view().exclusive, ['portal.test']);
});

/* ---------- lock groups ---------- */

const allow = (core, id, site) => core.answer(core.ask(id, 'site', site), true);

// The lock exists because these sites share one sign-in and server-side
// session: every built-in Google page is the same Google sign-in.
test('lock group: the Google sign-in is one lock across its hosts, while grants stay per site', () => {
  const { core } = locking();
  allow(core, A, 'mail.google.com');
  allow(core, B, 'accounts.google.com');
  assert.equal(core.enter(A, MAIL), null);
  assert.match(core.enter(B, 'https://accounts.google.com/Logout') ?? 'entered',
    /^accounts\.google\.com is in use by acme · aaaa under the google sign-in lock/, 'B could sign the shared account out under A');
  for (const host of ['myaccount', 'takeout', 'script', 'admin']) {
    assert.equal(core.lockedSite(`https://${host}.google.com/`), 'google sign-in');
  }
  assert.equal(core.lockedSite('https://search.google.com/'), null, 'a Google page outside the protected list is not locked');
  assert.deepEqual(core.view().leases[0].locks, ['google sign-in']);
  assert.match(core.enter(A, 'https://accounts.google.com/') ?? 'entered', /protected/, 'holding the lock is no Allow for another site in it');
});

test('lock group: each provider\'s sign-in, account and mail hosts are one lock, and providers are separate', () => {
  const { core } = locking();
  allow(core, A, 'login.microsoftonline.com');
  allow(core, B, 'outlook.office.com');
  allow(core, B, 'idmsa.apple.com');
  assert.equal(core.enter(A, 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize'), null);
  assert.match(core.enter(B, 'https://outlook.office.com/mail/') ?? 'entered', /under the microsoft sign-in lock/);
  assert.equal(core.enter(B, 'https://idmsa.apple.com/'), null, 'Apple is another sign-in');
  allow(core, A, 'appleid.apple.com');
  assert.match(core.enter(A, 'https://appleid.apple.com/') ?? 'entered', /under the apple sign-in lock/);
});

test('lock group: an exclusive entry may be an array of hosts (a portal and its sign-in), and a config host under a built-in group joins it', () => {
  const { core } = setup();
  core.configure({ exclusive: [['Portal.test', 'login.idp.test'], 'eu.login.live.com', 'benefits.example.gov'], protect: ['u.mail.google.com'] });
  grant(core, A);
  grant(core, B);
  assert.equal(core.lockedSite('https://login.idp.test/a'), 'portal.test + login.idp.test');
  assert.equal(core.lockedSite('https://eu.login.live.com/'), 'microsoft sign-in');
  assert.equal(core.lockedSite('https://u.mail.google.com/'), 'google sign-in');
  assert.equal(core.enter(A, 'https://www.portal.test/'), null);
  assert.match(core.enter(B, 'https://login.idp.test/') ?? 'entered', /in use by acme · aaaa under the portal\.test \+ login\.idp\.test lock/);
  assert.equal(core.enter(B, BENEFITS), null, 'another group stays open');
});

// The first matching entry used to name the lock, so two sessions held two
// locks inside one site.
test('lock group: overlapping entries take one lock, so two sessions never both enter', () => {
  for (const exclusive of [['benefits.example.gov', 'example.gov'], ['example.gov', 'benefits.example.gov'], [['a.test', 'benefits.example.gov'], ['example.gov', 'b.test']]]) {
    const { core } = setup();
    core.configure({ exclusive });
    grant(core, A);
    grant(core, B);
    assert.equal(core.enter(A, 'https://benefits.example.gov/portal'), null);
    for (const url of ['https://example.gov/', 'https://www.benefits.example.gov/x', 'https://other.example.gov/']) {
      assert.match(core.enter(B, url) ?? 'entered', /in use by acme/, `${JSON.stringify(exclusive)}: ${url}`);
    }
    assert.equal(core.lockedSite('https://example.gov/'), core.lockedSite(BENEFITS), 'one canonical lock');
    assert.deepEqual(core.view().leases.map((l) => l.locks.length), [1, 0]);
  }
  const { core } = setup();
  core.configure({ exclusive: ['google.com'] });
  assert.equal(core.lockedSite('https://search.google.com/'), core.lockedSite(MAIL), 'a broader config host takes the built-in group with it');
});

/* ---------- history ---------- */

// Where back or forward lands cannot be known before the tab moves.
test('history: back and forward are refused while another session holds any live lock', () => {
  const { core, advance } = locking();
  assert.equal(core.historyRefusal(B), null);
  core.ownTab(10, A);
  core.enter(A, BENEFITS);
  core.tabAt(10, BENEFITS);
  assert.equal(core.historyRefusal(A), null, 'the holder itself may go back');
  assert.match(core.historyRefusal(B), /back and forward are refused while acme · aaaa holds benefits\.example\.gov.*navigate by URL instead/);
  core.tabAt(10, 'https://example.com/');
  advance(LOCK_GRACE_MS);
  assert.equal(core.historyRefusal(B), null, 'a lock that has lapsed refuses nothing');
});

/* ---------- Phase 1 (2026-11-07 release review) ---------- */

// Unknown shapes were skipped and a Unicode host never matched a page (page
// URLs carry punycode), so a rule could be dropped without a word.
test('config hosts are matched as page URLs spell them, and any entry that is not a host name refuses control', () => {
  const { core } = setup();
  grant(core, A);
  core.configure({ deny: ['Bücher.example.'], protect: ['  Portal.TEST '], exclusive: [['faß.example', 'idp.test']] });
  assert.equal(core.view().configError, null);
  assert.match(core.urlRefusal('https://bücher.example/x') ?? '', /deny list/);
  assert.match(core.urlRefusal('https://xn--bcher-kva.example/') ?? '', /deny list/);
  assert.match(core.urlRefusal('https://login.portal.test/') ?? '', /protected/);
  assert.equal(core.lockedSite('https://faß.example/'), core.lockedSite('https://idp.test/'));
  assert.ok(core.lockedSite('https://faß.example/'));
  for (const lists of [{ deny: ['https://claims.example.org'] }, { protect: ['portal.test/login'] }, { exclusive: ['portal.test:8443'] },
    { deny: ['*.example.org'] }, { exclusive: [['portal.test', 'login idp.test']] }, { deny: [''] }, { deny: [42] }, { exclusive: [[]] },
    { deny: 'claims.example.org' }, { protect: ['user@portal.test'] }]) {
    core.configure(lists);
    assert.ok(core.view().configError, `accepted ${JSON.stringify(lists)}`);
    assert.equal(core.claim(B).status, 'refused', JSON.stringify(lists));
    assert.throws(() => core.authorize(A), /refuses control of Profile 4: config\.json is broken/);
    assert.deepEqual(core.view().deny, [], 'a broken file still applied some of its rules');
  }
  core.configure({ configError: 'it is not valid JSON (Expecting value)' });
  assert.match(core.claim(B).error, /config\.json is broken: it is not valid JSON \(Expecting value\)\. Ask the user to fix it/);
  core.configure({});
  assert.equal(core.view().configError, null);
  assert.doesNotThrow(() => core.authorize(A));
});

// a review full review #5, 2026-11-09: a lock taken through a frame lapsed after
// the grace while the frame stayed, since only top documents kept it alive.
test('site lock: a frame of the holder\'s tab on the site keeps it, until the frame or its page goes', () => {
  const { core, advance } = locking();
  core.ownTab(10, A);
  core.tabAt(10, 'https://example.com/');
  core.enter(A, BENEFITS);
  core.frameAt(10, 5, BENEFITS);
  core.frameAt(30, 5, BENEFITS); // a tab A does not own keeps nothing alive
  advance(LOCK_GRACE_MS + 1);
  assert.match(core.enter(B, BENEFITS) ?? 'entered', /in use/, 'the frame is still there');
  core.frameAt(10, 5, 'https://example.com/other'); // the frame went elsewhere
  assert.equal(core.lockRefusal(BENEFITS, B), null);
  core.frameAt(10, 5, BENEFITS);
  core.enter(A, BENEFITS);
  advance(LOCK_GRACE_MS + 1);
  assert.match(core.lockRefusal(BENEFITS, B) ?? 'free', /in use/);
  core.framesGone(10); // the page around it was replaced
  assert.equal(core.lockRefusal(BENEFITS, B), null);
  core.frameAt(10, 5, BENEFITS);
  core.enter(A, BENEFITS);
  advance(LOCK_GRACE_MS + 1);
  core.tabRemoved(10);
  assert.equal(core.enter(B, BENEFITS), null);
});
