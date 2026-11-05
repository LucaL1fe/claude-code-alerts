// The prompt pad's files, in ~/.claude-code-alerts/pad: one small file per note or prompt, so two VS Code windows never
// write over each other, and you (or Claude) can read every one of them as plain text.
//   items/<id>.md      a note or a prompt: "key: <JSON>" lines, a blank line, then its text (a prompt's text is what
//                      gets sent: the title, a blank line, the description)
//   images/<name>      pictures you pasted
//   places.json        your settings per session or folder (auto-send, where it stops, list or board)
//   known.json         names and folders of sessions and folders, kept after they are gone (for Deleted)
//   tmp/               files being written (renamed into place, so nobody reads half a file)
// No vscode here: the tests run it with plain node.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const FIELDS = ['kind', 'place', 'status', 'archived', 'draft', 'order', 'created', 'sentAt', 'doneAt', 'sending', 'error', 'images', 'from'];

const newId = () => Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
const validId = (id) => typeof id === 'string' && /^[\w-]{1,64}$/.test(id);

function parse(id, raw) {
  const item = { id, text: '' };
  const lines = raw.split('\n');
  let i = 0;
  for (; i < lines.length && lines[i] !== ''; i++) {
    const m = lines[i].match(/^(\w+): (.*)$/);
    if (!m) continue;
    try { item[m[1]] = JSON.parse(m[2]); } catch { /* a line someone edited by hand */ }
  }
  item.text = lines.slice(i + 1).join('\n');
  if (item.kind !== 'note' && item.kind !== 'prompt') item.kind = 'note';
  if (typeof item.place !== 'string') item.place = 'root';
  if (typeof item.order !== 'number') item.order = 0;
  return item;
}

function serialize(item) {
  const head = FIELDS.filter((k) => item[k] !== undefined && item[k] !== null && item[k] !== false)
    .map((k) => `${k}: ${JSON.stringify(item[k])}`);
  return head.join('\n') + '\n\n' + (item.text || '');
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

class Store {
  constructor(dir) {
    this.dir = dir || process.env.CCA_PAD_DIR || path.join(os.homedir(), '.claude-code-alerts/pad');
    this.itemsDir = path.join(this.dir, 'items');
    this.imagesDir = path.join(this.dir, 'images');
    this.tmpDir = path.join(this.dir, 'tmp');
    this.items = new Map();
    // What we last read or wrote per file (mtime + text), so only changed files are read again.
    this.seen = new Map();
    this.places = {};
    this.known = { sessions: {}, folders: {} };
    this.listeners = [];
    this.watchers = [];
    this.timer = null;
  }

  ensure() {
    for (const d of [this.itemsDir, this.imagesDir, this.tmpDir]) fs.mkdirSync(d, { recursive: true });
  }

  // Reads what changed on disk since the last look. Returns true when anything did.
  load() {
    this.ensure();
    let changed = false;
    let names = [];
    try { names = fs.readdirSync(this.itemsDir).filter((f) => f.endsWith('.md')); } catch { names = []; }
    const present = new Set();
    for (const name of names) {
      const id = name.slice(0, -3);
      if (!validId(id)) continue;
      present.add(id);
      const file = path.join(this.itemsDir, name);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      const was = this.seen.get(id);
      if (was && was.mtime === st.mtimeMs && was.size === st.size) continue;
      let raw;
      try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
      this.seen.set(id, { mtime: st.mtimeMs, size: st.size, raw });
      if (was && was.raw === raw) continue;
      this.items.set(id, parse(id, raw));
      changed = true;
    }
    for (const id of [...this.items.keys()]) {
      if (!present.has(id)) { this.items.delete(id); this.seen.delete(id); changed = true; }
    }
    const places = readJson(path.join(this.dir, 'places.json'), {});
    if (JSON.stringify(places) !== JSON.stringify(this.places)) { this.places = places; changed = true; }
    const known = readJson(path.join(this.dir, 'known.json'), null);
    if (known && JSON.stringify(known) !== JSON.stringify(this.known)) { this.known = { sessions: {}, folders: {}, ...known }; changed = true; }
    return changed;
  }

  write(file, text) {
    this.ensure();
    const tmp = path.join(this.tmpDir, path.basename(file) + '.' + crypto.randomBytes(4).toString('hex'));
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  }

  // Saves a note or prompt (new or changed). Only the fields given change; the rest stays as it is on disk.
  put(id, patch) {
    if (!validId(id)) return null;
    this.load();
    const cur = this.items.get(id);
    const item = { ...(cur || { id, kind: 'note', place: 'root', order: 0, created: Date.now(), text: '' }), ...patch, id };
    for (const k of Object.keys(item)) if (item[k] === undefined) delete item[k];
    const raw = serialize(item);
    const file = path.join(this.itemsDir, id + '.md');
    if (cur && this.seen.get(id) && this.seen.get(id).raw === raw) return cur;
    this.write(file, raw);
    let st = null;
    try { st = fs.statSync(file); } catch { /* gone again */ }
    this.seen.set(id, { mtime: st ? st.mtimeMs : 0, size: st ? st.size : 0, raw });
    const saved = parse(id, raw);
    this.items.set(id, saved);
    this.emit();
    return saved;
  }

  remove(id) {
    if (!validId(id)) return;
    try { fs.unlinkSync(path.join(this.itemsDir, id + '.md')); } catch { /* already gone */ }
    if (this.items.delete(id)) this.emit();
    this.seen.delete(id);
  }

  // Your settings for one place ("session:<id>", "folder:<id>", "root").
  setPlace(key, patch) {
    this.load();
    const cur = this.places[key] || {};
    const next = { ...cur, ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === null) delete next[k];
    if (JSON.stringify(next) === JSON.stringify(cur)) return;
    this.places = { ...this.places, [key]: next };
    if (!Object.keys(next).length) delete this.places[key];
    this.write(path.join(this.dir, 'places.json'), JSON.stringify(this.places, null, 1));
    this.emit();
  }

  // Every window computes the same names, so writing only on a real change keeps the file quiet.
  setKnown(known) {
    if (JSON.stringify(known) === JSON.stringify(this.known)) return false;
    this.known = known;
    this.write(path.join(this.dir, 'known.json'), JSON.stringify(known));
    return true;
  }

  // A pasted picture: saved under a new name, which goes in the item's "images" list.
  saveImage(buffer, ext) {
    this.ensure();
    const name = newId() + '.' + (/^(png|jpe?g|gif|webp)$/.test(ext) ? ext : 'png');
    this.write(path.join(this.imagesDir, name), buffer);
    return name;
  }

  imagePath(name) { return path.join(this.imagesDir, path.basename(name)); }

  // Pictures no note or prompt uses any more (a copied Done prompt shares its pictures, so only unused ones go).
  cleanImages() {
    const used = new Set();
    for (const it of this.items.values()) for (const n of it.images || []) if (n) used.add(n);
    let names = [];
    try { names = fs.readdirSync(this.imagesDir); } catch { return; }
    const day = Date.now() - 86400000;
    for (const n of names) {
      if (used.has(n)) continue;
      const file = path.join(this.imagesDir, n);
      // A picture pasted a moment ago may belong to an item that is still being written.
      try { if (fs.statSync(file).mtimeMs < day) fs.unlinkSync(file); } catch { /* gone */ }
    }
    try { for (const n of fs.readdirSync(this.tmpDir)) fs.unlinkSync(path.join(this.tmpDir, n)); } catch { /* none */ }
  }

  onChange(fn) { this.listeners.push(fn); }
  emit() { for (const fn of this.listeners) fn(); }

  // Changes made by another window (or by hand) come in through the file system.
  watch() {
    this.ensure();
    const poke = () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => { if (this.load()) this.emit(); }, 60);
    };
    for (const d of [this.itemsDir, this.dir]) {
      try { this.watchers.push(fs.watch(d, poke)); } catch { /* polled below */ }
    }
    // fs.watch can miss events (sleep, a busy disk): look again now and then.
    const poll = setInterval(poke, 15000);
    this.watchers.push({ close: () => clearInterval(poll) });
  }

  close() {
    for (const w of this.watchers) try { w.close(); } catch { /* closed */ }
    this.watchers = [];
    clearTimeout(this.timer);
  }
}

module.exports = { Store, newId, parse, serialize };
