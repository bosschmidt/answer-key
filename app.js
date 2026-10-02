// Answer Key: shows one book solution at a time. No framework, no build step.
// Rule: an answer is put into the DOM only when it is revealed, and removed when the screen changes.

import * as store from './store.js';
import { deriveBits, importKey, decrypt, keyFits } from './crypto.js';

const root = document.getElementById('app');
const SERIES_ORDER = ['Steps', 'Yusupov'];
const state = {
  key: null,        // AES key, or null until the passphrase is entered
  local: {},        // books on this device: id -> {title, series, order, unit, version, answers}
  book: null,       // the open book: {id, version, book}
  shown: null,      // the route now on screen
  overviewY: null,  // where the overview was scrolled when it was left: {book, y}
  exerciseFrom: '', // the screen an exercise was opened from, e.g. 'overview:steps-5'
  afterMount: null, // set by a screen that places the scroll itself
  reloadPending: false,
  toast: '',
};

// ---------- small helpers ----------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'onclick') el.addEventListener('click', v);
    else if (k === 'class') el.className = v;
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...children.filter(c => c != null && c !== false));
  return el;
}

function stamp(d = new Date()) {
  const p = n => String(Math.abs(n)).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${off >= 0 ? '+' : '-'}${p(Math.trunc(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
}

const abbr = unit => (unit === 'chapter' ? 'ch.' : 'p.');

function go(hash, replace = false) {
  if (replace) location.replace(hash);
  else location.hash = hash;
}

function toast(text) {
  state.toast = text;
  const old = document.querySelector('.toast');
  if (old) old.remove();
  if (!text) return;
  const el = h('div', { class: 'toast', role: 'status' }, text);
  document.body.append(el);
  setTimeout(() => el.remove(), 5000);
}

// Book text -> DOM. Only <b>, <i>, line breaks and the book's own PNG pictures are allowed.
function renderText(text) {
  const frag = document.createDocumentFragment();
  const stack = [frag];
  const re = /<(\/?)(b|i)>|<img src="(data:image\/png;base64,[A-Za-z0-9+/=]+)">|(\n)|&(amp|lt|gt);|[^<\n&]+|[<&]/g;
  const entity = { amp: '&', lt: '<', gt: '>' };
  for (const m of text.matchAll(re)) {
    const top = stack[stack.length - 1];
    if (m[2] && !m[1]) {
      const el = document.createElement(m[2]);
      top.append(el);
      stack.push(el);
    } else if (m[2]) {
      if (stack.length > 1) stack.pop();
    } else if (m[3]) {
      const img = document.createElement('img');
      img.src = m[3];
      img.alt = 'picture from the book';
      top.append(img);
    } else if (m[4]) {
      top.append(document.createElement('br'));
    } else {
      top.append(m[5] ? entity[m[5]] : m[0]);
    }
  }
  return frag;
}

// ---------- key, updates ----------

async function loadKey() {
  const saved = await store.get('kv', 'key');
  if (!saved) return null;
  return saved instanceof CryptoKey ? saved : importKey(saved);
}

async function saveKey(raw) {
  const key = await importKey(raw);
  try {
    await store.put('kv', key, 'key');      // stored as a key object that cannot be read back out
  } catch {
    await store.put('kv', raw, 'key');      // browsers that cannot store key objects
  }
  return key;
}

async function fetchIndex() {
  const res = await fetch(`data/index.json?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const index = await res.json();
  await store.put('kv', index, 'index');
  return index;
}

// Download new or changed books. Returns {error} | {needPassphrase} | {changed: [...], failed: [...]}.
async function update() {
  let index;
  try {
    index = await fetchIndex();
  } catch {
    return { error: 'Could not reach the site.' };
  }
  if (!state.key || !(await keyFits(state.key, index))) return { needPassphrase: true };
  const local = { ...state.local };
  const changed = [];
  const failed = [];
  for (const b of index.books) {
    const meta = { title: b.title, series: b.series, order: b.order, unit: b.unit };
    if (local[b.id] && local[b.id].version === b.version) {
      local[b.id] = { ...local[b.id], ...meta };
      continue;
    }
    try {
      const res = await fetch(`${b.file}?v=${b.version}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const plain = await decrypt(state.key, await res.arrayBuffer(), b.id);
      const book = JSON.parse(new TextDecoder().decode(plain));
      const answers = book.units.reduce((sum, u) => sum + u.items.length, 0);
      await store.put('books', { id: b.id, version: b.version, book });
      local[b.id] = { ...meta, version: b.version, answers, units: book.units.length };
      if (state.book && state.book.id === b.id) state.book = null;
      changed.push(`${b.title}: ${answers} answers`);
    } catch {
      failed.push(b.title);
    }
  }
  for (const id of Object.keys(local)) {
    if (!index.books.some(b => b.id === id)) {
      delete local[id];
      await store.del('books', id);
    }
  }
  state.local = local;
  await store.put('kv', local, 'local');
  return { changed, failed };
}

async function updateOnOpen() {
  if (!navigator.onLine) return;
  const result = await update();
  if (result.changed && result.changed.length) {
    toast(`Updated. ${result.changed.join('. ')}.`);
    if (parse().view === 'books') route();
  }
}

// ---------- routing ----------

function parse() {
  const p = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (p[0] === 'settings') return { view: 'settings' };
  if (p[0] === 'pass') return { view: 'pass' };
  if (p[0] === 'b' && p[1]) {
    if (p[2] === 'redo') return p[4] ? { view: 'exercise', id: p[1], unit: +p[3], n: +p[4], redo: true } : { view: 'redo', id: p[1] };
    if (p[2] === 'u' && p[4]) return { view: 'exercise', id: p[1], unit: +p[3], n: +p[4], redo: false };
    return { view: 'overview', id: p[1], unit: p[2] === 'u' && p[3] ? +p[3] : null };
  }
  return { view: 'books' };
}

async function openBook(id) {
  if (!state.book || state.book.id !== id) state.book = (await store.get('books', id)) || null;
  return state.book && state.local[id] ? state.book.book : null;
}

async function route() {
  if (state.reloadPending) return location.reload();      // a new app version is waiting
  const r = parse();
  const from = state.shown;
  if (from && from.view === 'overview') state.overviewY = { book: from.id, y: window.scrollY };
  if (r.view === 'exercise' && !(from && from.view === 'exercise')) state.exerciseFrom = from ? `${from.view}:${from.id}` : '';
  state.afterMount = null;
  let screen;
  if (r.view === 'settings') screen = await settingsScreen();
  else if (r.view === 'pass') screen = passScreen();
  else if (r.view === 'books') screen = await booksScreen();
  else {
    const book = await openBook(r.id);
    if (!book) return go('#/', true);
    if (r.view === 'overview') screen = await overviewScreen(book, r);
    else if (r.view === 'redo') screen = await redoScreen(book);
    else screen = await exerciseScreen(book, r);
    if (!screen) return go(`#/b/${r.id}`, true);
  }
  root.replaceChildren(...screen);      // the previous screen, and any answer on it, leaves the DOM here
  state.shown = r;
  if (state.afterMount) state.afterMount();
  else window.scrollTo(0, 0);
}

// ---------- screens ----------

async function booksScreen() {
  const ids = Object.keys(state.local);
  const last = await store.get('kv', 'last');
  const main = h('main', { class: 'main' });
  if (!state.key) {
    main.append(h('div', { class: 'card' },
      h('p', {}, ids.length ? 'Enter the passphrase to get updates.' : 'Enter the passphrase to download the books. You need to be online once.'),
      h('button', { class: 'btn primary', onclick: () => go('#/pass') }, 'Enter passphrase')));
  }
  if (last && state.local[last.book]) {
    const m = state.local[last.book];
    const where = `${abbr(m.unit)} ${last.unit}` + (last.n ? ` · #${last.n}` : '');
    main.append(h('h2', {}, 'Last used'),
      h('button', { class: 'btn book primary', onclick: () => { state.overviewY = null; go(last.n ? `#/b/${last.book}/u/${last.unit}/${last.n}` : `#/b/${last.book}`); } },
        h('span', { class: 'book-title' }, m.title), h('span', { class: 'book-sub' }, `Continue at ${where}`)));
  }
  const series = [...new Set(ids.map(id => state.local[id].series))]
    .sort((a, b) => (SERIES_ORDER.indexOf(a) + 1 || 99) - (SERIES_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b));
  for (const s of series) {
    main.append(h('h2', {}, s));
    for (const id of ids.filter(i => state.local[i].series === s).sort((a, b) => state.local[a].order - state.local[b].order)) {
      const m = state.local[id];
      main.append(h('button', { class: 'btn book', onclick: () => { state.overviewY = null; go(`#/b/${id}`); } },
        h('span', { class: 'book-title' }, m.title),
        h('span', { class: 'book-sub' }, `${m.units} ${m.unit}${m.units === 1 ? '' : 's'} · ${m.answers} answers`)));
    }
  }
  if (!ids.length && state.key) main.append(h('p', { class: 'muted' }, 'No books yet. Go online and check for updates in Settings.'));
  return [
    h('header', { class: 'top' }, h('h1', {}, 'Answer Key'),
      h('button', { class: 'link', onclick: () => go('#/settings') }, 'Settings')),
    main,
  ];
}

function resultClass(r) {
  if (!r) return '';
  return r.right ? (r.sure ? 'right' : 'unsure') : 'wrong';
}

const needsRedo = r => !(r.right && r.sure);

// The last book, unit and exercise.
async function remember(book, unit, n) {
  const pos = (await store.get('kv', 'pos')) || {};
  pos[book] = { unit, n };
  await store.put('kv', pos, 'pos');
  await store.put('kv', { book, unit, n }, 'last');
}

async function redoList(id) {
  return (await store.byBook('results', id)).filter(needsRedo).sort((a, b) => a.unit - b.unit || a.n - b.n);
}

// Header and tabs shared by a book's Overview and Redo screens.
function bookTop(book, active, redoCount, tools) {
  const tab = (name, label, hash) => h('button', {
    class: `tab${active === name ? ' on' : ''}`, role: 'tab', 'aria-selected': String(active === name),
    onclick: () => { if (active !== name) go(hash, true); },
  }, label);
  return [
    h('header', { class: 'top' },
      h('button', { class: 'link', onclick: () => go('#/', true) }, '‹ Books'),
      h('span', { class: 'top-title end' }, state.local[book.id].title)),
    h('div', { class: 'bar' },
      h('div', { class: 'tabs', role: 'tablist' },
        tab('overview', 'Overview', `#/b/${book.id}`), tab('redo', `Redo (${redoCount})`, `#/b/${book.id}/redo`)),
      ...(tools || [])),
  ];
}

const RESULT_WORDS = { '': 'not tried', right: 'right and sure', unsure: 'right but unsure', wrong: 'wrong' };

// Every unit of the book with one button per exercise. Numbers and titles only: no answer text is rendered here.
async function overviewScreen(book, r) {
  const word = state.local[book.id].unit;
  const results = new Map((await store.byBook('results', book.id)).map(x => [x.key, x]));
  const flags = new Set((await store.all('flags')).filter(f => f.book === book.id).map(f => f.key));
  const pos = ((await store.get('kv', 'pos')) || {})[book.id];
  const redoCount = [...results.values()].filter(needsRedo).length;
  const blocks = new Map();

  const main = h('main', { class: 'main overview' },
    h('p', { class: 'legend' },
      h('span', {}, h('span', { class: 'dot right' }), ' right'),
      h('span', {}, h('span', { class: 'dot unsure' }), ' unsure'),
      h('span', {}, h('span', { class: 'dot wrong' }), ' wrong'),
      h('span', {}, h('span', { class: 'flagmark' }), ' flagged')));
  for (const unit of book.units) {
    const head = h('div', { class: 'block-head' },
      h('h3', {}, `${abbr(word)} ${unit.number}` + (unit.title ? ` · ${unit.title}` : '')));
    const note = h('p', { class: 'note', hidden: true });
    if (unit.note) {
      const btn = h('button', { class: 'link note-btn', 'aria-expanded': 'false' }, 'Note');
      btn.addEventListener('click', () => {
        if (!note.hasChildNodes()) note.append(renderText(unit.note));
        note.hidden = !note.hidden;
        btn.setAttribute('aria-expanded', String(!note.hidden));
      });
      head.append(btn);
    }
    const grid = h('div', { class: 'grid' });
    for (const it of unit.items) {
      const key = store.exerciseKey(book.id, unit.number, it.n);
      const res = resultClass(results.get(key));
      const flagged = flags.has(key);
      const last = !!pos && pos.unit === unit.number && pos.n === it.n;
      grid.append(h('button', {
        class: `btn ex ${res}${flagged ? ' flagged' : ''}${last ? ' last' : ''}`,
        'aria-label': `${abbr(word)} ${unit.number} exercise ${it.n}, ${RESULT_WORDS[res]}${flagged ? ', flagged' : ''}${last ? ', used last' : ''}`,
        onclick: () => go(`#/b/${book.id}/u/${unit.number}/${it.n}`),
      }, String(it.n), h('span', { class: `dot ${res}` })));
    }
    const block = h('section', { class: 'block' }, head, note, grid);
    blocks.set(unit.number, block);
    main.append(block);
  }

  // "Go to page": scrolls to the page as it is typed.
  const status = h('span', { class: 'goto-status', role: 'status' });
  const input = h('input', { type: 'text', id: 'goto', inputmode: 'numeric', pattern: '[0-9]*', maxlength: '3',
    autocomplete: 'off', placeholder: `Go to ${word}`, 'aria-label': `Go to ${word}` });
  input.addEventListener('input', () => {
    const digits = input.value.replace(/\D/g, '');
    if (digits !== input.value) input.value = digits;
    status.textContent = '';
    if (!digits) return;
    const block = blocks.get(+digits);
    if (block) block.scrollIntoView({ block: 'start' });
    else status.textContent = `No ${word} ${+digits} in this book.`;
  });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); });

  state.afterMount = () => {
    const saved = state.overviewY;
    if (r.unit != null) history.replaceState(null, '', `#/b/${book.id}`);       // old-style link to one page: use it once
    if (r.unit != null && blocks.has(r.unit)) blocks.get(r.unit).scrollIntoView({ block: 'start' });
    else if (saved && saved.book === book.id) window.scrollTo(0, saved.y);        // back from an exercise
    else if (pos && blocks.has(pos.unit)) blocks.get(pos.unit).scrollIntoView({ block: 'start' });   // opened: the page used last
    else window.scrollTo(0, 0);
  };
  return [...bookTop(book, 'overview', redoCount, [input, status]), main];
}

function nextInBook(book, unitNumber, n) {
  const ui = book.units.findIndex(u => u.number === unitNumber);
  const later = book.units[ui].items.find(it => it.n > n);
  if (later) return { unit: unitNumber, n: later.n };
  for (const u of book.units.slice(ui + 1)) {
    if (u.items.length) return { unit: u.number, n: u.items[0].n };
  }
  return null;
}

async function exerciseScreen(book, r) {
  const meta = state.local[book.id];
  const unit = book.units.find(u => u.number === r.unit);
  const item = unit && unit.items.find(it => it.n === r.n);
  if (!item) return null;
  const base = `#/b/${book.id}`;
  await remember(book.id, unit.number, item.n);

  const flagKey = store.exerciseKey(book.id, unit.number, item.n);
  let flagged = !!(await store.get('flags', flagKey));
  const flagBtn = h('button', { class: 'link flag', onclick: toggleFlag });
  const paintFlag = () => { flagBtn.textContent = flagged ? 'Flagged ✓' : 'Flag'; flagBtn.classList.toggle('on', flagged); };
  async function toggleFlag() {
    flagged = !flagged;
    if (flagged) await store.put('flags', { key: flagKey, book: book.id, unit: unit.number, n: item.n, version: state.book.version, at: stamp() });
    else await store.del('flags', flagKey);
    paintFlag();
  }
  paintFlag();

  const answer = h('div', { class: 'answer', 'aria-live': 'polite' });
  const buttons = h('div', { class: 'pair' });
  let sure = null;
  let armedAt = 0;

  function reveal(isSure) {
    sure = isSure;
    answer.replaceChildren(renderText(item.answer));      // the only place an answer enters the DOM
    answer.classList.add('shown');
    armedAt = Date.now() + 400;                             // a second tap in the same spot must not mark it
    buttons.replaceChildren(
      h('button', { class: 'btn big right', onclick: () => mark(true) }, 'Right'),
      h('button', { class: 'btn big wrong', onclick: () => mark(false) }, 'Wrong'));
  }

  async function mark(right) {
    if (Date.now() < armedAt) return;
    armedAt = Infinity;
    await store.logAttempt(book.id, unit.number, item.n, sure, right, stamp());
    if (r.redo) {
      const list = await redoList(book.id);
      const next = list.find(x => x.unit > unit.number || (x.unit === unit.number && x.n > item.n));
      return go(next ? `${base}/redo/${next.unit}/${next.n}` : `${base}/redo`, true);
    }
    const next = nextInBook(book, unit.number, item.n);
    if (!next) {
      toast('That was the last exercise in this book.');
      return go(base, true);
    }
    go(`${base}/u/${next.unit}/${next.n}`, true);
  }

  // Back to the screen this exercise was opened from, without leaving a second copy of it in the history.
  function back() {
    if (state.exerciseFrom === `${r.redo ? 'redo' : 'overview'}:${book.id}`) history.back();
    else go(r.redo ? `${base}/redo` : base, true);
  }

  buttons.append(
    h('button', { class: 'btn big', onclick: () => reveal(true) }, 'Sure'),
    h('button', { class: 'btn big', onclick: () => reveal(false) }, 'Unsure'));

  const head = `${meta.title} · ${abbr(meta.unit)} ${unit.number} · #${item.n}` + (unit.title ? ` · ${unit.title}` : '');
  return [
    h('header', { class: 'top' },
      h('button', { class: 'link', onclick: back }, r.redo ? '‹ Redo' : '‹ Overview'),
      flagBtn),
    h('main', { class: 'main' }, h('p', { class: 'exercise-head' }, head), answer),
    h('footer', { class: 'bottom' }, buttons),
  ];
}

async function redoScreen(book) {
  const meta = state.local[book.id];
  const list = await redoList(book.id);
  const main = h('main', { class: 'main' });
  if (!list.length) main.append(h('p', { class: 'muted' }, 'Nothing to redo in this book.'));
  for (const x of list) {
    const unit = book.units.find(u => u.number === x.unit);
    main.append(h('button', { class: 'btn row', onclick: () => go(`#/b/${book.id}/redo/${x.unit}/${x.n}`) },
      h('span', { class: `dot ${resultClass(x)}` }),
      h('span', {}, `${abbr(meta.unit)} ${x.unit} · #${x.n}` + (unit && unit.title ? ` · ${unit.title}` : ''))));
  }
  return [...bookTop(book, 'redo', list.length), main];
}

async function exportLog() {
  const data = { app: 'answer-key', exported: stamp(), device: navigator.userAgent,
    attempts: await store.all('attempts'), flags: await store.all('flags') };
  const name = `answer-key-log-${stamp().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')}.txt`;
  const file = new File([JSON.stringify(data, null, 1)], name, { type: 'text/plain' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Answer Key log' });
      return 'Shared.';
    } catch (e) {
      if (e.name === 'AbortError') return 'Cancelled.';
    }
  }
  const url = URL.createObjectURL(file);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return `Saved as ${name}.`;
}

async function settingsScreen() {
  const attempts = (await store.all('attempts')).length;
  const flags = (await store.all('flags')).length;
  const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false;
  const caches_ = 'caches' in window ? (await caches.keys()).filter(k => k.startsWith('answer-key-')) : [];
  const updateStatus = h('p', { class: 'muted', role: 'status' });
  const exportStatus = h('p', { class: 'muted', role: 'status' });

  async function check() {
    updateStatus.textContent = 'Checking…';
    const result = await update();
    if (result.error) updateStatus.textContent = result.error;
    else if (result.needPassphrase) updateStatus.textContent = 'Enter the passphrase first.';
    else {
      updateStatus.textContent = (result.changed.length ? `Updated. ${result.changed.join('. ')}.` : 'Everything is up to date.') +
        (result.failed.length ? ` Failed: ${result.failed.join(', ')}.` : '');
    }
  }

  return [
    h('header', { class: 'top' },
      h('button', { class: 'link', onclick: () => go('#/', true) }, '‹ Books'),
      h('span', { class: 'top-title' }, 'Settings')),
    h('main', { class: 'main' },
      h('h2', {}, 'Passphrase'),
      h('p', { class: 'muted' }, state.key ? 'Set on this device.' : 'Not set.'),
      h('button', { class: 'btn', onclick: () => go('#/pass') }, state.key ? 'Change passphrase' : 'Enter passphrase'),
      h('h2', {}, 'Books'),
      h('button', { class: 'btn', onclick: check }, 'Check for updates'),
      updateStatus,
      h('h2', {}, 'Log'),
      h('p', { class: 'muted' }, `${attempts} attempt${attempts === 1 ? '' : 's'}, ${flags} flagged answer${flags === 1 ? '' : 's'}.`),
      h('button', { class: 'btn', onclick: async () => { exportStatus.textContent = await exportLog(); } }, 'Export log'),
      exportStatus,
      h('p', { class: 'muted small' },
        `App ${caches_.map(k => k.replace('answer-key-', '')).join(', ') || 'not cached yet'}. ` +
        `Storage ${persisted ? 'is protected' : 'is not protected'} from automatic clearing.`)),
  ];
}

function passScreen() {
  const input = h('input', { type: 'password', id: 'pass', autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false' });
  const show = h('input', { type: 'checkbox', id: 'show' });
  show.addEventListener('change', () => { input.type = show.checked ? 'text' : 'password'; });
  const status = h('p', { class: 'muted', role: 'status' });
  const save = h('button', { class: 'btn big primary', type: 'submit' }, 'Save');

  async function submit(e) {
    e.preventDefault();
    if (!input.value.trim()) return;
    save.disabled = true;
    status.textContent = 'Checking…';
    try {
      let index;
      try {
        index = await fetchIndex();
      } catch {
        index = await store.get('kv', 'index');
      }
      if (!index) throw new Error('You need to be online to set the passphrase.');
      const raw = await deriveBits(input.value, index.kdf);
      const key = await importKey(raw);
      if (!(await keyFits(key, index))) throw new Error('Wrong passphrase.');
      state.key = await saveKey(raw);
      if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
      status.textContent = 'Downloading books…';
      const result = await update();
      if (result.changed && result.changed.length) toast(`Downloaded. ${result.changed.join('. ')}.`);
      go('#/', true);
    } catch (err) {
      status.textContent = err.message;
      save.disabled = false;
    }
  }

  const form = h('form', { class: 'main' },
    h('label', { for: 'pass' }, 'Passphrase'), input,
    h('label', { class: 'check' }, show, ' Show what I type'),
    status, save);
  form.addEventListener('submit', submit);
  return [
    h('header', { class: 'top' },
      h('button', { class: 'link', onclick: () => go('#/', true) }, '‹ Books'),
      h('span', { class: 'top-title' }, 'Passphrase')),
    form,
  ];
}

// ---------- start ----------

async function start() {
  state.key = await loadKey();
  state.local = (await store.get('kv', 'local')) || {};
  window.addEventListener('hashchange', route);
  history.scrollRestoration = 'manual';
  await route();
  if ('serviceWorker' in navigator) {
    // When a new service worker takes over, the files on screen are old: reload, but not over an open answer.
    const hadWorker = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadWorker) return;                               // first install, nothing to replace
      if (document.querySelector('.answer.shown')) state.reloadPending = true;
      else location.reload();
    });
    navigator.serviceWorker.register('sw.js');
  }
  updateOnOpen();
  // An installed app is often resumed, not reloaded: look for a new app version and new books then too.
  let checked = Date.now();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || Date.now() - checked < 10 * 60 * 1000) return;
    checked = Date.now();
    if ('serviceWorker' in navigator) navigator.serviceWorker.getRegistration().then(reg => reg && reg.update()).catch(() => {});
    updateOnOpen();
  });
}

start();
