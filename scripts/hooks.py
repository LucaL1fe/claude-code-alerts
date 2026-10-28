#!/usr/bin/env python3
"""Adds or removes the Claude Code Alerts hooks and status line in ~/.claude/settings.json (keeps everything else, makes a
backup). A status line you already had keeps working: ours runs it and prints its output, and uninstall puts it back."""
import glob, json, os, shutil, sys, time

HOME = os.path.expanduser("~")
SETTINGS = os.path.join(HOME, ".claude", "settings.json")
MARK = ".claude-code-alerts/bin/cca"
CMD = f'"{HOME}/.claude-code-alerts/bin/cca" hook'
STATUS_CMD = f'"{HOME}/.claude-code-alerts/bin/cca" statusline'
# The status line you had before ours, run by `cca statusline`.
SAVED_STATUS = os.path.join(HOME, ".claude-code-alerts", "statusline.json")


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


def ours(value):
    return MARK in json.dumps(value or {})


def install_status(settings):
    # Claude Code hands its status line the usage limits with their exact reset times: that is how the app knows when a
    # session that stopped at the limit can go on.
    cur = settings.get("statusLine")
    if cur and not ours(cur):
        os.makedirs(os.path.dirname(SAVED_STATUS), exist_ok=True)
        with open(SAVED_STATUS, "w") as f:
            json.dump(cur, f, indent=2)
    elif not cur and os.path.exists(SAVED_STATUS):
        os.remove(SAVED_STATUS)
    # Its other options (padding, refresh interval) stay.
    keep = {k: v for k, v in cur.items() if k not in ("type", "command")} if isinstance(cur, dict) else {}
    settings["statusLine"] = {"type": "command", "command": STATUS_CMD, **keep}


def uninstall_status(settings):
    if ours(settings.get("statusLine")):
        if os.path.exists(SAVED_STATUS):
            with open(SAVED_STATUS) as f:
                settings["statusLine"] = json.load(f)
        else:
            del settings["statusLine"]
    if os.path.exists(SAVED_STATUS):
        os.remove(SAVED_STATUS)


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
        install_status(settings)
    else:
        uninstall_status(settings)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(settings, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"  {'added' if mode == 'install' else 'removed'} hooks and status line in {path}")


if __name__ == "__main__":
    main()
