'use strict';

// Accounts, passwords, sessions, invites, and per-document access checks.
//
// Passwords use scrypt from Node's built-in crypto – same scheme and same
// "scrypt$<saltHex>$<hashHex>" storage format as the Ukeportalen API, so there
// is one convention across both services and no native dependency to build on
// the VPS.
//
// Unlike Ukeportalen this uses the ASYNC crypto.scrypt rather than scryptSync:
// the same process also serves collaboration WebSockets, and a synchronous KDF
// would block every connected editor for the duration of a login.
//
// Sessions are carried as a BEARER TOKEN in the Authorization header, not a
// cookie. The frontend is published on GitHub Pages while the API lives on its
// own domain, so a session cookie would be a third-party cookie and is blocked
// by default in current browsers.

const crypto = require('crypto');
const { query } = require('./db');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;  // 30 days
const INVITE_TTL_MS  = 14 * 24 * 60 * 60 * 1000;  // 14 days
const SCRYPT_KEYLEN  = 64;

// ---------- passwords ----------

function scrypt(pw, salt, keylen) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(pw), salt, keylen, (err, key) => {
      if (err) reject(err); else resolve(key);
    });
  });
}

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(pw, salt, SCRYPT_KEYLEN);
  return 'scrypt$' + salt.toString('hex') + '$' + hash.toString('hex');
}

async function verifyPassword(pw, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, saltHex, hashHex] = stored.split('$');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(pw, Buffer.from(saltHex, 'hex'), expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// ---------- tokens ----------

// Tokens are random 32-byte hex strings. Only their SHA-256 is stored, so a
// database dump can't be replayed as a live session or a usable invite.
function newToken() {
  return crypto.randomBytes(32).toString('hex');
}
function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// ---------- sessions ----------

async function createSession(userId) {
  const token = newToken();
  const now = Date.now();
  await query(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ($1,$2,$3,$4)',
    [tokenHash(token), userId, now, now + SESSION_TTL_MS]);
  return { token, expiresAt: now + SESSION_TTL_MS };
}

async function destroySession(token) {
  if (!token) return;
  await query('DELETE FROM sessions WHERE token_hash=$1', [tokenHash(token)]);
}

// Resolves a bearer token to a user row, or null. Expired rows are deleted on
// sight so the table self-prunes without a cron job.
async function userForToken(token) {
  if (!token) return null;
  const h = tokenHash(token);
  const { rows } = await query(
    `SELECT u.id, u.email, u.name, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1`, [h]);
  const row = rows[0];
  if (!row) return null;
  if (Number(row.expires_at) < Date.now()) {
    await query('DELETE FROM sessions WHERE token_hash=$1', [h]);
    return null;
  }
  return { id: row.id, email: row.email, name: row.name };
}

function bearerToken(req) {
  const h = req.headers?.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : '';
}

// Express middleware: populates req.user or answers 401.
async function requireUser(req, res, next) {
  try {
    const user = await userForToken(bearerToken(req));
    if (!user) return res.status(401).json({ error: 'not signed in' });
    req.user = user;
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ---------- invites ----------

async function createInvite({ email = '', docId = null, docRole = 'editor', invitedBy }) {
  const token = newToken();
  const now = Date.now();
  await query(
    `INSERT INTO invites (token_hash, email, doc_id, doc_role, invited_by, created_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [tokenHash(token), String(email || '').trim().toLowerCase(), docId,
     docRole === 'viewer' ? 'viewer' : 'editor', invitedBy, now, now + INVITE_TTL_MS]);
  return { token, expiresAt: now + INVITE_TTL_MS };
}

async function inviteForToken(token) {
  if (!token) return null;
  const { rows } = await query('SELECT * FROM invites WHERE token_hash=$1', [tokenHash(token)]);
  const row = rows[0];
  if (!row) return null;
  if (row.used_at) return null;
  if (Number(row.expires_at) < Date.now()) return null;
  return row;
}

// ---------- access ----------

const ROLE_RANK = { viewer: 1, editor: 2, owner: 3 };

// Returns 'owner' | 'editor' | 'viewer' | null for a user against a document.
async function roleFor(userId, docId) {
  const { rows } = await query(
    `SELECT a.role FROM doc_access a
       JOIN documents d ON d.id = a.doc_id
      WHERE a.doc_id = $1 AND a.user_id = $2 AND d.deleted_at IS NULL`,
    [docId, userId]);
  return rows[0]?.role || null;
}

function atLeast(role, needed) {
  return (ROLE_RANK[role] || 0) >= (ROLE_RANK[needed] || 99);
}

module.exports = {
  SESSION_TTL_MS, INVITE_TTL_MS,
  hashPassword, verifyPassword,
  newToken, tokenHash,
  createSession, destroySession, userForToken, bearerToken, requireUser,
  createInvite, inviteForToken,
  roleFor, atLeast,
};
