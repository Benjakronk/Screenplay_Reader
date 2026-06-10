// Static-mode backend for Screenplay Reader.
//
// The app normally talks to the Python server (server.py) over /api/*. When the
// page is hosted with NO server behind it — e.g. GitHub Pages — those endpoints
// don't exist. This module installs a window.fetch wrapper that:
//
//   1. tries the real server first, and
//   2. if there is no server (404 / 405 / network error), serves the request
//      from an IndexedDB-backed store that replicates every endpoint's contract.
//
// So the *same* frontend files work both under the Python server (this file
// stays inert) and as a standalone static site. In static mode it also rewires
// PDF export to the browser's print dialog (which preserves pagination,
// including forced `===` page breaks) and adds file Import / Export / Backup
// affordances, since there is no disk to read or write.

(function () {
  'use strict';

  const DB_NAME = 'screenplay-reader';
  const DB_VERSION = 1;
  const STORE_FILES = 'files';      // { path, content, mtime }
  const STORE_HISTORY = 'history';  // { id, path, name, timestamp, content, size }

  // Snapshot throttling mirrors the server: auto-saves snapshot at most this
  // often; a manual save always checkpoints. Keep at most this many per file.
  const AUTO_SNAPSHOT_MS = 5 * 60 * 1000;
  const MAX_SNAPSHOTS = 60;

  const realFetch = window.fetch.bind(window);

  // null = unknown yet, true = a real server answered, false = static (no server)
  let serverPresent = null;

  // ---------- IndexedDB plumbing ----------
  let dbPromise = null;
  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_FILES)) {
          db.createObjectStore(STORE_FILES, { keyPath: 'path' });
        }
        if (!db.objectStoreNames.contains(STORE_HISTORY)) {
          const h = db.createObjectStore(STORE_HISTORY, { keyPath: 'id', autoIncrement: true });
          h.createIndex('path', 'path', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(store, mode, fn) {
    return openDb().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      let result;
      Promise.resolve(fn(s)).then(r => { result = r; }).catch(reject);
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }

  const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  // ---------- file store helpers ----------
  async function getFile(path) {
    return tx(STORE_FILES, 'readonly', s => reqP(s.get(path)));
  }
  async function putFile(rec) {
    return tx(STORE_FILES, 'readwrite', s => reqP(s.put(rec)));
  }
  async function deleteFile(path) {
    return tx(STORE_FILES, 'readwrite', s => reqP(s.delete(path)));
  }
  async function allFiles() {
    return tx(STORE_FILES, 'readonly', s => reqP(s.getAll()));
  }

  async function historyFor(path) {
    return tx(STORE_HISTORY, 'readonly', s => reqP(s.index('path').getAll(path)));
  }
  async function addSnapshot(path, content, timestamp) {
    return tx(STORE_HISTORY, 'readwrite', s =>
      reqP(s.add({ path, name: timestamp, timestamp, content, size: byteLen(content) })));
  }
  async function trimHistory(path) {
    const snaps = await historyFor(path);
    if (snaps.length <= MAX_SNAPSHOTS) return;
    snaps.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const drop = snaps.slice(0, snaps.length - MAX_SNAPSHOTS);
    await tx(STORE_HISTORY, 'readwrite', s => { for (const d of drop) s.delete(d.id); });
  }
  async function renameHistory(from, to) {
    const snaps = await historyFor(from);
    await tx(STORE_HISTORY, 'readwrite', s => {
      for (const snap of snaps) { snap.path = to; s.put(snap); }
    });
  }
  async function deleteHistory(path) {
    const snaps = await historyFor(path);
    await tx(STORE_HISTORY, 'readwrite', s => { for (const snap of snaps) s.delete(snap.id); });
  }

  // ---------- misc helpers ----------
  function byteLen(str) { return new TextEncoder().encode(String(str ?? '')).length; }

  // Timestamp string in the server's snapshot-name format: YYYYMMDDThhmmss,
  // with a "-N" suffix if two snapshots land in the same second.
  let lastStamp = '';
  let stampDup = 0;
  function snapshotStamp() {
    const d = new Date();
    const p = (n, w = 2) => String(n).padStart(w, '0');
    let s = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    if (s === lastStamp) { stampDup++; s = `${s}-${stampDup}`; } else { lastStamp = s; stampDup = 0; }
    return s;
  }

  function json(body, status = 200) {
    return new Response(JSON.stringify(body), {
      status, headers: { 'Content-Type': 'application/json' },
    });
  }

  function parseQuery(url) {
    const q = url.indexOf('?');
    const params = new URLSearchParams(q >= 0 ? url.slice(q) : '');
    const out = {};
    for (const [k, v] of params) out[k] = v;
    return out;
  }

  // ---------- /api/* handlers (static mode) ----------
  // Each returns a Response matching the shape server.py produces.
  async function handle(method, path, query, body) {
    // ----- tree -----
    if (path === '/api/tree' && method === 'GET') {
      const files = await allFiles();
      files.sort((a, b) => a.path.localeCompare(b.path));
      const tree = files.map(f => ({ type: 'file', name: f.path.split('/').pop(), path: f.path }));
      return json({ tree });
    }

    // ----- read a file -----
    if (path === '/api/file' && method === 'GET') {
      const rec = await getFile(query.path);
      if (!rec) return json({ error: 'not found' }, 404);
      return json({ content: rec.content, mtime: rec.mtime });
    }

    // ----- save -----
    if (path === '/api/save' && method === 'POST') {
      const { path: p, content, auto, force, baseMtime } = body;
      const existing = await getFile(p);
      // Conflict: the stored copy changed since the editor loaded it.
      if (existing && !force && baseMtime && existing.mtime > baseMtime) {
        return json({ error: 'conflict', disk: existing.content, mtime: existing.mtime }, 409);
      }
      // Snapshot the prior version before overwriting (throttled for autosaves).
      if (existing && existing.content !== content) {
        const snaps = await historyFor(p);
        const newest = snaps.reduce((m, s) => Math.max(m, s.id || 0), 0);
        const lastSnap = snaps.find(s => s.id === newest);
        const lastMs = lastSnap ? stampToMs(lastSnap.timestamp) : 0;
        const elapsed = Date.now() - lastMs;
        if (!auto || elapsed >= AUTO_SNAPSHOT_MS || snaps.length === 0) {
          await addSnapshot(p, existing.content, snapshotStamp());
          await trimHistory(p);
        }
      }
      const mtime = Date.now();
      await putFile({ path: p, content, mtime });
      return json({ mtime });
    }

    // ----- history list -----
    if (path === '/api/history' && method === 'GET') {
      const snaps = await historyFor(query.path);
      snaps.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      return json({ snapshots: snaps.map(s => ({ name: s.name, timestamp: s.timestamp, size: s.size })) });
    }

    // ----- read one historical version -----
    if (path === '/api/history/file' && method === 'GET') {
      const snaps = await historyFor(query.path);
      const snap = snaps.find(s => s.name === query.name);
      if (!snap) return json({ error: 'not found' }, 404);
      return json({ content: snap.content });
    }

    // ----- restore -----
    if (path === '/api/restore' && method === 'POST') {
      const { path: p, name } = body;
      const snaps = await historyFor(p);
      const snap = snaps.find(s => s.name === name);
      if (!snap) return json({ error: 'not found' }, 404);
      const cur = await getFile(p);
      if (cur) { await addSnapshot(p, cur.content, snapshotStamp()); await trimHistory(p); }
      await putFile({ path: p, content: snap.content, mtime: Date.now() });
      return json({ ok: true });
    }

    // ----- new -----
    if (path === '/api/new' && method === 'POST') {
      const { path: p, content } = body;
      const existing = await getFile(p);
      if (existing) return json({ error: 'exists' }, 409);
      await putFile({ path: p, content: content || '', mtime: Date.now() });
      return json({ ok: true, path: p });
    }

    // ----- rename -----
    if (path === '/api/rename' && method === 'POST') {
      const { from, to } = body;
      const rec = await getFile(from);
      if (!rec) return json({ error: 'not found' }, 404);
      if (await getFile(to)) return json({ error: 'target exists' }, 409);
      await putFile({ path: to, content: rec.content, mtime: Date.now() });
      await deleteFile(from);
      await renameHistory(from, to);
      return json({ ok: true });
    }

    // ----- delete -----
    if (path === '/api/delete' && method === 'POST') {
      await deleteFile(body.path);
      await deleteHistory(body.path);
      return json({ ok: true });
    }

    // Exports (pdf/fdx/sides/cue-sheet) and fdx import are server-only; in
    // static mode the UI is rewired so these are never called. If one slips
    // through, fail gracefully rather than hanging.
    return json({ error: 'This action needs the desktop app.' }, 501);
  }

  function stampToMs(stamp) {
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/.exec(String(stamp || ''));
    if (!m) return 0;
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  }

  // ---------- fetch interceptor ----------
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const isApi = /(^|\/)(api)\//.test(url) || url.startsWith('/api/') ||
                  url.includes('/api/');
    if (!isApi) return realFetch(input, init);

    const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();

    // If we already know a real server is there, just pass through.
    if (serverPresent === true) return realFetch(input, init);

    // If we know there's no server, go straight to the local handler.
    if (serverPresent === false) {
      return localRespond(url, method, init);
    }

    // Unknown: try the real server once. A success means we're under the
    // Python app; a 404/405/network failure means we're static.
    try {
      const res = await realFetch(input, init);
      if (res.ok || (res.status >= 200 && res.status < 500 && res.status !== 404 && res.status !== 405)) {
        serverPresent = true;
        return res;
      }
      serverPresent = false;
    } catch {
      serverPresent = false;
    }
    return localRespond(url, method, init);
  };

  async function localRespond(url, method, init) {
    await ready;   // ensure first-run seeding finished before serving the tree
    let body = {};
    if (init && init.body) {
      try { body = JSON.parse(init.body); } catch { body = {}; }
    }
    const pathOnly = url.split('?')[0].replace(/^https?:\/\/[^/]+/, '');
    const query = parseQuery(url);
    try {
      return await handle(method, pathOnly, query, body);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  }

  // ---------- first-run seeding ----------
  const WELCOME = `Title: Welcome
Author: Screenplay Reader
Format: screenplay
===

# Welcome

Your scripts are saved in this browser. They stay on this device — to move
one to another computer or to back it up, use the Export and Backup buttons.

INT. WRITING ROOM - DAY

A blank page waits. It does not blink. It is patient.

WRITER
(typing)
A character cue is an UPPERCASE line. The line under it is dialogue.

Press Tab on a line in Edit mode to cycle what kind of element it is.

> THE END <
`;

  const STAGE_SAMPLE = `Title: A Small Stage
Author: You
Format: stage
===

# Act One

A bare stage. A single chair.

ELENA
(stepping forward)
We open where every play opens: with someone who wants something.

MARCO
And someone standing in the way.

They regard each other.

FADE OUT.
`;

  async function seedIfEmpty() {
    const files = await allFiles();
    if (files.length > 0) return;
    const now = Date.now();
    await putFile({ path: 'Welcome.fountain', content: WELCOME, mtime: now });
    await putFile({ path: 'A Small Stage.fountain', content: STAGE_SAMPLE, mtime: now + 1 });
  }

  // ---------- static-mode UI adaptation ----------
  // app.js is a classic script, so its top-level `state`, `status`, `loadTree`
  // and `openScript` are globals we can reach by bare name. `state` is a `const`
  // (lexical global — not on window), and `window.status` is a legacy string
  // property, so we go through these guarded accessors rather than `window.*`.
  function say(msg, err) { try { if (typeof status === 'function') status(msg, err); } catch {} }
  function appState() { return (typeof state !== 'undefined') ? state : null; }

  // Browser print PDF. The on-screen #view already holds one .page section per
  // physical page (forced `===` breaks included); the print stylesheet isolates
  // those and emits one sheet each. We make sure the script is rendered first.
  function printScript() {
    const st = appState();
    if (!st || !st.currentPath) { say('Open a script first', true); return; }
    // Read mode renders the full document; split/edit also renders #view, so a
    // direct print works in either. Give the layout a tick to settle.
    say('Opening print dialog…');
    requestAnimationFrame(() => requestAnimationFrame(() => window.print()));
  }

  function downloadText(filename, text) {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  // Export the currently open script as a .fountain file the user can keep or
  // send to someone.
  function exportCurrentFile() {
    const st = appState();
    if (!st || !st.currentPath) { say('Open a script first', true); return; }
    const content = document.getElementById('editor').value;
    downloadText(st.currentPath.split('/').pop(), content);
    say('Downloaded ' + st.currentPath);
  }

  // Import a .fountain/.txt file from disk into the browser store, then open it.
  function importFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.fountain,.spmd,.txt,text/plain';
    input.onchange = async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      let content = '';
      try { content = await file.text(); } catch { say('Could not read file', true); return; }
      let path = file.name;
      if (!/\.(fountain|spmd|txt)$/i.test(path)) path += '.fountain';
      // Avoid clobbering an existing script of the same name.
      let unique = path, n = 2;
      while (await getFile(unique)) { unique = path.replace(/(\.[^.]+)$/, ` (${n})$1`); n++; }
      await putFile({ path: unique, content, mtime: Date.now() });
      if (typeof loadTree === 'function') await loadTree();
      if (typeof openScript === 'function') await openScript(unique);
      say('Imported ' + unique);
    };
    input.click();
  }

  // Back up / restore the whole library as a single JSON file — the safety net
  // for "I cleared my browser data".
  async function backupAll() {
    const files = await allFiles();
    const out = { kind: 'screenplay-reader-backup', version: 1, files: files.map(f => ({ path: f.path, content: f.content })) };
    downloadText('screenplay-reader-backup.json', JSON.stringify(out, null, 2));
    say(`Backed up ${files.length} script(s)`);
  }
  function restoreBackup() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      let data;
      try { data = JSON.parse(await file.text()); } catch { say('Not a valid backup file', true); return; }
      if (!data || !Array.isArray(data.files)) { say('Not a backup file', true); return; }
      let n = 0;
      for (const f of data.files) {
        if (!f || !f.path) continue;
        await putFile({ path: f.path, content: f.content || '', mtime: Date.now() + n });
        n++;
      }
      if (typeof loadTree === 'function') await loadTree();
      say(`Restored ${n} script(s)`);
    };
    input.click();
  }

  function adaptUi() {
    document.body.classList.add('static-mode');

    // Route every "Export PDF" path to browser print. app.js dispatches the
    // command-palette entry and Ctrl+Shift+S through the global CMDS table and
    // reads it at call time, so overriding this one entry covers both; the
    // toolbar button is bound directly, so rebind it too.
    try { if (typeof CMDS === 'object' && CMDS) CMDS['export'] = printScript; } catch {}
    const exportBtn = document.getElementById('btn-export');
    if (exportBtn) {
      exportBtn.onclick = printScript;
      exportBtn.title = 'Print / Save as PDF (Ctrl+P)';
    }

    // FDX export is server-only — hide it.
    const fdxBtn = document.getElementById('btn-export-fdx');
    if (fdxBtn) fdxBtn.style.display = 'none';

    // Repurpose the sidebar Import button for .fountain files, and add
    // Export-file / Backup / Restore beside it.
    const importBtn = document.getElementById('btn-import');
    if (importBtn) {
      importBtn.onclick = importFile;
      importBtn.textContent = '⤵ Import';
      importBtn.title = 'Import a .fountain file from your device';

      const toolbar = importBtn.parentElement;
      const mk = (label, title, fn) => {
        const b = document.createElement('button');
        b.textContent = label; b.title = title; b.onclick = fn;
        return b;
      };
      toolbar.insertBefore(mk('⤴ Export', 'Download the open script as a .fountain file', exportCurrentFile), importBtn.nextSibling);
      toolbar.appendChild(mk('💾 Backup', 'Download a backup of every script', backupAll));
      toolbar.appendChild(mk('↺ Restore', 'Restore scripts from a backup file', restoreBackup));
    }

    // Ctrl+P → print the script (not the whole page). Plain Ctrl+P only —
    // Ctrl+Shift+P is performance mode and must pass through untouched.
    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey &&
          (e.key === 'p' || e.key === 'P')) {
        e.preventDefault();
        printScript();
      }
    });
  }

  // Determine static-vs-server once, up front, so UI adaptation can run. We
  // probe with the real fetch directly (not the wrapped one) to avoid recursion.
  async function detect() {
    if (serverPresent !== null) return serverPresent;
    try {
      const res = await realFetch('/api/tree', { method: 'GET' });
      serverPresent = res.ok;
    } catch {
      serverPresent = false;
    }
    return serverPresent;
  }

  // Expose a small surface for debugging / reuse.
  window.Backend = { printScript, exportCurrentFile, importFile, backupAll, restoreBackup,
                     get static() { return serverPresent === false; } };

  // Boot: seed before the app reads the tree, then adapt the UI if static.
  const ready = (async () => {
    const isStatic = !(await detect());
    if (isStatic) await seedIfEmpty();
    return isStatic;
  })();
  window.Backend.ready = ready;

  // app.js binds its UI on DOMContentLoaded; run our adaptation after, on load.
  window.addEventListener('load', async () => {
    if (await ready) adaptUi();
  });
})();
