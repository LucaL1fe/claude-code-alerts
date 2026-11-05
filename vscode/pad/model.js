// What the prompt pad shows and decides, from plain data: the notes and prompts (items), the sessions and folders the
// app sends, and your settings. No vscode and no DOM: the extension, the pad page and the tests all use this one file.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PadModel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // A session is free for the next prompt when its turn is over (an error too: you may send by hand).
  const FREE = ['done', 'idle', 'error', 'free'];
  const URGENCY = { input: 0, review: 1, error: 2, done: 3, mac: 4, free: 5, working: 6, background: 6, idle: 7 };
  const SIGNAL = ['input', 'review', 'error', 'done', 'mac'];
  // A session or folder that left the list counts as gone only after this long (a restart, a reload, /clear).
  const GONE_AFTER = 60000;

  const byOrder = (a, b) => (a.order || 0) - (b.order || 0) || (a.created || 0) - (b.created || 0);
  const byName = (a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: 'base' });
  const byUrgency = (a, b) => (URGENCY[a.state] ?? 9) - (URGENCY[b.state] ?? 9) || (b.touched || 0) - (a.touched || 0) || byName(a, b);
  const byFolderOrder = (a, b) => (a.order || 0) - (b.order || 0) || byName(a, b);

  // An order value between two neighbours (either may be missing: the top or the end of a list).
  function between(above, below) {
    if (above == null && below == null) return 1;
    if (above == null) return below - 1;
    if (below == null) return above + 1;
    return (above + below) / 2;
  }

  const title = (item) => String(item.text || '').split('\n')[0];
  const description = (item) => String(item.text || '').split('\n').slice(1).join('\n').replace(/^\n+/, '');
  const status = (item) => item.status || (item.kind === 'prompt' ? 'todo' : 'open');

  // A new prompt starts with this title, so you can write what Claude should do right away. It names the prompt in
  // the pad only: it is not sent.
  const NEW_TITLE = 'New prompt';

  // The text that goes into the session: [Image #n] becomes the picture's full path (Claude opens it from there), and
  // control characters go (an Esc would act as a key in Claude Code).
  function promptText(item, imagePath) {
    const images = item.images || [];
    const raw = String(item.text || '');
    const tagged = new Set([...raw.matchAll(/\[Image #(\d+)\]/g)].map((m) => +m[1]));
    const text = raw
      .replace(/\[Image #(\d+)\]/g, (m, n) => (images[n - 1] ? imagePath(images[n - 1]) : ''))
      .replace(/\r\n?/g, '\n')
      .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '')
      .replace(/[ \t]+$/gm, '')
      .replace(/^\n+|\s+$/g, '');
    const [first, ...rest] = text.split('\n');
    const out = item.kind === 'prompt' && first.trim() === NEW_TITLE ? rest.join('\n').replace(/^\n+/, '') : text;
    // A picture without its tag in the text (0.7.0 lost the tag when pasting in VS Code) still goes, at the end.
    const loose = images.map((n, i) => (n && !tagged.has(i + 1) ? imagePath(n) : null)).filter(Boolean);
    return loose.length ? (out ? out + '\n\n' : '') + loose.join(' ') : out;
  }
  const hasText = (item) => !!promptText(item, (n) => n).trim();

  // ---------- lists in a description or a note ----------
  // A list item: "- ", "* ", "+ ", "• ", "1. " or "1) " at the start of a line (after its indent), maybe a "[ ] " box.
  // Groups: 1 indent, 2 marker, 3 number, 4 "." or ")", 5 the space after it, 6 the box.
  const LIST = /^([ \t]*)([-*+•]|(\d{1,4})([.)]))([ \t]+)(\[[ xX]\][ \t]+)?/;

  // Where the line around position i starts and ends.
  function lineAt(v, i) {
    const s = v.lastIndexOf('\n', i - 1) + 1;
    const e = v.indexOf('\n', i);
    return [s, e < 0 ? v.length : e];
  }
  const indentOf = (line) => line.match(/^[ \t]*/)[0].length;

  // The number a numbered item at this indent gets when it sits below line `ls`: one more than the item before it on
  // the same level (deeper lines in between are skipped), else 1.
  function nextNumber(v, ls, indent) {
    let s = ls;
    while (s > 0) {
      const [ps] = lineAt(v, s - 1);
      const l = v.slice(ps, s - 1);
      s = ps;
      if (!l.trim()) break;
      const li = indentOf(l);
      if (li > indent) continue;
      const m = l.match(LIST);
      return li === indent && m && m[3] ? +m[3] + 1 : 1;
    }
    return 1;
  }

  // The numbers of the items right below line end `le` on this level, counted on from n (stops at a blank line, a
  // line that is not an item, or a level further out).
  function renumber(v, le, indent, delim, n) {
    let pos = le;
    let out = '';
    while (pos < v.length) {
      const [s, e] = lineAt(v, pos + 1);
      const l = v.slice(s, e);
      if (!l.trim()) break;
      const li = indentOf(l);
      const m = l.match(LIST);
      if (li > indent) { out += '\n' + l; pos = e; continue; }
      if (li < indent || !m || !m[3] || m[4] !== delim) break;
      out += '\n' + m[1] + n + l.slice(m[1].length + m[3].length);
      n += 1;
      pos = e;
    }
    return { out, end: pos };
  }

  // Enter in a list, as in a notes app: the new line starts with the next bullet or number (and the numbers below move
  // on by one). Enter on an empty item moves it out a level, or ends the list. Null: a plain Enter.
  function listEnter(v, start, end) {
    if (start !== end) return null;
    const [ls, le] = lineAt(v, start);
    const line = v.slice(ls, le);
    const m = line.match(LIST);
    if (!m || start < ls + m[0].length) return null;
    if (!line.slice(m[0].length).trim() && start === le) {
      if (m[1].length) return listTab(v, start, end, true);
      return { value: v.slice(0, ls) + v.slice(le), start: ls, end: ls };
    }
    const marker = m[3] ? `${+m[3] + 1}${m[4]}` : m[2];
    const insert = '\n' + m[1] + marker + m[5] + (m[6] ? '[ ] ' : '');
    const after = m[3] ? renumber(v, le, m[1].length, m[4], +m[3] + 2) : { out: '', end: le };
    const value = v.slice(0, start) + insert + v.slice(start, le) + after.out + v.slice(after.end);
    return { value, start: start + insert.length, end: start + insert.length };
  }

  // Tab and Shift+Tab on list lines: in or out one level (in: by the width of the item above's marker, else 2 spaces;
  // out: to the level above). A numbered item takes the number that follows on its new level. Null: not a list line.
  function listTab(v, start, end, back) {
    const [ls] = lineAt(v, start);
    const [, le] = lineAt(v, end > start && v[end - 1] === '\n' ? end - 1 : end);
    const lines = v.slice(ls, le).split('\n');
    const m = lines[0].match(LIST);
    if (!m) return null;
    const indent = m[1].length;
    let to;
    if (back) {
      to = 0;
      let s = ls;
      while (s > 0) {
        const [ps] = lineAt(v, s - 1);
        const l = v.slice(ps, s - 1);
        s = ps;
        if (l.trim() && LIST.test(l) && indentOf(l) < indent) { to = indentOf(l); break; }
      }
      if (to === indent) return { value: v, start, end };
    } else {
      const [ps] = ls > 0 ? lineAt(v, ls - 1) : [0];
      const above = ls > 0 ? v.slice(ps, ls - 1).match(LIST) : null;
      const ai = above ? above[1].length : -1;
      to = ai > indent ? ai : ai === indent ? indent + above[2].length + above[5].length : indent + 2;
    }
    const shift = to - indent;
    const moved = lines.map((l, i) => {
      if (!l.trim()) return l;
      const li = indentOf(l);
      const next = ' '.repeat(Math.max(0, li + shift)) + l.slice(li);
      if (i > 0 || !m[3]) return next;
      const mm = next.match(LIST);
      return mm[1] + nextNumber(v, ls, mm[1].length) + next.slice(mm[1].length + mm[3].length);
    });
    const text = moved.join('\n');
    const value = v.slice(0, ls) + text + v.slice(le);
    const first = moved[0].length - lines[0].length;
    const all = text.length - (le - ls);
    // Selected whole lines stay selected; a caret moves with its text.
    const keepStart = end > start && start === ls;
    return { value, start: keepStart ? ls : Math.max(ls, start + first), end: Math.max(ls, end + (end > start ? all : first)) };
  }

  // Lines as they are typed into Claude Code: each line on its own, joined by Claude Code's newline (a backslash, then
  // Enter). A line ending in a backslash would join with the next one by itself, so it gets a space.
  function typedLines(text) {
    return text.split('\n').map((l) => (l.endsWith('\\') ? l + ' ' : l));
  }

  // The data every view is built from. "gone" lists sessions and folders that left the app's list a while ago.
  function context(data) {
    const sessions = data.sessions || [];
    const folders = data.folders || [];
    const ctx = {
      items: data.items || [],
      sessions,
      folders,
      known: data.known || { sessions: {}, folders: {} },
      places: data.places || {},
      gone: data.gone || { sessions: {}, folders: {} },
      sessionById: new Map(sessions.map((s) => [s.id, s])),
      folderById: new Map(folders.map((f) => [f.id, f])),
      now: data.now || Date.now()
    };
    ctx.byPlace = new Map();
    for (const it of ctx.items) {
      if (!ctx.byPlace.has(it.place)) ctx.byPlace.set(it.place, []);
      ctx.byPlace.get(it.place).push(it);
    }
    return ctx;
  }

  const placeOf = (kind, id) => (kind === 'root' || !id ? 'root' : `${kind}:${id}`);
  function parsePlace(place) {
    const i = String(place).indexOf(':');
    return i < 0 ? { kind: 'root', id: null } : { kind: place.slice(0, i), id: place.slice(i + 1) };
  }

  // A live session's folder (null: the top level, also when its folder is gone).
  function folderOfSession(ctx, s) { return s && s.folder && ctx.folderById.has(s.folder) ? s.folder : null; }
  function parentOfFolder(ctx, f) { return f && f.parent && ctx.folderById.has(f.parent) ? f.parent : null; }

  // The names and folders to remember, from the app's current list (sessions and folders that left keep theirs).
  function nextKnown(known, sessions, folders) {
    const out = { sessions: { ...((known && known.sessions) || {}) }, folders: { ...((known && known.folders) || {}) } };
    for (const s of sessions) out.sessions[s.id] = { name: s.name, folder: s.folder || null };
    for (const f of folders) out.folders[f.id] = { name: f.name, parent: f.parent || null };
    return out;
  }

  const isGone = (ctx, kind, id) => {
    if (kind === 'session') return !ctx.sessionById.has(id) && !!ctx.gone.sessions[id];
    if (kind === 'folder') return !ctx.folderById.has(id) && !!ctx.gone.folders[id];
    return false;
  };
  const exists = (ctx, kind, id) => kind === 'root' || (kind === 'session' ? ctx.sessionById.has(id) : ctx.folderById.has(id));

  // Where a place that is gone shows its items: in Deleted one level up, i.e. the first live folder above it (or the top).
  function homeOf(ctx, place) {
    let { kind, id } = parsePlace(place);
    let f = kind === 'session' ? (ctx.known.sessions[id] || {}).folder : kind === 'folder' ? (ctx.known.folders[id] || {}).parent : null;
    for (let n = 0; f && n < 64; n++) {
      if (ctx.folderById.has(f)) return 'folder:' + f;
      f = (ctx.known.folders[f] || {}).parent;
    }
    return 'root';
  }

  function nameOf(ctx, place) {
    const { kind, id } = parsePlace(place);
    if (kind === 'root') return 'All sessions';
    if (kind === 'session') return (ctx.sessionById.get(id) || ctx.known.sessions[id] || { name: 'session' }).name;
    return (ctx.folderById.get(id) || ctx.known.folders[id] || { name: 'folder' }).name;
  }

  // The four lists of one place.
  function sections(ctx, place) {
    const all = ctx.byPlace.get(place) || [];
    const live = all.filter((i) => !i.archived);
    const prompts = live.filter((i) => i.kind === 'prompt');
    return {
      notes: live.filter((i) => i.kind === 'note').sort(byOrder),
      archivedNotes: all.filter((i) => i.kind === 'note' && i.archived).sort(byOrder),
      todo: prompts.filter((i) => ['todo', 'queued', 'failed'].includes(status(i))).sort(byOrder),
      doing: prompts.filter((i) => status(i) === 'doing').sort(byOrder),
      done: prompts.filter((i) => status(i) === 'done').sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0) || byOrder(a, b))
    };
  }

  function sessionView(ctx, id) {
    const s = ctx.sessionById.get(id) || { id, name: nameOf(ctx, 'session:' + id), state: 'idle', gone: true };
    const place = 'session:' + id;
    const folder = folderOfSession(ctx, s);
    const path = [];
    for (let f = folder, n = 0; f && n < 64; f = parentOfFolder(ctx, ctx.folderById.get(f)), n++) path.unshift({ id: f, name: ctx.folderById.get(f).name });
    return { kind: 'session', id, place, session: s, path, settings: ctx.places[place] || {}, ...sections(ctx, place) };
  }

  // A folder in a list: its name, what waits in it (its own prompts and its sessions', with subfolders), its most urgent state.
  function folderSummary(ctx, id) {
    const f = ctx.folderById.get(id);
    const inside = new Set([id]);
    for (let grew = true; grew;) {
      grew = false;
      for (const x of ctx.folders) if (x.parent && inside.has(x.parent) && !inside.has(x.id)) { inside.add(x.id); grew = true; }
    }
    const sessions = ctx.sessions.filter((s) => inside.has(folderOfSession(ctx, s)));
    let todo = 0;
    let notes = 0;
    for (const p of [...[...inside].map((x) => 'folder:' + x), ...sessions.map((s) => 'session:' + s.id)]) {
      const sec = sections(ctx, p);
      todo += sec.todo.length;
      notes += sec.notes.length;
    }
    let signal = null;
    for (const s of sessions) if (SIGNAL.includes(s.state) && (!signal || URGENCY[s.state] < URGENCY[signal])) signal = s.state;
    return {
      id, name: f ? f.name : nameOf(ctx, 'folder:' + id), sessions: sessions.length, todo, notes, signal,
      working: sessions.filter((s) => s.state === 'working' || s.state === 'background').length
    };
  }

  // What waits in a session (for its row in a folder or the overview).
  function sessionSummary(ctx, s) {
    const sec = sections(ctx, 'session:' + s.id);
    return { id: s.id, name: s.name, state: s.state, updated: s.updated, origin: s.origin, todo: sec.todo.length, notes: sec.notes.length, doing: sec.doing.length };
  }

  // Deleted, on one level: the sessions and folders that were here (or below, if that is gone too) and are gone, each with
  // what they held. Their files stay until you unpack or archive them.
  function deleted(ctx, place) {
    const groups = [];
    for (const [p, list] of ctx.byPlace) {
      const { kind, id } = parsePlace(p);
      if (kind === 'root' || exists(ctx, kind, id) || !isGone(ctx, kind, id)) continue;
      if (homeOf(ctx, p) !== place) continue;
      const items = list.filter((i) => !i.archived).sort(byOrder);
      if (!items.length) continue;
      groups.push({ place: p, kind, id, name: nameOf(ctx, p), since: ctx.gone[kind === 'session' ? 'sessions' : 'folders'][id], items });
    }
    return groups.sort((a, b) => (b.since || 0) - (a.since || 0));
  }

  function folderView(ctx, id) {
    const f = ctx.folderById.get(id) || { id, name: nameOf(ctx, 'folder:' + id) };
    const place = 'folder:' + id;
    const path = [];
    for (let p = parentOfFolder(ctx, f), n = 0; p && n < 64; p = parentOfFolder(ctx, ctx.folderById.get(p)), n++) path.unshift({ id: p, name: ctx.folderById.get(p).name });
    return {
      kind: 'folder', id, place, folder: f, path, settings: ctx.places[place] || {}, ...sections(ctx, place),
      sessions: ctx.sessions.filter((s) => folderOfSession(ctx, s) === id).sort(byUrgency).map((s) => sessionSummary(ctx, s)),
      folders: ctx.folders.filter((x) => parentOfFolder(ctx, x) === id).sort(byFolderOrder).map((x) => folderSummary(ctx, x.id)),
      deleted: deleted(ctx, place)
    };
  }

  function rootView(ctx) {
    const sec = sections(ctx, 'root');
    const archive = ctx.items.filter((i) => i.archived).sort((a, b) => (b.doneAt || b.created || 0) - (a.doneAt || a.created || 0));
    const count = (st) => ctx.sessions.filter((s) => (Array.isArray(st) ? st.includes(s.state) : s.state === st)).length;
    return {
      kind: 'root', id: null, place: 'root', settings: ctx.places.root || {},
      notes: sec.notes, archivedNotes: sec.archivedNotes, backlog: sec.todo,
      sessions: ctx.sessions.filter((s) => !folderOfSession(ctx, s)).sort(byUrgency).map((s) => sessionSummary(ctx, s)),
      folders: ctx.folders.filter((f) => !parentOfFolder(ctx, f)).sort(byFolderOrder).map((f) => folderSummary(ctx, f.id)),
      deleted: deleted(ctx, 'root'),
      archive: archive.map((i) => ({ ...i, where: nameOf(ctx, i.place) })),
      totals: {
        folders: ctx.folders.length, sessions: ctx.sessions.length,
        working: count(['working', 'background']), input: count(['input', 'review']), done: count('done')
      }
    };
  }

  function view(ctx, level) {
    if (level && level.kind === 'session' && level.id) return sessionView(ctx, level.id);
    if (level && level.kind === 'folder' && level.id && (ctx.folderById.has(level.id) || ctx.known.folders[level.id])) return folderView(ctx, level.id);
    return rootView(ctx);
  }

  // The next thing to do for one session's queue, or null. Decided from times, not from state changes (a quick
  // done → idle can be missed; a reload forgets what came before):
  //   the prompt arrived   = the session's last prompt (touched) is not older than when we typed it (sentAt)
  //   its turn is over     = the last turn ended (ended) after sentAt; outcome done / error / limit
  // Without "ended" (an older app): free again after it arrived.
  function decide(s, items, settings, now) {
    if (!s) return null;
    const prompts = items.filter((i) => i.kind === 'prompt' && !i.archived);
    const doing = prompts.find((i) => status(i) === 'doing');
    if (doing) {
      const sent = doing.sentAt || 0;
      const arrived = (s.touched || 0) * 1000 >= sent - 1500;
      if (!arrived) return now - sent > 25000 ? { type: 'fail', id: doing.id, error: "didn't reach Claude" } : null;
      if (s.ended != null) {
        if (s.ended * 1000 < sent - 1500) return null;
        if (s.outcome === 'limit') return null;
        return s.outcome === 'error' ? { type: 'fail', id: doing.id, error: 'the turn ended with an error' } : { type: 'done', id: doing.id };
      }
      if (FREE.includes(s.state) && (s.updated || 0) * 1000 > sent + 1000) {
        return s.state === 'error' ? { type: 'fail', id: doing.id, error: 'the turn ended with an error' } : { type: 'done', id: doing.id };
      }
      return null;
    }
    if (!FREE.includes(s.state)) return null;
    const waiting = prompts.filter((i) => !i.draft && hasText(i)).sort(byOrder);
    const queued = waiting.find((i) => status(i) === 'queued');
    if (queued) return { type: 'send', id: queued.id };
    if (!settings || !settings.autoSend || s.state === 'error') return null;
    const stop = typeof settings.stopOrder === 'number' ? settings.stopOrder : Infinity;
    const next = waiting.find((i) => status(i) === 'todo' && (i.order || 0) < stop);
    return next ? { type: 'send', id: next.id, auto: true } : null;
  }

  // Prompts waiting in a place (for the Claude Sessions view).
  function waiting(ctx, place) { return sections(ctx, place).todo; }

  return {
    FREE, SIGNAL, URGENCY, GONE_AFTER, NEW_TITLE, LIST, between, byOrder, title, description, status, promptText, hasText,
    listEnter, listTab, typedLines, context,
    placeOf, parsePlace, nextKnown, homeOf, nameOf, sections, sessionView, folderView, rootView, folderSummary,
    sessionSummary, deleted, view, decide, waiting, isGone
  };
});
