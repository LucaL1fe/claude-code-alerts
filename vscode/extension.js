// Claude Code Alerts for VS Code.
// Tells the Mac app which terminals this window has (by shell PID), focuses or renames a terminal when the app asks,
// and shows every Claude session in a "Claude Sessions" view (with your own folders, like the Explorer) and the status bar.
const vscode = require('vscode');
const net = require('net');
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
      item.contextValue = parentOf(f) ? 'folder-nested' : 'folder';
      item.description = folderCount.get(f.id) ? String(folderCount.get(f.id)) : undefined;
      item.iconPath = vscode.ThemeIcon.Folder;
      item.resourceUri = keyUri(key);
      return item;
    }
    const s = sessionById.get(key.slice(2));
    if (!s) return new vscode.TreeItem('');
    const item = new vscode.TreeItem(s.name);
    item.id = key;
    item.contextValue = folderOf(s) ? 'session-nested' : 'session';
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
// right-clicked (in its folder), or from the title bar to the top level, whatever is selected.
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

// Opens a terminal tab that starts Claude; started from a folder, the session lands in that folder.
async function newSession(key) {
  const folder = targetFolder(key);
  const cfg = vscode.workspace.getConfiguration('claudeCodeAlerts');
  const t = vscode.window.createTerminal({
    cwd: workspacePath(),
    location: cfg.get('newSessionLocation') === 'panel' ? vscode.TerminalLocation.Panel : vscode.TerminalLocation.Editor,
    // VS Code may have been opened from inside a Claude session: without this, claude would think it is nested.
    env: { CLAUDECODE: null, CLAUDE_CODE_CHILD_SESSION: null, CLAUDE_CODE_ENTRYPOINT: null }
  });
  t.show(false);
  t.sendText(cfg.get('newSessionCommand') || 'claude');
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

// Removes only the folder: what was in it moves up one level.
function deleteFolder(key, keys) {
  for (const k of picked(key, keys)) {
    if (k.startsWith('f:')) send({ kind: 'folder', event: 'delete', folder: k.slice(2) });
  }
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

function activate(context) {
  extUri = context.extensionUri;
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'claudeCodeAlerts.sessions.focus';
  treeView = vscode.window.createTreeView('claudeCodeAlerts.sessions', {
    treeDataProvider: tree, dragAndDropController: dragAndDrop, canSelectMany: true, showCollapseAll: true
  });
  context.subscriptions.push(
    status,
    treeView,
    vscode.window.registerFileDecorationProvider(decorations),
    vscode.commands.registerCommand('claudeCodeAlerts.goto', gotoSession),
    vscode.commands.registerCommand('claudeCodeAlerts.newSession', newSession),
    vscode.commands.registerCommand('claudeCodeAlerts.newFolder', newFolder),
    vscode.commands.registerCommand('claudeCodeAlerts.rename', rename),
    vscode.commands.registerCommand('claudeCodeAlerts.deleteFolder', deleteFolder),
    vscode.commands.registerCommand('claudeCodeAlerts.moveTo', moveTo),
    vscode.commands.registerCommand('claudeCodeAlerts.moveToTop', moveToTop),
    vscode.commands.registerCommand('claudeCodeAlerts.moveUp', (key) => shiftFolder(key, 'up')),
    vscode.commands.registerCommand('claudeCodeAlerts.moveDown', (key) => shiftFolder(key, 'down')),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('claudeCodeAlerts.foldersPosition')) tree.refresh(); }),
    vscode.commands.registerCommand('claudeCodeAlerts.settings', () => execFile(CCA, ['settings'], () => {})),
    vscode.window.onDidOpenTerminal(reportSoon),
    vscode.window.onDidCloseTerminal(reportSoon),
    vscode.window.onDidChangeActiveTerminal(reportSoon),
    vscode.window.onDidChangeWindowState(reportSoon),
    vscode.workspace.onDidChangeWorkspaceFolders(reportSoon),
    vscode.window.registerUriHandler({
      handleUri(uri) {
        const q = new URLSearchParams(uri.query);
        const pid = Number(q.get('pid'));
        if (uri.path === '/focus' && pid) onMessage({ kind: 'focusTerminal', shellPid: pid });
        if (uri.path === '/dev-terminal') devTerminal(q);
        if (uri.path === '/dev-close') devClose();
      }
    }),
    { dispose: () => { clearTimeout(retry); if (sock) sock.destroy(); } }
  );
  connect();
  // Ages in the view ("3 min") stay fresh; tab titles change without an event, so report them now and then.
  const timer = setInterval(() => { tree.refresh(); report(); }, 30000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

function deactivate() {}

module.exports = { activate, deactivate };
