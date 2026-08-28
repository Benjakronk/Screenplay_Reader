// Live collaboration for the editor: binds the shared Y.Text of one document
// to the plain <textarea>.
//
// Loaded as a classic script after vendor/collab-bundle.js (which supplies
// window.FaaglarnaYjs) and before app.js uses it. Exposes window.Collab.
//
// HOW IT HOOKS IN. app.js already funnels every local mutation through
// markDirty(), so backend.js wraps that one function to also call
// Collab.syncFromTextarea(). No mutation site needs to know the CRDT exists;
// they keep assigning to textarea.value as they always did, and the diff below
// turns whatever changed into a minimal CRDT operation.
//
// WHY A DIFF AND NOT AN EDIT LOG. Trying to intercept fifteen separate
// mutation sites and describe each as a range operation is fragile — one missed
// site silently desyncs the document. Diffing the whole textarea is O(n) with
// two scans, and every real edit (a keystroke, a Tab-cycle, a find/replace hit)
// is one contiguous change, which prefix/suffix trimming locates exactly. At
// screenplay sizes (a long feature is well under 200 kB) this is far below the
// cost of the re-render that follows it.

window.Collab = (function () {
  'use strict';

  const LOCAL_ORIGIN = 'local-editor';

  let Y = null, HocuspocusProvider = null;
  let provider = null, ydoc = null, ytext = null, undoManager = null;
  let ta = null, docId = null;
  let applyingRemote = false;   // re-entrancy guard: our own patch must not echo
  let lastText = '';            // the text the CRDT and textarea last agreed on
  let hooks = {};
  let readOnly = false;

  // Yjs is ~120 kB and only cloud mode ever needs it, so the bundle is fetched
  // on demand rather than shipped to every offline visitor. index.html does not
  // reference it at all.
  let libsPromise = null;
  function ensureLibs() {
    if (Y) return Promise.resolve();
    if (libsPromise) return libsPromise;
    libsPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/collab-bundle.js';
      s.onload = () => {
        const lib = window.FaaglarnaYjs;
        if (!lib) return reject(new Error('collaboration bundle did not initialise'));
        Y = lib.Y;
        HocuspocusProvider = lib.HocuspocusProvider;
        resolve();
      };
      s.onerror = () => reject(new Error('could not load vendor/collab-bundle.js'));
      document.head.appendChild(s);
    });
    return libsPromise;
  }

  // ---------- diffing ----------

  // The one contiguous span in which `a` and `b` differ, found by trimming the
  // common prefix and the common suffix. Returns null when they are equal.
  function diffRange(a, b) {
    if (a === b) return null;
    const max = Math.min(a.length, b.length);
    let start = 0;
    while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++;
    let endA = a.length, endB = b.length;
    while (endA > start && endB > start &&
           a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) { endA--; endB--; }
    return { from: start, removed: endA - start, inserted: b.slice(start, endB) };
  }

  // ---------- local -> remote ----------

  // Called after any local mutation. Cheap and idempotent: if nothing changed
  // it returns immediately, so it is safe to call on every keystroke.
  function syncFromTextarea() {
    if (!ytext || !ta || applyingRemote || readOnly) return;
    const now = ta.value;
    const d = diffRange(lastText, now);
    if (!d) return;
    ydoc.transact(() => {
      if (d.removed) ytext.delete(d.from, d.removed);
      if (d.inserted) ytext.insert(d.from, d.inserted);
    }, LOCAL_ORIGIN);
    lastText = now;
    publishCursor();
    // The diff is exactly the shape of a tracked change, so suggest mode can
    // record it as one rather than recomputing anything.
    fireLocalEdit(d);
    fireDocChange();
  }

  // ---------- remote -> local ----------

  function applyRemote() {
    if (!ytext || !ta) return;
    const next = ytext.toString();
    const d = diffRange(ta.value, next);
    if (!d) { lastText = next; return; }

    applyingRemote = true;
    try {
      // setRangeText replaces only the changed span and, with 'preserve',
      // adjusts the selection around it — so a collaborator typing above the
      // caret does not drag it out from under the person typing here. A blunt
      // `ta.value = next` would drop the caret to the start every time.
      if (typeof ta.setRangeText === 'function') {
        const scrollTop = ta.scrollTop;
        ta.setRangeText(d.inserted, d.from, d.from + d.removed, 'preserve');
        ta.scrollTop = scrollTop;
      } else {
        const s = ta.selectionStart, e = ta.selectionEnd;
        const delta = d.inserted.length - d.removed;
        const remap = (p) => p <= d.from ? p
          : p >= d.from + d.removed ? p + delta
          : d.from + d.inserted.length;
        ta.value = next;
        ta.selectionStart = remap(s);
        ta.selectionEnd = remap(e);
      }
    } finally {
      applyingRemote = false;
    }
    lastText = ta.value;
    if (hooks.onRemoteChange) hooks.onRemoteChange(lastText);
  }

  // ---------- presence ----------

  function publishCursor() {
    if (!provider || !ta) return;
    try {
      provider.awareness.setLocalStateField('cursor', {
        anchor: ta.selectionStart, head: ta.selectionEnd,
      });
    } catch { /* awareness is best-effort */ }
  }

  function peers() {
    if (!provider) return [];
    const out = [];
    provider.awareness.getStates().forEach((state, clientId) => {
      if (clientId === ydoc.clientID) return;
      if (state && state.user) out.push({ clientId, ...state.user, cursor: state.cursor || null });
    });
    return out;
  }

  // Distinct, readable colours for collaborator chips.
  const COLORS = ['#d1495b', '#2e86ab', '#3f8f5b', '#b3761a', '#7b52ab', '#0f8b8d'];
  function colorFor(id) {
    let h = 0;
    for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return COLORS[h % COLORS.length];
  }

  // ---------- lifecycle ----------

  // Opens the collaboration socket for one document and binds it to the
  // textarea. Safe to call repeatedly; it detaches any previous document first.
  async function attach(opts) {
    await ensureLibs();
    detach();

    ta = opts.textarea || document.getElementById('editor');
    docId = opts.docId;
    hooks = opts.hooks || {};
    readOnly = opts.role === 'viewer';

    ydoc = new Y.Doc();
    provider = new HocuspocusProvider({
      url: opts.url,                  // wss://<api host>/collab
      name: String(docId),            // the document UUID, never its path
      document: ydoc,
      token: opts.token,
      onStatus: ({ status }) => hooks.onStatus && hooks.onStatus(status),
      onAuthenticationFailed: ({ reason }) =>
        hooks.onError && hooks.onError(reason || 'not allowed to open this script'),
    });

    // Must match Y_TEXT_FIELD in server-node/docs.js.
    ytext = ydoc.getText('content');

    // Per-user undo. A shared document must NOT use app.js's whole-document
    // snapshot stack: undoing there would also revert whatever a collaborator
    // typed elsewhere in the meantime. trackedOrigins scopes undo to edits made
    // in this browser.
    undoManager = new Y.UndoManager(ytext, {
      trackedOrigins: new Set([LOCAL_ORIGIN]),
      captureTimeout: 500,
    });

    ytext.observe((event, tr) => {
      if (tr.origin !== LOCAL_ORIGIN) applyRemote();   // our own edit comes back
      fireDocChange();
    });

    // First sync: adopt the server's copy wholesale.
    provider.on('synced', () => {
      lastText = '';                  // force a full diff against the textarea
      applyRemote();
      if (hooks.onSynced) hooks.onSynced(ytext.toString());
    });

    provider.awareness.setLocalStateField('user', {
      name: opts.user?.name || opts.user?.email || 'Someone',
      color: colorFor(opts.user?.id || ydoc.clientID),
    });
    provider.awareness.on('change', () => hooks.onPeers && hooks.onPeers(peers()));

    if (readOnly) ta.setAttribute('readonly', 'readonly');
    else ta.removeAttribute('readonly');

    return { docId };
  }

  function detach() {
    try { undoManager?.destroy(); } catch {}
    try { provider?.destroy(); } catch {}
    try { ydoc?.destroy(); } catch {}
    provider = ydoc = ytext = undoManager = null;
    docId = null;
    lastText = '';
    readOnly = false;
    if (ta) ta.removeAttribute('readonly');
  }

  const active = () => !!provider;

  function undo() { if (undoManager) { undoManager.undo(); afterUndo(); return true; } return false; }
  function redo() { if (undoManager) { undoManager.redo(); afterUndo(); return true; } return false; }
  function afterUndo() {
    applyRemote();
    lastText = ta ? ta.value : lastText;
  }

  // Fired after any change to the shared text, local or remote, so anything
  // anchored into it (comments, suggestions) can re-resolve its positions.
  const changeHooks = new Set();
  function onDocChange(fn) { changeHooks.add(fn); return () => changeHooks.delete(fn); }
  function fireDocChange() {
    for (const fn of changeHooks) {
      try { fn(); } catch { /* one bad listener must not stop the others */ }
    }
  }

  // Fired after a LOCAL edit is applied, carrying the {from, removed, inserted}
  // span that was applied. Suggest mode turns that span into a tracked change.
  const editHooks = new Set();
  function onLocalEdit(fn) { editHooks.add(fn); return () => editHooks.delete(fn); }
  function fireLocalEdit(d) {
    for (const fn of editHooks) {
      try { fn(d); } catch { /* as above */ }
    }
  }

  return {
    attach, detach, active, syncFromTextarea, undo, redo, peers, colorFor,
    // The CRDT itself, for features that anchor into the same document.
    // Null when not collaborating - callers must check.
    onDocChange, onLocalEdit,
    get Y() { return Y; },
    get ydoc() { return ydoc; },
    get ytext() { return ytext; },
    // Exposed for collab/test-binding.mjs, which fuzzes the diff against real
    // Yjs documents. Not part of the API the app uses.
    _diffRange: diffRange,
    get docId() { return docId; },
    get readOnly() { return readOnly; },
    get text() { return ytext ? ytext.toString() : ''; },
  };
})();
