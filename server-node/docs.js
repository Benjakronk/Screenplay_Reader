'use strict';

// Document storage: the CRDT <-> plain-text bridge, plus version history.
//
// In cloud mode the Y.Doc IS the document. Plain text is always derived from
// it (for exports, history snapshots and /api/file), never stored beside it,
// so the two can't drift.
//
// Everything a Yjs document holds lives under the shared text named
// Y_TEXT_FIELD. The browser binds the same name in static/collab.js – if you
// change it, change it in both places or documents will silently appear empty.

const Y = require('yjs');
const { query } = require('./db');

const Y_TEXT_FIELD = 'content';

// server.py's snapshot policy, mirrored: auto-saves only checkpoint if the
// newest snapshot is older than this, manual saves always do, and we keep the
// most recent N per document.
const SNAPSHOT_MIN_INTERVAL_MS = 5 * 60 * 1000;
const SNAPSHOT_MAX_PER_DOC = 80;

// ---------- Y.Doc <-> text ----------

function docFromState(bytes) {
  const doc = new Y.Doc();
  if (bytes && bytes.length) Y.applyUpdate(doc, new Uint8Array(bytes));
  return doc;
}

function textOf(doc) {
  return doc.getText(Y_TEXT_FIELD).toString();
}

// Replaces the whole shared text in one transaction. Used for operations that
// are genuinely a wholesale replacement – restore from history, .fdx import,
// seeding a new document – never for ordinary edits, which come from the
// browser as incremental CRDT updates.
function replaceText(doc, text) {
  const ytext = doc.getText(Y_TEXT_FIELD);
  doc.transact(() => {
    if (ytext.length) ytext.delete(0, ytext.length);
    if (text) ytext.insert(0, String(text));
  });
}

// Builds the initial CRDT state for a brand-new document.
function initialState(text) {
  const doc = new Y.Doc();
  replaceText(doc, text || '');
  return Buffer.from(Y.encodeStateAsUpdate(doc));
}

// ---------- persistence ----------

async function loadState(docId) {
  const { rows } = await query('SELECT ydoc FROM doc_state WHERE doc_id=$1', [docId]);
  return rows[0]?.ydoc || null;
}

async function storeState(docId, bytes) {
  await query(
    `INSERT INTO doc_state (doc_id, ydoc, updated_at) VALUES ($1,$2,$3)
     ON CONFLICT (doc_id) DO UPDATE SET ydoc = EXCLUDED.ydoc, updated_at = EXCLUDED.updated_at`,
    [docId, Buffer.from(bytes), Date.now()]);
  await query('UPDATE documents SET updated_at=$1 WHERE id=$2', [Date.now(), docId]);
}

// Reads a document's text straight from the stored CRDT state. Callers that
// need the authoritative, possibly-still-in-memory version should go through
// collab.js's readText() instead, which prefers a live Hocuspocus document.
async function storedText(docId) {
  const bytes = await loadState(docId);
  if (!bytes) return '';
  return textOf(docFromState(bytes));
}

// ---------- version history ----------

// server.py names snapshots YYYYMMDDTHHMMSS in local time; keep the format
// identical so the history UI renders them the same way.
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T` +
         `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function listVersions(docId) {
  const { rows } = await query(
    `SELECT name, timestamp, octet_length(content) AS size
       FROM doc_versions WHERE doc_id=$1 ORDER BY created_at DESC`, [docId]);
  return rows.map(r => ({ name: r.name, timestamp: r.timestamp, size: Number(r.size) }));
}

async function versionContent(docId, name) {
  const { rows } = await query(
    'SELECT content FROM doc_versions WHERE doc_id=$1 AND name=$2', [docId, name]);
  return rows[0]?.content ?? null;
}

// Mirrors server.py's snapshot_if_changed(): checkpoint the CURRENT content
// before it is replaced, skip if nothing changed, and throttle automatic
// checkpoints so typing doesn't fill the table.
async function snapshotIfChanged(docId, currentContent, { force = false, authorId = null } = {}) {
  if (currentContent == null) return false;

  const { rows } = await query(
    'SELECT content, created_at FROM doc_versions WHERE doc_id=$1 ORDER BY created_at DESC LIMIT 1',
    [docId]);
  const newest = rows[0];
  if (newest && newest.content === currentContent) return false;
  if (!force && newest && Date.now() - Number(newest.created_at) < SNAPSHOT_MIN_INTERVAL_MS) {
    return false;
  }

  // Disambiguate a second collision the same way server.py does, by appending
  // -1, -2, ... to the base timestamp.
  const base = stamp();
  let name = `${base}.fountain`;
  for (let n = 1; ; n++) {
    const { rowCount } = await query(
      'SELECT 1 FROM doc_versions WHERE doc_id=$1 AND name=$2', [docId, name]);
    if (!rowCount) break;
    name = `${base}-${n}.fountain`;
  }

  await query(
    `INSERT INTO doc_versions (doc_id, name, timestamp, content, author_id, created_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [docId, name, base, currentContent, authorId, Date.now()]);

  await query(
    `DELETE FROM doc_versions WHERE doc_id = $1 AND id NOT IN (
       SELECT id FROM doc_versions WHERE doc_id = $1 ORDER BY created_at DESC LIMIT $2
     )`, [docId, SNAPSHOT_MAX_PER_DOC]);
  return true;
}

module.exports = {
  Y_TEXT_FIELD, SNAPSHOT_MAX_PER_DOC, SNAPSHOT_MIN_INTERVAL_MS,
  docFromState, textOf, replaceText, initialState,
  loadState, storeState, storedText,
  stamp, listVersions, versionContent, snapshotIfChanged,
};
