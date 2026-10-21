# Contributing to Claude Code Alerts

Thanks for helping! This project wants to become a small, polished ecosystem for people who run many Claude Code
sessions in parallel. Bug reports, ideas and pull requests are all welcome.

## Good first contributions

- Exact-tab jumps for more terminals (iTerm2, Ghostty, Warp, kitty, tmux)
- Approve or deny a permission prompt right from the pill
- Phone push when you are away (e.g. ntfy)
- Themes, sounds, localization
- Tests for the rules in `app/Sources/App/Store.swift`

## Project layout

```
app/        Swift package: the menu bar app (ClaudeCodeAlerts) and the cca CLI
  Sources/Shared   socket protocol, process helpers, transcript reader
  Sources/App      state + rules (Store), overlays, pills, menu bar list, settings
  Sources/CLI      cca: hook entry point, notify/rename/mac, debug commands
vscode/     VS Code extension (plain JavaScript, no dependencies)
plugin/     Claude Code hooks + skill (also usable as a plugin)
scripts/    build.sh, hooks.py (merges hooks into settings.json), dev-reinstall.sh, demo/ (README clips)
```

## Develop

```bash
git clone https://github.com/LucaL1fe/claude-code-alerts && cd claude-code-alerts
./install.sh                      # builds from source and installs everything
./scripts/dev-reinstall.sh        # after changing the app: rebuild + restart
cd vscode && npx @vscode/vsce package --no-dependencies && code --install-extension *.vsix --force
```

Try things without a real session:

```bash
cca debug event --name my-session --state done --text "It works"   # also input, review, error, mac, free
cca debug away on|off
cca debug clear
cca status
```

## Guidelines

- Keep hooks fast and asynchronous: they run for every session.
- Never steal focus or jump on your own; only a click jumps.
- Everything stays local: no network calls, no analytics.
- macOS 14+, Swift 6, no third-party dependencies.

## License

By contributing you agree that your contributions are licensed under the MIT License.
