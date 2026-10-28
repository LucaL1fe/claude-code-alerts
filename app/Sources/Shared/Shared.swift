import Darwin
import Foundation

/// Paths and ids shared by the app, the CLI and (by convention) the VS Code extension.
public enum CCA {
    public static let bundleId = "io.github.lucal1fe.claude-code-alerts"
    public static let appName = "Claude Code Alerts"

    public static var supportDir: URL {
        let url = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/claude-code-alerts", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    public static var socketPath: String { supportDir.appendingPathComponent("alerts.sock").path }
}

/// One terminal of a VS Code window, as reported by the extension.
public struct TermInfo: Codable, Equatable {
    public var pid: Int32
    public var name: String
    public var active: Bool

    public init(pid: Int32, name: String, active: Bool) {
        self.pid = pid
        self.name = name
        self.active = active
    }
}

/// A session row as sent to the VS Code extension (Sessions view, status bar).
public struct SessionInfo: Codable, Equatable {
    public var id: String
    public var name: String
    public var state: String
    public var detail: String
    public var shellPid: Int32
    public var updated: Double
    /// Its folder in the Sessions view (nil = top level).
    public var folder: String?
    /// When you last wrote to it (or it started): the list order.
    public var touched: Double
    /// Where it runs: vscode-terminal, vscode-panel, terminal[:bundle id], desktop, background (nil = vscode-terminal).
    public var origin: String?

    public init(id: String, name: String, state: String, detail: String, shellPid: Int32, updated: Double,
                folder: String? = nil, touched: Double = 0, origin: String? = nil) {
        self.id = id
        self.name = name
        self.state = state
        self.detail = detail
        self.shellPid = shellPid
        self.updated = updated
        self.folder = folder
        self.touched = touched
        self.origin = origin
    }
}

/// A folder you made in the Sessions view, like a folder in the VS Code Explorer.
public struct FolderInfo: Codable, Equatable {
    public var id: String
    public var name: String
    /// The folder it is in (nil = top level), and its position among the folders there (Move Up / Move Down).
    public var parent: String?
    public var order: Double?
    /// Made in demo mode: shown only in demo mode, so recordings never show your own folders.
    public var demo: Bool?

    public init(id: String, name: String, parent: String?, order: Double?, demo: Bool? = nil) {
        self.id = id
        self.name = name
        self.parent = parent
        self.order = order
        self.demo = demo
    }
}

/// A usage-limit window as Claude Code reports it (the 5-hour limit, the weekly one, a model's weekly one): when it resets.
public struct LimitWindow: Codable, Equatable {
    /// five_hour, seven_day, seven_day_opus, …
    public var type: String
    /// Unix seconds.
    public var resetsAt: Double
    /// Share used, 0–100 (the status line has it; a refused request counts as 100).
    public var used: Double?

    public init(type: String, resetsAt: Double, used: Double? = nil) {
        self.type = type
        self.resetsAt = resetsAt
        self.used = used
    }
}

/// The one message type on the socket, one JSON object per line. Every field except `kind` is optional.
public struct Msg: Codable {
    public var kind: String
    public var event: String?
    public var sessionId: String?
    public var claudePid: Int32?
    public var shellPid: Int32?
    public var tty: String?
    public var cwd: String?
    public var transcript: String?
    public var name: String?
    public var text: String?
    public var state: String?
    public var toolName: String?
    public var notificationType: String?
    public var windowId: String?
    public var workspace: String?
    public var terminals: [TermInfo]?
    public var sessions: [SessionInfo]?
    public var folders: [FolderInfo]?
    /// Folder operations: the folder (create: the one to make it in; move: the one to move into; nil = top level)
    /// and the moved items ("s:<session id>", "f:<folder id>").
    public var folder: String?
    public var ids: [String]?
    public var focused: Bool?
    public var flag: Bool?
    public var entrypoint: String?
    /// How a session started (SessionStart hook): startup, resume, clear or compact.
    public var source: String?
    /// Background work still running when a turn ended (Stop hook): count and a short description.
    public var pending: Int?
    /// The turn ended because of the usage limit (Stop / StopFailure), and the limit windows known (with reset times).
    public var limitStop: Bool?
    public var limits: [LimitWindow]?
    public var ok: Bool?

    public init(kind: String) { self.kind = kind }
}

public enum Wire {
    public static func encode(_ msg: Msg) -> Data {
        var data = (try? JSONEncoder().encode(msg)) ?? Data("{}".utf8)
        data.append(0x0A)
        return data
    }

    public static func decode(_ line: Data) -> Msg? {
        try? JSONDecoder().decode(Msg.self, from: line)
    }
}

/// Minimal blocking Unix-socket client: send one line, optionally read one reply line.
public enum SocketClient {
    public static func connect(timeout: TimeInterval = 1.0) -> Int32? {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }
        var tv = timeval(tv_sec: Int(timeout), tv_usec: Int32((timeout - floor(timeout)) * 1_000_000))
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        var noSigPipe: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let path = CCA.socketPath
        let maxLen = MemoryLayout.size(ofValue: addr.sun_path) - 1
        withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
            ptr.withMemoryRebound(to: CChar.self, capacity: maxLen + 1) { dst in
                _ = path.withCString { strncpy(dst, $0, maxLen) }
            }
        }
        let ok = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        if ok != 0 {
            close(fd)
            return nil
        }
        return fd
    }

    @discardableResult
    public static func send(_ msg: Msg, waitReply: Bool = false, timeout: TimeInterval = 1.0) -> (sent: Bool, reply: Msg?) {
        guard let fd = connect(timeout: timeout) else { return (false, nil) }
        defer { close(fd) }
        let data = Wire.encode(msg)
        let written = data.withUnsafeBytes { write(fd, $0.baseAddress, data.count) }
        guard written == data.count else { return (false, nil) }
        guard waitReply else { return (true, nil) }
        var buffer = Data()
        var chunk = [UInt8](repeating: 0, count: 4096)
        while true {
            let n = read(fd, &chunk, chunk.count)
            if n <= 0 { break }
            buffer.append(contentsOf: chunk[0..<n])
            if let nl = buffer.firstIndex(of: 0x0A) {
                return (true, Wire.decode(buffer[buffer.startIndex..<nl]))
            }
        }
        return (true, nil)
    }
}

/// Process helpers via sysctl (no `ps` spawn, so hooks stay fast).
public enum Proc {
    public struct Info {
        public var pid: pid_t
        public var ppid: pid_t
        public var comm: String
        public var tty: String?
    }

    public static func info(_ pid: pid_t) -> Info? {
        var kinfo = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        guard sysctl(&mib, 4, &kinfo, &size, nil, 0) == 0, size > 0 else { return nil }
        let comm = withUnsafePointer(to: &kinfo.kp_proc.p_comm) {
            $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXCOMLEN) + 1) { String(cString: $0) }
        }
        var tty: String?
        let tdev = kinfo.kp_eproc.e_tdev
        if tdev != -1, let name = devname(tdev, S_IFCHR) {
            tty = "/dev/" + String(cString: name)
        }
        return Info(pid: pid, ppid: kinfo.kp_eproc.e_ppid, comm: comm, tty: tty)
    }

    public static func path(_ pid: pid_t) -> String? {
        var buf = [CChar](repeating: 0, count: 4096)
        let n = proc_pidpath(pid, &buf, UInt32(buf.count))
        return n > 0 ? String(cString: buf) : nil
    }

    /// The native Claude Code binary is named after its version (…/claude/versions/2.1.305),
    /// an npm install runs as node with a claude script; both are recognized.
    public static func isClaude(_ info: Info) -> Bool {
        if info.comm.lowercased().contains("claude") { return true }
        guard let p = path(info.pid)?.lowercased() else { return false }
        return p.contains("/claude/") || p.hasSuffix("/claude") || p.contains("claude-code")
    }

    /// Walks up from `start` to the first Claude Code ancestor.
    /// Returns that process and its parent (the terminal's shell, i.e. VS Code's `terminal.processId`).
    public static func claudeAndShell(from start: pid_t = getppid()) -> (claude: Info, shell: Info?)? {
        var pid = start
        for _ in 0..<12 {
            guard pid > 1, let info = info(pid) else { return nil }
            if isClaude(info) {
                return (info, Self.info(info.ppid))
            }
            pid = info.ppid
        }
        return nil
    }

    public static func isAlive(_ pid: pid_t) -> Bool {
        pid > 0 && (kill(pid, 0) == 0 || errno == EPERM)
    }
}

/// Reads the session's display name from the end of its transcript.
public enum Transcript {
    public static func name(path: String?) -> String? {
        guard let path, let handle = FileHandle(forReadingAtPath: path) else { return nil }
        defer { try? handle.close() }
        let size = (try? handle.seekToEnd()) ?? 0
        let window: UInt64 = 768 * 1024
        try? handle.seek(toOffset: size > window ? size - window : 0)
        guard let data = try? handle.readToEnd(), let text = String(data: data, encoding: .utf8) else { return nil }
        var agentName: String?
        var customTitle: String?
        var aiTitle: String?
        for line in text.split(separator: "\n").reversed() {
            if agentName == nil, line.contains("\"agent-name\""), let v = field(line, "agentName") { agentName = v }
            if customTitle == nil, line.contains("\"custom-title\""), let v = field(line, "customTitle") { customTitle = v }
            if aiTitle == nil, line.contains("\"ai-title\""), let v = field(line, "aiTitle") { aiTitle = v }
            if agentName != nil { break }
        }
        return agentName ?? customTitle ?? aiTitle
    }

    private static func field(_ line: Substring, _ key: String) -> String? {
        guard let obj = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else { return nil }
        let value = obj[key] as? String
        return (value?.isEmpty ?? true) ? nil : value
    }
}

/// What a session's transcript says about the usage limit. Reads only fields Claude Code writes for itself, never message
/// text, so it works whatever language the session speaks and however your Mac shows times.
public enum UsageLimit {
    public struct Scan {
        /// The turn that just ended stopped for the limit: Claude Code told Claude to wrap up (a note with
        /// usageLimitNote "wrap_up") or refused a request (error "rate_limit").
        public var stopped = false
        /// Reset times of refused requests (quotaLimits.resetsAt) in the session and its subagents, still ahead.
        public var windows: [LimitWindow] = []
    }

    public static func scan(transcript path: String?, now: Date = Date()) -> Scan {
        var out = Scan()
        guard let path else { return out }
        // Newest first, back to the prompt that started this turn (only turn starts have a promptSource). Screenshots make
        // rows big, so the tail is generous; the search runs on bytes, so it stays fast.
        let main = Tail(path, bytes: 8 << 20)
        var released = false
        for line in main.lines {
            let note = main.has(line, "\"usageLimitNote\"")
            let quota = main.has(line, "\"quotaLimits\"")
            let start = main.has(line, "\"promptSource\"")
            guard note || quota || start, let obj = main.object(line) else { continue }
            if quota, let w = refused(obj, now: now) {
                out.windows.append(w)
                if !released && (obj["error"] as? String) == "rate_limit" { out.stopped = true }
            }
            if note {
                // "release": the limit no longer applies (extra usage, a reset) after an earlier wrap-up note.
                switch obj["usageLimitNote"] as? String {
                case "release": if !out.stopped { released = true }
                case "wrap_up": if !released { out.stopped = true }
                default: break
                }
            }
            if start && (obj["type"] as? String) == "user" && obj["promptSource"] != nil { break }
        }
        // Background agents hit the limit too, and often first: their transcripts have the reset time. (Only read when
        // the turn stopped for the limit, so an ordinary turn end stays cheap.)
        let dir = URL(fileURLWithPath: (path as NSString).deletingPathExtension).appendingPathComponent("subagents")
        let files = !out.stopped ? [] :
            (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
        for file in files where file.pathExtension == "jsonl" {
            let modified = (try? file.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            guard now.timeIntervalSince(modified) < 12 * 3600 else { continue }
            let agent = Tail(file.path, bytes: 256 << 10)
            for line in agent.lines where agent.has(line, "\"quotaLimits\"") {
                if let obj = agent.object(line), let w = refused(obj, now: now) { out.windows.append(w) }
            }
        }
        // One per limit: the latest reset.
        var best: [String: LimitWindow] = [:]
        for w in out.windows where (best[w.type]?.resetsAt ?? 0) < w.resetsAt { best[w.type] = w }
        out.windows = best.values.sorted { $0.resetsAt < $1.resetsAt }
        return out
    }

    /// When the session last did something: the newest prompt or answer in its transcript.
    public static func lastActivity(transcript path: String?) -> Date? {
        guard let path else { return nil }
        let t = Tail(path, bytes: 8 << 20)
        for line in t.lines where t.has(line, "\"assistant\"") || t.has(line, "\"promptSource\"") {
            guard let obj = t.object(line), let type = obj["type"] as? String,
                  type == "assistant" || (type == "user" && obj["promptSource"] != nil),
                  let stamp = obj["timestamp"] as? String else { continue }
            return date(stamp)
        }
        return nil
    }

    private static func refused(_ obj: [String: Any], now: Date) -> LimitWindow? {
        guard let q = obj["quotaLimits"] as? [String: Any],
              (q["status"] as? String) == "rejected" || (obj["error"] as? String) == "rate_limit",
              let reset = (q["resetsAt"] as? NSNumber)?.doubleValue, reset > now.timeIntervalSince1970 else { return nil }
        return LimitWindow(type: q["rateLimitType"] as? String ?? "five_hour", resetsAt: reset, used: 100)
    }

    private static func date(_ stamp: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: stamp) ?? ISO8601DateFormatter().date(from: stamp)
    }

    /// The end of a file as bytes, cut into lines (newest first; a line cut off at the start is left out).
    private struct Tail {
        let bytes: [UInt8]
        let lines: [Range<Int>]

        init(_ path: String, bytes limit: UInt64) {
            var data = Data()
            var cut = false
            if let handle = FileHandle(forReadingAtPath: path) {
                let size = (try? handle.seekToEnd()) ?? 0
                cut = size > limit
                try? handle.seek(toOffset: cut ? size - limit : 0)
                data = (try? handle.readToEnd()) ?? Data()
                try? handle.close()
            }
            bytes = [UInt8](data)
            var found: [Range<Int>] = []
            bytes.withUnsafeBufferPointer { p in
                guard let base = p.baseAddress else { return }
                var pos = 0
                while pos < p.count {
                    let end = memchr(base + pos, 0x0A, p.count - pos).map { UnsafeRawPointer(base).distance(to: UnsafeRawPointer($0)) } ?? p.count
                    if end > pos { found.append(pos..<end) }
                    pos = end + 1
                }
            }
            if cut && !found.isEmpty { found.removeFirst() }
            lines = found.reversed()
        }

        func has(_ line: Range<Int>, _ needle: String) -> Bool {
            let n = Array(needle.utf8)
            return bytes.withUnsafeBufferPointer { p in
                n.withUnsafeBufferPointer { q in memmem(p.baseAddress! + line.lowerBound, line.count, q.baseAddress!, q.count) != nil }
            }
        }

        func object(_ line: Range<Int>) -> [String: Any]? {
            (try? JSONSerialization.jsonObject(with: Data(bytes[line]))) as? [String: Any]
        }
    }
}

public enum LimitText {
    /// "04:00" today, "Thu 04:00" on another day, in your Mac's own time format.
    public static func when(_ date: Date) -> String {
        let f = DateFormatter()
        if Calendar.current.isDateInToday(date) {
            f.dateStyle = .none
            f.timeStyle = .short
        } else {
            f.setLocalizedDateFormatFromTemplate("EEEjmm")
        }
        return f.string(from: date)
    }

    public static func label(_ type: String) -> String {
        switch type {
        case "five_hour": return "5h"
        case "seven_day": return "week"
        case "seven_day_opus": return "Opus week"
        case "seven_day_sonnet": return "Sonnet week"
        case "spend_limit": return "spend"
        default: return type.replacingOccurrences(of: "_", with: " ")
        }
    }

    /// The 5-hour limit first, then the weekly ones.
    public static func order(_ type: String) -> Int {
        type == "five_hour" ? 0 : type == "seven_day" ? 1 : 2
    }

    /// "5h 82% · resets 04:00 · week 41%": the 5-hour reset always, a weekly one once it is nearly used up.
    public static func usage(_ windows: [LimitWindow]) -> String {
        windows.sorted { order($0.type) < order($1.type) }.map { w in
            var part = LimitText.label(w.type)
            if let used = w.used { part += " \(Int(used.rounded()))%" }
            if w.type == "five_hour" || (w.used ?? 0) >= 80 {
                part += " · resets " + when(Date(timeIntervalSince1970: w.resetsAt))
            }
            return part
        }.joined(separator: " · ")
    }
}

public enum TextUtil {
    /// First meaningful line of a (markdown) message, stripped and shortened.
    public static func firstLine(_ text: String?, max: Int = 140) -> String {
        guard let text else { return "" }
        for raw in text.split(whereSeparator: \.isNewline) {
            var line = raw.trimmingCharacters(in: .whitespaces)
            while let first = line.first, "#>*-`_".contains(first) { line.removeFirst() }
            line = line.replacingOccurrences(of: "**", with: "").replacingOccurrences(of: "`", with: "")
                .trimmingCharacters(in: .whitespaces)
            if line.isEmpty { continue }
            if line.count > max { line = String(line.prefix(max - 1)) + "…" }
            return line
        }
        return ""
    }
}


/// Running Claude Code sessions as Claude Code itself records them (~/.claude/sessions/<pid>.json).
public enum ClaudeSessions {
    public struct Entry {
        public var pid: Int32
        public var sessionId: String
        public var cwd: String
        public var name: String?
        /// The name is only Claude Code's placeholder (folder + id, e.g. "raccoon-b3"), not a real title.
        public var derived: Bool
        public var busy: Bool
        public var startedAt: Date?
    }

    public static func scan() -> [Entry] {
        let dir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".claude/sessions")
        guard let files = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) else { return [] }
        var out: [Entry] = []
        for url in files where url.pathExtension == "json" {
            guard let data = try? Data(contentsOf: url),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let pid = (obj["pid"] as? NSNumber)?.int32Value, Proc.isAlive(pid),
                  let id = obj["sessionId"] as? String, (obj["kind"] as? String ?? "interactive") == "interactive"
            else { continue }
            let started = (obj["startedAt"] as? NSNumber).map { Date(timeIntervalSince1970: $0.doubleValue / 1000) }
            out.append(Entry(pid: pid, sessionId: id, cwd: obj["cwd"] as? String ?? "", name: obj["name"] as? String,
                             derived: (obj["nameSource"] as? String) == "derived",
                             busy: (obj["status"] as? String) == "busy", startedAt: started))
        }
        return out
    }

    /// The scheduled task behind a session of the Claude desktop app (its task id), from the app's own record of the
    /// session (~/Library/Application Support/Claude/claude-code-sessions/<account>/<org>/<host session id>.json).
    public static func desktopScheduledTask(pid: Int32) -> String? {
        let file = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".claude/sessions/\(pid).json")
        guard let data = try? Data(contentsOf: file), let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let host = obj["hostSessionId"] as? String else { return nil }
        return desktopScheduledTask(hostSessionId: host)
    }

    public static func desktopScheduledTask(hostSessionId host: String) -> String? {
        guard !host.isEmpty, !host.contains("/") else { return nil }
        let fm = FileManager.default
        let base = fm.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Claude/claude-code-sessions")
        for account in (try? fm.contentsOfDirectory(at: base, includingPropertiesForKeys: nil)) ?? [] {
            for org in (try? fm.contentsOfDirectory(at: account, includingPropertiesForKeys: nil)) ?? [] {
                guard let d = try? Data(contentsOf: org.appendingPathComponent(host + ".json")) else { continue }
                let record = try? JSONSerialization.jsonObject(with: d) as? [String: Any]
                return record?["scheduledTaskId"] as? String
            }
        }
        return nil
    }
}
