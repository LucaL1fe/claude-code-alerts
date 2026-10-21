// Claude Code Alerts for VS Code.
// Tells the Mac app which terminals this window has (by shell PID), focuses or renames a terminal when the app asks,
// and shows every Claude session in a "Claude Sessions" view and the status bar.
const vscode = require('vscode');
const net = require('net');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const SOCK = path.join(os.homedir(), 'Library/Application Support/claude-code-alerts/alerts.sock');
const CCA = path.join(os.homedir(), '.claude-code-alerts/bin/cca');
const windowId = crypto.randomUUID();

const COLOR = {
  working: 'charts.blue', input: 'charts.orange', review: 'charts.purple', done: 'charts.green',
  error: 'charts.red', idle: 'disabledForeground', mac: 'charts.red', free: 'charts.green'
};
const LABEL = {
  working: 'working', input: 'needs you', review: 'plan ready', done: 'done', error: 'error',
  idle: 'idle', mac: 'using your Mac', free: 'Mac is free'
};
const URGENCY = { input: 0, review: 1, error: 2, done: 3, mac: 4, free: 5, working: 6, idle: 7 };

let sock = null;
let buffer = '';
let retry = null;
let sessions = [];
let status;
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
    sessions = (m.sessions || []).slice().sort((a, b) =>
      (URGENCY[a.state] ?? 9) - (URGENCY[b.state] ?? 9) || b.updated - a.updated);
    tree.refresh();
    updateStatus();
  }
}

function ago(seconds) {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - seconds));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

class SessionTree {
  constructor() {
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
  }
  refresh() { this.emitter.fire(); }
  getChildren() { return sessions; }
  getTreeItem(s) {
    const item = new vscode.TreeItem(s.name);
    item.description = `${LABEL[s.state] || s.state} · ${ago(s.updated)}${s.detail ? ' · ' + s.detail : ''}`;
    item.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor(COLOR[s.state] || 'foreground'));
    item.tooltip = `${s.name}\n${LABEL[s.state] || s.state}\n${s.detail || ''}`;
    item.command = { command: 'claudeCodeAlerts.goto', title: 'Go to session', arguments: [s] };
    return item;
  }
}
const tree = new SessionTree();

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
  if (!s) return;
  const t = await findTerminal(s.shellPid);
  if (t) {
    t.show(false);
  }
  // Let the app mark it seen and, if the terminal lives in another window, bring that window up.
  send({ kind: 'goto', shellPid: s.shellPid });
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
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'claudeCodeAlerts.sessions.focus';
  context.subscriptions.push(
    status,
    vscode.window.registerTreeDataProvider('claudeCodeAlerts.sessions', tree),
    vscode.commands.registerCommand('claudeCodeAlerts.goto', gotoSession),
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
