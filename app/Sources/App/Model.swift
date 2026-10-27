import AppKit
import SwiftUI

/// What a session is doing, or what an alert asks of you.
enum AState: String, Codable, CaseIterable {
    case working, input, review, done, error, idle, mac, free
    /// The turn ended but Claude waits for background work (a shell, a subagent…) and continues by itself.
    case background

    var nsColor: NSColor {
        switch self {
        case .working, .background: return NSColor(srgbRed: 0.30, green: 0.55, blue: 1.00, alpha: 1)
        case .input: return NSColor(srgbRed: 1.00, green: 0.62, blue: 0.04, alpha: 1)
        case .review: return NSColor(srgbRed: 0.75, green: 0.35, blue: 0.95, alpha: 1)
        case .done, .free: return NSColor(srgbRed: 0.20, green: 0.78, blue: 0.35, alpha: 1)
        case .error, .mac: return NSColor(srgbRed: 1.00, green: 0.27, blue: 0.23, alpha: 1)
        case .idle: return NSColor(srgbRed: 0.54, green: 0.56, blue: 0.60, alpha: 1)
        }
    }

    var color: Color { Color(nsColor: nsColor) }

    var label: String {
        switch self {
        case .working: return "working"
        case .background: return "in background"
        case .input: return "needs you"
        case .review: return "plan ready"
        case .done: return "done"
        case .error: return "error"
        case .idle: return "idle"
        case .mac: return "using your Mac"
        case .free: return "Mac is free"
        }
    }

    /// Lower = more urgent.
    var urgency: Int {
        switch self {
        case .input: return 0
        case .review: return 1
        case .error: return 2
        case .done: return 3
        case .mac: return 4
        case .free: return 5
        case .working, .background: return 6
        case .idle: return 7
        }
    }

    var soundName: String {
        switch self {
        case .input: return "Ping"
        case .review: return "Purr"
        case .error: return "Basso"
        case .mac: return "Tink"
        case .free: return "Hero"
        default: return "Glass"
        }
    }
}

struct Session: Codable, Identifiable, Equatable {
    var id: String
    var autoName: String
    var customName: String?
    var claudePid: Int32
    var shellPid: Int32
    var tty: String?
    var cwd: String
    var transcript: String?
    var state: AState
    var detail: String
    var updated: Date
    /// Claude called `cca notify --needs-you` and waits for you.
    var notifyPending = false
    /// Where the session runs: vscode-terminal, vscode-panel, terminal[:bundle id], desktop, background.
    var origin: String? = nil
    /// When the session started, and when you last wrote to it (list order).
    var started: Date? = nil
    var lastPrompt: Date? = nil
    /// The Claude desktop app's scheduled task this session runs (its task id).
    var scheduledTask: String? = nil
    /// The turn running now was started by a schedule, not by you (a scheduled task's first turn).
    var unattended = false

    /// Your last interaction with the session, for the list order.
    var touched: Date { lastPrompt ?? started ?? .distantPast }

    /// Running or wanting you: these are listed on top.
    var isActive: Bool { state != .idle }

    var isBackground: Bool { origin == "background" }
    /// It runs in a VS Code terminal tab, so Close Session can close it.
    var closable: Bool { (origin ?? "vscode-terminal") == "vscode-terminal" && shellPid > 0 }

    var name: String { customName ?? autoName }

    enum CodingKeys: String, CodingKey {
        case id, autoName, customName, claudePid, shellPid, tty, cwd, transcript, state, detail, updated, notifyPending, origin, started, lastPrompt
        case scheduledTask, unattended
    }

    init(id: String, autoName: String, customName: String?, claudePid: Int32, shellPid: Int32, tty: String?, cwd: String,
         transcript: String?, state: AState, detail: String, updated: Date) {
        self.id = id; self.autoName = autoName; self.customName = customName; self.claudePid = claudePid
        self.shellPid = shellPid; self.tty = tty; self.cwd = cwd; self.transcript = transcript; self.state = state
        self.detail = detail; self.updated = updated
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        autoName = try c.decode(String.self, forKey: .autoName)
        customName = try c.decodeIfPresent(String.self, forKey: .customName)
        claudePid = try c.decode(Int32.self, forKey: .claudePid)
        shellPid = try c.decode(Int32.self, forKey: .shellPid)
        tty = try c.decodeIfPresent(String.self, forKey: .tty)
        cwd = try c.decode(String.self, forKey: .cwd)
        transcript = try c.decodeIfPresent(String.self, forKey: .transcript)
        state = try c.decode(AState.self, forKey: .state)
        detail = try c.decode(String.self, forKey: .detail)
        updated = try c.decode(Date.self, forKey: .updated)
        notifyPending = try c.decodeIfPresent(Bool.self, forKey: .notifyPending) ?? false
        origin = try c.decodeIfPresent(String.self, forKey: .origin)
        started = try c.decodeIfPresent(Date.self, forKey: .started)
        lastPrompt = try c.decodeIfPresent(Date.self, forKey: .lastPrompt)
        scheduledTask = try c.decodeIfPresent(String.self, forKey: .scheduledTask)
        unattended = try c.decodeIfPresent(Bool.self, forKey: .unattended) ?? false
    }
}

/// Where a session sits in the Sessions view. Kept after the session ends, so a resumed session finds its folder, the
/// name you gave it and its spot in the list again.
struct Place: Codable, Equatable {
    var folder: String?
    var used: Date
    var name: String? = nil
    var touched: Date? = nil
}

enum AlertStatus: String, Codable {
    case active, snoozed, muted
}

struct AlertItem: Codable, Identifiable, Equatable {
    var id = UUID()
    var sessionId: String
    var kind: AState
    var text: String
    var created = Date()
    var status: AlertStatus = .active
    var snoozeUntil: Date?
    /// Arrived while you were away: no pill or sound until you are back.
    var queued = false
    /// What raised it: a hook event name, or "notify" when Claude called `cca notify` on purpose.
    var source: String? = nil
    /// When its pill last appeared (for "fold pills into the notch after …").
    var shownAt: Date? = nil
}

/// User settings (UserDefaults).
final class AppSettings: ObservableObject {
    static let shared = AppSettings()
    private let d = UserDefaults.standard

    @Published var laterMinutes: Int { didSet { d.set(laterMinutes, forKey: "laterMinutes") } }
    @Published var sound: Bool { didSet { d.set(sound, forKey: "sound") } }
    @Published var voice: Bool { didSet { d.set(voice, forKey: "voice") } }
    @Published var macRing: Bool { didSet { d.set(macRing, forKey: "macRing") } }
    @Published var notchBand: Bool { didSet { d.set(notchBand, forKey: "notchBand") } }
    @Published var awayMinutes: Int { didSet { d.set(awayMinutes, forKey: "awayMinutes") } }
    @Published var tabDots: Bool { didSet { d.set(tabDots, forKey: "tabDots") } }
    @Published var edgeGlow: Bool { didSet { d.set(edgeGlow, forKey: "edgeGlow") } }
    /// Pills for runs without a window (scheduled tasks, `claude -p`); errors always get one.
    @Published var backgroundPills: Bool { didSet { d.set(backgroundPills, forKey: "backgroundPills") } }
    /// Seconds after which a pill folds into the notch (it stays in the list). 0 = never.
    @Published var foldSeconds: Int { didSet { d.set(foldSeconds, forKey: "foldSeconds") } }

    private init() {
        d.register(defaults: ["laterMinutes": 5, "sound": true, "voice": false, "macRing": true, "notchBand": false, "awayMinutes": 3, "foldSeconds": 0, "tabDots": true, "edgeGlow": false, "backgroundPills": false])
        laterMinutes = d.integer(forKey: "laterMinutes")
        sound = d.bool(forKey: "sound")
        voice = d.bool(forKey: "voice")
        macRing = d.bool(forKey: "macRing")
        notchBand = d.bool(forKey: "notchBand")
        awayMinutes = d.integer(forKey: "awayMinutes")
        foldSeconds = d.integer(forKey: "foldSeconds")
        tabDots = d.bool(forKey: "tabDots")
        edgeGlow = d.bool(forKey: "edgeGlow")
        backgroundPills = d.bool(forKey: "backgroundPills")
    }
}

extension Date {
    var agoLong: String {
        let a = ago
        return a == "now" ? "just now" : "\(a) ago"
    }

    var ago: String {
        let s = max(0, Int(Date().timeIntervalSince(self)))
        if s < 60 { return "now" }
        if s < 3600 { return "\(s / 60) min" }
        if s < 86400 { return "\(s / 3600) h" }
        return "\(s / 86400) d"
    }
}
