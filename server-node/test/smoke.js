'use strict';

// End-to-end test of the Faaglarna cloud API.
//
//   npm test          (from server-node/)
//
// Runs the REAL Express app against a REAL PostgreSQL — an in-process one
// (PGlite, a WASM build of Postgres 18) swapped in through db.js's _setDriver.
// So the schema, every query, the access checks and the CRDT storage are all
// exercised exactly as they will be on the VPS, with no database server to set
// up first.
//
// The collaboration WebSocket is NOT started here: server.js only listens when
// run as the main module, and collab.js falls back to reading and writing
// doc_state directly when no Hocuspocus instance exists. The Y.Text <-> textarea
// binding has its own tests in ../../collab/test-binding.mjs.
//
// PGlite is a devDependency-by-convention: install it with
//   npm install --no-save @electric-sql/pglite
// if it is missing.

const assert = require('node:assert');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (err) { failed++; console.log(`  FAIL ${name}\n       ${err.message}`); }
}
function section(name) { console.log(`\n${name}`); }

async function main() {
  let PGlite;
  try {
    ({ PGlite } = require('@electric-sql/pglite'));
  } catch {
    console.log('SKIP: @electric-sql/pglite is not installed.');
    console.log('      npm install --no-save @electric-sql/pglite');
    process.exit(0);
  }

  const db = require('../db');
  db._setDriver(new PGlite());
  await db.init();

  const { app } = require('../server');
  const auth = require('../auth');
  const docs = require('../docs');
  const collab = require('../collab');

  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const BASE = `http://127.0.0.1:${server.address().port}`;

  // Small client. `as` carries a session token.
  async function call(method, path, { body, as } = {}) {
    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (as) headers['Authorization'] = 'Bearer ' + as;
    const res = await fetch(BASE + path, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    });
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : await res.buffer?.() ?? null;
    return { status: res.status, data };
  }
  const GET  = (p, o) => call('GET', p, o);
  const POST = (p, b, o) => call('POST', p, { body: b, ...o });

  // ---------------------------------------------------------------- probes
  section('probes');
  await test('/api/health', async () => {
    const r = await GET('/api/health');
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
  });
  await test('/api/ready reports the database is reachable', async () => {
    const r = await GET('/api/ready');
    assert.equal(r.status, 200);
    assert.equal(r.data.ready, true);
  });

  // ---------------------------------------------------------------- accounts
  section('accounts');
  const now = Date.now();
  const benHash = await auth.hashPassword('a-long-enough-password');
  // Ben is the administrator — the first account, as created by create-user.js
  // with --admin. Only an administrator may invite someone who has no account.
  const { rows: [ben] } = await db.query(
    `INSERT INTO users (email, name, password_hash, created_at, is_admin)
     VALUES ('ben@example.no','Ben',$1,$2,TRUE) RETURNING id`, [benHash, now]);

  let benToken = '';
  await test('login with the right password issues a token', async () => {
    const r = await POST('/api/login', { email: 'ben@example.no', password: 'a-long-enough-password' });
    assert.equal(r.status, 200);
    assert.ok(r.data.token);
    benToken = r.data.token;
  });
  await test('login with the wrong password is refused', async () => {
    const r = await POST('/api/login', { email: 'ben@example.no', password: 'wrong' });
    assert.equal(r.status, 401);
  });
  await test('login for an unknown address gives the same answer', async () => {
    const r = await POST('/api/login', { email: 'nobody@example.no', password: 'wrong' });
    assert.equal(r.status, 401);
    assert.equal(r.data.error, 'wrong email or password');
  });
  await test('the session token is not stored in the clear', async () => {
    const { rows } = await db.query('SELECT token_hash FROM sessions');
    assert.ok(rows.length >= 1);
    assert.ok(!rows.some(r => r.token_hash === benToken), 'raw token found in sessions');
    assert.equal(rows[0].token_hash, auth.tokenHash(benToken));
  });
  await test('/api/me identifies the signed-in user', async () => {
    const r = await GET('/api/me', { as: benToken });
    assert.equal(r.data.user.email, 'ben@example.no');
  });
  await test('an endpoint without a token is 401', async () => {
    assert.equal((await GET('/api/tree')).status, 401);
  });
  await test('a forged token is 401', async () => {
    assert.equal((await GET('/api/tree', { as: 'deadbeef' })).status, 401);
  });

  // --------------------------------------------------------- password change
  section('changing your own password');
  const NEWPW = 'a-different-long-password';
  let secondToken = '';
  await test('a second session exists before the change', async () => {
    const r = await POST('/api/login', { email: 'ben@example.no', password: 'a-long-enough-password' });
    assert.equal(r.status, 200);
    secondToken = r.data.token;
    assert.notEqual(secondToken, benToken);
  });
  await test('the wrong current password is refused', async () => {
    const r = await POST('/api/password',
      { currentPassword: 'not-it', newPassword: NEWPW }, { as: benToken });
    assert.equal(r.status, 401);
  });
  await test('a too-short new password is refused', async () => {
    const r = await POST('/api/password',
      { currentPassword: 'a-long-enough-password', newPassword: 'short' }, { as: benToken });
    assert.equal(r.status, 400);
  });
  await test('reusing the current password is refused', async () => {
    const r = await POST('/api/password',
      { currentPassword: 'a-long-enough-password', newPassword: 'a-long-enough-password' },
      { as: benToken });
    assert.equal(r.status, 400);
  });
  await test('an unauthenticated change is refused', async () => {
    const r = await POST('/api/password', { currentPassword: 'x', newPassword: NEWPW });
    assert.equal(r.status, 401);
  });
  await test('the change succeeds and reports evicted sessions', async () => {
    const r = await POST('/api/password',
      { currentPassword: 'a-long-enough-password', newPassword: NEWPW }, { as: benToken });
    assert.equal(r.status, 200, r.data && r.data.error);
    assert.ok(r.data.otherSessionsEnded >= 1, 'other sessions were not ended');
  });
  await test('the new password works at login', async () => {
    const r = await POST('/api/login', { email: 'ben@example.no', password: NEWPW });
    assert.equal(r.status, 200);
  });
  await test('the old password no longer works', async () => {
    const r = await POST('/api/login', { email: 'ben@example.no', password: 'a-long-enough-password' });
    assert.equal(r.status, 401);
  });
  await test('the session that made the change is still valid', async () => {
    const r = await GET('/api/me', { as: benToken });
    assert.equal(r.status, 200);
  });
  await test('the OTHER session was signed out', async () => {
    const r = await GET('/api/me', { as: secondToken });
    assert.equal(r.status, 401);
  });
  await test('the stored hash actually changed and is still scrypt', async () => {
    const { rows } = await db.query('SELECT password_hash FROM users WHERE email=$1', ['ben@example.no']);
    assert.ok(rows[0].password_hash.startsWith('scrypt$'));
    assert.ok(await auth.verifyPassword(NEWPW, rows[0].password_hash));
    assert.ok(!(await auth.verifyPassword('a-long-enough-password', rows[0].password_hash)));
  });

  // --------------------------------------------------------------- documents
  section('documents');
  await test('a new script appears in the tree', async () => {
    const r = await POST('/api/new', { path: 'Fjellet.fountain' }, { as: benToken });
    assert.equal(r.status, 200);
    const t = await GET('/api/tree', { as: benToken });
    assert.equal(t.data.tree.length, 1);
    assert.equal(t.data.tree[0].name, 'Fjellet.fountain');
    assert.equal(t.data.tree[0].type, 'file');
  });
  await test('creating the same path twice is refused', async () => {
    const r = await POST('/api/new', { path: 'Fjellet.fountain' }, { as: benToken });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /already exists/);
  });
  await test('an unsupported extension is refused', async () => {
    const r = await POST('/api/new', { path: 'notes.exe' }, { as: benToken });
    assert.equal(r.status, 400);
  });
  await test('path traversal is refused', async () => {
    const r = await POST('/api/new', { path: '../../escape.fountain' }, { as: benToken });
    assert.equal(r.status, 400);
  });

  let docId = '';
  await test('/api/file returns content plus the collaboration document id', async () => {
    const r = await GET('/api/file?path=Fjellet.fountain', { as: benToken });
    assert.equal(r.status, 200);
    assert.equal(r.data.content, '');
    assert.equal(r.data.role, 'owner');
    assert.ok(r.data.id, 'no document id returned');
    assert.ok(typeof r.data.mtime === 'number');
    docId = r.data.id;
  });

  const SCRIPT = 'INT. SALOON - NATT\n\nRolige skritt.\n';
  await test('text written through the CRDT reads back', async () => {
    await collab.writeText(docId, SCRIPT);
    assert.equal(await collab.readText(docId), SCRIPT);
    const r = await GET('/api/file?path=Fjellet.fountain', { as: benToken });
    assert.equal(r.data.content, SCRIPT);
  });
  await test('doc_state holds a real Y.Doc, not plain text', async () => {
    const { rows } = await db.query('SELECT ydoc FROM doc_state WHERE doc_id=$1', [docId]);
    const bytes = Buffer.from(rows[0].ydoc);
    assert.ok(bytes.length > 0);
    assert.equal(docs.textOf(docs.docFromState(bytes)), SCRIPT);
  });

  // ---------------------------------------------------------------- history
  section('history');
  await test('autosave does not create a version', async () => {
    await POST('/api/save', { path: 'Fjellet.fountain', auto: true }, { as: benToken });
    const r = await GET('/api/history?path=Fjellet.fountain', { as: benToken });
    assert.equal(r.data.snapshots.length, 0);
  });
  await test('a manual save records one', async () => {
    const r0 = await POST('/api/save', { path: 'Fjellet.fountain' }, { as: benToken });
    assert.equal(r0.status, 200);
    const r = await GET('/api/history?path=Fjellet.fountain', { as: benToken });
    assert.equal(r.data.snapshots.length, 1);
    const s = r.data.snapshots[0];
    // The shape the existing history UI expects, and server.py's naming.
    assert.match(s.name, /^\d{8}T\d{6}(-\d+)?\.fountain$/);
    assert.match(s.timestamp, /^\d{8}T\d{6}$/);
    assert.equal(s.size, Buffer.byteLength(SCRIPT));
  });
  await test('saving again with no change adds nothing', async () => {
    await POST('/api/save', { path: 'Fjellet.fountain' }, { as: benToken });
    const r = await GET('/api/history?path=Fjellet.fountain', { as: benToken });
    assert.equal(r.data.snapshots.length, 1);
  });
  await test('restore brings an old version back', async () => {
    const hist = await GET('/api/history?path=Fjellet.fountain', { as: benToken });
    const name = hist.data.snapshots[0].name;
    await collab.writeText(docId, 'COMPLETELY DIFFERENT\n');
    const r = await POST('/api/restore', { path: 'Fjellet.fountain', name }, { as: benToken });
    assert.equal(r.status, 200);
    assert.equal(await collab.readText(docId), SCRIPT);
  });
  await test('restore checkpoints what it replaced', async () => {
    const r = await GET('/api/history?path=Fjellet.fountain', { as: benToken });
    assert.equal(r.data.snapshots.length, 2);
    const restored = await GET(
      '/api/history/file?path=Fjellet.fountain&name=' + encodeURIComponent(r.data.snapshots[0].name),
      { as: benToken });
    assert.equal(restored.data.content, 'COMPLETELY DIFFERENT\n');
  });

  // ---------------------------------------------------------------- sharing
  section('sharing and access control');
  let alexToken = '', inviteToken = '';
  await test('the owner can create an invite for a script', async () => {
    const r = await POST('/api/invite',
      { path: 'Fjellet.fountain', email: 'alex@example.no', role: 'editor' }, { as: benToken });
    assert.equal(r.status, 200);
    assert.ok(r.data.token);
    inviteToken = r.data.token;
  });
  await test('the invite is not stored in the clear either', async () => {
    const { rows } = await db.query('SELECT token_hash FROM invites');
    assert.ok(!rows.some(r => r.token_hash === inviteToken));
  });
  await test('accepting it creates the account and grants access', async () => {
    const r = await POST('/api/accept-invite', {
      token: inviteToken, email: 'alex@example.no',
      password: 'another-long-password', name: 'Alex',
    });
    assert.equal(r.status, 200);
    alexToken = r.data.token;
  });
  await test('an invite cannot be redeemed twice', async () => {
    const r = await POST('/api/accept-invite', {
      token: inviteToken, email: 'alex@example.no', password: 'another-long-password',
    });
    assert.equal(r.status, 404);
  });
  await test('a short password is refused', async () => {
    const inv = await POST('/api/invite', { email: 'x@example.no' }, { as: benToken });
    const r = await POST('/api/accept-invite',
      { token: inv.data.token, email: 'x@example.no', password: 'short' });
    assert.equal(r.status, 400);
  });
  await test("the shared script shows under Shared/ in Alex's tree", async () => {
    const r = await GET('/api/tree', { as: alexToken });
    const shared = r.data.tree.find(e => e.name === 'Shared');
    assert.ok(shared, 'no Shared folder');
    assert.equal(shared.type, 'dir');
    assert.equal(shared.children[0].children[0].name, 'Fjellet.fountain');
  });
  await test('Alex can read it through the Shared path', async () => {
    const r = await GET('/api/file?path=' + encodeURIComponent('Shared/Alex/Fjellet.fountain'),
      { as: alexToken });
    assert.equal(r.status, 200);
    assert.equal(r.data.content, SCRIPT);
    assert.equal(r.data.id, docId, 'resolved to a different document');
  });
  await test('Alex cannot reach it by guessing the owner path', async () => {
    const r = await GET('/api/file?path=Fjellet.fountain', { as: alexToken });
    assert.equal(r.status, 404);
  });
  await test('an editor cannot rename or delete', async () => {
    const p = encodeURIComponent('Shared/Alex/Fjellet.fountain');
    const rn = await POST('/api/rename',
      { from: 'Shared/Alex/Fjellet.fountain', to: 'Stolen.fountain' }, { as: alexToken });
    assert.equal(rn.status, 403);
    const del = await POST('/api/delete', { path: 'Shared/Alex/Fjellet.fountain' }, { as: alexToken });
    assert.equal(del.status, 403);
  });
  await test('a viewer cannot save', async () => {
    await POST('/api/share',
      { path: 'Fjellet.fountain', email: 'alex@example.no', role: 'viewer' }, { as: benToken });
    const r = await POST('/api/save', { path: 'Shared/Alex/Fjellet.fountain' }, { as: alexToken });
    assert.equal(r.status, 403);
  });
  await test('unshare revokes access', async () => {
    await POST('/api/unshare', { path: 'Fjellet.fountain', email: 'alex@example.no' }, { as: benToken });
    const r = await GET('/api/file?path=' + encodeURIComponent('Shared/Alex/Fjellet.fountain'),
      { as: alexToken });
    assert.equal(r.status, 404);
  });
  await test('the owner cannot be unshared from their own script', async () => {
    await POST('/api/unshare', { path: 'Fjellet.fountain', email: 'ben@example.no' }, { as: benToken });
    const r = await GET('/api/file?path=Fjellet.fountain', { as: benToken });
    assert.equal(r.status, 200);
  });

  // ------------------------------------------------------- rename and delete
  section('rename and delete');
  await test('rename moves the script and keeps its content', async () => {
    const r = await POST('/api/rename',
      { from: 'Fjellet.fountain', to: 'Act One/Fjellet.fountain' }, { as: benToken });
    assert.equal(r.status, 200);
    const f = await GET('/api/file?path=' + encodeURIComponent('Act One/Fjellet.fountain'),
      { as: benToken });
    assert.equal(f.data.content, SCRIPT);
    assert.equal(f.data.id, docId, 'rename changed the collaboration document id');
  });
  await test('the tree nests the new folder', async () => {
    const r = await GET('/api/tree', { as: benToken });
    const dir = r.data.tree.find(e => e.name === 'Act One');
    assert.ok(dir && dir.type === 'dir');
    assert.equal(dir.children[0].name, 'Fjellet.fountain');
  });
  await test('delete hides it but keeps the history', async () => {
    const r = await POST('/api/delete', { path: 'Act One/Fjellet.fountain' }, { as: benToken });
    assert.equal(r.status, 200);
    const t = await GET('/api/tree', { as: benToken });
    assert.equal(t.data.tree.length, 0);
    const { rows } = await db.query('SELECT count(*)::int AS n FROM doc_versions WHERE doc_id=$1', [docId]);
    assert.ok(rows[0].n >= 2, 'history was destroyed by the delete');
  });
  await test('the freed path can be reused', async () => {
    const r = await POST('/api/new', { path: 'Act One/Fjellet.fountain' }, { as: benToken });
    assert.equal(r.status, 200, r.data.error);
    assert.notEqual(r.data.id, docId, 'reused the deleted document');
  });

  // ---------------------------------------------------------------- exports
  section('exports');
  if (!process.env.EXPORT_SERVICE_URL) {
    await test('exports report unavailable when no sidecar is configured', async () => {
      const r = await GET('/api/export/pdf?path=' + encodeURIComponent('Act One/Fjellet.fountain'),
        { as: benToken });
      assert.equal(r.status, 503);
    });
    console.log('       (set EXPORT_SERVICE_URL to also test real PDF/FDX rendering)');
  } else {
    // The Python sidecar is up: check the whole chain, CRDT text included.
    const p = encodeURIComponent('Act One/Fjellet.fountain');
    await collab.writeText(
      (await GET('/api/file?path=' + p, { as: benToken })).data.id,
      ['Title: Test', '===', '', 'INT. SALOON - NATT', '', 'SARA', 'Hallo.', ''].join('\n'));

    const raw = async (route) => {
      const res = await fetch(BASE + route, { headers: { Authorization: 'Bearer ' + benToken } });
      return { status: res.status, buf: Buffer.from(await res.arrayBuffer()),
               disp: res.headers.get('content-disposition') || '' };
    };
    await test('PDF export renders through the sidecar', async () => {
      const r = await raw('/api/export/pdf?path=' + p);
      assert.equal(r.status, 200);
      assert.ok(r.buf.subarray(0, 5).toString() === '%PDF-', 'not a PDF');
      assert.match(r.disp, /filename="Fjellet\.pdf"/);
    });
    await test('FDX export renders through the sidecar', async () => {
      const r = await raw('/api/export/fdx?path=' + p);
      assert.equal(r.status, 200);
      assert.ok(r.buf.toString('utf8', 0, 5).startsWith('<?xml'), 'not XML');
      assert.match(r.disp, /filename="Fjellet\.fdx"/);
    });
    await test('actor sides render through the sidecar', async () => {
      const r = await raw('/api/export/sides?path=' + p + '&character=SARA');
      assert.equal(r.status, 200);
      assert.equal(r.buf.subarray(0, 5).toString(), '%PDF-');
    });
    await test('sides without a character is refused', async () => {
      const r = await raw('/api/export/sides?path=' + p);
      assert.equal(r.status, 400);
    });
    await test('.fdx import creates a new script', async () => {
      const fdxBytes = (await raw('/api/export/fdx?path=' + p)).buf.toString('utf8');
      const r = await POST('/api/import/fdx', { name: 'Imported.fdx', content: fdxBytes },
        { as: benToken });
      assert.equal(r.status, 200, r.data && r.data.error);
      const f = await GET('/api/file?path=' + encodeURIComponent(r.data.path), { as: benToken });
      assert.match(f.data.content, /INT\. SALOON - NATT/);
      assert.match(f.data.content, /SARA/);
    });
  }

  section('who may bring in a new person');
  {
    // Alex has an account but is not an administrator. Adding someone who
    // already exists is an ordinary owner's job; minting a credential that
    // becomes a NEW account is not.
    await test('an ordinary user cannot create an invite', async () => {
      const r = await POST('/api/invite', { email: 'stranger@example.no' }, { as: alexToken });
      assert.equal(r.status, 403);
      assert.match(r.data.error, /administrator/i);
    });
    await test('an administrator can', async () => {
      const r = await POST('/api/invite', { email: 'stranger@example.no' }, { as: benToken });
      assert.equal(r.status, 200, r.data && r.data.error);
      assert.ok(r.data.token);
    });
    await test('/api/me says which you are', async () => {
      assert.equal((await GET('/api/me', { as: benToken })).data.user.isAdmin, true);
      assert.equal((await GET('/api/me', { as: alexToken })).data.user.isAdmin, false);
    });
    await test('an ordinary user is told to ask, not to invite', async () => {
      // Alex owns this one, so the share is allowed to get as far as looking
      // the address up. The advice must differ by who is asking: telling an
      // ordinary user to "send an invite instead" points at a door they cannot
      // open.
      await POST('/api/new', { path: 'Alex.fountain' }, { as: alexToken });
      const r = await POST('/api/share',
        { path: 'Alex.fountain', email: 'nobody@example.no', role: 'editor' },
        { as: alexToken });
      assert.equal(r.status, 404);
      assert.match(r.data.error, /ask an administrator/);
    });
    await test('an administrator is told they can invite', async () => {
      // Its own document: by this point the earlier sections have renamed and
      // deleted the ones they made.
      await POST('/api/new', { path: 'AdminShare.fountain' }, { as: benToken });
      const r = await POST('/api/share',
        { path: 'AdminShare.fountain', email: 'nobody@example.no', role: 'editor' },
        { as: benToken });
      assert.equal(r.status, 404);
      assert.match(r.data.error, /send an invite/);
    });
    await test('everyone can list existing accounts to share with', async () => {
      const r = await GET('/api/users', { as: alexToken });
      assert.equal(r.status, 200);
      assert.ok(r.data.users.some((u) => u.email === 'ben@example.no'));
      assert.ok(!r.data.users.some((u) => u.email === 'alex@example.no'), 'not yourself');
    });
  }

  section('input rules');
  {
    const long = 'x'.repeat(45) + '@example.no';        // 56 characters
    await test('an over-long email is refused', async () => {
      const r = await POST('/api/invite', { email: long }, { as: benToken });
      assert.equal(r.status, 400);
      assert.match(r.data.error, /50 characters/);
    });
    await test('a malformed email is refused', async () => {
      for (const bad of ['not-an-address', '@nobody', 'nobody@', 'two words@x.no']) {
        const r = await POST('/api/invite', { email: bad }, { as: benToken });
        assert.equal(r.status, 400, `should have refused ${bad}`);
      }
    });
    await test('an address with no dot in the domain is ACCEPTED', async () => {
      // A real account in this database is joachim@eklund. Requiring a dot
      // reads as obviously correct and locks that person out of logging in: a
      // login validator runs against accounts that already exist, so rejecting
      // one is not a warning, it is a lockout.
      const r = await POST('/api/invite', { email: 'someone@intranet' }, { as: benToken });
      assert.equal(r.status, 200, r.data && r.data.error);
    });
    await test('login rejects a malformed address as a wrong password', async () => {
      // Same message and status as a real failure: this must not become a way
      // to probe which addresses are valid or exist.
      const r = await POST('/api/login', { email: 'not-an-address', password: 'x' });
      assert.equal(r.status, 401);
      assert.match(r.data.error, /wrong email or password/);
    });
    await test('an enormous password is refused without hashing it', async () => {
      const r = await POST('/api/login',
        { email: 'ben@example.no', password: 'x'.repeat(100000) });
      assert.equal(r.status, 401);
    });
    await test('an over-long display name is refused', async () => {
      const inv = await POST('/api/invite', { email: 'named@example.no' }, { as: benToken });
      const r = await POST('/api/accept-invite', {
        token: inv.data.token, email: 'named@example.no',
        password: 'a-long-enough-password', name: 'n'.repeat(51),
      });
      assert.equal(r.status, 400);
      assert.match(r.data.error, /50 characters/);
    });
    await test('a name is stripped of control characters and stored trimmed', async () => {
      const inv = await POST('/api/invite', { email: 'tidy@example.no' }, { as: benToken });
      const r = await POST('/api/accept-invite', {
        token: inv.data.token, email: '  TIDY@Example.NO ',
        password: 'a-long-enough-password',
        name: '  Ann‮  Berg\t',
      });
      assert.equal(r.status, 200, r.data && r.data.error);
      const { rows } = await db.query(
        "SELECT email, name FROM users WHERE email='tidy@example.no'");
      assert.equal(rows[0].email, 'tidy@example.no', 'address normalised');
      assert.equal(rows[0].name, 'Ann Berg', 'name cleaned');
    });
  }

  section('who contributed to each version');
  {
    // Version attribution compares the Yjs state vector stored with each
    // version against the previous one's: any client whose clock advanced wrote
    // something in between. Names come from the document's own author registry,
    // which the browsers write on their first edit.
    const Y = require('yjs');
    const r = await POST('/api/new', { path: 'Blame.fountain', content: 'start\n' },
      { as: benToken });
    assert.equal(r.status, 200, r.data && r.data.error);
    const { rows } = await db.query(
      "SELECT id FROM documents WHERE path='Blame.fountain' AND deleted_at IS NULL");
    const docId = rows[0].id;

    // Two people, each with their own Yjs client, editing the one document.
    const ben = new Y.Doc(), alex = new Y.Doc();
    const sync = () => {
      Y.applyUpdate(alex, Y.encodeStateAsUpdate(ben));
      Y.applyUpdate(ben, Y.encodeStateAsUpdate(alex));
    };
    // Each registers on its FIRST EDIT, as the browser does. Registering is
    // itself an operation, so registering ahead of editing would make someone a
    // contributor to a version they had not touched.
    ben.getMap('authors').set(String(ben.clientID), { id: 'u-ben', name: 'Ben' });
    ben.getText('content').insert(0, 'one\n');
    sync();

    const snap = async (doc, name) => {
      await docs.snapshotIfChanged(docId, doc.getText('content').toString(), {
        force: true, stateVector: Buffer.from(Y.encodeStateVector(doc)),
      });
      return name;
    };
    await snap(ben, 'v1');

    alex.getMap('authors').set(String(alex.clientID), { id: 'u-alex', name: 'Alex' });
    alex.getText('content').insert(alex.getText('content').length, 'two by alex\n');
    sync();
    await snap(ben, 'v2');

    ben.getText('content').insert(ben.getText('content').length, 'three by ben\n');
    sync();
    await snap(ben, 'v3');

    const authors = {};
    ben.getMap('authors').forEach((v, k) => { authors[String(k)] = v; });
    const by = await docs.versionContributors(docId, authors);
    const names = [...by.values()].map(v => v.contributors.join('+'));

    await test('each version names only who changed it', () => {
      // Oldest first. v1 is Ben's seed; then Alex alone; then Ben alone.
      assert.deepEqual(names, ['Ben', 'Alex', 'Ben']);
    });

    await test('a client with no registered name reads as unattributed', async () => {
      const ghost = new Y.Doc();
      Y.applyUpdate(ghost, Y.encodeStateAsUpdate(ben));
      ghost.getText('content').insert(0, 'anonymous\n');
      Y.applyUpdate(ben, Y.encodeStateAsUpdate(ghost));
      await snap(ben, 'v4');
      const again = await docs.versionContributors(docId, authors);
      const last = [...again.values()].pop();
      assert.deepEqual(last.contributors, []);
      assert.equal(last.unattributed, true);
    });

    await test('history reports contributors over the API', async () => {
      // The API reads the registry from the stored document, so it has to be
      // there — in the app the browsers' own edits keep it there.
      await docs.storeState(docId, Y.encodeStateAsUpdate(ben));
      const h = await GET('/api/history?path=Blame.fountain', { as: benToken });
      assert.equal(h.status, 200);
      const oldest = h.data.snapshots[h.data.snapshots.length - 1];
      assert.deepEqual(oldest.contributors, ['Ben']);
    });

    await test('a version saved before the column existed claims no authors', async () => {
      await db.query(
        `INSERT INTO doc_versions (doc_id, name, timestamp, content, created_at)
         VALUES ($1,'legacy.fountain','20200101T000000','old',$2)`, [docId, 1]);
      const by2 = await docs.versionContributors(docId, authors);
      assert.deepEqual(by2.get('legacy.fountain').contributors, []);
      assert.equal(by2.get('legacy.fountain').unattributed, false);
    });
  }

  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
