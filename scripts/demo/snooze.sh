#!/bin/bash
# README clip: "not now" → clock snoozes the pill; while you are away alerts queue; back → one summary.
# Usage: snooze.sh <payments-shell> <landing-shell> <checkout-shell>
set -u
C=~/.claude-code-alerts/bin/cca
OUT="$(dirname "$0")/out"; mkdir -p "$OUT"; rm -f "$OUT/snooze.mov"
$C debug clear
open -a "Google Chrome"; sleep 2
FRONT=$(osascript -e 'tell application "System Events" to get name of first process whose frontmost is true')
[ "$FRONT" = "Google Chrome" ] || { echo "Chrome is not in front ($FRONT)"; exit 1; }
screencapture -v -C -V 14 -x "$OUT/snooze.mov" &
REC=$!
sleep 1.5; $C debug event --shell "$3" --name checkout-refactor --state done --text "Validation added · all 3 tests pass"
sleep 3.0; $C debug ui later
sleep 2.0; $C debug away on
sleep 0.5; $C debug event --shell "$2" --name landing-page --state review --text "Plan ready · pricing section in 3 steps"
sleep 0.5; $C debug event --shell "$1" --name payments --state input --text "Allow Bash: npm run migrate"
sleep 1.5; $C debug away off
wait $REC
