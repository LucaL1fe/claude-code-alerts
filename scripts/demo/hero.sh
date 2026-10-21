#!/bin/bash
# README hero clip: you browse, a session finishes, flare + pill, the mouse goes to → and VS Code opens the exact tab.
# The test tool can't click while Chrome is in front, so the click is sent as `cca debug goto` (same code path).
# Usage: hero.sh <shell-pid-of-demo-terminal>   (run with demo mode on; move the mouse to → during seconds 9–11)
set -u
C=~/.claude-code-alerts/bin/cca
OUT="$(dirname "$0")/out"; mkdir -p "$OUT"; rm -f "$OUT/hero.mov"
open -a "Google Chrome"; sleep 2
FRONT=$(osascript -e 'tell application "System Events" to get name of first process whose frontmost is true')
[ "$FRONT" = "Google Chrome" ] || { echo "Chrome is not in front ($FRONT)"; exit 1; }
screencapture -v -C -V 12 -x "$OUT/hero.mov" &
REC=$!
sleep 2.5
$C debug event --name checkout-refactor --state done --text "Validation added · all 3 tests pass" --shell "$1"
sleep 5
$C debug goto --shell "$1"
wait $REC
