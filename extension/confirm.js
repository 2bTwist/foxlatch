const sessionId = decodeURIComponent(location.hash.slice(1));
// Allow stays disabled until the tab has been visible for ARM_MS (ui.js).
let code = null;
let deciding = false;
let armTimer = null;
let standing = null; // the remembered approvals this pairing gets, as last shown
let shownDigest = null; // their approvalsDigest, which Allow carries back (core.decide)

function end(message) {
  $('allow').disabled = $('deny').disabled = true;
  $('tiles').classList.add('off');
  $('expires').textContent = '';
  $('outcome').hidden = false;
  $('outcome').textContent = message;
  clearInterval(poll);
}

function arm() {
  clearTimeout(armTimer);
  if (document.visibilityState !== 'visible' || !code || deciding) return;
  armTimer = setTimeout(() => { if (!deciding) $('allow').disabled = false; }, ARM_MS);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') { clearTimeout(armTimer); $('allow').disabled = true; }
  arm();
});

function countdown(expires) {
  const s = Math.max(0, Math.ceil((expires - Date.now()) / 1000));
  $('expires').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} left`;
  $('expires').className = s <= LOW_S ? 'clock low' : 'clock';
}

async function refresh() {
  const v = await browser.runtime.sendMessage({ type: 'view' });
  $('profile').textContent = v.profile.name;
  document.title = `Allow an agent? · ${v.profile.name}`;
  if (deciding) return;
  if (v.configError) {
    renderTiles($('tiles'), '··· ···');
    $('label').textContent = '—';
    end(`No session can drive this profile: config.json is broken: ${v.configError}. Fix it, then restart Firefox.`);
    return;
  }
  const p = v.pending.find((x) => x.sessionId === sessionId);
  if (!p) {
    if (!code) { renderTiles($('tiles'), '··· ···'); $('label').textContent = '—'; }
    end(v.leases.some((l) => l.sessionId === sessionId) ? 'Already allowed. This session is driving the profile.'
      : 'This request is no longer waiting. Ask from your agent again if you still want it.');
    return;
  }
  if (p.code !== code) {
    code = p.code;
    renderLabel($('label'), p.label);
    renderTiles($('tiles'), p.code);
    arm();
  }
  showStanding(p);
  showLimits(v, p);
  countdown(p.expires);
  // Information only: allowing this session takes nothing from the others.
  const others = v.leases.filter((l) => l.sessionId !== sessionId).map((l) => l.label);
  $('others').hidden = !others.length;
  if (others.length) $('others').textContent = `Also driving: ${others.join(', ')}`;
}

/* The project the session pairs under, in full, and every remembered
 * approval Allow gives it, so the user reads them before allowing it. A
 * list that changes under them re-arms Allow, and Allow carries the list
 * shown. */
function showStanding(p) {
  $('project').textContent = p.project || 'No project, so nothing is remembered for it';
  const key = JSON.stringify(p.approvals);
  if (key === standing) return;
  if (standing !== null) { $('allow').disabled = true; arm(); }
  standing = key;
  shownDigest = p.approvalsDigest;
  $('standing').hidden = !p.approvals.length;
  $('standing-k').textContent = 'Remembered for this project: it gets these without asking';
  $('standing-list').replaceChildren(...p.approvals.map((e) => approvalRow(e)));
}

/* What the session is held to, as this profile has it: the protected sites
 * (built in, by provider, then those config.json added) and the refused
 * ones. Every host is one click away, never a wall of them. */
let limitsShown = null;
function showLimits(v, p) {
  const key = JSON.stringify([v.builtIn, v.protectAdded, v.deny, p.approvals.length > 0, v.scripts]);
  if (key === limitsShown) return;
  limitsShown = key;
  const providers = v.builtIn.map((g) => g.provider);
  const named = providers.length > 1 ? `${providers.slice(0, -1).join(', ')} and ${providers.at(-1)}` : providers.join('');
  const hosts = [...v.builtIn.flatMap((g) => g.hosts), ...v.protectAdded];
  const all = el('details', { className: 'all-sites' }, el('summary', { textContent: `All ${hosts.length} sites` }),
    el('p', { className: 'mono', textContent: hosts.join(', ') }));
  const added = v.protectAdded.length ? [', ', el('span', { className: 'mono', textContent: v.protectAdded.join(', ') })] : [];
  // A build without scripts (the public one) asks about sites alone.
  const scripts = v.scripts ? ', and each script' : '';
  const except = p.approvals.length ? ', except what is remembered above' : '';
  $('asks').replaceChildren(`Sign-in, account and mail pages of ${named}`, ...added, `${scripts}${except}. `, all);
  $('denied-row').hidden = !v.deny.length;
  $('denied').textContent = v.deny.join(', ');
}

async function decide(approve) {
  deciding = true;
  clearTimeout(armTimer);
  $('allow').disabled = $('deny').disabled = true;
  const r = await browser.runtime.sendMessage({ type: 'decide', sessionId, code, approve, approvalsDigest: shownDigest });
  if (r?.changed) {
    // The list changed after this page last read it: show it again, and arm Allow anew.
    deciding = false;
    standing = null;
    $('deny').disabled = false;
    await refresh();
    arm();
    return;
  }
  // On success the add-on closes this tab; the line below shows only if that is slow.
  if (r?.ok) end(approve ? 'Allowed. The session opens its own window in this profile.' : 'Not allowed. Nothing changed.');
  else end(r?.error || 'Could not record the decision.');
}

$('allow').addEventListener('click', () => decide(true));
$('deny').addEventListener('click', () => decide(false));
const poll = setInterval(refresh, 1000);
refresh();
