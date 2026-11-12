// Shared by the confirm tab and the toolbar popup. Everything is built with
// createElement and textContent: labels and profile names come from outside.
const $ = (id) => document.getElementById(id);
// An Allow stays disabled this long after it appears, so a click meant for
// whatever was under the pointer before grants nothing.
const ARM_MS = 1200;
// A countdown at or under this many seconds shows in the warning colour.
const LOW_S = 30;
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
};

// "559 175" -> six digit tiles in two triplets. Screen readers get the code
// once, from the container's label, not six separate digits.
function renderTiles(box, code) {
  box.replaceChildren(...[...code].map((ch) =>
    ch === ' ' ? el('span', { className: 'gap' }) : el('span', { className: 'tile', textContent: ch })));
  for (const c of box.children) c.setAttribute('aria-hidden', 'true');
  box.setAttribute('aria-label', `Code ${code}`);
}

// "acme · ec7b" -> "acme" and a quieter "· ec7b".
function renderLabel(node, label) {
  const i = label.lastIndexOf(' · ');
  if (i < 0) { node.textContent = label; return; }
  node.replaceChildren(label.slice(0, i), el('span', { className: 'quiet', textContent: label.slice(i) }));
}

// A remembered approval as one list row: what it covers, as machine text. A
// function is its origin and the start of its code's hash.
function approvalRow(e, ...extra) {
  const what = e.kind === 'site' ? [el('span', { className: 'mono', textContent: e.site })]
    : [el('span', { className: 'mono', textContent: e.origin.replace(/^https:\/\//, '') }),
      el('span', { className: 'mono quiet', textContent: e.sha256.slice(0, 8) })];
  return el('li', {}, el('span', { className: 'kind', textContent: e.kind === 'site' ? 'site' : 'function' }),
    el('span', { className: 'what' }, ...what), ...extra);
}
