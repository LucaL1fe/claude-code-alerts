import Foundation
import Shared

// cca: the command line side of Claude Code Alerts.
// Hooks call `cca hook` (hook JSON on stdin). Claude itself can call `cca notify`, `cca rename`, `cca mac`.

let version = "0.3.1"
var args = Array(CommandLine.arguments.dropFirst())

func usage() -> Never {
    print("""
    cca \(version) · Claude Code Alerts

    Used by Claude Code hooks:
      cca hook                         read a hook event from stdin and forward it

    Ask for your attention from a Claude session:
      cca notify [--needs-you|--done|--plan|--error] <text>
      cca rename <new name>            rename this session (pills, list, VS Code tab)
      cca mac start [what]             show the red "using your Mac" ring
      cca mac end                      ring off, "Mac is free"

    Other:
      cca status                       list known sessions
      cca settings                     open the settings window
      cca debug event --name N --state done|input|review|error [--text T] [--id ID] [--shell PID]
      cca debug away on|off            pretend you are away / back
      cca debug demo on|off            demo mode: ignore real sessions (for recordings)
      cca debug clear                  remove all alerts
      cca debug ui list|close|expand|quiet|later|done|goto   scripted UI steps for demo recordings
    """)
    exit(0)
}

/// Sends a message; launches the app once if it is not running.
@discardableResult
func deliver(_ msg: Msg, waitReply: Bool = false) -> Msg? {
    var result = SocketClient.send(msg, waitReply: waitReply)
    if !result.sent {
        let open = Process()
        open.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        open.arguments = ["-g", "-b", CCA.bundleId]
        open.standardOutput = FileHandle.nullDevice
        open.standardError = FileHandle.nullDevice
        try? open.run()
        open.waitUntilExit()
        for _ in 0..<25 {
            usleep(200_000)
            result = SocketClient.send(msg, waitReply: waitReply)
            if result.sent { break }
        }
    }
    return result.reply
}

/// The calling Claude session's processes (cca runs inside Claude's Bash tool or a hook).
func withProcs(_ msg: inout Msg) {
    msg.entrypoint = ProcessInfo.processInfo.environment["CLAUDE_CODE_ENTRYPOINT"]
    if let found = Proc.claudeAndShell() {
        msg.claudePid = found.claude.pid
        msg.shellPid = found.shell?.pid
        msg.tty = found.shell?.tty ?? found.claude.tty
    }
    msg.cwd = FileManager.default.currentDirectoryPath
}

func str(_ any: Any?) -> String? {
    guard let s = any as? String, !s.isEmpty else { return nil }
    return s
}

func toolSummary(_ tool: String?, _ input: [String: Any]?) -> String {
    guard let input else { return tool ?? "a tool" }
    if let cmd = str(input["command"]) { return TextUtil.firstLine(cmd, max: 110) }
    if let path = str(input["file_path"]) ?? str(input["path"]) { return (path as NSString).lastPathComponent }
    if let url = str(input["url"]) { return url }
    if let desc = str(input["description"]) { return TextUtil.firstLine(desc, max: 110) }
    return tool ?? "a tool"
}

func runHook() {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { exit(0) }
    let event = str(json["hook_event_name"]) ?? "unknown"
    var msg = Msg(kind: "hook")
    msg.event = event
    msg.sessionId = str(json["session_id"])
    msg.transcript = str(json["transcript_path"])
    withProcs(&msg)
    msg.cwd = str(json["cwd"]) ?? msg.cwd
    msg.name = str(json["session_title"]) ?? Transcript.name(path: msg.transcript)
    msg.toolName = str(json["tool_name"])
    msg.notificationType = str(json["notification_type"])
    let toolInput = json["tool_input"] as? [String: Any]

    switch event {
    case "Stop", "SubagentStop":
        msg.text = TextUtil.firstLine(str(json["last_assistant_message"]))
        // Work Claude waits for (it continues by itself when it finishes). Watchers and schedules do not count.
        let work: Set<String> = ["shell", "subagent", "workflow", "teammate", "cloud session", "MCP task"]
        let tasks = (json["background_tasks"] as? [[String: Any]] ?? []).filter {
            work.contains(str($0["type"]) ?? "") && (str($0["status"]) ?? "running") == "running"
        }
        if !tasks.isEmpty {
            msg.pending = tasks.count
            msg.toolName = TextUtil.firstLine(str(tasks[0]["description"]) ?? str(tasks[0]["command"]) ?? str(tasks[0]["type"]), max: 80)
        }
    case "StopFailure":
        msg.text = str(json["error_message"]) ?? str(json["error"]) ?? str(json["reason"]) ?? str(json["error_type"]) ?? "Stopped with an error"
        msg.text = TextUtil.firstLine(msg.text)
    case "Notification":
        msg.text = TextUtil.firstLine(str(json["message"]))
    case "PermissionRequest":
        msg.text = "Allow \(msg.toolName ?? "tool"): \(toolSummary(msg.toolName, toolInput))"
    case "PreToolUse":
        if msg.toolName == "ExitPlanMode" {
            msg.text = TextUtil.firstLine(str(toolInput?["plan"]))
        } else if msg.toolName == "AskUserQuestion" {
            let questions = toolInput?["questions"] as? [[String: Any]]
            msg.text = TextUtil.firstLine(str(questions?.first?["question"]) ?? "Claude has a question")
        } else {
            msg.text = TextUtil.firstLine(str(toolInput?["action"]) ?? msg.toolName)
        }
    default:
        break
    }

    if event == "SessionStart" {
        // Synchronous: re-apply a name you gave this session earlier.
        let reply = deliver(msg, waitReply: true)
        if let name = reply?.name, !name.isEmpty, name != str(json["session_title"]) {
            let out: [String: Any] = ["hookSpecificOutput": ["hookEventName": "SessionStart", "sessionTitle": name]]
            if let d = try? JSONSerialization.data(withJSONObject: out) { FileHandle.standardOutput.write(d) }
        }
    } else {
        deliver(msg)
    }
    exit(0)
}

func flagValue(_ flag: String) -> String? {
    guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
    let v = args[i + 1]
    args.removeSubrange(i...(i + 1))
    return v
}

guard let command = args.first else { usage() }
args.removeFirst()

switch command {
case "hook":
    runHook()

case "notify":
    var msg = Msg(kind: "notify")
    msg.state = "input"
    let states = ["--needs-you": "input", "--input": "input", "--done": "done", "--plan": "review", "--review": "review", "--error": "error"]
    args = args.filter { a in
        if let s = states[a] { msg.state = s; return false }
        return true
    }
    msg.text = args.joined(separator: " ")
    if msg.text?.isEmpty ?? true { msg.text = "Claude needs you" }
    withProcs(&msg)
    deliver(msg)
    print("Sent: \(msg.text ?? "")")

case "rename":
    var msg = Msg(kind: "rename")
    msg.name = args.joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
    guard !(msg.name ?? "").isEmpty else { usage() }
    withProcs(&msg)
    let reply = deliver(msg, waitReply: true)
    print(reply?.ok == false ? "No session found for this terminal" : "Renamed to \(msg.name ?? "")")

case "mac":
    var msg = Msg(kind: "mac")
    msg.flag = (args.first ?? "start") != "end"
    msg.text = args.dropFirst().joined(separator: " ")
    withProcs(&msg)
    deliver(msg)

case "status":
    var msg = Msg(kind: "status")
    msg.flag = true
    if let reply = deliver(msg, waitReply: true), let sessions = reply.sessions {
        if sessions.isEmpty { print("No sessions yet") }
        for s in sessions {
            print("\(s.state.padding(toLength: 8, withPad: " ", startingAt: 0)) \(s.name)  · \(s.detail)  [shell \(s.shellPid)]")
        }
        print("VS Code windows: \(reply.text?.isEmpty == false ? reply.text! : "none connected")")
        if reply.flag == true { print("You count as away right now") }
    } else {
        print("The app is not running")
    }

case "settings":
    deliver(Msg(kind: "settings"))

case "debug":
    guard let sub = args.first else { usage() }
    args.removeFirst()
    var msg = Msg(kind: "debug")
    msg.event = sub
    switch sub {
    case "event":
        msg.name = flagValue("--name") ?? "demo-session"
        msg.state = flagValue("--state") ?? "done"
        msg.text = flagValue("--text") ?? ""
        msg.sessionId = flagValue("--id") ?? "debug-" + (msg.name ?? "x")
        if let p = flagValue("--shell"), let pid = Int32(p) { msg.shellPid = pid }
        msg.cwd = flagValue("--cwd") ?? FileManager.default.currentDirectoryPath
    case "away", "demo":
        msg.flag = (args.first ?? "on") == "on"
    case "goto":
        if let p = flagValue("--shell"), let pid = Int32(p) { msg.shellPid = pid }
    case "ui":
        msg.text = args.first ?? ""
    default:
        break
    }
    deliver(msg)

case "whoami":
    if let found = Proc.claudeAndShell() {
        print("claude \(found.claude.pid) \(found.claude.comm) \(Proc.path(found.claude.pid) ?? "")")
        print("shell  \(found.shell?.pid ?? 0) \(found.shell?.comm ?? "") tty \(found.shell?.tty ?? "-")")
    } else {
        print("not inside a Claude Code session")
    }

case "-v", "--version", "version":
    print(version)

default:
    usage()
}
