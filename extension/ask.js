// One question from a session that already drives this profile: open a
// protected site, or run a script. The code shown is the code that runs.
const id = decodeURIComponent(location.hash.slice(1));
// Allow takes a deliberate press-and-hold: in the live check the user clicked
// a one-click Allow by habit after deciding to refuse. "No" is the default.
const HOLD_MS = 1500;
let holdTimer = null;
let shown = false;
let deciding = false;
let armTimer = null;
// A site or a function can be remembered for the session's project; an eval never.
let rememberable = false;

// The code as it will run, highlighted. Only spans and text are built, so the
// block's text is the code exactly; line numbers and the marks on invisible
// characters come from CSS and are never part of it. Highlighting is a guide,
// not a parser: a token it misreads only changes a colour.
const KEYWORDS = new Set(('async await break case catch class const continue debugger default delete do else export '
  + 'extends false finally for function if import in instanceof let new null of return static super switch this '
  + 'throw true try typeof undefined var void while with yield').split(' '));
const SYNTAX = [
  ['comment', /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/y],
  ['string', /'(?:\\[\s\S]|[^'\\\n])*'?|"(?:\\[\s\S]|[^"\\\n])*"?|`(?:\\[\s\S]|[^`\\])*`?/y],
  ['number', /(?:0[xob][\da-f_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:e[+-]?\d+)?)n?/iy],
  ['word', /[\p{ID_Start}$_][\p{ID_Continue}$]*/uy],
  ['punct', /[{}()[\];,.:?<>=!&|+\-*/%^~@#]+/y],
  [null, /[ \t]+/y],
];
// A name followed by "(" is a call (or a function's own name), the part of a
// script that does things, so it gets its own colour.
const CALL = /[ \t]*\(/y;
// Zero-width and bidi control characters: each becomes its own isolated span
// that CSS labels with its code point, so the code cannot read differently
// from what runs.
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;
const SPLIT = new RegExp(`(${INVISIBLE.source}|\n)`);

function renderCode(box, code) {
  let line = el('span', { className: 'ln' });
  let lines = 1;
  const out = [line];
  const put = (kind, text) => {
    for (const part of text.split(SPLIT)) {
      if (!part) continue;
      if (part === '\n') {
        line = el('span', { className: 'ln' });
        lines += 1;
        out.push('\n', line);
      } else if (INVISIBLE.test(part)) {
        const mark = el('span', { className: 'invisible', textContent: part });
        mark.dataset.cp = `U+${part.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
        line.append(mark);
      } else {
        line.append(kind ? el('span', { className: kind, textContent: part }) : part);
      }
    }
  };
  for (let i = 0; i < code.length;) {
    let kind = null;
    let text;
    for (const [k, re] of SYNTAX) {
      re.lastIndex = i;
      const m = re.exec(code);
      if (m?.[0]) { kind = k; text = m[0]; break; }
    }
    if (kind === 'word') {
      CALL.lastIndex = i + text.length;
      kind = KEYWORDS.has(text) ? 'keyword' : CALL.test(code) ? 'fn' : null;
    }
    text ??= String.fromCodePoint(code.codePointAt(i));
    put(kind, text);
    i += text.length;
  }
  box.dataset.digits = String(lines).length;
  box.replaceChildren(...out);
}

function end(message) {
  $('allow').disabled = $('deny').disabled = $('remember').disabled = true;
  $('expires').textContent = '';
  $('hold-hint').hidden = true;
  $('outcome').hidden = false;
  $('outcome').textContent = message;
  clearInterval(poll);
}

function arm() {
  clearTimeout(armTimer);
  if (document.visibilityState !== 'visible' || !shown || deciding) return;
  armTimer = setTimeout(() => { if (!deciding) $('allow').disabled = false; }, ARM_MS);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') { clearTimeout(armTimer); $('allow').disabled = true; }
  arm();
});

/* What the session says the script is for, in its own words, or that it
 * said nothing; and what can be seen in the code, a hint that is never a
 * verdict, so an empty list shows nothing at all. */
function purpose(subject) {
  $('said').hidden = false;
  $('purpose').textContent = subject.purpose || 'It gave no purpose.';
  $('purpose').className = subject.purpose ? 'said' : 'said none';
}
function notes(list = []) {
  $('seen').hidden = !list.length;
  $('notes').replaceChildren(...list.map((n) => el('li', { className: n.kind === 'dynamic' ? 'warn' : '', textContent: n.label })));
}

/* What Remember does, said plainly: it allows every later session from the
 * project (shown in full) on this site, or this function on this origin,
 * until the user forgets it. At the cap it is off, and says why. */
function remember(r, v) {
  $('remember-row').hidden = r.kind === 'eval' || !r.project;
  rememberable = !$('remember-row').hidden && !v.approvalsFull;
  $('remember').disabled = !rememberable;
  if ($('remember-row').hidden) return;
  if (v.approvalsFull) {
    $('remember-label').textContent = 'Remember is full: forget some remembered approvals in the toolbar first.';
    return;
  }
  const mono = (t) => el('span', { className: 'mono', textContent: t });
  const what = r.kind === 'site' ? [mono(r.subject)] : ['this function on ', mono(new URL(JSON.parse(r.subject).url).origin)];
  $('remember-label').replaceChildren('Also allow ', ...what, ' for every later session from ', mono(r.project), ', until you forget it in the toolbar.');
}

function show(r, v) {
  renderLabel($('label'), r.label);
  remember(r, v);
  if (r.kind === 'site') {
    $('title').textContent = `Open ${r.subject}?`;
    $('target-k').textContent = 'Protected site';
    $('target').textContent = r.subject;
    $('explain').textContent = 'It can read and act there until its control ends. What it reads goes to your agent and its model provider.';
    $('allow-label').textContent = 'Hold to allow';
  } else if (r.kind === 'function') {
    const subject = JSON.parse(r.subject);
    const { url, code } = subject;
    $('title').textContent = 'Approve this function?';
    $('target-k').textContent = 'On site';
    $('target').textContent = new URL(url).origin; // scheme and port too: what it is approved for
    $('target').title = url;
    purpose(subject);
    $('code').hidden = false;
    renderCode($('code'), code);
    notes(r.notes);
    $('explain').textContent = 'It can call this with data, as often as it likes, until its control ends.';
    $('allow-label').textContent = 'Hold to approve';
  } else {
    // url is the frame the script runs in; top is the page around it.
    const subject = JSON.parse(r.subject);
    const { url, top, frameId, code } = subject;
    const inFrame = Boolean(frameId) && Boolean(top);
    $('title').textContent = inFrame ? 'Run this script in a frame?' : 'Run this script?';
    $('target-k').textContent = inFrame ? `In a frame of ${new URL(top).host}` : 'On page';
    $('target').textContent = new URL(url).host + new URL(url).pathname;
    $('target').title = inFrame ? `${url}\nin a frame of ${top}` : url;
    purpose(subject);
    $('code').hidden = false;
    renderCode($('code'), code);
    notes(r.notes);
    $('explain').textContent = `Runs once, with the ${inFrame ? 'frame' : 'page'}’s full powers, password fields included.`;
    $('allow-label').textContent = 'Hold to run once';
  }
  document.title = `${$('title').textContent} · ${r.label}`;
}

async function refresh() {
  const v = await browser.runtime.sendMessage({ type: 'view' });
  $('profile').textContent = v.profile.name;
  if (deciding) return;
  const r = v.requests.find((x) => x.id === id);
  if (!r) {
    if (!shown) { $('title').textContent = 'Nothing to answer'; $('label').textContent = '—'; $('target').textContent = '—'; }
    end('This request is no longer waiting. It was answered, timed out, or control ended.');
    return;
  }
  if (!shown) { shown = true; show(r, v); arm(); }
  const s = Math.max(0, Math.ceil((r.expires - Date.now()) / 1000));
  $('expires').textContent = `${s} s left`;
  $('expires').className = s <= LOW_S ? 'clock low' : 'clock';
}

async function decide(approve) {
  deciding = true;
  clearTimeout(armTimer);
  holdCancel();
  $('allow').disabled = $('deny').disabled = $('remember').disabled = true;
  const keep = approve && rememberable && $('remember').checked === true;
  const r = await browser.runtime.sendMessage({ type: 'answer', id, approve, ...(keep ? { remember: true } : {}) });
  if (r?.ok) end(approve ? 'Allowed.' : 'Not allowed. The session was told no.');
  else end(r?.error || 'Could not record the answer.');
}

function holdStart() {
  if ($('allow').disabled || holdTimer) return;
  $('allow').classList.add('holding');
  holdTimer = setTimeout(() => { holdTimer = null; $('allow').classList.remove('holding'); decide(true); }, HOLD_MS);
}
function holdCancel() {
  clearTimeout(holdTimer);
  holdTimer = null;
  $('allow').classList.remove('holding');
}
const allow = $('allow');
allow.addEventListener('pointerdown', (e) => { allow.setPointerCapture?.(e.pointerId); holdStart(); });
for (const t of ['pointerup', 'pointercancel', 'lostpointercapture', 'blur']) allow.addEventListener(t, holdCancel);
allow.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); holdStart(); } });
allow.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') holdCancel(); });
allow.addEventListener('click', (e) => e.preventDefault()); // a click alone never allows
$('deny').addEventListener('click', () => decide(false));
const poll = setInterval(refresh, 1000);
refresh();
