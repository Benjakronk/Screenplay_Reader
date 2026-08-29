// Tests the tracked-change model in static/suggestions.js.
//
//   cd collab && node test-suggestions.mjs
//
// Loads the REAL module against real Y.Docs, as test-comments.mjs does. What is
// covered is the part that can silently corrupt a script: whether accepting or
// rejecting each kind of suggestion leaves the right text behind.

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

function makeCollab(doc, { readOnly = false } = {}) {
  return {
    active: () => true,
    get readOnly() { return readOnly; },
    get Y() { return Y; },
    get ydoc() { return doc; },
    get ytext() { return doc.getText('content'); },
    onDocChange: () => () => {},
    onLocalEdit: () => () => {},
  };
}

function load(collab, user) {
  const src = readFileSync(join(here, '..', 'static', 'suggestions.js'), 'utf8');
  const win = { Collab: collab, Cloud: { user } };
  const doc = {
    getElementById: () => null, querySelector: () => null,
    body: { classList: { toggle() {} } },
    createElement: () => ({ style: {}, dataset: {}, classList: { add(){}, remove(){}, toggle(){} },
                            appendChild(){}, setAttribute(){}, querySelectorAll: () => [] }),
  };
  new Function('window', 'document', src)(win, doc);
  return win.Suggestions;
}

function fresh(text, opts) {
  const doc = new Y.Doc();
  doc.getText('content').insert(0, text);
  return { doc, t: doc.getText('content'),
           S: load(makeCollab(doc, opts), { id: 'u1', name: 'Ben' }) };
}

const BASE = 'Rolige avventende skritt.';

// ------------------------------------------------------------ accept / reject
console.log('accept and reject leave the right text');
{
  // insert: the proposed text is already in the document, marked green.
  const { t, S } = fresh('Rolige ganske avventende skritt.');
  const id = S._recordInsert(7, 14);          // "ganske "
  test('an insert suggestion records what was proposed', () => {
    eq(S.list().length, 1);
    eq(S.list()[0].kind, 'insert');
    eq(S.list()[0].text, 'ganske ');
  });
  test('ACCEPTING an insert keeps the text and drops the mark', () => {
    S.accept(id);
    eq(t.toString(), 'Rolige ganske avventende skritt.');
    eq(S.list().length, 0);
  });
}
{
  const { t, S } = fresh('Rolige ganske avventende skritt.');
  const id = S._recordInsert(7, 14);
  test('REJECTING an insert removes the text', () => {
    S.reject(id);
    eq(t.toString(), BASE + '');
    eq(S.list().length, 0);
  });
}
{
  const { t, S } = fresh(BASE);
  const id = S._recordDelete(7, 18);          // "avventende "
  test('a delete suggestion leaves the text in place until resolved', () => {
    eq(t.toString(), BASE, 'text must not be removed when the suggestion is made');
    eq(S.list()[0].kind, 'delete');
    eq(S.list()[0].text, 'avventende ');
  });
  test('ACCEPTING a delete removes the text', () => {
    S.accept(id);
    eq(t.toString(), 'Rolige skritt.');
    eq(S.list().length, 0);
  });
}
{
  const { t, S } = fresh(BASE);
  const id = S._recordDelete(7, 18);
  test('REJECTING a delete keeps the text', () => {
    S.reject(id);
    eq(t.toString(), BASE);
    eq(S.list().length, 0);
  });
}

// ------------------------------------------------------------------- batching
console.log('\nconsecutive typing');
{
  const { t, S } = fresh('Rolige X skritt.');
  test('adjacent insertions extend one suggestion rather than piling up', () => {
    // Simulates typing "abc" one character at a time.
    t.insert(7, 'a'); S._recordInsert(7, 8);
    t.insert(8, 'b'); S._recordInsert(8, 9);
    t.insert(9, 'c'); S._recordInsert(9, 10);
    eq(S.list().length, 1, 'three keystrokes must be one suggestion');
    eq(S.list()[0].text, 'abc');
  });
  test('a non-adjacent insertion starts a new one', () => {
    t.insert(0, 'Z'); S._recordInsert(0, 1);
    eq(S.list().length, 2);
  });
}

// --------------------------------------------------- typing next to a deletion
console.log('\ncorrecting yourself while suggesting');
{
  const { t, S } = fresh('Rolige avventende skritt.');
  const id = S._recordDelete(7, 18);          // propose removing "avventende "
  test('text typed where a deletion ends is NOT swallowed by it', () => {
    // Typing over a selection marks the old text and inserts the new right at
    // the deletion's end. The replacement must stay out of the removal.
    t.insert(18, 'rolige ');
    const s = S.list()[0];
    eq(s.id, id);
    eq(s.text, 'avventende ', 'the mark must still cover only what was replaced');
  });
  test('accepting removes only the proposed span', () => {
    S.accept(id);
    eq(t.toString(), 'Rolige rolige skritt.');
  });
}
{
  const { t, S } = fresh('Rolige avventende skritt.');
  test('repeated backspaces grow one mark instead of a trail of them', () => {
    // Backspace walking left through "skritt", one character at a time.
    S._recordDelete(23, 24);
    S._recordDelete(22, 23);
    S._recordDelete(21, 22);
    eq(S.list().length, 1, 'three keystrokes must read as one proposed removal');
    eq(S.list()[0].text, 'itt');
  });
  test('the merged mark accepts as a single span', () => {
    S.accept(S.list()[0].id);
    eq(t.toString(), 'Rolige avventende skr.');
  });
}

// ------------------------------------------------------------------- anchoring
console.log('\nanchoring and orphans');
{
  const { t, S } = fresh(BASE);
  const id = S._recordDelete(7, 18);
  test('the mark follows its words when text is inserted above', () => {
    t.insert(0, 'INT. SALOON - NATT\n\n');
    const s = S.list()[0];
    eq(t.toString().slice(s.from, s.to), 'avventende ');
  });
  test('accepting still removes exactly the right span after a shift', () => {
    S.accept(id);
    eq(t.toString(), 'INT. SALOON - NATT\n\nRolige skritt.');
  });
}
{
  const { t, S } = fresh(BASE);
  S._recordDelete(7, 18);
  test('a suggestion whose text is deleted outright is marked orphaned', () => {
    t.delete(7, 11);
    eq(S.list()[0].orphaned, true);
  });
  test('resolving an orphan removes the mark and touches no text', () => {
    const before = t.toString();
    S.accept(S.list()[0].id);
    eq(t.toString(), before);
    eq(S.list().length, 0);
  });
}

// --------------------------------------------------------------- bulk resolve
console.log('\nresolving several at once');
{
  const { t, S } = fresh('one two three four');
  S._recordDelete(0, 4);      // "one "
  S._recordInsert(8, 14);     // "three "
  test('accept all: deletes go, inserts stay', () => {
    S.acceptAll();
    eq(t.toString(), 'two three four');
    eq(S.list().length, 0);
  });
}
{
  const { t, S } = fresh('one two three four');
  S._recordDelete(0, 4);
  S._recordInsert(8, 14);
  test('reject all: deletes stay, inserts go', () => {
    S.rejectAll();
    eq(t.toString(), 'one two four');
    eq(S.list().length, 0);
  });
}

// -------------------------------------------------------------- permissions
console.log('\npermissions');
{
  const { t, S } = fresh(BASE, { readOnly: true });
  test('a viewer cannot record or resolve suggestions', () => {
    S._recordDelete(0, 6);
    eq(S.list().length, 0);
    eq(t.toString(), BASE);
  });
}

// --------------------------------------------------------------- concurrency
console.log('\nconcurrency');
{
  const A = new Y.Doc(), B = new Y.Doc();
  A.getText('content').insert(0, 'one two three four');
  Y.applyUpdate(B, Y.encodeStateAsUpdate(A));
  const SA = load(makeCollab(A), { id: 'u1', name: 'Ben' });
  const SB = load(makeCollab(B), { id: 'u2', name: 'Alex' });

  const idA = SA._recordDelete(0, 4);
  SB._recordDelete(14, 18);
  Y.applyUpdate(B, Y.encodeStateAsUpdate(A));
  Y.applyUpdate(A, Y.encodeStateAsUpdate(B));

  test('suggestions made concurrently both survive', () => {
    eq(SA.list().length, 2);
    eq(SA.list().map(s => s.text), SB.list().map(s => s.text));
  });

  test('one side accepting propagates the text change to the other', () => {
    SA.accept(idA);
    Y.applyUpdate(B, Y.encodeStateAsUpdate(A));
    eq(A.getText('content').toString(), 'two three four');
    eq(B.getText('content').toString(), 'two three four');
    eq(SB.list().length, 1, 'the other suggestion is untouched');
    eq(SB.list()[0].text, 'four');
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
