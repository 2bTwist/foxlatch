/*
 * Authority for one Firefox profile: who may drive it, which tabs belong to
 * whom, which URLs are refused, and which actions wait for the user's say-so.
 * Pure logic with the clock and the code generator injected, so every rule
 * here runs under node:test without Firefox.
 *
 * State lives only in this object, in the background page's memory. Content
 * scripts (including the agent's own page scripts) cannot reach it, and it is
 * gone when Firefox or the add-on restarts, so a lease or a grant never
 * outlives the browser session that confirmed it. The one exception is the
 * remembered approvals: a copy of the file the host writes, which only the
 * host's hello and its confirmed writes replace, and only the add-on's own
 * pages add to (an Allow with Remember ticked) or take from (Forget). A
 * lease gets exactly those of its project the pairing page listed when
 * the user allowed it; one remembered later reaches only later pairings.
 *
 * Several sessions may drive one profile at once, each under its own lease
 * with its own tabs, grants, functions and questions. Locked sites (the
 * protected ones and config `exclusive`) take one session at a time, because
 * they share the profile's single sign-in and server-side session. One
 * sign-in can span several hosts, so a lock covers a group of hosts.
 */

/* Built-in lock groups: the account, sign-in and web mail pages of one
 * provider share one sign-in, so one session at a time across all of them.
 * Each host is protected too: a session reaches one only after the user
 * allows that site for that session, in Firefox. Grants stay per site. A host
 * covers its subdomains. Google's include exports (takeout), Apps Script,
 * which runs code as the user (script), and Workspace admin. config.json adds
 * to these, never removes one. */
const BUILT_IN = [
  { name: 'google sign-in', provider: 'Google', hosts: ['accounts.google.com', 'myaccount.google.com', 'mail.google.com',
    'takeout.google.com', 'script.google.com', 'admin.google.com'] },
  { name: 'microsoft sign-in', provider: 'Microsoft', hosts: ['login.microsoftonline.com', 'login.microsoft.com', 'login.live.com',
    'account.microsoft.com', 'account.live.com', 'myaccount.microsoft.com', 'mysignins.microsoft.com', 'outlook.live.com',
    'outlook.office.com', 'outlook.office365.com', 'outlook.cloud.microsoft'] },
  { name: 'apple sign-in', provider: 'Apple', hosts: ['account.apple.com', 'appleid.apple.com', 'idmsa.apple.com', 'iforgot.apple.com', 'www.icloud.com'] },
];
const LOCK_GROUPS = Object.fromEntries(BUILT_IN.map((g) => [g.name, g.hosts]));
const PROTECTED = BUILT_IN.flatMap((g) => g.hosts);
const CLAIM_TTL_MS = 3 * 60 * 1000;
const REQUEST_TTL_MS = 100 * 1000;
// An eval or define the user allowed must be collected this long after their
// answer, or the Allow lapses: it was for the page as they saw it then.
const COLLECT_TTL_MS = 100 * 1000;
// A question that ended without running anything (refused, unanswered,
// lapsed) is still reported to a late caller this long, then forgotten.
const ENDED_GRACE_MS = 60 * 1000;
// After the user says no, the same session waits before it may ask again, and
// the wait doubles with each refusal, so asking cannot wear them down.
const DENY_COOLDOWN_MS = 30 * 1000;
const DENY_COOLDOWN_MAX_MS = 10 * 60 * 1000;
// A session that enters a locked site holds it this long even before one of
// its tabs reports being there, covering a page that is still loading.
const LOCK_GRACE_MS = 30 * 1000;
// Remembered approvals are sent whole in the host's hello and in its answer
// to every write, and Firefox drops a host message over 1 MB; host.py holds
// the file to this many entries and a byte size well under that.
const MAX_APPROVALS = 500;
// A project is the canonical full path of the session's git root or working
// directory (mcp/server.py project_of); host.py holds the same limit.
const MAX_PROJECT_CHARS = 400;

/* What a script visibly reaches for, in plain words, for the page that asks
 * the user. A hint read off the text, not a check: code can hide a call, so a
 * script that builds names or code as it runs says so, and the code they read
 * is what counts. */
const SCRIPT_NOTES = [
  ['reads', 'Reads the page', /\b(querySelector(All)?|getElementById|getElementsBy\w+|innerText|textContent|innerHTML|document\.body)\b/],
  ['changes', 'Changes the page', /\.click\s*\(|\bdispatchEvent\b|\.(value|checked|innerHTML|textContent|innerText)\s*=(?!=)|\b(setAttribute|execCommand|appendChild|insertAdjacent\w*|removeChild)\b|\.remove\s*\(/],
  ['submits', 'Submits a form', /\.(submit|requestSubmit)\s*\(/],
  ['navigates', 'Leaves or opens a page', /\blocation\s*(=(?!=)|\.\s*(href\s*=(?!=)|assign|replace|reload))|\bwindow\.open\b|\bhistory\.(pushState|replaceState|back|go)\b/],
  ['network', 'Sends or fetches over the network', /\b(fetch|XMLHttpRequest|sendBeacon|WebSocket|EventSource)\b|\bimport\s*\(/],
  ['storage', 'Uses saved site data or cookies', /\b(localStorage|sessionStorage|indexedDB|cookie|caches)\b/],
  // A bracket with a quoted piece joined by +: the runs stop at the next [ (and
  // + for the second), so no character is scanned again from a later start
  // and the time stays linear in the code's length (one 20 KB script of "["
  // took ~170 ms with [^\]]*, and every pending script was rescanned).
  ['dynamic', 'Builds names or code as it runs, so this list may miss things', /\b(eval|Function)\s*\(|\bnew\s+Function\b|\bset(Timeout|Interval)\s*\(\s*['"`]|\[[^[\]]*['"`]\s*\+|\+\s*['"`][^[\]+]*\]|\b(window|globalThis|self|document|top|parent)\s*\[/],
];
function scriptNotes(code) {
  return SCRIPT_NOTES.filter(([, , re]) => re.test(code)).map(([kind, label]) => ({ kind, label }));
}

/* One line of plain text, for what a session says about itself on the user's
 * pages and notifications: no line breaks, direction overrides or invisible
 * characters that could rearrange or hide what they read. */
const oneLine = (t, n) => String(t ?? '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

/* SHA-256 of a string as lowercase hex: the identity of a remembered
 * function's exact code. Synchronous, so the code a define approves and the
 * hash that approves it are read in one step. The bytes are UTF-8, with a
 * lone surrogate as its own three bytes (WTF-8), so two different strings
 * never hash the same input. */
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
function sha256(text) {
  const b = [];
  for (const ch of String(text)) { // by code point; a lone surrogate comes alone
    const c = ch.codePointAt(0);
    if (c < 0x80) b.push(c);
    else if (c < 0x800) b.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) b.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else b.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  const bits = b.length * 8;
  b.push(0x80);
  while (b.length % 64 !== 56) b.push(0);
  const hi = Math.floor(bits / 2 ** 32);
  b.push(hi >>> 24, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255, bits >>> 24, (bits >>> 16) & 255, (bits >>> 8) & 255, bits & 255);
  const ror = (x, n) => (x >>> n) | (x << (32 - n));
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const W = new Array(64);
  for (let i = 0; i < b.length; i += 64) {
    for (let t = 0; t < 16; t++) W[t] = (b[i + 4 * t] << 24) | (b[i + 4 * t + 1] << 16) | (b[i + 4 * t + 2] << 8) | b[i + 4 * t + 3];
    for (let t = 16; t < 64; t++) {
      const s0 = ror(W[t - 15], 7) ^ ror(W[t - 15], 18) ^ (W[t - 15] >>> 3);
      const s1 = ror(W[t - 2], 17) ^ ror(W[t - 2], 19) ^ (W[t - 2] >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) | 0;
    }
    let [a, bb, c, d, e, f, g, h] = H;
    for (let t = 0; t < 64; t++) {
      const t1 = (h + (ror(e, 6) ^ ror(e, 11) ^ ror(e, 25)) + ((e & f) ^ (~e & g)) + SHA256_K[t] + W[t]) | 0;
      const t2 = ((ror(a, 2) ^ ror(a, 13) ^ ror(a, 22)) + ((a & bb) ^ (a & c) ^ (bb & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0;
    }
    [a, bb, c, d, e, f, g, h].forEach((x, k) => { H[k] = (H[k] + x) | 0; });
  }
  return H.map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
}

/* A remembered approval: { project, kind: 'site', site, added, label } or
 * { project, kind: 'function', origin, sha256, added, label }, label being
 * the session that asked when the user remembered it. Its key is what makes it
 * the same approval: the project and the site, or the project, the origin and
 * the code's hash. */
const ENTRY_KEYS = { site: ['project', 'kind', 'site'], function: ['project', 'kind', 'origin', 'sha256'] };
const isEntry = (e) => Boolean(e) && typeof e === 'object' && Object.hasOwn(ENTRY_KEYS, e.kind)
  && ENTRY_KEYS[e.kind].every((k) => typeof e[k] === 'string' && e[k] !== '');
const entryKey = (e) => JSON.stringify(ENTRY_KEYS[e.kind].map((k) => e[k]));
// What a list of approvals is, as the pairing page showed it: the Allow
// carries this back, so it grants only the list the user read.
const listDigest = (list) => sha256(JSON.stringify(list.map(entryKey)));
const described = (e) => (e.kind === 'site' ? e.site : `the function on ${e.origin}`);

/* The project a session's server declares, or '' for none: an absolute path
 * in canonical form (no empty, . or .. parts) of one plain line, which the
 * pairing page shows whole. Anything else is no project, never a cleaned-up
 * one, since remembered approvals are kept under the exact string. */
function projectPath(p) {
  if (typeof p !== 'string' || !p.startsWith('/') || p.length > MAX_PROJECT_CHARS || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(p)) return '';
  return p === '/' || p.split('/').slice(1).every((part) => part && part !== '.' && part !== '..') ? p : '';
}

const hostOf = (u) => u.hostname.toLowerCase().replace(/\.$/, '');

/* A config.json host as page URLs spell their hosts (hostOf): lowercase, an
 * IDN in punycode, no trailing dot. null for anything that is not a bare
 * host name (a scheme, path, port, wildcard or space), which would match no
 * page and so silently drop the rule. */
function configHost(h) {
  const t = typeof h === 'string' ? h.trim() : '';
  if (!t || /[\s/:?#@\\*[\]%]/.test(t)) return null;
  let host;
  try { host = hostOf(new URL(`http://${t}/`)); } catch { return null; }
  return /^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/.test(host) ? host : null;
}
const matches = (host, list) => list.find((d) => host === d || host.endsWith(`.${d}`)) ?? null;
// Two entries overlap when one host is the other or under it: some host falls under both.
const overlap = (a, b) => a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);

/* The lock groups for these entries ({ name?, hosts }). Entries that overlap,
 * directly or through a chain, merge into one group, so every host falls
 * under at most one group and takes one lock: a config host under a built-in
 * group joins it, and example.gov over benefits.example.gov is one lock, not two. A
 * group keeps only its broadest hosts; its key is those hosts, and its name
 * is the built-in name or else those hosts. */
function lockGroups(entries) {
  const groups = []; // pairwise non-overlapping, so a new entry need only be checked against each
  for (const e of entries) {
    if (!e.hosts.length) continue;
    const merged = { names: e.name ? [e.name] : [], hosts: [...e.hosts] };
    for (const g of [...groups]) {
      if (!g.hosts.some((h) => e.hosts.some((d) => overlap(h, d)))) continue;
      merged.names.push(...g.names);
      merged.hosts.push(...g.hosts);
      groups.splice(groups.indexOf(g), 1);
    }
    groups.push(merged);
  }
  return groups.map((g) => {
    const hosts = [...new Set(g.hosts)].filter((h, _, all) => !all.some((d) => d !== h && h.endsWith(`.${d}`)));
    const names = [...new Set(g.names)];
    return { key: hosts.join(' '), name: names.length ? names.join(' + ') : hosts.join(' + '), hosts };
  });
}

function createCore({ now = () => Date.now(), makeCode } = {}) {
  let profile = { name: 'unidentified profile', dir: '' };
  let deny = [];
  let protect = [...PROTECTED];
  let exclusive = [];
  let groups = lockGroups([...Object.entries(LOCK_GROUPS).map(([name, hosts]) => ({ name, hosts })), ...PROTECTED.map((d) => ({ hosts: [d] }))]);
  // What is wrong with config.json, as the host or configure() found it. While
  // set, no session may claim or act: a broken file would drop its rules.
  let configError = null;
  // sessionId -> { sessionId, label, project, since, standing: Set of the
  // remembered approvals' keys the pairing page listed when the user allowed it }
  const leases = new Map();
  const sessions = new Map(); // sessionId -> { label, project, connected, windowId, lost, denials }
  const claims = new Map(); // sessionId -> { code, label, created, status, decided }
  const tabOwner = new Map(); // tabId -> sessionId
  const tabUrl = new Map(); // tabId -> the URL an owned tab last reported
  const tabFrames = new Map(); // tabId -> Map(frameId -> the URL that frame of an owned tab last committed)
  const locks = new Map(); // lock group key -> { sessionId, since }
  const grants = new Map(); // sessionId -> Set of protected sites the user allowed it
  const functions = new Map(); // sessionId -> Map fnId -> { code, origin } the user approved
  // id -> { id, sessionId, label, kind, subject, created, status, answered?, fnId?, origin? } while
  // pending or approved; after that, only { id, sessionId, kind, status, ended?, fnId?, origin?, reason? }
  const requests = new Map();
  let nextRequest = 0;
  let nextFunction = 0;
  // Remembered approvals as the host last confirmed them (see hostApprovals),
  // less the keys the user forgot that the host has not yet confirmed gone.
  let approvals = [];
  // key -> { entry, sent, error }: a Forget the host has not confirmed. sent
  // counts the forgets asked of the host and not yet answered; with none left
  // and an error, it failed, and the popup shows it so until the user retries.
  const forgets = new Map();
  // What the popup tells the user about remembered approvals until they dismiss it.
  const notices = [];
  let nextNotice = 0;

  const session = (id) => {
    if (!sessions.has(id)) sessions.set(id, { label: id.slice(0, 8), project: '', connected: false, windowId: null, lost: null, denials: 0 });
    return sessions.get(id);
  };
  const standing = (project) => (project ? approvals.filter((e) => e.project === project) : []);
  /* The user's config.json can add refused, protected and exclusive sites,
   * never remove one. Every protected site is also locked. An `exclusive`
   * entry is a host, or an array of hosts that share one sign-in (a portal
   * and its identity provider) and so take one lock. Called on the host's
   * hello, before any session holds a lease. A file the host could not use
   * (configError), or any entry that is not a host name, refuses control
   * until it is fixed: skipping it would drop that rule without a word. */
  function configure({ profile: p, deny: extraDeny = [], protect: extraProtect = [], exclusive: extraExclusive = [], configError: hostError = null } = {}) {
    if (p) profile = { name: String(p.name || profile.name), dir: String(p.dir || '') };
    let bad = hostError ? oneLine(hostError, 300) : null;
    const hosts = (key, list) => (Array.isArray(list) ? list : [list]).map((d) => {
      const host = configHost(d);
      if (host === null) bad ||= `"${key}" entry ${oneLine(JSON.stringify(d) ?? String(d), 80)} is not a host name (write it like portal.example.com: no scheme, path, port or wildcard)`;
      return host;
    });
    const lists = { deny: [], protect: [], exclusive: [] };
    if (!bad) {
      for (const [key, list] of [['deny', extraDeny], ['protect', extraProtect], ['exclusive', extraExclusive]]) {
        if (!Array.isArray(list)) { bad ||= `"${key}" is not a list`; continue; }
        lists[key] = key !== 'exclusive' ? hosts(key, list)
          : list.map((e) => (Array.isArray(e) && !e.length ? (bad ||= `an "exclusive" group is empty`, null) : Array.isArray(e) ? [...new Set(hosts(key, e))] : hosts(key, e)[0]));
      }
    }
    configError = bad;
    if (bad) Object.assign(lists, { deny: [], protect: [], exclusive: [] });
    deny = [...new Set(lists.deny)];
    protect = [...new Set([...PROTECTED, ...lists.protect])];
    exclusive = lists.exclusive;
    groups = lockGroups([
      ...Object.entries(LOCK_GROUPS).map(([name, hosts]) => ({ name, hosts })),
      ...protect.map((d) => ({ hosts: [d] })),
      ...exclusive.map((e) => ({ hosts: Array.isArray(e) ? e : [e] })),
    ]);
  }

  function protectedSite(url) {
    try { return matches(hostOf(new URL(url)), protect); } catch { return null; }
  }

  /* The user allowed this session on the site, or the site was remembered for
   * its project and listed on its pairing page when they allowed it. Either
   * needs the lease. */
  function granted(sessionId, site) {
    if (grants.get(sessionId)?.has(site)) return true;
    const l = leases.get(sessionId);
    return Boolean(l) && l.standing.has(entryKey({ project: l.project, kind: 'site', site }));
  }

  /* At most one group matches: see lockGroups. */
  function groupOf(url) {
    let host;
    try { host = hostOf(new URL(url)); } catch { return null; }
    return groups.find((g) => matches(host, g.hosts)) ?? null;
  }

  function lockedSite(url) { return groupOf(url)?.name ?? null; }

  /* A lock holds while its session holds a lease and either one of its tabs,
   * or a frame of one, is on a host of the group or it entered less than
   * LOCK_GRACE_MS ago. A frame the page removed counts until its page goes.
   * Otherwise the group is free, and the next session to enter takes it. */
  function liveLock(key) {
    const l = locks.get(key);
    const g = groups.find((x) => x.key === key);
    if (!l || !g || !leases.has(l.sessionId)) return null;
    if (now() - l.since < LOCK_GRACE_MS) return l;
    const there = (url) => {
      try { return matches(hostOf(new URL(url)), g.hosts) !== null; } catch { return false; }
    };
    const on = tabsOf(l.sessionId).some((t) => there(tabUrl.get(t)) || [...tabFrames.get(t)?.values() ?? []].some(there));
    return on ? l : null;
  }

  /* Pure: the refusal when another session holds the lock of this URL. */
  function lockRefusal(url, sessionId = null) {
    const g = groupOf(url);
    const l = g && liveLock(g.key);
    if (!l || l.sessionId === sessionId) return null;
    const by = leases.get(l.sessionId).label;
    if (g.hosts.length === 1 && g.name === g.hosts[0]) {
      return `${g.name} is in use by ${by}; one session at a time on this site. Wait for it to finish, or ask the user.`;
    }
    return `${hostOf(new URL(url))} is in use by ${by} under the ${g.name} lock (${g.hosts.join(', ')}); one session at a time across them. `
      + 'Wait for it to finish, or ask the user.';
  }

  /* Pure: back and forward land on a page no one can know in advance, so
   * they are refused while another session holds any live lock. */
  function historyRefusal(sessionId) {
    const held = groups.map((g) => [g, liveLock(g.key)]).filter(([, l]) => l && l.sessionId !== sessionId);
    if (!held.length) return null;
    const who = held.map(([g, l]) => `${leases.get(l.sessionId).label} holds ${g.name}`).join(', and ');
    return `back and forward are refused while ${who}: where a history step lands cannot be known in advance; navigate by URL instead.`;
  }

  /* Refusals no approval can lift: bad URLs, other schemes, the deny list. */
  function hardRefusal(url) {
    let u;
    try { u = new URL(url); } catch { return `not a valid URL: ${url}`; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return `refused: only http and https pages (${u.protocol})`;
    if (matches(hostOf(u), deny)) return `refused: ${hostOf(u)} is on the user's deny list`;
    return null;
  }

  function urlRefusal(url, sessionId = null) {
    const hard = hardRefusal(url);
    if (hard) return hard;
    const held = lockRefusal(url, sessionId);
    if (held) return held;
    const host = hostOf(new URL(url));
    const site = matches(host, protect);
    if (site && !(sessionId && granted(sessionId, site))) {
      return `${host} is protected and the user has not allowed this session on ${site}; navigate a tab (or open) to it to ask them in Firefox`;
    }
    return null;
  }

  /* project is the full path the session's server declares (see
   * projectPath), which remembered approvals are kept under. The label
   * the user reads is made here from it, its last part and the session's short
   * id, so no session can pair under a name that hides its project. */
  function opened(sessionId, project = '') {
    const s = session(sessionId);
    s.project = projectPath(project);
    s.label = `${s.project ? oneLine(s.project.split('/').pop() || '/', 60) : 'no project'} · ${sessionId.slice(0, 4)}`;
    s.connected = true;
  }

  function labelOf(sessionId) { return sessions.get(sessionId)?.label ?? ''; }

  function expire() {
    for (const c of claims.values()) {
      if (c.status === 'pending' && now() - c.created > CLAIM_TTL_MS) c.status = 'expired';
    }
    const t = now();
    for (const [id, r] of requests) {
      if (r.status === 'pending' && t - r.created > REQUEST_TTL_MS) end(r, 'expired', r.created + REQUEST_TTL_MS);
      else if (r.status === 'approved' && r.kind !== 'site' && t - r.answered > COLLECT_TTL_MS) {
        // An approval nobody collected lapses, a function's included: the session never learned its id.
        if (r.fnId) functions.get(r.sessionId)?.delete(r.fnId);
        end(r, 'lapsed', r.answered + COLLECT_TTL_MS);
      }
      const over = requests.get(id);
      if (over?.ended !== undefined && t - over.ended > ENDED_GRACE_MS) requests.delete(id);
    }
  }

  /* A question that is over keeps only what a late caller is told, never
   * its code. ended is set for outcomes that ran nothing, which are
   * forgotten ENDED_GRACE_MS later; the rest end with the session's lease. */
  function end(r, status, ended, extra = {}) {
    requests.set(r.id, { id: r.id, sessionId: r.sessionId, kind: r.kind, status, ...(ended === undefined ? {} : { ended }), ...extra });
  }

  function cooldown(sessionId) {
    const c = claims.get(sessionId);
    const n = sessions.get(sessionId)?.denials ?? 0;
    if (c?.status !== 'denied' || !n) return 0;
    const wait = Math.min(DENY_COOLDOWN_MS * 2 ** (n - 1), DENY_COOLDOWN_MAX_MS);
    return Math.max(0, c.decided + wait - now());
  }

  /* `others` names the sessions driving now, for information only: approving
   * this one displaces nobody. */
  function claim(sessionId) {
    expire();
    if (configError) return { status: 'refused', error: refusedByConfig() };
    if (leases.has(sessionId)) return { status: 'granted' };
    const others = [...leases.values()].map((l) => l.label);
    const existing = claims.get(sessionId);
    if (existing?.status === 'pending') return { status: 'pending', code: existing.code, others, fresh: false };
    const wait = cooldown(sessionId);
    if (wait) return { status: 'denied', retryAfterS: Math.ceil(wait / 1000) };
    const { label, project } = session(sessionId);
    const c = { code: makeCode(), label, project, created: now(), status: 'pending', decided: null };
    claims.set(sessionId, c);
    return { status: 'pending', code: c.code, others, fresh: true };
  }

  /* Ends everything a session was given: its questions, whether waiting,
   * allowed and not collected, or over, its grants, functions and site
   * locks. Touches no other session. An approval it never collected must
   * not carry over to a lease the user gives it later. */
  function drop(sessionId) {
    grants.delete(sessionId);
    functions.delete(sessionId);
    for (const [key, l] of locks) if (l.sessionId === sessionId) locks.delete(key);
    for (const [id, r] of requests) if (r.sessionId === sessionId) requests.delete(id);
  }

  /* Only the background page calls this, after checking the message came
   * from the add-on's own confirm page or toolbar popup. An approval adds
   * this session's lease and never touches another session's. shown is the
   * approvalsDigest of the remembered approvals the page listed (none, if
   * not given): an Allow stands only if that is still the list, and the
   * lease gets exactly that list, so nothing reaches it that the user did not
   * read. A list that changed refuses the Allow and leaves the pairing
   * waiting, for the page to show again. */
  function decide(sessionId, code, approve, shown = listDigest([])) {
    expire();
    const c = claims.get(sessionId);
    if (!c || c.status !== 'pending') return { ok: false, error: 'no pending request for that session' };
    if (c.code !== code) return { ok: false, error: 'code does not match the pending request' };
    if (!approve) {
      c.decided = now();
      c.status = 'denied';
      session(sessionId).denials += 1;
      return { ok: true, status: 'denied' };
    }
    const list = standing(c.project);
    if (shown !== listDigest(list)) {
      return { ok: false, changed: true, error: 'The remembered approvals this session would get changed while you read them. Read the list again, then allow.' };
    }
    c.decided = now();
    leases.set(sessionId, { sessionId, label: c.label, project: c.project, since: now(), standing: new Set(list.map(entryKey)) });
    session(sessionId).lost = null;
    session(sessionId).windowId = null; // the window it had is the user's now; it opens its own
    c.status = 'granted';
    return { ok: true, status: 'granted' };
  }

  /* 'granted' only while the session holds its lease; a claim that once
   * succeeded reads 'ended' after control is lost. */
  function claimStatus(sessionId) {
    expire();
    if (leases.has(sessionId)) return 'granted';
    const status = claims.get(sessionId)?.status ?? 'none';
    return status === 'granted' ? 'ended' : status;
  }

  function release(sessionId, reason) {
    const c = claims.get(sessionId);
    if (c?.status === 'pending') c.status = 'cancelled';
    drop(sessionId);
    // Its tabs are the user's from here, for good: a session allowed again
    // starts with none, whatever they browsed to since.
    for (const [tabId, owner] of tabOwner) if (owner === sessionId) { tabOwner.delete(tabId); tabUrl.delete(tabId); tabFrames.delete(tabId); }
    if (!leases.has(sessionId)) return false;
    leases.delete(sessionId);
    session(sessionId).lost = { reason, at: now() };
    return true;
  }

  /* The user stops one session from the toolbar popup. */
  function revoke(sessionId) {
    if (!leases.has(sessionId)) return false;
    return release(sessionId, 'revoked in Firefox');
  }

  /* Every lease ends at once: the host, and every session's connection, is gone. */
  function revokeAll(reason = 'revoked in Firefox') {
    const ids = [...leases.keys()];
    for (const id of ids) release(id, reason);
    return ids.length;
  }

  function closed(sessionId) {
    const s = session(sessionId);
    s.connected = false;
    release(sessionId, 'session ended');
    return s.windowId;
  }

  const refusedByConfig = () => `Foxlatch refuses control of ${profile.name}: config.json is broken: ${configError}. `
    + 'Ask the user to fix it, then restart Firefox (or reload the add-on); the toolbar button shows the same message.';

  function authorize(sessionId) {
    if (configError) throw new Error(refusedByConfig());
    if (leases.has(sessionId)) return;
    const lost = sessions.get(sessionId)?.lost;
    if (lost) throw new Error(`not connected: ${lost.reason}. Ask the user, then call connect again.`);
    throw new Error(`not connected to ${profile.name}. Call connect and have the user confirm the code in Firefox.`);
  }

  /* An action that waits for the user: kind 'site' (subject: a protected site),
   * 'eval' (subject: the exact code that will run once) or 'function' (subject:
   * a function's exact code and the page; once approved the session may call
   * it, passing only data, on that page's origin). Returns the request id;
   * an identical pending request from the same session is reused. An eval's
   * token is the mark of the document the user is shown, one per document; the
   * script runs only where that mark is, and once (see settle). */
  function ask(sessionId, kind, subject, { token = null } = {}) {
    authorize(sessionId);
    expire();
    for (const r of requests.values()) {
      if (r.status === 'pending' && r.sessionId === sessionId && r.kind === kind && r.subject === subject) return r.id;
    }
    const id = `r${++nextRequest}`;
    const { label, project } = leases.get(sessionId);
    // A script's notes are read off its code once, here, not on every view().
    let code = subject;
    try { code = JSON.parse(subject).code; } catch { /* a bare script: the subject is its code */ }
    const notes = kind === 'site' ? {} : { notes: scriptNotes(String(code ?? '')) };
    requests.set(id, { id, sessionId, label, project, kind, subject, created: now(), status: 'pending', ...notes, ...(token ? { token } : {}) });
    return id;
  }

  /* The user's answer, from the add-on's own pages only (see decide). With
   * remember, an Allow on a site or a function also returns the entry to
   * remember for the session's project (never an eval's, never without a
   * project); the host writes it, and it stands only once the host confirms
   * (hostApprovals). The Allow itself applies to this session at once. */
  function answer(id, approve, { remember = false } = {}) {
    expire();
    const r = requests.get(id);
    if (!r || r.status !== 'pending') return { ok: false, error: 'that request is no longer waiting' };
    if (!leases.has(r.sessionId)) {
      end(r, 'cancelled', now());
      return { ok: false, error: 'that session no longer has control' };
    }
    if (!approve) {
      end(r, 'denied', now());
      return { ok: true, status: 'denied' };
    }
    r.status = 'approved';
    r.answered = now();
    if (r.kind === 'site') {
      if (!grants.has(r.sessionId)) grants.set(r.sessionId, new Set());
      grants.get(r.sessionId).add(r.subject);
    }
    if (r.kind === 'function') {
      const { url, code } = JSON.parse(r.subject);
      r.fnId = `f${++nextFunction}`;
      r.origin = new URL(url).origin;
      if (!functions.has(r.sessionId)) functions.set(r.sessionId, new Map());
      functions.get(r.sessionId).set(r.fnId, { code, origin: r.origin });
    }
    const project = leases.get(r.sessionId).project;
    if (remember !== true || !project || r.kind === 'eval') return { ok: true, status: r.status };
    const what = r.kind === 'site' ? { site: r.subject }
      : { origin: r.origin, sha256: sha256(functions.get(r.sessionId).get(r.fnId).code) };
    const entry = { project, kind: r.kind, ...what, added: now(), label: r.label };
    if (full()) {
      note(`Not remembered: ${described(entry)} for ${project}. ${MAX_APPROVALS} remembered approvals is the most; forget some first. The session that asked still has it.`);
      return { ok: true, status: r.status };
    }
    return { ok: true, status: r.status, remember: entry };
  }

  // Entries in the host's file, counting those whose forget it has not confirmed.
  const full = () => approvals.length + forgets.size >= MAX_APPROVALS;

  function note(text) {
    notices.push({ id: `n${++nextNotice}`, text: oneLine(text, 600) });
    if (notices.length > 20) notices.shift();
  }
  function dismiss(id) {
    const i = notices.findIndex((n) => n.id === id);
    if (i >= 0) notices.splice(i, 1);
  }

  /* A define whose exact code the user remembered for this session's project
   * on this page's origin, listed on its pairing page when they allowed it:
   * approved at once, as this session's function, ending with its lease like
   * any other and with the entry if they forget it. Returns { fnId, origin },
   * or null when they must be asked. */
  function rememberedFunction(sessionId, url, code) {
    authorize(sessionId);
    const origin = new URL(url).origin;
    const hash = sha256(code);
    const l = leases.get(sessionId);
    const e = standing(l.project).find((x) => x.kind === 'function' && x.origin === origin && x.sha256 === hash && l.standing.has(entryKey(x)));
    if (!e) return null;
    const fnId = `f${++nextFunction}`;
    if (!functions.has(sessionId)) functions.set(sessionId, new Map());
    functions.get(sessionId).set(fnId, { code, origin, via: entryKey(e) });
    return { fnId, origin };
  }

  /* The user forgets a remembered approval, from the toolbar popup (Forget,
   * or Retry on one that failed). It stops counting here at once, for every
   * session, functions it approved included, and stays out whatever the host
   * lists until the host confirms every forget of it asked so far. Until
   * then the popup shows it as being forgotten, never as gone. Returns the
   * entry for the host to drop from its file, or null if this is not one. */
  function forget(entry) {
    if (!isEntry(entry)) return null;
    const key = entryKey(entry);
    const f = forgets.get(key);
    const known = approvals.find((e) => entryKey(e) === key) ?? f?.entry ?? Object.fromEntries(ENTRY_KEYS[entry.kind].map((k) => [k, entry[k]]));
    forgets.set(key, { entry: known, sent: (f?.sent ?? 0) + 1, error: null });
    unlist(key);
    return known;
  }

  /* A forget that never reached a host (none was running). */
  function forgetFailed(entry, error) {
    const f = isEntry(entry) ? forgets.get(entryKey(entry)) : null;
    if (!f) return;
    f.sent = Math.max(0, f.sent - 1);
    f.error = oneLine(error, 300) || 'not saved';
  }

  /* The host stopped: no forget asked of it will be answered. */
  function forgetsLost(error) {
    for (const f of forgets.values()) {
      if (f.sent) { f.sent = 0; f.error = oneLine(error, 300) || 'not saved'; }
    }
  }

  /* An approval that no longer stands leaves every lease and the functions it approved. */
  function unlist(key) {
    approvals = approvals.filter((e) => entryKey(e) !== key);
    for (const l of leases.values()) l.standing.delete(key);
    for (const fns of functions.values()) for (const [id, f] of fns) if (f.via === key) fns.delete(id);
  }

  /* The approvals file as the host has it: in its hello (did null), or after
   * it did a remember or forget (did: { type, entry }, error if the write
   * failed). The host answers in the order it was asked, so each answer to a
   * forget settles one of those asked; until all are, the key stays out,
   * whatever an answer to an earlier remember lists (Forget, Remember, Forget
   * ends forgotten). A forget it failed to write stays out, failed, until
   * the user retries it or remembers it again. A new host answers nothing the
   * last one was asked: a forget it still lists is returned, for the add-on
   * to ask it again; one it does not list is done. A lease keeps only those
   * of its approvals still listed. */
  function hostApprovals(list, did = null, error = null) {
    const valid = (Array.isArray(list) ? list : []).filter(isEntry);
    const listed = new Set(valid.map(entryKey));
    const again = [];
    if (did === null) {
      for (const [key, f] of forgets) {
        if (!listed.has(key)) { forgets.delete(key); continue; }
        f.sent = 1;
        f.error = null;
        again.push(f.entry);
      }
    } else if (isEntry(did.entry)) {
      const key = entryKey(did.entry);
      const f = forgets.get(key);
      if (did.type === 'forget' && f) {
        f.sent = Math.max(0, f.sent - 1);
        // A forget written supersedes one that failed before it: it is off disk.
        f.error = error ? oneLine(error, 300) : null;
        if (!f.sent && !f.error) forgets.delete(key);
      }
      if (did.type === 'remember' && error) {
        note(`Not remembered: ${described(did.entry)} for ${did.entry.project}: ${oneLine(error, 300)}. The session that asked still has it; later sessions will be asked.`);
      } else if (did.type === 'remember' && f && !f.sent) {
        forgets.delete(key); // remembered again after a forget that failed
      }
    }
    approvals = valid.filter((e) => !forgets.has(entryKey(e))).map((e) => ({ ...e }));
    const keys = new Set(approvals.map(entryKey));
    for (const l of leases.values()) for (const k of [...l.standing]) if (!keys.has(k)) l.standing.delete(k);
    for (const fns of functions.values()) {
      for (const [id, f] of fns) if (f.via && !keys.has(f.via)) fns.delete(id);
    }
    return again;
  }

  /* Where a question stands, for the session that asked; to any other
   * session there is no such question. An approved eval hands back the code
   * that was shown once, and from then on reads 'running' until finished()
   * says it 'ran' or was 'refused', so a second caller learns the script is
   * taken rather than that nothing is there. An approved function reads
   * 'collected', with its id, to every later caller. Refused, unanswered and
   * lapsed questions read so to every caller for ENDED_GRACE_MS. */
  function settle(sessionId, id) {
    expire();
    const r = requests.get(id);
    if (!r || r.sessionId !== sessionId) return { status: 'none' };
    if (r.status === 'pending') return { status: 'pending' };
    if (r.status === 'approved') {
      const out = { status: 'approved', subject: r.subject, ...(r.fnId ? { fnId: r.fnId } : {}), ...(r.token ? { token: r.token } : {}) };
      if (r.kind === 'site') requests.delete(id);
      else if (r.kind === 'function') end(r, 'collected', undefined, { fnId: r.fnId, origin: r.origin });
      else end(r, 'running');
      return out;
    }
    const { status, fnId, origin, reason } = r;
    return { status, ...(fnId ? { fnId, origin } : {}), ...(reason ? { reason } : {}) };
  }

  /* The background page reports that a collected eval ran (reason null) or
   * was refused before running (the page changed since the user's answer). */
  function finished(id, reason = null) {
    const r = requests.get(id);
    if (r?.status !== 'running') return;
    end(r, reason ? 'refused' : 'ran', undefined, reason ? { reason } : {});
  }

  function approvedFunction(sessionId, fnId) {
    authorize(sessionId);
    return functions.get(sessionId)?.get(fnId) ?? null;
  }

  function requestOf(id) { return requests.get(id) ?? null; }

  /* Only a session holding its lease owns a tab or a window: one made while
   * its lease ended is the user's, and stays so if it is allowed again. */
  function ownTab(tabId, sessionId) {
    authorize(sessionId);
    tabOwner.set(tabId, sessionId);
  }
  function tabRemoved(tabId) { tabOwner.delete(tabId); tabUrl.delete(tabId); tabFrames.delete(tabId); }
  function ownerOf(tabId) { return tabOwner.get(tabId) ?? null; }
  function tabsOf(sessionId) { return [...tabOwner].filter(([, s]) => s === sessionId).map(([t]) => t); }
  /* Where an owned tab is now; only owned tabs can keep a site lock alive. */
  function tabAt(tabId, url) { if (tabOwner.has(tabId)) tabUrl.set(tabId, String(url)); }
  /* Where a frame of an owned tab is now, and that a new page took the
   * tab's frames with it. */
  function frameAt(tabId, frameId, url) {
    if (!tabOwner.has(tabId)) return;
    if (!tabFrames.has(tabId)) tabFrames.set(tabId, new Map());
    tabFrames.get(tabId).set(frameId, String(url));
  }
  function framesGone(tabId) { tabFrames.delete(tabId); }

  /* Where a session goes onto, or acts on, a page: refuses what urlRefusal
   * refuses, including a lock another session holds; otherwise takes or
   * refreshes this session's lock on the URL's group. The lock is not a
   * grant: each protected site in it still needs the user's Allow first. */
  function enter(sessionId, url) {
    authorize(sessionId);
    const refusal = urlRefusal(url, sessionId);
    if (refusal) return refusal;
    const g = groupOf(url);
    if (g) locks.set(g.key, { sessionId, since: now() });
    return null;
  }

  function checkTab(sessionId, tabId) {
    authorize(sessionId);
    if (tabOwner.get(tabId) !== sessionId) throw new Error(`tab ${tabId} is not one of this session's tabs; use open`);
  }

  function setWindow(sessionId, windowId) {
    authorize(sessionId);
    session(sessionId).windowId = windowId;
  }
  function windowOf(sessionId) { return sessions.get(sessionId)?.windowId ?? null; }
  function agentWindows() { return [...sessions.values()].map((s) => s.windowId).filter((id) => id !== null); }
  function windowRemoved(windowId) {
    for (const s of sessions.values()) if (s.windowId === windowId) s.windowId = null;
  }

  /* The add-on's own pages are the only senders allowed to approve or revoke.
   * Content scripts, including the agent's page scripts, report the page's
   * URL here and carry a tab, so they fail both checks. */
  function trustedSender(sender, extensionId, extensionBase) {
    return Boolean(sender) && sender.id === extensionId && !sender.tab?.url?.startsWith('http')
      && typeof sender.url === 'string' && sender.url.startsWith(extensionBase)
      && sender.envType !== 'content_child';
  }

  function view() {
    expire();
    return {
      profile,
      configError,
      deny: [...deny],
      protect: [...protect],
      // For the pairing page: the built-in protected sites by provider, and those config.json added.
      builtIn: BUILT_IN.map(({ provider, hosts }) => ({ provider, hosts: [...hosts] })),
      protectAdded: protect.filter((h) => !PROTECTED.includes(h)),
      exclusive: exclusive.map((e) => (Array.isArray(e) ? [...e] : e)),
      // sites: the protected sites the user allowed it on when it asked; standing:
      // the remembered approvals it was given at pairing and still holds.
      leases: [...leases.values()].map(({ standing: keys, ...l }) => ({ ...l, sites: [...(grants.get(l.sessionId) ?? [])],
        functions: [...(functions.get(l.sessionId)?.values() ?? [])].map((f) => f.origin),
        locks: groups.filter((g) => liveLock(g.key)?.sessionId === l.sessionId).map((g) => g.name),
        standing: approvals.filter((e) => keys.has(entryKey(e))).map((e) => ({ ...e })) })),
      // What a pairing gets without asking, so the user reads it before they allow
      // it; the Allow carries approvalsDigest back (see decide).
      pending: [...claims].filter(([, c]) => c.status === 'pending')
        .map(([sessionId, c]) => {
          const list = standing(c.project);
          return { sessionId, label: c.label, project: c.project, code: c.code, created: c.created,
            expires: c.created + CLAIM_TTL_MS, approvals: list.map((e) => ({ ...e })), approvalsDigest: listDigest(list) };
        }),
      approvals: approvals.map((e) => ({ ...e })),
      forgets: [...forgets.values()].map((f) => ({ entry: { ...f.entry }, status: f.sent ? 'pending' : 'failed', ...(f.sent ? {} : { error: f.error }) })),
      approvalsFull: full(),
      notices: notices.map((n) => ({ ...n })),
      requests: [...requests.values()].filter((r) => r.status === 'pending')
        .map(({ token, ...r }) => ({ ...r, expires: r.created + REQUEST_TTL_MS, ...(r.notes ? { notes: r.notes.map((n) => ({ ...n })) } : {}) })),
    };
  }

  return {
    configure, protectedSite, granted, hardRefusal, urlRefusal, lockedSite, lockRefusal, historyRefusal, enter,
    opened, labelOf, claim, decide, claimStatus, release, revoke, revokeAll, closed, authorize,
    ask, answer, settle, finished, requestOf, approvedFunction, rememberedFunction, forget, forgetFailed, forgetsLost, hostApprovals,
    note, dismiss,
    ownTab, ownerOf, tabRemoved, tabsOf, tabAt, frameAt, framesGone, checkTab, setWindow, windowOf, windowRemoved, agentWindows, trustedSender, view,
    get profile() { return profile; },
  };
}

if (typeof module !== 'undefined') {
  module.exports = {
    createCore, scriptNotes, oneLine, sha256, projectPath, MAX_APPROVALS, MAX_PROJECT_CHARS, PROTECTED, LOCK_GROUPS, CLAIM_TTL_MS, REQUEST_TTL_MS, COLLECT_TTL_MS, ENDED_GRACE_MS, DENY_COOLDOWN_MS, LOCK_GRACE_MS,
  };
}
