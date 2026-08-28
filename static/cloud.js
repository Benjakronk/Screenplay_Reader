// Cloud mode: accounts, sharing, and the live-collaboration lifecycle.
//
// This is the third of the app's three backends. backend.js decides which one
// is in play (see its detect()); this file owns everything specific to the
// hosted one:
//
//   - the session token and the sign-in / sign-out UI
//   - joining and leaving a document's collaboration session as tabs change
//   - the collaborator chips in the toolbar and the share dialog
//
// HOW IT ATTACHES TO app.js. It doesn't modify it. app.js declares its
// functions at the top level of a classic script, so they are properties of
// window, and this file wraps the four that matter — the same override idiom
// backend.js already uses for window.fetch and the export button. app.js stays
// byte-for-byte the file that the local server and the offline build run, so
// neither of those modes can be broken by anything here.

window.Cloud = (function () {
  'use strict';

  const TOKEN_KEY = 'faaglarna-cloud-token';
  const BASE_KEY  = 'faaglarna-cloud-base';   // dev override for the API origin

  // The UNWRAPPED fetch, captured at load time. This file must be loaded BEFORE
  // backend.js, whose wrapper waits on the boot decision — and the boot decision
  // waits on probe() below. Going through the wrapper here would deadlock.
  const rawFetch = window.fetch.bind(window);

  let base = '';
  let token = '';
  let user = null;
  let signedIn = false;
  let peers = [];

  const $ = (id) => document.getElementById(id);

  // app.js is a classic script: its `function` declarations become window
  // properties, but `const state` is a lexical global that never lands on
  // window, and `status` collides with the browser's built-in window.status
  // string. Reach both as bare identifiers, defensively.
  function notify(msg, isError) {
    try { if (typeof status === 'function') status(msg, isError); } catch { /* no-op */ }
  }
  function currentPath() {
    try { return (typeof state !== 'undefined' && state.currentPath) || null; }
    catch { return null; }
  }

  // ---------- configuration ----------

  function configuredBase() {
    // localStorage wins so a developer can point a Pages build at a local API
    // without editing the committed config.
    try {
      const override = localStorage.getItem(BASE_KEY);
      if (override) return override.replace(/\/+$/, '');
    } catch { /* private mode */ }
    return String(window.FAAGLARNA_CLOUD || '').replace(/\/+$/, '');
  }

  // Computed from the config, not from `base`, so it answers correctly before
  // probe() has run.
  function enabled() { return !!configuredBase(); }

  // True when the API is served from this very origin (the frontend and the
  // backend share a host). backend.js uses this to skip a probe that would only
  // ever return 401 and clutter the console.
  function sameOrigin() {
    try { return configuredBase() === location.origin; } catch { return false; }
  }
  function active()  { return signedIn; }

  // wss://<host>/collab — derived from the API origin so there is one setting.
  function wsUrl() {
    return base.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:') + '/collab';
  }

  function loadToken() {
    try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
  }
  function saveToken(t) {
    try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); }
    catch { /* private mode: session lasts until reload */ }
  }

  // ---------- API ----------

  // Talks to the cloud API directly, bypassing backend.js's fetch shim. Used
  // for the endpoints that only exist in cloud mode (login, share, …).
  async function api(path, opts = {}) {
    const headers = Object.assign({}, opts.headers);
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    const res = await rawFetch(base + path, {
      method: opts.method || 'GET',
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty or non-JSON body */ }
    if (!res.ok) throw new Error((data && data.error) || `request failed (${res.status})`);
    return data;
  }

  // Is the stored token still good? Called once at boot by backend.js.
  async function probe() {
    base = configuredBase();
    if (!base) return false;
    token = loadToken();
    if (!token) return false;
    try {
      const me = await api('/api/me');
      user = me.user;
      signedIn = true;
      return true;
    } catch {
      saveToken('');
      token = '';
      return false;
    }
  }

  async function login(email, password) {
    const out = await api('/api/login', { method: 'POST', body: { email, password } });
    token = out.token;
    user = out.user;
    signedIn = true;
    saveToken(token);
    return user;
  }

  async function acceptInvite(inviteToken, email, password, name) {
    const out = await api('/api/accept-invite', {
      method: 'POST', body: { token: inviteToken, email, password, name },
    });
    token = out.token;
    user = out.user;
    signedIn = true;
    saveToken(token);
    return user;
  }

  async function logout() {
    try { await api('/api/logout', { method: 'POST' }); } catch { /* going anyway */ }
    if (window.Collab) window.Collab.detach();
    token = ''; user = null; signedIn = false; peers = [];
    saveToken('');
    location.reload();          // simplest way back to a clean signed-out state
  }

  // Auth headers for backend.js's fetch shim.
  function authHeaders() { return token ? { Authorization: 'Bearer ' + token } : {}; }

  // ---------- collaboration lifecycle ----------

  // Joins the collaboration session for whatever document is open. app.js has
  // already painted the text it fetched over REST; once the socket syncs, the
  // CRDT's copy replaces it, which also corrects app.js's per-tab content cache
  // if it had gone stale while the tab was in the background.
  async function joinDocument(path) {
    if (!signedIn || !window.Collab) return;
    let info;
    try {
      info = await api('/api/file?path=' + encodeURIComponent(path));
    } catch (err) {
      notify('Could not open: ' + err.message, true);
      return;
    }
    if (!info || !info.id) return;

    try {
      await window.Collab.attach({
        url: wsUrl(),
        token,
        docId: info.id,
        role: info.role,
        user,
        textarea: $('editor'),
        hooks: {
          onSynced: () => { repaint(); setStatus('synced'); },
          onRemoteChange: () => repaint(),
          onPeers: (list) => { peers = list; renderPeers(); },
          onStatus: (s) => setStatus(s),
          onError: (msg) => notify(msg, true),
        },
      });
    } catch (err) {
      // The bundle failed to load, or the socket was refused. The document is
      // still open and editable — it just isn't syncing, and saves still work
      // over REST.
      notify('Live editing unavailable: ' + err.message, true);
      setStatus('offline');
      return;
    }
    renderPeers();
    markReadOnly(info.role === 'viewer');
  }

  function leaveDocument() {
    if (window.Collab) window.Collab.detach();
    peers = [];
    renderPeers();
  }

  // A remote edit changed the textarea; re-run app.js's own parse + preview.
  function repaint() {
    try {
      if (typeof window.reparseSource === 'function') window.reparseSource();
      if (typeof window.scheduleRender === 'function') window.scheduleRender();
    } catch { /* the preview will catch up on the next keystroke */ }
  }

  function markReadOnly(ro) {
    for (const id of ['btn-save', 'btn-rename', 'btn-delete']) {
      const el = $(id);
      if (el && ro) { el.disabled = true; el.title = 'You have view-only access'; }
    }
  }

  // ---------- UI ----------

  let statusEl = null, peersEl = null;

  function setStatus(s) {
    if (!statusEl) return;
    const label = s === 'connected' || s === 'synced' ? 'Live'
      : s === 'connecting' ? 'Connecting…'
      : 'Offline';
    statusEl.textContent = label;
    statusEl.className = 'cloud-status ' + (label === 'Live' ? 'live' : 'down');
    statusEl.title = label === 'Live'
      ? 'Connected — edits sync as you type'
      : 'Not connected. Your edits are kept and will sync when the connection returns.';
  }

  function renderPeers() {
    if (!peersEl) return;
    peersEl.innerHTML = '';
    for (const p of peers) {
      const chip = document.createElement('span');
      chip.className = 'peer-chip';
      chip.style.background = p.color || '#666';
      chip.textContent = (p.name || '?').trim().charAt(0).toUpperCase();
      chip.title = `${p.name} is editing this script`;
      peersEl.appendChild(chip);
    }
    peersEl.classList.toggle('hidden', peers.length === 0);
  }

  // Adds the account button, connection pill and collaborator chips to the
  // toolbar. Called by backend.js after app.js has bound its own UI.
  function adaptUi() {
    document.body.classList.add('cloud-mode');
    const actions = document.querySelector('.topbar .actions');
    if (!actions) return;

    peersEl = document.createElement('span');
    peersEl.className = 'peer-chips hidden';

    statusEl = document.createElement('span');
    statusEl.className = 'cloud-status down';
    statusEl.textContent = 'Offline';

    const shareBtn = document.createElement('button');
    shareBtn.id = 'btn-share';
    shareBtn.title = 'Share this script';
    shareBtn.textContent = '⇗ Share';
    shareBtn.onclick = openShareDialog;

    const acct = document.createElement('button');
    acct.className = 'icon-btn';
    acct.id = 'btn-account';
    acct.textContent = (user?.name || user?.email || '?').trim().charAt(0).toUpperCase();
    acct.title = `Signed in as ${user?.email || 'unknown'}`;
    acct.onclick = openAccountDialog;

    actions.insertBefore(peersEl, actions.firstChild);
    actions.insertBefore(statusEl, actions.firstChild);
    actions.appendChild(shareBtn);
    actions.appendChild(acct);

    // Bring across whatever you wrote before you had an account: export a
    // backup from the offline build, import it here.
    const sidebarTools = document.getElementById('btn-import')?.parentElement;
    if (sidebarTools) {
      const b = document.createElement('button');
      b.textContent = '☁ Import backup';
      b.title = 'Copy scripts from an offline backup file into your cloud account';
      b.onclick = importBackup;
      sidebarTools.appendChild(b);
    }
  }

  // ---------- moving offline work into the cloud ----------

  // Reads a backup file produced by the offline build's Backup button and
  // recreates each script in the cloud. Reuses that existing JSON format rather
  // than inventing a migration path: export from the offline app, import here.
  // Paths that already exist are skipped, so re-running it is safe.
  function importBackup() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const file = input.files && input.files[0];
      if (!file) return;

      let data;
      try { data = JSON.parse(await file.text()); }
      catch { notify('That is not a valid backup file', true); return; }
      const files = Array.isArray(data && data.files) ? data.files : null;
      if (!files) { notify('That file has no scripts in it', true); return; }

      let added = 0, skipped = 0, failed = 0;
      for (const f of files) {
        if (!f || typeof f.path !== 'string') { failed++; continue; }
        notify(`Importing ${added + skipped + failed + 1}/${files.length}…`);
        try {
          const created = await api('/api/new', {
            method: 'POST', body: { path: f.path, content: f.content || '' },
          });
          // /api/new seeds the CRDT with the content, so there is nothing
          // further to sync — the document is complete as soon as it exists.
          if (created && created.id) added++; else failed++;
        } catch (e) {
          if (/already exists/i.test(e.message)) skipped++; else failed++;
        }
      }

      notify(`Imported ${added} script(s)` +
             (skipped ? `, skipped ${skipped} already here` : '') +
             (failed ? `, ${failed} failed` : ''), failed > 0);
      if (typeof window.loadTree === 'function') window.loadTree();
    };
    input.click();
  }

  function modal(html) {
    const root = $('modal-root');
    root.classList.remove('hidden');
    root.innerHTML = html;
    const close = $('modal-close');
    if (close) close.onclick = () => root.classList.add('hidden');
    return root;
  }
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // Shown by backend.js when the app is configured for cloud but nobody is
  // signed in. "Continue offline" is always available — an account is for
  // collaborating, never a gate on using the app.
  function openSignInDialog(onDone) {
    const invite = new URLSearchParams(location.search).get('invite');
    const root = modal(`
      <div class="modal">
        <div class="modal-head">
          <h3>${invite ? 'Accept your invitation' : 'Sign in to Faaglarna'}</h3>
          <button class="icon-btn" id="modal-close">×</button>
        </div>
        <div class="modal-body">
          <p class="cloud-hint">${invite
            ? 'Pick a password and your account is ready.'
            : 'Sign in to reach your scripts from anywhere and write together in real time.'}</p>
          <label class="cloud-field">Email<input id="cloud-email" type="email" autocomplete="username" /></label>
          ${invite ? '<label class="cloud-field">Your name<input id="cloud-name" type="text" /></label>' : ''}
          <label class="cloud-field">Password<input id="cloud-pw" type="password"
            autocomplete="${invite ? 'new-password' : 'current-password'}" /></label>
          <p id="cloud-error" class="cloud-error hidden"></p>
          <div class="modal-actions">
            <button id="cloud-offline" class="ghost">Continue offline</button>
            <button id="cloud-go" class="primary">${invite ? 'Create account' : 'Sign in'}</button>
          </div>
        </div>
      </div>`);

    const err = $('cloud-error');
    const fail = (m) => { err.textContent = m; err.classList.remove('hidden'); };

    const go = async () => {
      const email = $('cloud-email').value.trim();
      const pw = $('cloud-pw').value;
      if (!email || !pw) return fail('Email and password are both required.');
      $('cloud-go').disabled = true;
      try {
        if (invite) await acceptInvite(invite, email, pw, $('cloud-name')?.value || '');
        else await login(email, pw);
        root.classList.add('hidden');
        history.replaceState(null, '', location.pathname + location.hash);
        onDone(true);
      } catch (e) {
        $('cloud-go').disabled = false;
        fail(e.message);
      }
    };

    $('cloud-go').onclick = go;
    $('cloud-pw').onkeydown = (e) => { if (e.key === 'Enter') go(); };
    $('cloud-offline').onclick = () => { root.classList.add('hidden'); onDone(false); };
    if (invite) {
      api('/api/invite?token=' + encodeURIComponent(invite))
        .then(info => { if (info.email) $('cloud-email').value = info.email; })
        .catch(() => fail('That invitation link is invalid or has expired.'));
    }
    setTimeout(() => $('cloud-email').focus(), 0);
  }

  // Who you are, changing your password, and signing out. Reached from the
  // initial in the toolbar.
  function openAccountDialog() {
    const root = modal(`
      <div class="modal">
        <div class="modal-head">
          <h3>Your account</h3>
          <button class="icon-btn" id="modal-close">×</button>
        </div>
        <div class="modal-body">
          <p class="cloud-hint">Signed in as <strong>${esc(user?.email || '')}</strong>${
            user?.name ? ' &middot; ' + esc(user.name) : ''}</p>

          <h4 class="cloud-subhead">Change password</h4>
          <label class="cloud-field">Current password<input id="pw-current" type="password"
            autocomplete="current-password" /></label>
          <label class="cloud-field">New password<input id="pw-new" type="password"
            autocomplete="new-password" /></label>
          <label class="cloud-field">Repeat new password<input id="pw-again" type="password"
            autocomplete="new-password" /></label>
          <p class="cloud-hint">At least 10 characters. Changing it signs you out
             everywhere else, but keeps you signed in here.</p>
          <p id="pw-error" class="cloud-error hidden"></p>
          <p id="pw-ok" class="cloud-hint hidden"></p>

          <div class="modal-actions">
            <button id="acct-signout" class="ghost">Sign out</button>
            <button id="pw-save" class="primary">Change password</button>
          </div>
        </div>
      </div>`);

    const err = $('pw-error'), ok = $('pw-ok');
    const fail = (m) => { ok.classList.add('hidden'); err.textContent = m; err.classList.remove('hidden'); };

    $('acct-signout').onclick = () => {
      if (confirm(`Sign out of ${user?.email}?`)) logout();
    };

    $('pw-save').onclick = async () => {
      const cur = $('pw-current').value;
      const nw = $('pw-new').value;
      const again = $('pw-again').value;
      if (!cur || !nw) return fail('Fill in your current and new password.');
      if (nw !== again) return fail('The two new passwords do not match.');
      if (nw.length < 10) return fail('The new password must be at least 10 characters.');

      $('pw-save').disabled = true;
      try {
        const out = await api('/api/password', {
          method: 'POST', body: { currentPassword: cur, newPassword: nw },
        });
        err.classList.add('hidden');
        ok.textContent = out.otherSessionsEnded
          ? `Password changed. ${out.otherSessionsEnded} other session(s) signed out.`
          : 'Password changed.';
        ok.classList.remove('hidden');
        for (const id of ['pw-current', 'pw-new', 'pw-again']) $(id).value = '';
        notify('Password changed');
      } catch (e) {
        fail(e.message);
      } finally {
        $('pw-save').disabled = false;
      }
    };

    $('pw-again').onkeydown = (e) => { if (e.key === 'Enter') $('pw-save').click(); };
    setTimeout(() => $('pw-current').focus(), 0);
  }

  async function openShareDialog() {
    const path = currentPath();
    if (!path) { notify('Open a script first'); return; }

    let info = { collaborators: [], online: 0 };
    try { info = await api('/api/collaborators?path=' + encodeURIComponent(path)); }
    catch (e) { notify(e.message, true); return; }

    const root = modal(`
      <div class="modal">
        <div class="modal-head">
          <h3>Share “${esc(path.split('/').pop())}”</h3>
          <button class="icon-btn" id="modal-close">×</button>
        </div>
        <div class="modal-body">
          <ul class="share-list">
            ${info.collaborators.map(c => `<li>
              <span class="share-who">${esc(c.name || c.email)}</span>
              <span class="share-role">${esc(c.role)}</span>
              ${c.role === 'owner' ? '' :
                `<button class="share-remove" data-email="${esc(c.email)}">Remove</button>`}
            </li>`).join('')}
          </ul>
          <label class="cloud-field">Email to invite<input id="share-email" type="email" /></label>
          <label class="cloud-field">Access
            <select id="share-role">
              <option value="editor">Can edit</option>
              <option value="viewer">Can read only</option>
            </select>
          </label>
          <p id="share-error" class="cloud-error hidden"></p>
          <p id="share-link" class="cloud-hint hidden"></p>
          <div class="modal-actions">
            <button id="share-invite" class="ghost">Create invite link</button>
            <button id="share-add" class="primary">Add existing user</button>
          </div>
        </div>
      </div>`);

    const err = $('share-error');
    const fail = (m) => { err.textContent = m; err.classList.remove('hidden'); };
    const email = () => $('share-email').value.trim();
    const role = () => $('share-role').value;

    // For someone who already has an account.
    $('share-add').onclick = async () => {
      if (!email()) return fail('Enter an email address.');
      try {
        await api('/api/share', { method: 'POST', body: { path, email: email(), role: role() } });
        root.classList.add('hidden');
        openShareDialog();
      } catch (e) { fail(e.message); }
    };

    // For someone who doesn't — a link that creates their account and grants
    // access in one step.
    $('share-invite').onclick = async () => {
      try {
        const out = await api('/api/invite', {
          method: 'POST', body: { path, email: email(), role: role() },
        });
        const link = `${location.origin}${location.pathname}?invite=${encodeURIComponent(out.token)}`;
        const el = $('share-link');
        el.classList.remove('hidden');
        el.innerHTML = `Send them this link (valid for 14 days):<br><code>${esc(link)}</code>`;
        try { await navigator.clipboard.writeText(link); notify('Invite link copied'); }
        catch { /* clipboard blocked — the link is on screen to copy by hand */ }
      } catch (e) { fail(e.message); }
    };

    for (const btn of root.querySelectorAll('.share-remove')) {
      btn.onclick = async () => {
        try {
          await api('/api/unshare', { method: 'POST', body: { path, email: btn.dataset.email } });
          root.classList.add('hidden');
          openShareDialog();
        } catch (e) { fail(e.message); }
      };
    }
  }

  // ---------- wrapping app.js ----------

  let wrapped = false;

  // collab.js should always be loaded, but if it ever fails to parse or 404s,
  // every call site below would throw and take openScript with it - losing the
  // whole app rather than just live editing. Degrade to "no collaboration".
  const collabActive = () => {
    try { return !!(window.Collab && window.Collab.active()); } catch { return false; }
  };

  function wrapApp() {
    if (wrapped) return;
    wrapped = true;
    if (!window.Collab) notify('Live editing unavailable (collab.js did not load)', true);

    // Every local mutation in app.js lands here, so this is the single point
    // where the textarea's new contents reach the CRDT.
    const origMarkDirty = window.markDirty;
    window.markDirty = function () {
      origMarkDirty.apply(this, arguments);
      if (collabActive()) window.Collab.syncFromTextarea();
    };

    // The one edit path that does NOT call markDirty: it uppercases a scene
    // heading after Enter. Without this it would never reach the CRDT (and in
    // every mode it also fails to schedule an autosave).
    const origSmart = window.applySmartUppercase;
    window.applySmartUppercase = function () {
      origSmart.apply(this, arguments);
      if (collabActive()) window.Collab.syncFromTextarea();
    };

    // Switch documents: leave the old session, join the new one.
    const origOpen = window.openScript;
    window.openScript = async function (path) {
      if (collabActive()) leaveDocument();
      await origOpen.apply(this, arguments);
      if (signedIn) await joinDocument(path);
    };

    // Undo must be per-user in a shared document. app.js's stack snapshots the
    // WHOLE text, so replaying one would also wipe out whatever a collaborator
    // typed in the meantime; Yjs's UndoManager only reverts this browser's own
    // changes. Fall through to app.js's own undo when not collaborating.
    const origUndo = window.histUndo, origRedo = window.histRedo;
    window.histUndo = function () {
      if (collabActive()) { window.Collab.undo(); repaint(); return; }
      return origUndo.apply(this, arguments);
    };
    window.histRedo = function () {
      if (collabActive()) { window.Collab.redo(); repaint(); return; }
      return origRedo.apply(this, arguments);
    };
  }

  return {
    enabled, sameOrigin, active, probe, login, logout, acceptInvite, authHeaders, api,
    adaptUi, wrapApp, openSignInDialog, openShareDialog, openAccountDialog,
    joinDocument, leaveDocument,
    importBackup,
    get base() { return base; },
    get user() { return user; },
    hasInvite: () => new URLSearchParams(location.search).has('invite'),
  };
})();
