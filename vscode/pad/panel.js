// The Prompt Pad tab: one webview, reused for whatever you open in it (a session, a folder, the overview). It opens in
// the editor group next to the session's terminal (where a scratch file usually sits), and stays where you put it.
const vscode = require('vscode');
const crypto = require('crypto');

const VIEW_TYPE = 'claudeCodeAlerts.pad';

class Panel {
  constructor(extUri, imagesDir, onMessage) {
    this.extUri = extUri;
    this.imagesDir = imagesDir;
    this.onMessage = onMessage;
    this.panel = null;
    this.level = { kind: 'root' };
    this.ready = false;
  }

  get open() { return !!this.panel; }

  // After a reload VS Code gives the tab back: it shows what it showed before.
  serializer() {
    return {
      deserializeWebviewPanel: async (panel, state) => {
        this.adopt(panel);
        if (state && state.level) this.level = state.level;
        this.onMessage({ t: 'restored', level: this.level });
      }
    };
  }

  show(level, { preserveFocus = false, near = null } = {}) {
    if (level) this.level = level;
    if (this.panel) {
      this.panel.reveal(this.panel.viewColumn, preserveFocus);
      return;
    }
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'Prompt Pad', { viewColumn: column(near), preserveFocus }, this.options());
    this.adopt(panel);
  }

  options() {
    return {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extUri, 'media'), vscode.Uri.joinPath(this.extUri, 'pad'), vscode.Uri.file(this.imagesDir)]
    };
  }

  adopt(panel) {
    this.panel = panel;
    this.ready = false;
    panel.webview.options = this.options();
    panel.iconPath = {
      light: vscode.Uri.joinPath(this.extUri, 'media', 'pad-light.svg'),
      dark: vscode.Uri.joinPath(this.extUri, 'media', 'pad-dark.svg')
    };
    panel.webview.html = this.html(panel.webview);
    panel.webview.onDidReceiveMessage((m) => {
      if (m && m.t === 'ready') this.ready = true;
      this.onMessage(m);
    });
    panel.onDidDispose(() => { this.panel = null; this.ready = false; });
  }

  post(msg) { if (this.panel && this.ready) this.panel.webview.postMessage(msg); }

  setTitle(title) { if (this.panel && this.panel.title !== title) this.panel.title = title; }

  imageBase() { return this.panel ? this.panel.webview.asWebviewUri(vscode.Uri.file(this.imagesDir)).toString() : ''; }

  html(webview) {
    const nonce = crypto.randomBytes(16).toString('base64');
    const uri = (...p) => webview.asWebviewUri(vscode.Uri.joinPath(this.extUri, ...p));
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} blob: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`
    ].join('; ');
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${uri('media', 'pad', 'pad.css')}">
<title>Prompt Pad</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${uri('pad', 'model.js')}"></script>
<script nonce="${nonce}" src="${uri('media', 'pad', 'pad.js')}"></script>
</body>
</html>`;
  }
}

// Where a new pad tab goes: next to the session's terminal tab, on the side where a scratch file usually sits (the
// group on its left), else beside the group you are in.
function column(near) {
  const groups = vscode.window.tabGroups.all;
  let group = null;
  if (near) {
    for (const g of groups) {
      if (g.tabs.some((tab) => tab.input instanceof vscode.TabInputTerminal && tab.label === near.name)) { group = g; break; }
    }
  }
  if (!group) {
    const active = vscode.window.tabGroups.activeTabGroup;
    const terminalHere = active && active.tabs.some((tab) => tab.input instanceof vscode.TabInputTerminal);
    if (!terminalHere) return active ? active.viewColumn : vscode.ViewColumn.Active;
    group = active;
  }
  const left = groups.find((g) => g.viewColumn === group.viewColumn - 1);
  if (left) return left.viewColumn;
  return groups.length === 1 ? vscode.ViewColumn.Beside : group.viewColumn + 1;
}

module.exports = { Panel, VIEW_TYPE };
