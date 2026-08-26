'use strict';

// Live collaboration: a Hocuspocus (Yjs) server backed by the doc_state table.
//
// WHY ITS OWN PORT. Hocuspocus v4 moved off the `ws` package onto crossws, and
// handleConnection() now wants a web-standard Request rather than Node's
// IncomingMessage – mounting it on the Express app means hand-wiring the
// crossws Node adapter to the upgrade event. The built-in Server class is
// documented as working exactly as before for Node, so we run that on its own
// localhost port inside this same process (shared pg pool, shared auth code)
// and let nginx route /collab/ to it.
//
// The document name on the wire is the document's UUID – never its path, which
// changes on rename.

const Y = require('yjs');
const { Server } = require('@hocuspocus/server');
const { Database } = require('@hocuspocus/extension-database');
const { userForToken, roleFor } = require('./auth');
const docs = require('./docs');

const COLLAB_PORT = Number(process.env.COLLAB_PORT) || 3003;
const COLLAB_HOST = process.env.HOST || '127.0.0.1';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// nginx proxies /collab/<uuid> here with the prefix stripped, but stay tolerant
// of a leading path segment either way.
function docIdFrom(documentName) {
  const last = String(documentName || '').split('/').filter(Boolean).pop() || '';
  return UUID_RE.test(last) ? last.toLowerCase() : null;
}

let server = null;

function createCollabServer() {
  server = new Server({
    port: COLLAB_PORT,
    address: COLLAB_HOST,
    name: 'faaglarna-collab',
    quiet: true,

    // Every connection must present a session token and hold access to the
    // requested document. Throwing rejects the connection.
    async onAuthenticate({ token, documentName, connectionConfig }) {
      const docId = docIdFrom(documentName);
      if (!docId) throw new Error('unknown document');

      const user = await userForToken(token);
      if (!user) throw new Error('not signed in');

      const role = await roleFor(user.id, docId);
      if (!role) throw new Error('no access to this document');

      // Viewers may watch the document change but not write to it. Hocuspocus
      // enforces this server-side, so a tampered client cannot edit.
      if (role === 'viewer') connectionConfig.readOnly = true;

      return { userId: user.id, name: user.name || user.email, role };
    },

    extensions: [
      new Database({
        fetch: async ({ documentName }) => {
          const docId = docIdFrom(documentName);
          if (!docId) return null;
          const bytes = await docs.loadState(docId);
          // Must be the same bytes store() saved – never a fresh Y.Doc.
          return bytes ? new Uint8Array(bytes) : null;
        },
        store: async ({ documentName, state }) => {
          const docId = docIdFrom(documentName);
          if (!docId) return;
          await docs.storeState(docId, state);
        },
      }),
    ],
  });

  return server;
}

async function listen() {
  if (!server) createCollabServer();
  await server.listen();
  return server;
}

// onStoreDocument is debounced, so a plain process exit can drop the last few
// seconds of edits. Flush before we go.
async function shutdown() {
  if (!server) return;
  try {
    server.hocuspocus.flushPendingStores();
    await server.destroy();
  } catch { /* shutting down anyway */ }
}

// ---------- authoritative text access ----------
//
// A document being edited right now lives in Hocuspocus's memory and its
// doc_state row may lag behind by a debounce interval. Exports and version
// snapshots must not read a stale copy, so they go through a direct connection:
// it serves the in-memory document when there is one and loads from the
// database when there isn't.

async function readText(docId) {
  if (!server) return docs.storedText(docId);
  const conn = await server.hocuspocus.openDirectConnection(String(docId));
  try {
    let text = '';
    await conn.transact((doc) => { text = docs.textOf(doc); });
    return text;
  } finally {
    await conn.disconnect();
  }
}

// Wholesale replacement – restore from history, .fdx import, seeding a new
// document. Ordinary edits never come through here; they arrive from the
// browser as incremental CRDT updates.
async function writeText(docId, text) {
  if (!server) {
    // No collaboration server running (create-user.js, tests): write directly.
    const bytes = await docs.loadState(docId);
    const doc = docs.docFromState(bytes);
    docs.replaceText(doc, text);
    await docs.storeState(docId, Y.encodeStateAsUpdate(doc));
    return;
  }
  const conn = await server.hocuspocus.openDirectConnection(String(docId));
  try {
    await conn.transact((doc) => { docs.replaceText(doc, text); });
  } finally {
    await conn.disconnect();
  }
}

// How many people are in a document right now, for the presence UI. The
// server-level getConnectionsCount() is a total across all documents, so go via
// the Document, which has its own per-document count.
function connectionCount(docId) {
  try {
    return server?.hocuspocus?.documents?.get(String(docId))?.getConnectionsCount() ?? 0;
  } catch {
    return 0;
  }
}

module.exports = {
  createCollabServer, listen, shutdown,
  readText, writeText, connectionCount,
  COLLAB_PORT,
};
