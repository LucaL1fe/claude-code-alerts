// Tests for the prompt pad's files and rules, with plain node: node vscode/pad/test/pad.test.js
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store, parse, serialize } = require('../store');
const M = require('../model');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e.stack || e).split('\n').slice(0, 3).join('\n     ')); }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cca-pad-test-'));

test('an item file round-trips', () => {
  const item = { id: 'a1', kind: 'prompt', place: 'session:s1', status: 'todo', order: 2.5, created: 1, images: ['x.png'], text: 'Title\n\nLine one\nLine two' };
  const back = parse('a1', serialize(item));
  assert.deepEqual(back, item);
});

test('a hand-edited header line is skipped, the text stays', () => {
  const back = parse('b', 'kind: "note"\norder: oops\n\nhello\n\nworld');
  assert.equal(back.kind, 'note');
  assert.equal(back.order, 0);
  assert.equal(back.text, 'hello\n\nworld');
});

test('put keeps fields it was not given and another store sees the change', () => {
  const dir = tmp();
  const a = new Store(dir);
  const b = new Store(dir);
  a.put('n1', { kind: 'note', place: 'root', order: 1, text: 'first' });
  a.put('n1', { text: 'second' });
  assert.equal(a.items.get('n1').order, 1);
  assert.equal(b.load(), true);
  assert.equal(b.items.get('n1').text, 'second');
  assert.equal(b.load(), false, 'nothing changed the second time');
  b.remove('n1');
  assert.equal(a.load(), true);
  assert.equal(a.items.has('n1'), false);
});

test('places and known are written only when they change', () => {
  const dir = tmp();
  const s = new Store(dir);
  s.setPlace('session:x', { autoSend: true });
  s.setPlace('session:x', { stopOrder: 3 });
  assert.deepEqual(s.places['session:x'], { autoSend: true, stopOrder: 3 });
  s.setPlace('session:x', { autoSend: null, stopOrder: null });
  assert.equal(s.places['session:x'], undefined);
  assert.equal(s.setKnown({ sessions: { a: { name: 'A' } }, folders: {} }), true);
  assert.equal(s.setKnown({ sessions: { a: { name: 'A' } }, folders: {} }), false);
});

test('unused old pictures go, used ones stay', () => {
  const dir = tmp();
  const s = new Store(dir);
  const used = s.saveImage(Buffer.from('png'), 'png');
  const unused = s.saveImage(Buffer.from('png'), 'png');
  s.put('p', { kind: 'prompt', images: [used], text: 'x [Image #1]' });
  const old = (Date.now() - 2 * 86400000) / 1000;
  fs.utimesSync(s.imagePath(used), old, old);
  fs.utimesSync(s.imagePath(unused), old, old);
  s.cleanImages();
  assert.equal(fs.existsSync(s.imagePath(used)), true);
  assert.equal(fs.existsSync(s.imagePath(unused)), false);
});

test('order between neighbours', () => {
  assert.equal(M.between(null, null), 1);
  assert.equal(M.between(null, 5), 4);
  assert.equal(M.between(5, null), 6);
  assert.equal(M.between(1, 2), 1.5);
});

test('prompt text: pictures become paths, control characters go', () => {
  const item = { text: 'Fix it [Image #1]\x1b[201~\r\n\nsee [Image #2] and [Image #3]  ', images: ['a.png', 'b.png'] };
  assert.equal(M.promptText(item, (n) => '/pad/images/' + n), 'Fix it /pad/images/a.png[201~\n\nsee /pad/images/b.png and');
  assert.deepEqual(M.typedLines('a\\\nb'), ['a\\ ', 'b']);
});

const S = (id, state, extra) => ({ id, name: id, state, folder: null, shellPid: 1, touched: 0, updated: 0, origin: 'vscode-terminal', ...extra });
const P = (id, extra) => ({ id, kind: 'prompt', place: 'session:s', status: 'todo', order: 1, text: 'Do ' + id, ...extra });

test('decide: nothing while working, the queued prompt first once free', () => {
  const items = [P('a', { order: 1 }), P('b', { order: 2, status: 'queued' })];
  assert.equal(M.decide(S('s', 'working'), items, { autoSend: true }, 0), null);
  assert.deepEqual(M.decide(S('s', 'idle'), items, {}, 0), { type: 'send', id: 'b' });
});

test('decide: auto-send respects the stop line, drafts and empty prompts', () => {
  const items = [P('d', { order: 0, draft: true }), P('e', { order: 0.5, text: '' }), P('a', { order: 1 }), P('b', { order: 3 })];
  assert.deepEqual(M.decide(S('s', 'done'), items, { autoSend: true }, 0), { type: 'send', id: 'a', auto: true });
  assert.equal(M.decide(S('s', 'done'), items, { autoSend: true, stopOrder: 0.9 }, 0), null);
  assert.equal(M.decide(S('s', 'done'), items, { autoSend: false }, 0), null);
  assert.equal(M.decide(S('s', 'error'), items, { autoSend: true }, 0), null, 'no auto-send after an error');
});

test('decide: a prompt that never arrives fails after a while', () => {
  const items = [P('a', { status: 'doing', sentAt: 100000 })];
  const s = S('s', 'idle', { touched: 50 });
  assert.equal(M.decide(s, items, {}, 110000), null);
  assert.deepEqual(M.decide(s, items, {}, 130000), { type: 'fail', id: 'a', error: "didn't reach Claude" });
});

test('decide: done, error and usage limit from ended/outcome', () => {
  const items = [P('a', { status: 'doing', sentAt: 100000 })];
  const arrived = { touched: 101 };
  assert.equal(M.decide(S('s', 'working', arrived), items, {}, 0), null);
  assert.deepEqual(M.decide(S('s', 'idle', { ...arrived, ended: 140, outcome: 'done' }), items, {}, 0), { type: 'done', id: 'a' });
  // The error was merged into idle by the time we looked: ended/outcome still tell.
  assert.equal(M.decide(S('s', 'idle', { ...arrived, ended: 140, outcome: 'error' }), items, {}, 0).type, 'fail');
  assert.equal(M.decide(S('s', 'background', { ...arrived, ended: 140, outcome: 'limit' }), items, {}, 0), null);
  // An ended from the turn before ours does not count.
  assert.equal(M.decide(S('s', 'idle', { ...arrived, ended: 90, outcome: 'done' }), items, {}, 0), null);
});

test('decide: an older app without ended: free again after it arrived', () => {
  const items = [P('a', { status: 'doing', sentAt: 100000 })];
  assert.deepEqual(M.decide(S('s', 'done', { touched: 101, updated: 150 }), items, {}, 0), { type: 'done', id: 'a' });
  assert.equal(M.decide(S('s', 'done', { touched: 101, updated: 100.5 }), items, {}, 0), null);
});

test('views: sections, gone sessions in Deleted one level up, folders and the overview', () => {
  const items = [
    { id: 'n1', kind: 'note', place: 'root', order: 1, text: 'general' },
    { id: 'b1', kind: 'prompt', place: 'root', status: 'todo', order: 1, text: 'backlog' },
    { id: 'f1', kind: 'prompt', place: 'folder:F', status: 'todo', order: 1, text: 'folder todo' },
    { id: 's1', kind: 'prompt', place: 'session:A', status: 'todo', order: 2, text: 'second' },
    { id: 's0', kind: 'prompt', place: 'session:A', status: 'queued', order: 1, text: 'first' },
    { id: 'sd', kind: 'prompt', place: 'session:A', status: 'done', order: 3, doneAt: 5, text: 'sent' },
    { id: 'g1', kind: 'prompt', place: 'session:GONE', status: 'todo', order: 1, text: 'left behind' },
    { id: 'x1', kind: 'note', place: 'folder:OLD', order: 1, text: 'old folder note' },
    { id: 'ar', kind: 'note', place: 'session:A', archived: true, order: 1, text: 'archived' }
  ];
  const ctx = M.context({
    items,
    sessions: [S('A', 'working', { folder: 'F' }), S('B', 'idle')],
    folders: [{ id: 'F', name: 'Folder', parent: null, order: 0 }],
    known: { sessions: { GONE: { name: 'gone session', folder: 'F' } }, folders: { OLD: { name: 'Launch prep', parent: null } } },
    gone: { sessions: { GONE: 1 }, folders: { OLD: 2 } }
  });
  const a = M.view(ctx, { kind: 'session', id: 'A' });
  assert.deepEqual(a.todo.map((i) => i.id), ['s0', 's1']);
  assert.deepEqual(a.done.map((i) => i.id), ['sd']);
  assert.deepEqual(a.archivedNotes.map((i) => i.id), ['ar']);
  assert.deepEqual(a.path, [{ id: 'F', name: 'Folder' }]);
  const f = M.view(ctx, { kind: 'folder', id: 'F' });
  assert.deepEqual(f.todo.map((i) => i.id), ['f1']);
  assert.deepEqual(f.sessions.map((s) => [s.id, s.todo]), [['A', 2]]);
  assert.deepEqual(f.deleted.map((g) => [g.name, g.items.map((i) => i.id)]), [['gone session', ['g1']]]);
  const r = M.view(ctx, null);
  assert.deepEqual(r.backlog.map((i) => i.id), ['b1']);
  assert.deepEqual(r.sessions.map((s) => s.id), ['B']);
  assert.deepEqual(r.folders.map((x) => [x.name, x.todo, x.sessions, x.working]), [['Folder', 3, 1, 1]]);
  assert.deepEqual(r.deleted.map((g) => g.name), ['Launch prep']);
  assert.deepEqual(r.archive.map((i) => i.id), ['ar']);
});

test('a session that just left the list is not gone yet', () => {
  const items = [{ id: 'g', kind: 'prompt', place: 'session:Q', status: 'todo', order: 1, text: 'x' }];
  const ctx = M.context({ items, sessions: [], folders: [], known: { sessions: { Q: { name: 'q' } }, folders: {} }, gone: { sessions: {}, folders: {} } });
  assert.equal(M.view(ctx, null).deleted.length, 0);
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
