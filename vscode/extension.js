// Claude Code Alerts for VS Code.
// Tells the Mac app which terminals this window has (by shell PID), focuses or renames a terminal when the app asks,
// and shows every Claude session in a "Claude Sessions" view (with your own folders, like the Explorer) and the status bar.
const vscode = require('vscode');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const SOCK = path.join(os.homedir(), 'Library/Application Support/claude-code-alerts/alerts.sock');
const CCA = path.join(os.homedir(), '.claude-code-alerts/bin/cca');
const windowId = crypto.randomUUID();

// Our own colors (package.json "colors"), the same as the dots: theme chart colors can be dull (a dark brown orange).
const COLOR = {
  working: 'claudeCodeAlerts.working', background: 'claudeCodeAlerts.working', input: 'claudeCodeAlerts.needsYou',
  review: 'claudeCodeAlerts.plan', done: 'claudeCodeAlerts.done', error: 'claudeCodeAlerts.error', idle: 'disabledForeground',
  mac: 'claudeCodeAlerts.error', free: 'claudeCodeAlerts.done'
};
const LABEL = {
  working: 'working', background: 'in background', input: 'needs you', review: 'plan ready', done: 'done', error: 'error',
  idle: 'idle', mac: 'using your Mac', free: 'Mac is free'
};
const URGENCY = { input: 0, review: 1, error: 2, done: 3, mac: 4, free: 5, working: 6, background: 6, idle: 7 };
// States that color a session's name and every folder above it, like changed files in the Explorer.
const SIGNAL = ['input', 'review', 'error', 'done', 'mac'];
const MIME = 'application/vnd.claude-code-alerts.items';
// Set inside a Claude session; a claude started with them thinks it is nested.
const NESTED = ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT'];

let sock = null;
let extUri = null;
let buffer = '';
let retry = null;
let sessions = [];
let folders = [];
let sessionById = new Map();
let folderById = new Map();
// Most urgent signal inside each folder (folder id → state), and how many sessions it holds (with subfolders).
let folderSignal = new Map();
let folderCount = new Map();
let status;
let treeView;
let reportTimer = null;

function send(obj) {
  if (sock && !sock.destroyed) sock.write(JSON.stringify(obj) + '\n');
}

async function terminals() {
  const active = vscode.window.activeTerminal;
  const list = [];
  for (const t of vscode.window.terminals) {
    const pid = await t.processId;
    if (pid) list.push({ pid, name: t.name, active: t === active });
  }
  return list;
}

function workspacePath() {
  const file = vscode.workspace.workspaceFile;
  if (file && file.scheme === 'file') return file.fsPath;
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length ? folders[0].uri.fsPath : undefined;
}

async function report(kind = 'vscodeState') {
  send({ kind, windowId, workspace: workspacePath(), terminals: await terminals(), focused: vscode.window.state.focused });
}

function reportSoon() {
  clearTimeout(reportTimer);
  reportTimer = setTimeout(() => report(), 120);
}

function connect() {
  sock = net.createConnection(SOCK);
  sock.setEncoding('utf8');
  sock.on('connect', () => report('vscodeHello'));
  sock.on('data', (data) => {
    buffer += data;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      try { onMessage(JSON.parse(line)); } catch (e) { /* ignore bad line */ }
    }
  });
  sock.on('error', () => {});
  sock.on('close', () => {
    sock = null;
    clearTimeout(retry);
    retry = setTimeout(connect, 3000);
  });
}

async function findTerminal(pid) {
  for (const t of vscode.window.terminals) {
    if ((await t.processId) === pid) return t;
  }
  return undefined;
}

async function onMessage(m) {
  if (m.kind === 'focusTerminal') {
    const t = await findTerminal(m.shellPid);
    if (t) t.show(false);
  } else if (m.kind === 'closeTerminal') {
    // Close Session: closing the tab ends Claude.
    const t = await findTerminal(m.shellPid);
    if (t) t.dispose();
  } else if (m.kind === 'sessions') {
    // The app sends them in order: most urgent first, newest session first within the same urgency.
    sessions = (m.sessions || []).slice();
    folders = (m.folders || []).slice();
    sessionById = new Map(sessions.map((s) => [s.id, s]));
    folderById = new Map(folders.map((f) => [f.id, f]));
    folderSignal = new Map();
    folderCount = new Map();
    for (const s of sessions) {
      for (const f of ancestors(folderOf(s))) {
        folderCount.set(f, (folderCount.get(f) || 0) + 1);
        const cur = folderSignal.get(f);
        if (SIGNAL.includes(s.state) && (!cur || URGENCY[s.state] < URGENCY[cur])) folderSignal.set(f, s.state);
      }
    }
    tree.refresh();
    decorations.refresh();
    updateStatus();
    // A session started or ended somewhere: maybe in one of our tabs.
    const key = sessions.map((s) => s.id + ':' + s.shellPid).sort().join(',');
    if (key !== sessionsKey) { sessionsKey = key; saveSoon(); }
  }
}

// Folders that no longer exist count as the top level (null).
function folderOf(s) { return s && s.folder && folderById.has(s.folder) ? s.folder : null; }
function parentOf(f) { return f && f.parent && folderById.has(f.parent) ? f.parent : null; }
// A folder id and every folder above it.
function ancestors(id) {
  const out = [];
  for (let f = id, n = 0; f && n < 64; f = parentOf(folderById.get(f)), n++) out.push(f);
  return out;
}

function ago(seconds) {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - seconds));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

// Tree elements are keys: "f:<folder id>" and "s:<session id>".
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
// Folders: your order (Move Up / Move Down). Sessions: most urgent first, then the one you wrote to last (only writing
// moves a session, so rows don't jump while you look around).
const byOrder = (a, b) => (a.order || 0) - (b.order || 0) || byName(a, b);
const byUrgency = (a, b) => (URGENCY[a.state] ?? 9) - (URGENCY[b.state] ?? 9) || (b.touched || 0) - (a.touched || 0) || byName(a, b);
const keyUri = (key) => vscode.Uri.from({ scheme: 'claude-session', path: '/' + key });

class SessionTree {
  constructor() {
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
  }
  refresh() { this.emitter.fire(); }
  // On every level: the sessions, then the folders (or folders first, with "foldersPosition": "top").
  getChildren(key) {
    if (key && key.startsWith('s:')) return [];
    const parent = key ? key.slice(2) : null;
    const dirs = folders.filter((f) => parentOf(f) === parent).sort(byOrder).map((f) => 'f:' + f.id);
    const list = sessions.filter((s) => folderOf(s) === parent).sort(byUrgency).map((s) => 's:' + s.id);
    const onTop = vscode.workspace.getConfiguration('claudeCodeAlerts').get('foldersPosition') === 'top';
    return onTop ? [...dirs, ...list] : [...list, ...dirs];
  }
  getParent(key) {
    const parent = key.startsWith('f:') ? parentOf(folderById.get(key.slice(2))) : folderOf(sessionById.get(key.slice(2)));
    return parent ? 'f:' + parent : undefined;
  }
  getTreeItem(key) {
    if (key.startsWith('f:')) {
      const f = folderById.get(key.slice(2)) || { name: '' };
      const item = new vscode.TreeItem(f.name, vscode.TreeItemCollapsibleState.Expanded);
      item.id = key;
      // Words the menus test: nested (can move to the top level), canUp / canDown (Move Up / Move Down).
      const sibs = folders.filter((x) => parentOf(x) === parentOf(f)).sort(byOrder);
      item.contextValue = ['folder', parentOf(f) && 'nested', sibs[0] !== f && 'canUp', sibs[sibs.length - 1] !== f && 'canDown']
        .filter(Boolean).join(' ');
      item.description = folderCount.get(f.id) ? String(folderCount.get(f.id)) : undefined;
      // Without a tooltip VS Code shows the row's internal URI ("f:ea0f…").
      item.tooltip = f.name;
      item.iconPath = vscode.ThemeIcon.Folder;
      item.resourceUri = keyUri(key);
      return item;
    }
    const s = sessionById.get(key.slice(2));
    if (!s) return new vscode.TreeItem('');
    const item = new vscode.TreeItem(s.name);
    item.id = key;
    // Words the menus test: tab (runs in a VS Code terminal tab, so Close Session can close it), nested.
    item.contextValue = ['session', closable(s) && 'tab', folderOf(s) && 'nested'].filter(Boolean).join(' ');
    item.resourceUri = keyUri(key);
    item.description = `${LABEL[s.state] || s.state} · ${ago(s.updated)}${s.detail ? ' · ' + s.detail : ''}`;
    // Colored dots are files, so a selected row keeps its state color (VS Code paints selected theme icons white).
    // Only the grey idle dot is a theme icon and turns white when you select it.
    item.iconPath = s.state === 'idle' || !extUri
      ? new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor(COLOR.idle))
      : vscode.Uri.joinPath(extUri, 'media', `dot-${s.state}.svg`);
    item.tooltip = `${s.name}\n${LABEL[s.state] || s.state}\n${s.detail || ''}`;
    item.command = { command: 'claudeCodeAlerts.goto', title: 'Go to session', arguments: [key] };
    return item;
  }
}
const tree = new SessionTree();

// Colors names like the Explorer colors changed files: a session that needs you, and every folder it is in
// (with a dot), so a collapsed folder still shows that something inside waits.
const decorations = {
  emitter: new vscode.EventEmitter(),
  get onDidChangeFileDecorations() { return this.emitter.event; },
  refresh() {
    this.emitter.fire([...folders.map((f) => keyUri('f:' + f.id)), ...sessions.map((s) => keyUri('s:' + s.id))]);
  },
  provideFileDecoration(uri) {
    if (uri.scheme !== 'claude-session') return undefined;
    const key = uri.path.slice(1);
    const isFolder = key.startsWith('f:');
    const s = isFolder ? null : sessionById.get(key.slice(2));
    const state = isFolder ? folderSignal.get(key.slice(2)) : s && SIGNAL.includes(s.state) ? s.state : null;
    if (!state) return undefined;
    return new vscode.FileDecoration(isFolder ? '●' : undefined, LABEL[state], new vscode.ThemeColor(COLOR[state]));
  }
};

// Drag sessions and folders: onto a folder = into it, onto a session = into that session's folder, onto empty space =
// top level.
const dragAndDrop = {
  dragMimeTypes: [MIME],
  dropMimeTypes: [MIME],
  handleDrag(keys, data) { data.set(MIME, new vscode.DataTransferItem(JSON.stringify(keys))); },
  async handleDrop(target, data) {
    const item = data.get(MIME);
    if (!item) return;
    const ids = JSON.parse(await item.asString());
    if (target && ids.includes(target)) return;
    const folder = !target ? null : target.startsWith('f:') ? target.slice(2) : folderOf(sessionById.get(target.slice(2)));
    send({ kind: 'folder', event: 'move', ids, folder });
  }
};

// Commands get the clicked row (context menu) or work on the selection (title bar, keys).
function picked(key, keys) {
  if (keys && keys.length) return keys;
  return key ? [key] : treeView.selection;
}

// Where something new goes: into the folder you clicked it on (hover button, right-click), next to the session you
// right-clicked (in its folder), else the top level.
function targetFolder(key) {
  return !key ? null : key.startsWith('f:') ? key.slice(2) : folderOf(sessionById.get(key.slice(2)));
}

async function newFolder(key) {
  const parent = targetFolder(key);
  const name = await vscode.window.showInputBox({
    prompt: parent ? `New folder in ${folderById.get(parent).name}` : 'New folder', placeHolder: 'Folder name'
  });
  if (name && name.trim()) send({ kind: 'folder', event: 'create', name: name.trim(), folder: parent });
}

// A terminal tab for a Claude session.
function claudeTerminal(cwd, location) {
  const cfg = vscode.workspace.getConfiguration('claudeCodeAlerts');
  return vscode.window.createTerminal({
    cwd,
    location: location || (cfg.get('newSessionLocation') === 'panel' ? vscode.TerminalLocation.Panel : vscode.TerminalLocation.Editor),
    // VS Code may have been opened from inside a Claude session: without this, claude would think it is nested.
    env: Object.fromEntries(NESTED.map((k) => [k, null]))
  });
}

const claudeCommand = () => vscode.workspace.getConfiguration('claudeCodeAlerts').get('newSessionCommand') || 'claude';

// Opens a terminal tab that starts Claude; started from a folder, the session lands in that folder.
async function newSession(key) {
  const folder = targetFolder(key);
  const t = claudeTerminal(workspacePath());
  t.show(false);
  t.sendText(claudeCommand());
  const shellPid = await t.processId;
  if (folder && shellPid) send({ kind: 'folder', event: 'expect', folder, shellPid });
  reportSoon();
}

async function rename(key) {
  key = key || treeView.selection[0];
  if (!key) return;
  const isFolder = key.startsWith('f:');
  const cur = isFolder ? folderById.get(key.slice(2)) : sessionById.get(key.slice(2));
  if (!cur) return;
  const name = await vscode.window.showInputBox({
    prompt: isFolder ? 'Rename folder' : 'Rename session (its terminal tab follows)',
    value: cur.name, valueSelection: [0, cur.name.length]
  });
  if (!name || !name.trim() || name.trim() === cur.name) return;
  send(isFolder
    ? { kind: 'folder', event: 'rename', folder: cur.id, name: name.trim() }
    : { kind: 'rename', sessionId: cur.id, name: name.trim() });
}

// Moves the clicked or selected rows into a folder picked from a list (or the top level).
async function moveTo(key, keys) {
  const ids = picked(key, keys);
  const moving = ids.filter((k) => k.startsWith('f:')).map((k) => k.slice(2));
  const path = (f) => ancestors(f.id).reverse().map((id) => folderById.get(id).name).join(' / ');
  const choices = folders
    .filter((f) => !ancestors(f.id).some((id) => moving.includes(id)))
    .map((f) => ({ label: '$(folder) ' + path(f), folder: f.id }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }));
  const pick = await vscode.window.showQuickPick([{ label: '$(root-folder) Top level', folder: null }, ...choices],
    { placeHolder: ids.length > 1 ? `Move ${ids.length} items to…` : 'Move to…' });
  if (pick) send({ kind: 'folder', event: 'move', ids, folder: pick.folder });
}

// Move Up / Move Down among the folders next to it.
function shiftFolder(key, direction) {
  key = key || treeView.selection[0];
  if (key && key.startsWith('f:')) send({ kind: 'folder', event: 'shift', folder: key.slice(2), text: direction });
}

function moveToTop(key, keys) {
  send({ kind: 'folder', event: 'move', ids: picked(key, keys), folder: null });
}

const closable = (s) => (s.origin || 'vscode-terminal') === 'vscode-terminal' && s.shellPid > 0;

// Trash: a folder goes, and what was in it moves up one level. A session in a VS Code tab closes (its tab closes, which
// ends Claude; claude --resume continues it later), asking first while Claude still works. A session that runs
// somewhere else only leaves the list: it keeps running and comes back when you write to it or it needs you.
async function remove(key, keys) {
  const ids = picked(key, keys);
  const list = ids.filter((k) => k.startsWith('s:')).map((k) => sessionById.get(k.slice(2))).filter(Boolean);
  const busy = list.filter((s) => closable(s) && (s.state === 'working' || s.state === 'background'));
  if (busy.length) {
    const what = busy.length === 1 ? `Claude is still working in “${busy[0].name}”.` : `Claude is still working in ${busy.length} of these sessions.`;
    const ok = await vscode.window.showWarningMessage(what, { modal: true, detail: 'Closing the session stops it in the middle of its work.' }, 'Close Session');
    if (ok !== 'Close Session') return;
  }
  for (const k of ids) {
    if (k.startsWith('f:')) send({ kind: 'folder', event: 'delete', folder: k.slice(2) });
  }
  const close = list.filter(closable).map((s) => 's:' + s.id);
  const hide = list.filter((s) => !closable(s)).map((s) => 's:' + s.id);
  if (close.length) send({ kind: 'folder', event: 'close', ids: close });
  if (hide.length) send({ kind: 'folder', event: 'hide', ids: hide });
}

// Set State ▸ (right-click a session): your own reminder, without a pill or sound. Needs You and Plan Ready stay until
// you write to the session, Done goes when you open it (like an unread mail), Idle clears it.
function setState(state) {
  return (key, keys) => {
    const ids = picked(key, keys).filter((k) => k.startsWith('s:'));
    if (ids.length) send({ kind: 'folder', event: 'state', ids, state });
  };
}

function updateStatus() {
  const waiting = sessions.filter((s) => ['input', 'review', 'error', 'done'].includes(s.state));
  if (!sessions.length) { status.hide(); return; }
  const top = waiting[0];
  status.text = waiting.length ? `$(circle-filled) ${waiting.length} Claude` : `$(circle-outline) Claude`;
  status.color = top ? new vscode.ThemeColor(COLOR[top.state]) : undefined;
  status.tooltip = waiting.length
    ? waiting.map((s) => `${s.name}: ${LABEL[s.state]}`).join('\n')
    : `${sessions.length} Claude sessions, nothing waiting`;
  status.show();
}

async function gotoSession(s) {
  if (typeof s === 'string') s = sessionById.get(s.slice(2));
  if (!s) return;
  const t = await findTerminal(s.shellPid);
  if (t) t.show(false);
  // Found here: the app only marks it seen. Elsewhere: the app brings that window up.
  send({ kind: 'goto', shellPid: s.shellPid, focused: !!t });
}

// Development helper for demos and tests: opens an editor terminal running a command.
// Only works when "claudeCodeAlerts.devTerminals" is true in this workspace (the demo folder sets it).
function devTerminal(q) {
  if (!vscode.workspace.getConfiguration('claudeCodeAlerts').get('devTerminals')) return;
  const cwd = workspacePath();
  const cmd = q.get('cmd') || '';
  if (q.get('type')) {
    // Like typing the command into a normal shell (shell integration sees it, as in real use).
    const t = vscode.window.createTerminal({ cwd, location: vscode.TerminalLocation.Editor,
      env: { CLAUDECODE: null, CLAUDE_CODE_CHILD_SESSION: null, CLAUDE_CODE_ENTRYPOINT: null, CLAUDE_CODE_SSE_PORT: null } });
    t.show(false);
    setTimeout(() => t.sendText(q.get('type')), 1500);
    reportSoon();
    return;
  }
  // Without a name VS Code shows the title the program sets (like a normal terminal).
  const t = vscode.window.createTerminal({
    name: q.get('name') || undefined,
    cwd,
    location: vscode.TerminalLocation.Editor,
    shellPath: '/bin/zsh',
    // A clean environment: VS Code may have been started from inside another Claude session.
    env: { CLAUDECODE: null, CLAUDE_CODE_CHILD_SESSION: null, CLAUDE_CODE_ENTRYPOINT: null, CLAUDE_CODE_SSE_PORT: null },
    shellArgs: ['-l', '-c', cmd ? `${cmd}; exec /bin/zsh -l` : 'exec /bin/zsh -l']
  });
  t.show(false);
  reportSoon();
}

// Development helper for demos: closes every terminal of this window (only with devTerminals on).
function devClose() {
  if (!vscode.workspace.getConfiguration('claudeCodeAlerts').get('devTerminals')) return;
  for (const t of vscode.window.terminals) t.dispose();
  reportSoon();
}

// Sessions come back after VS Code or the Mac restarts. VS Code reopens the terminal tabs, but as empty shells in the
// folder they were in (panel terminals first, then the editor tabs group by group). So we keep that list with the
// Claude session each tab ran, and after a restart resume each one in its old tab: `claude --resume <id>`.
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const OPEN = 'openSessions';
// When VS Code quits, Claude ends before the tabs close: a session that left its tab still counts this long.
const GRACE = 10000;
const MAX_AGE = 14 * 86400000;
let ctx = null;
let out = null;
let restoring = true;
let closing = false;
let saveTimer = null;
let sessionsKey = '';
// Shell PID → the session that ran in it ({ id, gone: when it stopped running }).
const held = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pidOf = (t) => Promise.race([t.processId, sleep(2000)]);

function run(cmd, args) {
  return new Promise((resolve) => execFile(cmd, args, { timeout: 5000 }, (e, out) => resolve(out || '')));
}

// Every process: pid → { parent, start }.
async function processes() {
  const map = new Map();
  for (const line of (await run('/bin/ps', ['-axo', 'pid=,ppid=,lstart='])).split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (m) map.set(Number(m[1]), { parent: Number(m[2]), start: Date.parse(m[3]) });
  }
  return map;
}

// Claude sessions running now, from Claude Code's own list (~/.claude/sessions/<pid>.json). A file left behind by a
// crash can name a PID another process has taken since: the start time (procStart, in UTC) tells them apart.
function claudeSessions(procs) {
  const dir = path.join(CLAUDE_DIR, 'sessions');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const f of files) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const p = procs.get(r.pid);
      const started = r.procStart ? Date.parse(r.procStart + ' UTC') : NaN;
      if (r.sessionId && p && !(Math.abs(started - p.start) > 3000)) out.push({ pid: r.pid, id: r.sessionId });
    } catch { /* being written */ }
  }
  return out;
}

// The folder each shell is in (VS Code reopens its tab there).
async function cwds(pids) {
  const map = new Map();
  if (!pids.length) return map;
  let pid = 0;
  for (const line of (await run('/usr/sbin/lsof', ['-a', '-d', 'cwd', '-Fn', '-p', pids.join(',')])).split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1));
    else if (line[0] === 'n' && pid) map.set(pid, line.slice(1));
  }
  return map;
}

// This window's terminals in the order VS Code reopens them, each with its folder and Claude session.
async function openTerminals() {
  const list = [];
  for (const t of vscode.window.terminals) {
    const pid = await pidOf(t);
    if (pid) list.push({ t, pid });
  }
  // An editor tab is labeled with its terminal's name: that gives the tab order.
  const editor = [];
  for (const g of vscode.window.tabGroups.all) {
    for (const tab of g.tabs) {
      const x = tab.input instanceof vscode.TabInputTerminal && list.find((y) => !editor.includes(y) && y.t.name === tab.label);
      if (x) editor.push(x);
    }
  }
  const procs = await processes();
  const shells = new Set(list.map((x) => x.pid));
  const inShell = new Map();
  for (const s of claudeSessions(procs)) {
    // Claude's parent is the shell (or a wrapper the shell started).
    for (let p = procs.get(s.pid), n = 0; p && n < 4; p = procs.get(p.parent), n++) {
      if (shells.has(p.parent)) { inShell.set(p.parent, s.id); break; }
    }
  }
  const dirs = await cwds(list.map((x) => x.pid));
  // VS Code can show one shell twice (in the panel and in an editor tab): it counts once, as the tab.
  const panel = list.filter((x) => !editor.includes(x) && !editor.some((y) => y.pid === x.pid))
    .filter((x, i, all) => all.findIndex((y) => y.pid === x.pid) === i);
  return [...panel.map((x) => ({ ...x, panel: true })), ...editor]
    .map((x) => ({ ...x, cwd: dirs.get(x.pid) || null, session: inShell.get(x.pid) || null }));
}

function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 1000);
}

async function save() {
  if (restoring || closing || !ctx) return;
  const terminals = await openTerminals();
  if (closing) return;
  const now = Date.now();
  let waiting = false;
  for (const x of terminals) {
    if (x.session) { held.set(x.pid, { id: x.session, gone: 0 }); continue; }
    const h = held.get(x.pid);
    if (!h) continue;
    if (!h.gone) h.gone = now;
    if (now - h.gone < GRACE) { x.session = h.id; waiting = true; } else held.delete(x.pid);
  }
  for (const pid of held.keys()) if (!terminals.some((x) => x.pid === pid)) held.delete(pid);
  if (waiting) setTimeout(saveSoon, GRACE);
  const list = terminals.map((x) => ({ cwd: x.cwd, session: x.session, ...(x.panel ? { panel: true } : {}) }));
  const cur = ctx.workspaceState.get(OPEN);
  if (!cur || now - cur.at > 3600000 || JSON.stringify(cur.terminals) !== JSON.stringify(list)) {
    ctx.workspaceState.update(OPEN, { at: now, terminals: list });
  }
}

// Waits until VS Code has reopened its terminal tabs (their number stops changing).
async function settle() {
  let n = -1;
  let same = 0;
  for (let i = 0; i < 20 && same < 3; i++) {
    await sleep(500);
    same = vscode.window.terminals.length === n ? same + 1 : 0;
    n = vscode.window.terminals.length;
  }
}

// Two windows of the same folder share what was saved: only one of them resumes a session.
function claim(id) {
  const dir = path.join(os.tmpdir(), 'claude-code-alerts-resume');
  const file = path.join(dir, id);
  try {
    fs.mkdirSync(dir, { recursive: true });
    try { if (Date.now() - fs.statSync(file).mtimeMs < 120000) return false; } catch { /* not claimed yet */ }
    fs.writeFileSync(file, String(process.pid));
    return true;
  } catch { return false; }
}

// Which reopened tab belongs to which saved one (saved index → tab): the longest run of tabs in the same folders, in
// the same order. Usually all of them; when VS Code's list differs from ours (a tab missing, the panel late), matching
// from the end keeps the editor tabs, where sessions live, in place. A session left over takes any tab in its folder.
function match(saved, free) {
  const n = saved.length;
  const m = free.length;
  const same = (i, k) => saved[i].cwd === free[k].cwd;
  const len = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let k = 1; k <= m; k++) len[i][k] = same(i - 1, k - 1) ? len[i - 1][k - 1] + 1 : Math.max(len[i - 1][k], len[i][k - 1]);
  }
  const tabs = new Map();
  const used = new Set();
  for (let i = n, k = m; i > 0 && k > 0;) {
    if (same(i - 1, k - 1)) { tabs.set(i - 1, free[k - 1]); used.add(k - 1); i--; k--; }
    else if (len[i - 1][k] >= len[i][k - 1]) i--;
    else k--;
  }
  saved.forEach((e, i) => {
    if (!e.session || tabs.has(i)) return;
    const k = free.findIndex((x, j) => !used.has(j) && x.cwd === e.cwd);
    if (k >= 0) { tabs.set(i, free[k]); used.add(k); }
  });
  return tabs;
}

// A reopened tab keeps the environment from before the restart: VS Code marks it with ⚠, and Claude in it would talk to
// VS Code on an old port. So the session gets a new tab in the reopened one's place (next to it in its group), and the
// reopened one closes. (VS Code's Relaunch on a reopened tab mixes up tabs at the next Reload Window.)
async function resume(e, tab, columns) {
  let location;
  if (tab) {
    // Make it the active tab of its group (the new tab opens next to it), once VS Code's tab events have settled.
    let last = Date.now();
    const subs = [vscode.window.tabGroups.onDidChangeTabs(() => { last = Date.now(); }),
      vscode.window.tabGroups.onDidChangeTabGroups(() => { last = Date.now(); })];
    tab.t.show(false);
    for (let i = 0; i < 40 && (vscode.window.activeTerminal !== tab.t || Date.now() - last < 250); i++) await sleep(50);
    subs.forEach((x) => x.dispose());
    const column = columns.get(tab.t);
    location = column ? { viewColumn: column, preserveFocus: true } : vscode.TerminalLocation.Panel;
  }
  const t = claudeTerminal(e.cwd, location);
  t.show(true);
  if (tab) tab.t.dispose();
  return t;
}

// The editor group of each reopened tab (none: it is in the panel). VS Code reopens the panel terminals first, then the
// editor tabs group by group, so the last ones fill the groups in order.
function editorColumns() {
  const columns = new Map();
  const groups = vscode.window.tabGroups.all;
  const counts = groups.map((g) => g.tabs.filter((x) => x.input instanceof vscode.TabInputTerminal).length);
  const all = vscode.window.terminals;
  let i = all.length - counts.reduce((a, b) => a + b, 0);
  if (i < 0) return columns;
  groups.forEach((g, n) => { for (let k = 0; k < counts[n]; k++) columns.set(all[i++], g.viewColumn); });
  return columns;
}

// Starts Claude in a new tab. A resumed Claude shows only its own title, and VS Code shows a Claude tab's title only
// after it saw "Claude Code" in one; so that comes first, once the shell is up (VS Code naming the shell would undo it).
async function startClaude(t, id) {
  await new Promise((resolve) => {
    const done = () => { sub.dispose(); clearTimeout(timer); resolve(); };
    const sub = vscode.window.onDidChangeTerminalShellIntegration((e) => { if (e.terminal === t) done(); });
    const timer = setTimeout(done, 5000);
    if (t.shellIntegration) done();
  });
  await sleep(700);
  t.sendText(`printf '\\033]0;Claude Code\\007'; clear`);
  t.sendText(`${claudeCommand()} --resume ${id}`);
  const pid = await pidOf(t);
  if (pid) held.set(pid, { id, gone: Date.now() + 20000 });
}

// After a restart: the sessions this window had that run nowhere now, each in the tab VS Code reopened for it (same
// folder, same order), else in a new tab.
async function restore() {
  try {
    const saved = ctx.workspaceState.get(OPEN);
    if (!vscode.workspace.getConfiguration('claudeCodeAlerts').get('restoreSessions')) return;
    if (!saved || !(Date.now() - saved.at < MAX_AGE) || !saved.terminals.some((e) => e.session)) return;
    await settle();
    const running = new Set(claudeSessions(await processes()).map((s) => s.id));
    const todo = new Set(saved.terminals
      .filter((e) => e.session && /^[\w-]+$/.test(e.session) && !running.has(e.session) && e.cwd && fs.existsSync(e.cwd))
      .map((e) => e.session));
    out.info(`restore: ${saved.terminals.length} saved tabs, ${todo.size} sessions to resume, ${running.size} running`);
    if (!todo.size) return;
    // The reopened tabs: shells with nothing running in them (asked twice: a starting shell runs short helpers).
    const busy = new Set();
    for (let i = 0; i < 2; i++) {
      if (i) await sleep(800);
      for (const p of (await processes()).values()) busy.add(p.parent);
    }
    const free = [];
    for (const t of vscode.window.terminals) {
      const pid = await pidOf(t);
      if (pid && !busy.has(pid) && !free.some((x) => x.pid === pid)) free.push({ t, pid });
    }
    const dirs = await cwds(free.map((x) => x.pid));
    for (const x of free) x.cwd = dirs.get(x.pid);
    out.info(`restore: reopened idle tabs ${free.map((x) => `${x.pid} ${x.cwd}`).join(' | ')}`);
    const tabs = match(saved.terminals, free);
    const columns = editorColumns();
    // Resuming brings each tab forward for a moment: afterwards, back to the tab you were in.
    const group = vscode.window.tabGroups.activeTabGroup;
    const wasTerminal = group && group.activeTab && group.activeTab.input instanceof vscode.TabInputTerminal;
    const terminalBefore = vscode.window.activeTerminal;
    const editorBefore = vscode.window.activeTextEditor;
    const started = [];
    for (const [i, e] of saved.terminals.entries()) {
      if (!e.session || !todo.has(e.session)) continue;
      todo.delete(e.session);
      if (!claim(e.session)) continue;
      const tab = tabs.get(i);
      out.info(`restore: ${e.session} (${e.cwd}) in ${tab ? 'reopened tab ' + tab.pid : 'a new tab'}`);
      started.push(startClaude(await resume(e, tab, columns), e.session));
    }
    await Promise.all(started);
    const count = started.length;
    if (wasTerminal && terminalBefore && !terminalBefore.exitStatus) terminalBefore.show(false);
    else if (editorBefore) vscode.window.showTextDocument(editorBefore.document, { viewColumn: editorBefore.viewColumn });
    if (count) vscode.window.setStatusBarMessage(`$(history) Resumed ${count} Claude session${count === 1 ? '' : 's'}`, 15000);
  } catch (e) {
    out.error('restore failed', e);
  } finally {
    restoring = false;
    saveSoon();
  }
}

function activate(context) {
  ctx = context;
  out = vscode.window.createOutputChannel('Claude Code Alerts', { log: true });
  extUri = context.extensionUri;
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'claudeCodeAlerts.sessions.focus';
  treeView = vscode.window.createTreeView('claudeCodeAlerts.sessions', {
    treeDataProvider: tree, dragAndDropController: dragAndDrop, canSelectMany: true, showCollapseAll: true
  });
  context.subscriptions.push(
    out,
    status,
    treeView,
    vscode.window.registerFileDecorationProvider(decorations),
    vscode.commands.registerCommand('claudeCodeAlerts.goto', gotoSession),
    vscode.commands.registerCommand('claudeCodeAlerts.newSession', newSession),
    vscode.commands.registerCommand('claudeCodeAlerts.newFolder', newFolder),
    // The title bar buttons: VS Code hands title actions the focused row, so these ignore it and mean the top level.
    vscode.commands.registerCommand('claudeCodeAlerts.newSessionTopLevel', () => newSession(null)),
    vscode.commands.registerCommand('claudeCodeAlerts.newFolderTopLevel', () => newFolder(null)),
    vscode.commands.registerCommand('claudeCodeAlerts.rename', rename),
    vscode.commands.registerCommand('claudeCodeAlerts.deleteFolder', remove),
    vscode.commands.registerCommand('claudeCodeAlerts.removeSession', remove),
    vscode.commands.registerCommand('claudeCodeAlerts.closeSession', remove),
    vscode.commands.registerCommand('claudeCodeAlerts.moveTo', moveTo),
    vscode.commands.registerCommand('claudeCodeAlerts.moveToTop', moveToTop),
    vscode.commands.registerCommand('claudeCodeAlerts.setStateInput', setState('input')),
    vscode.commands.registerCommand('claudeCodeAlerts.setStateReview', setState('review')),
    vscode.commands.registerCommand('claudeCodeAlerts.setStateDone', setState('done')),
    vscode.commands.registerCommand('claudeCodeAlerts.setStateIdle', setState('idle')),
    vscode.commands.registerCommand('claudeCodeAlerts.moveUp', (key) => shiftFolder(key, 'up')),
    vscode.commands.registerCommand('claudeCodeAlerts.moveDown', (key) => shiftFolder(key, 'down')),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('claudeCodeAlerts.foldersPosition')) tree.refresh(); }),
    vscode.commands.registerCommand('claudeCodeAlerts.settings', () => execFile(CCA, ['settings'], () => {})),
    vscode.window.onDidOpenTerminal(() => { reportSoon(); saveSoon(); }),
    vscode.window.onDidCloseTerminal(async (t) => {
      reportSoon();
      // Closed by VS Code quitting or reloading: what was open stays saved for next time.
      if (t.exitStatus && t.exitStatus.reason === vscode.TerminalExitReason.Shutdown) { closing = true; return; }
      held.delete(await pidOf(t));
      saveSoon();
    }),
    vscode.window.onDidChangeActiveTerminal(reportSoon),
    vscode.window.onDidChangeWindowState(reportSoon),
    vscode.workspace.onDidChangeWorkspaceFolders(reportSoon),
    vscode.window.registerUriHandler({
      handleUri(uri) {
        const q = new URLSearchParams(uri.query);
        const pid = Number(q.get('pid'));
        if (uri.path === '/focus' && pid) onMessage({ kind: 'focusTerminal', shellPid: pid });
        // New Session from the menu bar list (Claude Code Alerts app), in a folder or at the top level.
        if (uri.path === '/new-session') newSession(q.get('folder') ? 'f:' + q.get('folder') : null);
        if (uri.path === '/dev-terminal') devTerminal(q);
        if (uri.path === '/dev-close') devClose();
      }
    }),
    { dispose: () => { clearTimeout(retry); if (sock) sock.destroy(); } }
  );
  connect();
  // Ages in the view ("3 min") stay fresh; tab titles change without an event, so report them now and then.
  const timer = setInterval(() => { tree.refresh(); report(); saveSoon(); }, 30000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
  restore();
}

function deactivate() { closing = true; }

module.exports = { activate, deactivate };
