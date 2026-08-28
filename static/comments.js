// Comments anchored to ranges of the script.
//
// Loaded as a classic script after collab.js. Exposes window.Comments. Inert
// unless a collaboration session is active — comments live inside the same
// Y.Doc as the text, so they only exist in cloud mode.
//
// WHY THE SAME Y.DOC. Storing them there means sync, offline, conflict
// resolution, persistence and backups all come for free: doc_state.ydoc already
// carries them, so there is no server change and no second sync path. It also
// means a comment and the edit it refers to arrive together, never out of order.
//
// ANCHORING. A comment records Y.RelativePositions, not character offsets. A
// relative position stays on its words when someone inserts text above it —
// which is the entire reason this is worth doing on the CRDT rather than on
// plain indices. Verified: an anchor survives insertion above, below and
// immediately before itself.
//
// ORPHANS. When the anchored text is deleted, Yjs does not invalidate the
// positions; it collapses them toward a surviving neighbour, so `to - from`
// becomes 0. That is the orphan signal. Such a comment is kept, shown with the
// text it was originally attached to, and only a person may dismiss it — the
// deletion is often exactly what the comment was about, and a thread must not
// evaporate mid-conversation.

window.Comments = (function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  function notify(msg, isError) {
    try { if (typeof status === 'function') status(msg, isError); } catch { /* no-op */ }
  }

  // ---------- reaching the CRDT ----------

  const C = () => window.Collab;
  const live = () => !!(C() && C().active() && C().ydoc && C().ytext);
  const readOnly = () => !!(C() && C().readOnly);
  const arr = () => (live() ? C().ydoc.getArray('comments') : null);

  // ---------- model ----------

  function encodePos(index) {
    const Y = C().Y, t = C().ytext;
    return Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(t, index));
  }
  function decodePos(bytes) {
    const Y = C().Y;
    const abs = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(bytes), C().ydoc);
    return abs ? abs.index : null;
  }

  // A comment's live range, re-resolved from its relative positions every time.
  function rangeOf(m) {
    const from = decodePos(m.get('from'));
    const to = decodePos(m.get('to'));
    if (from == null || to == null) return { from: 0, to: 0, orphaned: true };
    return { from, to, orphaned: to - from === 0 };
  }

  // Plain-object view of every comment, for rendering.
  function list() {
    const a = arr();
    if (!a) return [];
    return a.toArray().map((m) => {
      const r = rangeOf(m);
      return {
        id: m.get('id'),
        from: r.from, to: r.to, orphaned: r.orphaned,
        quote: m.get('quote') || '',
        authorId: m.get('authorId') || '',
        authorName: m.get('authorName') || 'Someone',
        createdAt: m.get('createdAt') || 0,
        resolved: !!m.get('resolved'),
        replies: (m.get('replies') ? m.get('replies').toArray() : []).map((r2) => ({
          authorName: r2.get('authorName') || 'Someone',
          text: r2.get('text') || '',
          at: r2.get('at') || 0,
        })),
      };
    }).sort((x, y) => x.from - y.from || x.createdAt - y.createdAt);
  }

  function findMap(id) {
    const a = arr();
    if (!a) return null;
    return a.toArray().find((m) => m.get('id') === id) || null;
  }

  function add(from, to, text) {
    if (!live() || readOnly()) return null;
    const Y = C().Y, doc = C().ydoc, t = C().ytext;
    const me = window.Cloud && window.Cloud.user;
    const id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const who = (me && (me.name || me.email)) || 'Someone';
    const m = new Y.Map();
    doc.transact(() => {
      // ORDER MATTERS. A nested Y type can only be populated once its parent is
      // attached to the document - Yjs throws "Add Yjs type to a document before
      // reading data" otherwise. So the map goes into the array first, and the
      // replies list is filled afterwards.
      arr().push([m]);
      m.set('id', id);
      m.set('from', encodePos(from));
      m.set('to', encodePos(to));
      m.set('quote', t.toString().slice(from, to));
      m.set('authorId', (me && me.id) || '');
      m.set('authorName', who);
      m.set('createdAt', Date.now());
      m.set('resolved', false);
      m.set('replies', new Y.Array());

      const r = new Y.Map();
      m.get('replies').push([r]);
      r.set('authorName', who);
      r.set('text', text);
      r.set('at', Date.now());
    });
    return id;
  }

  function reply(id, text) {
    if (!live() || readOnly()) return;
    const m = findMap(id);
    if (!m) return;
    const Y = C().Y, doc = C().ydoc;
    const me = window.Cloud && window.Cloud.user;
    doc.transact(() => {
      const r = new Y.Map();
      m.get('replies').push([r]);   // attach before populating, as above
      r.set('authorName', (me && (me.name || me.email)) || 'Someone');
      r.set('text', text);
      r.set('at', Date.now());
    });
  }

  function setResolved(id, v) {
    if (!live() || readOnly()) return;
    const m = findMap(id);
    if (m) C().ydoc.transact(() => m.set('resolved', !!v));
  }

  function remove(id) {
    if (!live() || readOnly()) return;
    const a = arr();
    const i = a.toArray().findIndex((m) => m.get('id') === id);
    if (i >= 0) C().ydoc.transact(() => a.delete(i, 1));
  }

  // ---------- editor overlay ----------
  //
  // Mirrors the find-highlight pattern in app.js: one absolutely-positioned host
  // inside .pane-edit, a box per wrapped visual line, repositioned on scroll.

  function overlayHost() {
    const pane = document.querySelector('.pane-edit');
    if (!pane) return null;
    let host = $('comment-hl');
    if (!host) {
      host = document.createElement('div');
      host.id = 'comment-hl';
      host.setAttribute('aria-hidden', 'true');
      pane.appendChild(host);
    }
    return host;
  }

  // Rebuilding is EXPENSIVE: textareaRangeRects lays out the whole document in
  // the mirror div once per range. On a feature-length script that is tens of
  // kilobytes of text laid out per comment, so it must never run on a scroll or
  // a keystroke - doing so froze and then crashed the tab.
  //
  // Scrolling does not move the boxes relative to the text, only relative to the
  // viewport, so the host is offset with a transform instead. That is one style
  // write per scroll event and no layout at all.

  // Measures MANY ranges in a single mirror layout. app.js's textareaRangeRects
  // lays out the whole document once per range, which on a feature-length script
  // means tens of kilobytes of text laid out per comment. Batching turns that
  // into one pass.
  //
  // Ranges must be walked in order and not overlap for a single pass to work, so
  // anything that overlaps its predecessor falls back to a measurement of its
  // own. Overlapping comments are legitimate but uncommon, so the common case
  // stays at one layout.
  function batchRangeRects(ta, ranges) {
    const sorted = ranges.slice().sort((a, b) => a.from - b.from || a.to - b.to);
    const inline = [], spill = [];
    let pos = 0;
    for (const r of sorted) {
      if (r.from >= pos) { inline.push(r); pos = r.to; } else { spill.push(r); }
    }

    const out = new Map();
    if (inline.length) {
      const div = configTaMirror(ta);
      div.textContent = '';
      const spans = [];
      let at = 0;
      for (const r of inline) {
        if (r.from > at) div.appendChild(document.createTextNode(ta.value.slice(at, r.from)));
        const sp = document.createElement('span');
        sp.textContent = ta.value.slice(r.from, r.to);
        div.appendChild(sp);
        spans.push([r, sp]);
        at = r.to;
      }
      div.appendChild(document.createTextNode(ta.value.slice(at)));
      const mr = div.getBoundingClientRect();
      for (const [r, sp] of spans) {
        out.set(r.key, Array.from(sp.getClientRects()).map((c) => ({
          // Same sub-pixel calibration app.js applies - see scaleMirrorTop.
          top: scaleMirrorTop(ta, c.top - mr.top),
          left: c.left - mr.left, width: c.width, height: c.height,
        })));
      }
      div.textContent = '';
    }
    for (const r of spill) out.set(r.key, textareaRangeRects(ta, r.from, r.to));
    return out;
  }

  function rebuildOverlay() {
    const host = overlayHost();
    const ta = $('editor');
    if (!host || !ta) return;
    host.innerHTML = '';
    if (!live() || typeof textareaRangeRects !== 'function') return;

    const shown = list().filter((c) => !c.orphaned && !c.resolved);
    if (!shown.length) return;
    const rects = batchRangeRects(ta, shown.map((c) => ({ key: c.id, from: c.from, to: c.to })));
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 0;

    for (const c of shown) {
      for (const r of (rects.get(c.id) || [])) {
        const box = document.createElement('div');
        box.className = 'comment-hl-box';
        box.dataset.id = c.id;
        box.title = `${c.authorName}: ${c.replies[0] ? c.replies[0].text : ''}`;
        // Content coordinates - the scroll offset lives on the host.
        //
        // getClientRects returns the GLYPH box, which sits inside the taller
        // line box by half the leading, so a mark drawn on it alone reads as
        // sitting above the text. Cover the line box instead.
        const lead = lh > r.height ? (lh - r.height) / 2 : 0;
        box.style.top = (r.top - lead) + 'px';
        box.style.left = r.left + 'px';
        box.style.width = r.width + 'px';
        box.style.height = (lh || r.height) + 'px';
        box.onclick = () => focusComment(c.id);
        host.appendChild(box);
      }
    }
    positionOverlay();
  }

  // Cheap: called on every scroll event.
  function positionOverlay() {
    const host = $('comment-hl');
    const ta = $('editor');
    if (!host || !ta) return;
    host.style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`;
  }

  // ---------- sidebar panel ----------

  function panelHost() {
    const sidebar = $('sidebar');
    if (!sidebar) return null;
    let panel = $('comments-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'comments-panel';
      panel.className = 'outline-panel';
      panel.innerHTML = '<div class="section-head">Comments</div><div id="comments-list"></div>';
      sidebar.appendChild(panel);
    }
    return panel;
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function renderPanel() {
    const panel = panelHost();
    if (!panel) return;
    panel.classList.toggle('hidden', !live());
    if (!live()) return;

    const items = list();
    const open = items.filter((c) => !c.resolved && !c.orphaned);
    const orphan = items.filter((c) => !c.resolved && c.orphaned);
    const done = items.filter((c) => c.resolved);

    const host = $('comments-list');
    host.innerHTML = '';

    if (!items.length) {
      host.innerHTML = '<p class="comment-empty">Select text in the editor and choose ' +
                       '“Comment on selection” to start a thread.</p>';
      return;
    }

    const section = (label, group, cls) => {
      if (!group.length) return;
      if (label) {
        const h = document.createElement('div');
        h.className = 'comment-subhead';
        h.textContent = `${label} (${group.length})`;
        host.appendChild(h);
      }
      for (const c of group) host.appendChild(threadEl(c, cls));
    };

    section('', open, '');
    section('Orphaned', orphan, 'orphaned');
    section('Resolved', done, 'resolved');
  }

  function threadEl(c, cls) {
    const el = document.createElement('div');
    el.className = 'comment-thread' + (cls ? ' ' + cls : '');
    el.dataset.id = c.id;

    const quote = c.orphaned
      ? `<div class="comment-quote gone">${esc(c.quote)}</div>
         <div class="comment-note">The text this was attached to has been deleted.</div>`
      : `<div class="comment-quote">${esc(c.quote)}</div>`;

    el.innerHTML = quote +
      c.replies.map((r) => `
        <div class="comment-msg">
          <span class="comment-who">${esc(r.authorName)}</span>
          <span class="comment-text">${esc(r.text)}</span>
        </div>`).join('') +
      `<div class="comment-actions">
         <input class="comment-reply" type="text" placeholder="Reply…" />
         <button class="comment-resolve">${c.resolved ? 'Reopen' : 'Resolve'}</button>
         <button class="comment-delete" title="Delete this thread">×</button>
       </div>`;

    if (!c.orphaned) el.querySelector('.comment-quote').onclick = () => focusComment(c.id);

    const input = el.querySelector('.comment-reply');
    input.onkeydown = (ev) => {
      if (ev.key !== 'Enter' || !input.value.trim()) return;
      reply(c.id, input.value.trim());
      input.value = '';
      redraw();
    };
    el.querySelector('.comment-resolve').onclick = () => { setResolved(c.id, !c.resolved); redraw(); };
    el.querySelector('.comment-delete').onclick = () => {
      if (confirm('Delete this comment thread?')) { remove(c.id); redraw(); }
    };

    if (readOnly()) {
      for (const n of el.querySelectorAll('input,button')) n.disabled = true;
    }
    return el;
  }

  // Scroll both panes to a comment and flash it.
  function focusComment(id) {
    const c = list().find((x) => x.id === id);
    const ta = $('editor');
    if (!c || !ta || c.orphaned) return;
    if (typeof textareaCaretCoords === 'function') {
      const top = textareaCaretCoords(ta, c.from).top;
      ta.scrollTop = Math.max(0, top - ta.clientHeight / 3);
    }
    ta.setSelectionRange(c.from, c.to);
    const el = document.querySelector(`.comment-thread[data-id="${id}"]`);
    if (el) {
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 900);
      el.scrollIntoView({ block: 'nearest' });
    }
  }

  // ---------- composing ----------

  function commentOnSelection() {
    if (!live()) { notify('Comments need a cloud session'); return; }
    if (readOnly()) { notify('You have view-only access'); return; }
    const ta = $('editor');
    const from = ta.selectionStart, to = ta.selectionEnd;
    if (from === to) { notify('Select some text to comment on'); return; }

    const root = $('modal-root');
    root.classList.remove('hidden');
    root.innerHTML = `
      <div class="modal">
        <div class="modal-head"><h3>Add a comment</h3>
          <button class="icon-btn" id="modal-close">×</button></div>
        <div class="modal-body">
          <div class="comment-quote">${esc(ta.value.slice(from, to))}</div>
          <label class="cloud-field">Comment
            <textarea id="comment-input" rows="3"></textarea></label>
          <div class="modal-actions">
            <button id="comment-cancel" class="ghost">Cancel</button>
            <button id="comment-save" class="primary">Comment</button>
          </div>
        </div>
      </div>`;
    const close = () => root.classList.add('hidden');
    $('modal-close').onclick = close;
    $('comment-cancel').onclick = close;
    $('comment-save').onclick = () => {
      const text = $('comment-input').value.trim();
      if (!text) return;
      add(from, to, text);
      close();
      redraw();
    };
    setTimeout(() => $('comment-input').focus(), 0);
  }

  // ---------- lifecycle ----------

  let unsubscribe = null;
  let observed = null;          // the Y.Array we attached observeDeep to

  // Debounced, not rAF-throttled: onDocChange fires on every keystroke, and a
  // rebuild is far too heavy to run at that rate on a long script.
  let redrawTimer = null;
  function redraw() {
    clearTimeout(redrawTimer);
    redrawTimer = setTimeout(() => {
      redrawTimer = null;
      rebuildOverlay();
      renderPanel();
    }, 150);
  }

  // Called when a document's collaboration session starts.
  function attach() {
    detach();
    if (!live()) return;
    unsubscribe = C().onDocChange(redraw);
    observed = C().ydoc.getArray('comments');
    observed.observeDeep(redraw);
    const ta = $('editor');
    if (ta && !ta.dataset.commentScroll) {
      ta.dataset.commentScroll = '1';
      ta.addEventListener('scroll', positionOverlay);
    }
    redraw();
  }

  function detach() {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    // Switching documents replaces the Y.Doc; drop the observer with it rather
    // than leaving one bound to a doc that is about to be destroyed.
    if (observed) { try { observed.unobserveDeep(redraw); } catch {} observed = null; }
    const host = $('comment-hl');
    if (host) host.innerHTML = '';
    const panel = $('comments-panel');
    if (panel) panel.classList.add('hidden');
  }

  return {
    attach, detach, redraw, commentOnSelection, focusComment,
    list, add, reply, setResolved, remove,
    // Exposed for tests in collab/test-comments.mjs.
    _rangeOf: rangeOf,
  };
})();
