import SwiftUI

// MARK: - Small parts

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
                IconButton(symbol: "arrow.right", help: "Go to this session", filled: alert.kind.color, size: size) {
                    Store.shared.goTo(alert: alert.id)
                }
            }
        }
    }
}

/// Session name with a pencil; click the pencil to rename in place.
struct NameField: View {
    let session: Session?
    var fontSize: CGFloat = 13
    @ObservedObject private var store = Store.shared
    @State private var draft = ""
    @FocusState private var focused: Bool

    var body: some View {
        if let session, store.editingSessionId == session.id {
            HStack(spacing: 6) {
                TextField("Name", text: $draft)
                    .textFieldStyle(.plain)
                    .font(.system(size: fontSize, weight: .semibold))
                    .foregroundColor(.white)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(RoundedRectangle(cornerRadius: 5).fill(Color.white.opacity(0.12)))
                    .focused($focused)
                    .onSubmit { commit(session) }
                    .onExitCommand { store.editingSessionId = nil }
                    .frame(minWidth: 120)
                Text("Enter saves").font(.system(size: fontSize * 0.75, weight: .semibold)).foregroundColor(.white.opacity(0.5))
            }
            .onAppear {
                draft = session.name
                NSApp.activate(ignoringOtherApps: true)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { focused = true }
            }
        } else {
            HStack(spacing: 5) {
                Text(session?.name ?? "Session")
                    .font(.system(size: fontSize, weight: .semibold))
                    .foregroundColor(.white)
                    .lineLimit(1).truncationMode(.tail)
                if let session {
                    Button { store.editingSessionId = session.id } label: {
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
        store.editingSessionId = nil
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
            if alert.kind != .mac && alert.kind != .free { store.goTo(alert: alert.id) }
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
                NameField(session: session, fontSize: 12.5)
                Text(alert.text)
                    .font(.system(size: 11.5, weight: .medium)).foregroundColor(c)
                    .lineLimit(open ? 4 : 1).truncationMode(.tail)
                    .fixedSize(horizontal: false, vertical: open)
                if open {
                    Text("\(alert.created.ago) ago · \(alert.status == .snoozed ? "snoozed" : alert.kind.label)")
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
    @ObservedObject private var store = Store.shared
    @State private var hover = false

    var body: some View {
        HStack(spacing: 9) {
            Circle().fill(session.state.color).frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 1) {
                NameField(session: session, fontSize: 12)
                Text(session.detail.isEmpty ? session.state.label : session.detail)
                    .font(.system(size: 11, weight: .medium)).foregroundColor(session.state.color).lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Text("\(session.state.label) · \(session.updated.ago)")
                .font(.system(size: 10.5, weight: .semibold)).foregroundColor(.white.opacity(0.45))
            if hover {
                IconButton(symbol: "arrow.right", help: "Go to this session", filled: session.state.color, size: 20) {
                    store.goTo(session.id)
                }
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.white.opacity(hover ? 0.10 : 0.0)))
        .contentShape(Rectangle())
        .onHover { hover = $0 }
        .onTapGesture { store.goTo(session.id) }
    }
}

struct AlertList: View {
    @ObservedObject private var store = Store.shared
    @State private var expanded: UUID?
    var width: CGFloat = 380
    var showFooter = true

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
            ForEach(waiting) { AlertRow(alert: $0, expanded: $expanded) }
            if !muted.isEmpty {
                Text("Muted · \(muted.count)").font(.system(size: 11, weight: .bold)).foregroundColor(.white.opacity(0.45))
                    .padding(.horizontal, 4).padding(.top, 4)
                ForEach(muted) { AlertRow(alert: $0, expanded: $expanded, dim: true) }
            }
            if !store.sessions.isEmpty {
                Text("Sessions · \(store.sessions.count)").font(.system(size: 11, weight: .bold)).foregroundColor(.white.opacity(0.45))
                    .padding(.horizontal, 4).padding(.top, 6)
                ForEach(store.sortedSessions) { SessionRow(session: $0) }
            }
            if showFooter {
                Divider().background(Color.white.opacity(0.15)).padding(.top, 4)
                HStack {
                    Button("Settings…") { Actions.shared.openSettings() }.buttonStyle(.plain)
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
            Toggle("Sound when something happens", isOn: $settings.sound)
            Toggle("Voice: says who and what happened", isOn: $settings.voice)
            Toggle("Show when Claude uses your Mac (red ring)", isOn: $settings.macRing)
            Toggle("Notch band with session dots", isOn: $settings.notchBand)
            Picker("Count me as away after", selection: $settings.awayMinutes) {
                ForEach([1, 3, 5, 10], id: \.self) { Text("\($0) min").tag($0) }
            }
            Toggle("Open at login", isOn: $login)
                .onChange(of: login) { _, v in Actions.shared.launchAtLogin = v }
            Text("Claude Code Alerts · community project, not affiliated with Anthropic")
                .font(.footnote).foregroundColor(.secondary)
        }
        .formStyle(.grouped)
        .frame(width: 440)
    }
}
