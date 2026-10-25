import AppKit
import Combine
import Shared

/// A connected VS Code window and its terminals.
struct VSWindow {
    var conn: Conn
    var windowId: String
    var workspace: String?
    var terminals: [TermInfo]
    var focused: Bool
}

/// All state and all rules. Lives on the main thread.
final class Store: ObservableObject {
    static let shared = Store()

    @Published private(set) var sessions: [String: Session] = [:] {
        // Which terminal a session just left, so the next session there (after /clear) takes over its place.
        didSet {
            for (id, s) in oldValue where sessions[id] == nil {
                if s.shellPid > 0 { lastInShell[s.shellPid] = (id, Date()) }
                hidden.remove(id)
            }
        }
    }
    /// Sessions you took off the lists (trash in the Sessions view). They keep running; one comes back when you write
    /// to it or it needs you.
    @Published private(set) var hidden: Set<String> = []
    /// Your folders in the Sessions view, and where each session sits in it.
    @Published private(set) var folders: [String: FolderInfo] = [:]
    private(set) var places: [String: Place] = [:]
    private var lastInShell: [Int32: (id: String, at: Date)] = [:]
    /// Terminals opened with New Session in a folder (shell PID → folder): their session goes there.
    private var expected: [Int32: (folder: String, at: Date)] = [:]
    @Published private(set) var alerts: [AlertItem] = []
    @Published var away = false
    @Published var summaryCount = 0
    @Published var macSessionId: String?
    @Published var editingSessionId: String?
    @Published var expandedAlertId: UUID?
    /// Debug UI steps for scripted demo recordings ("list", "close").
    var onDebugUI: ((String) -> Void)?
    /// Demo mode (for recordings) survives restarts until switched off.
    @Published var demoMode = UserDefaults.standard.bool(forKey: "demoMode") {
        didSet { UserDefaults.standard.set(demoMode, forKey: "demoMode") }
    }
    var debugAway = false
    var windows: [UUID: VSWindow] = [:]
    var lastMacUse = Date.distantPast
    private var lastPillIds: [UUID] = []
    private var saveWork: DispatchWorkItem?
    private let settings = AppSettings.shared

    /// Called after every change so overlays, menu bar and VS Code follow.
    var onChange: (() -> Void)?
    var onFlare: ((AState) -> Void)?

    private var stateURL: URL { CCA.supportDir.appendingPathComponent("state.json") }

    // MARK: - Derived

    /// In demo mode only demo and debug sessions are shown (for recordings without private data).
    private func visible(_ sessionId: String) -> Bool {
        guard demoMode else { return true }
        if sessionId.hasPrefix("debug-") { return true }
        return (sessions[sessionId]?.cwd ?? "").contains("claude-code-alerts-demo")
    }

    /// Alerts that ask for you, most urgent first (not muted).
    var waiting: [AlertItem] {
        alerts.filter { $0.status != .muted && visible($0.sessionId) }.sorted(by: Self.order)
    }

    var muted: [AlertItem] { alerts.filter { $0.status == .muted && visible($0.sessionId) }.sorted(by: Self.order) }

    /// Pills on screen right now.
    var pills: [AlertItem] {
        let fold = TimeInterval(settings.foldSeconds)
        let now = Date()
        return alerts.filter { a in
            guard a.status == .active, !a.queued, visible(a.sessionId) else { return false }
            if fold > 0, a.kind != .mac, a.kind != .free, now.timeIntervalSince(a.shownAt ?? a.created) > fold { return false }
            return true
        }.sorted(by: Self.order)
    }

    var mostUrgent: AState? { waiting.first?.kind }

    static func order(_ a: AlertItem, _ b: AlertItem) -> Bool {
        a.kind.urgency != b.kind.urgency ? a.kind.urgency < b.kind.urgency : a.created > b.created
    }

    func session(_ id: String) -> Session? { sessions[id] }

    /// Sessions for the lists: most urgent first (needs you, plan, error, done, working, idle). Inside the same
    /// urgency, the session you last wrote to comes first. That only changes when you write (or a session starts),
    /// never during tool calls, so rows don't jump around.
    var sortedSessions: [Session] {
        sessions.values.filter { visible($0.id) && !hidden.contains($0.id) && !($0.id.hasPrefix("debug-") && $0.state == .idle) }.sorted { a, b in
            if a.state.urgency != b.state.urgency { return a.state.urgency < b.state.urgency }
            return a.touched != b.touched ? a.touched > b.touched : a.id < b.id
        }
    }

    // MARK: - Persistence

    struct Saved: Codable {
        var sessions: [String: Session]
        var alerts: [AlertItem]
        var folders: [FolderInfo]?
        var places: [String: Place]?
        var hidden: [String]?
    }

    private var snapshot: Saved {
        Saved(sessions: sessions, alerts: alerts.filter { $0.kind != .mac && $0.kind != .free },
              folders: Array(folders.values), places: places, hidden: Array(hidden))
    }

    func load() {
        guard let data = try? Data(contentsOf: stateURL), let saved = try? JSONDecoder().decode(Saved.self, from: data) else { return }
        // Sessions whose Claude process is gone are dropped, with their alerts (debug sessions stay).
        sessions = saved.sessions.filter { $0.key.hasPrefix("debug-") || Proc.isAlive($0.value.claudePid) }
        alerts = saved.alerts.filter { sessions[$0.sessionId] != nil && $0.kind != .mac && $0.kind != .free }
        for i in alerts.indices { alerts[i].queued = false }
        hidden = Set((saved.hidden ?? []).filter { sessions[$0] != nil })
        folders = Dictionary((saved.folders ?? []).map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        // Places of running sessions, and of the 300 sessions used last (for resuming them).
        let kept = (saved.places ?? [:]).filter { sessions[$0.key] == nil }.sorted { $0.value.used > $1.value.used }.prefix(300)
        places = Dictionary(uniqueKeysWithValues: Array(kept))
        for (id, p) in saved.places ?? [:] where sessions[id] != nil { places[id] = Place(folder: p.folder, used: Date()) }
        for id in sessions.keys where places[id] == nil { place(id) }
    }

    /// Writes the state right away (on quit).
    func saveNow() {
        saveWork?.cancel()
        if let data = try? JSONEncoder().encode(snapshot) { try? data.write(to: stateURL, options: .atomic) }
    }

    private func save() {
        saveWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            if let data = try? JSONEncoder().encode(self.snapshot) { try? data.write(to: self.stateURL, options: .atomic) }
        }
        saveWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: work)
    }

    let tabTitles = TabTitles()

    private func changed() {
        save()
        tabTitles.sync(Array(sessions.values), enabled: settings.tabDots)
        onChange?()
    }

    // MARK: - Messages

    func handle(_ msg: Msg, _ conn: Conn) {
        switch msg.kind {
        case "hook": handleHook(msg, conn)
        case "notify": handleNotify(msg)
        case "rename":
            let id = sessionId(for: msg)
            var reply = Msg(kind: "ok")
            reply.ok = id != nil
            if let id, let name = msg.name { rename(id, to: name) }
            conn.send(reply)
        case "mac": handleMac(msg)
        case "status":
            var reply = Msg(kind: "status")
            reply.sessions = sessionInfos()
            reply.text = windows.values.map { w in
                "\((w.workspace as NSString?)?.lastPathComponent ?? "untitled") (\(w.terminals.count) terminals\(w.focused ? ", focused" : ""))"
                    + (msg.flag == true ? ": " + w.terminals.map { "\($0.name)[\($0.pid)]" }.joined(separator: " | ") : "")
            }.joined(separator: ", ")
            reply.flag = away
            conn.send(reply)
        case "settings": Actions.shared.openSettings()
        case "vscodeHello", "vscodeState": handleVSCode(msg, conn)
        case "folder": handleFolder(msg)
        case "goto":
            if let pid = msg.shellPid, let s = sessions.values.first(where: { $0.shellPid == pid }) {
                if msg.focused == true {
                    // The VS Code window already showed the tab itself.
                    markSeen(s.id)
                    changed()
                } else {
                    goTo(s.id)
                }
            }
        case "debug": handleDebug(msg)
        default: break
        }
    }

    func disconnected(_ conn: Conn) {
        if windows.removeValue(forKey: conn.id) != nil { changed() }
    }

    private func isDemoSession(_ msg: Msg) -> Bool {
        (msg.cwd ?? "").contains("claude-code-alerts-demo")
    }

    /// Registers or refreshes the session behind a message.
    @discardableResult
    private func upsert(_ msg: Msg) -> String? {
        let id = msg.sessionId ?? sessionId(for: msg) ?? msg.claudePid.map { "pid-\($0)" }
        guard let id else { return nil }
        var s = sessions[id] ?? Session(id: id, autoName: "", customName: nil, claudePid: msg.claudePid ?? 0,
                                        shellPid: msg.shellPid ?? 0, tty: msg.tty, cwd: msg.cwd ?? "",
                                        transcript: msg.transcript, state: .idle, detail: "", updated: Date())
        if s.started == nil { s.started = Date() }
        if let n = msg.name, !n.isEmpty {
            s.autoName = Self.cleanName(n)
        } else if let tn = terminalName(for: msg.shellPid ?? s.shellPid) {
            s.autoName = tn
        }
        if s.autoName.isEmpty { s.autoName = ((msg.cwd ?? s.cwd) as NSString).lastPathComponent }
        if let p = msg.claudePid, p > 0 { s.claudePid = p }
        if let p = msg.shellPid, p > 0 { s.shellPid = p }
        if let t = msg.tty { s.tty = t }
        if let c = msg.cwd, !c.isEmpty { s.cwd = c }
        if let t = msg.transcript { s.transcript = t }
        sessions[id] = s
        classifyIfNeeded(id, entrypoint: msg.entrypoint)
        place(id)
        return id
    }

    /// Strips status glyphs Claude puts in front of titles ("✳ name", spinner characters).
    static func cleanName(_ raw: String) -> String {
        var name = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        while let first = name.unicodeScalars.first, !CharacterSet.alphanumerics.contains(first) {
            name.removeFirst()
            name = name.trimmingCharacters(in: .whitespaces)
        }
        return name
    }

    /// The VS Code tab name of a terminal, unless it is just a shell or version name.
    func terminalName(for shellPid: Int32) -> String? {
        guard shellPid > 0, let t = windowOwning(shellPid)?.terminals.first(where: { $0.pid == shellPid }) else { return nil }
        let name = Self.cleanName(t.name)
        let generic: Set<String> = ["zsh", "bash", "fish", "sh", "node", "claude", "claude code", "terminal", "login"]
        if name.isEmpty || generic.contains(name.lowercased()) { return nil }
        if name.range(of: #"^\d+\.\d+\.\d+"#, options: .regularExpression) != nil { return nil }
        return name
    }

    /// Finds the session of a CLI call by its Claude process.
    func sessionId(for msg: Msg) -> String? {
        if let id = msg.sessionId, sessions[id] != nil { return id }
        if let pid = msg.claudePid, let s = sessions.values.first(where: { $0.claudePid == pid }) { return s.id }
        if let pid = msg.shellPid, pid > 0, let s = sessions.values.first(where: { $0.shellPid == pid }) { return s.id }
        return nil
    }

    private func setState(_ id: String, _ state: AState, _ detail: String? = nil) {
        guard var s = sessions[id] else { return }
        s.state = state
        if let detail, !detail.isEmpty { s.detail = detail }
        s.updated = Date()
        sessions[id] = s
    }

    private func log(_ line: String) {
        let url = CCA.supportDir.appendingPathComponent("events.log")
        let stamp = ISO8601DateFormatter().string(from: Date())
        let data = Data("\(stamp) \(line)\n".utf8)
        if let h = try? FileHandle(forWritingTo: url) {
            h.seekToEndOfFile(); h.write(data); try? h.close()
            if (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0 > 400_000 {
                try? FileManager.default.removeItem(at: url)
            }
        } else {
            try? data.write(to: url)
        }
    }

    private func handleHook(_ msg: Msg, _ conn: Conn) {
        if demoMode && !isDemoSession(msg) { return }
        guard let event = msg.event, let id = upsert(msg) else { return }
        let before = alerts.count
        defer {
            let s = sessions[id]
            log("\(event) \(s?.name ?? id) origin=\(s?.origin ?? "-") entry=\(msg.entrypoint ?? "-") state=\(s?.state.rawValue ?? "-") alert=\(alerts.count > before ? "yes" : "no")")
        }
        switch event {
        case "SessionStart":
            setState(id, .idle)
            var reply = Msg(kind: "ok")
            reply.name = sessions[id]?.customName
            conn.send(reply)
        case "UserPromptSubmit":
            // You are at this session: its reminders are answered.
            alerts.removeAll { $0.sessionId == id }
            tabTitles.forget(id)
            hidden.remove(id)
            if var s = sessions[id] {
                // A scheduled task's first prompt comes from its schedule; every later one is you writing to it.
                if s.origin == "desktop" && s.lastPrompt == nil && s.scheduledTask == nil {
                    s.scheduledTask = ClaudeSessions.desktopScheduledTask(pid: s.claudePid)
                }
                s.unattended = s.scheduledTask != nil && s.lastPrompt == nil
                s.notifyPending = false; s.lastPrompt = Date(); sessions[id] = s
            }
            setState(id, .working, "Working")
        case "PostToolUse":
            let tool = msg.toolName.map { $0.hasPrefix("mcp__") ? String($0.split(separator: "_").last ?? "") : $0 } ?? ""
            let st = sessions[id]?.state
            // Claude went on, so a permission prompt or plan was answered. Alerts Claude sent on purpose stay.
            if st == .input || st == .review {
                alerts.removeAll { $0.sessionId == id && ($0.kind == .input || $0.kind == .review) && $0.source != "notify" }
                if !alerts.contains(where: { $0.sessionId == id && $0.source == "notify" }) { setState(id, .working, "Working · \(tool)") }
            } else if st == .idle || st == .working || st == .background {
                setState(id, .working, "Working · \(tool)")
            }
            if msg.toolName?.hasPrefix("mcp__computer-use__") == true { macUsed(id) }
        case "Stop":
            if macSessionId == id { endMac(showFree: true) }
            if let n = msg.pending, n > 0 {
                // The turn ended, but Claude waits for background work and continues by itself: not done yet.
                let what = msg.toolName.map { ": \($0)" } ?? ""
                setState(id, .background, "Waiting for \(n) background task\(n == 1 ? "" : "s")\(what)")
            } else {
                raise(id, .done, msg.text?.isEmpty == false ? msg.text! : "Finished", source: event)
            }
        case "StopFailure":
            if macSessionId == id { endMac(showFree: true) }
            raise(id, .error, msg.text ?? "Stopped with an error", source: event)
        case "Notification":
            let type = msg.notificationType ?? ""
            if ["permission_prompt", "elicitation_dialog", "agent_needs_input", "elicitation_url_dialog"].contains(type) {
                raise(id, .input, msg.text ?? "Claude needs you", source: event)
            }
        case "PermissionRequest":
            // Plans and questions have their own, better alert (PreToolUse).
            if msg.toolName != "ExitPlanMode" && msg.toolName != "AskUserQuestion" {
                raise(id, .input, msg.text ?? "Claude asks for permission", source: event)
            }
        case "PreToolUse":
            let tool = msg.toolName ?? ""
            if tool == "ExitPlanMode" {
                raise(id, .review, msg.text?.isEmpty == false ? "Plan ready · " + msg.text! : "Plan ready to review", source: event)
            } else if tool == "AskUserQuestion" {
                raise(id, .input, msg.text ?? "Claude has a question", source: event)
            } else if tool.hasPrefix("mcp__computer-use__") {
                startMac(id, what: "Using your Mac")
            }
        case "SessionEnd":
            if macSessionId == id { endMac(showFree: false) }
            alerts.removeAll { $0.sessionId == id }
            sessions.removeValue(forKey: id)
        default:
            break
        }
        changed()
    }

    private func handleNotify(_ msg: Msg) {
        if demoMode && !isDemoSession(msg) { return }
        guard let id = upsert(msg) else { return }
        let kind = AState(rawValue: msg.state ?? "input") ?? .input
        if var s = sessions[id] { s.notifyPending = kind == .input; sessions[id] = s }
        raise(id, kind, msg.text ?? "Claude needs you", source: "notify")
        changed()
    }

    private func handleMac(_ msg: Msg) {
        if demoMode && !isDemoSession(msg) { return }
        guard let id = upsert(msg) else { return }
        if msg.flag == false {
            if macSessionId == id || macSessionId == nil { endMac(showFree: true) }
        } else {
            startMac(id, what: msg.text?.isEmpty == false ? msg.text! : "Using your Mac")
        }
        changed()
    }

    // MARK: - Rules

    /// Creates an alert unless you are already looking at that session.
    /// One alert per session; a new event only replaces it when it is at least as urgent, so "done" never hides
    /// "needs you", and Claude's generic follow-up messages never hide a specific question or a plan.
    func raise(_ id: String, _ kind: AState, _ text: String, source: String = "") {
        // Claude asked for you on purpose (cca notify) and is now waiting: that stays the session's state and
        // alert until you act, even if you were looking at the tab when it came in.
        if source != "notify", let s = sessions[id], s.state == .input, s.notifyPending, kind.urgency > AState.input.urgency { return }
        // A plan waits for approval: Claude's generic "needs your approval" message must not replace it,
        // also when no alert exists because you were looking at the tab.
        let generic = source == "Notification" || source == "PermissionRequest"
        if let st = sessions[id]?.state, st == .review, kind == .input, generic { return }
        if let st = sessions[id]?.state, st == .input, kind == .input, source == "Notification",
           let s = sessions[id], Date().timeIntervalSince(s.updated) < 300 { return }
        if let existing = alerts.first(where: { $0.sessionId == id && $0.kind != .mac && $0.kind != .free }) {
            var keep = existing.kind.urgency < kind.urgency
            if existing.kind == .review && kind == .input && (source == "Notification" || source == "PermissionRequest") { keep = true }
            if existing.kind == kind && source == "Notification" && Date().timeIntervalSince(existing.created) < 300 { keep = true }
            if keep {
                setState(id, existing.kind, existing.text)
                return
            }
        }
        setState(id, kind, text)
        guard let s = sessions[id] else { return }
        // Runs without a window (scheduled tasks, claude -p): listed, but no pill unless it failed or you want them.
        if s.isBackground && kind != .error && !settings.backgroundPills { return }
        // The same for a turn a schedule started in the Claude desktop app finishing; a question or an error still comes.
        if s.unattended && kind == .done && !settings.backgroundPills { return }
        if isLookingAt(s) {
            // You see it already: a finished session needs no dot or alert.
            if kind == .done { setState(id, .idle) }
            return
        }
        hidden.remove(id)
        alerts.removeAll { $0.sessionId == id && $0.kind != .mac && $0.kind != .free }
        var alert = AlertItem(sessionId: id, kind: kind, text: text)
        alert.queued = away
        alert.source = source
        alert.shownAt = away ? nil : Date()
        alerts.append(alert)
        if !away { announce(kind, s) }
    }

    /// Flare, sound, voice for something new on screen.
    /// No flare while a session drives the Mac: the flare windows would sit where Claude wants to click.
    func announce(_ kind: AState, _ s: Session?) {
        // The glow is for computer use ("Mac is free"); for other alerts only if switched on in Settings.
        if macSessionId == nil && kind != .mac && (kind == .free || settings.edgeGlow) { onFlare?(kind) }
        Actions.shared.sound(kind)
        if let s { Actions.shared.speak("\(s.name), \(kind.label)") }
    }

    static let claudeDesktop = "com.anthropic.claudefordesktop"

    /// True when that session's terminal is the active tab of the focused VS Code window and VS Code is in front.
    /// For a session of the Claude desktop app: the app is in front and this is the session you wrote to last there
    /// (the app doesn't tell which session it shows; the one you just wrote in is the one you have open).
    func isLookingAt(_ s: Session) -> Bool {
        guard !away else { return false }
        let front = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
        if s.origin == "desktop" {
            guard front == Self.claudeDesktop, s.lastPrompt != nil, !s.unattended else { return false }
            let mine = sessions.values.filter { $0.origin == "desktop" && !$0.unattended && $0.lastPrompt != nil }
            return mine.max { $0.lastPrompt! < $1.lastPrompt! }?.id == s.id
        }
        guard front == "com.microsoft.VSCode" else { return false }
        return windows.values.contains { w in w.focused && w.terminals.contains { $0.pid == s.shellPid && $0.active } }
    }

    // MARK: - Your actions

    func quiet(_ alertId: UUID) {
        guard let i = alerts.firstIndex(where: { $0.id == alertId }) else { return }
        if alerts[i].kind == .mac || alerts[i].kind == .free { alerts.remove(at: i) } else { alerts[i].status = .muted }
        changed()
    }

    func later(_ alertId: UUID) {
        guard let i = alerts.firstIndex(where: { $0.id == alertId }) else { return }
        alerts[i].status = .snoozed
        alerts[i].snoozeUntil = Date().addingTimeInterval(TimeInterval(settings.laterMinutes * 60))
        changed()
    }

    func done(_ alertId: UUID) {
        guard let i = alerts.firstIndex(where: { $0.id == alertId }) else { return }
        let a = alerts.remove(at: i)
        if a.kind == .done || a.kind == .error { setState(a.sessionId, .idle) }
        changed()
    }

    func goTo(alert alertId: UUID) {
        guard let a = alerts.first(where: { $0.id == alertId }) else { return }
        goTo(a.sessionId)
    }

    var onGoTo: (() -> Void)?

    func goTo(_ sessionId: String) {
        onGoTo?()
        markSeen(sessionId)
        if let s = sessions[sessionId] { Actions.shared.goTo(s, owner: windowOwning(s.shellPid)) }
        changed()
    }

    func muteAll() {
        for i in alerts.indices where alerts[i].kind != .mac { alerts[i].status = .muted }
        changed()
    }

    func rename(_ sessionId: String, to name: String) {
        let clean = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var s = sessions[sessionId], !clean.isEmpty else { return }
        s.customName = clean
        sessions[sessionId] = s
        // The tab follows through its title (see TabTitles), so the colored dots keep working.
        tabTitles.forget(sessionId)
        changed()
    }

    /// You looked at the session: its reminders go away, a finished session becomes idle.
    func markSeen(_ sessionId: String) {
        let before = alerts.count
        if var s = sessions[sessionId], s.notifyPending { s.notifyPending = false; sessions[sessionId] = s }
        alerts.removeAll { $0.sessionId == sessionId && $0.kind != .mac }
        if let s = sessions[sessionId], s.state == .done || s.state == .error { setState(sessionId, .idle) }
        if alerts.count != before { save() }
    }

    // MARK: - Computer use

    func startMac(_ id: String, what: String) {
        guard settings.macRing else { return }
        lastMacUse = Date()
        guard macSessionId != id else { return }
        if macSessionId != nil { endMac(showFree: false) }
        macSessionId = id
        setState(id, .mac, what)
        alerts.removeAll { $0.kind == .mac || $0.kind == .free }
        alerts.append(AlertItem(sessionId: id, kind: .mac, text: what))
        announce(.mac, sessions[id])
        let alertId = alerts.last!.id
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in
            self?.alerts.removeAll { $0.id == alertId }
            self?.onChange?()
        }
    }

    func macUsed(_ id: String) {
        if macSessionId == id { lastMacUse = Date() }
    }

    func endMac(showFree: Bool) {
        guard let id = macSessionId else { return }
        macSessionId = nil
        alerts.removeAll { $0.kind == .mac }
        if sessions[id]?.state == .mac { setState(id, .working, "Working") }
        if showFree {
            let free = AlertItem(sessionId: id, kind: .free, text: "You can use your Mac again")
            alerts.append(free)
            announce(.free, nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in
                self?.alerts.removeAll { $0.id == free.id }
                self?.onChange?()
            }
        }
        changed()
    }

    // MARK: - Where a session runs

    static let shells: Set<String> = ["zsh", "bash", "fish", "sh", "dash", "nu", "login", "tmux", "screen"]

    /// Decides where a session lives from facts, never guesses: Claude Code's entry point, the parent process and the
    /// first app above it. Used by "go to" and to keep background runs quiet.
    static func classify(claudePid: Int32, entrypoint: String?) -> String {
        if let e = entrypoint, e.contains("vscode") { return "vscode-panel" }
        // Print mode and the SDKs (claude -p, scheduled tasks, scripts) have no window to go to.
        if let e = entrypoint, e.hasPrefix("sdk") { return "background" }
        guard claudePid > 0, let me = Proc.info(claudePid) else { return "background" }
        let parent = Proc.info(me.ppid)
        let underShell = parent.map { shells.contains($0.comm) || $0.comm.hasPrefix("-") } ?? false
        var pid = me.ppid
        var host: NSRunningApplication?
        for _ in 0..<14 {
            guard pid > 1 else { break }
            if let app = NSRunningApplication(processIdentifier: pid), app.activationPolicy == .regular { host = app; break }
            guard let info = Proc.info(pid) else { break }
            pid = info.ppid
        }
        let bundle = host?.bundleIdentifier ?? ""
        if underShell {
            if bundle.contains("VSCode") { return "vscode-terminal" }
            return bundle.isEmpty ? "terminal" : "terminal:" + bundle
        }
        let sessionFile = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".claude/sessions/\(claudePid).json")
        if bundle.hasPrefix("com.anthropic."), FileManager.default.fileExists(atPath: sessionFile.path) { return "desktop" }
        return "background"
    }

    private func classifyIfNeeded(_ id: String, entrypoint: String? = nil) {
        guard var s = sessions[id], s.origin == nil || entrypoint != nil, !id.hasPrefix("debug-") else { return }
        let o = Self.classify(claudePid: s.claudePid, entrypoint: entrypoint)
        guard s.origin != o else { return }
        s.origin = o
        if o == "desktop" && s.lastPrompt == nil {
            // A scheduled task of the Claude app: its first turn runs without you.
            s.scheduledTask = ClaudeSessions.desktopScheduledTask(pid: s.claudePid)
            s.unattended = s.scheduledTask != nil
        }
        sessions[id] = s
    }

    // MARK: - Discovery

    private var lastDiscovery = Date.distantPast

    /// Picks up every running Claude session from Claude Code's own records, also ones no hook has reported yet,
    /// and keeps their names current.
    func discover() {
        lastDiscovery = Date()
        var dirty = false
        for e in ClaudeSessions.scan() {
            let shell = Proc.info(e.pid).flatMap { Proc.info($0.ppid) }
            if var s = sessions[e.sessionId] {
                // A placeholder name never replaces the title the hooks found; it only stands in until there is one.
                let n = e.derived ? (s.autoName == e.name ? title(of: e, transcript: s.transcript, shell: shell?.pid) : nil) : e.name
                if let n, !n.isEmpty, s.autoName != n { s.autoName = n; dirty = true }
                if s.claudePid != e.pid { s.claudePid = e.pid; dirty = true }
                if let sh = shell, s.shellPid != sh.pid { s.shellPid = sh.pid; s.tty = sh.tty; dirty = true }
                if s.origin == nil { dirty = true }
                if let st = e.startedAt, s.started != st { s.started = st; dirty = true }
                sessions[e.sessionId] = s
                classifyIfNeeded(e.sessionId)
            } else {
                if demoMode && !e.cwd.contains("claude-code-alerts-demo") { continue }
                // The same terminal may still hold an older session of this process.
                sessions = sessions.filter { $0.value.claudePid != e.pid || $0.key.hasPrefix("debug-") }
                let name = e.derived ? title(of: e, transcript: nil, shell: shell?.pid) : e.name
                sessions[e.sessionId] = Session(id: e.sessionId, autoName: name ?? (e.cwd as NSString).lastPathComponent,
                                                customName: nil, claudePid: e.pid, shellPid: shell?.pid ?? 0,
                                                tty: shell?.tty, cwd: e.cwd, transcript: nil,
                                                state: e.busy ? .working : .idle, detail: "", updated: Date())
                sessions[e.sessionId]?.started = e.startedAt ?? Date()
                classifyIfNeeded(e.sessionId)
                place(e.sessionId)
                dirty = true
            }
        }
        if dirty { changed() }
    }

    /// The real title of a session Claude Code only has a placeholder name for: the transcript's title,
    /// else its VS Code tab (Claude Code puts the title there), else the placeholder.
    private func title(of e: ClaudeSessions.Entry, transcript: String?, shell: Int32?) -> String? {
        Transcript.name(path: transcript) ?? terminalName(for: shell ?? 0) ?? e.name
    }

    // MARK: - Timers (called every second)

    func tick() {
        if Date().timeIntervalSince(lastDiscovery) > 15 { discover() }
        var dirty = false
        let now = Date()
        for i in alerts.indices where alerts[i].status == .snoozed {
            if let until = alerts[i].snoozeUntil, until <= now {
                alerts[i].status = .active
                alerts[i].snoozeUntil = nil
                alerts[i].shownAt = Date()
                dirty = true
                if !away { Actions.shared.sound(alerts[i].kind) }
            }
        }
        if macSessionId != nil, now.timeIntervalSince(lastMacUse) > 60 { endMac(showFree: true); dirty = true }
        let pillIds = pills.map(\.id)
        if pillIds != lastPillIds { lastPillIds = pillIds; dirty = true }
        // Drop sessions whose Claude process ended without SessionEnd.
        for (id, s) in sessions where !id.hasPrefix("debug-") && s.claudePid > 0 && !Proc.isAlive(s.claudePid) {
            sessions.removeValue(forKey: id)
            alerts.removeAll { $0.sessionId == id }
            dirty = true
        }
        if dirty { changed() }
    }

    // MARK: - Away

    func setAway(_ value: Bool) {
        guard value != away else { return }
        away = value
        if !value {
            let queued = alerts.filter { $0.queued }
            for i in alerts.indices where alerts[i].queued {
                alerts[i].queued = false
                alerts[i].shownAt = Date()
            }
            if !queued.isEmpty {
                summaryCount = queued.count
                let top = queued.sorted(by: Self.order).first!.kind
                if settings.edgeGlow { onFlare?(top) }
                Actions.shared.sound(top)
                DispatchQueue.main.asyncAfter(deadline: .now() + 20) { [weak self] in
                    self?.summaryCount = 0
                    self?.onChange?()
                }
            }
        }
        changed()
    }

    // MARK: - VS Code

    private func handleVSCode(_ msg: Msg, _ conn: Conn) {
        var w = windows[conn.id] ?? VSWindow(conn: conn, windowId: msg.windowId ?? conn.id.uuidString, workspace: nil, terminals: [], focused: false)
        if let ws = msg.workspace { w.workspace = ws }
        if let t = msg.terminals { w.terminals = t }
        if let f = msg.focused { w.focused = f }
        windows[conn.id] = w
        if msg.kind == "vscodeHello" {
            conn.send(sessionsMessage())
            // A (re)loaded window forgets the tab titles: write every session's name again.
            discover()
            let pids = Set(w.terminals.map(\.pid))
            tabTitles.restore(sessions.values.filter { pids.contains($0.shellPid) }, enabled: settings.tabDots)
        }
        // Seen: the focused window's active terminal.
        if w.focused, let active = w.terminals.first(where: { $0.active }),
           let s = sessions.values.first(where: { $0.shellPid == active.pid }),
           NSWorkspace.shared.frontmostApplication?.bundleIdentifier == "com.microsoft.VSCode" {
            if alerts.contains(where: { $0.sessionId == s.id && $0.kind != .mac && $0.status == .active })
                || s.state == .done || s.state == .error {
                markSeen(s.id)
                changed()
            }
        }
    }

    func windowOwning(_ shellPid: Int32) -> VSWindow? {
        windows.values.first { $0.terminals.contains { $0.pid == shellPid } }
    }

    func sessionInfos() -> [SessionInfo] {
        sortedSessions.map {
            SessionInfo(id: $0.id, name: $0.name, state: $0.state.rawValue, detail: $0.detail, shellPid: $0.shellPid,
                        updated: $0.updated.timeIntervalSince1970, folder: folderOf($0.id), touched: $0.touched.timeIntervalSince1970)
        }
    }

    func sessionsMessage() -> Msg {
        var m = Msg(kind: "sessions")
        m.sessions = sessionInfos()
        m.folders = visibleFolders
        return m
    }

    func broadcastSessions() {
        let m = sessionsMessage()
        for w in windows.values { w.conn.send(m) }
    }

    // MARK: - Folders (the Sessions view in VS Code)

    /// In demo mode only the folders made in demo mode.
    var visibleFolders: [FolderInfo] { folders.values.filter { ($0.demo ?? false) == demoMode } }

    /// The folder a session is in, if that folder still exists (nil = top level).
    private func folderOf(_ sessionId: String) -> String? {
        places[sessionId]?.folder.flatMap { folders[$0] != nil ? $0 : nil }
    }

    /// Gives a session its place once. A resumed session keeps its old one. A session in a terminal opened with New Session
    /// in a folder goes to that folder. A session that follows another in the same terminal (/clear, or a new `claude` in
    /// that tab) takes over that one's place. Any other goes to the top level.
    private func place(_ id: String) {
        guard places[id] == nil, let s = sessions[id] else { return }
        let inTerminal = s.shellPid > 0 && (s.origin ?? "").contains("terminal")
        let prior = !inTerminal ? nil : sessions.values.first { $0.id != id && $0.shellPid == s.shellPid }?.id
            ?? lastInShell[s.shellPid].flatMap { Date().timeIntervalSince($0.at) < 300 ? $0.id : nil }
        if s.shellPid > 0, let e = expected.removeValue(forKey: s.shellPid), Date().timeIntervalSince(e.at) < 600 {
            places[id] = Place(folder: e.folder, used: Date())
        } else {
            places[id] = Place(folder: prior.flatMap { places[$0]?.folder }, used: Date())
        }
    }

    /// The folders directly in `parent` (nil = top level), in their order.
    private func siblings(_ parent: String?) -> [String] {
        folders.values.filter { $0.parent == parent }
            .sorted { ($0.order ?? 0, $0.name.lowercased()) < ($1.order ?? 0, $1.name.lowercased()) }.map(\.id)
    }

    /// After the last folder in `parent`.
    private func nextOrder(_ parent: String?) -> Double {
        (folders.values.filter { $0.parent == parent }.compactMap(\.order).max() ?? -1) + 1
    }

    /// Folder `id` is `folder` itself or one of its subfolders.
    private func isWithin(_ id: String?, _ folder: String) -> Bool {
        var cur = id
        for _ in 0..<64 {
            guard let c = cur else { return false }
            if c == folder { return true }
            cur = folders[c]?.parent
        }
        return true
    }

    private func handleFolder(_ msg: Msg) {
        switch msg.event {
        case "create":
            let name = (msg.name ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty else { return }
            let parent = msg.folder.flatMap { folders[$0] != nil ? $0 : nil }
            let id = UUID().uuidString.lowercased()
            folders[id] = FolderInfo(id: id, name: name, parent: parent, order: nextOrder(parent), demo: demoMode ? true : nil)
        case "rename":
            let name = (msg.name ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard let id = msg.folder, folders[id] != nil, !name.isEmpty else { return }
            folders[id]?.name = name
        case "delete":
            // Only the folder goes: what was in it moves up one level.
            guard let id = msg.folder, let f = folders[id] else { return }
            for sub in siblings(id) { folders[sub]?.parent = f.parent; folders[sub]?.order = nextOrder(f.parent) }
            for (sid, p) in places where p.folder == id { places[sid]?.folder = f.parent }
            folders.removeValue(forKey: id)
        case "move":
            move(msg.ids ?? [], into: msg.folder)
        case "hide":
            // Off the lists, not ended: it keeps running and comes back when you write to it or it needs you.
            for item in msg.ids ?? [] where item.hasPrefix("s:") {
                let id = String(item.dropFirst(2))
                guard sessions[id] != nil else { continue }
                markSeen(id)
                hidden.insert(id)
            }
        case "shift":
            // Move Up / Move Down: swaps the folder with its neighbor.
            guard let id = msg.folder, let f = folders[id] else { return }
            var list = siblings(f.parent)
            guard let i = list.firstIndex(of: id) else { return }
            let j = msg.text == "up" ? i - 1 : i + 1
            guard list.indices.contains(j) else { return }
            list.swapAt(i, j)
            for (n, sib) in list.enumerated() { folders[sib]?.order = Double(n) }
        case "expect":
            guard let pid = msg.shellPid, pid > 0, let f = msg.folder, folders[f] != nil else { return }
            expected[pid] = (f, Date())
            return
        default:
            return
        }
        changed()
    }

    /// Moves sessions ("s:<id>") and folders ("f:<id>") into a folder (nil = top level). A folder never goes into itself
    /// or one of its subfolders.
    private func move(_ items: [String], into target: String?) {
        let parent = target.flatMap { folders[$0] != nil ? $0 : nil }
        for item in items {
            let id = String(item.dropFirst(2))
            if item.hasPrefix("f:"), let f = folders[id], f.parent != parent, !isWithin(parent, id) {
                folders[id]?.order = nextOrder(parent)
                folders[id]?.parent = parent
            }
            if item.hasPrefix("s:"), sessions[id] != nil { places[id] = Place(folder: parent, used: Date()) }
        }
    }

    // MARK: - Debug

    private func handleDebug(_ msg: Msg) {
        switch msg.event {
        case "event":
            // With --shell of a real session, the event goes to that session (and --name renames it).
            let real = msg.shellPid.flatMap { pid in sessions.values.first { $0.shellPid == pid && !$0.id.hasPrefix("debug-") } }
            let id = real?.id ?? msg.sessionId ?? "debug-demo"
            if real == nil {
                var m = msg
                m.sessionId = id
                m.claudePid = 0
                upsert(m)
                if var s = sessions[id], let n = msg.name { s.autoName = n; sessions[id] = s }
            } else if var s = sessions[id], let n = msg.name {
                s.customName = n
                sessions[id] = s
            }
            let kind = AState(rawValue: msg.state ?? "done") ?? .done
            switch kind {
            case .working, .idle:
                setState(id, kind, msg.text)
            case .mac:
                startMac(id, what: msg.text?.isEmpty == false ? msg.text! : "Using your Mac")
            case .free:
                macSessionId = id
                endMac(showFree: true)
            default:
                raise(id, kind, msg.text?.isEmpty == false ? msg.text! : kind.label)
            }
        case "away":
            debugAway = msg.flag ?? false
            setAway(debugAway)
        case "demo":
            demoMode = msg.flag ?? false
        case "clear":
            alerts.removeAll()
            sessions = sessions.filter { !$0.key.hasPrefix("debug-") }
            summaryCount = 0
        case "goto":
            if let pid = msg.shellPid, let s = sessions.values.first(where: { $0.shellPid == pid && $0.id.hasPrefix("debug-") })
                ?? sessions.values.first(where: { $0.shellPid == pid }) {
                goTo(s.id)
            }
        case "ui":
            // Scripted demo steps: the same actions as the buttons, for recordings.
            let first = pills.first ?? waiting.first
            switch msg.text ?? "" {
            case "expand": expandedAlertId = waiting.first?.id
            case "quiet": if let a = first { quiet(a.id) }
            case "later": if let a = first { later(a.id) }
            case "done": if let a = first { done(a.id) }
            case "goto": if let a = first { goTo(alert: a.id) }
            default: onDebugUI?(msg.text ?? "")
            }
        case "endsession":
            if let id = msg.sessionId { sessions.removeValue(forKey: id); alerts.removeAll { $0.sessionId == id } }
        default:
            break
        }
        changed()
    }
}
