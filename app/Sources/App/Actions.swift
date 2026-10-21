import AppKit
import AVFoundation
import ServiceManagement
import Shared
import SwiftUI

/// Side effects: sounds, voice, jumping to VS Code, windows.
final class Actions {
    static let shared = Actions()
    private let speech = AVSpeechSynthesizer()
    private var settingsWindow: NSWindow?
    private var lastSound = Date.distantPast

    func sound(_ kind: AState) {
        guard AppSettings.shared.sound, Date().timeIntervalSince(lastSound) > 0.8 else { return }
        lastSound = Date()
        NSSound(named: NSSound.Name(kind.soundName))?.play()
    }

    func speak(_ text: String) {
        guard AppSettings.shared.voice else { return }
        let spoken = text.replacingOccurrences(of: "-", with: " ").replacingOccurrences(of: "_", with: " ")
        speech.stopSpeaking(at: .immediate)
        speech.speak(AVSpeechUtterance(string: spoken))
    }

    // MARK: - Go to

    /// Brings up the session's own VS Code window (macOS slides to its desktop), then its terminal tab.
    func goTo(_ s: Session, owner: VSWindow?) {
        var focus = Msg(kind: "focusTerminal")
        focus.shellPid = s.shellPid
        if let owner {
            if let ws = owner.workspace, FileManager.default.fileExists(atPath: ws) {
                raiseWindow(of: ws) { owner.conn.send(focus) }
            } else {
                activateVSCode()
            }
            owner.conn.send(focus)
        } else if isPanelSession(s), let url = URL(string: "vscode://anthropic.claude-code/open?session=\(s.id)") {
            // A session in the Claude Code panel (no terminal): Anthropic's extension focuses its tab.
            NSWorkspace.shared.open(url)
        } else if let app = terminalApp(of: s.shellPid), app.bundleIdentifier != "com.microsoft.VSCode" {
            // A session in another terminal (Terminal, iTerm, Ghostty…): bring that app forward.
            app.activate()
        } else {
            activateVSCode()
            for w in Store.shared.windows.values { w.conn.send(focus) }
        }
    }

    /// The GUI app a shell runs in: the first ancestor that is a running application.
    private func terminalApp(of shellPid: Int32) -> NSRunningApplication? {
        var pid = shellPid
        for _ in 0..<10 {
            guard pid > 1 else { return nil }
            if let app = NSRunningApplication(processIdentifier: pid), app.activationPolicy == .regular { return app }
            guard let info = Proc.info(pid) else { return nil }
            pid = info.ppid
        }
        return nil
    }

    /// Panel sessions are started by VS Code's extension host, not by a shell in a terminal.
    private func isPanelSession(_ s: Session) -> Bool {
        guard s.id.count == 36, let parent = Proc.info(s.shellPid) else { return false }
        let shells = ["zsh", "bash", "fish", "sh", "login", "tmux"]
        return !shells.contains(parent.comm) && !parent.comm.hasPrefix("-")
    }

    /// Brings up the VS Code window that has this folder open (macOS then switches to its desktop).
    /// Goes through Launch Services like a double click, so no extra VS Code process shows up in the Dock.
    private func raiseWindow(of folder: String, then: @escaping () -> Void) {
        guard let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.microsoft.VSCode") else {
            activateVSCode(); then(); return
        }
        let cfg = NSWorkspace.OpenConfiguration()
        cfg.activates = true
        NSWorkspace.shared.open([URL(fileURLWithPath: folder)], withApplicationAt: app, configuration: cfg) { _, _ in
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { then() }
        }
    }

    func activateVSCode() {
        if let app = NSRunningApplication.runningApplications(withBundleIdentifier: "com.microsoft.VSCode").first {
            app.activate()
        }
    }

    // MARK: - Settings window

    func openSettings() {
        if settingsWindow == nil {
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 460, height: 470), styleMask: [.titled, .closable],
                             backing: .buffered, defer: false)
            w.title = "Claude Code Alerts"
            w.isReleasedWhenClosed = false
            w.contentView = NSHostingView(rootView: SettingsView())
            w.center()
            settingsWindow = w
        }
        NSApp.activate(ignoringOtherApps: true)
        settingsWindow?.makeKeyAndOrderFront(nil)
    }

    // MARK: - Launch at login

    var launchAtLogin: Bool {
        get { SMAppService.mainApp.status == .enabled }
        set {
            do {
                if newValue { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            } catch {
                NSLog("cca: launch at login: \(error)")
            }
        }
    }
}
