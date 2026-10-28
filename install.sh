#!/bin/bash
# Claude Code Alerts installer: the menu bar app, the cca CLI, Claude Code hooks + skill, and the VS Code extension.
#
#   curl -fsSL https://raw.githubusercontent.com/LucaL1fe/claude-code-alerts/main/install.sh | bash
#
# Run it again to update. Uninstall: ~/.claude-code-alerts/uninstall.sh
set -euo pipefail

REPO="LucaL1fe/claude-code-alerts"
BUNDLE_ID="io.github.lucal1fe.claude-code-alerts"
if [ -w /Applications ]; then APP_DIR="/Applications"; else APP_DIR="$HOME/Applications"; fi
APP="$APP_DIR/Claude Code Alerts.app"
HOME_DIR="$HOME/.claude-code-alerts"
SKILL_DIR="$HOME/.claude/skills/claude-code-alerts"

say() { printf '\033[1m›\033[0m %s\n' "$1"; }
ok() { printf '\033[32m✓\033[0m %s\n' "$1"; }

[ "$(uname)" = "Darwin" ] || { echo "Claude Code Alerts runs on macOS only."; exit 1; }

# Where the files come from: this checkout, or a fresh download.
SELF_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "$(dirname "${BASH_SOURCE[0]}")/scripts/build.sh" ]; then
  SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
if [ -z "$SELF_DIR" ]; then
  say "Downloading ${REPO}…"
  curl -fsSL "https://github.com/$REPO/archive/refs/heads/main.tar.gz" | tar xz -C "$TMP"
  SRC="$(ls -d "$TMP"/claude-code-alerts-*)"
else
  SRC="$SELF_DIR"
fi

# 1. The app: prebuilt release if there is one, else build from source.
BUILT=""
if [ -z "$SELF_DIR" ] && curl -fsSL -o "$TMP/app.zip" "https://github.com/$REPO/releases/latest/download/Claude-Code-Alerts.zip" 2>/dev/null; then
  say "Using the latest release build"
  ditto -x -k "$TMP/app.zip" "$TMP/release"
  BUILT="$TMP/release/Claude Code Alerts.app"
  curl -fsSL -o "$TMP/claude-code-alerts.vsix" "https://github.com/$REPO/releases/latest/download/claude-code-alerts.vsix" 2>/dev/null || true
else
  xcode-select -p >/dev/null 2>&1 || { echo "Building needs the Xcode command line tools: xcode-select --install"; exit 1; }
  say "Building the app from source (about a minute)…"
  bash "$SRC/scripts/build.sh"
  BUILT="$SRC/build/Claude Code Alerts.app"
fi

if pgrep -x ClaudeCodeAlerts >/dev/null 2>&1; then
  osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
  sleep 1
fi
mkdir -p "$APP_DIR"
rm -rf "$APP"
ditto "$BUILT" "$APP"
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
ok "App installed: $APP"

# 2. The cca command at a fixed path (hooks and the skill call it there).
mkdir -p "$HOME_DIR/bin"
ln -sf "$APP/Contents/MacOS/cca" "$HOME_DIR/bin/cca"
cp "$SRC/uninstall.sh" "$HOME_DIR/uninstall.sh"
cp "$SRC/scripts/hooks.py" "$HOME_DIR/hooks.py"
chmod +x "$HOME_DIR/uninstall.sh" "$HOME_DIR/hooks.py"
ok "cca: $HOME_DIR/bin/cca"

# 3. Claude Code hooks (merged into ~/.claude/settings.json, backup next to it) and the skill.
say "Adding Claude Code hooks…"
python3 "$HOME_DIR/hooks.py" install
mkdir -p "$SKILL_DIR"
cp "$SRC/plugin/skills/claude-code-alerts/SKILL.md" "$SKILL_DIR/SKILL.md"
ok "Hooks, status line and skill installed (running sessions pick them up by themselves)"

# 4. VS Code extension.
CODE_CLI="$(command -v code || true)"
[ -z "$CODE_CLI" ] && [ -x "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" ] && \
  CODE_CLI="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
if [ -n "$CODE_CLI" ]; then
  VSIX="$TMP/claude-code-alerts.vsix"
  if [ ! -s "$VSIX" ]; then
    if command -v npx >/dev/null 2>&1; then
      say "Packaging the VS Code extension…"
      (cd "$SRC/vscode" && npx --yes @vscode/vsce package --no-dependencies --skip-license -o "$VSIX" >/dev/null 2>&1) || true
    fi
  fi
  if [ -s "$VSIX" ]; then
    "$CODE_CLI" --install-extension "$VSIX" --force >/dev/null 2>&1 && ok "VS Code extension installed"
  else
    echo "  Skipped the VS Code extension (needs node/npx to package it)."
  fi
else
  echo "  VS Code not found: skipped the extension."
fi

# 5. Start it.
open "$APP"
ok "Claude Code Alerts is running in your menu bar (four small squares)."

if pgrep -xq "Code" || pgrep -fq "Visual Studio Code.app/Contents/MacOS"; then
  printf '\n\033[1;33m┌─────────────────────────────────────────────────────────────────┐\033[0m\n'
  printf '\033[1;33m│\033[0m  \033[1mOne last step: reload your open VS Code windows once\033[0m          \033[1;33m│\033[0m\n'
  printf '\033[1;33m│\033[0m  In each window: Cmd+Shift+P › "Developer: Reload Window"        \033[1;33m│\033[0m\n'
  printf '\033[1;33m│\033[0m  Your terminals and Claude sessions keep running.               \033[1;33m│\033[0m\n'
  printf '\033[1;33m└─────────────────────────────────────────────────────────────────┘\033[0m\n'
fi
echo
echo "  Try it:   $HOME_DIR/bin/cca debug event --name my-session --state done --text \"It works\""
echo "  Settings: click the menu bar icon › Settings…"
