#!/bin/bash
# README clip: in VS Code you ask Claude to rename the tab and to ping you for the password; you switch to Reddit;
# Claude's own "needs you" pill arrives; one click brings you back to the renamed tab.
# Usage: talk.sh   (demo window in front, no terminals open)
set -u
C=~/.claude-code-alerts/bin/cca
OUT="$(dirname "$0")/out"; mkdir -p "$OUT"; rm -f "$OUT/talk.mov"
enc(){ python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$1"; }
screencapture -v -C -V 50 -x "$OUT/talk.mov" &
REC=$!
sleep 0.5
open "vscode://lucal1fe.claude-code-alerts/dev-terminal?name=claude&cmd=$(enc 'claude --permission-mode bypassPermissions "Rename this tab to release-checklist. Then run the Bash command sleep 12 in the foreground (not in the background). Then pretend the next step needs my Mac password for the keychain and notify me through claude-code-alerts. Do all of this in one turn and reply with one short line at the end."')"
sleep 10
open -a "Google Chrome"
# wait for Claude's own notify, then go back like a click on →
for _ in $(seq 1 70); do
  $C status | grep -q "^input.*release-checklist" && break
  sleep 0.5
done
sleep 4
$C debug ui goto
sleep 3; kill -INT $REC 2>/dev/null
wait $REC
