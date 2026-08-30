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

// Only the suggestions still awaiting a decision. Resolved ones stay in the
// list as a record of what was decided and why, so counting everything answers
// a different question than these tests are asking.
const openOf = (S) => S.list().filter((s) => s.open);

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
    eq(openOf(S).length, 0);
  });
  test('and the decision is kept, with what was proposed', () => {
    const s = S.list()[0];
    eq(s.status, 'accepted');
    eq(s.resolvedBy, 'Ben');
    eq(s.text, 'ganske ');
  });
  test('the accepted range no longer grows with later typing', () => {
    // An accepted insertion stays in the document and its range end still
    // associates rightwards, so a live reading would swallow whatever is typed
    // next. The record is frozen at the moment it was resolved.
    t.insert(14, 'MORE');
    eq(S.list()[0].text, 'ganske ');
  });
}
{
  const { t, S } = fresh('Rolige ganske avventende skritt.');
  const id = S._recordInsert(7, 14);
  test('REJECTING an insert removes the text', () => {
    S.reject(id);
    eq(t.toString(), BASE + '');
    eq(openOf(S).length, 0);
    eq(S.list()[0].status, 'rejected');
    eq(S.list()[0].text, 'ganske ', 'the record still says what was proposed');
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
    eq(openOf(S).length, 0);
    eq(S.list()[0].status, 'accepted');
    eq(S.list()[0].text, 'avventende ', 'the removed words survive in the record');
  });
}
{
  const { t, S } = fresh(BASE);
  const id = S._recordDelete(7, 18);
  test('REJECTING a delete keeps the text', () => {
    S.reject(id);
    eq(t.toString(), BASE);
    eq(openOf(S).length, 0);
    eq(S.list()[0].status, 'rejected');
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
    eq(openOf(S).length, 0);
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
    eq(openOf(S).length, 0);
    eq(S.list().length, 2, 'both decisions are kept');
  });
}
{
  const { t, S } = fresh('one two three four');
  S._recordDelete(0, 4);
  S._recordInsert(8, 14);
  test('reject all: deletes stay, inserts go', () => {
    S.rejectAll();
    eq(t.toString(), 'one two four');
    eq(openOf(S).length, 0);
    eq(S.list().length, 2, 'both decisions are kept');
  });
}

// ------------------------------------------------------- explaining a change
console.log('\na suggestion carries its own thread');
{
  const { S } = fresh(BASE);
  const id = S._recordDelete(7, 18);
  test('a new suggestion starts with no notes', () => {
    eq(S.list()[0].replies, []);
  });
  test('a note records who wrote it and what it says', () => {
    S.reply(id, 'This line repeats the stage direction above.');
    const r = S.list()[0].replies;
    eq(r.length, 1);
    eq(r[0].text, 'This line repeats the stage direction above.');
    eq(r[0].authorName, 'Ben');
  });
  test('the thread keeps its order as it grows', () => {
    S.reply(id, 'Agreed, cut it.');
    eq(S.list()[0].replies.map((r) => r.text),
       ['This line repeats the stage direction above.', 'Agreed, cut it.']);
  });
  test('an empty note is not recorded', () => {
    S.reply(id, '   ');
    eq(S.list()[0].replies.length, 2);
  });
}
{
  // Threads were added after suggestions existed, so a suggestion stored
  // without a replies list must still accept one rather than throwing.
  const doc = new Y.Doc();
  doc.getText('content').insert(0, BASE);
  const S = load(makeCollab(doc), { id: 'u1', name: 'Ben' });
  const legacy = new Y.Map();
  doc.transact(() => {
    doc.getArray('suggestions').push([legacy]);
    legacy.set('id', 'old1');
    legacy.set('kind', 'delete');
    legacy.set('from', Y.encodeRelativePosition(
      Y.createRelativePositionFromTypeIndex(doc.getText('content'), 7)));
    legacy.set('to', Y.encodeRelativePosition(
      Y.createRelativePositionFromTypeIndex(doc.getText('content'), 18, -1)));
    legacy.set('text', 'avventende ');
    legacy.set('authorName', 'Ben');
    // deliberately no 'replies'
  });
  test('a suggestion made before threads existed reads as having none', () => {
    eq(S.list()[0].replies, []);
  });
  test('and can still be given one', () => {
    S.reply('old1', 'Why this goes');
    eq(S.list()[0].replies.map((r) => r.text), ['Why this goes']);
  });
}
{
  // Two people writing on the same thread at once, neither having seen the
  // other — the case a plain array would lose one half of.
  const A = new Y.Doc(), B = new Y.Doc();
  A.getText('content').insert(0, BASE);
  const SA = load(makeCollab(A), { id: 'u1', name: 'Ben' });
  const id = SA._recordDelete(7, 18);
  Y.applyUpdate(B, Y.encodeStateAsUpdate(A));
  const SB = load(makeCollab(B), { id: 'u2', name: 'Alex' });

  SA.reply(id, 'Cut this?');
  SB.reply(id, 'It reads better without.');
  Y.applyUpdate(B, Y.encodeStateAsUpdate(A));
  Y.applyUpdate(A, Y.encodeStateAsUpdate(B));

  test('concurrent notes both survive the merge', () => {
    const texts = SA.list()[0].replies.map((r) => r.text).sort();
    eq(texts, ['Cut this?', 'It reads better without.']);
    eq(SA.list()[0].replies.length, SB.list()[0].replies.length);
  });
  test('both sides agree on the thread', () => {
    eq(SA.list()[0].replies.map((r) => r.text),
       SB.list()[0].replies.map((r) => r.text));
  });
  test('resolving KEEPS the thread — the reasoning outlives the decision', () => {
    SA.accept(id);
    eq(openOf(SA).length, 0);
    const s = SA.list()[0];
    eq(s.status, 'accepted');
    eq(s.replies.map((r) => r.text).sort(),
       ['Cut this?', 'It reads better without.']);
  });
  test('and dismissing is what finally removes it', () => {
    SA.dismiss(SA.list()[0].id);
    eq(SA.list().length, 0);
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
{
  // A viewer reads the discussion but does not join it: the notes live in the
  // same document as the text, which they have no write access to.
  const doc = new Y.Doc();
  doc.getText('content').insert(0, BASE);
  const writer = load(makeCollab(doc), { id: 'u1', name: 'Ben' });
  const id = writer._recordDelete(7, 18);
  writer.reply(id, 'Because it repeats.');
  const viewer = load(makeCollab(doc, { readOnly: true }), { id: 'u2', name: 'Alex' });

  test('a viewer sees the thread', () => {
    eq(viewer.list()[0].replies.map((r) => r.text), ['Because it repeats.']);
  });
  test('a viewer cannot add to it', () => {
    viewer.reply(id, 'let me in');
    eq(writer.list()[0].replies.length, 1);
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
    eq(openOf(SB).length, 1, 'the other suggestion is untouched');
    eq(openOf(SB)[0].text, 'four');
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
