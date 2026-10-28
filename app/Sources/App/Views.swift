import Shared
import SwiftUI

// MARK: - Small parts

/// Makes the window holding this view the key window, so a text field in a non-activating panel gets the keyboard.
struct MakeKeyWindow: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView { NSView() }
    func updateNSView(_ view: NSView, context: Context) {
        DispatchQueue.main.async { view.window?.makeKey() }
    }
}

/// A session's dot: filled, or a ring while Claude waits for background work.
struct StateDot: View {
    let state: AState
    var size: CGFloat = 8

    var body: some View {
        if state == .background {
            Circle().strokeBorder(state.color, lineWidth: max(1.5, size * 0.22)).frame(width: size, height: size)
        } else {
            Circle().fill(state.color).frame(width: size, height: size)
        }
    }
}

struct IconButton: View {
    let symbol: String
    let help: String
    var filled: Color? = nil
    var size: CGFloat = 24
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: size * 0.46, weight: .bold))
                .foregroundColor(filled != nil ? .black : .white.opacity(hover ? 1 : 0.85))
                .frame(width: size, height: size)
                .background(Circle().fill(filled ?? Color.white.opacity(hover ? 0.22 : 0.12)))
        }
        .buttonStyle(.plain)
        .help(help)
        .onHover { hover = $0 }
    }
}

/// The four actions, same order everywhere: quiet, later, done, go to.
struct ActionButtons: View {
    let alert: AlertItem
    var size: CGFloat = 24
    @ObservedObject private var settings = AppSettings.shared

    var body: some View {
        HStack(spacing: size * 0.25) {
            IconButton(symbol: "xmark", help: alert.kind == .mac || alert.kind == .free ? "Dismiss" : "Quiet: no more pings, stays in the list",
                       size: size) { Store.shared.quiet(alert.id) }
            if alert.kind != .mac && alert.kind != .free {
                IconButton(symbol: "clock", help: "Again in \(settings.laterMinutes) min", size: size) { Store.shared.later(alert.id) }
                IconButton(symbol: "checkmark", help: "Done", size: size) { Store.shared.done(alert.id) }
                if Store.shared.session(alert.sessionId)?.isBackground != true {
                    IconButton(symbol: "arrow.right", help: "Go to this session", filled: alert.kind.color, size: size) {
                        Store.shared.goTo(alert: alert.id)
                    }
                }
            }
        }
    }
}

/// Session name with a pencil; click the pencil to rename in place.
/// `context` keeps two fields for the same session (pill, list row, session row) from editing at once.
struct NameField: View {
    let session: Session?
    var fontSize: CGFloat = 13
    var context = "pill"
    @ObservedObject private var store = Store.shared
    @State private var draft = ""
    @FocusState private var focused: Bool

    var body: some View {
        if let session, store.editingSessionId == "\(context):\(session.id)" {
            HStack(spacing: 6) {
                TextField("Name", text: $draft)
                    .textFieldStyle(.plain)
                    .font(.system(size: fontSize, weight: .semibold))
                    .foregroundColor(.white)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(RoundedRectangle(cornerRadius: 5).fill(Color.white.opacity(0.12)))
                    .focused($focused)
                    .background(MakeKeyWindow())
                    .onSubmit { commit(session) }
                    .onExitCommand { Rename.end() }
                    .frame(minWidth: 120)
                Text("Enter saves").font(.system(size: fontSize * 0.75, weight: .semibold)).foregroundColor(.white.opacity(0.5))
            }
            .onAppear {
                draft = session.name
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) { focused = true }
            }
        } else {
            HStack(spacing: 5) {
                Text(session?.name ?? "Session")
                    .font(.system(size: fontSize, weight: .semibold))
                    .foregroundColor(.white)
                    .lineLimit(1).truncationMode(.tail)
                if let session {
                    Button { Rename.begin("\(context):\(session.id)") } label: {
                        Image(systemName: "pencil").font(.system(size: fontSize * 0.75, weight: .semibold))
                            .foregroundColor(.white.opacity(0.5))
                    }
                    .buttonStyle(.plain)
                    .help("Rename")
                }
            }
        }
    }

    private func commit(_ session: Session) {
        store.rename(session.id, to: draft)
        Rename.end()
    }
}

/// Renaming needs the keyboard: our app comes to the front for it and hands it back afterwards.
enum Rename {
    private static var previousApp: NSRunningApplication?

    static func begin(_ key: String) {
        let front = NSWorkspace.shared.frontmostApplication
        if front?.bundleIdentifier != Bundle.main.bundleIdentifier { previousApp = front }
        Store.shared.editingSessionId = key
        NSApp.activate()
    }

    static func end() {
        Store.shared.editingSessionId = nil
        previousApp?.activate()
        previousApp = nil
    }
}

// MARK: - Pill

struct PillView: View {
    let alert: AlertItem
    @ObservedObject private var store = Store.shared

    var body: some View {
        let session = store.session(alert.sessionId)
        let c = alert.kind.color
        HStack(spacing: 10) {
            Circle().fill(c).frame(width: 9, height: 9)
            VStack(alignment: .leading, spacing: 1) {
                NameField(session: session)
                Text(alert.text)
                    .font(.system(size: 11.5, weight: .medium))
                    .foregroundColor(c)
                    .lineLimit(1).truncationMode(.tail)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Text(alert.kind.label)
                .font(.system(size: 11, weight: .bold))
                .foregroundColor(c)
                .fixedSize()
            ActionButtons(alert: alert)
        }
        .padding(.leading, 14).padding(.trailing, 8)
        .frame(width: 440, height: 48)
        .background(Capsule().fill(Color.black))
        .overlay(Capsule().strokeBorder(c, lineWidth: 1.5))
        .shadow(color: c.opacity(0.5), radius: 10)
        .contentShape(Capsule())
        .onTapGesture {
            if alert.kind != .mac && alert.kind != .free && session?.isBackground != true { store.goTo(alert: alert.id) }
        }
    }
}

struct PillStack: View {
    @ObservedObject private var store = Store.shared
    var onMore: () -> Void = {}

    var body: some View {
        let pills = store.pills
        VStack(spacing: 7) {
            if store.summaryCount > 0 {
                Text("While you were away · \(store.summaryCount)")
                    .font(.system(size: 12, weight: .bold)).foregroundColor(.white)
                    .padding(.horizontal, 14).frame(height: 26)
                    .background(Capsule().fill(Color.black))
            }
            ForEach(Array(pills.prefix(4))) { PillView(alert: $0) }
            if pills.count > 4 {
                Button(action: onMore) {
                    Text("+\(pills.count - 4) more").font(.system(size: 12, weight: .bold)).foregroundColor(.white)
                        .padding(.horizontal, 14).frame(height: 26)
                        .background(Capsule().fill(Color.black))
                }.buttonStyle(.plain)
            }
        }
        .padding(14)
        .fixedSize()
    }
}

// MARK: - List (menu bar and notch)

struct AlertRow: View {
    let alert: AlertItem
    @Binding var expanded: UUID?
    var dim = false
    @ObservedObject private var store = Store.shared
    @State private var hover = false

    var body: some View {
        let session = store.session(alert.sessionId)
        let c = alert.kind.color
        let open = expanded == alert.id
        HStack(alignment: open ? .top : .center, spacing: 9) {
            Circle().fill(c).frame(width: 8, height: 8).padding(.top, open ? 5 : 0)
            VStack(alignment: .leading, spacing: 2) {
                NameField(session: session, fontSize: 12.5, context: "row")
                Text(alert.text)
                    .font(.system(size: 11.5, weight: .medium)).foregroundColor(c)
                    .lineLimit(open ? 4 : 1).truncationMode(.tail)
                    .fixedSize(horizontal: false, vertical: open)
                if open {
                    Text("\(alert.created.agoLong) · \(alert.status == .snoozed ? "snoozed" : alert.kind.label)")
                        .font(.system(size: 10.5, weight: .medium)).foregroundColor(.white.opacity(0.45))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if hover || open {
                ActionButtons(alert: alert, size: 22)
            } else {
                Text(alert.status == .snoozed ? "snoozed" : alert.created.ago)
                    .font(.system(size: 10.5, weight: .semibold)).foregroundColor(.white.opacity(0.45))
            }
        }
        .padding(.horizontal, 10).padding(.vertical, open ? 9 : 7)
        .background(
            RoundedRectangle(cornerRadius: open ? 14 : 8)
                .fill(open ? Color.black : Color.white.opacity(hover ? 0.10 : 0.05))
        )
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(open ? c : .clear, lineWidth: 1.5))
        .opacity(dim ? 0.5 : 1)
        .contentShape(Rectangle())
        .onHover { hover = $0 }
        .onTapGesture { withAnimation(.easeOut(duration: 0.15)) { expanded = open ? nil : alert.id } }
    }
}

struct SessionRow: View {
    let session: Session
    var depth = 0
    @ObservedObject private var store = Store.shared
    @State private var hover = false

    var body: some View {
        let id = session.id
        let folder = store.shownFolder(of: id)
        HStack(spacing: 9) {
            StateDot(state: session.state)
            VStack(alignment: .leading, spacing: 1) {
                NameField(session: session, fontSize: 12, context: "session")
                Text(session.detail.isEmpty ? session.state.label : session.detail)
                    .font(.system(size: 11, weight: .medium)).foregroundColor(session.state.color).lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Text("\(session.isBackground ? "background" : session.state.label) · \(session.updated.ago)")
                .font(.system(size: 10.5, weight: .semibold)).foregroundColor(.white.opacity(0.45))
            if hover && !session.isBackground {
                IconButton(symbol: "arrow.right", help: "Go to this session", filled: session.state.color, size: 20) {
                    store.goTo(session.id)
                }
            }
        }
        .padding(.leading, 10 + CGFloat(depth) * 16).padding(.trailing, 10).padding(.vertical, 6)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.white.opacity(hover ? 0.10 : 0.0)))
        .contentShape(Rectangle())
        .onHover { hover = $0 }
        .onTapGesture { if !session.isBackground { store.goTo(session.id) } }
        // The same menu as in VS Code's Claude Sessions view.
        .contextMenu {
            Button("New Session") { store.newSession(in: folder) }
            Button("New Folder…") { NewFolder.begin(in: folder) }
            Divider()
            if !session.isBackground { Button("Go to Session") { store.goTo(id) } }
            Menu("Set State") {
                Button("Needs You") { store.sessionsAction("state", ids: ["s:" + id], state: "input") }
                Button("Plan Ready") { store.sessionsAction("state", ids: ["s:" + id], state: "review") }
                Button("Done") { store.sessionsAction("state", ids: ["s:" + id], state: "done") }
                Divider()
                Button("Idle") { store.sessionsAction("state", ids: ["s:" + id], state: "idle") }
            }
            if session.limit?.auto == true {
                Button("Don't Continue by Itself") { store.keepPaused(id) }
            }
            Divider()
            MoveMenu(item: "s:" + id)
            if folder != nil { Button("Move to Top Level") { store.sessionsAction("move", ids: ["s:" + id], folder: nil) } }
            Divider()
            Button("Rename…") { Rename.begin("session:\(id)") }
            if session.closable {
                Button("Close Session") { CloseSession.begin(session) }
            } else {
                Button("Remove from List") { store.sessionsAction("hide", ids: ["s:" + id]) }
            }
        }
    }
}

/// Move to Folder ▸: the top level and every folder (shown as its path), except where a folder can't go.
struct MoveMenu: View {
    let item: String
    @ObservedObject private var store = Store.shared

    var body: some View {
        let moving = item.hasPrefix("f:") ? String(item.dropFirst(2)) : nil
        let targets = store.visibleFolders
            .filter { f in moving.map { !store.ancestors(f.id).contains($0) } ?? true }
            .map { f in (id: f.id, path: store.ancestors(f.id).reversed().compactMap { store.folderName($0) }.joined(separator: " / ")) }
            .sorted { $0.path.localizedStandardCompare($1.path) == .orderedAscending }
        Menu("Move to Folder") {
            Button("Top Level") { store.sessionsAction("move", ids: [item], folder: nil) }
            if !targets.isEmpty { Divider() }
            ForEach(targets, id: \.id) { t in Button(t.path) { store.sessionsAction("move", ids: [item], folder: t.id) } }
        }
    }
}

/// New Folder: makes "New Folder" and lets you name it right away.
/// Close Session: its VS Code tab closes, which ends Claude (`claude --resume` continues it later). Asks first while
/// Claude is still working.
enum CloseSession {
    static func begin(_ session: Session) {
        DispatchQueue.main.async {
            let s = Store.shared.sessions[session.id] ?? session
            if s.state == .working || s.state == .background {
                let previous = NSWorkspace.shared.frontmostApplication
                let alert = NSAlert()
                alert.messageText = "Claude is still working in “\(s.name)”."
                alert.informativeText = "Closing the session stops it in the middle of its work."
                alert.addButton(withTitle: "Close Session")
                alert.addButton(withTitle: "Cancel")
                NSApp.activate()
                let ok = alert.runModal() == .alertFirstButtonReturn
                previous?.activate()
                guard ok else { return }
            }
            Store.shared.sessionsAction("close", ids: ["s:" + s.id])
        }
    }
}

enum NewFolder {
    static func begin(in parent: String?) {
        let id = Store.shared.createFolder("New Folder", in: parent)
        if let parent { Store.shared.collapsed.remove(parent) }
        Rename.begin("folder:\(id)")
    }
}

/// A folder's name, colored like in VS Code when something inside waits; rename in place.
struct FolderNameField: View {
    let folder: FolderInfo
    var color: Color?
    @ObservedObject private var store = Store.shared
    @State private var draft = ""
    @FocusState private var focused: Bool

    var body: some View {
        if store.editingSessionId == "folder:\(folder.id)" {
            HStack(spacing: 6) {
                TextField("Folder name", text: $draft)
                    .textFieldStyle(.plain)
                    .font(.system(size: 12, weight: .semibold)).foregroundColor(.white)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(RoundedRectangle(cornerRadius: 5).fill(Color.white.opacity(0.12)))
                    .focused($focused)
                    .background(MakeKeyWindow())
                    .onSubmit {
                        store.sessionsAction("rename", folder: folder.id, name: draft)
                        Rename.end()
                    }
                    .onExitCommand { Rename.end() }
                    .frame(minWidth: 120)
                Text("Enter saves").font(.system(size: 9, weight: .semibold)).foregroundColor(.white.opacity(0.5))
            }
            .onAppear {
                draft = folder.name
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) { focused = true }
            }
        } else {
            Text(folder.name)
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(color ?? .white.opacity(0.85))
                .lineLimit(1).truncationMode(.tail)
        }
    }
}

/// A folder like in the Explorer: click to open or close it; hover for Rename and Delete; right-click for the rest.
struct FolderRow: View {
    let folder: FolderInfo
    var depth = 0
    @ObservedObject private var store = Store.shared
    @State private var hover = false

    var body: some View {
        let id = folder.id
        let open = !store.collapsed.contains(id)
        let signal = store.folderSignal(id)
        let count = store.folderCount(id)
        let siblings = store.listFolders(in: folder.parent)
        HStack(spacing: 6) {
            Image(systemName: "chevron.right")
                .font(.system(size: 9, weight: .bold)).foregroundColor(.white.opacity(0.5))
                .rotationEffect(.degrees(open ? 90 : 0)).frame(width: 10)
            Image(systemName: open ? "folder" : "folder.fill")
                .font(.system(size: 11)).foregroundColor(.white.opacity(0.55))
            FolderNameField(folder: folder, color: signal?.color)
            if count > 0 {
                Text("\(count)").font(.system(size: 10.5, weight: .semibold)).foregroundColor(.white.opacity(0.45))
            }
            if let signal { Circle().fill(signal.color).frame(width: 6, height: 6) }
            Spacer(minLength: 4)
            if hover && store.editingSessionId != "folder:\(id)" {
                IconButton(symbol: "pencil", help: "Rename", size: 20) { Rename.begin("folder:\(id)") }
                IconButton(symbol: "trash", help: "Delete folder (what is inside moves up a level)", size: 20) {
                    store.sessionsAction("delete", folder: id)
                }
            }
        }
        .frame(minHeight: 20)
        .padding(.leading, 10 + CGFloat(depth) * 16).padding(.trailing, 10).padding(.vertical, 5)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.white.opacity(hover ? 0.10 : 0.0)))
        .contentShape(Rectangle())
        .onHover { hover = $0 }
        .onTapGesture {
            withAnimation(.easeOut(duration: 0.12)) { if open { store.collapsed.insert(id) } else { store.collapsed.remove(id) } }
        }
        .contextMenu {
            Button("New Session") { store.newSession(in: id) }
            Button("New Folder…") { NewFolder.begin(in: id) }
            Divider()
            MoveMenu(item: "f:" + id)
            if folder.parent != nil { Button("Move to Top Level") { store.sessionsAction("move", ids: ["f:" + id], folder: nil) } }
            if siblings.first?.id != id { Button("Move Up") { store.sessionsAction("shift", folder: id, text: "up") } }
            if siblings.last?.id != id { Button("Move Down") { store.sessionsAction("shift", folder: id, text: "down") } }
            Divider()
            Button("Rename…") { Rename.begin("folder:\(id)") }
            Button("Delete") { store.sessionsAction("delete", folder: id) }
        }
    }
}

/// The sessions and folders of one level, then each open folder's own level below it.
struct SessionTree: View {
    var parent: String? = nil
    var depth = 0
    @ObservedObject private var store = Store.shared

    var body: some View {
        ForEach(store.listSessions(in: parent)) { SessionRow(session: $0, depth: depth) }
        ForEach(store.listFolders(in: parent), id: \.id) { f in
            FolderRow(folder: f, depth: depth)
            if !store.collapsed.contains(f.id) { AnyView(SessionTree(parent: f.id, depth: depth + 1)) }
        }
    }
}

private struct HeightKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

struct AlertList: View {
    @ObservedObject private var store = Store.shared
    @State private var contentHeight: CGFloat = 200
    private var expanded: Binding<UUID?> { Binding(get: { store.expandedAlertId }, set: { store.expandedAlertId = $0 }) }
    var width: CGFloat = 380
    var showFooter = true
    var onClose: () -> Void = {}

    private var maxHeight: CGFloat {
        (OverlayController.mainScreen.visibleFrame.height - 140)
    }

    var body: some View {
        let waiting = store.waiting.filter { $0.kind != .mac && $0.kind != .free }
        let muted = store.muted
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(waiting.isEmpty ? "Nothing waiting for you" : "Waiting for you · \(waiting.count)")
                    .font(.system(size: 12, weight: .bold)).foregroundColor(.white.opacity(0.6))
                Spacer()
                if !waiting.isEmpty {
                    Button("Mute all") { store.muteAll() }.buttonStyle(.plain)
                        .font(.system(size: 11.5, weight: .semibold)).foregroundColor(.white.opacity(0.6))
                }
            }
            .padding(.horizontal, 4)
            ScrollView(.vertical, showsIndicators: contentHeight > maxHeight) {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(waiting) { AlertRow(alert: $0, expanded: expanded) }
                    if !muted.isEmpty {
                        Text("Muted · \(muted.count)").font(.system(size: 11, weight: .bold)).foregroundColor(.white.opacity(0.45))
                            .padding(.horizontal, 4).padding(.top, 4)
                        ForEach(muted) { AlertRow(alert: $0, expanded: expanded, dim: true) }
                    }
                    if !store.sortedSessions.isEmpty || !store.visibleFolders.isEmpty {
                        HStack(spacing: 6) {
                            Text("Sessions · \(store.sortedSessions.count)").font(.system(size: 11, weight: .bold)).foregroundColor(.white.opacity(0.45))
                            Spacer()
                            IconButton(symbol: "plus", help: "New Session (a terminal tab in VS Code that runs claude)", size: 20) {
                                onClose(); store.newSession(in: nil)
                            }
                            IconButton(symbol: "folder.badge.plus", help: "New Folder", size: 20) { NewFolder.begin(in: nil) }
                        }
                        .padding(.horizontal, 4).padding(.top, 6)
                        SessionTree()
                    }
                }
                .background(GeometryReader { g in Color.clear.preference(key: HeightKey.self, value: g.size.height) })
            }
            .frame(height: min(contentHeight, maxHeight))
            .onPreferenceChange(HeightKey.self) { contentHeight = $0 }
            if showFooter {
                Divider().background(Color.white.opacity(0.15)).padding(.top, 4)
                HStack {
                    Button("Settings…") { onClose(); Actions.shared.openSettings() }.buttonStyle(.plain)
                    Spacer()
                    Button("Quit") { NSApp.terminate(nil) }.buttonStyle(.plain)
                }
                .font(.system(size: 12, weight: .semibold)).foregroundColor(.white.opacity(0.7))
                .padding(.horizontal, 4)
            }
        }
        .padding(10)
        .frame(width: width)
        .background(Color(red: 0.11, green: 0.11, blue: 0.13))
        .environment(\.colorScheme, .dark)
    }
}

// MARK: - Settings

struct SettingsView: View {
    @ObservedObject private var settings = AppSettings.shared
    @State private var login = Actions.shared.launchAtLogin

    var body: some View {
        Form {
            Picker("Later button", selection: $settings.laterMinutes) {
                ForEach([1, 5, 10, 15, 30, 60], id: \.self) { Text($0 == 60 ? "1 h" : "\($0) min").tag($0) }
            }
            Picker("Fold pills into the notch after", selection: $settings.foldSeconds) {
                Text("Never").tag(0)
                Text("10 s").tag(10)
                Text("30 s").tag(30)
                Text("1 min").tag(60)
                Text("5 min").tag(300)
            }
            Toggle("Colored dot in the terminal tab title (🟢 🟠 🟣 🔴)", isOn: $settings.tabDots)
            Toggle("Glow around the screen for every alert (always on for computer use)", isOn: $settings.edgeGlow)
            Toggle("Pills for background runs (scheduled tasks, claude -p)", isOn: $settings.backgroundPills)
            Toggle("Continue by itself after a usage limit resets (VS Code terminal tabs)", isOn: $settings.autoContinue)
            Toggle("Usage limits in Claude Code's status line", isOn: $settings.statusLineUsage)
            Toggle("Sound when something happens", isOn: $settings.sound)
            Toggle("Voice: says who and what happened", isOn: $settings.voice)
            Toggle("Show when Claude uses your Mac (red ring)", isOn: $settings.macRing)
            Toggle("Notch band with session dots", isOn: $settings.notchBand)
            Picker("Count me as away after", selection: $settings.awayMinutes) {
                ForEach([1, 3, 5, 10, 30, 60], id: \.self) { Text($0 == 60 ? "1 h" : "\($0) min").tag($0) }
            }
            Toggle("Open at login", isOn: $login)
                .onChange(of: login) { _, v in
                    UserDefaults.standard.set(v, forKey: "openAtLogin")
                    Actions.shared.launchAtLogin = v
                }
            Text("Claude Code Alerts · community project, not affiliated with Anthropic")
                .font(.footnote).foregroundColor(.secondary)
        }
        .formStyle(.grouped)
        .frame(width: 440)
    }
}
