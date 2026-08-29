// Two clients, the REAL static/collab.js, end to end.
//
//   cd collab && node test-twoclient.mjs
//
// test-binding.mjs re-implements the sync by hand and tests diffRange against
// raw Y.Docs. That left the path the app actually runs — attach(), the ytext
// observer, applyRemote() and the textarea it writes to — with no coverage at
// all, which is where the "edits don't land" bug lived.
//
// Here collab.js is loaded twice against a fake provider that relays updates
// between the two documents, exactly as the server does over the wire.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Y from 'yjs';

const here = dirname(fileURLToPath(import.meta.url));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (err) { failed++; console.log(`  FAIL ${name}\n       ${err.message}`); }
}
const eq = (a, b, msg) => {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${msg || 'mismatch'}\n         got      ${x}\n         expected ${y}`);
};

// ---------- fakes ----------

// A <textarea> NORMALISES newlines: the HTML spec's "API value" converts CRLF
// and lone CR to LF, both on assignment and through setRangeText. A fake that
// stores whatever it is given is not a textarea, and the difference is not
// cosmetic - it is the entire reason a CRLF document desynced while an LF one
// worked. Reproduce it exactly.
const taNormalise = (s) => String(s).replace(/\r\n?/g, '\n');

function makeTextarea(initial = '') {
  return {
    _value: taNormalise(initial),
    get value() { return this._value; },
    set value(v) { this._value = taNormalise(v); },
    selectionStart: 0, selectionEnd: 0, scrollTop: 0, scrollLeft: 0,
    dataset: {}, _attrs: {}, _on: {},
    setAttribute(k, v) { this._attrs[k] = v; },
    removeAttribute(k) { delete this._attrs[k]; },
    getAttribute(k) { return this._attrs[k] ?? null; },
    addEventListener(k, fn) { (this._on[k] ||= []).push(fn); },
    removeEventListener() {},
    setSelectionRange(s, e) { this.selectionStart = s; this.selectionEnd = e; },
    // Faithful to the spec's selectionMode:'preserve'.
    setRangeText(repl, start, end, mode) {
      const clean = taNormalise(repl);
      this._value = this._value.slice(0, start) + clean + this._value.slice(end);
      const delta = clean.length - (end - start);
      const adj = (p) => (p <= start ? p : p >= end ? p + delta : start + clean.length);
      if (mode === 'preserve') {
        this.selectionStart = adj(this.selectionStart);
        this.selectionEnd = adj(this.selectionEnd);
      } else {
        this.selectionStart = this.selectionEnd = start + clean.length;
      }
    },
  };
}

// A hub standing in for the collaboration server: every document joined to it
// receives every other document's updates.
const HUB = {
  peers: [],
  join(p) {
    for (const q of this.peers) Y.applyUpdate(p.doc, Y.encodeStateAsUpdate(q.doc), 'hub');
    p._relay = (update, origin) => {
      if (origin === 'hub') return;
      for (const q of HUB.peers) if (q !== p) Y.applyUpdate(q.doc, update, 'hub');
    };
    p.doc.on('update', p._relay);
    this.peers.push(p);
  },
  leave(p) {
    this.peers = this.peers.filter((q) => q !== p);
    try { p.doc.off('update', p._relay); } catch {}
  },
  reset() { this.peers = []; },
};

class FakeProvider {
  constructor(opts) {
    this.doc = opts.document;
    this.handlers = {};
    this.awareness = {
      setLocalStateField() {}, getStates() { return new Map(); }, on() {},
    };
    HUB.join(this);
    // The real provider syncs asynchronously, after the caller has registered
    // its handlers.
    queueMicrotask(() => this.emit('synced'));
  }
  on(ev, fn) { (this.handlers[ev] ||= []).push(fn); }
  emit(ev, arg) { for (const f of this.handlers[ev] || []) f(arg); }
  destroy() { HUB.leave(this); }
}

// static/collab.js is a classic script that lazy-loads its Yjs bundle by
// appending a <script>. Hand it one that is already there.
function loadCollab(textarea) {
  const src = readFileSync(join(here, '..', 'static', 'collab.js'), 'utf8');
  const win = { FaaglarnaYjs: { Y, HocuspocusProvider: FakeProvider } };
  const doc = {
    getElementById: (id) => (id === 'editor' ? textarea : null),
    createElement: () => {
      const el = {};
      queueMicrotask(() => el.onload && el.onload());
      return el;
    },
    head: { appendChild() {} },
  };
  new Function('window', 'document', src)(win, doc);
  return win.Collab;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function twoClients(initial = '') {
  HUB.reset();
  const taA = makeTextarea(''), taB = makeTextarea('');
  const A = loadCollab(taA), B = loadCollab(taB);
  const seed = { docId: 'doc-1', url: 'ws://x', token: 't', user: { id: 'u', name: 'N' } };
  await A.attach({ ...seed, role: 'editor', textarea: taA, hooks: {} });
  await tick();
  // Only now does A have a synced (empty) document to type into: its own first
  // sync would otherwise overwrite whatever the textarea held.
  taA.value = initial;
  A.syncFromTextarea();
  await B.attach({ ...seed, role: 'editor', textarea: taB, hooks: {} });
  await tick();
  return { A, B, taA, taB };
}

// Typing: app.js mutates the textarea, then markDirty() calls syncFromTextarea.
function type(C, ta, next) { ta.value = next; C.syncFromTextarea(); }

// ---------- the path that had no coverage ----------

console.log('a remote edit reaches the other textarea');
{
  const { A, B, taA, taB } = await twoClients('INT. SALOON - NATT\n');

  test('joining pulls the existing text into the textarea', () => {
    eq(taB.value, 'INT. SALOON - NATT\n');
  });

  test("A's edit lands in B's textarea", () => {
    type(A, taA, 'INT. SALOON - NATT\n\nRolige skritt.\n');
    eq(taB.value, 'INT. SALOON - NATT\n\nRolige skritt.\n');
  });

  test("B's edit lands in A's textarea", () => {
    type(B, taB, 'INT. SALOON - NATT\n\nRolige avventende skritt.\n');
    eq(taA.value, 'INT. SALOON - NATT\n\nRolige avventende skritt.\n');
  });

  test('both textareas agree with the CRDT', () => {
    eq(taA.value, A.text);
    eq(taB.value, B.text);
  });

  test('a second round trip still lands', () => {
    type(A, taA, A.text + 'SARA\nHallo?\n');
    eq(taB.value, taA.value);
    type(B, taB, taB.value + 'KORNELIUS\nJa.\n');
    eq(taA.value, taB.value);
  });
}

console.log('\nthe caret survives a collaborator typing');
{
  const { A, B, taA, taB } = await twoClients('one two three');
  taB.setSelectionRange(13, 13);          // B's caret at the end
  test('an insertion above B does not drag B\'s caret', () => {
    type(A, taA, 'ZERO\none two three');
    eq(taB.value, 'ZERO\none two three');
    eq(taB.selectionStart, 18);
  });
}

// ---------- the full client: collab + suggestions, two of them ----------
//
// The reported failure was that a suggestion crosses to the other browser but
// the TEXT does not, and that accepting resolves only for the person who
// suggested it. Both are about two clients running every module at once, which
// is what this drives.

function loadInto(win, name, textarea) {
  const src = readFileSync(join(here, '..', 'static', name), 'utf8');
  const stubEl = () => ({
    style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} },
    appendChild() {}, setAttribute() {}, querySelectorAll: () => [],
    querySelector: () => null, innerHTML: '', textContent: '',
  });
  const doc = {
    getElementById: (id) => (id === 'editor' ? textarea : null),
    querySelector: () => null,
    body: { classList: { toggle() {} } },
    createElement: () => stubEl(),
  };
  new Function('window', 'document', src)(win, doc);
}

async function fullClients(initial) {
  HUB.reset();
  const mk = (name) => {
    const ta = makeTextarea('');
    const win = {
      FaaglarnaYjs: { Y, HocuspocusProvider: FakeProvider },
      Cloud: { user: { id: name, name } },
    };
    const src = readFileSync(join(here, '..', 'static', 'collab.js'), 'utf8');
    new Function('window', 'document', src)(win, {
      getElementById: (id) => (id === 'editor' ? ta : null),
      createElement: () => {
        const el = {};
        queueMicrotask(() => el.onload && el.onload());
        return el;
      },
      head: { appendChild() {} },
    });
    loadInto(win, 'suggestions.js', ta);
    return { win, ta, Collab: win.Collab, S: win.Suggestions, name };
  };

  const A = mk('ben'), B = mk('alex');
  const seed = { docId: 'doc-1', url: 'ws://x', token: 't' };
  await A.Collab.attach({ ...seed, role: 'editor', user: { id: 'ben' }, textarea: A.ta, hooks: {} });
  await tick();
  A.ta.value = initial;
  A.Collab.syncFromTextarea();
  A.S.attach();
  await B.Collab.attach({ ...seed, role: 'editor', user: { id: 'alex' }, textarea: B.ta, hooks: {} });
  B.S.attach();
  await tick();
  return { A, B };
}

console.log('\nsuggestions across two clients');
{
  const { A, B } = await fullClients('Rolige avventende skritt.');

  test('both clients start from the same text', () => {
    eq(B.ta.value, 'Rolige avventende skritt.');
  });

  A.S.setEnabled(true);
  type(A.Collab, A.ta, 'Rolige ganske avventende skritt.');

  test("the suggested TEXT reaches the other client's textarea", () => {
    eq(B.ta.value, 'Rolige ganske avventende skritt.');
  });
  test('the other client sees the suggestion in its panel', () => {
    eq(B.S.list().length, 1);
    eq(B.S.list()[0].text, 'ganske ');
  });
  test('the reviewer accepting drops the mark on BOTH sides', () => {
    B.S.accept(B.S.list()[0].id);
    eq(B.S.list().length, 0);
    eq(A.S.list().length, 0);
    eq(A.ta.value, 'Rolige ganske avventende skritt.');
    eq(B.ta.value, 'Rolige ganske avventende skritt.');
  });
}

{
  const { A, B } = await fullClients('Rolige avventende skritt.');
  A.S.setEnabled(true);
  const id = A.S._recordDelete(7, 18);          // "avventende "

  test('a delete suggestion crosses to the other client', () => {
    eq(B.S.list().length, 1);
    eq(B.S.list()[0].kind, 'delete');
    eq(B.S.list()[0].text, 'avventende ');
  });
  test('the reviewer accepting removes the text in BOTH textareas', () => {
    B.S.accept(id);
    eq(B.ta.value, 'Rolige skritt.');
    eq(A.ta.value, 'Rolige skritt.');
  });
}

{
  const { A, B } = await fullClients('Rolige avventende skritt.');
  A.S.setEnabled(true);
  const id = A.S._recordDelete(7, 18);
  test('the reviewer rejecting keeps the text and clears both marks', () => {
    B.S.reject(id);
    eq(A.ta.value, 'Rolige avventende skritt.');
    eq(B.ta.value, 'Rolige avventende skritt.');
    eq(A.S.list().length, 0);
    eq(B.S.list().length, 0);
  });
}

// ---------- CRLF: the document the app could not edit ----------
//
// A .fountain file written on Windows arrives with CRLF line endings, and the
// server seeded the CRDT with them verbatim. A textarea cannot hold a CR, so
// the CRDT held 1430 characters the editor did not - and every offset that
// crossed between them (a typed edit, a comment anchor, a suggestion range) was
// wrong by the number of lines above it. Editing such a document corrupted it;
// an LF document was fine, which is exactly what was observed in the wild.

const CRLF = 'INT. SALOON - NATT\r\n\r\nRolige avventende skritt.\r\n\r\nSARA\r\nHallo?\r\n';
const LF = CRLF.replace(/\r\n/g, '\n');

// Seeds the shared document the way an import does: straight into the CRDT,
// bypassing the textarea that would otherwise have normalised it.
async function importedClients(text) {
  const { A, B, taA, taB } = await twoClients('');
  A.ydoc.transact(() => { A.ytext.delete(0, A.ytext.length); A.ytext.insert(0, text); }, 'import');
  await tick();
  return { A, B, taA, taB };
}

console.log('\na document imported with CRLF line endings');
{
  const { A, B, taA, taB } = await importedClients(CRLF);

  test('the CRDT is normalised to LF, so the textarea can match it', () => {
    eq(A.text, LF);
  });
  test('both textareas hold exactly what the CRDT holds', () => {
    eq(taA.value, LF);
    eq(taB.value, LF);
  });

  test('an edit lands where it was typed, not shifted by the CR count', () => {
    // Type "ganske " before "avventende", counted in the editor's coordinates.
    const at = taA.value.indexOf('avventende');
    taA.value = taA.value.slice(0, at) + 'ganske ' + taA.value.slice(at);
    A.syncFromTextarea();
    eq(A.text, taA.value, 'the CRDT must agree with the editor that produced it');
    eq(taB.value, taA.value, 'and the other client must see the same');
    eq(taB.value.includes('Rolige ganske avventende skritt.'), true);
  });

  test('a second edit still lands correctly', () => {
    taB.value = taB.value.replace('Hallo?', 'Hallo der?');
    B.syncFromTextarea();
    eq(taA.value, taB.value);
    eq(A.text, taA.value);
  });
}

console.log('\nCRLF arriving mid-session');
{
  // A restore-from-history or an .fdx import can push CRLF into a document that
  // is already open. The editor must not be left disagreeing with the CRDT.
  const { A, B, taA, taB } = await twoClients('one\ntwo\n');
  A.ydoc.transact(() => { A.ytext.delete(0, A.ytext.length); A.ytext.insert(0, 'a\r\nb\r\nc\r\n'); }, 'restore');
  await tick();

  test('the CR characters do not survive in the CRDT', () => {
    eq(A.text.includes('\r'), false);
    eq(A.text, 'a\nb\nc\n');
  });
  test('both editors show the restored text', () => {
    eq(taA.value, 'a\nb\nc\n');
    eq(taB.value, 'a\nb\nc\n');
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
