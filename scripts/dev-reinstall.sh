#!/bin/bash
# Dev loop: rebuild the app and swap it in place (hooks, skill and extension stay as they are).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
bash "$ROOT/scripts/build.sh" >/dev/null
osascript -e 'tell application id "io.github.lucal1fe.claude-code-alerts" to quit' >/dev/null 2>&1 || true
for _ in 1 2 3 4 5 6 7 8 9 10; do pgrep -x ClaudeCodeAlerts >/dev/null || break; sleep 0.3; done
APP_DIR=/Applications; [ -w /Applications ] || APP_DIR="$HOME/Applications"
rm -rf "$APP_DIR/Claude Code Alerts.app"
ditto "$ROOT/build/Claude Code Alerts.app" "$APP_DIR/Claude Code Alerts.app"
open "$APP_DIR/Claude Code Alerts.app"
sleep 1.5
pgrep -lx ClaudeCodeAlerts >/dev/null && echo "✓ reinstalled and running"
