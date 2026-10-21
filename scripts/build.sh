#!/bin/bash
# Builds "Claude Code Alerts.app" (menu bar app + the cca CLI inside it) into ./build.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/build/Claude Code Alerts.app"
VERSION="$(grep -E '^let version' "$ROOT/app/Sources/CLI/main.swift" | sed -E 's/.*"(.*)".*/\1/')"

echo "› Building Swift package (release)…"
swift build -c release --package-path "$ROOT/app" --arch arm64 --arch x86_64 2>&1 | grep -vE "^\[|^Building|^Compiling|^Write" || true
BIN="$(swift build -c release --package-path "$ROOT/app" --arch arm64 --arch x86_64 --show-bin-path)"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN/ClaudeCodeAlerts" "$APP/Contents/MacOS/ClaudeCodeAlerts"
cp "$BIN/cca" "$APP/Contents/MacOS/cca"
[ -f "$ROOT/app/Resources/AppIcon.icns" ] && cp "$ROOT/app/Resources/AppIcon.icns" "$APP/Contents/Resources/"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Claude Code Alerts</string>
  <key>CFBundleDisplayName</key><string>Claude Code Alerts</string>
  <key>CFBundleIdentifier</key><string>io.github.lucal1fe.claude-code-alerts</string>
  <key>CFBundleExecutable</key><string>ClaudeCodeAlerts</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

codesign --force --deep --sign - "$APP" >/dev/null 2>&1
echo "✓ Built $APP ($VERSION)"
