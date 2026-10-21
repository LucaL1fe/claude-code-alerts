---
name: claude-code-alerts
description: Mac alerts for the user through Claude Code Alerts (the `cca` command). Use when the user asks to be notified, pinged or alerted ("notify me when…", "ping me if you need my password", "tell me when the build is done"), asks to rename this session or tab, or before you take over their Mac with AppleScript/osascript keystrokes or clicks.
---

# Claude Code Alerts

The user runs **Claude Code Alerts**, a menu bar app that shows a glowing screen edge and a pill with this session's
name when something needs them. Finished turns, permission prompts, questions and plans are already announced
automatically by hooks. Use the commands below only for the moments the hooks can't know about.

The CLI lives at `~/.claude-code-alerts/bin/cca` and finds this session by itself. Run it with the Bash tool.

## Ask for the user's attention

```bash
~/.claude-code-alerts/bin/cca notify --needs-you "Enter your Mac password in the keychain prompt"
~/.claude-code-alerts/bin/cca notify --done "Build finished, 3 warnings"
~/.claude-code-alerts/bin/cca notify --plan "Migration plan ready to review"
~/.claude-code-alerts/bin/cca notify --error "Deploy failed: missing env var"
```

- Keep the text short (under 80 characters); it is shown in the pill and can be read out loud.
- When the user says "if you need X, notify me", send `--needs-you` at that moment, then wait for them.
- Don't notify at the end of a normal turn: the Stop hook already does that.

## Rename this session

When the user asks to rename the session or tab ("rename this tab to checkout-fix"):

```bash
~/.claude-code-alerts/bin/cca rename "checkout-fix"
```

The new name is used in pills, the list and the VS Code terminal tab.

## Taking over the Mac

Computer-use tools turn on the red "using your Mac" ring automatically. If you drive the Mac another way
(osascript keystrokes, `open` + clicks), wrap it:

```bash
~/.claude-code-alerts/bin/cca mac start "Typing a reply in Mail"
# … your osascript / UI steps …
~/.claude-code-alerts/bin/cca mac end
```

Always call `mac end` when you are done, also after an error.
