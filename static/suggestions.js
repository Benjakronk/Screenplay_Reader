// Tracked changes: proposed edits that another person accepts or rejects.
//
// Loaded as a classic script after comments.js. Exposes window.Suggestions.
// Like comments, these live in the same Y.Doc as the text, so sync, offline,
// merge and persistence all come for free.
//
// THE TEXT IS ALWAYS REALLY IN THE DOCUMENT. An open insertion is text that
// exists and is marked green; an open deletion is text that exists and is
// marked red. That mirrors Word's "All Markup" view, and it is what keeps the
// textarea and the CRDT in agreement — there is no phantom text anywhere, so
// every existing feature (export, search, pagination, word count) keeps working
// on a document with open suggestions in it.
//
// Accepting or rejecting is therefore only ever "keep the text" or "remove the
// text", plus dropping the mark:
//
//              accept            reject
//   insert     keep the text     remove the text
//   delete     remove the text   keep the text
//
// SUGGEST MODE. With it on, typing still edits the textarea normally and
// collab.js's diff turns the change into a CRDT operation as usual — a
// suggestion is simply recorded over the span it reports, which is already
// exactly {from, removed, inserted}. Deletions are the awkward half: the text
// must NOT go, so beforeinput is cancelled and the range is marked instead.

window.Suggestions = (function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  function notify(msg, isError) {
    try { if (typeof status === 'function') status(msg, isError); } catch { /* no-op */ }
  }

  const C = () => window.Collab;
  const live = () => !!(C() && C().active() && C().ydoc && C().ytext);
  const readOnly = () => !!(C() && C().readOnly);
  const arr = () => (live() ? C().ydoc.getArray('suggestions') : null);

  let suggesting = false;

  // ---------- model ----------

  // WHICH WAY A RANGE END LEANS. A Yjs relative position binds to a character,
  // and `assoc` picks which side. With assoc 0 it binds to the character AFTER
  // the index, so text inserted exactly there lands inside the range; with
  // assoc -1 it binds to the character before, and inserted text lands outside.
  //
  // The two kinds of suggestion need opposite answers, and getting this wrong
  // is not cosmetic:
  //
  //   insert  greedy at both ends  - typing on continues one proposal instead
  //                                  of starting a new one per keystroke.
  //   delete  greedy at neither    - typing a replacement next to a deletion
  //                                  must NOT quietly mark the replacement for
  //                                  deletion too.
  //
  // The delete case was live: typing over a selection marked the replaced text
  // AND the text typed in its place, so accepting removed something nobody had
  // asked to remove.
  const ASSOC = {
    insert: { from: -1, to: 0 },
    delete: { from: 0, to: -1 },
  };

  function encodePos(index, assoc = 0) {
    const Y = C().Y;
    return Y.encodeRelativePosition(
      Y.createRelativePositionFromTypeIndex(C().ytext, index, assoc));
  }
  function decodePos(bytes) {
    const Y = C().Y;
    const abs = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(bytes), C().ydoc);
    return abs ? abs.index : null;
  }

  function list() {
    const a = arr();
    if (!a) return [];
    return a.toArray().map((m) => {
      const from = decodePos(m.get('from'));
      const to = decodePos(m.get('to'));
      const ok = from != null && to != null;
      return {
        id: m.get('id'),
        kind: m.get('kind'),
        from: ok ? from : 0,
        to: ok ? to : 0,
        // A suggestion whose span has been deleted out from under it has
        // nothing left to accept or reject.
        orphaned: !ok || to - from === 0,
        // Derived from the live range, because a range can extend after it
        // was recorded. The stored copy is only meaningful once orphaned, when
        // there is no range left to read.
        text: ok && to > from ? C().ytext.toString().slice(from, to) : (m.get('text') || ''),
        authorId: m.get('authorId') || '',
        authorName: m.get('authorName') || 'Someone',
        createdAt: m.get('createdAt') || 0,
      };
    }).sort((x, y) => x.from - y.from || x.createdAt - y.createdAt);
  }

  function findIndex(id) {
    const a = arr();
    return a ? a.toArray().findIndex((m) => m.get('id') === id) : -1;
  }
  function findMap(id) {
    const a = arr();
    return a ? (a.toArray().find((m) => m.get('id') === id) || null) : null;
  }

  const me = () => (window.Cloud && window.Cloud.user) || null;
  const who = () => { const u = me(); return (u && (u.name || u.email)) || 'Someone'; };

  function record(kind, from, to) {
    if (!live() || readOnly() || to <= from) return null;
    // As in comments.js: a proposal is a contribution worth a name.
    if (window.Blame) window.Blame.register();
    const Y = C().Y, doc = C().ydoc, t = C().ytext;
    const id = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const m = new Y.Map();
    const lean = ASSOC[kind] || ASSOC.delete;
    doc.transact(() => {
      arr().push([m]);           // attach before populating, as in comments.js
      m.set('id', id);
      m.set('kind', kind);
      m.set('from', encodePos(from, lean.from));
      m.set('to', encodePos(to, lean.to));
      m.set('text', t.toString().slice(from, to));
      m.set('authorId', (me() && me().id) || '');
      m.set('authorName', who());
      m.set('createdAt', Date.now());
    });
    return id;
  }

  // Typing one character at a time does NOT need merging: a Yjs range end
  // associates with the character after it, so inserting at the end of an open
  // insertion extends that range on its own. Verified — inserting "b" at the end
  // of a range covering "a" leaves it covering "ab".
  //
  // So the only thing to avoid is recording a SECOND suggestion over text an
  // existing one has already swallowed.
  function recordInsert(from, to) {
    if (!live() || readOnly() || to <= from) return null;
    const already = covering('insert', from, to);
    if (already) return already.id;        // tracked by the extended range
    return record('insert', from, to);
  }

  const myId = () => (me() && me().id) || '';

  // My own open suggestion of `kind` that already covers [from, to), if any.
  function covering(kind, from, to) {
    return list().find((s) =>
      s.kind === kind && !s.orphaned && s.authorId === myId() &&
      s.from <= from && s.to >= to) || null;
  }

  // Moves an existing range rather than adding a second one beside it.
  function extend(id, from, to) {
    const m = findMap(id);
    if (!m) return id;
    const lean = ASSOC[m.get('kind')] || ASSOC.delete;
    C().ydoc.transact(() => {
      m.set('from', encodePos(from, lean.from));
      m.set('to', encodePos(to, lean.to));
      m.set('text', C().ytext.toString().slice(from, to));
    });
    return id;
  }

  // Holding Backspace should grow ONE mark, not leave a trail of
  // single-character ones for the reviewer to accept individually.
  function recordDelete(from, to) {
    if (!live() || readOnly() || to <= from) return null;
    const touching = list().find((s) =>
      s.kind === 'delete' && !s.orphaned && s.authorId === myId() &&
      s.from <= to && s.to >= from);
    if (touching) {
      return extend(touching.id, Math.min(touching.from, from), Math.max(touching.to, to));
    }
    return record('delete', from, to);
  }

  // Backspacing away something you typed a moment ago should remove the
  // proposal, not leave an empty one behind: with no text left there is nothing
  // to accept or reject. Only the author prunes their own, so two clients never
  // race to delete the same entry by index.
  function pruneMyEmptyInserts() {
    if (!live() || readOnly()) return;
    for (const s of list()) {
      if (s.kind !== 'insert' || !s.orphaned || s.authorId !== myId()) continue;
      const at = findIndex(s.id);
      if (at >= 0) C().ydoc.transact(() => arr().delete(at, 1));
    }
  }

  // Resolving is only ever "keep the text" or "remove the text".
  function resolve(id, keepText) {
    if (!live() || readOnly()) return;
    const s = list().find((x) => x.id === id);
    const i = findIndex(id);
    if (!s || i < 0) return;
    C().ydoc.transact(() => {
      if (!keepText && !s.orphaned && s.to > s.from) {
        C().ytext.delete(s.from, s.to - s.from);
      }
      const at = findIndex(id);            // the delete above may have shifted it
      if (at >= 0) arr().delete(at, 1);
    });
  }

  const accept = (id) => {
    const s = list().find((x) => x.id === id);
    if (s) resolve(id, s.kind === 'insert');
  };
  const reject = (id) => {
    const s = list().find((x) => x.id === id);
    if (s) resolve(id, s.kind === 'delete');
  };

  function acceptAll() { for (const s of list()) accept(s.id); }
  function rejectAll() { for (const s of list()) reject(s.id); }

  // ---------- suggest mode ----------

  const enabled = () => suggesting;

  function setEnabled(on) {
    suggesting = !!on && live() && !readOnly();
    document.body.classList.toggle('suggesting', suggesting);
    const btn = $('btn-suggest');
    if (btn) {
      btn.classList.toggle('active', suggesting);
      btn.title = suggesting
        ? 'Suggesting — your edits are proposed, not applied. Click to stop.'
        : 'Suggest changes instead of editing directly';
    }
    notify(suggesting ? 'Suggesting: your edits are proposed for review' : 'Editing directly');
    return suggesting;
  }

  // Local edits arrive already reduced to one span by collab.js's diff. In
  // suggest mode an insertion becomes a proposal; a deletion should never reach
  // here, because beforeinput cancels it first.
  function onLocalEdit(d) {
    if (!suggesting || !d) return;
    if (d.inserted) recordInsert(d.from, d.from + d.inserted.length);
    if (d.removed) pruneMyEmptyInserts();
  }

  // Deleting must not remove anything: the text stays and is marked instead.
  // beforeinput is used rather than keydown because it covers Backspace, Delete,
  // cut, and typing over a selection under one event with a stated intent.
  function onBeforeInput(ev) {
    if (!suggesting || !live() || readOnly()) return;
    const ta = ev.target;
    const t = String(ev.inputType || '');
    const selStart = ta.selectionStart, selEnd = ta.selectionEnd;
    const isDelete = t.startsWith('delete');
    const replacing = selEnd > selStart;

    if (!isDelete && !replacing) return;      // a plain insertion: let it happen

    let from = selStart, to = selEnd;
    if (!replacing) {
      // A collapsed caret: Backspace marks the character before it, Delete the
      // one after.
      if (t === 'deleteContentBackward') { from = Math.max(0, selStart - 1); to = selStart; }
      else if (t === 'deleteContentForward') { from = selStart; to = Math.min(ta.value.length, selStart + 1); }
      else return;                            // some other deletion we do not model
    }
    if (to <= from) { ev.preventDefault(); return; }

    // Correcting a typo in what you are proposing right now is not a deletion
    // to track: that text is not in the document under review, so there is
    // nothing for anyone to reject. Let the browser really delete it and the
    // insert suggestion shrinks with it. Without this, fixing a mistype left a
    // removal mark sitting on top of your own pending addition.
    if (covering('insert', from, to)) return;

    ev.preventDefault();
    recordDelete(from, to);

    if (isDelete) {
      // Collapse to the edge the caret would have ended at, so repeated presses
      // walk through the text marking as they go.
      const caret = (t === 'deleteContentBackward') ? from : to;
      ta.setSelectionRange(caret, caret);
    } else {
      // Typing over a selection: the replaced text is marked for deletion and
      // the new text goes in after it, where it becomes an insert suggestion via
      // the normal path.
      ta.setSelectionRange(to, to);
      if (ev.data) {
        ta.setRangeText(ev.data, to, to, 'end');
        if (typeof markDirty === 'function') markDirty();
      }
    }
    redraw();
  }

  // ---------- rendering ----------

  function overlayHost() {
    const pane = document.querySelector('.pane-edit');
    if (!pane) return null;
    let host = $('suggest-hl');
    if (!host) {
      host = document.createElement('div');
      host.id = 'suggest-hl';
      host.setAttribute('aria-hidden', 'true');
      pane.appendChild(host);
    }
    return host;
  }

  function rebuildOverlay() {
    const host = overlayHost();
    const ta = $('editor');
    if (!host || !ta) return;
    host.innerHTML = '';
    if (!live() || typeof textareaRangeRects !== 'function') return;

    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 0;
    for (const s of list()) {
      if (s.orphaned) continue;
      for (const r of textareaRangeRects(ta, s.from, s.to)) {
        const box = document.createElement('div');
        box.className = 'suggest-hl-box ' + s.kind;
        box.dataset.id = s.id;
        box.title = `${s.authorName} suggests ${s.kind === 'insert' ? 'adding' : 'removing'} this`;
        const lead = lh > r.height ? (lh - r.height) / 2 : 0;
        box.style.top = (r.top - lead) + 'px';
        box.style.left = r.left + 'px';
        box.style.width = r.width + 'px';
        box.style.height = (lh || r.height) + 'px';
        host.appendChild(box);
      }
    }
    positionOverlay();
  }

  function positionOverlay() {
    const host = $('suggest-hl'), ta = $('editor');
    if (!host || !ta) return;
    host.style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`;
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function panelHost() {
    const sidebar = $('sidebar');
    if (!sidebar) return null;
    let panel = $('suggestions-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'suggestions-panel';
      panel.className = 'outline-panel';
      panel.innerHTML =
        '<div class="section-head">Suggestions <span id="suggest-count"></span></div>' +
        '<div id="suggestions-list"></div>';
      sidebar.appendChild(panel);
    }
    return panel;
  }

  function renderPanel() {
    const panel = panelHost();
    if (!panel) return;
    const items = list();
    panel.classList.toggle('hidden', !live() || !items.length);
    if (!live() || !items.length) return;

    $('suggest-count').textContent = `(${items.length})`;
    renderInto($('suggestions-list'));
  }

  function itemEl(s) {
    const el = document.createElement('div');
    el.className = 'suggest-item ' + s.kind + (s.orphaned ? ' orphaned' : '');
    el.innerHTML =
      `<div class="suggest-head">
         <span class="suggest-kind">${s.kind === 'insert' ? 'add' : 'remove'}</span>
         <span class="suggest-who">${esc(s.authorName)}</span>
       </div>
       <div class="suggest-text">${esc(s.text)}</div>` +
      (s.orphaned ? '<div class="comment-note">This text is no longer in the script.</div>' : '') +
      `<div class="suggest-actions">
         <button class="suggest-accept">Accept</button>
         <button class="suggest-reject">Reject</button>
       </div>`;
    el.querySelector('.suggest-accept').onclick = () => { accept(s.id); redraw(); };
    el.querySelector('.suggest-reject').onclick = () => { reject(s.id); redraw(); };
    if (!s.orphaned) {
      el.querySelector('.suggest-text').onclick = () => {
        const ta = $('editor');
        if (!ta) return;
        if (typeof textareaCaretCoords === 'function') {
          ta.scrollTop = Math.max(0, textareaCaretCoords(ta, s.from).top - ta.clientHeight / 3);
        }
        ta.setSelectionRange(s.from, s.to);
      };
    }
    if (readOnly()) for (const b of el.querySelectorAll('button')) b.disabled = true;
    return el;
  }

  // Builds the list into any host, so the sidebar panel and the review modal
  // stay one implementation. Returns how many there are.
  function renderInto(host) {
    if (!host || !live()) return 0;
    const items = list();
    host.innerHTML = '';
    if (!items.length) {
      host.innerHTML = '<p class="comment-empty">Turn on suggest mode (✎) and type: ' +
                       'your changes are proposed for someone else to accept.</p>';
      return 0;
    }
    for (const s of items) host.appendChild(itemEl(s));
    return items.length;
  }

  // ---------- lifecycle ----------

  let unsubDoc = null, unsubEdit = null, observed = null, timer = null;

  function redraw() {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; rebuildOverlay(); renderPanel(); }, 150);
  }

  function attach() {
    detach();
    if (!live()) return;
    unsubDoc = C().onDocChange(redraw);
    unsubEdit = C().onLocalEdit(onLocalEdit);
    observed = C().ydoc.getArray('suggestions');
    observed.observeDeep(redraw);

    const btn = $('btn-suggest');
    if (btn) {
      btn.classList.remove('hidden');
      btn.onclick = () => { setEnabled(!suggesting); redraw(); };
    }

    const ta = $('editor');
    if (ta && !ta.dataset.suggestBound) {
      ta.dataset.suggestBound = '1';
      ta.addEventListener('scroll', positionOverlay);
      ta.addEventListener('beforeinput', onBeforeInput);
    }
    redraw();
  }

  function detach() {
    if (unsubDoc) { unsubDoc(); unsubDoc = null; }
    if (unsubEdit) { unsubEdit(); unsubEdit = null; }
    if (observed) { try { observed.unobserveDeep(redraw); } catch {} observed = null; }
    setEnabled(false);
    const host = $('suggest-hl');
    if (host) host.innerHTML = '';
    const panel = $('suggestions-panel');
    if (panel) panel.classList.add('hidden');
    const btn = $('btn-suggest');
    if (btn) btn.classList.add('hidden');
  }

  return {
    attach, detach, redraw,
    enabled, setEnabled, toggle: () => setEnabled(!suggesting),
    list, accept, reject, acceptAll, rejectAll,
    // Used by review.js to build the same list inside its modal.
    renderInto,
    // Exposed for collab/test-suggestions.mjs.
    _recordInsert: recordInsert, _recordDelete: recordDelete,
  };
})();
