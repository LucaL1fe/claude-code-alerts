import AppKit
import Combine
import CoreGraphics
import Shared

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let server = Server()
    private let store = Store.shared
    private var overlay: OverlayController!
    private var menuBar: MenuBarController!
    private var notch: NotchController!
    private var locked = false
    private var asleep = false
    private var cancellables: Set<AnyCancellable> = []
    private var broadcastWork: DispatchWorkItem?

    func applicationDidFinishLaunching(_ notification: Notification) {
        store.load()
        overlay = OverlayController()
        menuBar = MenuBarController()
        notch = NotchController()
        overlay.onMore = { [weak self] in self?.menuBar.show() }
        menuBar.onOpenChange = { [weak self] open in self?.overlay.listOpen = open }
        store.onGoTo = { [weak self] in self?.menuBar.close() }
        store.onDebugUI = { [weak self] action in
            if action == "list" { self?.menuBar.show() }
            if action == "close" { self?.menuBar.close() }
        }
        notch.onOpenChange = { [weak self] open in self?.overlay.listOpen = open }

        store.onFlare = { [weak self] kind in self?.overlay.flare(kind) }
        store.onChange = { [weak self] in self?.refresh() }
        server.onMessage = { [weak self] msg, conn in self?.store.handle(msg, conn) }
        server.onDisconnect = { [weak self] conn in self?.store.disconnected(conn) }
        server.start()

        notch.rebuild()
        refresh()

        // Open at login by default (Settings can switch it off). Registered again if the app moved.
        UserDefaults.standard.register(defaults: ["openAtLogin": true])
        if UserDefaults.standard.bool(forKey: "openAtLogin") && !Actions.shared.launchAtLogin {
            Actions.shared.launchAtLogin = true
        }

        AppSettings.shared.objectWillChange.sink { [weak self] _ in
            DispatchQueue.main.async {
                self?.notch.rebuild()
                if !AppSettings.shared.macRing { self?.store.endMac(showFree: false) }
                self?.refresh()
            }
        }.store(in: &cancellables)

        // Snoozes, the end of computer use, sessions that ended.
        Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.store.tick() }
        // Away: idle, locked or display asleep.
        Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.checkAway() }

        let dnc = DistributedNotificationCenter.default()
        dnc.addObserver(forName: .init("com.apple.screenIsLocked"), object: nil, queue: .main) { [weak self] _ in
            self?.locked = true
            self?.checkAway()
        }
        dnc.addObserver(forName: .init("com.apple.screenIsUnlocked"), object: nil, queue: .main) { [weak self] _ in
            self?.locked = false
            self?.checkAway()
        }
        let wnc = NSWorkspace.shared.notificationCenter
        wnc.addObserver(forName: NSWorkspace.screensDidSleepNotification, object: nil, queue: .main) { [weak self] _ in
            self?.asleep = true
            self?.checkAway()
        }
        wnc.addObserver(forName: NSWorkspace.screensDidWakeNotification, object: nil, queue: .main) { [weak self] _ in
            self?.asleep = false
            self?.checkAway()
        }
        NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil,
                                               queue: .main) { [weak self] _ in
            self?.overlay.screensChanged()
            self?.notch.rebuild()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        store.saveNow()
    }

    private func idleSeconds() -> Double {
        let types: [CGEventType] = [.mouseMoved, .keyDown, .leftMouseDown, .scrollWheel, .rightMouseDown]
        return types.map { CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: $0) }.min() ?? 0
    }

    private func checkAway() {
        let idle = idleSeconds() > Double(AppSettings.shared.awayMinutes * 60)
        let away = store.debugAway || locked || asleep || idle
        if away != store.away { store.setAway(away) }
    }

    private func refresh() {
        overlay.update()
        overlay.setRing(store.macSessionId != nil)
        menuBar.update()
        notch.update()
        broadcastWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.store.broadcastSessions() }
        broadcastWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2, execute: work)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
// Menu bar app without a Dock icon. `defaults write io.github.lucal1fe.claude-code-alerts debugDockIcon -bool true`
// shows it as a regular app (useful for UI test tools that only list regular apps).
app.setActivationPolicy(UserDefaults.standard.bool(forKey: "debugDockIcon") ? .regular : .accessory)
app.run()
