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

// LF is the only line ending the shared text may hold. The editor is a
// <textarea>, whose value the HTML spec normalises: CR and CRLF both become LF.
// A CRDT seeded with CRLF therefore describes a document the browser cannot
// reproduce, and every offset crossing between the two – a typed edit, a
// comment anchor, a suggestion range – comes out wrong by the number of line
// breaks above it, landing edits silently in the wrong place.
//
// A .fountain or .fdx file written on Windows arrives with CRLF, so this is the
// gate that keeps it out. See the matching guard in static/collab.js, which
// heals documents seeded before this existed.
function normalizeNewlines(text) {
  return String(text).replace(/\r\n?/g, '\n');
}

// Replaces the whole shared text in one transaction. Used for operations that
// are genuinely a wholesale replacement – restore from history, .fdx import,
// seeding a new document – never for ordinary edits, which come from the
// browser as incremental CRDT updates.
function replaceText(doc, text) {
  const ytext = doc.getText(Y_TEXT_FIELD);
  const clean = text ? normalizeNewlines(text) : '';
  doc.transact(() => {
    if (ytext.length) ytext.delete(0, ytext.length);
    if (clean) ytext.insert(0, clean);
  });
}

// Builds the initial CRDT state for a brand-new document. `user` is credited
// with the seed text, so an imported script is attributed to whoever imported
// it rather than reading as text nobody wrote.
function initialState(text, user = null) {
  const doc = new Y.Doc();
  replaceText(doc, text || '');
  if (user) {
    doc.getMap('authors').set(String(doc.clientID), {
      id: user.id || '', name: user.name || user.email || 'Someone',
    });
  }
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

// Who contributed to each version, by comparing its Yjs state vector with the
// one before it: any client whose clock advanced produced operations in that
// window. Names come from the document's own author registry.
//
// This is deliberately coarse. It answers "who worked on this version", not
// "who wrote this sentence" — the latter needs Yjs snapshots, which require
// garbage collection to be off and the document to retain every deletion
// forever. `Blame` answers the per-character question on the CURRENT text
// instead, where the CRDT already knows the answer for free.
//
// Versions saved before this column existed have no vector; they report no
// contributors rather than a wrong guess.
async function versionContributors(docId, authors) {
  const { rows } = await query(
    `SELECT name, state_vector, author_id FROM doc_versions
      WHERE doc_id=$1 ORDER BY created_at ASC`, [docId]);

  const decode = (buf) => {
    if (!buf || !buf.length) return null;
    try { return Y.decodeStateVector(new Uint8Array(buf)); } catch { return null; }
  };

  const out = new Map();
  let prev = null;
  for (const row of rows) {
    const now = decode(row.state_vector);
    const names = new Set();
    let unattributed = false;
    if (now) {
      for (const [client, clock] of now) {
        const before = prev ? (prev.get(client) || 0) : 0;
        if (clock <= before) continue;              // this client did nothing
        const who = authors[String(client)];
        if (who && who.name) names.add(who.name);
        else unattributed = true;
      }
      prev = now;
    }
    out.set(row.name, { contributors: [...names].sort(), unattributed });
  }
  return out;
}

async function versionContent(docId, name) {
  const { rows } = await query(
    'SELECT content FROM doc_versions WHERE doc_id=$1 AND name=$2', [docId, name]);
  return rows[0]?.content ?? null;
}

// Mirrors server.py's snapshot_if_changed(): checkpoint the CURRENT content
// before it is replaced, skip if nothing changed, and throttle automatic
// checkpoints so typing doesn't fill the table.
async function snapshotIfChanged(docId, currentContent,
                                 { force = false, authorId = null, stateVector = null } = {}) {
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
    `INSERT INTO doc_versions (doc_id, name, timestamp, content, author_id, created_at, state_vector)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [docId, name, base, currentContent, authorId, Date.now(),
     stateVector ? Buffer.from(stateVector) : null]);

  await query(
    `DELETE FROM doc_versions WHERE doc_id = $1 AND id NOT IN (
       SELECT id FROM doc_versions WHERE doc_id = $1 ORDER BY created_at DESC LIMIT $2
     )`, [docId, SNAPSHOT_MAX_PER_DOC]);
  return true;
}

module.exports = {
  Y_TEXT_FIELD, SNAPSHOT_MAX_PER_DOC, SNAPSHOT_MIN_INTERVAL_MS,
  docFromState, textOf, replaceText, initialState, normalizeNewlines,
  loadState, storeState, storedText,
  stamp, listVersions, versionContent, snapshotIfChanged, versionContributors,
};
