/*
 * Functions that run inside a page frame as content scripts. background.js
 * injects one at a time through pageScript(), which serialises it with
 * toString(), so none may close over anything outside its own body; the
 * helpers they share live in `ctx()`, which pageScript defines beside each
 * one, so they are rebuilt against the page as it is on every call.
 *
 * Element refs live in the content-script sandbox (`window` here is an Xray
 * view, so the page cannot see `__fxd`), not in DOM attributes: the page's own
 * scripts never observe a change made by the driver. A new document gets a new
 * sandbox, so its refs start again at e1; `s.doc`, the tag its first snapshot
 * was given, tells a ref from this document from one an older document issued.
 */

const PAGE = {
  ctx() {
    const s = (window.__fxd ||= { n: 0, byRef: new Map(), byEl: new WeakMap() });
    s.prints ||= new Map(); // ref -> its role, name, look-alike count and URL at the snapshot that listed it
    const INTERACTIVE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option],[role=checkbox],[role=radio],[role=switch],[role=combobox],[role=textbox],[role=searchbox],[role=slider],[role=treeitem],[contenteditable=""],[contenteditable=true],[tabindex]:not([tabindex="-1"])';
    const HEADINGS = 'h1,h2,h3,[role=heading],[role=dialog],[role=alertdialog]';

    // Collapsed and clipped, never inside a surrogate pair.
    const clean = (t, n = 100) => (t || '').replace(/\s+/g, ' ').trim().slice(0, n).replace(/[\uD800-\uDBFF]$/, '');
    const nameOf = (el, n = 100) => {
      const by = el.getAttribute('aria-labelledby');
      if (by) {
        const t = by.split(/\s+/).map((id) => el.getRootNode().getElementById?.(id)?.innerText || '').join(' ');
        if (t.trim()) return clean(t, n);
      }
      return clean(el.getAttribute('aria-label') || el.labels?.[0]?.innerText || el.innerText
        || el.placeholder || el.title || el.alt || (el.type === 'submit' || el.type === 'button' ? el.value : ''), n);
    };
    // Clipped: the role and type attributes are the page's, of any length or content.
    const roleOf = (el) => clean(el.getAttribute('role') || el.tagName.toLowerCase() + (el.tagName === 'INPUT' && el.type ? `[${el.type}]` : ''), 40);
    // The ARIA role: the first one the role attribute names, else the one a
    // native element has without it (find matches this or roleOf).
    const ariaRole = (el) => {
      const named = (el.getAttribute('role') || '').trim().split(/\s+/)[0];
      if (named) return named.toLowerCase();
      const tag = el.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) return 'heading';
      if (tag === 'input') {
        const type = String(el.type || 'text').toLowerCase();
        return { button: 'button', submit: 'button', reset: 'button', image: 'button', checkbox: 'checkbox', radio: 'radio',
          range: 'slider', number: 'spinbutton', search: 'searchbox', hidden: '' }[type] ?? 'textbox';
      }
      if (tag === 'select') return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
      if (tag === 'a' || tag === 'area') return el.getAttribute('href') !== null ? 'link' : '';
      if (tag === 'img') return el.getAttribute('alt') === '' ? 'presentation' : 'img';
      return { button: 'button', summary: 'button', textarea: 'textbox', ul: 'list', ol: 'list', menu: 'list', li: 'listitem',
        table: 'table', tr: 'row', td: 'cell', th: 'columnheader', nav: 'navigation', main: 'main', form: 'form', dialog: 'dialog',
        option: 'option', article: 'article', aside: 'complementary', fieldset: 'group', progress: 'progressbar', hr: 'separator' }[tag] ?? '';
    };
    // A field whose value is a password: its type, or the autocomplete hint a
    // "show password" toggle leaves on it when it turns it into text.
    const secret = (el) => el.type === 'password' || /password/i.test(el.getAttribute?.('autocomplete') || '');
    const shown = (el, r = el.getBoundingClientRect()) => {
      if (!r.width || !r.height) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) !== 0;
    };
    // What snapshot lists: what is shown, and every native <select>, which a
    // custom dropdown often hides while driving it; choosing on the native
    // one is what works there.
    const listed = (el, r) => el.tagName === 'SELECT' || shown(el, r);
    // Everything inside top, in document order across open shadow roots
    // (each root's elements after those of the tree holding it).
    const under = (top) => {
      const roots = [top];
      if (top.shadowRoot) roots.push(top.shadowRoot);
      const out = [];
      while (roots.length) {
        const root = roots.shift();
        for (const el of root.querySelectorAll('*')) {
          out.push(el);
          if (el.shadowRoot) roots.push(el.shadowRoot);
        }
      }
      return out;
    };
    const all = () => under(document);
    const refOf = (el) => {
      let r = s.byEl.get(el);
      if (!r) { r = `e${++s.n}`; s.byEl.set(el, r); s.byRef.set(r, new WeakRef(el)); }
      return r;
    };
    // Whether the pointer at its centre would hit something else.
    const covered = (el, r) => {
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false;
      const top = el.getRootNode().elementFromPoint?.(x, y);
      return Boolean(top) && top !== el && !el.contains(top) && !top.contains(el);
    };
    // An element as snapshot lists it, after its ref.
    const line = (el, ref, r = el.getBoundingClientRect()) => {
      const role = roleOf(el);
      const name = nameOf(el);
      const value = secret(el) ? '' : clean(el.isContentEditable ? el.innerText : el.value ?? '', 60);
      // Where a link goes, so reading an address needs no script (each one
      // asks the user): same-site links by path, others in full, both cut short.
      let to = '';
      if (el.tagName === 'A' && el.href) {
        try {
          const u = new URL(el.href);
          // A sign-in in the address is the page's secret, and a script link's body is code, not a place.
          u.username = '';
          u.password = '';
          to = u.protocol === 'javascript:' ? 'javascript:'
            : clean(u.origin === location.origin ? u.pathname + u.search + u.hash : u.href, 150);
        } catch { /* an href that is not a URL has nowhere to show */ }
      }
      return `${ref} ${role} "${name}"${value && value !== name ? ` value="${value}"` : ''}${to ? ` -> ${to}` : ''}`
        + `${el.checked ? ' checked' : ''}${el.getAttribute('aria-expanded') === 'true' ? ' expanded' : ''}`
        + `${el.getAttribute('aria-selected') === 'true' ? ' selected' : ''}${el.disabled || el.getAttribute('aria-disabled') === 'true' ? ' disabled' : ''}`
        + `${!shown(el, r) ? ' hidden' : r.bottom < 0 || r.top > innerHeight ? ' offscreen' : covered(el, r) ? ' covered' : ''}`;
    };
    /* Refs for elements find or read returns, each remembered as snapshot
     * remembers one (its role, name, look-alike count and URL), so a
     * re-render finds it again under the same rule. Only interactive
     * elements are re-found; the count is over what snapshot lists. */
    let lookalikes = null;
    const issue = (els) => els.map((el) => {
      const ref = refOf(el);
      if (el.matches(INTERACTIVE)) {
        if (!lookalikes) {
          lookalikes = new Map();
          for (const c of all()) {
            if (!c.matches(INTERACTIVE) || !listed(c)) continue;
            const k = `${roleOf(c)}\n${nameOf(c)}`;
            lookalikes.set(k, (lookalikes.get(k) ?? 0) + 1);
          }
        }
        const role = roleOf(el);
        const name = nameOf(el);
        s.prints.set(ref, { role, name, count: lookalikes.get(`${role}\n${name}`) ?? 0, href: location.href });
      }
      return ref;
    });
    const tagOf = (el) => {
      const cls = typeof el.className === 'string' ? clean(el.className, 60) : '';
      return `<${el.tagName.toLowerCase()}${el.id ? ` id="${clean(el.id, 40)}"` : ''}${cls ? ` class="${cls}"` : ''}>`;
    };
    /* The element a ref names. When a re-render replaced it, it is found
     * again only where nothing else could be meant: at the snapshot it was
     * the one element with its role and name, the page is still at the URL
     * that snapshot saw (a same-document route change is another page), and
     * exactly one element has both now, which no other ref names. An unnamed
     * element is never guessed. */
    const resolve = (ref, doc) => {
      // A ref from another document (doc is the tag its snapshot was given)
      // would name whatever this one numbered the same.
      if (doc !== undefined && doc !== s.doc) throw new Error(`element ${ref} is from a page this frame has since left; snapshot again`);
      const el = s.byRef.get(ref)?.deref();
      if (el?.isConnected) return { el, refound: false };
      const p = s.prints.get(ref);
      const gone = `element ${ref} is gone; take a new snapshot`;
      if (!p?.name || p.count !== 1 || p.href !== location.href) throw new Error(gone);
      const fits = all().filter((c) => c.matches(INTERACTIVE) && roleOf(c) === p.role && listed(c) && nameOf(c) === p.name);
      if (fits.length !== 1) throw new Error(fits.length ? `${gone} (${fits.length} elements now look like it, 1 did before)` : gone);
      const [found] = fits;
      if (s.byEl.has(found)) throw new Error(gone);
      s.byRef.set(ref, new WeakRef(found));
      s.byEl.set(found, ref);
      return { el: found, refound: true };
    };
    return { s, INTERACTIVE, HEADINGS, clean, nameOf, roleOf, ariaRole, secret, shown, listed, under, all, refOf, line, issue, tagOf, resolve };
  },

  snapshot({ max, filter, doc }) {
    const { s, INTERACTIVE, HEADINGS, nameOf, roleOf, listed, all, refOf, line: lineOf } = ctx();
    // The first snapshot in this document names it; the background page gives
    // every snapshot a tag no other has had, so no two documents share one.
    if (doc && s.doc === undefined) s.doc = doc;
    const want = filter ? filter.toLowerCase() : null;
    const words = (t) => t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const wanted = want ? words(want) : [];

    const lines = [];
    const near = []; // lines the filter missed, scored by the filter words they share
    const seen = new Map(); // role and name -> elements with both
    const prints = [];
    let skipped = 0;
    for (const el of all()) {
      const isHeading = el.matches(HEADINGS);
      if (!isHeading && !el.matches(INTERACTIVE)) continue;
      const r = el.getBoundingClientRect();
      if (!listed(el, r)) continue;
      const role = roleOf(el);
      const name = nameOf(el);
      if (isHeading && !el.matches(INTERACTIVE)) {
        if (!want && name && lines.length >= max) skipped++;
        else if (!want && name) lines.push(`  ${role === 'dialog' || role === 'alertdialog' ? `[${role}]` : '#'} ${name}`);
        continue;
      }
      // What finds this element again if a re-render replaces it.
      const key = `${role}\n${name}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
      const ref = refOf(el);
      const print = { role, name, key, href: location.href };
      s.prints.set(ref, print);
      prints.push(print);
      const line = lineOf(el, ref, r);
      const lower = line.toLowerCase();
      if (want && !lower.includes(want)) {
        const score = wanted.reduce((n, w) => n + (lower.includes(w) ? 1
          : w.length >= 4 && words(lower).some((x) => x.startsWith(w.slice(0, 4))) ? 0.5 : 0), 0);
        if (score) near.push({ line, score });
        continue;
      }
      if (lines.length >= max) { skipped++; continue; }
      lines.push(line);
    }
    for (const p of prints) { p.count = seen.get(p.key); delete p.key; }
    return {
      doc: s.doc ?? '',
      url: location.href,
      title: document.title,
      scroll: `${Math.round(scrollY)} of ${Math.max(0, document.documentElement.scrollHeight - innerHeight)}px`,
      lines,
      skipped,
      ...(want && !lines.length ? { near: near.sort((a, b) => b.score - a.score).slice(0, 10) } : {}),
    };
  },

  /* Elements matching every criterion given, in document order across
   * open shadow roots, inside `within` when it names one: role (ARIA,
   * implicit, or as snapshot prints it), name (substring, case-insensitive;
   * exact when quoted), text (the innermost element whose visible text holds
   * it). Lines as snapshot prints them, at most max; matches counts all. */
  find({ role, name, text, within, doc, tag, max }) {
    const { s, INTERACTIVE, HEADINGS, clean, nameOf, roleOf, ariaRole, listed, under, all, line, issue, resolve } = ctx();
    if (!role && !name && !text) throw new Error('pass role, name or text');
    const scope = within ? resolve(within, doc).el : null;
    if (tag && s.doc === undefined) s.doc = tag;
    const fold = (t) => clean(t, Infinity).toLowerCase();
    const squash = (t) => t.toLowerCase().replace(/\s+/g, '');
    const wantRole = role ? role.trim().toLowerCase() : null;
    const quoted = name ? /^\s*"(.*)"\s*$/s.exec(name) : null;
    const exact = quoted ? clean(quoted[1], Infinity) : null;
    const part = name && !quoted ? fold(name) : null;
    const wantText = text ? fold(text) : null;
    const textKey = text ? squash(text) : null;
    const found = [];
    // textContent holds every letter innerText shows, in order, and an
    // element's is part of its parent's: one whose text lacks it rules out
    // everything inside it without asking the page's layout.
    const without = new Set();
    for (const el of scope ? under(scope) : all()) {
      if (text) {
        if (without.has(el.parentElement) || !squash(el.textContent || '').includes(textKey)) { without.add(el); continue; }
      }
      if (wantRole) {
        if (roleOf(el).toLowerCase() !== wantRole && ariaRole(el) !== wantRole) continue;
      } else if (!text && !el.matches(INTERACTIVE) && !el.matches(HEADINGS)) {
        continue; // a name alone looks among what snapshot lists
      }
      if (name) {
        const n = nameOf(el, 1000);
        if (exact !== null ? n !== exact : !n.toLowerCase().includes(part)) continue;
      }
      if (text && !fold(el.innerText).includes(wantText)) continue;
      if (!listed(el)) continue;
      found.push(el);
    }
    // In document order an element's descendants follow it at once, so one
    // holding another match is followed by one: keep the innermost.
    const matches = text ? found.filter((el, i) => !(found[i + 1] && el.contains(found[i + 1]))) : found;
    const shown = matches.slice(0, Math.max(0, max));
    const refs = issue(shown);
    return { doc: s.doc ?? '', matches: matches.length, lines: shown.map((el, i) => line(el, refs[i])) };
  },

  /* A bounded read of one scope (a ref, a selector's first match, or the
   * main landmark or body), shaped by what it is: a table's rows, a form's
   * fields, a list's items, or else its text blocks in reading order.
   * offset and max count those; next is where the following page starts.
   * Only what is shown is read, and no password value. */
  read({ ref, doc, selector, tag, offset, max }) {
    const { s, INTERACTIVE, clean, nameOf, roleOf, secret, shown, listed, under, issue, resolve } = ctx();
    let scope;
    if (ref) {
      scope = resolve(ref, doc).el;
    } else if (selector) {
      try {
        scope = document.querySelector(selector);
      } catch (e) {
        throw new Error(`bad selector ${selector}: ${e.message}`);
      }
      if (!scope) throw new Error(`nothing matches ${selector}`);
    } else {
      scope = [...document.querySelectorAll('main,[role=main]')].find((el) => shown(el)) || document.body;
      if (!scope) throw new Error('the page has no body to read');
    }
    if (tag && s.doc === undefined) s.doc = tag;
    // The whole result stays far under the host's 900 KB message cap: pages
    // stop once this many characters of JSON are in, after at least one unit.
    const BUDGET = 100000;
    const MAX_PARTS = 100; // cells or refs of one row or item
    // Whatever shortens the unit being rendered sets this, and the unit says
    // so (cut: true): a caller is never left taking a part for the whole.
    let cut = false;
    const short = (t, n) => {
      const all = clean(t, Infinity);
      if (all.length > n) cut = true;
      return clean(all, n);
    };
    const capped = (list) => {
      if (list.length > MAX_PARTS) cut = true;
      return list.slice(0, MAX_PARTS);
    };
    const say = (el, n) => (shown(el) ? short(el.innerText, n) : '');
    // Each ref with its role and name, so a row's Edit and Delete are told apart.
    const refsIn = (el) => {
      const els = capped(under(el).filter((c) => c.matches(INTERACTIVE) && listed(c)));
      return issue(els).map((ref, i) => ({ ref, role: roleOf(els[i]), name: short(nameOf(els[i], 1e5), 100) }));
    };
    const paged = (units, render) => {
      const out = [];
      let size = 0;
      let i = Math.max(0, offset);
      for (; i < units.length && out.length < max; i++) {
        cut = false;
        const unit = render(units[i]);
        if (cut) unit.cut = true;
        const n = JSON.stringify(unit).length;
        if (out.length && size + n > BUDGET) break;
        out.push(unit);
        size += n;
      }
      return { out, total: units.length, ...(i < units.length ? { next: i } : {}) };
    };
    const done = (kind, key, units, render, extra = {}) => {
      const { out, total, next } = paged(units, render);
      return { doc: s.doc ?? '', kind, ...extra, [key]: out, total, ...(next !== undefined ? { next } : {}) };
    };
    const below = (el, sel) => { // el's nearest ancestor matching sel, up to the scope itself, or null
      for (let n = el.parentElement; n; n = n.parentElement) {
        if (n.matches(sel)) return n;
        if (n === scope) return null;
      }
      return null;
    };

    const TABLE = 'table,[role=table],[role=grid],[role=treegrid]';
    const ROW = 'tr,[role=row]';
    const CELL = 'td,th,[role=cell],[role=gridcell],[role=columnheader],[role=rowheader]';
    if (scope.matches(TABLE)) {
      const rows = [...scope.querySelectorAll(ROW)].filter((r) => below(r, TABLE) === scope && shown(r));
      const cellsOf = (r) => capped([...r.querySelectorAll(CELL)].filter((c) => below(c, ROW) === r));
      // Header rows: those in <thead>, else the leading rows of headings only;
      // at most four, so a table of <th> rows throughout still has a body.
      const allHeadings = (r) => cellsOf(r).length && cellsOf(r).every((c) => c.matches('th,[role=columnheader]'));
      let head = rows.filter((r) => below(r, 'thead'));
      if (!head.length) for (const r of rows) { if (!allHeadings(r)) break; head.push(r); }
      head = head.slice(0, 4);
      const body = rows.filter((r) => !head.includes(r));
      // Each column is named by every heading above it, spans laid out as a
      // grid (a grouped column reads "City proper · Population").
      const span = (c, name) => Math.min(Math.max(parseInt(c.getAttribute(name), 10) || 1, 1), MAX_PARTS);
      const grid = head.map(() => []);
      cut = false; // from here to the headers: whether a heading or a column of them was shortened
      head.forEach((r, i) => {
        let col = 0;
        for (const c of cellsOf(r)) {
          while (grid[i][col] !== undefined) col++;
          const label = say(c, 200);
          for (let y = i; y < Math.min(i + span(c, 'rowspan'), head.length); y++) {
            for (let x = col; x < Math.min(col + span(c, 'colspan'), MAX_PARTS); x++) grid[y][x] = label;
          }
          col += span(c, 'colspan');
        }
      });
      const width = Math.max(0, ...grid.map((g) => g.length));
      const headers = Array.from({ length: width }, (_, x) => {
        const parts = [];
        for (const g of grid) if (g[x] && parts.at(-1) !== g[x]) parts.push(g[x]);
        return parts.join(' · ');
      });
      const headersCut = cut;
      return done('table', 'rows', body, (r) => {
        const cells = cellsOf(r);
        return { cells: cells.length ? cells.map((c) => say(c, 200)) : [say(r, 200)], refs: refsIn(r) };
      }, { headers, ...(headersCut ? { headersCut } : {}) });
    }

    const LIST = 'ul,ol,dl,[role=list],[role=listbox],[role=feed]';
    const ITEM = 'li,dt,dd,article,[role=listitem],[role=option],[role=article]';
    if (scope.matches(LIST)) {
      const items = under(scope).filter((el) => el.matches(ITEM) && below(el, LIST) === scope && shown(el)
        && !below(el, ITEM));
      return done('list', 'items', items, (el) => ({ text: say(el, 1000), refs: refsIn(el) }));
    }

    const FIELD = 'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]),select,textarea,'
      + '[role=checkbox],[role=radio],[role=switch],[role=combobox],[role=textbox],[role=searchbox],[role=slider],[role=spinbutton],'
      + '[contenteditable=""],[contenteditable=true]';
    const fields = [scope, ...under(scope)].filter((el) => el.matches(FIELD) && listed(el)); // a field's own ref reads it
    // A form, or a scope the caller chose that holds fields; the page's main
    // or body with a search box in it is still read as text.
    if (scope.matches('form,[role=form],[role=search],fieldset') || ((ref || selector) && fields.length)) {
      return done('form', 'fields', fields, (el) => {
        const [fieldRef] = issue([el]);
        const f = { ref: fieldRef, role: roleOf(el), label: short(nameOf(el, 1e5), 200) };
        if (!secret(el)) f.value = short(el.isContentEditable ? el.innerText : el.value ?? '', 1000);
        if (el.tagName === 'SELECT') {
          // The first 50, and the selected ones wherever they are.
          const all = [...el.options];
          const some = all.filter((o, i) => i < 50 || o.selected).slice(0, MAX_PARTS);
          f.options = some.map((o) => ({ label: short(o.label, 200), value: short(o.value, 200), selected: Boolean(o.selected) }));
          if (some.length < all.length) {
            f.optionsTotal = all.length;
            cut = true;
          }
          const chosen = all.filter((o) => o.selected).length;
          if (chosen > some.filter((o) => o.selected).length) f.selectedTotal = chosen;
        }
        const checkable = (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) || /^(checkbox|radio|switch)$/.test(el.getAttribute('role') || '');
        if (checkable) f.checked = el.tagName === 'INPUT' ? Boolean(el.checked) : el.getAttribute('aria-checked') === 'true';
        if (el.required || el.getAttribute('aria-required') === 'true') f.required = true;
        if (el.disabled || el.getAttribute('aria-disabled') === 'true') f.disabled = true;
        if (el.getAttribute('aria-invalid') === 'true' || el.validity?.valid === false) f.invalid = true;
        return f;
      });
    }

    // Text: the outermost block elements, and the innermost containers laid
    // out as blocks whose content is all inline (an app's <div> of <span>s).
    // Loose text beside blocks inside one container is not reached here.
    const HEADING = 'h1,h2,h3,h4,h5,h6,[role=heading]';
    const ITEMS = 'li,dt,dd,[role=listitem]';
    const BLOCK = `${HEADING},${ITEMS},${CELL},p,pre,blockquote,figcaption,caption`;
    const els = [scope, ...under(scope)];
    const blocky = (el) => {
      const { display } = getComputedStyle(el);
      return display !== 'none' && (el.matches(BLOCK) || !/^(inline|contents|ruby)/.test(display));
    };
    const holdsBlock = new Set();
    for (const el of els) {
      // Only a block that will be read stands for its ancestors: an empty or
      // hidden one (a clearfix, a spacer) would hide their text.
      if (!blocky(el) || !shown(el) || !clean(el.innerText, 1)) continue;
      for (let n = el.parentElement; n && !holdsBlock.has(n); n = n.parentElement) {
        holdsBlock.add(n);
        if (n === scope) break;
      }
    }
    const inBlock = (el) => el !== scope && below(el, BLOCK) !== null;
    const blocks = els.filter((el) => (el.matches(BLOCK) || (blocky(el) && !holdsBlock.has(el)))
      && !inBlock(el) && shown(el) && clean(el.innerText, 1));
    return done('text', 'blocks', blocks, (el) => ({
      role: el.matches(HEADING) ? 'heading' : el.matches(ITEMS) ? 'item' : el.matches(CELL) ? 'cell' : 'paragraph',
      text: say(el, 1000),
    }));
  },

  /* The frame's visible text from offset, at most max characters (never
   * half a surrogate pair), with its whole length and where the rest starts. */
  text({ offset, max }) {
    const all = document.body?.innerText || '';
    const from = Math.min(Math.max(0, offset), all.length);
    let to = Math.min(all.length, from + max);
    const high = (i) => { const c = all.charCodeAt(i); return c >= 0xd800 && c <= 0xdbff; };
    if (to < all.length && to - 1 > from && high(to - 1)) to--;
    return { url: location.href, title: document.title, text: all.slice(from, to), offset: from, total: all.length, ...(to < all.length ? { next: to } : {}) };
  },

  /* A ref's box in page coordinates, after scrolling it into view: the rect
   * captureTab takes for an element screenshot. */
  rect({ ref, doc }) {
    const { el } = ctx().resolve(ref, doc);
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height };
  },

  async act({ ref, doc, lease, action, text, clear, key, option, dx, dy, force }) {
    const { resolve, tagOf } = ctx();
    let el = null;
    let note = '';
    const find = () => {
      const found = resolve(ref, doc);
      el = found.el;
      if (found.refound) note = ` (re-found ${ref} after the page re-rendered)`;
    };
    if (ref) find();
    if (!el && ['click', 'hover', 'select'].includes(action)) throw new Error(`pass a ref to ${action}`);
    if (action === 'select' && !(el instanceof HTMLSelectElement)) throw new Error(`element ${ref} is not a <select>; click it and pick an option ref instead`);

    // What a person needs before acting on an element: it is there, has a
    // box and is not hidden, is enabled, and for a click is what the pointer
    // would hit at its centre (it or something inside it). Pages are often
    // mid-render or mid-animation, so this is retried for up to 2 s. A native
    // <select> is often hidden behind the custom dropdown that drives it, so
    // select skips the visibility check; force skips a click's covered check,
    // for a widget that lays its own overlay over its button.
    const blocker = (target) => {
      if (!target.isConnected) return 'is gone; take a new snapshot';
      if (action === 'click') target.scrollIntoView({ block: 'center', inline: 'center' });
      const r = target.getBoundingClientRect();
      if (action !== 'select' && (!r.width || !r.height || getComputedStyle(target).visibility === 'hidden')) return 'is not visible';
      if (action !== 'hover' && (target.matches(':disabled') || target.closest('[aria-disabled="true"]'))) return 'is disabled';
      if (action === 'click' && force !== true) {
        // A container over it still holds it, and receives the click as the
        // event bubbles; anything else on top would take a person's click.
        const top = target.getRootNode().elementFromPoint?.(r.left + r.width / 2, r.top + r.height / 2);
        if (top && top !== target && !target.contains(top) && !top.contains(target)) return `is covered by ${tagOf(top)}`;
      }
      return null;
    };
    // Control can end (the user's Stop) between the background page's check and
    // this script, or while it waits: before the first try and each later
    // one it asks whether this action's lease still holds, and nothing but
    // synchronous checks stand between that answer and the dispatch.
    const alive = async () => {
      if (!lease) return;
      const ok = await browser.runtime.sendMessage({ type: 'alive', lease }).catch(() => false);
      if (ok !== true) throw new Error('not connected: control ended before the action ran; nothing was done');
    };
    await alive();
    if (el && ['click', 'hover', 'type', 'select'].includes(action)) {
      const until = Date.now() + 2000;
      for (let why = blocker(el); why; why = blocker(el)) {
        if (!el.isConnected && !note) { find(); continue; } // re-rendered while waiting: once
        if (Date.now() >= until) throw new Error(`element ${ref} ${why}`);
        await new Promise((r) => setTimeout(r, 100));
        await alive();
      }
    }

    const point = (target) => {
      target.scrollIntoView({ block: 'center', inline: 'center' });
      const r = target.getBoundingClientRect();
      return { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, screenX: r.left + r.width / 2, screenY: r.top + r.height / 2 };
    };
    const fire = (target, type, extra = {}) => {
      const init = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, ...extra };
      const ev = type.startsWith('pointer') ? new PointerEvent(type, { pointerId: 1, pointerType: 'mouse', isPrimary: true, ...init })
        : type.startsWith('key') ? new KeyboardEvent(type, init) : new MouseEvent(type, init);
      return target.dispatchEvent(ev);
    };

    const done = (() => { switch (action) {
      case 'click': {
        const at = point(el);
        for (const t of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove', 'pointerdown', 'mousedown']) fire(el, t, at);
        el.focus?.({ focusVisible: false });
        for (const t of ['pointerup', 'mouseup']) fire(el, t, at);
        el.click();
        return 'clicked';
      }
      case 'hover': {
        const at = point(el);
        for (const t of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) fire(el, t, at);
        return 'hovered';
      }
      case 'type': {
        const target = el || document.activeElement;
        if (!target || target === document.body) throw new Error('no element to type into; pass a ref');
        const secret = (e) => e && (e.type === 'password' || /password/i.test(e.getAttribute?.('autocomplete') || ''));
        if (secret(target)) throw new Error('refused: password field');
        const editable = target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
        if (!editable) throw new Error(`element ${ref} does not accept text`);
        if (target.readOnly || target.disabled) throw new Error(`element ${ref} is read-only or disabled`);
        target.focus();
        // insertText writes wherever focus is, and a page's focus handler can
        // move it; type only into the element that was checked.
        let focused = document.activeElement;
        while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement;
        const sameEditor = target.isContentEditable && focused?.isContentEditable && (focused.contains(target) || target.contains(focused));
        if (focused !== target && !sameEditor) throw new Error(secret(focused) ? 'refused: focus moved to a password field' : 'focus moved to another element; snapshot again');
        if (clear) {
          if (target.isContentEditable) document.execCommand('selectAll');
          else target.select();
        } else if (!target.isContentEditable) {
          target.setSelectionRange?.(target.value.length, target.value.length);
        }
        // execCommand goes through the browser's own editing path, so the
        // page sees trusted beforeinput and input events, as from a keyboard.
        if (text === '' && clear) document.execCommand('delete');
        else if (!document.execCommand('insertText', false, text)) {
          const proto = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(target, clear ? text : target.value + text);
          target.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        }
        target.dispatchEvent(new Event('change', { bubbles: true }));
        return 'typed';
      }
      case 'select': {
        const opt = [...el.options].find((o) => o.label.trim() === option || o.value === option)
          || [...el.options].find((o) => o.label.toLowerCase().includes(String(option).toLowerCase()));
        if (!opt) throw new Error(`no option "${option}"; options: ${[...el.options].map((o) => o.label.trim()).join(' | ').slice(0, 300)}`);
        el.focus();
        el.value = opt.value;
        el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return `selected "${opt.label.trim()}"`;
      }
      case 'key': {
        const target = el || document.activeElement || document.body;
        const parts = key.split('+');
        const name = parts.pop();
        const mods = new Set(parts.map((m) => m.toLowerCase()));
        const CODES = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, Space: 32, ' ': 32, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, PageUp: 33, PageDown: 34 };
        const k = name === 'Space' ? ' ' : name;
        const keyCode = CODES[name] ?? (k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0);
        const init = {
          key: k, code: name.length === 1 ? `Key${name.toUpperCase()}` : name === ' ' ? 'Space' : name, keyCode, which: keyCode,
          ctrlKey: mods.has('control') || mods.has('ctrl'), shiftKey: mods.has('shift'), altKey: mods.has('alt'), metaKey: mods.has('meta') || mods.has('cmd'),
        };
        // A page that cancels keydown or keypress has taken the key for itself.
        const down = fire(target, 'keydown', init);
        const go = down && (k === 'Enter' || k.length === 1)
          ? fire(target, 'keypress', { ...init, charCode: k === 'Enter' ? 13 : k.charCodeAt(0) }) : down;
        fire(target, 'keyup', init);
        // Synthetic events carry no default action. Supply the two a form needs.
        if (go && k === 'Enter' && target instanceof HTMLInputElement && target.form && !init.ctrlKey && !init.metaKey) {
          target.form.requestSubmit();
          return 'pressed Enter (form submitted)';
        }
        if (go && k === 'Tab') {
          const order = [...document.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"]),[contenteditable=true]')]
            .filter((e) => !e.disabled && e.getClientRects().length);
          const i = order.indexOf(document.activeElement);
          order[(i + (init.shiftKey ? -1 : 1) + order.length) % order.length]?.focus();
        }
        return `pressed ${key}`;
      }
      case 'scroll': {
        if (el) el.scrollIntoView({ block: 'center' });
        else window.scrollBy(dx || 0, dy || 0);
        return `scroll ${Math.round(scrollY)} of ${Math.max(0, document.documentElement.scrollHeight - innerHeight)}px`;
      }
      default:
        throw new Error(`unknown action ${action}`);
    } })();
    return done + note;
  },

  /* One poll of a wait, run by the background page: whether the page shows
   * the text, and whether the selector matches, right now. */
  present({ text, selector }) {
    const out = {};
    if (selector) {
      try {
        out.selector = Boolean(document.querySelector(selector));
      } catch (e) {
        throw new Error(`bad selector ${selector}: ${e.message}`);
      }
    }
    if (text) out.text = (document.body?.innerText || '').includes(text);
    return out;
  },
};

/* The code background.js injects into a frame: re-check that the frame still
 * shows the host the caller checked, define ctx, then run PAGE[name] on JSON
 * args. A navigation that commits between the check and the injection meets
 * a refusal, not the new page. args are JSON text, a literal: data, never
 * code. Only PAGE's own functions are injected; this file has none that runs
 * a session's code (the personal build's scripts.js adds those to PAGE). */
function pageScript(name, args, host) {
  if (name === 'ctx' || !Object.hasOwn(PAGE, name)) throw new Error(`no page function ${name} in this build`);
  const source = (fn) => {
    const s = fn.toString();
    return s.startsWith('async ') ? `async function ${s.slice(6)}` : `function ${s}`;
  };
  return `(() => { if (location.hostname !== ${JSON.stringify(host)}) throw new Error('the page changed before the action ran; snapshot again'); `
    + `const ctx = ${source(PAGE.ctx)}; `
    + `return (${source(PAGE[name])})(${JSON.stringify(args)}); })()`;
}

if (typeof module !== 'undefined') module.exports = { PAGE, pageScript };
