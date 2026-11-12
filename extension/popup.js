// Opened often, so it renders the current state and nothing animates. It
// re-reads the state every few seconds while open so the timer and requests
// stay true; buttons are rebuilt only when what they act on changes.
const span = (ms) => {
  const m = Math.floor(ms / 60000);
  return m < 1 ? 'under a minute' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};
const send = (msg) => browser.runtime.sendMessage(msg);
let shown = '';
// This render's Allow buttons. They arm together ARM_MS after the list was
// last rebuilt, so a row that shifts under the pointer (a request arriving
// above it) cannot be allowed by a second quick click meant for another.
let allows = [];
let armTimer = null;

function status(v) {
  if (v.configError) {
    $('status').replaceChildren(el('div', { className: 'status' },
      el('p', { className: 'line config-error', role: 'alert', textContent: `config.json is broken, so no session can drive this profile: ${v.configError}. Fix it, then restart Firefox.` })));
    return;
  }
  if (v.hostRefused) {
    $('status').replaceChildren(el('div', { className: 'status' },
      el('p', { className: 'line config-error', role: 'alert', textContent: `No session can drive this profile through this add-on: ${v.hostRefused}.` })));
    return;
  }
  if (!v.leases.length) {
    $('status').replaceChildren(el('div', { className: 'status' },
      el('p', { className: 'line' }, el('span', { className: 'dot' }), 'No session is driving')));
    return;
  }
  $('status').replaceChildren(...v.leases.map(driver));
}

/* One driving session, with its own Stop: stopping it leaves the others. */
function driver(l) {
  const name = el('span');
  renderLabel(name, l.label);
  const stop = el('button', { type: 'button', className: 'danger', textContent: 'Stop' });
  stop.setAttribute('aria-label', `Stop ${l.label}`);
  stop.addEventListener('click', async () => { stop.disabled = true; await send({ type: 'revoke', sessionId: l.sessionId }); render(); });
  const since = el('p', { className: 'sub since' });
  since.dataset.since = l.since;
  return el('div', { className: 'status on' },
    el('p', { className: 'line' }, el('span', { className: 'dot' }), el('span', {}, name, ' is driving')),
    el('p', { className: 'sites mono', textContent: l.project || 'No project' }),
    since,
    ...(l.sites.length ? [el('p', { className: 'sites', textContent: `Allowed on ${l.sites.join(', ')}` })] : []),
    ...(l.functions?.length ? [el('p', { className: 'sites', textContent: `Functions on ${[...new Set(l.functions)].join(', ')}` })] : []),
    ...(l.standing?.length ? [el('p', { className: 'sites', textContent: 'Remembered, given at pairing:' }),
      el('ul', { className: 'approvals sites' }, ...l.standing.map((e) => approvalRow(e)))] : []),
    ...(l.locks.length ? [el('p', { className: 'sites', textContent: `Using alone: ${l.locks.join(', ')}` })] : []),
    stop);
}

/* A question from the driving session; the full text (and any script) is on
 * its own tab, which this opens rather than answering blind. */
function question(r) {
  const who = el('p', { className: 'who' });
  renderLabel(who, r.label);
  who.append(r.kind === 'site' ? ` asks to open ${r.subject}` : r.kind === 'function' ? ' asks to approve a function' : ' asks to run a script');
  const open = el('button', { type: 'button', className: 'primary', textContent: r.kind === 'site' ? 'Review' : r.kind === 'function' ? 'Review function' : 'Review script' });
  open.addEventListener('click', async () => {
    const url = browser.runtime.getURL(`ask.html#${encodeURIComponent(r.id)}`);
    const found = (await browser.tabs.query({})).find((t) => t.url === url);
    if (found) {
      await browser.tabs.update(found.id, { active: true });
      await browser.windows.update(found.windowId, { focused: true });
    }
    window.close();
  });
  return el('div', { className: 'request' }, who, el('div', { className: 'actions' }, open));
}

function request(p) {
  const who = el('p', { className: 'who' });
  renderLabel(who, p.label);
  who.append(' asks to drive');
  const tiles = el('div', { className: 'tiles small', role: 'img' });
  renderTiles(tiles, p.code);
  const allow = el('button', { type: 'button', className: 'primary', textContent: 'Allow', disabled: true });
  const deny = el('button', { type: 'button', textContent: 'Don’t allow' });
  allows.push(allow);
  const decide = async (approve) => {
    allows = allows.filter((b) => b !== allow);
    allow.disabled = deny.disabled = true;
    // The list shown above goes with the Allow: if it changed since, it is refused and shown again.
    await send({ type: 'decide', sessionId: p.sessionId, code: p.code, approve, approvalsDigest: p.approvalsDigest });
    render();
  };
  allow.addEventListener('click', () => decide(true));
  deny.addEventListener('click', () => decide(false));
  // What Allow also gives it, as the confirm page lists it.
  const standing = p.approvals.length ? [el('p', { className: 'sub' }, 'Gets without asking, remembered for ', el('span', { className: 'mono', textContent: p.project }), ':'),
    el('ul', { className: 'approvals' }, ...p.approvals.map((e) => approvalRow(e)))] : [];
  return el('div', { className: 'request' }, who,
    el('p', { className: 'sub mono', textContent: p.project || 'No project' }),
    el('p', { className: 'sub', textContent: 'Allow only if it matches the code your agent shows. What it reads goes to your agent and its model provider.' }),
    tiles, ...standing, el('div', { className: 'actions' }, deny, allow));
}

/* Remembered approvals by project, each with Forget, which stops it counting
 * at once. It is gone only once the host has written that: until then the
 * row reads Forgetting…, and a forget the host failed (or that found no
 * host) stays, with what went wrong and Retry, since it would be back after
 * a restart. Notices about remembered approvals sit above, until dismissed. */
function remembered(v) {
  const list = v.approvals;
  const forgets = v.forgets ?? [];
  const notices = v.notices ?? [];
  $('remembered').hidden = !list.length && !forgets.length && !notices.length;
  const rows = [...list.map((e) => ({ e })), ...forgets.map((f) => ({ e: f.entry, f }))];
  const projects = [...new Set(rows.map((r) => r.e.project))];
  const forgetButton = (e, label) => {
    const b = el('button', { type: 'button', className: 'danger', textContent: label });
    b.setAttribute('aria-label', `${label} ${e.kind === 'site' ? e.site : `the function on ${e.origin}`} for ${e.project}`);
    b.addEventListener('click', async () => { b.disabled = true; await send({ type: 'forget', entry: e }); render(); });
    return b;
  };
  const row = ({ e, f }) => {
    if (!f) return approvalRow(e, forgetButton(e, 'Forget'));
    if (f.status === 'pending') return approvalRow(e, el('button', { type: 'button', className: 'danger', textContent: 'Forgetting…', disabled: true }));
    return approvalRow(e, el('span', { className: 'failed', role: 'alert', textContent: `Not forgotten: ${f.error}` }), forgetButton(e, 'Retry'));
  };
  $('remembered').replaceChildren(el('h2', { textContent: 'Remembered' }),
    ...notices.map((n) => {
      const ok = el('button', { type: 'button', textContent: 'Dismiss' });
      ok.addEventListener('click', async () => { ok.disabled = true; await send({ type: 'dismiss', id: n.id }); render(); });
      return el('div', { className: 'notice' }, el('p', { role: 'alert', textContent: n.text }), ok);
    }),
    ...projects.map((project) => el('div', { className: 'project' },
      el('p', { className: 'mono', textContent: project }),
      el('ul', { className: 'approvals' }, ...rows.filter((r) => r.e.project === project).map(row)))));
}

async function render() {
  const v = await send({ type: 'view' });
  $('profile').textContent = v.profile.name;
  $('deny').textContent = v.deny.join(', ');
  const key = JSON.stringify([v.configError, v.hostRefused, v.leases.map((l) => [l.sessionId, l.project, l.sites, l.functions, l.standing, l.locks]),
    v.pending.map((p) => [p.sessionId, p.project, p.code, p.approvals]), v.requests.map((r) => r.id), v.approvals, v.forgets, v.notices]);
  if (key !== shown) {
    shown = key;
    status(v);
    allows = [];
    clearTimeout(armTimer);
    $('pending').replaceChildren(...v.pending.map(request), ...v.requests.map(question));
    remembered(v);
    armTimer = setTimeout(() => { for (const b of allows) b.disabled = false; }, ARM_MS);
  }
  for (const p of document.querySelectorAll('.since')) {
    const t = Number(p.dataset.since);
    p.textContent = `for ${span(Date.now() - t)}`;
  }
  // A forget waiting for the host is read again soon, so its outcome shows without waiting for the next refresh.
  clearTimeout(soon);
  if (v.forgets?.some((f) => f.status === 'pending')) soon = setTimeout(render, 500);
}
let soon = null;

render();
setInterval(render, 5000);
