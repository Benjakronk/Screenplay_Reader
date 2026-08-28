'use strict';

// End-to-end test of the collaboration server.
//
//   node test/collab.js          (or: npm run test:collab)
//
// Starts the REAL Hocuspocus server from collab.js against an in-process
// Postgres (PGlite), then connects real HocuspocusProviders over a real
// WebSocket — the same client the browser uses. This is the piece the smoke
// test deliberately leaves out, and the one the whole feature depends on:
// authentication, per-document access, read-only enforcement, propagation
// between two clients, and persistence across a server restart.

const assert = require('node:assert');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (err) { failed++; console.log(`  FAIL ${name}\n       ${err.message}`); }
}
const section = (n) => console.log(`\n${n}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Waits for a condition, so tests don't depend on fixed sleeps.
async function until(fn, what, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let ok = false;
    try { ok = await fn(); } catch { ok = false; }
    if (ok) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

async function main() {
  let PGlite;
  try { ({ PGlite } = require('@electric-sql/pglite')); }
  catch { console.log('SKIP: @electric-sql/pglite is not installed.'); process.exit(0); }

  let HocuspocusProvider, Y;
  try {
    ({ HocuspocusProvider } = require('@hocuspocus/provider'));
    Y = require('yjs');
  } catch {
    console.log('SKIP: @hocuspocus/provider is not installed (npm install --save-dev @hocuspocus/provider).');
    process.exit(0);
  }

  const PORT = 3999;
  process.env.COLLAB_PORT = String(PORT);
  process.env.HOST = '127.0.0.1';

  const db = require('../db');
  db._setDriver(new PGlite());
  await db.init();

  const auth = require('../auth');
  const docs = require('../docs');
  const collab = require('../collab');

  // --- fixtures: an owner, a viewer, an outsider, and one document ---
  const now = Date.now();
  const mk = async (email, name) => {
    const { rows } = await db.query(
      `INSERT INTO users (email, name, password_hash, created_at)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [email, name, await auth.hashPassword('a-long-enough-password'), now]);
    return rows[0].id;
  };
  const ownerId = await mk('owner@example.no', 'Owner');
  const viewerId = await mk('viewer@example.no', 'Viewer');
  const outsiderId = await mk('outsider@example.no', 'Outsider');

  const { rows: [doc] } = await db.query(
    `INSERT INTO documents (owner_id, path, created_at, updated_at)
     VALUES ($1,'Script.fountain',$2,$2) RETURNING id`, [ownerId, now]);
  const docId = doc.id;
  await db.query(
    `INSERT INTO doc_access (doc_id, user_id, role, created_at) VALUES
     ($1,$2,'owner',$4), ($1,$3,'viewer',$4)`, [docId, ownerId, viewerId, now]);
  await db.query(`INSERT INTO doc_state (doc_id, ydoc, updated_at) VALUES ($1,$2,$3)`,
    [docId, docs.initialState(''), now]);

  const ownerTok = (await auth.createSession(ownerId)).token;
  const viewerTok = (await auth.createSession(viewerId)).token;
  const outsiderTok = (await auth.createSession(outsiderId)).token;

  await collab.listen();
  // The provider treats this as the socket ENDPOINT and sends the document name
  // in the protocol, not the path. Behind nginx the browser therefore connects
  // to exactly /collab with no document id and no trailing slash - which is why
  // the nginx location must be `/collab`, not `/collab/`.
  const URL = `ws://127.0.0.1:${PORT}`;

  // Connects a provider and resolves how it went, rather than hanging on a
  // rejection.
  function connect(token, name = docId, onClose = null) {
    const ydoc = new Y.Doc();
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      const provider = new HocuspocusProvider({
        url: URL, name: String(name), document: ydoc, token,
        WebSocketPolyfill: globalThis.WebSocket,
        onClose: () => { if (onClose) onClose(); },
        onSynced: () => done({ ok: true, provider, ydoc, text: ydoc.getText('content') }),
        onAuthenticationFailed: ({ reason }) => { provider.destroy(); done({ ok: false, reason }); },
      });
      setTimeout(() => done({ ok: false, reason: 'timeout' }), 6000);
    });
  }

  // ------------------------------------------------------------ authentication
  section('authentication');
  await test('a valid session connects', async () => {
    const c = await connect(ownerTok);
    assert.ok(c.ok, 'owner was refused: ' + c.reason);
    c.provider.destroy();
  });
  await test('no token is refused', async () => {
    const c = await connect('');
    assert.equal(c.ok, false);
  });
  await test('a forged token is refused', async () => {
    const c = await connect('deadbeefdeadbeef');
    assert.equal(c.ok, false);
  });
  await test('a valid session for a document you cannot see is refused', async () => {
    const c = await connect(outsiderTok);
    assert.equal(c.ok, false);
  });
  await test('an unknown document name is refused', async () => {
    const c = await connect(ownerTok, 'not-a-uuid');
    assert.equal(c.ok, false);
  });

  // ------------------------------------------------------------- propagation
  section('propagation');
  let a, b;
  await test('two clients both connect to the same document', async () => {
    a = await connect(ownerTok);
    b = await connect(ownerTok);
    assert.ok(a.ok && b.ok);
  });
  await test('an edit in one client reaches the other', async () => {
    a.ydoc.transact(() => a.text.insert(0, 'INT. SALOON - NATT\n'), 'local-editor');
    await until(() => b.text.toString() === 'INT. SALOON - NATT\n', 'the edit to arrive');
  });
  await test('concurrent edits from both clients converge', async () => {
    a.ydoc.transact(() => a.text.insert(0, '# AKT I\n\n'), 'local-editor');
    b.ydoc.transact(() => b.text.insert(b.text.length, 'SARA\nHallo.\n'), 'local-editor');
    await until(() => a.text.toString() === b.text.toString(), 'convergence');
    const out = a.text.toString();
    assert.ok(out.includes('AKT I'), 'lost the first edit');
    assert.ok(out.includes('Hallo.'), 'lost the second edit');
  });

  // -------------------------------------------------------------- permissions
  section('permissions');
  await test('a viewer may connect and read', async () => {
    const v = await connect(viewerTok);
    assert.ok(v.ok, 'viewer was refused: ' + v.reason);
    await until(() => v.text.toString().includes('AKT I'), 'the viewer to receive the text');
    v.provider.destroy();
  });
  await test("a viewer's writes are rejected by the server", async () => {
    const v = await connect(viewerTok);
    assert.ok(v.ok);
    const before = a.text.toString();
    v.ydoc.transact(() => v.text.insert(0, 'VANDALISM\n'), 'local-editor');
    await sleep(600);   // give a write that must NOT propagate time to fail to
    assert.equal(a.text.toString(), before, 'a read-only client changed the document');
    v.provider.destroy();
  });

  // -------------------------------------------------------------- persistence
  section('persistence');
  await test('the document is written to doc_state', async () => {
    const expected = a.text.toString();
    a.provider.destroy();
    b.provider.destroy();
    await until(async () => {
      const { rows } = await db.query('SELECT ydoc FROM doc_state WHERE doc_id=$1', [docId]);
      if (!rows[0]) return false;
      return docs.textOf(docs.docFromState(Buffer.from(rows[0].ydoc))) === expected;
    }, 'the CRDT to be persisted', 8000);
  });
  await test('a fresh client loads it back after the server restarts', async () => {
    const { rows } = await db.query('SELECT ydoc FROM doc_state WHERE doc_id=$1', [docId]);
    const expected = docs.textOf(docs.docFromState(Buffer.from(rows[0].ydoc)));

    await collab.shutdown();
    collab.createCollabServer();
    await collab.listen();

    const c = await connect(ownerTok);
    assert.ok(c.ok, 'could not reconnect: ' + c.reason);
    await until(() => c.text.toString() === expected, 'the reloaded document');
    assert.ok(expected.includes('AKT I') && expected.includes('Hallo.'));
    c.provider.destroy();
  });

  // ------------------------------------------------- role changes (LAST)
  //
  // These force-close every connection to the document, so they run after the
  // tests that depend on live sockets rather than before them.
  section('role changes reach live connections');

  await test('closeConnections drops an open socket', async () => {
    let dropped = false;
    const c = await connect(ownerTok, docId, () => { dropped = true; });
    assert.ok(c.ok, 'could not connect: ' + c.reason);
    collab.closeConnections(docId);
    await until(() => dropped, 'the socket to be closed', 5000);
    c.provider.destroy();
  });

  await test('a promoted viewer can write once reconnected', async () => {
    // The viewer's socket authenticated as read-only. Promoting them in the
    // database does not reach it - which is exactly why the API closes
    // connections on a role change, rather than leaving writes to be dropped.
    await db.query('UPDATE doc_access SET role=$1 WHERE doc_id=$2 AND user_id=$3',
      ['editor', docId, viewerId]);
    collab.closeConnections(docId);

    const v = await connect(viewerTok);
    assert.ok(v.ok, 'promoted user was refused: ' + v.reason);

    const marker = 'WRITTEN-AFTER-PROMOTION';
    v.ydoc.transact(() => v.text.insert(v.text.length, marker), 'local-editor');

    const w = await connect(ownerTok);
    await until(() => w.text.toString().includes(marker), 'the promoted write to propagate');

    v.provider.destroy();
    w.provider.destroy();
  });

  await collab.shutdown();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
