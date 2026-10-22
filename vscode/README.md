# Claude Code Alerts for VS Code

Companion extension of the [Claude Code Alerts](https://github.com/LucaL1fe/claude-code-alerts) Mac app.

- Jumps to the **exact terminal tab** of a Claude Code session when you click its alert.
- **Claude Sessions** view in the Explorer: every session with its state (working, needs you, plan ready, done, error).
- **New Session** (+ in the view's title bar, or right-click a folder): a terminal tab that starts `claude`, in that folder.
- Your own **folders** in that view, like in the Explorer: drag sessions and folders onto a folder, or right-click →
  Move to Folder… / Move to Top Level. Hover a folder for New Session, Rename (F2) and Delete. Move Up / Move Down
  (Alt+↑ / Alt+↓) orders folders; sessions sort themselves (most urgent, then the one you wrote to last).
- A folder takes the color of the most urgent session inside, also when collapsed, and shows how many sessions it holds.
- Status bar item with the number of sessions waiting for you.
- Renames the terminal tab when you rename a session in the app or ask Claude to.

Install the whole thing (app, hooks, skill and this extension) with one command, see the main README.
