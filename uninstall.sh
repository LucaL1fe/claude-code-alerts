#!/bin/bash
# Removes Claude Code Alerts: app, hooks, skill, cca and the VS Code extension. Your other settings stay.
set -uo pipefail
BUNDLE_ID="io.github.lucal1fe.claude-code-alerts"
HOME_DIR="$HOME/.claude-code-alerts"
osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
if [ -f "$HOME_DIR/hooks.py" ]; then python3 "$HOME_DIR/hooks.py" uninstall; fi
rm -rf "$HOME/.claude/skills/claude-code-alerts"
rm -rf "/Applications/Claude Code Alerts.app" "$HOME/Applications/Claude Code Alerts.app"
CODE_CLI="$(command -v code || echo "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code")"
[ -x "$CODE_CLI" ] && "$CODE_CLI" --uninstall-extension lucal1fe.claude-code-alerts >/dev/null 2>&1
rm -rf "$HOME/Library/Application Support/claude-code-alerts"
defaults delete "$BUNDLE_ID" >/dev/null 2>&1 || true
rm -rf "$HOME_DIR"
echo "✓ Claude Code Alerts removed."
