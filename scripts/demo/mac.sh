#!/bin/bash
# README clip: a session drives the Mac → red ring + short pill; done → green "Mac is free".
# Usage: mac.sh <checkout-shell> start|end   (the typing in between is done by the computer-use tool)
set -u
C=~/.claude-code-alerts/bin/cca
if [ "$2" = start ]; then
  $C debug event --shell "$1" --name checkout-refactor --state mac --text "Writing the release notes in TextEdit"
else
  $C debug event --shell "$1" --name checkout-refactor --state free
fi
