#!/usr/bin/env python3
"""Adds or removes the Claude Code Alerts hooks in ~/.claude/settings.json (keeps everything else, makes a backup)."""
import glob, json, os, shutil, sys, time

HOME = os.path.expanduser("~")
SETTINGS = os.path.join(HOME, ".claude", "settings.json")
MARK = ".claude-code-alerts/bin/cca"
CMD = f'"{HOME}/.claude-code-alerts/bin/cca" hook'


def entry(sync=False, matcher=None):
    hook = {"type": "command", "command": CMD}
    if sync:
        hook["timeout"] = 5
    else:
        hook["async"] = True
    e = {"hooks": [hook]}
    if matcher:
        e["matcher"] = matcher
    return e


OURS = {
    "SessionStart": [entry(sync=True)],
    "UserPromptSubmit": [entry()],
    "Stop": [entry()],
    "StopFailure": [entry()],
    "Notification": [entry()],
    "PermissionRequest": [entry()],
    "PreToolUse": [entry(matcher="ExitPlanMode|AskUserQuestion|mcp__computer-use__.*")],
    "PostToolUse": [entry(matcher="*")],
    "SessionEnd": [entry()],
}


def strip(settings):
    hooks = settings.get("hooks", {})
    for event in list(hooks.keys()):
        kept = []
        for e in hooks[event]:
            e = dict(e)
            e["hooks"] = [h for h in e.get("hooks", []) if MARK not in h.get("command", "")]
            if e["hooks"]:
                kept.append(e)
        if kept:
            hooks[event] = kept
        else:
            del hooks[event]
    if not hooks and "hooks" in settings:
        del settings["hooks"]


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "install"
    path = sys.argv[2] if len(sys.argv) > 2 else SETTINGS
    settings = {}
    if os.path.exists(path):
        with open(path) as f:
            settings = json.load(f)
        backup = f"{path}.bak-claude-code-alerts-{time.strftime('%Y%m%d-%H%M%S')}"
        shutil.copy2(path, backup)
        print(f"  backup: {backup}")
        # Keep the very first backup (your settings before the first install) and the two newest.
        backups = sorted(glob.glob(f"{path}.bak-claude-code-alerts-*"))
        for old in backups[1:-2]:
            os.remove(old)
    strip(settings)
    if mode == "install":
        hooks = settings.setdefault("hooks", {})
        for event, entries in OURS.items():
            hooks.setdefault(event, []).extend(entries)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(settings, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"  {'added' if mode == 'install' else 'removed'} hooks in {path}")


if __name__ == "__main__":
    main()
