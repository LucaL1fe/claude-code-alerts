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

    public init(id: String, name: String, state: String, detail: String, shellPid: Int32, updated: Double) {
        self.id = id
        self.name = name
        self.state = state
        self.detail = detail
        self.shellPid = shellPid
        self.updated = updated
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
    public var focused: Bool?
    public var flag: Bool?
    public var entrypoint: String?
    /// Background work still running when a turn ended (Stop hook): count and a short description.
    public var pending: Int?
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
                             busy: (obj["status"] as? String) == "busy", startedAt: started))
        }
        return out
    }
}
