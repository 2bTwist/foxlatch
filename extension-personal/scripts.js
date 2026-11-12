/*
 * Scripts by approval: eval, define, call and await_question, and the page
 * functions that run a session's code. Only the personal package holds this
 * file (foxlatch/build.py adds it, and loads it after page.js and before
 * background.js); the public package, and the tree's extension/ as loaded as
 * a temporary add-on, have none of it, as Mozilla's policy on remote code
 * requires.
 *
 * Loaded before background.js, it only defines: the tools below call
 * background.js's functions when they run, never as this file loads.
 * background.js finds SCRIPT_TOOLS and takes from it the four tools above
 * alone; without this file they refuse, and the build is public.
 */

/* global PAGE, core, oneLine, REQUEST_TTL_MS, COLLECT_TTL_MS, usableTab, frameUsable, documentOf, putQuestion, answerOf,
   allowed, leaseEnd, inFrame, parseFrame, condition, mark, settle, nonce */

const EVAL_MAX_CHARS = 20000; // what the user can read before allowing it
const CALL_MAX_CHARS = 100000; // data passed to an approved function
const PURPOSE_MAX_CHARS = 200; // the session's one line on what a script does, shown to the user
const SCRIPT_CHECK_MS = 3000; // see scriptsAllowed

/* Page functions of the script path, for pageScript (page.js) to inject. */
Object.assign(PAGE, {
  /* Whether this page lets evalInPage run at all, checked with constant code
   * before the user is asked, so they are never asked to allow a script that a
   * Content Security Policy will refuse anyway. */
  canEval() {
    try {
      window.wrappedJSObject.eval('0');
      return true;
    } catch (e) {
      if (/content security policy|call to eval|unsafe-eval/i.test(String(e?.message || e))) return false;
      throw e;
    }
  },

  /* This document's mark, which every eval question asked in it records:
   * the first question's token, set once and never replaced or added to, so
   * asking again, however often and however the questions end, keeps one
   * value. It lives in this document's content-script sandbox, which the
   * page cannot read and a reload or new document does not inherit. With
   * href, the frame must still show exactly that URL. */
  markDocument({ token, href = null }) {
    if (href !== null && location.href !== href) throw new Error('the page moved before the script ran; it did not run. Ask again');
    const { s } = ctx();
    if (!Object.hasOwn(s, 'mark')) Object.defineProperty(s, 'mark', { value: String(token), enumerable: true, writable: false, configurable: false });
    return s.mark;
  },

  /* Runs in the page's own world, with only the page's powers: a content
   * script could fetch any site with the user's cookies, which would bypass the
   * deny list. Pages whose CSP forbids eval refuse this; use the other tools.
   * Before the code, in the same step: with href (an approved eval), the
   * frame must still show exactly the URL the user was shown; with origin (an
   * approved function), exactly the origin they approved it on; with token
   * (an approved eval), this must be the document whose mark the question
   * recorded, so it never runs in a document that replaced it. That an Allow
   * runs once is core's: settle hands it to one collection only. */
  evalInPage({ code, href = null, origin = null, token = null }) {
    if (href !== null && location.href !== href) throw new Error('the page moved before the script ran; it did not run. Ask again');
    if (origin !== null && location.origin !== origin) throw new Error('the page is no longer on the origin the function was approved for; it did not run');
    if (token !== null && window.__fxd?.mark !== token) {
      throw new Error('the page was reloaded or replaced before the script ran, though its URL is the same; it did not run. Ask again');
    }
    return (async () => {
      const w = window.wrappedJSObject;
      let r;
      try {
        r = w.eval(code);
      } catch (e) {
        const msg = String(e?.message || e);
        if (/content security policy|call to eval|unsafe-eval/i.test(msg)) throw new Error('this page’s Content Security Policy forbids eval; use snapshot, click and type');
        throw new Error(msg);
      }
      if (r && typeof r === 'object' && typeof r.then === 'function') r = await r;
      const s = w.JSON.stringify(r === undefined ? null : r);
      return s === undefined ? null : JSON.parse(s);
    })();
  },
});

/* p's value, or null once ms pass. */
async function withinScriptCheck(p, ms) {
  let timer;
  try {
    return await Promise.race([p, new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

/* Before eval or define ask the user: a page whose Content Security Policy
 * forbids eval would refuse the script after they allowed it (1 in 6 evals in
 * live use). The check runs constant code, never the session's. */
async function scriptsAllowed(sessionId, tabId, frameId, url) {
  const end = leaseEnd(sessionId);
  let timer;
  try {
    const ok = await end.or(Promise.race([
      inFrame(sessionId, tabId, frameId, 'canEval', {}, url),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), SCRIPT_CHECK_MS); }),
    ]));
    if (ok === null) {
      throw new Error(`the page did not answer within ${SCRIPT_CHECK_MS / 1000} s whether it allows scripts (it may be showing a dialog), so the user was not asked`);
    }
    if (!ok) throw new Error('this page’s Content Security Policy forbids eval, so the user was not asked; use snapshot, text, click and type');
  } finally {
    clearTimeout(timer);
    end.forget();
  }
}

/* Where this session's eval or define question stands, waiting up to ms:
 *   { status: 'pending', question, kind, expiresInS }
 *   { status: 'done', kind: 'eval', value }   the script ran, once, for this call
 *   { status: 'done', kind: 'function', fn, origin }   to every call that asks
 *   { status: 'running', question, kind: 'eval' }   another call collected it; the script is still running
 *   { status: 'ran', question, kind: 'eval' }   another call collected it, and its result went there
 * or throws if the user said no, did not answer, their Allow lapsed uncollected,
 * the page changed since they were shown it, or control ended. Site questions
 * are not here: open and navigate wait for those themselves. The script
 * runs only now, so the lease, the tab and the document they were shown are
 * checked as they are when it runs, not as they were when they were asked. */
async function scriptQuestion(sessionId, id, ms) {
  const r = core.requestOf(id);
  if (!r || r.sessionId !== sessionId || r.kind === 'site') {
    throw new Error(`no question ${id} is waiting for this session (never asked here, or over and forgotten); eval or define asks a new one`);
  }
  const out = await answerOf(sessionId, id, ms);
  const what = r.kind === 'function' ? 'that function' : 'that script';
  switch (out.status) {
    case 'pending':
      return { status: 'pending', question: id, kind: r.kind, expiresInS: Math.max(0, Math.ceil((r.created + REQUEST_TTL_MS - Date.now()) / 1000)) };
    case 'collected': return { status: 'done', kind: 'function', fn: out.fnId, origin: out.origin };
    case 'running': case 'ran': return { status: out.status, question: id, kind: r.kind };
    case 'refused': throw new Error(`question ${id} was collected by another call and did not run: ${out.reason}`);
    case 'lapsed':
      throw new Error(`The user allowed ${what}, but no call collected it within ${COLLECT_TTL_MS / 1000} s of their answer, `
        + 'so the Allow lapsed and nothing ran. Ask again only if it is still needed.');
    default: break;
  }
  const { subject, token } = allowed(sessionId, r.kind, r.subject, out);
  if (r.kind === 'function') return { status: 'done', kind: 'function', fn: out.fnId, origin: new URL(JSON.parse(subject).url).origin };
  const { tabId, frameId, url: askedUrl, top: askedTop, document: askedDocument, code } = JSON.parse(subject);
  let url;
  try {
    if (!token) throw new Error('the question carries no mark of the page the user was shown; it did not run. Ask again');
    // The user allowed this code on the document they were shown, in that frame of that page.
    const tab = await usableTab(sessionId, tabId);
    url = await frameUsable(sessionId, tab, frameId);
    if (tab.url !== askedTop) throw new Error(`the tab moved to ${tab.url} after the user allowed the script; it did not run. Ask again`);
    if (url !== askedUrl) throw new Error(`frame f${frameId} moved to ${url} after the user allowed the script; it did not run. Ask again`);
    if (JSON.stringify(documentOf(tabId, frameId)) !== JSON.stringify(askedDocument)) {
      throw new Error(`the ${frameId === 0 ? 'page' : `page in frame f${frameId}`} was reloaded or replaced after the user allowed `
        + 'the script, though its URL is the same; it did not run. Ask again');
    }
  } catch (e) {
    core.finished(id, String(e?.message || e));
    throw e;
  }
  try {
    // The page script checks the frame's full URL again, as it runs, and
    // that it is the document marked when the user was asked (a reload since
    // the checks above, at the same URL, has no mark).
    return { status: 'done', kind: 'eval', value: await inFrame(sessionId, tabId, frameId, 'evalInPage', { code, href: url, token }, url) };
  } finally {
    core.finished(id);
  }
}

const SCRIPT_TOOLS = {
  /* Script can do anything the page can, including reveal a password field,
   * so the user reads each one and allows it; the code they read is what
   * runs. It returns at once with the question (see scriptQuestion), so the
   * session can tell them to look, and await_question brings the result.
   * The question records the frame's URL, the page around it, and which
   * document each is, which is what they allow. */
  async eval(sessionId, { tabId, code, frame, purpose }) {
    code = String(code ?? '');
    if (!code.trim()) throw new Error('pass code');
    if (code.length > EVAL_MAX_CHARS) throw new Error(`code is ${code.length} characters; keep it under ${EVAL_MAX_CHARS} so the user can read it`);
    const frameId = parseFrame(frame);
    await scriptsAllowed(sessionId, tabId, frameId, await frameUsable(sessionId, await usableTab(sessionId, tabId), frameId));
    // What the user is shown is read after the check, as one moment: a document
    // that commits while the page and frame are read refuses the question.
    const document = documentOf(tabId, frameId);
    const tab = await usableTab(sessionId, tabId);
    const url = await frameUsable(sessionId, tab, frameId);
    // The mark of the document they are shown, which the script will need: set
    // there once, by its first eval question, and kept for its life; a later
    // document at the same URL, a reload included, has another.
    const token = await withinScriptCheck(inFrame(sessionId, tabId, frameId, 'markDocument', { token: nonce(), href: url }, url), SCRIPT_CHECK_MS).catch(() => false);
    if (token === null) throw new Error(`the page did not answer within ${SCRIPT_CHECK_MS / 1000} s (it may be showing a dialog), so the user was not asked`);
    if (typeof token !== 'string' || !/^[0-9a-f]{32}$/.test(token)) throw new Error('the page changed while the question was prepared, so the user was not asked; try again');
    if (JSON.stringify(documentOf(tabId, frameId)) !== JSON.stringify(document)) {
      throw new Error('the page changed while the question was prepared, so the user was not asked; try again');
    }
    const subject = { tabId, frameId, url, top: tab.url, document, code, purpose: oneLine(purpose, PURPOSE_MAX_CHARS) };
    return scriptQuestion(sessionId, await putQuestion(sessionId, 'eval', JSON.stringify(subject), { token }), 0);
  },

  /* A function the user reads and approves once, since asking at every run
   * turned one long task into hundreds of questions. Later calls pass only
   * data: the code they read is what runs, on the origin they approved it
   * for, until this session's control ends. Returns at once, as eval does;
   * one remembered for this project returns its id without asking. */
  async define(sessionId, { tabId, code, purpose }) {
    code = String(code ?? '');
    if (!code.trim()) throw new Error('pass code');
    if (code.length > EVAL_MAX_CHARS) throw new Error(`code is ${code.length} characters; keep it under ${EVAL_MAX_CHARS} so the user can read it`);
    await scriptsAllowed(sessionId, tabId, 0, (await usableTab(sessionId, tabId)).url);
    const tab = await usableTab(sessionId, tabId); // the origin as it is after the check
    // This exact code, remembered for the session's project on this origin: no question.
    const known = core.rememberedFunction(sessionId, tab.url, code);
    if (known) return { status: 'done', kind: 'function', fn: known.fnId, origin: known.origin };
    return scriptQuestion(sessionId, await putQuestion(sessionId, 'function', JSON.stringify({ tabId, url: tab.url, code, purpose: oneLine(purpose, PURPOSE_MAX_CHARS) })), 0);
  },

  /* Waits for the user's answer to an eval or define this session asked. */
  async await_question(sessionId, { id, timeoutMs = 90000 }) {
    core.authorize(sessionId);
    return scriptQuestion(sessionId, String(id ?? ''), Math.min(timeoutMs, 110000));
  },

  async call(sessionId, { tabId, fn, args = [], waitFor }) {
    const tab = await usableTab(sessionId, tabId);
    const cond = waitFor == null ? null : condition(waitFor);
    const f = core.approvedFunction(sessionId, String(fn ?? ''));
    if (!f) throw new Error(`no approved function ${fn} in this session; define it and have the user approve it`);
    const origin = new URL(tab.url).origin;
    if (origin !== f.origin) throw new Error(`function ${fn} was approved on ${f.origin}, not ${origin}`);
    if (!Array.isArray(args)) throw new Error('args must be a JSON array');
    // JSON text is a JS literal, so the arguments arrive as data, never as code
    const data = JSON.stringify(args);
    if (data.length > CALL_MAX_CHARS) throw new Error(`args are ${data.length} characters; keep them under ${CALL_MAX_CHARS}`);
    const since = mark();
    // The page script checks the approved origin again, as it runs: the tab
    // may have moved (http to https, another port) since the check above.
    const result = await inFrame(sessionId, tabId, 0, 'evalInPage', { code: `(${f.code})(...${data})`, origin: f.origin }, tab.url);
    // Unchanged without waitFor, so callers that read the result as is keep working.
    if (!cond) return result;
    return { result, ...(await settle(sessionId, tabId, cond, since, `function ${fn} ran`)) };
  },
};
