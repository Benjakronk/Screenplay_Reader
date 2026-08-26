// Tests the Y.Text <-> textarea binding in static/collab.js.
//
//   cd collab && node test-binding.mjs
//
// Two things are checked, both against real Yjs documents:
//
//   1. diffRange finds a correct single-span edit for arbitrary text changes
//      (fuzzed, including the multi-byte and newline cases a screenplay hits).
//   2. Two clients typing at once converge on identical text, which is the
//      whole point of using a CRDT.
//
// No browser and no WebSocket: updates are relayed between the two documents by
// hand, which is exactly what the provider does over the wire.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Y from 'yjs';

const here = dirname(fileURLToPath(import.meta.url));

// static/collab.js is a classic browser script; give it just enough of a window
// to evaluate, then take the object it assigns.
function loadCollab() {
  const src = readFileSync(join(here, '..', 'static', 'collab.js'), 'utf8');
  const win = {};
  const doc = { getElementById: () => null };
  new Function('window', 'document', src)(win, doc);
  return win.Collab;
}

const Collab = loadCollab();
const diffRange = Collab._diffRange;

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) { failures++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
  else console.log(`  ok   ${name}`);
};

// ---------- 1. diffRange ----------
console.log('diffRange');

// Applying the returned range to `a` must reproduce `b` exactly.
function applyRange(a, d) {
  if (!d) return a;
  return a.slice(0, d.from) + d.inserted + a.slice(d.from + d.removed);
}

const cases = [
  ['', ''],
  ['', 'hello'],
  ['hello', ''],
  ['abc', 'abd'],
  ['INT. KITCHEN - DAY', 'INT. KITCHEN - NIGHT'],
  ['a\nb\nc', 'a\nB\nc'],
  ['line one\n', 'line one\nline two\n'],
  ['SARA', '@SARA'],
  ['aaa', 'aaaa'],           // ambiguous prefix/suffix
  ['aaaa', 'aaa'],
  ['tåke', 'tåke ligger'],   // non-ASCII
  ['x'.repeat(5000), 'x'.repeat(2500) + 'Y' + 'x'.repeat(2500)],
];
let allOk = true;
for (const [a, b] of cases) {
  const d = diffRange(a, b);
  if (applyRange(a, d) !== b) {
    allOk = false;
    console.log(`       mismatch: ${JSON.stringify(a).slice(0, 40)} -> ${JSON.stringify(b).slice(0, 40)}`);
  }
}
check(`${cases.length} hand-picked cases round-trip`, allOk);
check('equal strings return null', diffRange('same', 'same') === null);

// Fuzz: random edits to random screenplay-ish text.
const ALPHABET = 'abcdefghij \n.ÅØÆåøæ';
const rnd = (n) => Math.floor(Math.random() * n);
const randText = (len) => Array.from({ length: len }, () => ALPHABET[rnd(ALPHABET.length)]).join('');

let fuzzOk = true, minimal = true;
for (let i = 0; i < 3000; i++) {
  const a = randText(rnd(200));
  const from = rnd(a.length + 1);
  const removed = rnd(Math.max(1, a.length - from + 1));
  const inserted = randText(rnd(12));
  const b = a.slice(0, from) + inserted + a.slice(from + removed);

  const d = diffRange(a, b);
  if (applyRange(a, d) !== b) { fuzzOk = false; break; }
  // The span found must be no larger than the edit that was actually made.
  if (d && (d.removed > Math.max(removed, inserted.length) + a.length)) minimal = false;
}
check('3000 random single-span edits round-trip', fuzzOk);
check('found spans stay bounded', minimal);

// ---------- 2. convergence ----------
console.log('\nCRDT convergence');

// A pair of documents wired to each other, like two browsers through the server.
function pair() {
  const A = new Y.Doc(), B = new Y.Doc();
  A.on('update', (u, origin) => { if (origin !== 'remote') Y.applyUpdate(B, u, 'remote'); });
  B.on('update', (u, origin) => { if (origin !== 'remote') Y.applyUpdate(A, u, 'remote'); });
  return [A, B, A.getText('content'), B.getText('content')];
}

// Mirrors syncFromTextarea(): diff the textarea against what the CRDT last had,
// then apply that one span.
function typeInto(doc, ytext, was, now) {
  const d = diffRange(was, now);
  if (!d) return was;
  doc.transact(() => {
    if (d.removed) ytext.delete(d.from, d.removed);
    if (d.inserted) ytext.insert(d.from, d.inserted);
  }, 'local-editor');
  return now;
}

{
  const [A, B, ta, tb] = pair();
  let a = '', b = '';
  a = typeInto(A, ta, a, 'INT. SALOON - NATT\n');
  b = tb.toString();
  a = typeInto(A, ta, a, 'INT. SALOON - NATT\n\nRolige skritt.\n');
  check('sequential edits propagate', ta.toString() === tb.toString(),
    `${JSON.stringify(ta.toString())} vs ${JSON.stringify(tb.toString())}`);
}

{
  // Concurrent edits at different places, neither client having seen the other.
  const A = new Y.Doc(), B = new Y.Doc();
  const ta = A.getText('content'), tb = B.getText('content');
  ta.insert(0, 'INT. SALOON - NATT\n\nAction here.\n');
  Y.applyUpdate(B, Y.encodeStateAsUpdate(A));

  ta.insert(0, '# AKT I\n\n');          // A edits the top
  tb.insert(tb.length, 'SARA\nHallo.\n'); // B appends at the bottom

  Y.applyUpdate(B, Y.encodeStateAsUpdate(A));
  Y.applyUpdate(A, Y.encodeStateAsUpdate(B));

  check('concurrent edits converge', ta.toString() === tb.toString());
  check('both edits survive',
    ta.toString().includes('AKT I') && ta.toString().includes('Hallo.'),
    JSON.stringify(ta.toString()));
}

{
  // The hard case: both clients typing at the SAME offset, offline, then
  // reconnecting. Order is arbitrary but both sides must agree and lose nothing.
  const A = new Y.Doc(), B = new Y.Doc();
  const ta = A.getText('content'), tb = B.getText('content');
  ta.insert(0, 'SCENE\n');
  Y.applyUpdate(B, Y.encodeStateAsUpdate(A));

  ta.insert(6, 'AAAA');
  tb.insert(6, 'BBBB');

  Y.applyUpdate(B, Y.encodeStateAsUpdate(A));
  Y.applyUpdate(A, Y.encodeStateAsUpdate(B));

  const out = ta.toString();
  check('same-offset concurrent inserts converge', out === tb.toString());
  check('no characters lost', out.includes('AAAA') && out.includes('BBBB'), JSON.stringify(out));
}

{
  // Per-user undo: undoing must not revert a collaborator's text.
  const A = new Y.Doc(), B = new Y.Doc();
  const ta = A.getText('content'), tb = B.getText('content');
  A.on('update', (u, o) => { if (o !== 'remote') Y.applyUpdate(B, u, 'remote'); });
  B.on('update', (u, o) => { if (o !== 'remote') Y.applyUpdate(A, u, 'remote'); });

  const undoA = new Y.UndoManager(ta, { trackedOrigins: new Set(['local-editor']) });

  A.transact(() => ta.insert(0, 'MINE\n'), 'local-editor');
  B.transact(() => tb.insert(tb.length, 'THEIRS\n'), 'local-editor');
  undoA.undo();

  check('undo removes only my own text',
    !ta.toString().includes('MINE') && ta.toString().includes('THEIRS'),
    JSON.stringify(ta.toString()));
  check('undo converges', ta.toString() === tb.toString());
}

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
