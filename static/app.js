// Faaglarna frontend.

const state = {
  currentPath: null,
  mtime: 0,
  dirty: false,
  mode: 'view',     // view | split (initialized from prefs below)
  tokens: [],
  titlePage: {},
  characters: [],   // names seen, in order of first appearance
  rendering: false,
  scrollSyncing: false,
  openTabs: [],     // ordered list of paths
  tabState: {},     // path -> { content, mtime, dirty }
};

// ---------- persisted prefs ----------
const PREFS_KEY = 'screenplay-reader-prefs-v1';
function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch { return {}; }
}
function savePrefs(p) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch {}
}
function getBookmarks() { return loadPrefs().bookmarks || []; }
function setBookmarks(arr) { const p = loadPrefs(); p.bookmarks = arr; savePrefs(p); }
function getScrollFor(path, pane) {
  // pane = 'view' (default) | 'source'. Backwards compat: legacy entries
  // were stored as plain numbers (view scroll only); accept those too.
  const entry = (loadPrefs().scroll || {})[path];
  if (entry == null) return 0;
  if (typeof entry === 'number') return pane === 'source' ? 0 : entry;
  return entry[pane || 'view'] || 0;
}
function setScrollFor(path, y, pane) {
  const p = loadPrefs();
  p.scroll = p.scroll || {};
  const cur = p.scroll[path];
  const entry = (cur && typeof cur === 'object') ? cur : { view: typeof cur === 'number' ? cur : 0, source: 0 };
  entry[pane || 'view'] = y;
  p.scroll[path] = entry;
  savePrefs(p);
}
function getMode() {
  const m = loadPrefs().mode;
  return (m === 'split' || m === 'view') ? m : 'view';
}
function setStoredMode(m) { const p = loadPrefs(); p.mode = m; savePrefs(p); }
function getLastOpen() { return loadPrefs().lastOpen; }
function setLastOpen(path) { const p = loadPrefs(); p.lastOpen = path; savePrefs(p); }
function getTheme() { return loadPrefs().theme || 'paper'; }
function setTheme(t) { const p = loadPrefs(); p.theme = t; savePrefs(p); applyTheme(t); }
function getSidebarOpen() { return loadPrefs().sidebarOpen !== false; }
function setSidebarOpen(v) { const p = loadPrefs(); p.sidebarOpen = v; savePrefs(p); applySidebar(v); }

function applyTheme(t) {
  for (const cls of [...document.body.classList]) {
    if (cls.startsWith('theme-')) document.body.classList.remove(cls);
  }
  document.body.classList.add('theme-' + t);
}

const ZOOM_MIN = 0.6, ZOOM_MAX = 2.5, ZOOM_STEP = 0.1;
function getZoom() {
  const v = parseFloat(loadPrefs().zoom);
  return Number.isFinite(v) ? v : 1;
}
function setZoom(v) {
  v = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(v * 100) / 100));
  const p = loadPrefs(); p.zoom = v; savePrefs(p);
  applyZoom(v);
  return v;
}
function applyZoom(v) {
  document.documentElement.style.setProperty('--zoom', String(v));
}
function zoomIn()    { const v = setZoom(getZoom() + ZOOM_STEP); status(`Zoom ${Math.round(v * 100)}%`); }
function zoomOut()   { const v = setZoom(getZoom() - ZOOM_STEP); status(`Zoom ${Math.round(v * 100)}%`); }
function zoomReset() { setZoom(1); status('Zoom 100%'); }

const UI_MIN = 0.8, UI_MAX = 1.6;
function getUiScale() {
  const v = parseFloat(loadPrefs().uiScale);
  return Number.isFinite(v) ? v : 1;
}
function setUiScale(v) {
  v = Math.max(UI_MIN, Math.min(UI_MAX, Math.round(v * 100) / 100));
  const p = loadPrefs(); p.uiScale = v; savePrefs(p);
  applyUiScale(v);
  return v;
}
function applyUiScale(v) {
  document.documentElement.style.setProperty('--ui-scale', String(v));
}
function applySidebar(open) {
  document.body.classList.toggle('sidebar-collapsed', !open);
}
function toggleSidebar() { setSidebarOpen(!getSidebarOpen()); }

const $ = (id) => document.getElementById(id);

// ---------- tree ----------
async function loadTree() {
  const res = await fetch('/api/tree');
  const { tree } = await res.json();
  const root = $('tree');
  root.innerHTML = '';
  root.appendChild(renderTree(tree));
}
function renderTree(entries) {
  const ul = document.createElement('ul');
  ul.className = 'tree-list';
  for (const e of entries) {
    const li = document.createElement('li');
    if (e.type === 'dir') {
      const label = document.createElement('div');
      label.className = 'tree-dir';
      label.textContent = e.name;
      li.appendChild(label);
      li.appendChild(renderTree(e.children || []));
    } else {
      const a = document.createElement('a');
      a.className = 'tree-file';
      a.textContent = e.name;
      a.dataset.path = e.path;
      a.href = '#' + encodeURIComponent(e.path);
      a.onclick = (ev) => { ev.preventDefault(); openScript(e.path); };
      li.appendChild(a);
    }
    ul.appendChild(li);
  }
  return ul;
}
function highlightTreeSelection() {
  for (const a of document.querySelectorAll('.tree-file')) {
    a.classList.toggle('active', a.dataset.path === state.currentPath);
  }
}

// ---------- open / save ----------
async function openScript(path) {
  // Stash current tab state and scroll positions before switching.
  if (state.currentPath) {
    const view = document.querySelector('.pane-view');
    if (view) setScrollFor(state.currentPath, view.scrollTop, 'view');
    setScrollFor(state.currentPath, $('editor').scrollTop, 'source');
    state.tabState[state.currentPath] = {
      content: $('editor').value,
      mtime: state.mtime,
      dirty: state.dirty,
    };
  }
  // Load fresh if not already cached as an open tab.
  let content, mtime;
  if (state.tabState[path]) {
    ({ content, mtime } = state.tabState[path]);
  } else {
    const res = await fetch('/api/file?path=' + encodeURIComponent(path));
    if (!res.ok) { status('Failed to load', true); return; }
    ({ content, mtime } = await res.json());
    state.tabState[path] = { content, mtime, dirty: false };
  }
  if (!state.openTabs.includes(path)) state.openTabs.push(path);

  state.currentPath = path;
  state.mtime = mtime;
  state.dirty = !!state.tabState[path].dirty;
  $('crumbs').textContent = path;
  $('editor').value = content;
  enableActions(true);
  state._pageCache = null;   // don't reuse the previous document's page nodes
  render(content);
  histReset();   // undo history is per-document; start fresh on open
  location.hash = encodeURIComponent(path);
  highlightTreeSelection();
  setLastOpen(path);
  requestAnimationFrame(() => {
    const view = document.querySelector('.pane-view');
    if (view) view.scrollTop = getScrollFor(path, 'view');
    $('editor').scrollTop = getScrollFor(path, 'source');
  });
  status('Opened ' + path);
  renderBookmarksPanel();
  renderTabs();
}

function renderTabs() {
  const strip = $('tabs');
  if (state.openTabs.length <= 1) { strip.classList.add('hidden'); strip.innerHTML = ''; return; }
  strip.classList.remove('hidden');
  strip.innerHTML = '';
  for (const path of state.openTabs) {
    const t = document.createElement('div');
    t.className = 'tab' + (path === state.currentPath ? ' active' : '');
    const dirty = state.tabState[path]?.dirty ? ' •' : '';
    t.innerHTML = `<span class="tab-name" title="${escapeHtml(path)}">${escapeHtml(path.split('/').pop())}${dirty}</span><button class="tab-close" title="Close">×</button>`;
    t.onclick = (ev) => {
      if (ev.target.classList.contains('tab-close')) return;
      if (path !== state.currentPath) openScript(path);
    };
    t.querySelector('.tab-close').onclick = (ev) => { ev.stopPropagation(); closeTab(path); };
    strip.appendChild(t);
  }
}

async function closeTab(path) {
  const t = state.tabState[path];
  if (t && t.dirty && !confirm(`Close ${path} without saving?`)) return;
  delete state.tabState[path];
  state.openTabs = state.openTabs.filter(p => p !== path);
  if (state.currentPath === path) {
    if (state.openTabs.length > 0) {
      openScript(state.openTabs[state.openTabs.length - 1]);
    } else {
      state.currentPath = null;
      $('editor').value = '';
      histReset();
      $('view').innerHTML = '';
      $('crumbs').textContent = 'No script selected';
      enableActions(false);
    }
  }
  renderTabs();
}

let autoSaveTimer = null;
let saveInFlight = false;
const AUTO_SAVE_MS = 1500;

async function saveScript(opts = {}) {
  if (!state.currentPath) return;
  if (saveInFlight) return;             // a save is in progress; coalesce
  if (!state.dirty && !opts.force) return;
  saveInFlight = true;
  const savingPath = state.currentPath;
  const content = $('editor').value;
  status('Saving…');
  try {
    const res = await fetch('/api/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: savingPath,
        content,
        auto: !!opts.auto,
        force: !!opts.overwrite,
        baseMtime: state.mtime,
      }),
    });
    // The file changed on disk since we loaded it. Don't silently clobber.
    if (res.status === 409) {
      const info = await res.json().catch(() => ({}));
      if (opts.auto) {
        // Never interrupt typing with a dialog — defer to a manual save.
        status('⚠ File changed on disk — press Ctrl+S to resolve', true);
        return;
      }
      const ok = confirm(
        `"${savingPath}" was modified on disk since you opened it ` +
        `(another tab, an external editor, or a restore).\n\n` +
        `OK = overwrite with your version.\nCancel = keep the version on disk (reload).`);
      if (ok) {
        saveInFlight = false;
        return saveScript({ ...opts, overwrite: true });
      }
      // Reload the on-disk version into this tab.
      if (typeof info.disk === 'string' && state.currentPath === savingPath) {
        $('editor').value = info.disk;
        state.mtime = info.mtime || state.mtime;
        state.dirty = false;
        if (state.tabState[savingPath]) {
          state.tabState[savingPath] = { content: info.disk, mtime: state.mtime, dirty: false };
        }
        render(info.disk);
        $('btn-save').disabled = true;
        renderTabs();
      }
      status('Reloaded version from disk', true);
      return;
    }
    if (!res.ok) { status('Save failed', true); return; }
    const { mtime } = await res.json();
    state.mtime = mtime;
    state.dirty = false;
    if (state.tabState[savingPath]) {
      state.tabState[savingPath].dirty = false;
      state.tabState[savingPath].mtime = mtime;
    }
    if (state.currentPath === savingPath) $('btn-save').disabled = true;
    status(opts.auto ? 'Auto-saved' : 'Saved');
    renderTabs();
  } finally {
    saveInFlight = false;
  }
}

function markDirty() {
  state.dirty = true;
  if (state.currentPath && state.tabState[state.currentPath]) {
    state.tabState[state.currentPath].dirty = true;
  }
  $('btn-save').disabled = false;
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => saveScript({ auto: true }), AUTO_SAVE_MS);
  renderTabs();
}

function enableActions(on) {
  for (const id of ['btn-history', 'btn-export', 'btn-export-fdx', 'btn-rename', 'btn-delete']) {
    $(id).disabled = !on;
  }
  $('btn-save').disabled = !on || !state.dirty;
}

// ---------- render (paginated) ----------
//
// Re-rendering rebuilds the page DOM from the parsed source. Parse + paginate
// are cheap (a few ms even for a full play); the cost is constructing the
// hundreds-to-thousands of element nodes. So we cache each page's DOM keyed by
// a signature of everything that affects its rendered output, and reuse the
// node verbatim when that signature is unchanged. The dominant editing
// pattern — typing forward at the end of the script — leaves every page above
// the caret byte-identical, so only the page being edited is rebuilt.

// Signature for one block: every field renderBlock() reads, plus the source
// position it stamps on the node (so a reused node never points at a stale
// source line). tokIdx/srcLine shift only on structural edits (adding/removing
// lines), which is exactly when the node must be rebuilt anyway.
function blockSig(b, showMarkup) {
  const t = (typeof b.tokIdx === 'number') ? state.tokens[b.tokIdx] : null;
  const srcLine = t && typeof t.srcLine === 'number' ? t.srcLine : null;
  const notes = (showMarkup && t && t.notes && t.notes.length) ? t.notes : null;
  const sig = {
    k: b.kind, l: b.lines, i: b.indentIn, a: b.align,
    bo: b.bold, it: b.italic, un: b.underline, c: b.cue, lv: b.level,
    ti: b.tokIdx, sl: srcLine, n: notes,
  };
  if (b.kind === 'dual') {
    sig.L = (b.left || []).map(x => blockSig(x, showMarkup));
    sig.R = (b.right || []).map(x => blockSig(x, showMarkup));
  }
  return sig;
}

function pageSig(page, base, flags, showMarkup) {
  if (page.isTitlePage) {
    return 'T|' + flags + '|' + JSON.stringify(page.titlePage || {});
  }
  return 'P|' + flags + '|' + JSON.stringify(base) + '|' + page.pageNumber + '|' +
    JSON.stringify((page.blocks || []).map(b => blockSig(b, showMarkup)));
}

// Scene/section/synopsis anchors a page contributes — used to advance the
// running counters when a page is reused (and thus not walked block-by-block).
function countPageAnchors(page) {
  const c = { scene: 0, section: 0, synopsis: 0 };
  for (const b of (page.blocks || [])) {
    if (b.kind === 'scene') c.scene++;
    else if (b.kind === 'section') c.section++;
    else if (b.kind === 'synopsis') c.synopsis++;
  }
  return c;
}

function buildBodyPage(page, rules, counters) {
  const pageEl = document.createElement('section');
  pageEl.className = 'page';
  pageEl.dataset.pageNum = page.pageNumber;
  pageEl.style.setProperty('--page-w-ch',  String(rules.pageW  * Pagination.CHARS_PER_INCH));
  pageEl.style.setProperty('--page-h-em',  String(rules.pageH  * Pagination.LINES_PER_INCH));
  pageEl.style.setProperty('--mar-l-ch',   String(rules.left   * Pagination.CHARS_PER_INCH));
  pageEl.style.setProperty('--mar-r-ch',   String(rules.right  * Pagination.CHARS_PER_INCH));
  pageEl.style.setProperty('--mar-t-em',   String(rules.top    * Pagination.LINES_PER_INCH));
  pageEl.style.setProperty('--mar-b-em',   String(rules.bottom * Pagination.LINES_PER_INCH));

  // Page number top-right (skip page 1 by convention; appears from page 2).
  if (page.pageNumber > 1) {
    const num = document.createElement('div');
    num.className = 'page-number';
    num.textContent = page.pageNumber + '.';
    pageEl.appendChild(num);
  }

  const inner = document.createElement('div');
  inner.className = 'page-content';
  for (const b of page.blocks) {
    inner.appendChild(renderBlock(b, counters));
  }
  pageEl.appendChild(inner);
  return pageEl;
}

function render(text) {
  const parsed = Fountain.parse(text);
  state.titlePage = parsed.titlePage;
  state.tokens = parsed.tokens;
  state.characters = collectCharacters(parsed.tokens);

  const paginated = Pagination.paginateScript(parsed);
  state.pages = paginated.pages;
  state.rules = paginated.rules;
  const rules = paginated.rules;

  const view = $('view');
  view.className = 'script format-' + rules.name;
  // Page nodes are cached and reused across renders, so any node we might reuse
  // must be structurally pristine. clearMirror() normally removes selection
  // mirror spans, but a render can land while one is present — unwrap them so a
  // reused node never carries a stale <span class="mirror-sel"> inside it.
  for (const m of view.querySelectorAll('.mirror-sel')) {
    const parent = m.parentNode;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
    parent.normalize();
  }
  // Industry revision colors: tint paper based on title-page `revision:`.
  const REVISION_COLORS = {
    white: '#ffffff', blue: '#d8e6f5', pink: '#f5d8e0',
    yellow: '#fdf6c0', green: '#daeeda', goldenrod: '#f0d99a',
  };
  const rev = (state.titlePage.revision || '').toLowerCase().trim();
  if (rev && REVISION_COLORS[rev]) {
    view.style.setProperty('--paper-tint', REVISION_COLORS[rev]);
  } else {
    view.style.removeProperty('--paper-tint');
  }

  // Track anchor counters across the whole script (not per page) so the
  // outline links (#scene-3, #section-2) stay stable.
  const counters = { scene: 0, section: 0, synopsis: 0 };
  const totalBodyPages = paginated.pages.filter(p => !p.isTitlePage).length;

  // Pool of reusable page nodes from the previous render, keyed by signature.
  const showMarkup = document.body.classList.contains('show-markup');
  const flags = rules.name + (showMarkup ? '|M' : '');
  const pool = new Map();
  for (const e of (state._pageCache || [])) {
    let arr = pool.get(e.sig);
    if (!arr) { arr = []; pool.set(e.sig, arr); }
    arr.push(e.node);
  }

  const frag = document.createDocumentFragment();
  const newCache = [];
  let reused = 0;
  for (const page of paginated.pages) {
    const base = page.isTitlePage ? null
      : { sc: counters.scene, se: counters.section, sy: counters.synopsis };
    const sig = pageSig(page, base, flags, showMarkup);
    const avail = pool.get(sig);
    let node = avail && avail.length ? avail.shift() : null;
    if (node) {
      reused++;
      if (!page.isTitlePage) {
        const a = countPageAnchors(page);
        counters.scene += a.scene; counters.section += a.section; counters.synopsis += a.synopsis;
      }
    } else {
      node = page.isTitlePage
        ? renderTitlePageEl(page.titlePage, rules)
        : buildBodyPage(page, rules, counters);
    }
    frag.appendChild(node);          // moves reused nodes out of #view into frag
    newCache.push({ sig, node });
  }
  // Whatever wasn't reused is still in #view; clearing drops only those.
  view.innerHTML = '';
  view.appendChild(frag);
  state._pageCache = newCache;
  state._renderReused = reused;      // exposed for debugging/measurement

  renderOutline();
  renderCharacterList();
  renderSceneNav();
  state.pageCount = totalBodyPages;
  updateMeta();

  // Apply the current mode (sets contenteditable on the new .page-content nodes).
  setMode(state.mode || 'view');
}

function renderBlock(b, counters) {
  if (b.kind === 'dual') {
    const wrap = document.createElement('div');
    wrap.className = 'elem-dual';
    for (const side of ['left', 'right']) {
      const col = document.createElement('div');
      col.className = 'elem-dual-col elem-dual-' + side;
      for (const sub of (b[side] || [])) col.appendChild(renderBlock(sub, counters));
      wrap.appendChild(col);
    }
    return wrap;
  }
  const el = document.createElement('div');
  el.className = 'elem elem-' + b.kind;
  if (b.indentIn) el.style.marginLeft = (b.indentIn * Pagination.CHARS_PER_INCH).toFixed(2) + 'ch';
  if (b.align && b.align !== 'left') el.style.textAlign = b.align;
  // Color-code character cues.
  if (b.kind === 'character' && b.lines.length) {
    el.style.color = colorForCharacter(b.lines[0]);
    el.dataset.cue = b.lines[0];
  }
  if ((b.kind === 'dialogue' || b.kind === 'parenthetical') && b.cue) {
    el.dataset.cue = b.cue;
  }
  // Anchor IDs and outline navigation.
  if (b.kind === 'scene') {
    counters.scene++;
    el.id = 'scene-' + counters.scene;
    el.dataset.sceneNum = counters.scene;
  }
  if (b.kind === 'section')  { counters.section++;  el.id = 'section-' + counters.section; }
  if (b.kind === 'synopsis') { counters.synopsis++; el.id = 'synopsis-' + counters.synopsis; }
  if (typeof b.tokIdx === 'number') {
    el.dataset.tokIdx = b.tokIdx;
    const tok = state.tokens[b.tokIdx];
    if (tok && typeof tok.srcLine === 'number') el.dataset.srcLine = tok.srcLine;
  }
  const showMarkup = document.body.classList.contains('show-markup');
  const inlineFn = showMarkup ? Fountain.inlineToHtmlVisible : Fountain.inlineToHtml;
  // SFX / MUSIC cues are radio-drama-only formatting on action blocks. The
  // prefix (SFX: / MUSIC: / FX: / SOUND:) appears on the first wrapped line
  // of the block; we promote it to a class on the entire .elem so styling
  // applies to all the wrapped lines, not just the first.
  let lines = b.lines;
  if (b.kind === 'action' && lines.length > 0) {
    const m = /^(SFX|MUSIC|FX|SOUND):\s*(.*)$/i.exec(lines[0]);
    if (m) {
      el.classList.add('cue', 'cue-' + m[1].toLowerCase());
      lines = [m[1].toUpperCase() + ': ' + m[2], ...lines.slice(1)];
    }
  }
  el.innerHTML = lines.map(line => inlineFn(line) || '&nbsp;').join('<br>');
  // Reattach notes when "show markup" is on. We capture them on tokens; the
  // paginated block doesn't carry them, but tokIdx points back to the token.
  if (showMarkup && typeof b.tokIdx === 'number') {
    const tok = state.tokens[b.tokIdx];
    if (tok && tok.notes && tok.notes.length) {
      el.innerHTML += ' ' + tok.notes
        .map(n => `<span class="mk-note">[[${escapeHtml(n)}]]</span>`)
        .join(' ');
    }
  }
  return el;
}

function renderTitlePageEl(tp, rules) {
  const pageEl = document.createElement('section');
  pageEl.className = 'page page-title';
  // The title page is structured (centered title, credit, corner contact, etc.)
  // — free-form contenteditable would be lossy. Clicking opens the form modal.
  pageEl.title = 'Click to edit title page';
  pageEl.addEventListener('click', (ev) => {
    if (state.mode === 'source') return;
    ev.preventDefault();
    openTitlePageEditor();
  });
  pageEl.style.setProperty('--page-w-ch',  String(rules.pageW  * Pagination.CHARS_PER_INCH));
  pageEl.style.setProperty('--page-h-em',  String(rules.pageH  * Pagination.LINES_PER_INCH));
  pageEl.style.setProperty('--mar-l-ch',   String(rules.left   * Pagination.CHARS_PER_INCH));
  pageEl.style.setProperty('--mar-r-ch',   String(rules.right  * Pagination.CHARS_PER_INCH));
  pageEl.style.setProperty('--mar-t-em',   String(rules.top    * Pagination.LINES_PER_INCH));
  pageEl.style.setProperty('--mar-b-em',   String(rules.bottom * Pagination.LINES_PER_INCH));

  const inner = document.createElement('div');
  inner.className = 'title-page';

  const center = document.createElement('div');
  center.className = 'tp-center';
  if (tp.title)  center.appendChild(tpLine('tp-title', tp.title));
  if (tp.credit) center.appendChild(tpLine('tp-credit', tp.credit));
  const author = tp.author || tp.authors;
  if (author)    center.appendChild(tpLine('tp-author', author));
  if (tp.source) center.appendChild(tpLine('tp-source', tp.source));
  inner.appendChild(center);

  const corner = document.createElement('div');
  corner.className = 'tp-corner';
  for (const key of ['contact', 'copyright']) {
    if (tp[key]) corner.appendChild(tpLine('tp-line', tp[key]));
  }
  if (tp.draft_date) corner.appendChild(tpLine('tp-line', tp.draft_date));
  inner.appendChild(corner);

  pageEl.appendChild(inner);
  return pageEl;
}
function tpLine(cls, text) {
  const el = document.createElement('div');
  el.className = cls;
  el.innerHTML = Fountain.inlineToHtml(text).replace(/\n/g, '<br>');
  return el;
}

// Scroll the source textarea so a source line sits at the top of its viewport,
// optionally dropping the caret there (and focusing the textarea when it's
// visible). Wrap-accurate via textareaCaretCoords.
function scrollSourceToLine(srcLine, { caret = false } = {}) {
  const ta = $('editor');
  if (!ta || Number.isNaN(srcLine)) return;
  // The source pane is collapsed (zero width) in page-only view, where its
  // scroll position is meaningless and the wrap-measurement would be garbage.
  if (state.mode !== 'source' && state.mode !== 'split') return;
  const lines = ta.value.split('\n');
  let idx = 0;
  for (let i = 0; i < srcLine && i < lines.length; i++) idx += lines[i].length + 1;
  if (caret) {
    ta.selectionStart = ta.selectionEnd = idx;
    ta.focus();
  }
  const pad = parseFloat(getComputedStyle(ta).paddingTop) || 0;
  ta.scrollTop = Math.max(0, textareaCaretCoords(ta, idx).top - pad);
}

// Jump to a scene/section/synopsis anchor in BOTH panes: scroll the page
// element into view and, via its data-src-line, scroll the source to the same
// line. Used by the outline, the "jump to" dropdown, and the command palette,
// so navigation works whether you're reading the page, the source, or both.
function jumpToTarget(targetId) {
  const el = document.getElementById(targetId);
  if (!el) return;
  state.scrollSyncing = true;   // suppress scroll-sync feedback during the jump
  try {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    scrollSourceToLine(parseInt(el.dataset.srcLine, 10), { caret: true });
  } finally {
    setTimeout(() => { state.scrollSyncing = false; }, 450);
  }
}

function renderSceneNav() {
  const sel = $('scene-nav');
  sel.innerHTML = '<option value="">— jump to —</option>';
  let sceneIdx = 0, sectionIdx = 0;
  for (const t of state.tokens) {
    if (t.type === 'section') {
      sectionIdx++;
      const opt = document.createElement('option');
      opt.value = 'section-' + sectionIdx;
      // Indent sub-sections so hierarchy is visible.
      const indent = '  '.repeat(Math.max(0, (t.level || 1) - 1));
      opt.textContent = `§ ${indent}${t.text}`;
      sel.appendChild(opt);
    } else if (t.type === 'scene') {
      sceneIdx++;
      const opt = document.createElement('option');
      opt.value = 'scene-' + sceneIdx;
      opt.textContent = `${sceneIdx}. ${t.text}`;
      sel.appendChild(opt);
    }
  }
  // If the dropdown has nothing beyond the placeholder, hint why.
  if (sel.options.length === 1) {
    const opt = document.createElement('option');
    opt.disabled = true;
    opt.textContent = '(no scenes or sections)';
    sel.appendChild(opt);
  }
  sel.onchange = () => {
    if (!sel.value) return;
    jumpToTarget(sel.value);
    sel.value = '';
  };
}

function colorForCharacter(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return `hsl(${hue}, 55%, 45%)`;
}

// Count words, Unicode-aware so Norwegian words (blåbær, sølvskinn) count as
// one — a plain \w+ regex would split on æ/ø/å. Apostrophes and hyphens keep
// contractions and compounds together. Shared by the character list, the stats
// panel, and the status bar so every word count agrees.
function countWords(s) {
  return (String(s || '').match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu) || []).length;
}

function collectCharacters(tokens) {
  const seen = new Map();
  const ensure = (name) => {
    if (!seen.has(name)) seen.set(name, { name, count: 0, words: 0 });
    return seen.get(name);
  };
  let current = null;
  for (const t of tokens) {
    if (t.type === 'character') {
      const name = t.text.replace(/\s*\([^)]*\)\s*$/, '').trim();
      current = ensure(name);
      current.count += 1;
    } else if (t.type === 'dialogue' && current) {
      current.words += countWords(t.text);
    }
  }
  return [...seen.values()];
}


function renderOutline() {
  const ul = $('outline');
  ul.innerHTML = '';
  let sceneIdx = 0, sectionIdx = 0, synopsisIdx = 0;
  let sceneOrdinal = 0; // 0-indexed scene position for reorder

  const makeLink = (targetId, text, cls) => {
    const li = document.createElement('li');
    li.className = cls;
    const a = document.createElement('a');
    a.href = '#' + targetId;
    a.textContent = text;
    a.onclick = (ev) => {
      ev.preventDefault();
      jumpToTarget(targetId);
    };
    li.appendChild(a);
    return li;
  };

  state.tokens.forEach((t) => {
    if (t.type === 'section') {
      sectionIdx++;
      ul.appendChild(makeLink('section-' + sectionIdx, t.text, 'ol-section ol-level-' + t.level));
    } else if (t.type === 'scene') {
      sceneIdx++;
      const li = makeLink('scene-' + sceneIdx, t.text, 'ol-scene');
      // Drag-to-reorder.
      const idx = sceneOrdinal++;
      li.draggable = true;
      li.dataset.sceneIdx = idx;
      li.addEventListener('dragstart', (ev) => {
        ev.dataTransfer.setData('text/x-scene-idx', String(idx));
        ev.dataTransfer.effectAllowed = 'move';
        li.classList.add('dragging');
      });
      li.addEventListener('dragend', () => li.classList.remove('dragging'));
      li.addEventListener('dragover', (ev) => { ev.preventDefault(); ev.dataTransfer.dropEffect = 'move'; li.classList.add('drop-above'); });
      li.addEventListener('dragleave', () => li.classList.remove('drop-above'));
      li.addEventListener('drop', (ev) => {
        ev.preventDefault();
        li.classList.remove('drop-above');
        const from = parseInt(ev.dataTransfer.getData('text/x-scene-idx'), 10);
        const to = idx;
        if (isNaN(from) || from === to) return;
        reorderScenes(from, to);
      });
      ul.appendChild(li);
    } else if (t.type === 'synopsis') {
      synopsisIdx++;
      ul.appendChild(makeLink('synopsis-' + synopsisIdx, t.text, 'ol-synopsis'));
    }
  });
}

function reorderScenes(from, to) {
  const text = $('editor').value;
  const { preamble, chunks } = splitBySceneHeading(text);
  if (from < 0 || from >= chunks.length || to < 0 || to >= chunks.length) return;
  const moved = chunks.splice(from, 1)[0];
  chunks.splice(to, 0, moved);
  const newText = preamble +
    (preamble && !preamble.endsWith('\n') ? '\n' : '') +
    chunks.map(c => c.body).join('\n');
  histCommit();
  $('editor').value = newText;
  markDirty();
  scheduleRender();
  histCommit();
  status('Scenes reordered');
}
function renderCharacterList() {
  const ul = $('characters');
  ul.innerHTML = '';
  const sorted = state.characters.slice().sort((a, b) => b.count - a.count);
  for (const c of sorted) {
    const li = document.createElement('li');
    li.className = 'ol-char';
    const color = colorForCharacter(c.name);
    li.title = `${c.count} ${c.count === 1 ? 'cue' : 'cues'} · ${c.words} words`;
    li.innerHTML = `<span class="ch-dot" style="background:${color}"></span>` +
      `<span class="ch-name" style="color:${color}">${escapeHtml(c.name)}</span>` +
      `<span class="ch-count">${c.count}<span class="ch-unit">c</span> · ${c.words}<span class="ch-unit">w</span></span>`;
    ul.appendChild(li);
  }
}
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function updateMeta() {
  const scenes = state.tokens.filter(t => t.type === 'scene').length;
  const chars = state.characters.length;
  const pages = state.pageCount || 0;
  let words = 0;
  for (const t of state.tokens) {
    if (t.type === 'dialogue' || t.type === 'action') {
      words += countWords(t.text);
    }
  }
  $('status-meta').textContent =
    `${pages} pg · ${scenes} sc · ${chars} ch · ${words.toLocaleString()} words`;
}

function status(msg, isError) {
  const el = $('status-msg');
  el.textContent = msg;
  el.style.color = isError ? '#b00020' : '';
  if (!isError) setTimeout(() => { if (el.textContent === msg) el.textContent = 'Ready.'; }, 2000);
}

// ---------- mode switching ----------
// Modes: 'view'  = paginated, WYSIWYG editable (default — industry-standard)
//        'split' = page view + raw source textarea side-by-side
function setMode(mode) {
  if (mode !== 'view' && mode !== 'split' && mode !== 'source') mode = 'view';
  const sameMode = mode === state.mode;

  // Capture the topmost visible element so we can restore scroll after the
  // pane resizes. Only meaningful when actually switching modes.
  let anchor = null;
  if (!sameMode) {
    const pane = document.querySelector('.pane-view');
    if (pane) {
      const paneTop = pane.getBoundingClientRect().top;
      for (const el of pane.querySelectorAll('.elem, .page')) {
        const r = el.getBoundingClientRect();
        if (r.bottom > paneTop + 4) { anchor = el; break; }
      }
    }
  }

  state.mode = mode;
  setStoredMode(mode);
  const c = $('content');
  c.classList.remove('mode-view', 'mode-source', 'mode-split');
  c.classList.add('mode-' + mode);
  // The two buttons are independent pane toggles, so both are lit in split.
  for (const btn of document.querySelectorAll('.mode-switch button')) {
    const pane = btn.dataset.pane;
    btn.classList.toggle('active',
      pane === 'view' ? (mode === 'view' || mode === 'split')
                      : (mode === 'source' || mode === 'split'));
  }
  $('format-toolbar').classList.toggle('hidden', false);

  // The page view is a read-only projection of the source — all editing happens
  // in the source textarea. (It used to be contentEditable, which required a
  // lossy DOM→source round-trip.) The `editable` class is kept only so the
  // title page stays click-to-edit (that opens a modal, not inline editing).
  if (!document.body.classList.contains('perform')) {
    $('view').classList.add('editable');
  }

  if (anchor) requestAnimationFrame(() => anchor.scrollIntoView({ block: 'start' }));
  if (!sameMode && (mode === 'split' || mode === 'source')) setTimeout(() => $('editor').focus(), 0);
}

// Show or hide one pane, independently of the other. The two are never both
// hidden: turning off the only visible pane swaps to the other instead, which
// is what makes a single button read as "show just this one".
function togglePane(which) {
  let showView   = state.mode === 'view'   || state.mode === 'split';
  let showSource = state.mode === 'source' || state.mode === 'split';
  if (which === 'view') showView = !showView; else showSource = !showSource;
  if (!showView && !showSource) {
    if (which === 'view') showSource = true; else showView = true;
  }
  setMode(showView && showSource ? 'split' : (showView ? 'view' : 'source'));
}

// ---------- editor ----------
function onEditorInput() {
  histTouch();
  markDirty();
  scheduleRender();
  maybeAutoUppercase();
  maybeAutocomplete();
}
let renderTimer = null;
function scheduleRender() {
  if (renderTimer) clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    render($('editor').value);
  }, 120);
}

function maybeAutoUppercase() {
  // If user just finished typing a line that has only letters/spaces and was
  // preceded by a blank line and followed by Enter, uppercase it. We hook
  // this on space (cheap; doesn't disturb mid-word edits).
  // Skipping: requires more complex tracking; instead expose Tab/cycle below.
}

// Tab cycles current line through element types.
const TAB_CYCLE = [
  { name: 'action',       transform: (l) => l.replace(/^[\s@!.>~#=]*/, '').replace(/\s+$/, '') },
  { name: 'character',    transform: (l) => '@' + l.replace(/^[\s@!.>~#=]*/, '').toUpperCase().trim() },
  { name: 'dialogue',     transform: (l) => l }, // marked by indent — leave alone, handled by render
  { name: 'parenthetical',transform: (l) => '(' + l.replace(/^[\s@!.>~#=()]*/, '').replace(/\)\s*$/, '').trim() + ')' },
  { name: 'scene',        transform: (l) => 'INT. ' + l.replace(/^[\s@!.>~#=]*/, '').toUpperCase().trim() + ' - DAY' },
  { name: 'transition',   transform: (l) => '> ' + l.replace(/^[\s@!.>~#=]*/, '').toUpperCase().trim().replace(/:?$/, ':') },
];

function getCurrentLine(ta) {
  const start = ta.selectionStart;
  const text = ta.value;
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const lineEnd = text.indexOf('\n', start);
  return {
    start: lineStart,
    end: lineEnd < 0 ? text.length : lineEnd,
    text: text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd),
  };
}
function replaceLine(ta, line, newText) {
  const before = ta.value.slice(0, line.start);
  const after = ta.value.slice(line.end);
  ta.value = before + newText + after;
  ta.selectionStart = ta.selectionEnd = line.start + newText.length;
  markDirty();
  scheduleRender();
}

function onEditorKeydown(ev) {
  const ta = ev.target;
  if (ev.key === 'Tab' && !ev.shiftKey) {
    ev.preventDefault();
    const line = getCurrentLine(ta);
    cycleLineType(ta, line);
    return;
  }
  if (ev.key === 'Enter' && !ev.shiftKey) {
    // Let the default insertion happen, then apply smart auto-uppercase on
    // the line just completed.
    setTimeout(() => applySmartUppercase(ta), 0);
  }
  if (ev.key === 'Escape') {
    hideAutocomplete();
    hideContextMenu();
  }
  // Other shortcuts (Ctrl+S, Ctrl+1..7, Ctrl+B/I/U, Ctrl+/, Ctrl+;) are
  // handled by the global hotkey dispatcher so they work the same whether
  // the editor or the page has focus.
}

// After Enter, look at the line we just completed. If it's a scene-heading
// prefix typed in lowercase, uppercase it. Conservative — we don't touch
// character cues automatically (Tab handles those explicitly).
const SCENE_LEAD = /^(int|ext|est|i\/e|int\.\/ext|int\/ext)[\.\s]/i;
function applySmartUppercase(ta) {
  const pos = ta.selectionStart;
  const text = ta.value;
  // Look at the line just before the caret (Enter just split a line).
  const before = text.slice(0, pos);
  const newlineBefore = before.lastIndexOf('\n');
  // The completed line is the one whose newline is at `newlineBefore`.
  // Its content is text between the previous newline and `newlineBefore`.
  const prevNewline = newlineBefore > 0 ? before.lastIndexOf('\n', newlineBefore - 1) : -1;
  const completedLine = text.slice(prevNewline + 1, newlineBefore);
  if (!completedLine) return;
  if (!SCENE_LEAD.test(completedLine.trim())) return;
  if (completedLine === completedLine.toUpperCase()) return;
  const upper = completedLine.toUpperCase();
  ta.value = text.slice(0, prevNewline + 1) + upper + text.slice(newlineBefore);
  ta.selectionStart = ta.selectionEnd = pos;
}

const TYPE_ORDER = ['action', 'character', 'dialogue', 'parenthetical', 'scene', 'transition'];

function classifyLine(text) {
  const t = text.trim();
  if (!t) return 'action';
  if (/^@/.test(t)) return 'character';
  if (/^\./.test(t) && !/^\.\./.test(t)) return 'scene';
  if (/^(INT|EXT|EST)[\.\s]/i.test(t)) return 'scene';
  if (/^>/.test(t)) return 'transition';
  if (/^\(.*\)$/.test(t)) return 'parenthetical';
  if (/TO:\s*$/.test(t) && t === t.toUpperCase()) return 'transition';
  if (t === t.toUpperCase() && /[A-Z]/.test(t)) return 'character';
  return 'action';
}

function cycleLineType(ta, line) {
  const current = classifyLine(line.text);
  const idx = TYPE_ORDER.indexOf(current);
  const next = TYPE_ORDER[(idx + 1) % TYPE_ORDER.length];
  const stripped = line.text.replace(/^[\s@!>.~#=]*/, '').replace(/^\(/, '').replace(/\)\s*$/, '').replace(/\s+$/, '');
  let newText;
  switch (next) {
    case 'action':       newText = stripped; break;
    case 'character':    newText = '@' + stripped.toUpperCase(); break;
    case 'dialogue':     newText = stripped; break;
    case 'parenthetical': newText = '(' + stripped + ')'; break;
    case 'scene':        newText = '.' + stripped.toUpperCase(); break;
    case 'transition':   newText = '> ' + stripped.toUpperCase().replace(/:?$/, ':'); break;
  }
  replaceLine(ta, line, newText);
  status('Line → ' + next);
}

// Autocomplete for character cues.
function maybeAutocomplete() {
  const ta = $('editor');
  const line = getCurrentLine(ta);
  const stripped = line.text.replace(/^@/, '').trim();
  // Trigger if line is at most a short uppercase prefix and previous line is blank.
  if (!stripped) { hideAutocomplete(); return; }
  const prevBlank = (() => {
    const text = ta.value;
    const prevLineEnd = line.start - 1;
    if (prevLineEnd < 0) return true;
    const prevLineStart = text.lastIndexOf('\n', prevLineEnd - 1) + 1;
    return text.slice(prevLineStart, prevLineEnd).trim() === '';
  })();
  if (!prevBlank) { hideAutocomplete(); return; }
  if (stripped.length > 12 || stripped !== stripped.toUpperCase()) { hideAutocomplete(); return; }
  const matches = state.characters
    .filter(c => c.name.startsWith(stripped) && c.name !== stripped)
    .slice(0, 6);
  if (matches.length === 0) { hideAutocomplete(); return; }
  showAutocomplete(matches.map(m => m.name), (pick) => {
    replaceLine(ta, line, line.text.startsWith('@') ? '@' + pick : pick);
    hideAutocomplete();
  });
}
function showAutocomplete(items, onPick) {
  const el = $('autocomplete');
  el.innerHTML = '';
  for (const it of items) {
    const d = document.createElement('div');
    d.className = 'ac-item';
    d.textContent = it;
    d.onmousedown = (ev) => { ev.preventDefault(); onPick(it); };
    el.appendChild(d);
  }
  el.classList.remove('hidden');
  // Position near the caret.
  const ta = $('editor');
  const rect = ta.getBoundingClientRect();
  el.style.left = (rect.left + 8) + 'px';
  el.style.top = (rect.top + 30) + 'px';
}
function hideAutocomplete() { $('autocomplete').classList.add('hidden'); }

// ---------- scroll sync ----------
//
// Anchor-based sync, modelled on the markdown reader. We capture the
// topmost visible scene/section marker in one pane (its index + pixel
// offset from the pane top) and apply the same anchor in the other pane —
// the same marker ends up at the same screen-Y in both panes. Toggleable
// via the chain button or the palette.

function getSplitSync() { return loadPrefs().splitSync !== false; }
function setSplitSync(v) { const p = loadPrefs(); p.splitSync = !!v; savePrefs(p); applySplitSyncButton(); }
function applySplitSyncButton() {
  const btn = $('btn-sync');
  if (!btn) return;
  const on = getSplitSync();
  btn.classList.toggle('active', on);
  btn.title = 'Scroll sync ' + (on ? 'ON' : 'OFF') + ' — click to toggle';
}
function toggleSplitSync() {
  setSplitSync(!getSplitSync());
  status('Scroll sync ' + (getSplitSync() ? 'on' : 'off'));
  if (getSplitSync() && state.mode === 'split') syncNow();
}

// Source-anchor list: lines that begin a scene or section, in document
// order. (Same logic as the parser's classifier — kept here so this works
// without re-parsing.)
function listSourceAnchors(src) {
  const out = [];
  const lines = src.split('\n');
  let charIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    let hit = false;
    if (t && /^#{1,6}\s+/.test(t)) hit = true;
    else if (t && /^\.(?!\.)/.test(t)) hit = true;
    else if (t && /^(INT|EXT|EST|I\/E|INT\.\/EXT|INT\/EXT)[\.\s]/i.test(t)
             && (i === 0 || lines[i - 1].trim() === '')
             && (i === lines.length - 1 || lines[i + 1].trim() === '')) hit = true;
    if (hit) out.push({ lineIdx: i, charIdx });
    charIdx += lines[i].length + 1;
  }
  return out;
}

// ---------- scroll sync ----------
//
// Both panes are keyed to the same anchors (scene and section headings) and the
// position between them is INTERPOLATED, not copied as a pixel offset. A scene
// that is 300px of source may be 800px rendered, so carrying the raw offset
// across drifts through the scene and then jumps at the next heading. Working in
// fractions keeps the two in step the whole way down.
//
// Source positions are measured with textareaCaretCoords, which lays the text
// out in a mirror div. Estimating them as lineIndex * lineHeight assumes every
// line occupies one visual row, which soft wrapping breaks - and the error
// accumulates, so the panes diverge further apart the deeper you scroll.

function paneScrollTopOf(pane, el) {
  return el.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop;
}

// Where each anchor sits, in the scrollable coordinates of its own pane.
function sourceAnchorTops(ta) {
  return listSourceAnchors(ta.value).map(a => textareaCaretCoords(ta, a.charIdx).top);
}
function viewAnchorEls(pane) {
  return Array.from(pane.querySelectorAll('.elem-scene, .elem-section'));
}

// Which anchor span the pane is in, and how far through it (0..1). index -1
// means "above the first anchor", where the span is the run-up to it.
function positionWithin(tops, y, contentEnd) {
  if (!tops.length) return null;
  let i = -1;
  for (let k = 0; k < tops.length; k++) {
    if (tops[k] <= y) i = k; else break;
  }
  const from = i < 0 ? 0 : tops[i];
  const to   = (i + 1 < tops.length) ? tops[i + 1] : Math.max(contentEnd, from + 1);
  const span = Math.max(1, to - from);
  return { index: i, frac: Math.min(1, Math.max(0, (y - from) / span)) };
}

// Turn that back into a scroll position in the other pane.
function scrollFromPosition(tops, pos, contentEnd) {
  if (!tops.length || !pos) return null;
  const i = Math.min(pos.index, tops.length - 1);
  const from = i < 0 ? 0 : tops[i];
  const to   = (i + 1 < tops.length) ? tops[i + 1] : Math.max(contentEnd, from + 1);
  return from + pos.frac * Math.max(1, to - from);
}

function captureAnchorFromSource() {
  const ta = $('editor');
  const tops = sourceAnchorTops(ta);
  return positionWithin(tops, ta.scrollTop, ta.scrollHeight - ta.clientHeight);
}
function captureAnchorFromView() {
  const pane = document.querySelector('.pane-view');
  if (!pane) return null;
  const tops = viewAnchorEls(pane).map(el => paneScrollTopOf(pane, el));
  return positionWithin(tops, pane.scrollTop, pane.scrollHeight - pane.clientHeight);
}
function applyAnchorToSource(pos) {
  const ta = $('editor');
  const tops = sourceAnchorTops(ta);
  const y = scrollFromPosition(tops, pos, ta.scrollHeight - ta.clientHeight);
  if (y != null) ta.scrollTop = Math.max(0, y);
}
function applyAnchorToView(pos) {
  const pane = document.querySelector('.pane-view');
  if (!pane) return;
  const tops = viewAnchorEls(pane).map(el => paneScrollTopOf(pane, el));
  const y = scrollFromPosition(tops, pos, pane.scrollHeight - pane.clientHeight);
  if (y != null) pane.scrollTop = Math.max(0, y);
}

function syncScroll(fromEl, toEl) {
  if (state.scrollSyncing) return;
  if (!getSplitSync()) return;
  if (state.mode !== 'split') return;   // nothing to sync to
  state.scrollSyncing = true;
  try {
    const anchor = fromEl.tagName === 'TEXTAREA'
      ? captureAnchorFromSource()
      : captureAnchorFromView();
    if (anchor) {
      if (fromEl.tagName === 'TEXTAREA') applyAnchorToView(anchor);
      else applyAnchorToSource(anchor);
    }
  } finally {
    requestAnimationFrame(() => { state.scrollSyncing = false; });
  }
}

// Scroll the page so the element holding the source caret/selection appears at
// the same height it occupies in the source pane, bringing the selected text
// into view. Returns false if the caret's line has no rendered element (e.g.
// it sits in the title page or a blank gap), so the caller can fall back to
// scene/section-anchor alignment.
function alignViewToSourceSelection() {
  const ta = $('editor');
  const pane = document.querySelector('.pane-view');
  if (!pane) return false;
  const startLine = lineAtTextareaPos(ta, ta.selectionStart);
  const el = elemForSrcLine(startLine);
  if (!el) return false;
  // Where the selection currently sits relative to the source pane's top.
  // textareaCaretCoords is wrap-accurate (the textarea soft-wraps long lines),
  // unlike a flat line*lineHeight estimate.
  const lineViewportTop = textareaCaretCoords(ta, ta.selectionStart).top - ta.scrollTop;
  const paneTop = pane.getBoundingClientRect().top;
  const elViewportTop = el.getBoundingClientRect().top - paneTop;
  pane.scrollTop = Math.max(0, pane.scrollTop + (elViewportTop - lineViewportTop));
  return true;
}

// One-shot align: capture from the indicated pane and apply to the other.
// When `from` is omitted, fall back to whichever pane currently has focus
// (or the source by default).
function syncNow(from) {
  if (state.mode !== 'split') return;
  const ta = $('editor');
  let fromSource;
  if (from === 'source') fromSource = true;
  else if (from === 'view') fromSource = false;
  else fromSource = document.activeElement === ta;
  state.scrollSyncing = true;
  try {
    if (fromSource) {
      // Prefer the caret/selection so the exact text is brought into view;
      // fall back to the nearest scene/section anchor when it can't be mapped.
      if (!alignViewToSourceSelection()) {
        const a = captureAnchorFromSource();
        if (a) applyAnchorToView(a);
      }
      mirrorFromSource();   // (re)draw the selection highlight at its new spot
    } else {
      const a = captureAnchorFromView();
      if (a) applyAnchorToSource(a);
    }
  } finally {
    requestAnimationFrame(() => { state.scrollSyncing = false; });
  }
  status('Aligned from ' + (fromSource ? 'source' : 'page'));
}

// ---------- diff ----------
// Line-based LCS diff. Returns [{ type: 'eq'|'add'|'del', text }].
function diffLines(a, b) {
  const m = a.length, n = b.length;
  // dp[i][j] = LCS length of a[i..] and b[j..]. We use a single 2D array of
  // small ints (Uint16) — fine for scripts up to ~65k lines.
  const dp = [];
  for (let i = 0; i <= m; i++) dp.push(new Uint16Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { out.push({ type: 'eq', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', text: a[i++] }); }
    else { out.push({ type: 'add', text: b[j++] }); }
  }
  while (i < m) out.push({ type: 'del', text: a[i++] });
  while (j < n) out.push({ type: 'add', text: b[j++] });
  return out;
}

async function openDiff(snapshotName, snapshotTimestamp) {
  if (!state.currentPath) return;
  const res = await fetch('/api/history/file?path=' + encodeURIComponent(state.currentPath) +
                          '&name=' + encodeURIComponent(snapshotName));
  const { content: snapContent } = await res.json();
  const current = $('editor').value;
  const diff = diffLines(snapContent.split('\n'), current.split('\n'));

  const modal = $('modal-root');
  modal.classList.remove('hidden');
  const adds = diff.filter(d => d.type === 'add').length;
  const dels = diff.filter(d => d.type === 'del').length;
  modal.innerHTML = `
    <div class="modal modal-wide modal-diff">
      <div class="modal-head">
        <h3>Diff — snapshot ${escapeHtml(formatTs(snapshotTimestamp))} → current
          <span class="diff-stats">+${adds} −${dels}</span></h3>
        <button class="icon-btn" id="modal-close">×</button>
      </div>
      <div class="modal-body">
        <pre class="diff-view">${diff.map(d => {
          const cls = d.type === 'add' ? 'd-add' : d.type === 'del' ? 'd-del' : 'd-eq';
          const sigil = d.type === 'add' ? '+' : d.type === 'del' ? '−' : ' ';
          return `<span class="${cls}">${sigil} ${escapeHtml(d.text)}</span>`;
        }).join('\n')}</pre>
      </div>
    </div>`;
  $('modal-close').onclick = () => modal.classList.add('hidden');
}

// ---------- history modal ----------
async function openHistory() {
  if (!state.currentPath) return;
  const res = await fetch('/api/history?path=' + encodeURIComponent(state.currentPath));
  const { snapshots } = await res.json();
  const modal = $('modal-root');
  modal.classList.remove('hidden');
  modal.innerHTML = `
    <div class="modal">
      <div class="modal-head">
        <h3>Version history</h3>
        <button class="icon-btn" id="modal-close">×</button>
      </div>
      <div class="modal-body">
        ${snapshots.length === 0 ? '<p>No snapshots yet — save once to create one.</p>' : ''}
        <ul class="history-list">
          ${snapshots.map(s => `<li>
            <span class="hist-ts">${formatTs(s.timestamp)}</span>
            <span class="hist-size">${s.size} B</span>
            <button data-name="${s.name}" data-ts="${s.timestamp}" class="hist-diff">Diff</button>
            <button data-name="${s.name}" class="hist-restore">Restore</button>
          </li>`).join('')}
        </ul>
      </div>
    </div>`;
  $('modal-close').onclick = () => modal.classList.add('hidden');
  for (const btn of modal.querySelectorAll('.hist-restore')) {
    btn.onclick = async () => {
      if (!confirm('Restore this version? Current text will be snapshotted first.')) return;
      await fetch('/api/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: state.currentPath, name: btn.dataset.name }),
      });
      modal.classList.add('hidden');
      await openScript(state.currentPath);
    };
  }
  for (const btn of modal.querySelectorAll('.hist-diff')) {
    btn.onclick = () => openDiff(btn.dataset.name, btn.dataset.ts);
  }
}
function formatTs(s) {
  // Snapshots taken in the same second get a "-N" suffix; ignore it for display.
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(?:-\d+)?$/.exec(s);
  if (!m) return s;
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
}

// ---------- new / rename / delete ----------
async function newScript() {
  const name = prompt('New script filename (e.g. "untitled.fountain")');
  if (!name) return;
  const path = name.includes('.') ? name : (name + '.fountain');
  const res = await fetch('/api/new', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content: 'Title: ' + name.replace(/\.[^.]+$/, '') + '\n\n' }),
  });
  if (!res.ok) { status('Create failed', true); return; }
  await loadTree();
  openScript(path);
}
async function renameScript() {
  if (!state.currentPath) return;
  const to = prompt('Rename to:', state.currentPath);
  if (!to || to === state.currentPath) return;
  const res = await fetch('/api/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: state.currentPath, to }),
  });
  if (!res.ok) { status('Rename failed', true); return; }
  state.currentPath = to;
  await loadTree();
  openScript(to);
}
async function deleteScript() {
  if (!state.currentPath) return;
  if (!confirm('Delete ' + state.currentPath + '?')) return;
  const res = await fetch('/api/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: state.currentPath }),
  });
  if (!res.ok) { status('Delete failed', true); return; }
  state.currentPath = null;
  $('crumbs').textContent = 'No script selected';
  $('editor').value = '';
  histReset();
  $('view').innerHTML = '';
  enableActions(false);
  await loadTree();
}

// ---------- path-targeted file ops (used by the file-tree context menu) ----------
// These operate on a given path rather than the current script, so they work on
// any file the user right-clicks in the tree.
async function renamePath(path) {
  const to = prompt('Rename to:', path);
  if (!to || to === path) return;
  const res = await fetch('/api/rename', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: path, to }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    status('Rename failed: ' + (e.error || res.status), true);
    return;
  }
  // Carry over open-tab state if the renamed file was open.
  if (state.tabState[path]) { state.tabState[to] = state.tabState[path]; delete state.tabState[path]; }
  state.openTabs = state.openTabs.map(p => (p === path ? to : p));
  if (state.currentPath === path) state.currentPath = to;
  await loadTree();
  if (state.currentPath === to) { openScript(to); } else { renderTabs(); highlightTreeSelection(); }
  status('Renamed to ' + to);
}

async function deletePath(path) {
  if (!confirm('Delete ' + path + '?')) return;
  const res = await fetch('/api/delete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    status('Delete failed: ' + (e.error || res.status), true);
    return;
  }
  delete state.tabState[path];
  state.openTabs = state.openTabs.filter(p => p !== path);
  if (state.currentPath === path) {
    if (state.openTabs.length > 0) {
      await openScript(state.openTabs[state.openTabs.length - 1]);
    } else {
      state.currentPath = null;
      $('editor').value = '';
      histReset();
      $('view').innerHTML = '';
      $('crumbs').textContent = 'No script selected';
      enableActions(false);
    }
  }
  await loadTree();
  renderTabs();
  status('Deleted ' + path);
}

async function duplicateScript(path) {
  const res = await fetch('/api/file?path=' + encodeURIComponent(path));
  if (!res.ok) { status('Could not read file', true); return; }
  const { content } = await res.json();
  const ext = (path.match(/\.[^.\/]+$/) || ['.fountain'])[0];
  const base = path.replace(/\.[^.\/]+$/, '');
  let newPath = base + ' copy' + ext;
  for (let n = 2; ; n++) {
    const r = await fetch('/api/new', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: newPath, content }),
    });
    if (r.ok) break;
    const e = await r.json().catch(() => ({}));
    if ((e.error || '').includes('exists') && n <= 50) { newPath = base + ' copy ' + n + ext; continue; }
    status('Duplicate failed: ' + (e.error || r.status), true);
    return;
  }
  await loadTree();
  openScript(newPath);
  status('Duplicated to ' + newPath);
}

// Right-click menu for the file tree: per-file actions when a file is clicked,
// plus library-level actions (new / import / refresh) always.
function onTreeContextMenu(ev) {
  const fileEl = ev.target.closest('.tree-file');
  ev.preventDefault();
  const items = [];
  if (fileEl) {
    const path = fileEl.dataset.path;
    const name = path.split('/').pop();
    items.push({ label: 'Open',        action: () => openScript(path) });
    items.push({ label: 'Rename…',     action: () => renamePath(path) });
    items.push({ label: 'Duplicate',   action: () => duplicateScript(path) });
    items.push({ label: 'Delete',      action: () => deletePath(path) });
    items.push('-');
    items.push({ label: 'Export PDF',                 action: () => exportPdf(path) });
    items.push({ label: 'Export Final Draft (.fdx)',  action: () => exportFdx(path) });
    items.push({ label: 'Version history', action: async () => { await openScript(path); openHistory(); } });
    items.push('-');
  }
  items.push({ label: 'New script…',                 action: newScript,  hint: 'Ctrl+N' });
  items.push({ label: 'Import Final Draft (.fdx)…',  action: importFdx });
  items.push({ label: 'Refresh tree',                action: loadTree });
  showContextMenu(ev.clientX, ev.clientY, items);
}

// ---------- PDF export ----------
// pathArg is optional (tree context menu passes a path); when omitted, or when
// called as a button handler (receives an Event), we export the current script.
async function exportPdf(pathArg) {
  const path = (typeof pathArg === 'string' && pathArg) ? pathArg : state.currentPath;
  if (!path) return;
  status('Generating PDF…');
  const res = await fetch('/api/export/pdf?path=' + encodeURIComponent(path));
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    status('Export failed: ' + (e.error || res.status), true);
    return;
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = path.replace(/\.[^.]+$/, '') + '.pdf';
  a.click();
  URL.revokeObjectURL(url);
  status('Exported PDF');
}

// ---------- Final Draft (.fdx) interchange ----------
async function exportFdx(pathArg) {
  const path = (typeof pathArg === 'string' && pathArg) ? pathArg : state.currentPath;
  if (!path) return;
  status('Generating Final Draft file…');
  const res = await fetch('/api/export/fdx?path=' + encodeURIComponent(path));
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    status('FDX export failed: ' + (e.error || res.status), true);
    return;
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = path.replace(/\.[^.]+$/, '') + '.fdx';
  a.click();
  URL.revokeObjectURL(url);
  status('Exported Final Draft (.fdx)');
}

// Pick a .fdx file, convert it server-side to a new .fountain, then open it.
function importFdx() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.fdx,application/xml,text/xml';
  input.onchange = async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    status('Importing ' + file.name + '…');
    let content;
    try { content = await file.text(); }
    catch { status('Could not read file', true); return; }
    const res = await fetch('/api/import/fdx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: file.name, content }),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      status('Import failed: ' + (e.error || res.status), true);
      return;
    }
    const { path } = await res.json();
    await loadTree();
    await openScript(path);
    status('Imported ' + path);
  };
  input.click();
}

async function exportSides() {
  if (!state.currentPath) return;
  if (state.characters.length === 0) { status('No characters in script', true); return; }
  const modal = $('modal-root');
  modal.classList.remove('hidden');
  const opts = state.characters
    .slice().sort((a, b) => b.count - a.count)
    .map(c => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)} (${c.count} cues)</option>`).join('');
  modal.innerHTML = `
    <div class="modal">
      <div class="modal-head"><h3>Export character sides</h3><button class="icon-btn" id="modal-close">×</button></div>
      <div class="modal-body">
        <p>Pick a character. The PDF will include only the scenes they appear in,
           with their dialogue highlighted and others dimmed.</p>
        <select id="sides-character" style="width: 100%; padding: 0.4rem; font: 0.9rem var(--courier);">${opts}</select>
        <button id="sides-go" class="apply-btn" style="margin-top: 0.8rem;">Generate</button>
      </div>
    </div>`;
  $('modal-close').onclick = () => modal.classList.add('hidden');
  $('sides-go').onclick = async () => {
    const character = $('sides-character').value;
    modal.classList.add('hidden');
    status('Generating sides for ' + character + '…');
    const res = await fetch('/api/export/sides?path=' + encodeURIComponent(state.currentPath) +
                            '&character=' + encodeURIComponent(character));
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      status('Sides failed: ' + (e.error || res.status), true);
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = state.currentPath.replace(/\.[^.]+$/, '') + '-sides-' + character + '.pdf';
    a.click();
    URL.revokeObjectURL(url);
    status('Exported sides');
  };
}

// ---------- bookmarks ----------
function renderBookmarksPanel() {
  let panel = $('bookmarks-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'bookmarks-panel';
    panel.className = 'outline-panel';
    panel.innerHTML = '<div class="section-head">Bookmarks</div><ul id="bookmarks" class="outline"></ul>';
    $('sidebar').appendChild(panel);
  }
  const ul = $('bookmarks');
  ul.innerHTML = '';
  const all = getBookmarks();
  const mine = all.filter(b => b.path === state.currentPath);
  for (const bm of mine) {
    const li = document.createElement('li');
    li.className = 'bm-item';
    const a = document.createElement('a');
    a.href = '#';
    a.textContent = bm.label;
    a.onclick = (ev) => {
      ev.preventDefault();
      const view = document.querySelector('.pane-view');
      if (view) view.scrollTop = bm.y;
    };
    const del = document.createElement('button');
    del.className = 'bm-del'; del.textContent = '×';
    del.onclick = () => {
      setBookmarks(all.filter(x => !(x.path === bm.path && x.y === bm.y)));
      renderBookmarksPanel();
    };
    li.appendChild(a); li.appendChild(del);
    ul.appendChild(li);
  }
  if (mine.length === 0) {
    const li = document.createElement('li');
    li.className = 'bm-empty';
    li.textContent = 'B to bookmark current position';
    ul.appendChild(li);
  }
}

function addBookmark() {
  if (!state.currentPath) return;
  const view = document.querySelector('.pane-view');
  const y = view.scrollTop;
  // Use nearest scene heading above as label.
  let label = 'Position ' + Math.round(y);
  const nodes = view.querySelectorAll('.scene');
  for (const n of nodes) {
    if (n.offsetTop <= y + 50) label = n.textContent.slice(0, 40);
  }
  const all = getBookmarks();
  all.push({ path: state.currentPath, y, label, ts: Date.now() });
  setBookmarks(all);
  renderBookmarksPanel();
  status('Bookmarked: ' + label);
}

// ---------- stats modal ----------
function openStats() {
  if (!state.currentPath) return;
  const stats = computeStats();
  const modal = $('modal-root');
  modal.classList.remove('hidden');
  const charRows = stats.characters.map(c =>
    `<tr><td>${escapeHtml(c.name)}</td><td>${c.cues}</td><td>${c.lines}</td><td>${c.words}</td><td>${c.scenes}</td></tr>`
  ).join('');
  const locRows = stats.locations.map(l =>
    `<tr><td>${escapeHtml(l.name)}</td><td>${l.count}</td></tr>`
  ).join('');
  modal.innerHTML = `
    <div class="modal modal-wide">
      <div class="modal-head">
        <h3>Production stats — ${escapeHtml(state.currentPath)}</h3>
        <button class="icon-btn" id="modal-close">×</button>
      </div>
      <div class="modal-body">
        <div class="stat-row">
          <div class="stat-box"><div class="stat-num">${stats.pages}</div><div class="stat-lbl">pages</div></div>
          <div class="stat-box"><div class="stat-num">${formatRuntime(stats.runtimeMin)}</div><div class="stat-lbl">est. runtime</div></div>
          <div class="stat-box"><div class="stat-num">${stats.scenes}</div><div class="stat-lbl">scenes</div></div>
          <div class="stat-box"><div class="stat-num">${stats.characters.length}</div><div class="stat-lbl">characters</div></div>
          <div class="stat-box"><div class="stat-num">${stats.locations.length}</div><div class="stat-lbl">locations</div></div>
          <div class="stat-box"><div class="stat-num">${stats.words}</div><div class="stat-lbl">words</div></div>
        </div>
        <p class="stat-note">Runtime: ${stats.format === 'screenplay'
          ? 'screenplay 1 page ≈ 1 minute'
          : `${stats.format} ≈ ${RUNTIME_WPM[stats.format] || 130} spoken words/min (${stats.spokenWords} spoken words)`}.</p>
        <h4>Characters</h4>
        <table class="stat-table">
          <thead><tr><th>Name</th><th>Cues</th><th>Lines</th><th>Words</th><th>Scenes</th></tr></thead>
          <tbody>${charRows}</tbody>
        </table>
        <h4>Locations</h4>
        <table class="stat-table">
          <thead><tr><th>Slug</th><th>Scenes</th></tr></thead>
          <tbody>${locRows}</tbody>
        </table>
      </div>
    </div>`;
  $('modal-close').onclick = () => modal.classList.add('hidden');
}

// Speech rates (words per minute) for runtime estimation. Screenplay runtime
// is page-based (the industry 1 page ≈ 1 minute rule); stage and radio are
// estimated from spoken word counts since their pages don't map to minutes.
const RUNTIME_WPM = { stage: 130, radio: 150 };

function computeStats() {
  let scenes = 0, spokenWords = 0, actionWords = 0;
  const chars = new Map();
  const locs = new Map();
  let currentScene = 0;
  let currentChar = null;

  const wordsIn = countWords;
  const ensureChar = (name) => {
    if (!chars.has(name)) chars.set(name, { name, cues: 0, lines: 0, words: 0, scenes: new Set() });
    return chars.get(name);
  };

  for (const t of state.tokens) {
    if (t.type === 'scene') {
      scenes++;
      currentScene = scenes;
      // Extract location: everything before the last " - " or full slug.
      const m = /^(?:INT|EXT|EST|I\/E|INT\.\/EXT|INT\/EXT)[\.\s]+(.+?)(?:\s+-\s+.*)?$/i.exec(t.text);
      const loc = (m ? m[1] : t.text).trim().toUpperCase();
      locs.set(loc, (locs.get(loc) || 0) + 1);
    }
    if (t.type === 'character') {
      currentChar = t.text.replace(/\s*\([^)]*\)\s*$/, '').trim();
      const c = ensureChar(currentChar);
      c.cues++;
      if (currentScene) c.scenes.add(currentScene);
    }
    if (t.type === 'dialogue' && currentChar) {
      const c = ensureChar(currentChar);
      c.lines++;
      c.words += wordsIn(t.text);
      spokenWords += wordsIn(t.text);
    }
    if (t.type === 'action') actionWords += wordsIn(t.text);
  }
  const words = spokenWords + actionWords;
  // Use the real paginated page count from the renderer — the same number
  // shown in the page view — instead of re-estimating it here.
  const pages = state.pageCount ||
    Math.max(1, Math.ceil(state.tokens.reduce(
      (acc, t) => acc + Math.max(1, Math.ceil((t.text || '').length / 50)), 0) / 55));

  // Format-aware runtime estimate, in minutes.
  const fmt = (state.rules && state.rules.name) || 'screenplay';
  let runtimeMin;
  if (fmt === 'radio') runtimeMin = Math.round((spokenWords + actionWords) / RUNTIME_WPM.radio);
  else if (fmt === 'stage') runtimeMin = Math.round(spokenWords / RUNTIME_WPM.stage);
  else runtimeMin = pages; // screenplay: 1 page ≈ 1 minute

  const characters = [...chars.values()]
    .map(c => ({ ...c, scenes: c.scenes.size }))
    .sort((a, b) => b.lines - a.lines || b.cues - a.cues);
  const locations = [...locs.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
  return { pages, scenes, words, spokenWords, actionWords, runtimeMin, format: fmt, characters, locations };
}

// "95" → "1h 35m"; "8" → "8 min".
function formatRuntime(min) {
  min = Math.max(0, Math.round(min || 0));
  if (min < 60) return min + ' min';
  return Math.floor(min / 60) + 'h ' + (min % 60) + 'm';
}

// ---------- cast list (dramatis personae) ----------
// Returns the character index in `text` where the body begins, i.e. just after
// the title-page block (mirrors the parser / rewriteTitlePage logic).
function bodyStartIndex(text) {
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (!(i < lines.length && /^[A-Za-z][A-Za-z0-9 _\-]*:/.test(lines[i]))) return 0;
  while (i < lines.length && lines[i].trim() !== '') i++;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i < lines.length && /^={3,}\s*$/.test(lines[i])) {
    i++;
    while (i < lines.length && lines[i].trim() === '') i++;
  }
  return lines.slice(0, i).join('\n').length + (i > 0 ? 1 : 0);
}

function buildCastListText() {
  // First-appearance order reads more naturally for a cast list than the
  // line-count order used in stats.
  const names = state.characters.map(c => c.name);
  const lines = ['# CAST OF CHARACTERS', ''];
  for (const n of names) lines.push('!' + n + ' — ');
  lines.push('');
  return lines.join('\n');
}

function openCastList() {
  if (!state.currentPath) return;
  if (state.characters.length === 0) { status('No characters found', true); return; }
  const stats = computeStats();
  const byName = new Map(stats.characters.map(c => [c.name, c]));
  const modal = $('modal-root');
  modal.classList.remove('hidden');
  const rows = state.characters.map(c => {
    const s = byName.get(c.name) || { cues: c.count, lines: 0, scenes: 0 };
    return `<tr><td>${escapeHtml(c.name)}</td><td>${s.cues}</td><td>${s.scenes}</td></tr>`;
  }).join('');
  modal.innerHTML = `
    <div class="modal modal-wide">
      <div class="modal-head"><h3>Cast list — ${escapeHtml(state.currentPath)}</h3>
        <button class="icon-btn" id="modal-close">×</button></div>
      <div class="modal-body">
        <p>${state.characters.length} speaking ${state.characters.length === 1 ? 'role' : 'roles'}, in order of first appearance.</p>
        <table class="stat-table">
          <thead><tr><th>Character</th><th>Cues</th><th>Scenes</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="modal-actions">
          <button id="cast-copy" class="apply-btn">Copy as text</button>
          <button id="cast-insert">Insert into script</button>
        </div>
      </div>
    </div>`;
  $('modal-close').onclick = () => modal.classList.add('hidden');
  $('cast-copy').onclick = () => {
    const txt = buildCastListText().replace(/^!/gm, '');
    navigator.clipboard?.writeText(txt);
    status('Cast list copied');
  };
  $('cast-insert').onclick = () => {
    const ta = $('editor');
    const text = ta.value;
    const at = bodyStartIndex(text);
    const block = buildCastListText() + '\n';
    histCommit();
    ta.value = text.slice(0, at) + block + text.slice(at);
    ta.selectionStart = ta.selectionEnd = at;
    reparseSource();
    markDirty();
    scheduleRender();
    histCommit();
    modal.classList.add('hidden');
    status('Cast list inserted — edit the descriptions');
  };
}

// ---------- notes review ----------
// Every [[note]] in the script, listed for a revision pass. Click to jump.
function collectNotes() {
  const out = [];
  for (const t of state.tokens) {
    if (t.notes && t.notes.length && typeof t.srcLine === 'number') {
      for (const n of t.notes) {
        out.push({ text: n, srcLine: t.srcLine, context: (t.text || '').slice(0, 60) });
      }
    }
  }
  return out;
}

function openNotesReview() {
  if (!state.currentPath) return;
  const notes = collectNotes();
  const modal = $('modal-root');
  modal.classList.remove('hidden');
  const items = notes.length
    ? notes.map((n, i) =>
        `<li class="note-item" data-line="${n.srcLine}" data-i="${i}">
           <div class="note-text">${escapeHtml(n.text)}</div>
           <div class="note-ctx">line ${n.srcLine + 1}${n.context ? ' · ' + escapeHtml(n.context) : ''}</div>
         </li>`).join('')
    : '<li class="note-empty">No notes yet. Add inline notes with [[ … ]] (Ctrl+/).</li>';
  modal.innerHTML = `
    <div class="modal">
      <div class="modal-head"><h3>Notes — ${notes.length} in this script</h3>
        <button class="icon-btn" id="modal-close">×</button></div>
      <div class="modal-body">
        <ul class="note-list">${items}</ul>
      </div>
    </div>`;
  $('modal-close').onclick = () => modal.classList.add('hidden');
  for (const li of modal.querySelectorAll('.note-item')) {
    li.onclick = () => {
      const line = parseInt(li.dataset.line, 10);
      modal.classList.add('hidden');
      if (Number.isNaN(line)) return;
      if (state.mode !== 'split') setMode('split');
      scrollSourceToLine(line, { caret: true });
    };
  }
}

// ---------- Page (WYSIWYG) editing ----------
//
// The paginated view is a read-only projection of the source. These helpers map
// a clicked `.elem` (which carries its element type as a class and its source
// line as data-src-line) back to the source line so toolbar/menu operations
// edit the source.

function elKind(el) {
  for (const c of el.classList) {
    if (c.startsWith('elem-') && c !== 'elem-dual' && c !== 'elem-dual-col' && c !== 'elem-dual-left' && c !== 'elem-dual-right') {
      return c.slice('elem-'.length);
    }
  }
  return 'action';
}
function nearestElem(node) {
  while (node && node !== document) {
    if (node.nodeType === 1 && node.classList && node.classList.contains('elem')) return node;
    node = node.parentNode;
  }
  return null;
}
function focusedElem() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  return nearestElem(sel.anchorNode);
}
// The page view is a read-only projection of the source. Editing operations
// target the source line that backs a clicked/located page element via its
// data-src-line. caretToElemLine parks the source caret at the line start;
// selectElemLine selects the whole line (for convert/wrap operations).
function caretToElemLine(el) {
  const n = parseInt(el && el.dataset && el.dataset.srcLine, 10);
  if (Number.isNaN(n)) return -1;
  const ta = $('editor');
  const lines = ta.value.split('\n');
  let idx = 0;
  for (let i = 0; i < n && i < lines.length; i++) idx += lines[i].length + 1;
  ta.selectionStart = ta.selectionEnd = idx;
  return n;
}
function selectElemLine(el) {
  const n = parseInt(el && el.dataset && el.dataset.srcLine, 10);
  if (Number.isNaN(n)) return false;
  const ta = $('editor');
  const lines = ta.value.split('\n');
  let idx = 0;
  for (let i = 0; i < n; i++) idx += lines[i].length + 1;
  ta.selectionStart = idx;
  ta.selectionEnd = idx + (lines[n] || '').length;
  return true;
}
// Replace the whole source line backing a page element (goes through spliceText
// so it's undoable and re-renders).
function setElemSourceLine(el, newLine) {
  const n = parseInt(el && el.dataset && el.dataset.srcLine, 10);
  if (Number.isNaN(n)) return;
  const ta = $('editor');
  const lines = ta.value.split('\n');
  let idx = 0;
  for (let i = 0; i < n; i++) idx += lines[i].length + 1;
  spliceText(ta, idx, idx + (lines[n] || '').length, newLine);
}
// Clicking the read-only page parks the source caret on that element's line so
// the toolbar element-type buttons act on what the user clicked.
function onPageClick(ev) {
  const el = ev.target && ev.target.closest ? ev.target.closest('.elem') : null;
  if (el) caretToElemLine(el);
}

// Re-parse the current textarea content into state.titlePage / state.tokens
// without touching the rendered DOM. Cheap; safe to call after any
// programmatic ta.value mutation.
function reparseSource() {
  try {
    const parsed = Fountain.parse($('editor').value);
    state.titlePage = parsed.titlePage;
    state.tokens = parsed.tokens;
  } catch (e) { /* ignore */ }
}

// ---------- undo / redo history ----------
// App-level history over the canonical Fountain source. The browser's native
// textarea/contenteditable undo is useless here: every operation rewrites
// editor.value programmatically (which wipes the native undo stack) and
// re-renders the page. So we snapshot the source instead. Discrete operations
// (formatting, element conversion, page edits, beat board, find/replace) each
// become one undo step via histCommit(); free typing is coalesced on a timer
// via histTouch().
let _histUndo = [], _histRedo = [], _histBase = null, _histTimer = null;
const HIST_MAX = 300;
function histSnap() {
  const ta = $('editor');
  return { text: ta.value, s: ta.selectionStart, e: ta.selectionEnd };
}
function histReset() {
  _histUndo = []; _histRedo = []; _histBase = histSnap();
  clearTimeout(_histTimer); _histTimer = null;
}
// Seal the current source as an undo boundary (cheap no-op when unchanged).
function histCommit() {
  clearTimeout(_histTimer); _histTimer = null;
  const cur = histSnap();
  if (_histBase == null) { _histBase = cur; return; }
  if (cur.text !== _histBase.text) {
    _histUndo.push(_histBase);
    if (_histUndo.length > HIST_MAX) _histUndo.shift();
    _histRedo = [];
  }
  _histBase = cur;
}
// Coalesced boundary for free typing — settles into one step after a pause.
function histTouch() {
  clearTimeout(_histTimer);
  _histTimer = setTimeout(histCommit, 500);
}
function histApply(st) {
  const ta = $('editor');
  ta.value = st.text;
  reparseSource();
  render(st.text);
  ta.selectionStart = st.s; ta.selectionEnd = st.e;
  if (state.mode === 'source' || state.mode === 'split') ta.focus();
  _histBase = { text: st.text, s: st.s, e: st.e };
  clearTimeout(_histTimer); _histTimer = null;
  markDirty();
}
function histUndo() {
  histCommit();       // seal the latest change so it can be undone
  if (!_histUndo.length) { status('Nothing to undo'); return; }
  _histRedo.push(_histBase);
  histApply(_histUndo.pop());
  status('Undo');
}
function histRedo() {
  histCommit();
  if (!_histRedo.length) { status('Nothing to redo'); return; }
  _histUndo.push(_histBase);
  histApply(_histRedo.pop());
  status('Redo');
}

// ---------- find & replace ----------
const findState = {
  open: false,
  query: '',
  matches: [],   // [{ start, end }] indices into editor textarea
  current: -1,
};

function openFind(preset = '') {
  $('find-bar').classList.remove('hidden');
  findState.open = true;
  if (preset) $('find-input').value = preset;
  $('find-input').focus();
  $('find-input').select();
  recomputeMatches();
}
function closeFind() {
  $('find-bar').classList.add('hidden');
  findState.open = false;
  clearFindHighlight();
  // Land focus on the current match so it's visible and ready to edit.
  const m = findState.matches[findState.current];
  if (m && (state.mode === 'source' || state.mode === 'split')) {
    const ta = $('editor');
    ta.focus();
    ta.setSelectionRange(m.start, m.end);
  }
  findState.matches = [];
  findState.current = -1;
  updateFindCount();
}
function findRegex(q, caseSensitive) {
  if (!q) return null;
  try {
    return new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'g' : 'gi');
  } catch { return null; }
}

// Compute per-character scope mask from current source.
// scope: 'all' | 'dialogue' | 'action' | 'scene' | 'character'
function scopeMask(text, scope) {
  if (scope === 'all') return null;
  const parsed = Fountain.parse(text);
  // Build a Uint8Array marking allowed character positions.
  const mask = new Uint8Array(text.length);
  // The parser doesn't track source positions, so we re-scan: find each
  // token's text occurrence in the source and mark the matching span.
  let cursor = 0;
  for (const tok of parsed.tokens) {
    if (!tok.text) continue;
    const idx = text.indexOf(tok.text, cursor);
    if (idx < 0) continue;
    cursor = idx + tok.text.length;
    if (tok.type === scope) {
      for (let i = idx; i < idx + tok.text.length; i++) mask[i] = 1;
    }
  }
  return mask;
}

function recomputeMatches() {
  const ta = $('editor');
  const q = $('find-input').value;
  findState.query = q;
  const caseSensitive = $('find-case').checked;
  const scope = $('find-scope').value;
  const re = findRegex(q, caseSensitive);
  if (!re) { findState.matches = []; findState.current = -1; clearFindHighlight(); updateFindCount(); return; }

  const text = ta.value;
  const mask = scope === 'all' ? null : scopeMask(text, scope);
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index === re.lastIndex) re.lastIndex++; // safety on zero-width
    if (mask && !mask[m.index]) continue;
    out.push({ start: m.index, end: m.index + m[0].length });
    if (m[0].length === 0) re.lastIndex++;
  }
  findState.matches = out;
  // Anchor selection on first match at/after current cursor.
  const caret = ta.selectionStart;
  let cur = out.findIndex(x => x.start >= caret);
  if (cur < 0 && out.length > 0) cur = 0;
  findState.current = cur;
  if (cur >= 0) highlightMatch(cur);
  else clearFindHighlight();
  updateFindCount();
}

function updateFindCount() {
  const el = $('find-count');
  if (!findState.query) { el.textContent = ''; return; }
  if (findState.matches.length === 0) { el.textContent = 'No matches'; return; }
  el.textContent = `${findState.current + 1}/${findState.matches.length}`;
}

function highlightMatch(idx) {
  const ta = $('editor');
  const m = findState.matches[idx];
  if (!m) return;
  clearFindHighlight();
  ta.setSelectionRange(m.start, m.end);
  // Don't steal focus while the user is in the find bar (typing a query,
  // pressing Enter, or clicking prev/next) — that would interrupt typing.
  // The selection is still set + scrolled into view, and becomes visible when
  // the find bar is closed (closeFind focuses the editor on the match).
  const ae = document.activeElement;
  if (!(ae && ae.closest && ae.closest('#find-bar'))) ta.focus();
  // Best-effort scroll into view.
  const before = ta.value.slice(0, m.start);
  const approxLine = before.split('\n').length;
  ta.scrollTop = Math.max(0, (approxLine - 4) * (ta.scrollHeight / Math.max(1, ta.value.split('\n').length)));
  // Draw a visible highlight box over the match in the source pane (a textarea
  // can't show its own selection while another field is focused), now that the
  // textarea has been scrolled to the match.
  drawFindHighlightSource(m);
  // If in view/split mode, also scroll the page view to the matching text and
  // highlight the element it lives in.
  if (state.mode === 'view' || state.mode === 'split') {
    const needle = ta.value.slice(m.start, m.end);
    if (needle.length >= 2) {
      const pane = document.querySelector('.pane-view');
      const elems = pane.querySelectorAll('.elem');
      for (const el of elems) {
        if ((el.textContent || '').includes(needle)) {
          el.scrollIntoView({ behavior: 'smooth', block: 'start' });
          el.classList.add('find-hit');
          break;
        }
      }
    }
  }
}

// Overlay box(es) marking the current match in the source textarea.
function drawFindHighlightSource(m) {
  if (state.mode !== 'source' && state.mode !== 'split') return;
  const ta = $('editor');
  const pane = document.querySelector('.pane-edit');
  if (!ta || !pane) return;
  let host = $('find-hl');
  if (!host) {
    host = document.createElement('div');
    host.id = 'find-hl';
    host.setAttribute('aria-hidden', 'true');
    pane.appendChild(host);
  }
  host.innerHTML = '';
  for (const r of textareaRangeRects(ta, m.start, m.end)) {
    const box = document.createElement('div');
    box.className = 'find-hl-box';
    box.style.top = (r.top - ta.scrollTop) + 'px';
    box.style.left = (r.left - ta.scrollLeft) + 'px';
    box.style.width = r.width + 'px';
    box.style.height = r.height + 'px';
    host.appendChild(box);
  }
  host.classList.remove('hidden');
}

function clearFindHighlight() {
  const host = $('find-hl');
  if (host) { host.innerHTML = ''; host.classList.add('hidden'); }
  for (const el of document.querySelectorAll('#view .elem.find-hit')) el.classList.remove('find-hit');
}

// Reposition the source highlight after the textarea scrolls (its boxes are
// positioned relative to the scroll offset).
function repositionFindHighlight() {
  if (!findState.open) return;
  const m = findState.matches[findState.current];
  if (m && (state.mode === 'source' || state.mode === 'split')) drawFindHighlightSource(m);
}

function findNext() {
  if (findState.matches.length === 0) return;
  findState.current = (findState.current + 1) % findState.matches.length;
  highlightMatch(findState.current);
  updateFindCount();
}
function findPrev() {
  if (findState.matches.length === 0) return;
  findState.current = (findState.current - 1 + findState.matches.length) % findState.matches.length;
  highlightMatch(findState.current);
  updateFindCount();
}
function replaceOne() {
  if (findState.matches.length === 0 || findState.current < 0) return;
  const ta = $('editor');
  const repl = $('find-replace').value;
  const m = findState.matches[findState.current];
  histCommit();
  ta.value = ta.value.slice(0, m.start) + repl + ta.value.slice(m.end);
  ta.selectionStart = ta.selectionEnd = m.start + repl.length;
  markDirty();
  scheduleRender();
  histCommit();
  recomputeMatches();
  // Advance to next match (now invalidated).
  if (findState.matches.length > 0) {
    findState.current = Math.min(findState.current, findState.matches.length - 1);
    highlightMatch(findState.current);
    updateFindCount();
  }
}
function replaceAll() {
  if (findState.matches.length === 0) return;
  const ta = $('editor');
  const repl = $('find-replace').value;
  // Walk matches in reverse so indices stay valid.
  let value = ta.value;
  const count = findState.matches.length;
  for (let i = findState.matches.length - 1; i >= 0; i--) {
    const m = findState.matches[i];
    value = value.slice(0, m.start) + repl + value.slice(m.end);
  }
  histCommit();
  ta.value = value;
  markDirty();
  scheduleRender();
  histCommit();
  recomputeMatches();
  status(`Replaced ${count}`);
}

// ---------- index card / beat board ----------
//
// Each scene = one card. Drag to reorder; on drop, we rewrite the Fountain
// source by reassembling scene blocks in the new order. Anything before the
// first scene heading (title page, preamble) stays at the top untouched.

const SCENE_HEADING_RE = /^(\.(?!\.)|(INT|EXT|EST|I\/E|INT\.\/EXT|INT\/EXT)[\.\s])/i;
const SECTION_HEADING_RE = /^#{1,6}\s+/;
function isSceneHeadingLine(line, includeSections) {
  const t = line.trim();
  if (!t) return false;
  if (SCENE_HEADING_RE.test(t)) return true;
  // Stage plays and outlines organize by `#` sections rather than INT/EXT
  // slugs; the beat board treats those as beats too so it isn't empty.
  if (includeSections && SECTION_HEADING_RE.test(t)) return true;
  return false;
}
function splitBySceneHeading(text, includeSections = false) {
  const lines = text.split('\n');
  const chunks = [];
  const preambleLines = [];
  let cur = null;
  for (const line of lines) {
    if (isSceneHeadingLine(line, includeSections)) {
      if (cur) chunks.push(cur);
      cur = { headLine: line.trim(), lines: [line] };
    } else if (cur) {
      cur.lines.push(line);
    } else {
      preambleLines.push(line);
    }
  }
  if (cur) chunks.push(cur);
  return {
    preamble: preambleLines.join('\n'),
    chunks: chunks.map(c => ({ head: c.headLine, body: c.lines.join('\n') })),
  };
}

function synopsisFor(chunk) {
  // First `= synopsis` line inside the chunk's body.
  for (const line of chunk.body.split('\n')) {
    const m = /^=\s+(.+)$/.exec(line);
    if (m) return m[1];
  }
  return '';
}
function previewFor(chunk) {
  // First action paragraph after the heading (skip blank / synopsis / section).
  for (const line of chunk.body.split('\n').slice(1)) {
    const t = line.trim();
    if (!t) continue;
    if (/^[=#~>]/.test(t)) continue;
    return t.length > 80 ? t.slice(0, 80) + '…' : t;
  }
  return '';
}

function openCards() {
  if (!state.currentPath) return;
  const text = $('editor').value;
  let { preamble, chunks } = splitBySceneHeading(text, true);

  const modal = $('modal-root');
  modal.classList.remove('hidden');
  modal.innerHTML = `
    <div class="modal modal-cards">
      <div class="modal-head">
        <h3>Beat board — drag to reorder scenes</h3>
        <div>
          <button id="cards-apply" class="apply-btn">Apply order</button>
          <button class="icon-btn" id="modal-close">×</button>
        </div>
      </div>
      <div class="modal-body">
        <div id="cards-grid" class="cards-grid"></div>
      </div>
    </div>`;
  const grid = $('cards-grid');

  function renderCards() {
    grid.innerHTML = '';
    chunks.forEach((c, i) => {
      const card = document.createElement('div');
      card.className = 'card';
      card.draggable = true;
      card.dataset.idx = i;
      card.innerHTML = `
        <div class="card-head">${escapeHtml(c.head.replace(/^\.(?!\.)/, '').replace(/^#{1,6}\s*/, ''))}</div>
        ${synopsisFor(c) ? `<div class="card-syn">${escapeHtml(synopsisFor(c))}</div>` : ''}
        <div class="card-prev">${escapeHtml(previewFor(c))}</div>
        <div class="card-num">${i + 1}</div>`;
      card.addEventListener('dragstart', (ev) => {
        ev.dataTransfer.setData('text/plain', String(i));
        ev.dataTransfer.effectAllowed = 'move';
        card.classList.add('dragging');
      });
      card.addEventListener('dragend', () => card.classList.remove('dragging'));
      card.addEventListener('dragover', (ev) => { ev.preventDefault(); ev.dataTransfer.dropEffect = 'move'; card.classList.add('drop-target'); });
      card.addEventListener('dragleave', () => card.classList.remove('drop-target'));
      card.addEventListener('drop', (ev) => {
        ev.preventDefault();
        card.classList.remove('drop-target');
        const from = parseInt(ev.dataTransfer.getData('text/plain'), 10);
        const to = i;
        if (from === to || isNaN(from)) return;
        const moved = chunks.splice(from, 1)[0];
        chunks.splice(to, 0, moved);
        renderCards();
      });
      grid.appendChild(card);
    });
  }
  renderCards();

  $('modal-close').onclick = () => modal.classList.add('hidden');
  $('cards-apply').onclick = () => {
    const newText = preamble +
      (preamble && !preamble.endsWith('\n') ? '\n' : '') +
      chunks.map(c => c.body).join('\n');
    histCommit();
    $('editor').value = newText;
    markDirty();
    scheduleRender();
    histCommit();
    modal.classList.add('hidden');
    status('Scenes reordered');
  };
}

// ---------- typewriter / focus mode ----------
function getTypewriter() { return !!loadPrefs().typewriter; }
function setTypewriter(v) { const p = loadPrefs(); p.typewriter = !!v; savePrefs(p); applyTypewriter(v); }
function applyTypewriter(on) {
  document.body.classList.toggle('typewriter', !!on);
  if (on) recenterCaret();
  status('Typewriter ' + (on ? 'on' : 'off'));
}
function toggleTypewriter() { setTypewriter(!document.body.classList.contains('typewriter')); }

function recenterCaret() {
  if (!document.body.classList.contains('typewriter')) return;
  if (state.mode === 'source' || state.mode === 'split') {
    recenterTextareaCaret($('editor'));
  }
  if (state.mode === 'view' || state.mode === 'split') {
    const el = focusedElem();
    if (el) recenterDomNode(el);
  }
}
function recenterTextareaCaret(ta) {
  const text = ta.value;
  const line = text.slice(0, ta.selectionStart).split('\n').length - 1;
  const total = Math.max(1, text.split('\n').length);
  const target = (ta.scrollHeight * line / total) - (ta.clientHeight / 2);
  ta.scrollTop = Math.max(0, target);
}
function recenterDomNode(el) {
  const pane = el.closest('.pane-view');
  if (!pane) return;
  const elRect = el.getBoundingClientRect();
  const paneRect = pane.getBoundingClientRect();
  const desiredCenter = paneRect.top + paneRect.height / 2;
  pane.scrollBy({ top: elRect.top - desiredCenter });
}

function trackActiveElem() {
  const cur = focusedElem();
  for (const e of document.querySelectorAll('.elem.elem-active')) e.classList.remove('elem-active');
  if (cur) cur.classList.add('elem-active');
}

// ---------- caret / selection mirror across panes ----------
function lineAtTextareaPos(ta, pos) {
  return ta.value.slice(0, Math.max(0, Math.min(pos, ta.value.length))).split('\n').length - 1;
}
function clearMirror() {
  for (const e of document.querySelectorAll('.mirror-caret, .mirror-highlight')) {
    e.classList.remove('mirror-caret', 'mirror-highlight');
  }
  // Unwrap any inline selection mirror spans.
  for (const m of document.querySelectorAll('.mirror-sel')) {
    const parent = m.parentNode;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
    parent.normalize();
  }
  $('source-faux-caret')?.classList.add('hidden');
  $('source-mirror-sel')?.classList.add('hidden');
  $('page-faux-caret')?.classList.add('hidden');
}

// Find the latest token whose srcLine ≤ requested line.
function tokenForSrcLine(srcLine) {
  if (!state.tokens) return null;
  let pick = null, pickIdx = -1;
  state.tokens.forEach((t, i) => {
    if (t.srcLine == null) return;
    if (t.srcLine <= srcLine) { pick = t; pickIdx = i; }
  });
  return pick ? { tok: pick, tokIdx: pickIdx } : null;
}

// Get the rect of a specific character offset inside an element. Returns
// null if the offset can't be located (e.g. element has no text nodes).
function rectAtTextOffset(elem, offset) {
  const walker = document.createTreeWalker(elem, NodeFilter.SHOW_TEXT);
  let acc = 0;
  while (walker.nextNode()) {
    const n = walker.currentNode;
    const len = n.length;
    // `>` not `>=` so offset == acc + len rolls forward to the next text
    // node (start of next visual line after a <br>).
    if (acc + len > offset) {
      const off = Math.max(0, Math.min(len, offset - acc));
      const r = document.createRange();
      r.setStart(n, off);
      r.setEnd(n, off);
      const rects = r.getClientRects();
      if (rects.length > 0) return rects[0];
      return r.getBoundingClientRect();
    }
    acc += len;
  }
  // Past end of text — anchor on the element's bottom-right.
  const er = elem.getBoundingClientRect();
  return { top: er.top, bottom: er.bottom, left: er.right, right: er.right, height: er.height, width: 0 };
}

// Position the page-side faux caret at the source position (line, col).
// Returns true on success.
function showPageFauxCaret(srcLine, srcCol) {
  const view = $('view');
  const pane = document.querySelector('.pane-view');
  const caret = $('page-faux-caret');
  if (!view || !pane || !caret) return false;

  const hit = tokenForSrcLine(srcLine);
  if (!hit) return false;
  const { tokIdx } = hit;
  const elem = view.querySelector(`.elem[data-tok-idx="${tokIdx}"]`);
  if (!elem) return false;

  // Char offset within the rendered .elem's textContent, derived from the same
  // rendered↔source alignment used in the page→source direction so it stays in
  // sync with soft-wrap-dropped spaces and stripped inline markers.
  const charOffset = renderedOffsetForSrc(elem, srcLine, srcCol);
  if (charOffset == null) return false;

  const rect = rectAtTextOffset(elem, charOffset);
  if (!rect) return false;
  const paneRect = pane.getBoundingClientRect();
  const top = rect.top - paneRect.top + pane.scrollTop;
  const left = rect.left - paneRect.left + pane.scrollLeft;
  const height = rect.height || parseFloat(getComputedStyle(elem).lineHeight) || 16;
  caret.style.top = top + 'px';
  caret.style.left = left + 'px';
  caret.style.height = height + 'px';
  caret.classList.remove('hidden');
  return true;
}

function colAtTextareaPos(ta, pos) {
  const text = ta.value;
  const lineStart = text.lastIndexOf('\n', Math.max(0, pos - 1)) + 1;
  return pos - lineStart;
}

// Length of an inline Fountain marker starting at index `i` in `line`, or 0.
function markerLenAt(line, i) {
  if (line.startsWith('***', i)) return 3;
  if (line.startsWith('**', i)) return 2;
  const c = line[i];
  if (c === '*' || c === '_') return 1;
  if (line.startsWith('[[', i)) {
    const end = line.indexOf(']]', i);
    if (end >= 0) return end + 2 - i;
  }
  return 0;
}

// Build a per-character map between an .elem's rendered textContent and its
// source token. Returns { tok, map } where map[k] = { li, ci }: the source
// line offset (relative to tok.srcLine) and column of the k-th rendered char,
// with map[len] being the position just past the end.
//
// We align by walking the rendered text against the source with a dual cursor,
// skipping whatever the renderer removed: spaces dropped at soft-wrap points
// (wrapLines re-flows long lines and drops the boundary space), stripped inline
// emphasis markers, and source newlines folded into <br>. Matching the rendered
// char directly first means literal markers and "show markup" output map too,
// and a case-insensitive fallback absorbs scene/transition upper-casing.
//
// Crucially we align against the RAW source lines, not tok.text: the parser has
// already stripped block prefixes from tok.text ("= " synopsis, "# " section,
// "~ " lyric, "! " forced action, "@" forced character, "> " transition, "."
// forced scene, "> … <" centered). Those prefixes still occupy columns in the
// textarea, so aligning against the raw line — letting the skip-dropped-char
// step below consume the prefix — keeps map columns in the same coordinate space
// as the textarea caret. Otherwise the page caret lands a few characters off on
// every prefixed line.
function buildElemMap(elem) {
  if (!elem) return null;
  const tokIdx = parseInt(elem.dataset.tokIdx, 10);
  if (Number.isNaN(tokIdx)) return null;
  const tok = state.tokens[tokIdx];
  if (!tok || tok.srcLine == null) return null;
  const lineCount = (tok.text || '').split('\n').length;
  const allLines = $('editor').value.split('\n');
  let srcLines = allLines.slice(tok.srcLine, tok.srcLine + lineCount);
  if (srcLines.length === 0) srcLines = (tok.text || '').split('\n');
  const rendered = elem.textContent || '';
  const map = new Array(rendered.length + 1);
  let li = 0, ci = 0;
  const atEnd = () => li >= srcLines.length;
  for (let k = 0; k < rendered.length; k++) {
    const rc = rendered[k];
    let guard = 0;
    while (!atEnd() && guard++ < 8000) {
      const line = srcLines[li];
      if (ci >= line.length) { li++; ci = 0; continue; }   // crossed a newline
      const sc = line[ci];
      if (sc === rc || sc.toLowerCase() === rc.toLowerCase()) break; // matched
      const mk = markerLenAt(line, ci);
      if (mk) { ci += mk; continue; }                       // skip a marker
      ci++;                                                 // skip dropped char
    }
    map[k] = { li: Math.min(li, srcLines.length - 1), ci };
    if (!atEnd() && ci < srcLines[li].length) ci++;         // consume matched char
  }
  while (!atEnd() && li < srcLines.length - 1 && ci >= srcLines[li].length) { li++; ci = 0; }
  map[rendered.length] = { li: Math.min(li, srcLines.length - 1), ci };
  return { tok, map };
}

// Source (line, col) → rendered textContent offset within an .elem.
function renderedOffsetForSrc(elem, srcLine, srcCol) {
  const built = buildElemMap(elem);
  if (!built) return null;
  const tLi = srcLine - built.tok.srcLine;
  const map = built.map;
  for (let k = 0; k < map.length; k++) {
    const m = map[k];
    if (m.li > tLi || (m.li === tLi && m.ci >= srcCol)) return k;
  }
  return map.length - 1;
}

// Walk an .elem's text nodes and find the textContent offset of a given
// (node, offset-in-node) pair from a Range/Selection anchor.
function textContentOffsetInElem(elem, node, offsetInNode) {
  if (!elem || !node) return 0;
  const walker = document.createTreeWalker(elem, NodeFilter.SHOW_TEXT);
  let acc = 0;
  while (walker.nextNode()) {
    if (walker.currentNode === node) return acc + offsetInNode;
    acc += walker.currentNode.length;
  }
  return acc;
}

// Given an .elem + a textContent offset, return the matching source
// (line, col). Handles multi-line tokens (action paragraphs).
function srcPosFromElemOffset(elem, textOffset) {
  const built = buildElemMap(elem);
  if (!built) return null;
  const map = built.map;
  const idx = Math.max(0, Math.min(textOffset, map.length - 1));
  const p = map[idx];
  return { srcLine: built.tok.srcLine + p.li, srcCol: p.ci };
}

// Convert a source (line, col) into a flat character index in the textarea.
function lineColToCharIdx(ta, line, col) {
  const lines = ta.value.split('\n');
  let off = 0;
  for (let i = 0; i < line && i < lines.length; i++) off += lines[i].length + 1;
  return off + Math.min(col, (lines[line] || '').length);
}

// Measure the pixel position of a character index inside the textarea using a
// hidden mirror div that replicates the textarea's box + text styling. This is
// wrap-aware: long source lines that the textarea soft-wraps onto several
// visual rows are accounted for, unlike a flat `line * lineHeight` estimate
// (which placed the caret/selection a few rows too high). Returned top/left are
// relative to the textarea's border-box top-left, before scroll is applied.
let _taCaretMirror = null;
// Configure (creating if needed) the hidden mirror div so it lays out text
// identically to the textarea — same box metrics, wrapping, and glyph spacing.
function configTaMirror(ta) {
  const cs = getComputedStyle(ta);
  let div = _taCaretMirror;
  if (!div) {
    div = _taCaretMirror = document.createElement('div');
    div.setAttribute('aria-hidden', 'true');
    document.body.appendChild(div);
  }
  const s = div.style;
  s.position = 'absolute';
  s.visibility = 'hidden';
  s.top = '0';
  s.left = '-9999px';
  s.whiteSpace = 'pre-wrap';
  s.overflowWrap = 'break-word';
  const props = ['boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom',
    'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth',
    'borderLeftWidth', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle',
    'lineHeight', 'letterSpacing', 'wordSpacing', 'textTransform', 'textIndent',
    'tabSize', 'wordBreak'];
  for (const p of props) s[p] = cs[p];
  // cs.width is the content-box width even under border-box; force border-box so
  // the copied padding/border don't widen the mirror past the textarea.
  s.boxSizing = 'border-box';
  s.width = ta.clientWidth + 'px';
  return div;
}

function textareaCaretCoords(ta, index) {
  const cs = getComputedStyle(ta);
  const div = configTaMirror(ta);
  div.textContent = ta.value.slice(0, index);
  const span = document.createElement('span');
  // A non-empty span so it has a layout box even at end-of-text / end-of-line.
  span.textContent = ta.value.slice(index) || '.';
  div.appendChild(span);
  const top = span.offsetTop;
  const left = span.offsetLeft;
  const height = parseFloat(cs.lineHeight) || span.offsetHeight;
  div.textContent = '';
  return { top, left, height };
}

// Pixel rectangles covering the [start, end) character range in the textarea,
// one per wrapped visual line. Coordinates are relative to the textarea's
// border-box top-left (before scroll), matching textareaCaretCoords — so an
// overlay in .pane-edit positions a box at `rect.top - ta.scrollTop`, etc.
function textareaRangeRects(ta, start, end) {
  const div = configTaMirror(ta);
  div.textContent = '';
  div.appendChild(document.createTextNode(ta.value.slice(0, start)));
  const span = document.createElement('span');
  span.textContent = ta.value.slice(start, end);
  div.appendChild(span);
  div.appendChild(document.createTextNode(ta.value.slice(end)));
  const mr = div.getBoundingClientRect();
  const rects = [...span.getClientRects()].map(r => ({
    top: r.top - mr.top, left: r.left - mr.left, width: r.width, height: r.height,
  }));
  div.textContent = '';
  return rects;
}

// Place a blinking caret-shaped overlay inside the source textarea at the
// given source (line, col). We don't focus the textarea — that would steal
// the user's typing context from the page.
function showSourceFauxCaret(srcLine, srcCol) {
  const ta = $('editor');
  const caret = $('source-faux-caret');
  if (!ta || !caret) return;
  const c = textareaCaretCoords(ta, lineColToCharIdx(ta, srcLine, srcCol || 0));
  caret.style.top = (c.top - ta.scrollTop) + 'px';
  caret.style.left = (c.left - ta.scrollLeft) + 'px';
  caret.style.height = c.height + 'px';
  caret.classList.remove('hidden');
}

// Show a block-level selection overlay in the source textarea, covering the
// lines spanned by [startLine, endLine] inclusive. Used to mirror a page
// selection back into the unfocused source, since browsers hide unfocused
// textarea selection highlights. Wrap-aware: the block grows to cover every
// visual row the spanned source lines occupy.
function showSourceMirrorSel(startLine, endLine) {
  const ta = $('editor');
  const sel = $('source-mirror-sel');
  if (!ta || !sel) return;
  if (endLine < startLine) [startLine, endLine] = [endLine, startLine];
  const cs = getComputedStyle(ta);
  const padLeft = parseFloat(cs.paddingLeft) || 0;
  const padRight = parseFloat(cs.paddingRight) || 0;
  const lines = ta.value.split('\n');
  const top = textareaCaretCoords(ta, lineColToCharIdx(ta, startLine, 0));
  const bot = textareaCaretCoords(ta, lineColToCharIdx(ta, endLine, (lines[endLine] || '').length));
  const y = top.top - ta.scrollTop;
  const h = (bot.top + bot.height) - top.top;
  sel.style.top = y + 'px';
  sel.style.left = padLeft + 'px';
  sel.style.right = padRight + 'px';
  sel.style.height = h + 'px';
  sel.classList.remove('hidden');
}

// Wrap a character range inside an element with a <span class="mirror-sel">
// so the visual "selection" mirror persists across pane focus. Walks text
// nodes so it works even when the .elem contains inline emphasis spans.
function wrapRangeInElem(el, startIdx, len) {
  if (len <= 0) return;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let acc = 0, startNode = null, startOff = 0, endNode = null, endOff = 0;
  while (walker.nextNode()) {
    const n = walker.currentNode;
    const nlen = n.nodeValue.length;
    if (!startNode && acc + nlen > startIdx) {
      startNode = n; startOff = startIdx - acc;
    }
    if (startNode && acc + nlen >= startIdx + len) {
      endNode = n; endOff = startIdx + len - acc; break;
    }
    acc += nlen;
  }
  if (!startNode || !endNode) return;
  const range = document.createRange();
  try {
    range.setStart(startNode, startOff);
    range.setEnd(endNode, endOff);
    const mark = document.createElement('span');
    mark.className = 'mirror-sel';
    range.surroundContents(mark);
  } catch (_) { /* range crossed an element boundary — fall through */ }
}
function elemForSrcLine(srcLine) {
  // Latest .elem with srcLine ≤ requested line (the cursor sits inside that
  // element's source range, until the next anchored .elem starts).
  const all = document.querySelectorAll('#view .elem[data-src-line]');
  let pick = null;
  for (const el of all) {
    const ln = parseInt(el.dataset.srcLine, 10);
    if (ln <= srcLine) pick = el;
    else break;
  }
  return pick;
}

function mirrorFromSource() {
  if (state.mode !== 'split') return;
  const ta = $('editor');
  if (document.activeElement !== ta) return;
  clearMirror();

  const ss = ta.selectionStart, se = ta.selectionEnd;
  const startLine = lineAtTextareaPos(ta, ss);
  const startCol  = colAtTextareaPos(ta, ss);
  const endLine = lineAtTextareaPos(ta, se);
  const elStart = elemForSrcLine(startLine);
  const elEnd   = elemForSrcLine(endLine);

  if (ss === se) {
    showPageFauxCaret(startLine, startCol);
    return;
  }

  if (elStart && elStart === elEnd) {
    // Char-level mirror within a single element: project the source span
    // onto the rendered textContent by counting from the elem's first source
    // character. We use the matching substring search to absorb inline
    // emphasis markers being stripped by the renderer.
    const selectedText = ta.value.slice(ss, se);
    // Strip Fountain inline markers so the needle matches rendered output.
    const needle = selectedText
      .replace(/\[\[[^\]]+\]\]/g, '')
      .replace(/\*\*\*|\*\*|\*|_/g, '');
    if (needle.length >= 1) {
      const tc = elStart.textContent || '';
      const idx = tc.indexOf(needle);
      if (idx >= 0) {
        wrapRangeInElem(elStart, idx, needle.length);
        return;
      }
    }
    // Fallback: highlight the whole element.
    elStart.classList.add('mirror-highlight');
    return;
  }

  // Multi-element selection: highlight each .elem in the source range.
  for (const el of document.querySelectorAll('#view .elem[data-src-line]')) {
    const ln = parseInt(el.dataset.srcLine, 10);
    if (ln >= startLine && ln <= endLine) el.classList.add('mirror-highlight');
  }
}


// ---------- command palette ----------
const PALETTE_COMMANDS = [
  { label: 'Save',                   action: 'save',          group: 'File',    hint: 'Ctrl+S' },
  { label: 'New script',             action: 'new',           group: 'File',    hint: 'Ctrl+N' },
  { label: 'Export PDF',             action: 'export',        group: 'File',    hint: 'Ctrl+Shift+S' },
  { label: 'Export Final Draft (.fdx)', action: () => exportFdx(),     group: 'File' },
  { label: 'Import Final Draft (.fdx)…', action: () => importFdx(),    group: 'File' },
  { label: 'Version history',        action: 'history',       group: 'File' },

  { label: 'Read view',              action: 'mode-view',     group: 'View',    hint: 'Ctrl+E' },
  { label: 'Edit (source + preview)', action: 'mode-split',   group: 'View',    hint: 'Ctrl+E' },
  { label: 'Source only',            action: 'mode-source',   group: 'View' },
  { label: 'Fullscreen',             action: 'fullscreen',    group: 'View' },
  { label: 'Toggle scroll sync',     action: () => toggleSplitSync(), group: 'View' },
  { label: 'Align panes now',        action: () => syncNow(),         group: 'View' },
  { label: 'Performance mode',       action: 'perform',       group: 'View',    hint: 'Ctrl+Shift+P' },
  { label: 'Toggle sidebar',         action: 'toggle-sidebar',group: 'View',    hint: 'Ctrl+\\' },
  { label: 'Theme…',                 action: 'theme',         group: 'View',    hint: 'Ctrl+Shift+T' },
  { label: 'Zoom in',                action: 'zoom-in',       group: 'View',    hint: 'Ctrl+=' },
  { label: 'Zoom out',               action: 'zoom-out',      group: 'View',    hint: 'Ctrl+-' },
  { label: 'Reset zoom',             action: 'zoom-reset',    group: 'View',    hint: 'Ctrl+0' },

  { label: 'Find',                   action: () => openFind(),         group: 'Search', hint: 'Ctrl+F' },
  { label: 'Find & replace',         action: () => { openFind(); $('find-replace').focus(); }, group: 'Search', hint: 'Ctrl+H' },

  { label: 'Scene heading',          action: 'elem-scene',    group: 'Element', hint: 'Ctrl+1' },
  { label: 'Action',                 action: 'elem-action',   group: 'Element', hint: 'Ctrl+2' },
  { label: 'Character cue',          action: 'elem-character',group: 'Element', hint: 'Ctrl+3' },
  { label: 'Parenthetical',          action: 'elem-paren',    group: 'Element', hint: 'Ctrl+4' },
  { label: 'Dialogue',               action: 'elem-dialogue', group: 'Element', hint: 'Ctrl+5' },
  { label: 'Transition',             action: 'elem-transition', group: 'Element', hint: 'Ctrl+6' },

  { label: 'Bold',                   action: 'bold',          group: 'Format',  hint: 'Ctrl+B' },
  { label: 'Italic',                 action: 'italic',        group: 'Format',  hint: 'Ctrl+I' },
  { label: 'Underline',              action: 'underline',     group: 'Format',  hint: 'Ctrl+U' },
  { label: 'Note',                   action: 'note',          group: 'Format',  hint: 'Ctrl+/' },
  { label: 'Page break',             action: 'pagebreak',     group: 'Format',  hint: 'Ctrl+;' },
  { label: 'Dual dialogue',          action: 'dual',          group: 'Format',  hint: 'Ctrl+Shift+D' },

  { label: 'Show markup',            action: () => toggleMarkup(),     group: 'View' },
  { label: 'Toggle spellcheck',      action: () => toggleSpellcheck(), group: 'View' },
  { label: 'Spellcheck language…',   action: () => openSpellPicker(),  group: 'View' },
  { label: 'Help & shortcuts',       action: 'help',          group: 'Help',    hint: 'F1' },
  { label: 'Production stats',       action: () => openStats(),        group: 'Tools' },
  { label: 'Cast list (dramatis personae)…', action: () => openCastList(), group: 'Tools' },
  { label: 'Review notes…',          action: () => openNotesReview(),  group: 'Tools' },
  { label: 'Beat board (index cards)', action: () => openCards(),      group: 'Tools' },
  { label: 'Export character sides…', action: () => exportSides(),     group: 'Tools' },
  { label: 'Rehearse a character…',   action: () => openRehearsalPicker(), group: 'Tools' },
  { label: 'Read aloud (TTS)',         action: () => ttsToggle(),       group: 'Tools' },
  { label: 'Export cue sheet (radio)', action: () => exportCueSheet(),  group: 'Tools' },
  { label: 'Edit title page…',         action: () => openTitlePageEditor(), group: 'Tools' },
];

async function exportCueSheet() {
  if (!state.currentPath) return;
  status('Generating cue sheet…');
  const res = await fetch('/api/export/cue-sheet?path=' + encodeURIComponent(state.currentPath));
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    status('Cue sheet failed: ' + (e.error || res.status), true); return;
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = state.currentPath.replace(/\.[^.]+$/, '') + '-cue-sheet.pdf';
  a.click();
  URL.revokeObjectURL(url);
  status('Exported cue sheet');
}

function buildPaletteItems() {
  const items = [...PALETTE_COMMANDS];
  // Scene and section jumps from the current script.
  if (state.tokens) {
    let sceneN = 0, sectionN = 0;
    for (const t of state.tokens) {
      if (t.type === 'section') {
        sectionN++;
        const target = 'section-' + sectionN;
        items.push({
          label: 'Go to section: ' + t.text,
          group: 'Sections',
          action: () => jumpToTarget(target),
        });
      } else if (t.type === 'scene') {
        sceneN++;
        const target = 'scene-' + sceneN;
        items.push({
          label: 'Go to scene: ' + t.text,
          group: 'Scenes',
          action: () => jumpToTarget(target),
        });
      }
    }
  }
  // Character jumps (first cue of each character).
  if (state.tokens) {
    const seen = new Set();
    let n = 0;
    for (const t of state.tokens) {
      if (t.type === 'character') {
        const name = (t.text || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        // Find the nth scene we're in so we can scroll. Simpler: just find
        // the first .elem-character whose textContent matches.
        items.push({
          label: 'Find first cue: ' + name,
          group: 'Characters',
          action: () => {
            const ta = $('editor');
            const idx = ta.value.indexOf(name);
            if (idx >= 0) {
              ta.focus();
              ta.setSelectionRange(idx, idx + name.length);
            }
          },
        });
      }
    }
  }
  return items;
}

function paletteFilter(items, q) {
  if (!q) return items.slice(0, 50);
  const s = q.toLowerCase();
  // Subsequence match → score = inverse position spread.
  return items
    .map(it => {
      const label = it.label.toLowerCase();
      let i = 0, last = -1, spread = 0;
      for (const ch of s) {
        const idx = label.indexOf(ch, i);
        if (idx < 0) return null;
        if (last >= 0) spread += idx - last;
        last = idx;
        i = idx + 1;
      }
      return { it, score: spread + label.length };
    })
    .filter(Boolean)
    .sort((a, b) => a.score - b.score)
    .slice(0, 50)
    .map(x => x.it);
}

function openPalette() {
  const modal = $('modal-root');
  modal.classList.remove('hidden');
  modal.innerHTML = `
    <div class="modal modal-palette">
      <input id="palette-input" class="palette-input" type="search" placeholder="Type a command, scene, or character…" autocomplete="off" />
      <ul id="palette-list" class="palette-list"></ul>
    </div>`;
  const all = buildPaletteItems();
  let items = paletteFilter(all, '');
  let active = 0;
  const input = $('palette-input');
  const list = $('palette-list');

  const renderList = () => {
    list.innerHTML = '';
    items.forEach((it, i) => {
      const li = document.createElement('li');
      li.className = 'palette-item' + (i === active ? ' active' : '');
      li.innerHTML = `
        <span class="pal-label">${escapeHtml(it.label)}</span>
        <span class="pal-meta">${escapeHtml(it.group || '')}${it.hint ? ' · ' + escapeHtml(it.hint) : ''}</span>`;
      li.onmousedown = (ev) => { ev.preventDefault(); pick(i); };
      list.appendChild(li);
    });
  };

  const pick = (idx) => {
    const it = items[idx];
    modal.classList.add('hidden');
    if (!it) return;
    if (typeof it.action === 'function') it.action();
    else runCmd(it.action);
  };

  input.oninput = () => {
    items = paletteFilter(all, input.value);
    active = 0;
    renderList();
  };
  input.onkeydown = (ev) => {
    if (ev.key === 'ArrowDown') { ev.preventDefault(); active = Math.min(items.length - 1, active + 1); renderList(); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); active = Math.max(0, active - 1); renderList(); }
    else if (ev.key === 'Enter') { ev.preventDefault(); pick(active); }
    else if (ev.key === 'Escape') { ev.preventDefault(); modal.classList.add('hidden'); }
  };

  renderList();
  input.focus();
}

// ---------- show markup toggle ----------
function getShowMarkup() { return !!loadPrefs().showMarkup; }
function setShowMarkup(v) { const p = loadPrefs(); p.showMarkup = !!v; savePrefs(p); applyMarkupToggle(v); }
function applyMarkupToggle(on) {
  document.body.classList.toggle('show-markup', !!on);
  const cb = $('show-markup');
  if (cb) cb.checked = !!on;
  // Re-render so the inline emphasis spans use the right helper.
  if (state.currentPath) render($('editor').value);
}
function toggleMarkup() { setShowMarkup(!document.body.classList.contains('show-markup')); }

// ---------- spellcheck ----------
// Uses the browser's built-in spellchecker. Which dictionary it uses follows
// the editor's `lang` attribute — so you can spellcheck Norwegian (or any
// language whose dictionary is installed in your browser/OS), not just English.
const SPELL_LANGS = [
  { code: 'en', label: 'English' },
  { code: 'nb', label: 'Norsk (bokmål)' },
  { code: 'nn', label: 'Norsk (nynorsk)' },
  { code: 'sv', label: 'Svenska' },
  { code: 'da', label: 'Dansk' },
  { code: 'de', label: 'Deutsch' },
  { code: 'fr', label: 'Français' },
  { code: 'es', label: 'Español' },
];
function getSpellcheck() { return !!loadPrefs().spellcheck; }
function getSpellLang() { return loadPrefs().spellLang || 'en'; }
function setSpellcheck(v) { const p = loadPrefs(); p.spellcheck = !!v; savePrefs(p); applySpellcheck(); }
function setSpellLang(code) { const p = loadPrefs(); p.spellLang = code; savePrefs(p); applySpellcheck(); }
function applySpellcheck() {
  const ta = $('editor');
  if (!ta) return;
  const on = getSpellcheck();
  ta.spellcheck = on;
  ta.lang = getSpellLang();
  if (on) {
    // Force the spellchecker to re-scan with the new language.
    const active = document.activeElement === ta;
    ta.blur();
    if (active) ta.focus();
  }
}
function toggleSpellcheck() {
  const on = !getSpellcheck();
  setSpellcheck(on);
  const lang = SPELL_LANGS.find(l => l.code === getSpellLang());
  status('Spellcheck ' + (on ? 'on (' + (lang ? lang.label : getSpellLang()) + ')' : 'off'));
}
function openSpellPicker() {
  const modal = $('modal-root');
  modal.classList.remove('hidden');
  const cur = getSpellLang();
  const opts = SPELL_LANGS.map(l =>
    `<option value="${l.code}" ${l.code === cur ? 'selected' : ''}>${escapeHtml(l.label)}</option>`).join('');
  modal.innerHTML = `
    <div class="modal">
      <div class="modal-head"><h3>Spellcheck</h3><button class="icon-btn" id="modal-close">×</button></div>
      <div class="modal-body">
        <label class="spell-row"><input type="checkbox" id="spell-on" ${getSpellcheck() ? 'checked' : ''}> Check spelling in the editor</label>
        <label class="spell-row">Language
          <select id="spell-lang" style="margin-left:0.5rem; padding:0.3rem; font:0.9rem var(--ui);">${opts}</select>
        </label>
        <p class="stat-note">The dictionary must be installed in your browser or operating system.
           Norwegian and other languages may need a one-time dictionary download in your OS language settings.</p>
      </div>
    </div>`;
  $('modal-close').onclick = () => modal.classList.add('hidden');
  $('spell-on').onchange = (e) => setSpellcheck(e.target.checked);
  $('spell-lang').onchange = (e) => { setSpellLang(e.target.value); if (getSpellcheck()) status('Spellcheck language set'); };
}

// ---------- editor commands ----------
// All commands operate on the textarea. Element conversions rewrite the
// current line; inline formatters wrap the current selection; insertions
// drop a snippet at the cursor with sensible cursor placement.

function stripMarkers(s) {
  return s.replace(/^[\s@!>.~#=]+/, '').replace(/^\(/, '').replace(/\)\s*$/, '').replace(/\s+$/, '');
}

function convertCurrentLine(kind) {
  const ta = $('editor');
  const line = getCurrentLine(ta);
  const stripped = stripMarkers(line.text);
  let newText;
  switch (kind) {
    case 'scene':
      // Natural slug if it already begins with INT/EXT/EST. An empty line seeds
      // a natural slug (matches the samples); a named line that isn't a slug is
      // forced with a leading dot (the only valid Fountain way to mark it).
      if (/^(INT|EXT|EST|I\/E|INT\.\/EXT|INT\/EXT)[\.\s]/i.test(stripped)) {
        newText = stripped.toUpperCase();
      } else if (!stripped) {
        newText = 'INT. NEW SCENE - DAY';
      } else {
        newText = '.' + stripped.toUpperCase();
      }
      break;
    case 'action':
      newText = stripped;
      break;
    case 'character':
      newText = '@' + (stripped ? stripped.toUpperCase() : 'NAME');
      break;
    case 'parenthetical':
      newText = '(' + (stripped || '...') + ')';
      break;
    case 'dialogue':
      // Dialogue is dialogue by virtue of position (after a character cue).
      // We strip any markers but otherwise leave content alone.
      newText = stripped;
      break;
    case 'transition':
      newText = '> ' + (stripped ? stripped.toUpperCase().replace(/:?$/, ':') : 'CUT TO:');
      break;
    default:
      return;
  }
  replaceLine(ta, line, newText);
  status('Line → ' + kind);
}

function getTaSelection(ta) {
  return {
    start: ta.selectionStart,
    end: ta.selectionEnd,
    text: ta.value.slice(ta.selectionStart, ta.selectionEnd),
  };
}
function spliceText(ta, start, end, replacement, selStart, selEnd) {
  histCommit();   // seal any prior pending edit so this op is its own step
  ta.value = ta.value.slice(0, start) + replacement + ta.value.slice(end);
  if (selStart === undefined) {
    ta.selectionStart = ta.selectionEnd = start + replacement.length;
  } else {
    ta.selectionStart = selStart; ta.selectionEnd = selEnd ?? selStart;
  }
  markDirty();
  scheduleRender();
  histCommit();   // seal this op as a discrete undo step
}

function wrapSelection(open, close, placeholder) {
  const ta = $('editor');
  const sel = getTaSelection(ta);
  if (sel.start === sel.end) {
    // No selection: insert markers and place cursor between.
    const ins = open + (placeholder || '') + close;
    spliceText(ta, sel.start, sel.end, ins,
      sel.start + open.length,
      sel.start + open.length + (placeholder || '').length);
  } else {
    // Toggle: if the selection is already wrapped, unwrap.
    const before = ta.value.slice(Math.max(0, sel.start - open.length), sel.start);
    const after = ta.value.slice(sel.end, sel.end + close.length);
    if (before === open && after === close) {
      const start = sel.start - open.length;
      spliceText(ta, start, sel.end + close.length, sel.text, start, start + sel.text.length);
    } else {
      const wrapped = open + sel.text + close;
      spliceText(ta, sel.start, sel.end, wrapped,
        sel.start + open.length,
        sel.start + open.length + sel.text.length);
    }
  }
  ta.focus();
}

function insertAtLineStart(prefix, placeholder) {
  const ta = $('editor');
  const line = getCurrentLine(ta);
  const newText = prefix + (line.text.trim() || (placeholder || ''));
  replaceLine(ta, line, newText);
  ta.focus();
}

function insertBlock(text, afterBlankLine = true) {
  const ta = $('editor');
  const start = ta.selectionStart;
  // Walk to end of current line.
  const lineEnd = ta.value.indexOf('\n', start);
  const insertAt = lineEnd < 0 ? ta.value.length : lineEnd;
  const prefix = afterBlankLine ? '\n\n' : '\n';
  const ins = prefix + text + (text.endsWith('\n') ? '' : '\n');
  spliceText(ta, insertAt, insertAt, ins, insertAt + ins.length);
  ta.focus();
}

function makeDualDialogue() {
  // Find the most recent character cue at or before the cursor and add `^`.
  const ta = $('editor');
  const text = ta.value;
  const pos = ta.selectionStart;
  // Walk backwards line by line.
  let i = pos;
  while (i > 0) {
    const lineStart = text.lastIndexOf('\n', i - 1) + 1;
    const lineEnd = text.indexOf('\n', lineStart);
    const lineText = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
    const trimmed = lineText.trim();
    if (trimmed && /^@/.test(trimmed)) {
      // Forced character; append ^.
      const updated = lineText.replace(/\s*\^?\s*$/, '') + ' ^';
      spliceText(ta, lineStart, lineEnd < 0 ? text.length : lineEnd, updated);
      status('Marked dual dialogue');
      return;
    }
    if (trimmed && trimmed === trimmed.toUpperCase() && /[A-Z]/.test(trimmed)) {
      const updated = lineText.replace(/\s*\^?\s*$/, '') + ' ^';
      spliceText(ta, lineStart, lineEnd < 0 ? text.length : lineEnd, updated);
      status('Marked dual dialogue');
      return;
    }
    if (lineStart === 0) break;
    i = lineStart - 1;
  }
  status('No character cue found to mark as dual', true);
}

function insertContd() {
  const ta = $('editor');
  // Insert (CONT'D) at end of nearest character cue above cursor.
  const text = ta.value;
  const pos = ta.selectionStart;
  let i = pos;
  while (i > 0) {
    const ls = text.lastIndexOf('\n', i - 1) + 1;
    const le = text.indexOf('\n', ls);
    const lineText = text.slice(ls, le < 0 ? text.length : le);
    const trimmed = lineText.trim();
    if (trimmed && (/^@/.test(trimmed) || (trimmed === trimmed.toUpperCase() && /[A-Z]/.test(trimmed)))) {
      if (/\(CONT'D\)\s*\^?\s*$/.test(lineText)) return; // already
      const updated = lineText.replace(/(\s*\^?\s*)$/, " (CONT'D)$1");
      spliceText(ta, ls, le < 0 ? text.length : le, updated);
      return;
    }
    if (ls === 0) break;
    i = ls - 1;
  }
}

// The page view is read-only, so all toolbar/menu commands act on the source.
// Element-type changes convert the source line at the caret (clicking a page
// element parks the caret on its line); inline formatting wraps the current
// source selection.
function applyElementCommand(kind) {
  convertCurrentLine(kind);
}

function applyInlineCommand(open, close, placeholder) {
  wrapSelection(open, close, placeholder);
}

// Map command name → action.
const CMDS = {
  save: () => saveScript(),
  undo: () => histUndo(),
  redo: () => histRedo(),

  'elem-scene':       () => applyElementCommand('scene'),
  'elem-action':      () => applyElementCommand('action'),
  'elem-character':   () => applyElementCommand('character'),
  'elem-paren':       () => applyElementCommand('parenthetical'),
  'elem-dialogue':    () => applyElementCommand('dialogue'),
  'elem-transition':  () => applyElementCommand('transition'),

  bold:      () => applyInlineCommand('**', '**', 'bold text'),
  italic:    () => applyInlineCommand('*',  '*',  'italic text'),
  underline: () => applyInlineCommand('_',  '_',  'underlined text'),

  section:   () => insertAtLineStart('# ',  'Section title'),
  synopsis:  () => insertAtLineStart('= ',  'Synopsis'),
  centered:  () => {
    const ta = $('editor'); const sel = getTaSelection(ta);
    const body = sel.text || 'CENTERED';
    const line = getCurrentLine(ta);
    replaceLine(ta, line, '> ' + body + ' <');
  },
  lyric:     () => insertAtLineStart('~ ', 'lyric'),
  note:      () => applyInlineCommand('[[', ']]', 'note'),
  pagebreak: () => insertBlock('==='),

  dual:  makeDualDialogue,
  contd: insertContd,
  more:  () => {
    const ta = $('editor');
    insertBlock('(MORE)', true);
  },

  'toggle-sidebar': toggleSidebar,
  'typewriter':     toggleTypewriter,
  'zoom-in':    zoomIn,
  'zoom-out':   zoomOut,
  'zoom-reset': zoomReset,
  'theme':          openThemePicker,
  'help':           openHelp,
  'perform':        togglePerform,
  'bookmark':       addBookmark,
  'export':         exportPdf,
  'history':        openHistory,
  'new':            newScript,
  'mode-view':      () => setMode('view'),
  'mode-edit':      () => setMode('edit'),
  'mode-split':     () => setMode('split'),
  'mode-source':    () => setMode('source'),
  'fullscreen':     toggleFullscreen,
};

function runCmd(name) {
  const fn = CMDS[name];
  if (!fn) { console.warn('unknown cmd', name); return; }
  fn();
}

// ---------- theme picker ----------
const THEMES = [
  { id: 'paper',   name: 'Paper',         desc: 'Cream page, dark ink — industry default' },
  { id: 'light',   name: 'Light',         desc: 'Clean white with soft shadow' },
  { id: 'sepia',   name: 'Sepia',         desc: 'Warm parchment tones' },
  { id: 'dark',   name: 'Dark',          desc: 'Off-white on charcoal' },
  { id: 'night',   name: 'Night',         desc: 'Very low light, warm tint' },
  { id: 'hicon',   name: 'High contrast', desc: 'Pure white background, black ink' },
];
function openThemePicker() {
  const modal = $('modal-root');
  modal.classList.remove('hidden');
  const current = getTheme();
  const cards = THEMES.map(t => `
    <button class="theme-card ${t.id === current ? 'active' : ''}" data-theme="${t.id}">
      <div class="theme-swatch theme-${t.id}">
        <div class="sw-page"><div class="sw-line"></div><div class="sw-line short"></div></div>
      </div>
      <div class="theme-name">${t.name}</div>
      <div class="theme-desc">${escapeHtml(t.desc)}</div>
    </button>`).join('');
  const ui = getUiScale();
  modal.innerHTML = `
    <div class="modal">
      <div class="modal-head"><h3>Appearance</h3><button class="icon-btn" id="modal-close">×</button></div>
      <div class="modal-body">
        <div class="ui-scale-row">
          <label for="ui-scale-slider"><strong>UI text size</strong>
            <span class="ui-scale-val" id="ui-scale-val">${Math.round(ui * 100)}%</span></label>
          <input id="ui-scale-slider" type="range" min="${UI_MIN}" max="${UI_MAX}" step="0.05" value="${ui}" />
          <div class="ui-scale-hint">Sidebar, toolbars, modals — independent of document zoom.</div>
        </div>
        <h4 style="margin-top:1rem">Theme</h4>
        <div class="theme-grid">${cards}</div>
      </div>
    </div>`;
  $('modal-close').onclick = () => modal.classList.add('hidden');
  for (const card of modal.querySelectorAll('.theme-card')) {
    card.onclick = () => {
      setTheme(card.dataset.theme);
      for (const c of modal.querySelectorAll('.theme-card')) c.classList.remove('active');
      card.classList.add('active');
      status('Theme: ' + card.dataset.theme);
    };
  }
  const slider = $('ui-scale-slider');
  const valLabel = $('ui-scale-val');
  slider.addEventListener('input', () => {
    const v = setUiScale(parseFloat(slider.value));
    valLabel.textContent = Math.round(v * 100) + '%';
  });
}

// ---------- help modal ----------
const HOTKEYS = [
  ['Files & navigation', [
    ['Ctrl+N',         'New script'],
    ['Ctrl+S',         'Save'],
    ['Ctrl+Shift+S',   'Export PDF'],
    ['Ctrl+\\',        'Toggle sidebar'],
    ['Ctrl+E',         'Cycle panes: preview / both / source'],
    ['Ctrl+L',         'Align panes now (one-shot)'],
    ['Ctrl+Shift+L',   'Toggle scroll sync'],
    ['Ctrl+Shift+P',   'Performance mode (read-only; ↑↓ to step between lines)'],
    ['Esc',            'Exit performance / close modal'],
    ['F1 or ?',        'This help'],
  ]],
  ['Element types (in editor)', [
    ['Tab',            'Cycle current line through element types'],
    ['Ctrl+1',         'Scene heading'],
    ['Ctrl+2',         'Action'],
    ['Ctrl+3',         'Character cue'],
    ['Ctrl+4',         'Parenthetical'],
    ['Ctrl+5',         'Dialogue'],
    ['Ctrl+6',         'Transition'],
  ]],
  ['Inline formatting', [
    ['Ctrl+B',         'Bold (**text**)'],
    ['Ctrl+I',         'Italic (*text*)'],
    ['Ctrl+U',         'Underline (_text_)'],
  ]],
  ['Structural', [
    ['Ctrl+/',         'Wrap selection in [[note]]'],
    ['Ctrl+;',         'Insert page break (===)'],
    ['Ctrl+Shift+D',   'Mark current cue as dual dialogue'],
  ]],
  ['Writing flow', [
    ['Ctrl+Shift+F',   'Typewriter / focus mode (dim non-current lines)'],
  ]],
  ['Search', [
    ['Ctrl+F',         'Find'],
    ['Ctrl+H',         'Find &amp; replace'],
    ['Ctrl+K',         'Command palette (commands, scenes, characters)'],
    ['Enter',          'Next match (in find bar)'],
    ['Shift+Enter',    'Previous match'],
  ]],
  ['View', [
    ['Ctrl+=',         'Zoom in'],
    ['Ctrl+-',         'Zoom out'],
    ['Ctrl+0',         'Reset zoom'],
    ['Ctrl+D',         'Bookmark current scroll position'],
    ['Ctrl+Shift+T',   'Theme picker'],
  ]],
  ['Fountain quick reference', [
    ['INT/EXT/EST',    'Scene heading prefix'],
    ['Leading .',      'Force scene heading'],
    ['Leading @',      'Force character cue (lowercase names ok)'],
    ['Leading !',      'Force action line'],
    ['Leading >',      'Forced transition'],
    ['> text <',       'Centered text'],
    ['~ lyric',        'Lyric line'],
    ['# Heading',      'Section (outline only, not in script)'],
    ['= synopsis',     'Synopsis (outline only)'],
    ['[[…]]',          'Note (hidden in performance)'],
    ['/* … */',        'Boneyard (excluded from render)'],
    ['===',            'Page break'],
    ['^ on cue line',  'Dual dialogue (second speaker)'],
  ]],
];
function openHelp(initialTab) {
  // Remember the last tab the user looked at; default to "howto" on the very
  // first open. Guard against a non-string arg: openHelp is also wired as a
  // click handler, so initialTab can arrive as a MouseEvent.
  if (typeof initialTab !== 'string') initialTab = loadPrefs().helpTab || 'howto';
  const modal = $('modal-root');
  modal.classList.remove('hidden');
  const shortcutsHtml = HOTKEYS.map(([title, rows]) => `
    <h4>${title}</h4>
    <table class="hk-table">
      ${rows.map(([k, d]) => `<tr><td class="hk-key">${escapeHtml(k)}</td><td>${d}</td></tr>`).join('')}
    </table>`).join('');
  modal.innerHTML = `
    <div class="modal modal-help">
      <div class="modal-head">
        <h3>Help</h3>
        <div class="help-tabs" role="tablist">
          <button class="help-tab" data-tab="howto">How to</button>
          <button class="help-tab" data-tab="shortcuts">Shortcuts</button>
          <button class="help-tab" data-tab="fountain">Fountain syntax</button>
        </div>
        <button class="icon-btn" id="modal-close">×</button>
      </div>
      <div class="modal-body">
        <div class="help-pane" data-pane="howto">${HELP_HOWTO_HTML}</div>
        <div class="help-pane" data-pane="shortcuts">${shortcutsHtml}</div>
        <div class="help-pane" data-pane="fountain">${HELP_FOUNTAIN_HTML}</div>
      </div>
    </div>`;
  $('modal-close').onclick = () => modal.classList.add('hidden');
  const setTab = (name) => {
    for (const t of modal.querySelectorAll('.help-tab')) t.classList.toggle('active', t.dataset.tab === name);
    for (const p of modal.querySelectorAll('.help-pane')) p.classList.toggle('active', p.dataset.pane === name);
    const p = loadPrefs(); p.helpTab = name; savePrefs(p);
  };
  for (const t of modal.querySelectorAll('.help-tab')) t.onclick = () => setTab(t.dataset.tab);
  setTab(initialTab);
}

const HELP_HOWTO_HTML = `
<section class="howto">
  <h4>Getting started</h4>
  <p>Scripts live in the <code>scripts/</code> folder beside <code>server.py</code>.
     Use <strong>＋ New</strong> in the sidebar, or open an existing
     <code>.fountain</code> file from the file tree.</p>

  <h4>The two views</h4>
  <p><strong>Read</strong> mode (the default) shows the script paginated like a
     printed page — courier, real margins, scene numbers, real page breaks. It's
     a read-only preview; click a line to locate it in the source.</p>
  <p><strong>Edit</strong> mode opens the Fountain source in a textarea
     alongside the live preview — this is where you write. Toolbar buttons and
     shortcuts act on the source. <kbd>Ctrl+E</kbd> cycles the panes: preview, both, source. Read and Edit can also be toggled independently.</p>
  <p>Toggle <em>markup</em> (top-right) to show inline Fountain markers
     (<code>**bold**</code>, <code>*italic*</code>, <code>_underline_</code>,
     <code>[[notes]]</code>) in the preview.</p>

  <h4>Writing flow</h4>
  <ol>
    <li>Click the title page (the cover) to open the title-page editor.
        Fill in title, author, format, draft date, etc. — pick screenplay,
        stage, or radio to drive the layout.</li>
    <li>Start the first scene: type <code>INT. KITCHEN - DAY</code> on a fresh
        line. Lowercase prefixes auto-uppercase when you press Enter.</li>
    <li>Press Enter to drop into action. Type a paragraph.</li>
    <li>Blank line, then type a character name in caps (e.g. <code>ANNA</code>)
        and press Enter. The next line auto-formats as <em>dialogue</em>.</li>
    <li>Need a stage direction inside dialogue? Press <strong>Tab</strong>
        on a fresh line to cycle to <em>parenthetical</em>, type <code>(whispering)</code>,
        then Enter.</li>
    <li>Use <strong>Tab</strong> from anywhere to cycle the current line through
        Scene → Action → Character → Parenthetical → Dialogue → Transition.
        Or use <kbd>Ctrl+1</kbd>..<kbd>Ctrl+6</kbd> to set the type directly.</li>
    <li>Right-click any line for the same operations plus dual-dialogue and
        (CONT'D) helpers.</li>
  </ol>

  <h4>Structure: sections & synopses</h4>
  <p>Use <code># Act One</code> for outline-only act/sequence markers and
     <code>= short summary</code> for synopses. They appear in the
     <strong>Outline</strong> sidebar and the <strong>Beat board</strong>
     (📇 button) but don't clutter the printed script.</p>

  <h4>Beat board (index cards)</h4>
  <p>📇 opens a card view — one card per scene, slug + synopsis + preview.
     Drag cards to reorder. <strong>Apply order</strong> rewrites the source
     in the new order. Scenes can also be reordered by dragging entries in
     the Outline sidebar.</p>

  <h4>Multi-character scenes</h4>
  <p>For two characters speaking simultaneously, put <code>^</code> at the end
     of the <em>second</em> character cue. Or right-click the second cue in the
     preview and choose <em>Mark as dual dialogue</em>. The pair renders as two
     side-by-side columns.</p>

  <h4>Search</h4>
  <p><kbd>Ctrl+F</kbd> opens a find bar at the bottom. Optionally scope to
     dialogue, action, scene headings, or character cues only — useful for
     "every line ANNA says about the kettle". <kbd>Ctrl+H</kbd> goes straight
     to replace.</p>

  <h4>Command palette</h4>
  <p><kbd>Ctrl+K</kbd> opens a palette that searches every command plus
     scenes and characters in the current script. Type a few letters of a
     scene's slug to jump to it.</p>

  <h4>Focused writing</h4>
  <p><kbd>Ctrl+Shift+F</kbd> toggles <strong>typewriter mode</strong>: the
     active line stays centered, non-current lines dim. Combine with
     <strong>Performance mode</strong> (<kbd>Ctrl+Shift+P</kbd>) to hide
     sidebar and chrome entirely.</p>

  <h4>Auto-save and version history</h4>
  <p>Every edit auto-saves ~1.5s after you stop typing. The save button
     turns enabled the instant the document is dirty. Use the <strong>⟲</strong>
     history button to see prior snapshots, and <em>Diff</em> for a line-level
     comparison. Auto-saves checkpoint at most once every few minutes so the
     history stays a list of meaningful versions rather than hundreds of
     keystroke-by-keystroke ones; a manual <kbd>Ctrl+S</kbd> always checkpoints.
     If the file changed on disk underneath you (a second tab, an external
     editor, a restore), the next manual save asks before overwriting.</p>

  <h4>Cast list &amp; notes review</h4>
  <p>From the command palette (<kbd>Ctrl+K</kbd>): <strong>Cast list</strong>
     lists every speaking role with cue and scene counts, and can copy or insert
     a dramatis-personae block. <strong>Review notes</strong> gathers every
     <code>[[note]]</code> in the script into one list — click any note to jump
     to that line in the source. <strong>Toggle spellcheck</strong> turns the
     browser spell-checker on or off in the editor; <strong>Spellcheck
     language…</strong> picks the dictionary (English, Norwegian bokmål/nynorsk,
     and more — it must be installed in your browser or OS). The status bar
     shows live page / scene / character / word counts.</p>

  <h4>Character counts &amp; production stats</h4>
  <p>Each name in the sidebar <strong>Characters</strong> panel shows two
     numbers: <strong>c</strong> = <em>cues</em> (how many times the character
     speaks — each cue line counts once) and <strong>w</strong> = <em>words</em>
     of dialogue (a better measure of role size, since one cue can be a single
     word or a long monologue). Cue variants like <code>(V.O.)</code> and
     <code>(CONT'D)</code> fold into the base name. The 📊 <strong>Production
     stats</strong> panel breaks this down further — cues, dialogue lines,
     words, and scenes per character — plus locations and totals. Word counts
     are Unicode-aware, so Norwegian words count correctly.</p>

  <h4>Page count &amp; estimated runtime</h4>
  <p>The <strong>page count</strong> is the real paginated count (the same pages
     you see in Read view): page height minus margins, at six lines per inch
     (≈55 lines on a US-Letter screenplay page). The <strong>estimated
     runtime</strong> depends on the title-page <code>format:</code>:</p>
  <ul>
    <li><strong>screenplay</strong> — the industry rule of <em>one page ≈ one
        minute</em>, so runtime equals the page count.</li>
    <li><strong>radio</strong> — spoken plus action words ÷ <strong>150</strong>
        words per minute (near-continuous audio).</li>
    <li><strong>stage</strong> — spoken words ÷ <strong>130</strong> words per
        minute (slower delivery, blocking, pauses).</li>
  </ul>
  <p>These rates are fixed estimates — a pause-heavy production will run longer
     than the number suggests; treat it as a ballpark, not a stopwatch.</p>

  <h4>Revision colors</h4>
  <p>Industry shooting scripts cycle paper colors: white → blue → pink →
     yellow → green → goldenrod. Set <code>Revision: blue</code> on the title
     page (or via the title-page editor) and every page renders on that tint
     in both the on-screen view and the exported PDF.</p>

  <h4>Rehearsal and performance</h4>
  <ul>
    <li><strong>Performance mode</strong> (<kbd>Ctrl+Shift+P</kbd> or 🎭):
        hides every UI element except the page. Esc to exit.</li>
    <li><strong>Rehearse a character</strong> (in the command palette):
        hides every line not spoken by your chosen character behind
        <code>···</code> placeholders. Click a placeholder to peek.</li>
    <li><strong>Read aloud (TTS)</strong>: each character gets a distinct
        browser voice. Status bar shows what's being spoken.</li>
  </ul>

  <h4>Exports</h4>
  <p>From the command palette or the topbar:</p>
  <ul>
    <li><strong>Export PDF</strong> (<kbd>Ctrl+Shift+S</kbd>) — the full
        script, industry margins per format.</li>
    <li><strong>Character sides</strong> — one character's PDF: only their
        scenes, lines highlighted, others dimmed. Standard for auditions.</li>
    <li><strong>Cue sheet</strong> (radio drama) — a separate document
        listing every <code>SFX:</code> / <code>MUSIC:</code> cue with the line
        it follows. For sound engineers.</li>
    <li><strong>Final Draft (.fdx)</strong> — export to, or import from, the
        industry-standard Final Draft format. <em>Export</em> from the
        <strong>↓ FDX</strong> button in the topbar, the command palette, or by
        right-clicking a script in the file tree. <em>Import</em> from the
        <strong>⤵ Import</strong> button above the file tree, the command
        palette, or the tree's right-click menu — it creates a new
        <code>.fountain</code> file and opens it. Round-trip is loss-free for all
        standard screenplay elements; Fountain-only bits (sections, synopses,
        lyrics) become styled action, and dual dialogue flattens to sequential
        cues.</li>
  </ul>

  <h4>The file tree</h4>
  <p><strong>Right-click any script</strong> in the sidebar tree for Open,
     Rename, Duplicate, Delete, Export PDF, Export Final Draft, and Version
     history. Right-click anywhere in the tree for New script, Import
     <code>.fdx</code>, and Refresh.</p>

  <h4>Tips</h4>
  <ul>
    <li>Customize the look from the 🎨 theme picker — six themes plus a UI
        text-size slider for readability.</li>
    <li>Adjust document text size with <kbd>Ctrl+=</kbd>, <kbd>Ctrl+-</kbd>,
        <kbd>Ctrl+0</kbd> to reset.</li>
    <li>Open multiple scripts simultaneously — they become tabs above the
        toolbar.</li>
    <li><kbd>F1</kbd> or <kbd>?</kbd> (anywhere outside a text field) opens
        this help.</li>
  </ul>
</section>`;

const HELP_FOUNTAIN_HTML = `
<section class="howto">
  <p>Fountain is a plain-text screenplay format. Structure is inferred from
     formatting; you rarely need to insert explicit markup. Here are the
     conventions the parser recognises:</p>

  <h4>Scene headings</h4>
  <ul>
    <li>Line starting with <code>INT.</code>, <code>EXT.</code>, <code>EST.</code>,
        <code>INT/EXT</code>, <code>I/E</code>, etc. surrounded by blank lines.</li>
    <li>Force a non-standard slug with a leading dot:
        <code>.HER POV - THE PANTRY DOOR</code>.</li>
  </ul>

  <h4>Character cues & dialogue</h4>
  <ul>
    <li>ALL-CAPS line preceded by a blank line → character cue.</li>
    <li>Line directly under the cue → dialogue.</li>
    <li><code>(parenthetical)</code> on its own line between cue and dialogue.</li>
    <li>Force a non-uppercase character cue with <code>@</code>:
        <code>@McAvoy</code>.</li>
    <li>End the second cue of a simultaneous pair with <code>^</code> for
        dual dialogue.</li>
  </ul>

  <h4>Transitions</h4>
  <ul>
    <li>ALL-CAPS line ending in <code>TO:</code> with blank lines around it.</li>
    <li>Force with leading <code>&gt;</code>: <code>&gt; SMASH CUT:</code>.</li>
  </ul>

  <h4>Inline formatting</h4>
  <ul>
    <li><code>**bold**</code>, <code>*italic*</code>, <code>***bold italic***</code>,
        <code>_underline_</code>.</li>
    <li><code>[[inline note]]</code> — hidden in the printed render; visible
        when "markup" is toggled.</li>
    <li><code>/* boneyard */</code> — excluded entirely from the render.</li>
  </ul>

  <h4>Outline-only blocks (don't print)</h4>
  <ul>
    <li><code># Heading</code> — section (act / sequence).
        Use <code>##</code>, <code>###</code> for sub-levels.</li>
    <li><code>= synopsis</code> — one-line summary attached to the preceding
        scene or section.</li>
  </ul>

  <h4>Special blocks</h4>
  <ul>
    <li><code>~ lyric line</code> — italicized lyric.</li>
    <li><code>&gt; CENTERED &lt;</code> — centered text (great for "FADE OUT.").</li>
    <li><code>===</code> on its own line — forced page break.</li>
  </ul>

  <h4>Title page</h4>
  <p>At the top of the file, before any body content, you can include
     <code>Key: Value</code> pairs ended by a blank line or <code>===</code>:</p>
  <pre>Title: The Quiet Kitchen
Credit: Written by
Author: Benjamin Ensrud
Format: screenplay
Revision: blue
Draft date: 2026-05-19
Contact:
    me@example.com
===</pre>
  <p>The "Format" key drives layout (<code>screenplay</code> /
     <code>stage</code> / <code>radio</code>). "Revision" tints the paper
     (white, blue, pink, yellow, green, goldenrod).</p>

  <p>Full spec: <a href="https://fountain.io/syntax" target="_blank" rel="noopener">fountain.io/syntax</a>.</p>
</section>`;

// ---------- context menu ----------
function showContextMenu(x, y, items) {
  const menu = $('ctx-menu');
  menu.innerHTML = '';
  for (const it of items) {
    if (it === '-') {
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      menu.appendChild(sep);
      continue;
    }
    const btn = document.createElement('button');
    btn.className = 'ctx-item' + (it.disabled ? ' disabled' : '');
    btn.innerHTML = `<span>${escapeHtml(it.label)}</span>` +
                    (it.hint ? `<span class="ctx-hint">${escapeHtml(it.hint)}</span>` : '');
    btn.onclick = (ev) => {
      ev.stopPropagation();
      if (it.disabled) return;
      hideContextMenu();
      try { it.action(); } catch (e) { console.error(e); }
    };
    menu.appendChild(btn);
  }
  menu.classList.remove('hidden');
  // Position, clamping to viewport.
  const rect = menu.getBoundingClientRect();
  const maxX = window.innerWidth - rect.width - 8;
  const maxY = window.innerHeight - rect.height - 8;
  menu.style.left = Math.min(x, maxX) + 'px';
  menu.style.top  = Math.min(y, maxY) + 'px';
}
function hideContextMenu() { $('ctx-menu').classList.add('hidden'); }

function onEditorContextMenu(ev) {
  if (!state.currentPath) return;
  ev.preventDefault();
  const ta = ev.target;
  const line = getCurrentLine(ta);
  const sel = getTaSelection(ta);
  const lineKind = classifyLine(line.text);

  const items = [
    // Commenting exists only inside a collaboration session, so the entry is
    // absent rather than disabled when there is nothing to anchor into.
    ...(window.Comments && window.Collab && window.Collab.active()
      ? [{ label: 'Comment on selection',
           action: () => window.Comments.commentOnSelection(),
           disabled: sel.start === sel.end }, '-']
      : []),
    { label: 'Convert line to…', disabled: true },
    { label: '  Scene heading',  action: () => CMDS['elem-scene'](),      hint: 'Ctrl+1' },
    { label: '  Action',         action: () => CMDS['elem-action'](),     hint: 'Ctrl+2' },
    { label: '  Character',      action: () => CMDS['elem-character'](),  hint: 'Ctrl+3' },
    { label: '  Parenthetical',  action: () => CMDS['elem-paren'](),      hint: 'Ctrl+4' },
    { label: '  Dialogue',       action: () => CMDS['elem-dialogue'](),   hint: 'Ctrl+5' },
    { label: '  Transition',     action: () => CMDS['elem-transition'](), hint: 'Ctrl+6' },
    '-',
    { label: 'Bold',      action: CMDS.bold,      hint: 'Ctrl+B' },
    { label: 'Italic',    action: CMDS.italic,    hint: 'Ctrl+I' },
    { label: 'Underline', action: CMDS.underline, hint: 'Ctrl+U' },
    { label: 'Note',      action: CMDS.note,      hint: 'Ctrl+/' },
    '-',
    { label: 'Insert page break', action: CMDS.pagebreak, hint: 'Ctrl+;' },
    { label: 'Insert (MORE)',     action: CMDS.more },
  ];
  if (lineKind === 'character') {
    items.push(
      '-',
      { label: 'Mark as dual dialogue', action: CMDS.dual, hint: 'Ctrl+Shift+D' },
      { label: "Add (CONT'D)",          action: CMDS.contd },
    );
  }
  if (state.mode === 'split') {
    items.push('-');
    items.push({
      label: (getSplitSync() ? '✓ Scroll sync' : 'Scroll sync (off)'),
      action: toggleSplitSync,
      hint: 'Ctrl+Shift+L',
    });
    items.push({ label: 'Align page to source here', action: () => syncNow('source'), hint: 'Ctrl+L' });
  }
  showContextMenu(ev.clientX, ev.clientY, items);
}

function onViewContextMenu(ev) {
  if (!state.currentPath) return;
  // Target the element the user clicked. In WYSIWYG mode this is the .elem
  // they want operations applied to, regardless of where the caret happens
  // to be sitting.
  const elem = ev.target.closest('.elem');
  ev.preventDefault();
  const editable = state.mode !== 'source';
  const items = [];

  if (elem && editable) {
    const kind = elKind(elem);
    // All edits operate on the source line backing the clicked element.
    const convert = (k) => { selectElemLine(elem); convertCurrentLine(k); };
    const wrapLine = (o, c, ph) => { if (selectElemLine(elem)) applyInlineCommand(o, c, ph); };
    items.push({ label: 'Convert line to…', disabled: true });
    items.push({ label: '  Scene heading',  action: () => convert('scene'),         hint: 'Ctrl+1' });
    items.push({ label: '  Action',         action: () => convert('action'),        hint: 'Ctrl+2' });
    items.push({ label: '  Character',      action: () => convert('character'),     hint: 'Ctrl+3' });
    items.push({ label: '  Parenthetical',  action: () => convert('parenthetical'), hint: 'Ctrl+4' });
    items.push({ label: '  Dialogue',       action: () => convert('dialogue'),      hint: 'Ctrl+5' });
    items.push({ label: '  Transition',     action: () => convert('transition'),    hint: 'Ctrl+6' });
    items.push('-');
    items.push({ label: 'Bold',      action: () => wrapLine('**', '**', 'bold text'),   hint: 'Ctrl+B' });
    items.push({ label: 'Italic',    action: () => wrapLine('*',  '*',  'italic text'), hint: 'Ctrl+I' });
    items.push({ label: 'Underline', action: () => wrapLine('_',  '_',  'underlined'),  hint: 'Ctrl+U' });
    items.push({ label: 'Note',      action: () => wrapLine('[[', ']]', 'note'),        hint: 'Ctrl+/' });
    items.push('-');
    items.push({ label: 'Insert action below',  action: () => { caretToElemLine(elem); insertBlock(''); } });
    items.push({ label: 'Insert scene below',   action: () => { caretToElemLine(elem); insertBlock('INT. NEW SCENE - DAY'); } });
    items.push({ label: 'Insert page break',    action: () => { caretToElemLine(elem); insertBlock('==='); } });
    if (kind === 'character') {
      items.push('-');
      items.push({ label: 'Mark as dual dialogue', action: () => { caretToElemLine(elem); makeDualDialogue(); }, hint: 'Ctrl+Shift+D' });
      items.push({ label: "Add (CONT'D)", action: () => {
          const n = parseInt(elem.dataset.srcLine, 10);
          if (Number.isNaN(n)) return;
          const raw = $('editor').value.split('\n')[n] || '';
          const dual = /\s\^\s*$/.test(raw);
          const cur = raw.replace(/\(CONT'D\)\s*\^?\s*$/, '').replace(/\s*\^\s*$/, '').trimEnd();
          setElemSourceLine(elem, cur + " (CONT'D)" + (dual ? ' ^' : ''));
        } });
    }
    items.push('-');
  }

  items.push({ label: 'Copy text', action: () => {
    const t = (elem && elem.textContent) || ev.target.textContent || '';
    navigator.clipboard?.writeText(t);
    status('Copied');
  }});
  items.push({ label: 'Bookmark this position', action: () => {
    if (elem) elem.scrollIntoView({ block: 'start' });
    addBookmark();
  }});
  if (elem && elem.classList.contains('elem-scene')) {
    items.push({ label: 'Scroll to top of this scene',
                 action: () => elem.scrollIntoView({ behavior: 'smooth', block: 'start' }) });
  }
  if (state.mode === 'split') {
    items.push('-');
    items.push({
      label: (getSplitSync() ? '✓ Scroll sync' : 'Scroll sync (off)'),
      action: toggleSplitSync,
      hint: 'Ctrl+Shift+L',
    });
    items.push({ label: 'Align source to page here', action: () => syncNow('view'), hint: 'Ctrl+L' });
  }

  showContextMenu(ev.clientX, ev.clientY, items);
}

// ---------- global hotkey dispatcher ----------
function onGlobalKeydown(ev) {
  const inField = ev.target.tagName === 'INPUT' || ev.target.tagName === 'SELECT';
  const inTextarea = ev.target.tagName === 'TEXTAREA';
  const ctrl = ev.ctrlKey || ev.metaKey;
  const shift = ev.shiftKey;
  const key = ev.key;
  const lkey = (typeof key === 'string') ? key.toLowerCase() : '';

  // Esc: close modal first, else autocomplete, else perform mode.
  if (key === 'Escape') {
    const modal = $('modal-root');
    if (!modal.classList.contains('hidden')) { modal.classList.add('hidden'); return; }
    if (!$('ctx-menu').classList.contains('hidden')) { hideContextMenu(); return; }
    if (document.body.classList.contains('perform')) { togglePerform(); return; }
    return;
  }

  // Performance mode: arrow-key navigation through elements.
  if (document.body.classList.contains('perform')) {
    if (key === 'ArrowDown' || key === 'ArrowRight' || key === 'PageDown' || key === ' ') {
      ev.preventDefault(); performStep(+1); return;
    }
    if (key === 'ArrowUp' || key === 'ArrowLeft' || key === 'PageUp') {
      ev.preventDefault(); performStep(-1); return;
    }
    if (key === 'Home') { ev.preventDefault(); const el = performElems()[0]; if (el) setPerformActive(el); return; }
    if (key === 'End')  { ev.preventDefault(); const all = performElems(); if (all.length) setPerformActive(all[all.length - 1]); return; }
  }

  // F1 = help (anywhere).
  if (key === 'F1') { ev.preventDefault(); openHelp(); return; }
  // ? (Shift+/) when not in editor/input = help.
  if (key === '?' && !inField && !inTextarea) { ev.preventDefault(); openHelp(); return; }

  if (ctrl) {
    // Ctrl + digit 1..6 → element type.
    if (!shift && /^[1-6]$/.test(key)) {
      ev.preventDefault();
      const map = { '1': 'elem-scene', '2': 'elem-action', '3': 'elem-character',
                    '4': 'elem-paren', '5': 'elem-dialogue', '6': 'elem-transition' };
      runCmd(map[key]); return;
    }
    if (!inField && !shift && lkey === 'z') { ev.preventDefault(); histUndo(); return; }
    if (!inField && ((shift && lkey === 'z') || (!shift && lkey === 'y'))) { ev.preventDefault(); histRedo(); return; }
    if (!shift && lkey === 's') { ev.preventDefault(); runCmd('save'); return; }
    if (shift && lkey === 's')  { ev.preventDefault(); runCmd('export'); return; }
    if (!shift && lkey === 'n') { ev.preventDefault(); runCmd('new'); return; }
    if (!shift && key === '\\') { ev.preventDefault(); runCmd('toggle-sidebar'); return; }
    if (!shift && lkey === 'e') { ev.preventDefault();
      setMode(state.mode === 'split' ? 'view' : 'split'); return; }
    if (shift && lkey === 'p')  { ev.preventDefault(); runCmd('perform'); return; }
    if (shift && lkey === 't')  { ev.preventDefault(); runCmd('theme'); return; }
    if (!shift && lkey === 'd') { ev.preventDefault(); runCmd('bookmark'); return; }
    if (shift && lkey === 'd')  { ev.preventDefault(); runCmd('dual'); return; }
    if (!shift && lkey === 'b') { ev.preventDefault(); runCmd('bold'); return; }
    if (!shift && lkey === 'i') { ev.preventDefault(); runCmd('italic'); return; }
    if (!shift && lkey === 'u') { ev.preventDefault(); runCmd('underline'); return; }
    if (!shift && key === '/')  { ev.preventDefault(); runCmd('note'); return; }
    if (!shift && key === ';')  { ev.preventDefault(); runCmd('pagebreak'); return; }
    if (!shift && (key === '=' || key === '+')) { ev.preventDefault(); zoomIn(); return; }
    if (!shift && key === '-') { ev.preventDefault(); zoomOut(); return; }
    if (!shift && key === '0') { ev.preventDefault(); zoomReset(); return; }
    if (!shift && lkey === 'f') {
      ev.preventDefault();
      // Pre-fill find with current selection if any.
      const sel = ev.target.tagName === 'TEXTAREA' ? getTaSelection(ev.target).text : '';
      openFind(sel);
      return;
    }
    if (!shift && lkey === 'h') { ev.preventDefault(); openFind(); $('find-replace').focus(); return; }
    if (!shift && lkey === 'k') { ev.preventDefault(); openPalette(); return; }
    if (shift && lkey === 'f')  { ev.preventDefault(); toggleTypewriter(); return; }
    if (!shift && lkey === 'l') { ev.preventDefault(); syncNow(); return; }
    if (shift && lkey === 'l')  { ev.preventDefault(); toggleSplitSync(); return; }
  }
}

// ---------- title page editor ----------
const TP_FIELDS = [
  { key: 'title',      label: 'Title' },
  { key: 'credit',     label: 'Credit (e.g. “Written by”)' },
  { key: 'author',     label: 'Author' },
  { key: 'source',     label: 'Source / based on' },
  { key: 'draft_date', label: 'Draft date' },
  { key: 'contact',    label: 'Contact', multiline: true },
  { key: 'copyright',  label: 'Copyright' },
  { key: 'format',     label: 'Format',   choices: ['screenplay', 'stage', 'radio'] },
  { key: 'revision',   label: 'Revision', choices: ['', 'white', 'blue', 'pink', 'yellow', 'green', 'goldenrod'] },
];

function openTitlePageEditor() {
  if (!state.currentPath) return;
  const tp = { ...state.titlePage };
  const modal = $('modal-root');
  modal.classList.remove('hidden');
  modal.innerHTML = `
    <div class="modal modal-tp">
      <div class="modal-head"><h3>Title page</h3><button class="icon-btn" id="modal-close">×</button></div>
      <div class="modal-body">
        <form id="tp-form" class="tp-form">
          ${TP_FIELDS.map(f => {
            if (f.choices) {
              return `<label><span>${f.label}</span>
                <select name="${f.key}">
                  ${f.choices.map(c => `<option value="${escapeHtml(c)}" ${(tp[f.key] || '') === c ? 'selected' : ''}>${escapeHtml(c) || '—'}</option>`).join('')}
                </select></label>`;
            }
            if (f.multiline) {
              return `<label><span>${f.label}</span>
                <textarea name="${f.key}" rows="2">${escapeHtml(tp[f.key] || '')}</textarea></label>`;
            }
            return `<label><span>${f.label}</span>
              <input name="${f.key}" type="text" value="${escapeHtml(tp[f.key] || '')}"></label>`;
          }).join('')}
          <button type="submit" class="apply-btn">Save title page</button>
        </form>
      </div>
    </div>`;
  $('modal-close').onclick = () => modal.classList.add('hidden');
  $('tp-form').onsubmit = (ev) => {
    ev.preventDefault();
    const data = new FormData(ev.target);
    const newTp = {};
    for (const [k, v] of data.entries()) {
      const val = String(v).trim();
      if (val) newTp[k] = val;
    }
    rewriteTitlePage(newTp);
    modal.classList.add('hidden');
    status('Title page updated');
  };
}

function rewriteTitlePage(newTp) {
  const text = $('editor').value;
  const lines = text.split('\n');
  // Find end of existing title-page block (matches parser logic).
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  let hasTp = false;
  if (i < lines.length && /^[A-Za-z][A-Za-z0-9 _\-]*:/.test(lines[i])) {
    hasTp = true;
    while (i < lines.length && lines[i].trim() !== '') i++;
    while (i < lines.length && lines[i].trim() === '') i++;
    if (i < lines.length && /^={3,}\s*$/.test(lines[i])) {
      i++;
      while (i < lines.length && lines[i].trim() === '') i++;
    }
  }
  const body = lines.slice(hasTp ? i : 0).join('\n').replace(/^\n+/, '');
  const ORDER = ['title', 'credit', 'author', 'source', 'draft_date', 'contact', 'copyright', 'format', 'revision'];
  const out = [];
  for (const k of ORDER) {
    if (!newTp[k]) continue;
    const label = k.replace(/_/g, ' ').replace(/\b\w/g, m => m.toUpperCase());
    const val = String(newTp[k]);
    if (val.includes('\n')) {
      out.push(label + ':');
      for (const ln of val.split('\n')) out.push('    ' + ln);
    } else {
      out.push(label + ': ' + val);
    }
  }
  const tpText = out.length ? out.join('\n') + '\n\n===\n\n' : '';
  histCommit();
  $('editor').value = tpText + body;
  reparseSource();
  markDirty();
  scheduleRender();
  histCommit();
}

// ---------- read-aloud (TTS) ----------
const tts = { queue: [], current: -1, playing: false, voices: [] };
function loadVoices() {
  if (typeof speechSynthesis === 'undefined') return;
  tts.voices = speechSynthesis.getVoices() || [];
}
if (typeof speechSynthesis !== 'undefined') {
  speechSynthesis.onvoiceschanged = loadVoices;
  loadVoices();
}

function voiceForCharacter(name) {
  if (tts.voices.length === 0) return null;
  let h = 0;
  for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  return tts.voices[Math.abs(h) % tts.voices.length];
}

function buildTtsQueue() {
  const items = [];
  let curChar = null;
  for (const t of state.tokens) {
    const text = t.text || '';
    if (!text.trim() && t.type !== 'scene') continue;
    if (t.type === 'scene') {
      items.push({ text, voice: null, label: 'Scene' });
    } else if (t.type === 'character') {
      curChar = text.replace(/\s*\([^)]*\)\s*$/, '').trim();
    } else if (t.type === 'dialogue') {
      items.push({ text, voice: curChar ? voiceForCharacter(curChar) : null, label: curChar });
    } else if (t.type === 'action') {
      items.push({ text, voice: null, label: 'Action' });
    }
  }
  return items;
}

function ttsPlay() {
  if (!state.currentPath || typeof speechSynthesis === 'undefined') {
    status('TTS not available', true); return;
  }
  ttsStop();
  tts.queue = buildTtsQueue();
  tts.current = -1;
  tts.playing = true;
  ttsNext();
}
function ttsNext() {
  if (!tts.playing) return;
  tts.current++;
  if (tts.current >= tts.queue.length) { ttsStop(); status('TTS finished'); return; }
  const it = tts.queue[tts.current];
  const u = new SpeechSynthesisUtterance(it.text);
  if (it.voice) u.voice = it.voice;
  u.onend = () => ttsNext();
  u.onerror = () => ttsNext();
  speechSynthesis.speak(u);
  status('🔊 ' + (it.label || '…') + ' — ' + it.text.slice(0, 50));
}
function ttsStop() {
  tts.playing = false;
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
}
function ttsToggle() {
  if (tts.playing) { ttsStop(); status('TTS stopped'); }
  else ttsPlay();
}

// ---------- rehearsal (line memorization) ----------
function startRehearsal(character) {
  state.rehearsalChar = character;
  document.body.classList.add('rehearse');
  applyRehearsalMask();
  if (!document.body.classList.contains('perform')) {
    document.body.classList.add('perform');
  }
}
function endRehearsal() {
  state.rehearsalChar = null;
  document.body.classList.remove('rehearse');
  for (const el of document.querySelectorAll('[data-original-html]')) {
    el.innerHTML = el.dataset.originalHtml;
    delete el.dataset.originalHtml;
    delete el.dataset.revealed;
    el.onclick = null;
  }
}
const REHEARSE_PLACEHOLDER = '<span class="rehearse-placeholder">···  (click to reveal)</span>';
function applyRehearsalMask() {
  const focal = (state.rehearsalChar || '').toUpperCase().trim();
  for (const el of document.querySelectorAll('.elem-dialogue, .elem-parenthetical')) {
    const cue = (el.dataset.cue || '').toUpperCase().trim();
    if (cue && cue !== focal) {
      if (!el.dataset.originalHtml) el.dataset.originalHtml = el.innerHTML;
      el.dataset.revealed = '';
      el.innerHTML = REHEARSE_PLACEHOLDER;
      // Click toggles between the masked placeholder and the real line.
      el.onclick = (ev) => {
        ev.stopPropagation();
        const reveal = el.dataset.revealed !== '1';
        el.innerHTML = reveal ? el.dataset.originalHtml : REHEARSE_PLACEHOLDER;
        el.dataset.revealed = reveal ? '1' : '';
      };
    }
  }
}
function openRehearsalPicker() {
  if (state.characters.length === 0) { status('No characters', true); return; }
  const modal = $('modal-root');
  modal.classList.remove('hidden');
  const opts = state.characters
    .slice().sort((a, b) => b.count - a.count)
    .map(c => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)} (${c.count} cues)</option>`).join('');
  modal.innerHTML = `
    <div class="modal">
      <div class="modal-head"><h3>Rehearse character</h3><button class="icon-btn" id="modal-close">×</button></div>
      <div class="modal-body">
        <p>Your character's lines stay visible. Others are hidden behind <code>···</code> — click to peek.</p>
        <select id="rehearse-char" style="width: 100%; padding: 0.4rem; font: 0.9rem var(--courier);">${opts}</select>
        <button id="rehearse-go" class="apply-btn" style="margin-top: 0.8rem;">Start rehearsing</button>
      </div>
    </div>`;
  $('modal-close').onclick = () => modal.classList.add('hidden');
  $('rehearse-go').onclick = () => {
    const c = $('rehearse-char').value;
    modal.classList.add('hidden');
    startRehearsal(c);
    status('Rehearsing ' + c + ' — Esc to exit');
  };
}

// ---------- performance mode ----------
// Real browser fullscreen, for working with the chrome out of the way. This is
// deliberately NOT performance mode: that one also hides the sidebar and editor
// and enlarges the type for rehearsal. Fullscreen just reclaims the screen and
// leaves the app exactly as it is, so it composes with any pane layout.
function toggleFullscreen() {
  const el = document.documentElement;
  if (!document.fullscreenElement) {
    const p = el.requestFullscreen ? el.requestFullscreen() : null;
    if (p && p.catch) p.catch(() => status('Fullscreen was refused by the browser', true));
  } else if (document.exitFullscreen) {
    document.exitFullscreen();
  }
}

function syncFullscreenButton() {
  const b = document.getElementById('btn-fullscreen');
  if (!b) return;
  const on = !!document.fullscreenElement;
  b.classList.toggle('active', on);
  b.title = on ? 'Leave fullscreen' : 'Fullscreen';
}
document.addEventListener('fullscreenchange', syncFullscreenButton);

function togglePerform() {
  if (document.body.classList.contains('perform')) {
    document.body.classList.remove('perform');
    if (state.rehearsalChar) endRehearsal();
    setMode('view');
    enablePagesEditing(true);
  } else {
    document.body.classList.add('perform');
    setMode('view');
    enablePagesEditing(false);
    // Pick the first .elem (or the one closest to the current scroll) as
    // the starting "active" anchor for arrow-key navigation.
    pickInitialPerformAnchor();
  }
}

// Toggle the page's editing affordances (just the `editable` class now — the
// page is read-only, but the class drives the title-page click-to-edit cursor).
// Used to lock those down in performance mode.
function enablePagesEditing(on) {
  $('view').classList.toggle('editable', on);
}

function performElems() {
  return Array.from(document.querySelectorAll('#view .elem, #view .page-title'));
}

function pickInitialPerformAnchor() {
  const elems = performElems();
  if (elems.length === 0) return;
  const pane = document.querySelector('.pane-view');
  if (!pane) return;
  const paneTop = pane.getBoundingClientRect().top;
  let pick = elems[0];
  for (const el of elems) {
    if (el.getBoundingClientRect().bottom > paneTop + 4) { pick = el; break; }
  }
  setPerformActive(pick);
}

function setPerformActive(el) {
  for (const old of document.querySelectorAll('.elem.perform-active, .page-title.perform-active')) {
    old.classList.remove('perform-active');
  }
  if (!el) return;
  el.classList.add('perform-active');
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function performStep(delta) {
  const elems = performElems();
  if (elems.length === 0) return;
  const cur = document.querySelector('.elem.perform-active, .page-title.perform-active');
  let idx = cur ? elems.indexOf(cur) : -1;
  idx += delta;
  if (idx < 0) idx = 0;
  if (idx >= elems.length) idx = elems.length - 1;
  setPerformActive(elems[idx]);
}

// ---------- wiring ----------
function wire() {
  // Topbar
  $('btn-save').onclick = saveScript;
  $('btn-new').onclick = newScript;
  $('btn-import').onclick = importFdx;
  $('btn-refresh').onclick = loadTree;
  $('btn-rename').onclick = renameScript;
  $('btn-delete').onclick = deleteScript;
  $('btn-history').onclick = openHistory;
  $('btn-export').onclick = exportPdf;
  $('btn-export-fdx').onclick = exportFdx;
  $('btn-perform').onclick = togglePerform;
  { const b = $('btn-fullscreen'); if (b) { b.onclick = toggleFullscreen; syncFullscreenButton(); } }
  $('btn-stats').onclick = openStats;
  $('btn-cards').onclick = openCards;
  $('btn-sidebar-toggle').onclick = toggleSidebar;
  $('btn-theme').onclick = openThemePicker;
  $('btn-help').onclick = openHelp;
  $('btn-zoom-in').onclick = zoomIn;
  $('btn-zoom-out').onclick = zoomOut;
  $('btn-zoom-reset').onclick = zoomReset;
  $('btn-sync').onclick = toggleSplitSync;

  for (const btn of document.querySelectorAll('.mode-switch button')) {
    btn.onclick = () => togglePane(btn.dataset.pane);
  }
  // Format toolbar buttons (data-cmd dispatch).
  for (const btn of document.querySelectorAll('#format-toolbar button[data-cmd]')) {
    btn.addEventListener('mousedown', (ev) => ev.preventDefault()); // keep editor selection
    btn.onclick = () => runCmd(btn.dataset.cmd);
  }

  const ta = $('editor');
  ta.addEventListener('input', onEditorInput);
  ta.addEventListener('keydown', onEditorKeydown);
  ta.addEventListener('blur', () => setTimeout(hideAutocomplete, 100));
  ta.addEventListener('contextmenu', onEditorContextMenu);

  // The page view is read-only; clicking an element locates the matching line
  // in the source so toolbar/menu operations act there.
  $('view').addEventListener('click', onPageClick);

  // Track which .elem holds the caret (for typewriter mode dim/active), and
  // mirror the source caret/selection onto the page (read-only indicator) in
  // split view.
  document.addEventListener('selectionchange', () => {
    trackActiveElem();
    recenterCaret();
    if (document.activeElement === $('editor')) mirrorFromSource();
  });

  const markupCb = $('show-markup');
  if (markupCb) markupCb.onchange = () => setShowMarkup(markupCb.checked);

  // Find & replace
  $('find-input').addEventListener('input', recomputeMatches);
  $('find-case').addEventListener('change', recomputeMatches);
  $('find-scope').addEventListener('change', recomputeMatches);
  $('find-input').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      ev.shiftKey ? findPrev() : findNext();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      closeFind();
    }
  });
  $('find-replace').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); replaceOne(); }
    if (ev.key === 'Escape') { ev.preventDefault(); closeFind(); }
  });
  $('find-prev').onclick = findPrev;
  $('find-next').onclick = findNext;
  $('find-replace-one').onclick = replaceOne;
  $('find-replace-all').onclick = replaceAll;
  $('find-close').onclick = closeFind;

  // File-tree right-click menu (delegated, so it survives tree re-renders).
  $('tree').addEventListener('contextmenu', onTreeContextMenu);

  const viewWrap = document.querySelector('.pane-view');
  viewWrap.addEventListener('contextmenu', onViewContextMenu);
  viewWrap.addEventListener('scroll', () => {
    if (state.mode === 'split') syncScroll(viewWrap, ta);
    // Re-position the page faux caret if it's currently shown — it's an
    // abs-positioned child of pane-view, which scrolls with the content.
    // Nothing to do here since scrolling moves the caret along naturally.
  });
  ta.addEventListener('scroll', () => {
    if (state.mode === 'split') syncScroll(ta, viewWrap);
    repositionFindHighlight();
  });

  // Close context menu on outside click / scroll.
  document.addEventListener('mousedown', (ev) => {
    if (!$('ctx-menu').contains(ev.target)) hideContextMenu();
  });
  document.addEventListener('scroll', hideContextMenu, true);

  // Global hotkey dispatcher (covers editor and page focus).
  document.addEventListener('keydown', onGlobalKeydown);

  // Persist scroll position (both panes) per file.
  if (viewWrap) {
    viewWrap.addEventListener('scroll', () => {
      if (state.currentPath) setScrollFor(state.currentPath, viewWrap.scrollTop, 'view');
    }, { passive: true });
  }
  ta.addEventListener('scroll', () => {
    if (state.currentPath) setScrollFor(state.currentPath, ta.scrollTop, 'source');
  }, { passive: true });

  window.addEventListener('hashchange', () => {
    const h = decodeURIComponent(location.hash.replace(/^#/, ''));
    if (h && h !== state.currentPath) openScript(h);
  });

  // Guard against losing unsaved edits if the window closes inside the
  // autosave window or while a save is failing.
  window.addEventListener('beforeunload', (ev) => {
    const anyDirty = state.dirty ||
      Object.values(state.tabState).some(t => t && t.dirty);
    if (anyDirty) { ev.preventDefault(); ev.returnValue = ''; return ''; }
  });
}

wire();
applyTheme(getTheme());
applySidebar(getSidebarOpen());
applyZoom(getZoom());
applyMarkupToggle(getShowMarkup());
applySpellcheck();
applyTypewriter(getTypewriter());
applyUiScale(getUiScale());
applySplitSyncButton();
state.mode = getMode();
setMode(state.mode);
loadTree().then(() => {
  const h = decodeURIComponent(location.hash.replace(/^#/, ''));
  const last = getLastOpen();
  if (h) openScript(h);
  else if (last) openScript(last);
});
