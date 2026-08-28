// Tests the comment model in static/comments.js.
//
//   cd collab && node test-comments.mjs
//
// Loads the REAL module and drives it against real Y.Docs, with only enough of
// a window/document to let it evaluate. Everything exercised here — anchoring,
// orphan detection, concurrent merge — is model logic that touches the CRDT and
// not the DOM, so it is genuinely the shipped code under test rather than a
// reimplementation of it.
//
// The rendering half (overlay boxes, the sidebar panel) needs a browser and is
// covered by the manual checklist instead.

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
const ok = (v, msg) => { if (!v) throw new Error(msg || 'expected truthy'); };

// A Collab stand-in over a real Y.Doc: the same surface comments.js consumes.
function makeCollab(doc, { readOnly = false, user = { id: 'u1', name: 'Ben' } } = {}) {
  return {
    active: () => true,
    get readOnly() { return readOnly; },
    get Y() { return Y; },
    get ydoc() { return doc; },
    get ytext() { return doc.getText('content'); },
    onDocChange: () => () => {},
  };
}

// Evaluate the real module with a minimal window/document.
function loadComments(collab, user) {
  const src = readFileSync(join(here, '..', 'static', 'comments.js'), 'utf8');
  const win = { Collab: collab, Cloud: { user }, requestAnimationFrame: (f) => f() };
  const doc = { getElementById: () => null, querySelector: () => null,
                createElement: () => ({ style: {}, dataset: {}, classList: { add(){}, remove(){}, toggle(){} },
                                        appendChild(){}, setAttribute(){}, querySelectorAll: () => [] }) };
  new Function('window', 'document', 'requestAnimationFrame', src)(win, doc, (f) => f());
  return win.Comments;
}

function fresh(text = 'INT. SALOON - NATT\n\nRolige avventende skritt.\n', opts) {
  const doc = new Y.Doc();
  doc.getText('content').insert(0, text);
  const collab = makeCollab(doc, opts);
  return { doc, collab, C: loadComments(collab, (opts && opts.user) || { id: 'u1', name: 'Ben' }) };
}

// ---------------------------------------------------------------- anchoring
console.log('anchoring');
{
  const { doc, C } = fresh();
  const t = doc.getText('content');
  const at = t.toString().indexOf('avventende');
  const id = C.add(at, at + 'avventende'.length, 'too wordy?');

  test('a new comment resolves to the text it was made on', () => {
    const c = C.list()[0];
    eq(t.toString().slice(c.from, c.to), 'avventende');
    eq(c.orphaned, false);
    eq(c.replies.length, 1);
    eq(c.replies[0].text, 'too wordy?');
  });

  test('the anchor holds when text is inserted ABOVE it', () => {
    t.insert(0, '# AKT I\n\nA whole new scene.\n\n');
    const c = C.list()[0];
    eq(t.toString().slice(c.from, c.to), 'avventende');
  });

  test('the anchor holds when text is inserted immediately BEFORE it', () => {
    t.insert(t.toString().indexOf('avventende'), 'ganske ');
    const c = C.list()[0];
    eq(t.toString().slice(c.from, c.to), 'avventende');
  });

  test('the anchor holds when text is inserted below', () => {
    t.insert(t.length, '\nSARA\nHallo.\n');
    eq(t.toString().slice(C.list()[0].from, C.list()[0].to), 'avventende');
  });

  test('deleting the anchored span orphans the comment', () => {
    const c = C.list()[0];
    t.delete(c.from, c.to - c.from);
    const after = C.list()[0];
    eq(after.orphaned, true);
    eq(after.quote, 'avventende', 'the original words must survive on the thread');
    eq(after.replies[0].text, 'too wordy?', 'the discussion must not be lost');
  });

  test('an orphaned comment is kept, never auto-deleted', () => {
    eq(C.list().length, 1);
    ok(id, 'id was returned');
  });
}

// ------------------------------------------------------------------ threads
console.log('\nthreads');
{
  const { doc, C } = fresh();
  const t = doc.getText('content');
  const at = t.toString().indexOf('Rolige');
  const id = C.add(at, at + 6, 'cut this?');

  test('replies append in order', () => {
    C.reply(id, 'I disagree');
    C.reply(id, 'fair enough');
    eq(C.list()[0].replies.map(r => r.text), ['cut this?', 'I disagree', 'fair enough']);
  });
  test('resolve and reopen', () => {
    C.setResolved(id, true);
    eq(C.list()[0].resolved, true);
    C.setResolved(id, false);
    eq(C.list()[0].resolved, false);
  });
  test('delete removes the thread', () => {
    C.remove(id);
    eq(C.list().length, 0);
  });
}

// -------------------------------------------------------------- permissions
console.log('\npermissions');
{
  const { doc, C } = fresh(undefined, { readOnly: true });
  const t = doc.getText('content');
  test('a viewer cannot add a comment', () => {
    C.add(0, 6, 'nope');
    eq(C.list().length, 0);
  });
  test('a viewer cannot reply, resolve or delete', () => {
    // Seed one as an editor, then confirm the viewer instance cannot touch it.
    const editor = loadComments(makeCollab(doc), { id: 'u2', name: 'Alex' });
    const id = editor.add(0, 6, 'from the owner');
    C.reply(id, 'sneaky');
    C.setResolved(id, true);
    C.remove(id);
    const c = editor.list()[0];
    eq(c.replies.length, 1, 'reply was refused');
    eq(c.resolved, false, 'resolve was refused');
    eq(editor.list().length, 1, 'delete was refused');
  });
}

// --------------------------------------------------------------- concurrency
console.log('\nconcurrency');
{
  const A = new Y.Doc(), B = new Y.Doc();
  A.getText('content').insert(0, 'Rolige avventende skritt.\n');
  Y.applyUpdate(B, Y.encodeStateAsUpdate(A));

  const CA = loadComments(makeCollab(A), { id: 'u1', name: 'Ben' });
  const CB = loadComments(makeCollab(B), { id: 'u2', name: 'Alex' });

  // Neither has seen the other yet.
  const idA = CA.add(7, 17, 'too wordy?');
  CB.add(0, 6, 'good opening');

  Y.applyUpdate(B, Y.encodeStateAsUpdate(A));
  Y.applyUpdate(A, Y.encodeStateAsUpdate(B));

  test('comments made concurrently both survive', () => {
    eq(CA.list().length, 2);
    eq(CA.list().map(c => c.quote), CB.list().map(c => c.quote));
  });

  test('both anchors still resolve after the merge', () => {
    const txt = A.getText('content').toString();
    for (const c of CA.list()) eq(txt.slice(c.from, c.to), c.quote);
  });

  test('replies made concurrently to one thread both land', () => {
    CA.reply(idA, 'from Ben');
    CB.reply(idA, 'from Alex');
    Y.applyUpdate(B, Y.encodeStateAsUpdate(A));
    Y.applyUpdate(A, Y.encodeStateAsUpdate(B));
    const a = CA.list().find(c => c.id === idA).replies.map(r => r.text);
    const b = CB.list().find(c => c.id === idA).replies.map(r => r.text);
    eq(a.length, 3, 'original + two concurrent replies');
    eq(a, b, 'both sides agree on the order');
  });

  test('one side deleting the text orphans the comment for both', () => {
    const c = CA.list().find(x => x.id === idA);
    A.getText('content').delete(c.from, c.to - c.from);
    Y.applyUpdate(B, Y.encodeStateAsUpdate(A));
    eq(CA.list().find(x => x.id === idA).orphaned, true);
    eq(CB.list().find(x => x.id === idA).orphaned, true);
  });
}

// ------------------------------------------------------------------ ordering
console.log('\nordering');
{
  const { doc, C } = fresh('one two three four five six\n');
  const text = ['one two three four five six', ''].join('\n');
  const at = (w) => [text.indexOf(w), text.indexOf(w) + w.length];
  C.add(...at('three'), 'about three');   // later in the text, added FIRST
  C.add(...at('one'),   'about one');
  test('the panel lists comments in document order, not creation order', () => {
    eq(C.list().map(c => c.quote), ['one', 'three']);
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
