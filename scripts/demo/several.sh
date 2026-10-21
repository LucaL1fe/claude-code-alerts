#!/bin/bash
# README clip: three sessions want you while you browse: pills stack by urgency, the list opens, go to the urgent one.
# Usage: several.sh <payments-shell> <landing-shell> <checkout-shell>
set -u
C=~/.claude-code-alerts/bin/cca
OUT="$(dirname "$0")/out"; mkdir -p "$OUT"; rm -f "$OUT/several.mov"
$C debug clear
open -a "Google Chrome"; sleep 2
FRONT=$(osascript -e 'tell application "System Events" to get name of first process whose frontmost is true')
[ "$FRONT" = "Google Chrome" ] || { echo "Chrome is not in front ($FRONT)"; exit 1; }
screencapture -v -C -V 15 -x "$OUT/several.mov" &
REC=$!
sleep 1.5; $C debug event --shell "$3" --name checkout-refactor --state done --text "Validation added · all 3 tests pass"
sleep 1.4; $C debug event --shell "$2" --name landing-page --state review --text "Plan ready · pricing section in 3 steps"
sleep 1.4; $C debug event --shell "$1" --name payments --state input --text "Allow Bash: npm run migrate"
sleep 3.2; $C debug ui list
sleep 1.6; $C debug ui expand
sleep 2.4; $C debug ui goto
wait $REC
