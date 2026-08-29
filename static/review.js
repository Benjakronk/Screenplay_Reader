// A dedicated window onto everything awaiting review: comments and suggestions
// side by side, with the same controls as the sidebar.
//
// Loaded as a classic script after comments.js and suggestions.js, whose
// renderInto() it calls — the lists are built by the modules that own them, so
// there is one implementation of a thread and one of a suggestion, not two that
// drift apart.
//
// WHY THIS EXISTS ALONGSIDE THE SIDEBAR. On a narrow screen the sidebar is the
// first thing to go, and its panels scroll inside an already-short column, so
// review work was the hardest thing to do on the smallest screen. The modal
// gets the full window, which is exactly where reading a colleague's notes and
// accepting their changes wants to happen. It is an addition, not a
// replacement: the sidebar panels and the editor overlay are untouched.

window.Review = (function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const C = () => window.Collab;
  const live = () => !!(C() && C().active() && C().ydoc && C().ytext);

  let open = false;
  let unsubDoc = null, watched = [], timer = null;

  // ---------- counts ----------

  function counts() {
    const c = (window.Comments && live()) ? window.Comments.list() : [];
    const s = (window.Suggestions && live()) ? window.Suggestions.list() : [];
    return {
      comments: c.filter((x) => !x.resolved).length,
      suggestions: s.length,
      total: c.filter((x) => !x.resolved).length + s.length,
    };
  }

  // The button carries the count, because on a small screen the sidebar that
  // would otherwise show it may not be on screen at all.
  let lastBadge = null;
  function renderBadge() {
    const btn = $('btn-review'), badge = $('review-count');
    if (!btn || !badge) return;
    const n = counts().total;
    const shape = `${live()}|${n}`;
    if (shape === lastBadge) return;      // nothing that changes the width
    lastBadge = shape;

    btn.classList.toggle('hidden', !live());
    badge.textContent = n > 99 ? '99+' : String(n);
    badge.classList.toggle('hidden', n === 0);
    btn.title = n
      ? `Comments and suggestions (${n} open)`
      : 'Comments and suggestions';
    // The button just changed width, so what still fits has changed with it.
    if (typeof window.layoutTopbar === 'function') window.layoutTopbar();
  }

  // ---------- the modal ----------

  function build() {
    const root = $('modal-root');
    if (!root) return null;
    root.classList.remove('hidden');
    root.innerHTML = `
      <div class="modal modal-review">
        <div class="modal-head">
          <h3>Comments &amp; suggestions</h3>
          <button class="icon-btn" id="review-close" aria-label="Close">×</button>
        </div>
        <div class="modal-body">
          <div class="review-cols">
            <section class="review-col">
              <h4>Suggestions <span id="review-scount" class="review-n"></span></h4>
              <div class="review-bulk">
                <button id="review-accept-all" class="ghost">Accept all</button>
                <button id="review-reject-all" class="ghost">Reject all</button>
              </div>
              <div id="review-suggestions" class="review-list"></div>
            </section>
            <section class="review-col">
              <h4>Comments <span id="review-ccount" class="review-n"></span></h4>
              <div class="review-bulk">
                <button id="review-new-comment" class="ghost">Comment on selection</button>
              </div>
              <div id="review-comments" class="review-list"></div>
            </section>
          </div>
        </div>
      </div>`;

    $('review-close').onclick = close;

    const S = window.Suggestions;
    const M = window.Comments;
    const readOnly = !!(C() && C().readOnly);

    $('review-accept-all').onclick = () => {
      if (!confirm('Accept every open suggestion?')) return;
      S.acceptAll(); S.redraw(); refresh();
    };
    $('review-reject-all').onclick = () => {
      if (!confirm('Reject every open suggestion?')) return;
      S.rejectAll(); S.redraw(); refresh();
    };
    $('review-new-comment').onclick = () => {
      // commentOnSelection replaces the modal with its own composer, so this
      // deliberately hands over rather than nesting.
      close();
      M.commentOnSelection();
    };
    if (readOnly) {
      for (const id of ['review-accept-all', 'review-reject-all', 'review-new-comment']) {
        const b = $(id); if (b) b.disabled = true;
      }
    }

    return root;
  }

  // #modal-root is shared with every other modal in the app, so "is my modal
  // still the one on screen?" is a real question: opening History over the top
  // of this replaces the whole subtree. Anything that touches the DOM has to
  // ask first, or it operates on someone else's modal - or on nothing.
  const showing = () => open && !!$('review-suggestions');

  // Jumping to a line is pointless behind a full-screen modal, so a click on
  // any quote closes it first. Capture phase, so this runs BEFORE the handler
  // the list item installed; closing only hides the modal root, so that handler
  // still runs and still scrolls the editor.
  //
  // Bound once, not per open: build() runs on every show, and re-binding there
  // would stack a listener each time.
  {
    const root = $('modal-root');
    if (root) {
      root.addEventListener('click', (ev) => {
        if (!showing()) return;
        if (ev.target.closest('.comment-quote, .suggest-text')) close();
      }, true);
    }
  }

  function refresh() {
    if (!open) { renderBadge(); return; }
    // Another modal took the root over. Stand down rather than write into it.
    if (!showing()) { open = false; renderBadge(); return; }
    if (!live()) { close(); return; }
    const n = counts();
    const s = window.Suggestions.renderInto($('review-suggestions'));
    const c = window.Comments.renderInto($('review-comments'));
    $('review-scount').textContent = s ? `(${s})` : '';
    $('review-ccount').textContent = c ? `(${c})` : '';
    const bulk = !s || !!(C() && C().readOnly);
    for (const id of ['review-accept-all', 'review-reject-all']) {
      const b = $(id); if (b) b.disabled = bulk;
    }
    renderBadge();
  }

  function show() {
    if (!live()) { return; }
    if (!build()) return;
    open = true;
    refresh();
  }

  function close() {
    const mine = showing();
    open = false;
    const root = $('modal-root');
    // Only pull down the overlay if it is still ours — never someone else's.
    if (root && mine) root.classList.add('hidden');
    renderBadge();
  }

  function toggle() { showing() ? close() : show(); }

  // ---------- lifecycle ----------

  // Debounced for the same reason the panels are: onDocChange fires on every
  // keystroke, and re-rendering two lists at that rate is wasted work.
  function scheduleRefresh() {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; refresh(); }, 150);
  }

  function attach() {
    detach();
    lastBadge = null;               // a different document; remeasure from scratch
    if (!live()) return;
    unsubDoc = C().onDocChange(scheduleRefresh);
    for (const name of ['comments', 'suggestions']) {
      const arr = C().ydoc.getArray(name);
      arr.observeDeep(scheduleRefresh);
      watched.push(arr);
    }
    const btn = $('btn-review');
    if (btn) btn.onclick = toggle;
    renderBadge();
  }

  function detach() {
    if (unsubDoc) { unsubDoc(); unsubDoc = null; }
    for (const arr of watched) {
      try { arr.unobserveDeep(scheduleRefresh); } catch { /* doc already gone */ }
    }
    watched = [];
    if (open) close();
    lastBadge = null;
    const btn = $('btn-review');
    if (btn) btn.classList.add('hidden');
    if (typeof window.layoutTopbar === 'function') window.layoutTopbar();
  }

  // Escape closes it, matching the app's other modals.
  document.addEventListener('keydown', (ev) => {
    if (showing() && ev.key === 'Escape') { ev.stopPropagation(); close(); }
  }, true);

  return { attach, detach, show, close, toggle, refresh, counts, get open() { return open; } };
})();
