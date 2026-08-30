'use strict';

// Opens a PostgreSQL connection pool and, on startup, creates the schema if it
// is missing. Shared by server.js, collab.js and create-user.js.
//
// Connection config comes from the environment (PGHOST/PGPORT/PGDATABASE/
// PGUSER/PGPASSWORD). A local .env file is loaded via Node's built-in loader
// (no dotenv dependency); on the VPS the same vars can come from pm2 instead.
//
// There is no migration framework: init() runs on EVERY boot and uses
// IF NOT EXISTS throughout, so it is safe to re-run. Editing an existing
// CREATE TABLE does nothing to a live table – add a separate idempotent
// ALTER TABLE ... IF NOT EXISTS line instead.

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const ENV_PATH = path.join(__dirname, '.env');
if (typeof process.loadEnvFile === 'function' && fs.existsSync(ENV_PATH)) {
  process.loadEnvFile(ENV_PATH);
}

const pool = new Pool({
  host:     process.env.PGHOST || '127.0.0.1',
  port:     Number(process.env.PGPORT) || 5432,
  database: process.env.PGDATABASE || 'faaglarna',
  user:     process.env.PGUSER || 'faaglarna_app',
  password: process.env.PGPASSWORD || '',
  max: 10,
});

// Thin helper so callers don't touch the pool directly.
//
// Everything goes through `driver`, which is the pg Pool in production. Tests
// swap in an in-process Postgres (PGlite) with _setDriver so the whole API can
// be exercised without a database server running — see test/smoke.js.
let driver = pool;

function query(text, params) {
  return driver.query(text, params);
}

function _setDriver(d) {
  driver = d;
}

async function init() {
  // ---- accounts -------------------------------------------------------
  // Email is stored already-lowercased by the caller so a plain UNIQUE is
  // enough; citext would need CREATE EXTENSION, which the app user may not be
  // allowed to run.
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email         TEXT NOT NULL UNIQUE,
      name          TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      created_at    BIGINT NOT NULL,
      last_seen     BIGINT NOT NULL DEFAULT 0
    );
  `);

  // Invite-only signup: there is no public registration endpoint. A row here
  // is a one-shot ticket to create an account, optionally pre-granting access
  // to one document (doc_id) so "share this script with Alex" is a single link.
  // Only the SHA-256 of the token is stored, so a database leak does not hand
  // out usable invites.
  await query(`
    CREATE TABLE IF NOT EXISTS invites (
      token_hash TEXT PRIMARY KEY,
      email      TEXT NOT NULL DEFAULT '',
      doc_id     UUID,
      doc_role   TEXT NOT NULL DEFAULT 'editor',
      invited_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at BIGINT NOT NULL,
      expires_at BIGINT NOT NULL,
      used_at    BIGINT,
      used_by    UUID REFERENCES users(id) ON DELETE SET NULL
    );
  `);

  // Sessions live in the DB so they survive a restart and can be revoked.
  // Same hashed-at-rest treatment as invites.
  await query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at BIGINT NOT NULL,
      expires_at BIGINT NOT NULL
    );
  `);
  await query('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);');

  // ---- documents ------------------------------------------------------
  // `path` deliberately preserves the path-based addressing the frontend
  // already speaks (/api/file?path=..., rename, delete), so app.js needs no
  // changes. Paths are unique per owner, not globally.
  //
  // Delete is a soft delete (mirrors server.py, where history outlives the
  // file). The partial unique index lets a new document reuse the path of a
  // deleted one.
  await query(`
    CREATE TABLE IF NOT EXISTS documents (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      path       TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      deleted_at BIGINT
    );
  `);
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_owner_path
      ON documents(owner_id, path) WHERE deleted_at IS NULL;
  `);

  // Who may open a document, and how. The owner also gets a row here (role
  // 'owner') so access checks are a single lookup with no special-casing.
  await query(`
    CREATE TABLE IF NOT EXISTS doc_access (
      doc_id     UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role       TEXT NOT NULL DEFAULT 'editor',
      created_at BIGINT NOT NULL,
      PRIMARY KEY (doc_id, user_id)
    );
  `);
  await query('CREATE INDEX IF NOT EXISTS idx_doc_access_user ON doc_access(user_id);');

  // The CRDT itself – the source of truth for document content in cloud mode.
  // Written by the Hocuspocus Database extension in collab.js; plain text is
  // always derived from this, never stored alongside it, so there is no cache
  // to go stale.
  await query(`
    CREATE TABLE IF NOT EXISTS doc_state (
      doc_id     UUID PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
      ydoc       BYTEA NOT NULL,
      updated_at BIGINT NOT NULL
    );
  `);

  // Version history. `name` and `timestamp` carry server.py's snapshot naming
  // (YYYYMMDDTHHMMSS[-N].fountain) so /api/history returns byte-identical
  // shapes to the local server and the existing history UI just works.
  await query(`
    CREATE TABLE IF NOT EXISTS doc_versions (
      id         BIGSERIAL PRIMARY KEY,
      doc_id     UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      timestamp  TEXT NOT NULL,
      content    TEXT NOT NULL,
      author_id  UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at BIGINT NOT NULL
    );
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS idx_doc_versions_doc
      ON doc_versions(doc_id, created_at DESC);
  `);
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_doc_versions_name
      ON doc_versions(doc_id, name);
  `);

  // WHO CHANGED WHAT BETWEEN TWO VERSIONS.
  //
  // author_id records only who pressed Ctrl+S. The Yjs state vector recorded
  // here says, per client, how many operations that client had produced at the
  // moment of the snapshot — so comparing one version's vector with the
  // previous one's names exactly the clients that contributed in between.
  //
  // WHY NOT Yjs SNAPSHOTS, which would give per-character attribution inside a
  // diff: snapshots only work with garbage collection disabled, which means the
  // document retains every character anyone ever deletes, forever. A state
  // vector is a few bytes per client and costs the document nothing.
  //
  // Added after the table existed, so it is a separate idempotent ALTER —
  // editing the CREATE TABLE above would do nothing to a live table.
  await query(`ALTER TABLE doc_versions ADD COLUMN IF NOT EXISTS state_vector BYTEA;`);

  // WHO MAY BRING A NEW PERSON INTO THE SYSTEM.
  //
  // Sharing a document with an EXISTING account is an ordinary thing an owner
  // does. Creating an invite is different in kind: it mints a credential that
  // turns into an account, on an install with no public registration. That is
  // an administrator's decision, not a document owner's, so it is a property of
  // the person rather than of any document.
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;`);
}

module.exports = { pool, query, init, _setDriver };
