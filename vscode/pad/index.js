// The prompt pad: notes and a queue of prompts for every session, every folder and the top level, in one tab next to
// your sessions. It replaces a scratch markdown file: you write prompts there, send one into its session with a click,
// or let the next one go by itself when Claude finishes (auto-send). Pictures you paste become [Image #n] in the text.
// Files: ./store.js. What to show and when to send: ./model.js (also loaded by the pad page). The tab: ./panel.js.
const vscode = require('vscode');
const { Store, newId } = require('./store');
const M = require('./model');
const { Panel, VIEW_TYPE } = require('./panel');

let store = null;
let panel = null;
let deps = null;
// The app's last list (empty until the first one comes: then nothing counts as gone).
let snap = { sessions: [], folders: [], demo: false, features: [] };
let connected = false;
// Since when a session or folder we knew is missing from the app's list (id → ms).
const missing = { sessions: new Map(), folders: new Map() };
// Sessions whose queue is being worked on (so a snapshot and a file change at the same time can't send twice).
const busy = new Set();
let runTimer = null;
let postTimer = null;
let listeners = [];

function init(context, d) {
  deps = d;
  store = new Store();
  store.load();
  store.cleanImages();
  store.watch();
  store.onChange(() => { postSoon(); runSoon(); for (const fn of listeners) fn(); });
  panel = new Panel(context.extensionUri, store.imagesDir, onMessage);
  const tick = setInterval(() => { runQueues(); if (panel.open) postSoon(); }, 5000);
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, panel.serializer()),
    { dispose: () => { clearInterval(tick); store.close(); } }
  );
}

// The Claude Sessions view redraws when the pad changes (its "· 2 todo" and the prompts under folders).
function onChange(fn) { listeners.push(fn); }

const items = () => [...store.items.values()];
const itemsAt = (place) => items().filter((i) => i.place === place);
const sessionById = (id) => snap.sessions.find((s) => s.id === id);
const sendable = (s) => !!s && (s.origin || 'vscode-terminal') === 'vscode-terminal' && s.shellPid > 0;

// A new list from the app.
function onSessions(m) {
  snap = { sessions: m.sessions || [], folders: m.folders || [], demo: !!m.demo, features: m.features || [] };
  connected = true;
  const now = Date.now();
  if (!snap.demo) {
    const live = { sessions: new Set(snap.sessions.map((s) => s.id)), folders: new Set(snap.folders.map((f) => f.id)) };
    for (const kind of ['sessions', 'folders']) {
      for (const id of Object.keys(store.known[kind] || {})) {
        if (live[kind].has(id)) missing[kind].delete(id);
        else if (!missing[kind].has(id)) missing[kind].set(id, now);
      }
    }
    store.setKnown(prune(M.nextKnown(store.known, snap.sessions, snap.folders), live));
    carryOver();
  }
  postSoon();
  runSoon();
}

function onDisconnect() { connected = false; }

// Names are kept only while the pad needs them: live ones, gone ones that still hold notes or prompts, and the folders
// above those (Deleted shows them one level up).
function prune(known, live) {
  const used = new Set(items().map((i) => i.place));
  const out = { sessions: {}, folders: {} };
  for (const [id, v] of Object.entries(known.sessions)) if (live.sessions.has(id) || used.has('session:' + id)) out.sessions[id] = v;
  const need = new Set([...Object.values(out.sessions).map((v) => v.folder), ...[...used].filter((p) => p.startsWith('folder:')).map((p) => p.slice(7))]);
  for (const [id, v] of Object.entries(known.folders)) if (live.folders.has(id)) need.add(id);
  for (let grew = true; grew;) {
    grew = false;
    for (const id of [...need]) {
      const f = known.folders[id];
      if (f && !out.folders[id]) { out.folders[id] = f; grew = true; if (f.parent) need.add(f.parent); }
    }
  }
  for (const kind of ['sessions', 'folders']) for (const id of [...missing[kind].keys()]) if (!out[kind][id]) missing[kind].delete(id);
  return out;
}

// /clear starts a new session in the same terminal: its notes and prompts move along to the new one.
function carryOver() {
  for (const s of snap.sessions) {
    if (!s.prev || sessionById(s.prev)) continue;
    for (const it of itemsAt('session:' + s.prev)) store.put(it.id, { place: 'session:' + s.id });
  }
}

// Sessions and folders missing from the app's list for a minute count as gone (not in demo mode, not while the app is
// away, not right after a reload: they may just be restarting).
function goneNow() {
  const out = { sessions: {}, folders: {} };
  if (!connected || snap.demo) return out;
  const now = Date.now();
  for (const kind of ['sessions', 'folders']) {
    for (const [id, since] of missing[kind]) if (now - since >= M.GONE_AFTER) out[kind][id] = since;
  }
  return out;
}

function data() {
  return { items: items(), sessions: snap.sessions, folders: snap.folders, known: store.known, places: store.places, gone: goneNow(), now: Date.now() };
}

function postSoon() {
  if (!panel || !panel.open) return;
  clearTimeout(postTimer);
  postTimer = setTimeout(post, 40);
}

function post() {
  if (!panel.open) return;
  const ctx = M.context(data());
  panel.setTitle(titleOf(ctx, panel.level));
  panel.post({ t: 'model', level: panel.level, data: data(), imageBase: panel.imageBase(), features: snap.features });
}

function titleOf(ctx, level) {
  if (!level || level.kind === 'root') return 'Prompt Pad';
  // Not just the name: the session's own terminal tab has that.
  return 'Pad · ' + M.nameOf(ctx, M.placeOf(level.kind, level.id));
}

// Opens the pad on a session ("s:<id>"), a folder ("f:<id>"), a prompt ("p:<id>": its place, scrolled to it) or the
// overview (nothing).
async function open(key, { preserveFocus = false } = {}) {
  let level = { kind: 'root' };
  let focus = null;
  if (key && key.startsWith('s:')) level = { kind: 'session', id: key.slice(2) };
  else if (key && key.startsWith('f:')) level = { kind: 'folder', id: key.slice(2) };
  else if (key && key.startsWith('p:')) {
    const it = store.items.get(key.slice(2));
    if (it) { const p = M.parsePlace(it.place); level = p.kind === 'root' ? { kind: 'root' } : { kind: p.kind, id: p.id }; focus = it.id; }
  }
  const s = level.kind === 'session' ? sessionById(level.id) : null;
  const near = s && s.shellPid > 0 ? await deps.findTerminal(s.shellPid) : null;
  const wasOpen = panel.open;
  panel.show(level, { preserveFocus, near });
  if (wasOpen) post(); // else the page asks once it is ready
  if (focus) setTimeout(() => panel.post({ t: 'focus', id: focus }), wasOpen ? 50 : 600);
}

function onMessage(m) {
  if (!m || !m.t) return;
  switch (m.t) {
    // A new tab shows what it was opened for; one VS Code gave back after a reload shows what it showed before.
    case 'ready':
      post();
      break;
    case 'restored':
      if (m.level) panel.level = m.level;
      post();
      break;
    case 'level':
      panel.level = m.level || { kind: 'root' };
      post();
      break;
    case 'put':
      if (m.id && m.patch) store.put(m.id, m.patch);
      break;
    case 'remove':
      store.remove(m.id);
      break;
    case 'place':
      if (m.key) store.setPlace(m.key, m.patch || {});
      break;
    case 'image': addImage(m.id, m.data); break;
    case 'removeImage': removeImage(m.id, m.index); break;
    case 'openImage':
      if (m.name) vscode.commands.executeCommand('vscode.open', vscode.Uri.file(store.imagePath(m.name)), { preview: true });
      break;
    case 'send': sendNow(m.id); break;
    case 'cancel': cancel(m.id); break;
    case 'markDone':
      if (store.items.get(m.id)) store.put(m.id, { status: 'done', doneAt: Date.now(), sending: null, error: null });
      break;
    case 'assign': assign(m.id); break;
    case 'goto': deps.gotoSession(m.session); break;
    case 'newSession': deps.newSession(m.folder ? 'f:' + m.folder : null); break;
    case 'restore': restore(m.place); break;
    case 'unpack': unpack(m.place, m.to); break;
    case 'archive':
      for (const it of itemsAt(m.place)) store.put(it.id, { archived: true });
      break;
  }
}

// A picture pasted into a note or prompt: saved as a file, added to the item's list ([Image #n] is its place there).
function addImage(id, dataUrl) {
  const it = store.items.get(id);
  const m = /^data:image\/(png|jpe?g|gif|webp);base64,(.+)$/.exec(String(dataUrl || ''));
  if (!it || !m) return;
  const name = store.saveImage(Buffer.from(m[2], 'base64'), m[1] === 'jpeg' ? 'jpg' : m[1]);
  store.put(id, { images: [...(it.images || []), name] });
}

function removeImage(id, index) {
  const it = store.items.get(id);
  if (!it || !it.images || !it.images[index]) return;
  const images = it.images.slice();
  images[index] = null;
  const text = String(it.text || '').split(`[Image #${index + 1}]`).join('');
  store.put(id, { images, text });
}

// Send now: into a session that is free it goes at once; a busy one gets it when its turn is over (first in line).
// A session that is not in a VS Code terminal can't be typed into: the prompt is copied for you to paste.
async function sendNow(id) {
  const it = store.items.get(id);
  if (!it) return;
  const p = M.parsePlace(it.place);
  const s = p.kind === 'session' ? sessionById(p.id) : null;
  if (!s) return;
  if (!M.hasText(it)) { panel.post({ t: 'toast', text: 'Write what Claude should do first.' }); return; }
  if (!sendable(s)) {
    await vscode.env.clipboard.writeText(M.promptText(it, (n) => store.imagePath(n)));
    store.put(id, { status: 'done', doneAt: Date.now(), sentAt: Date.now() });
    panel.post({ t: 'toast', text: `Copied. Paste it into “${s.name}”.` });
    return;
  }
  const todo = M.sections(M.context(data()), it.place).todo.filter((x) => x.id !== id);
  store.put(id, { kind: 'prompt', status: 'queued', order: M.between(null, todo.length ? todo[0].order : null), error: null, draft: null });
  runQueues();
}

function cancel(id) {
  const it = store.items.get(id);
  if (!it) return;
  store.put(id, { sending: null, status: it.status === 'queued' ? 'todo' : it.status });
  // Auto-send waits until you turn it on again (else it would start the countdown right away).
  if (!it.status || it.status === 'todo') store.setPlace(it.place, { autoSend: null });
}

// Assign to…: a backlog or folder prompt goes to a session or folder you pick (to the end of its Todo).
async function assign(id) {
  const it = store.items.get(id);
  if (!it) return;
  const ctx = M.context(data());
  const pathOf = (f) => {
    const names = [];
    for (let x = f, n = 0; x && n < 64; x = (ctx.folderById.get(x) || {}).parent, n++) names.unshift((ctx.folderById.get(x) || {}).name || '');
    return names.join(' / ');
  };
  const picks = [
    ...snap.sessions.map((s) => ({ label: '$(circle-filled) ' + s.name, description: s.folder ? pathOf(s.folder) : '', place: 'session:' + s.id })),
    ...snap.folders.map((f) => ({ label: '$(folder) ' + pathOf(f.id), place: 'folder:' + f.id })),
    { label: '$(home) Overview backlog', place: 'root' }
  ].filter((x) => x.place !== it.place);
  const pick = await vscode.window.showQuickPick(picks, { placeHolder: `Give “${M.title(it) || 'this prompt'}” to…`, matchOnDescription: true });
  if (!pick) return;
  const there = M.sections(ctx, pick.place).todo;
  store.put(id, { place: pick.place, kind: it.kind, status: it.kind === 'prompt' ? 'todo' : it.status, order: M.between(there.length ? there[there.length - 1].order : null, null), draft: null });
}

// Restore in Deleted: a session is resumed in a new tab (its notes and prompts come back with it); a folder is made again
// with its old id, so everything that was in it shows up there again.
async function restore(place) {
  const p = M.parsePlace(place);
  const known = p.kind === 'session' ? store.known.sessions[p.id] : store.known.folders[p.id];
  if (p.kind === 'session') await deps.resumeSession(p.id, known && known.folder);
  else if (p.kind === 'folder' && snap.features.includes('folderId')) deps.send({ kind: 'folder', event: 'create', name: (known && known.name) || 'Folder', folder: known && known.parent, ids: [p.id] });
}

// Unpack here: what a gone session or folder held moves to the level where it is listed (prompts to its Todo, notes to
// its Notes; sent ones go to the Archive).
function unpack(place, to) {
  const ctx = M.context(data());
  const dest = to || M.homeOf(ctx, place);
  let order = (() => { const t = M.sections(ctx, dest).todo; return t.length ? t[t.length - 1].order : 0; })();
  for (const it of itemsAt(place)) {
    if (it.archived) continue;
    if (it.kind === 'prompt' && M.status(it) === 'done') { store.put(it.id, { archived: true }); continue; }
    order += 1;
    store.put(it.id, { place: dest, order, status: it.kind === 'prompt' ? 'todo' : it.status, sending: null, error: null });
  }
}

function runSoon() {
  clearTimeout(runTimer);
  runTimer = setTimeout(runQueues, 150);
}

// Every session's queue, but only for the sessions in this window's terminals (the window that can type into them).
async function runQueues() {
  if (!store) return;
  const now = Date.now();
  for (const s of snap.sessions) {
    if (!sendable(s) || busy.has(s.id)) continue;
    const place = 'session:' + s.id;
    const list = itemsAt(place);
    if (!list.some((i) => i.kind === 'prompt' && !i.archived && ['todo', 'queued', 'doing'].includes(M.status(i)))) continue;
    const act = M.decide(s, list, store.places[place] || {}, now);
    const t = await deps.findTerminal(s.shellPid);
    if (!t) continue;
    // A countdown that no longer applies (you edited the prompt, the session got busy) stops.
    for (const i of list) if (i.sending && !(act && act.id === i.id && act.auto)) store.put(i.id, { sending: null });
    if (!act) continue;
    busy.add(s.id);
    try { await perform(s, t, act, list); } catch (e) { deps.out.error('prompt pad', e); } finally { busy.delete(s.id); }
  }
}

async function perform(s, t, act, list) {
  const now = Date.now();
  const it = store.items.get(act.id);
  if (!it) return;
  if (act.type === 'done') {
    store.put(it.id, { status: 'done', doneAt: now, sending: null, error: null });
    return;
  }
  if (act.type === 'fail') {
    const todo = list.filter((i) => ['todo', 'queued', 'failed'].includes(M.status(i)) && i.id !== it.id).sort(M.byOrder);
    store.put(it.id, { status: 'failed', error: act.error, order: M.between(null, todo.length ? todo[0].order : null) });
    store.setPlace(it.place, { autoSend: null });
    deps.out.info(`prompt pad: “${M.title(it)}” in ${s.name}: ${act.error}`);
    return;
  }
  if (act.type !== 'send') return;
  // Auto-send waits 3 s, shown on the prompt with Cancel: you may be writing in Claude's prompt box.
  if (act.auto) {
    if (!it.sending) { store.put(it.id, { sending: now + 3000 }); setTimeout(runSoon, 3100); return; }
    if (it.sending > now) { setTimeout(runSoon, it.sending - now + 100); return; }
  }
  store.put(it.id, { status: 'doing', sentAt: now, sending: null, error: null, draft: null });
  deps.out.info(`prompt pad: sending “${M.title(it)}” to ${s.name} (shell ${s.shellPid})`);
  await deps.typeLines(t, M.typedLines(M.promptText(it, (n) => store.imagePath(n))));
}

// For the Claude Sessions view.
function waitingIn(place) { return store ? M.waiting(M.context(data()), place) : []; }
function item(id) { return store ? store.items.get(id) : undefined; }
function moveItems(ids, place) {
  const ctx = M.context(data());
  let last = (() => { const t = M.sections(ctx, place).todo; return t.length ? t[t.length - 1].order : 0; })();
  for (const id of ids) {
    const it = store.items.get(id);
    if (it && it.place !== place) store.put(id, { place, order: ++last, status: it.kind === 'prompt' ? 'todo' : it.status, draft: null });
  }
}

module.exports = { init, onSessions, onDisconnect, open, onChange, waitingIn, item, moveItems, newId };
