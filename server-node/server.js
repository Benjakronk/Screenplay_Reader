'use strict';

// =============================================================
// FAAGLARNA – cloud API
//
// Serves the same /api/* surface as the local Python server
// (server.py) so the browser frontend needs no changes to its
// data layer: static/backend.js just rewrites the URL to this
// host and adds an Authorization header.
//
// Differences from server.py, all deliberate:
//   - documents belong to user accounts, not a scripts/ folder
//   - the Y.Doc in doc_state is the source of truth for content;
//     plain text is derived from it (see docs.js / collab.js)
//   - /api/save no longer writes content. Autosave is a no-op
//     (the CRDT persists continuously); a manual save records a
//     version. Content arrives over the collaboration socket.
//   - PDF/FDX rendering is delegated to the stateless Python
//     sidecar (../export-service/), which owns the ReportLab and
//     Fountain code so there is no second implementation.
//
// Env: PORT (default 3001), HOST (default 127.0.0.1 – behind
// nginx), COLLAB_PORT (default 3003), EXPORT_SERVICE_URL,
// ALLOWED_ORIGINS, plus the PG* vars read by db.js.
// =============================================================

const express = require('express');
const { query, init } = require('./db');
const auth = require('./auth');
const docs = require('./docs');
const collab = require('./collab');

const PORT = Number(process.env.PORT) || 3001;
const HOST = process.env.HOST || '127.0.0.1';
const EXPORT_SERVICE_URL = (process.env.EXPORT_SERVICE_URL || '').replace(/\/$/, '');

// Same extension whitelist as server.py.
const ALLOWED_EXT = ['.fountain', '.spmd', '.txt'];

// Documents shared with you appear under this top-level folder in the tree.
const SHARED_DIR = 'Shared';

// ---------- CORS ----------
// The frontend is published on GitHub Pages while this API lives on its own
// domain, so every request is cross-origin. Auth rides in an Authorization
// header rather than a cookie, so no credentialed-CORS dance is needed.
const EXTRA_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean));

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (EXTRA_ORIGINS.has(origin)) return true;
  if (/^https:\/\/[a-z0-9-]+\.github\.io$/i.test(origin)) return true;
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '8mb' }));

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------- helpers ----------

// Mirrors server.py's safe_script_path: reject absolute paths, traversal, and
// unsupported extensions. Returns a normalised relative path.
function cleanPath(raw) {
  let p = String(raw || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!p) throw new Error('path required');
  if (p.length > 400) throw new Error('path too long');
  const parts = p.split('/').filter(Boolean);
  if (parts.some(s => s === '.' || s === '..')) throw new Error('invalid path');
  if (parts.some(s => /[\x00-\x1f]/.test(s))) throw new Error('invalid path');
  p = parts.join('/');
  const dot = p.lastIndexOf('.');
  const ext = dot < 0 ? '' : p.slice(dot).toLowerCase();
  if (!ALLOWED_EXT.includes(ext)) throw new Error('unsupported extension');
  if (parts[0] === SHARED_DIR) throw new Error(`"${SHARED_DIR}/" is reserved`);
  return p;
}

// Resolves a path as the signed-in user sees it — either one of their own
// documents, or "Shared/<owner>/<path>" for one shared with them.
async function resolveDoc(userId, rawPath) {
  const p = String(rawPath || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!p) return null;

  const parts = p.split('/').filter(Boolean);
  if (parts[0] === SHARED_DIR) {
    // Shared/<ownerLabel>/<their path> — the owner label is cosmetic, so match
    // on the remaining path across every document shared with this user.
    const rest = parts.slice(2).join('/');
    const { rows } = await query(
      `SELECT d.id, d.path, d.owner_id, a.role
         FROM documents d
         JOIN doc_access a ON a.doc_id = d.id AND a.user_id = $1
        WHERE d.deleted_at IS NULL AND d.owner_id <> $1 AND d.path = $2`,
      [userId, rest]);
    const row = rows[0];
    return row ? { id: row.id, path: p, ownPath: row.path, role: row.role, ownerId: row.owner_id } : null;
  }

  const { rows } = await query(
    `SELECT d.id, d.path, d.owner_id, a.role
       FROM documents d
       JOIN doc_access a ON a.doc_id = d.id AND a.user_id = $1
      WHERE d.deleted_at IS NULL AND d.owner_id = $1 AND d.path = $2`,
    [userId, p]);
  const row = rows[0];
  return row ? { id: row.id, path: p, ownPath: row.path, role: row.role, ownerId: row.owner_id } : null;
}

// Builds server.py's nested tree shape from flat paths: directories first, then
// files, each group case-insensitively by name.
function buildTree(entries) {
  const root = { dirs: new Map(), files: [] };
  for (const e of entries) {
    const parts = e.path.split('/').filter(Boolean);
    const fileName = parts.pop();
    let node = root;
    let sofar = [];
    for (const seg of parts) {
      sofar.push(seg);
      if (!node.dirs.has(seg)) {
        node.dirs.set(seg, { name: seg, path: sofar.join('/'), dirs: new Map(), files: [] });
      }
      node = node.dirs.get(seg);
    }
    node.files.push({ type: 'file', name: fileName, path: e.path, id: e.id, role: e.role });
  }
  const emit = (node) => {
    const dirs = [...node.dirs.values()]
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
      .map(d => ({ type: 'dir', name: d.name, path: d.path, children: emit(d) }));
    const files = node.files
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    return [...dirs, ...files];
  };
  return emit(root);
}

// server.py reports mtimes as float seconds; keep the same unit so the
// frontend's conflict bookkeeping behaves identically.
const toMtime = (ms) => Number(ms) / 1000;

function fail(res, err, status = 400) {
  res.status(status).json({ error: err && err.message ? err.message : String(err) });
}

// ---------- probes ----------

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Readiness probe for external monitoring (UptimeRobot). Unlike /api/health it
// touches the database, so it confirms the whole chain. Returns 503 when the DB
// is unreachable so a plain HTTP monitor trips too.
app.get('/api/ready', async (req, res) => {
  try {
    await query('SELECT 1');
    res.json({ ready: true });
  } catch (err) {
    res.status(503).json({ ready: false, error: err.message });
  }
});

// ---------- accounts ----------

app.post('/api/login', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const { rows } = await query(
      'SELECT id, email, name, password_hash FROM users WHERE email=$1', [email]);
    const user = rows[0];
    const ok = user && await auth.verifyPassword(password, user.password_hash);
    if (!ok) {
      // Same message and shape either way – don't leak which half was wrong.
      return res.status(401).json({ error: 'wrong email or password' });
    }
    const { token, expiresAt } = await auth.createSession(user.id);
    await query('UPDATE users SET last_seen=$1 WHERE id=$2', [Date.now(), user.id]);
    res.json({ token, expiresAt, user: { id: user.id, email: user.email, name: user.name } });
  } catch (err) { fail(res, err, 500); }
});

app.post('/api/logout', async (req, res) => {
  try {
    await auth.destroySession(auth.bearerToken(req));
    res.json({ ok: true });
  } catch (err) { fail(res, err, 500); }
});

app.get('/api/me', auth.requireUser, (req, res) => {
  res.json({ user: req.user });
});

// Change your own password. Requires the current one even though the session is
// already authenticated: a borrowed session should not be enough to lock the
// real owner out of their account.
app.post('/api/password', auth.requireUser, async (req, res) => {
  try {
    const current = String(req.body?.currentPassword || '');
    const next = String(req.body?.newPassword || '');
    if (next.length < 10) {
      return res.status(400).json({ error: 'new password must be at least 10 characters' });
    }
    if (next === current) {
      return res.status(400).json({ error: 'that is already your password' });
    }

    const { rows } = await query('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
    if (!rows[0] || !(await auth.verifyPassword(current, rows[0].password_hash))) {
      return res.status(401).json({ error: 'current password is wrong' });
    }

    await query('UPDATE users SET password_hash=$1 WHERE id=$2',
      [await auth.hashPassword(next), req.user.id]);

    // Changing a password is also how you evict someone. End every OTHER
    // session, keeping the one making the request so the user is not signed out
    // of the tab they are standing in.
    const keep = auth.tokenHash(auth.bearerToken(req));
    const { rowCount } = await query(
      'DELETE FROM sessions WHERE user_id=$1 AND token_hash <> $2', [req.user.id, keep]);

    res.json({ ok: true, otherSessionsEnded: rowCount });
  } catch (err) { fail(res, err, 500); }
});

// Create an invite. Optionally scoped to one document, which pre-grants access
// so "share this script with Alex" is a single link.
app.post('/api/invite', auth.requireUser, async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const role = req.body?.role === 'viewer' ? 'viewer' : 'editor';
    let docId = null;
    if (req.body?.path) {
      const doc = await resolveDoc(req.user.id, req.body.path);
      if (!doc) return res.status(404).json({ error: 'not found' });
      if (!auth.atLeast(doc.role, 'owner')) {
        return res.status(403).json({ error: 'only the owner can share' });
      }
      docId = doc.id;
    }
    const { token, expiresAt } = await auth.createInvite({
      email, docId, docRole: role, invitedBy: req.user.id,
    });
    res.json({ ok: true, token, expiresAt });
  } catch (err) { fail(res, err, 500); }
});

// What an invite is for, so the accept page can show it before asking for a
// password. Never reveals anything beyond the invited address.
app.get('/api/invite', async (req, res) => {
  try {
    const inv = await auth.inviteForToken(req.query.token);
    if (!inv) return res.status(404).json({ error: 'invalid or expired invite' });
    res.json({ ok: true, email: inv.email, sharesDocument: !!inv.doc_id });
  } catch (err) { fail(res, err, 500); }
});

app.post('/api/accept-invite', async (req, res) => {
  try {
    const inv = await auth.inviteForToken(req.body?.token);
    if (!inv) return res.status(404).json({ error: 'invalid or expired invite' });

    const email = String(req.body?.email || inv.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const name = String(req.body?.name || '').trim();
    if (!email.includes('@')) return res.status(400).json({ error: 'a valid email is required' });
    if (password.length < 10) {
      return res.status(400).json({ error: 'password must be at least 10 characters' });
    }
    // If the invite named an address, that is the address it creates.
    if (inv.email && inv.email !== email) {
      return res.status(400).json({ error: 'this invite is for a different email address' });
    }

    const { rows: existing } = await query('SELECT id FROM users WHERE email=$1', [email]);
    let userId = existing[0]?.id;
    if (!userId) {
      const hash = await auth.hashPassword(password);
      const { rows } = await query(
        `INSERT INTO users (email, name, password_hash, created_at)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [email, name, hash, Date.now()]);
      userId = rows[0].id;
    }

    if (inv.doc_id) {
      await query(
        `INSERT INTO doc_access (doc_id, user_id, role, created_at) VALUES ($1,$2,$3,$4)
         ON CONFLICT (doc_id, user_id) DO NOTHING`,
        [inv.doc_id, userId, inv.doc_role, Date.now()]);
    }
    await query('UPDATE invites SET used_at=$1, used_by=$2 WHERE token_hash=$3',
      [Date.now(), userId, auth.tokenHash(req.body.token)]);

    const { token, expiresAt } = await auth.createSession(userId);
    res.json({ ok: true, token, expiresAt, user: { id: userId, email, name } });
  } catch (err) { fail(res, err, 500); }
});

// Grant an existing account access to one of your documents.
app.post('/api/share', auth.requireUser, async (req, res) => {
  try {
    const doc = await resolveDoc(req.user.id, req.body?.path);
    if (!doc) return res.status(404).json({ error: 'not found' });
    if (!auth.atLeast(doc.role, 'owner')) {
      return res.status(403).json({ error: 'only the owner can share' });
    }
    const email = String(req.body?.email || '').trim().toLowerCase();
    const role = req.body?.role === 'viewer' ? 'viewer' : 'editor';
    const { rows } = await query('SELECT id FROM users WHERE email=$1', [email]);
    if (!rows[0]) {
      return res.status(404).json({ error: 'no account with that email – send an invite instead' });
    }
    if (rows[0].id === req.user.id) return res.status(400).json({ error: 'that is you' });
    await query(
      `INSERT INTO doc_access (doc_id, user_id, role, created_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (doc_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [doc.id, rows[0].id, role, Date.now()]);
    res.json({ ok: true });
  } catch (err) { fail(res, err, 500); }
});

// Who can see a document, for the share dialog.
app.get('/api/collaborators', auth.requireUser, async (req, res) => {
  try {
    const doc = await resolveDoc(req.user.id, req.query.path);
    if (!doc) return res.status(404).json({ error: 'not found' });
    const { rows } = await query(
      `SELECT u.email, u.name, a.role FROM doc_access a
         JOIN users u ON u.id = a.user_id
        WHERE a.doc_id = $1 ORDER BY a.created_at`, [doc.id]);
    res.json({ collaborators: rows, online: collab.connectionCount(doc.id) });
  } catch (err) { fail(res, err, 500); }
});

app.post('/api/unshare', auth.requireUser, async (req, res) => {
  try {
    const doc = await resolveDoc(req.user.id, req.body?.path);
    if (!doc) return res.status(404).json({ error: 'not found' });
    if (!auth.atLeast(doc.role, 'owner')) {
      return res.status(403).json({ error: 'only the owner can change sharing' });
    }
    const email = String(req.body?.email || '').trim().toLowerCase();
    await query(
      `DELETE FROM doc_access WHERE doc_id=$1
         AND user_id = (SELECT id FROM users WHERE email=$2)
         AND user_id <> $3`,
      [doc.id, email, doc.ownerId]);
    res.json({ ok: true });
  } catch (err) { fail(res, err, 500); }
});

// ---------- documents ----------

app.get('/api/tree', auth.requireUser, async (req, res) => {
  try {
    const { rows: own } = await query(
      `SELECT d.id, d.path, a.role FROM documents d
         JOIN doc_access a ON a.doc_id = d.id AND a.user_id = $1
        WHERE d.deleted_at IS NULL AND d.owner_id = $1`, [req.user.id]);

    const { rows: shared } = await query(
      `SELECT d.id, d.path, a.role, u.name AS owner_name, u.email AS owner_email
         FROM documents d
         JOIN doc_access a ON a.doc_id = d.id AND a.user_id = $1
         JOIN users u ON u.id = d.owner_id
        WHERE d.deleted_at IS NULL AND d.owner_id <> $1`, [req.user.id]);

    const entries = own.map(r => ({ path: r.path, id: r.id, role: r.role }));
    for (const r of shared) {
      const owner = (r.owner_name || r.owner_email || 'someone').replace(/\//g, '-');
      entries.push({ path: `${SHARED_DIR}/${owner}/${r.path}`, id: r.id, role: r.role });
    }
    res.json({ tree: buildTree(entries) });
  } catch (err) { fail(res, err, 500); }
});

// The `id` and `role` fields are additive – app.js ignores them, static/collab.js
// uses `id` to open the collaboration socket and `role` to decide read-only.
app.get('/api/file', auth.requireUser, async (req, res) => {
  try {
    const doc = await resolveDoc(req.user.id, req.query.path);
    if (!doc) return res.status(404).json({ error: 'not found' });
    const content = await collab.readText(doc.id);
    const { rows } = await query('SELECT updated_at FROM documents WHERE id=$1', [doc.id]);
    res.json({
      content,
      mtime: toMtime(rows[0]?.updated_at || Date.now()),
      id: doc.id,
      role: doc.role,
    });
  } catch (err) { fail(res, err, 500); }
});

// Content is NOT written here – the collaboration socket owns it. Autosave is
// acknowledged and dropped; a manual save records a version, which is what the
// existing history UI then lists. There is no 409 conflict path in cloud mode:
// the CRDT merges concurrent edits instead of racing over a whole file.
app.post('/api/save', auth.requireUser, async (req, res) => {
  try {
    const doc = await resolveDoc(req.user.id, req.body?.path);
    if (!doc) return res.status(404).json({ error: 'not found' });
    if (!auth.atLeast(doc.role, 'editor')) {
      return res.status(403).json({ error: 'read-only access' });
    }

    if (!req.body?.auto) {
      const content = await collab.readText(doc.id);
      await docs.snapshotIfChanged(doc.id, content, { force: true, authorId: req.user.id });
    }
    const now = Date.now();
    await query('UPDATE documents SET updated_at=$1 WHERE id=$2', [now, doc.id]);
    res.json({ ok: true, path: req.body.path, mtime: toMtime(now) });
  } catch (err) { fail(res, err, 500); }
});

app.post('/api/new', auth.requireUser, async (req, res) => {
  try {
    const p = cleanPath(req.body?.path);
    const existing = await resolveDoc(req.user.id, p);
    if (existing) return res.status(400).json({ error: 'already exists' });

    const now = Date.now();
    const { rows } = await query(
      `INSERT INTO documents (owner_id, path, created_at, updated_at)
       VALUES ($1,$2,$3,$3) RETURNING id`, [req.user.id, p, now]);
    const docId = rows[0].id;
    await query(
      `INSERT INTO doc_access (doc_id, user_id, role, created_at) VALUES ($1,$2,'owner',$3)`,
      [docId, req.user.id, now]);
    await query(
      `INSERT INTO doc_state (doc_id, ydoc, updated_at) VALUES ($1,$2,$3)`,
      [docId, docs.initialState(req.body?.content || ''), now]);

    res.json({ ok: true, path: p, id: docId });
  } catch (err) { fail(res, err); }
});

app.post('/api/rename', auth.requireUser, async (req, res) => {
  try {
    const doc = await resolveDoc(req.user.id, req.body?.from);
    if (!doc) return res.status(404).json({ error: 'source does not exist' });
    if (!auth.atLeast(doc.role, 'owner')) {
      return res.status(403).json({ error: 'only the owner can rename' });
    }
    const to = cleanPath(req.body?.to);
    if (await resolveDoc(req.user.id, to)) {
      return res.status(400).json({ error: 'destination already exists' });
    }
    await query('UPDATE documents SET path=$1, updated_at=$2 WHERE id=$3',
      [to, Date.now(), doc.id]);
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

// Soft delete, mirroring server.py, which checkpoints the content before
// unlinking so history outlives the file.
app.post('/api/delete', auth.requireUser, async (req, res) => {
  try {
    const doc = await resolveDoc(req.user.id, req.body?.path);
    if (!doc) return res.status(404).json({ error: 'not found' });
    if (!auth.atLeast(doc.role, 'owner')) {
      return res.status(403).json({ error: 'only the owner can delete' });
    }
    const content = await collab.readText(doc.id);
    await docs.snapshotIfChanged(doc.id, content, { force: true, authorId: req.user.id });
    await query('UPDATE documents SET deleted_at=$1 WHERE id=$2', [Date.now(), doc.id]);
    res.json({ ok: true });
  } catch (err) { fail(res, err, 500); }
});

// ---------- history ----------

app.get('/api/history', auth.requireUser, async (req, res) => {
  try {
    const doc = await resolveDoc(req.user.id, req.query.path);
    if (!doc) return res.status(404).json({ error: 'not found' });
    res.json({ snapshots: await docs.listVersions(doc.id) });
  } catch (err) { fail(res, err, 500); }
});

app.get('/api/history/file', auth.requireUser, async (req, res) => {
  try {
    const doc = await resolveDoc(req.user.id, req.query.path);
    if (!doc) return res.status(404).json({ error: 'not found' });
    const content = await docs.versionContent(doc.id, String(req.query.name || ''));
    if (content == null) return res.status(404).json({ error: 'not found' });
    res.json({ content });
  } catch (err) { fail(res, err, 500); }
});

app.post('/api/restore', auth.requireUser, async (req, res) => {
  try {
    const doc = await resolveDoc(req.user.id, req.body?.path);
    if (!doc) return res.status(404).json({ error: 'not found' });
    if (!auth.atLeast(doc.role, 'editor')) {
      return res.status(403).json({ error: 'read-only access' });
    }
    const content = await docs.versionContent(doc.id, String(req.body?.name || ''));
    if (content == null) return res.status(404).json({ error: 'not found' });

    // Checkpoint what is there now, then replace it. Everyone connected sees
    // the restore arrive as an ordinary CRDT update.
    const current = await collab.readText(doc.id);
    await docs.snapshotIfChanged(doc.id, current, { force: true, authorId: req.user.id });
    await collab.writeText(doc.id, content);
    res.json({ ok: true });
  } catch (err) { fail(res, err, 500); }
});

// ---------- exports (delegated to the Python sidecar) ----------

async function callExporter(route, payload) {
  if (!EXPORT_SERVICE_URL) {
    const err = new Error('server-side export is not configured');
    err.status = 503;
    throw err;
  }
  const r = await fetch(`${EXPORT_SERVICE_URL}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    let detail = '';
    try { detail = (await r.json()).error || ''; } catch { /* non-JSON body */ }
    const err = new Error(detail || `export failed (${r.status})`);
    err.status = 502;
    throw err;
  }
  return Buffer.from(await r.arrayBuffer());
}

const baseName = (p) => (p.split('/').pop() || 'script').replace(/\.[^.]*$/, '');

function sendFile(res, bytes, type, filename) {
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(bytes);
}

async function exportRoute(req, res, route, extra, type, suffix) {
  try {
    const doc = await resolveDoc(req.user.id, req.query.path);
    if (!doc) return res.status(404).json({ error: 'not found' });
    const text = await collab.readText(doc.id);
    const bytes = await callExporter(route, { text, ...extra });
    sendFile(res, bytes, type, baseName(doc.ownPath) + suffix);
  } catch (err) { fail(res, err, err.status || 500); }
}

app.get('/api/export/pdf', auth.requireUser, (req, res) =>
  exportRoute(req, res, '/pdf', {}, 'application/pdf', '.pdf'));

app.get('/api/export/cue-sheet', auth.requireUser, (req, res) =>
  exportRoute(req, res, '/cue-sheet', {}, 'application/pdf', '-cue-sheet.pdf'));

app.get('/api/export/fdx', auth.requireUser, (req, res) =>
  exportRoute(req, res, '/fdx', {}, 'application/xml', '.fdx'));

app.get('/api/export/sides', auth.requireUser, async (req, res) => {
  const character = String(req.query.character || '');
  if (!character) return res.status(400).json({ error: 'character required' });
  return exportRoute(req, res, '/sides', { character },
    'application/pdf', `-sides-${character}.pdf`);
});

app.post('/api/import/fdx', auth.requireUser, async (req, res) => {
  try {
    const xml = String(req.body?.content || '');
    if (!xml.trim()) return res.status(400).json({ error: 'empty .fdx content' });

    let text;
    try {
      text = (await callExporter('/from-fdx', { xml })).toString('utf8');
    } catch (err) {
      return res.status(400).json({ error: `could not parse .fdx: ${err.message}` });
    }

    // Find a free <stem>.fountain, appending -1, -2, … like server.py does.
    const raw = String(req.body?.name || 'imported').split(/[\\/]/).pop();
    const stem = raw.replace(/\.[^.]*$/, '') || 'imported';
    let p = `${stem}.fountain`;
    for (let n = 1; await resolveDoc(req.user.id, p); n++) p = `${stem}-${n}.fountain`;

    const now = Date.now();
    const { rows } = await query(
      `INSERT INTO documents (owner_id, path, created_at, updated_at)
       VALUES ($1,$2,$3,$3) RETURNING id`, [req.user.id, cleanPath(p), now]);
    const docId = rows[0].id;
    await query(
      `INSERT INTO doc_access (doc_id, user_id, role, created_at) VALUES ($1,$2,'owner',$3)`,
      [docId, req.user.id, now]);
    await query(
      `INSERT INTO doc_state (doc_id, ydoc, updated_at) VALUES ($1,$2,$3)`,
      [docId, docs.initialState(text), now]);

    res.json({ ok: true, path: p, id: docId });
  } catch (err) { fail(res, err, 500); }
});

// ---------- boot ----------

app.use((req, res) => res.status(404).json({ error: 'unknown endpoint' }));

async function main() {
  await init();
  await collab.listen();
  console.log(`faaglarna-collab listening on ws://${HOST}:${collab.COLLAB_PORT}`);

  const httpServer = app.listen(PORT, HOST, () => {
    console.log(`faaglarna-api listening on http://${HOST}:${PORT}`);
  });

  // pm2 restarts send SIGINT/SIGTERM. Flush debounced CRDT writes before
  // exiting or the last few seconds of everyone's edits are lost.
  const stop = async (sig) => {
    console.log(`${sig} received – flushing documents and shutting down`);
    httpServer.close();
    await collab.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

if (require.main === module) {
  main().catch((err) => {
    console.error('failed to start:', err);
    process.exit(1);
  });
}

module.exports = { app, cleanPath, buildTree, isAllowedOrigin };
