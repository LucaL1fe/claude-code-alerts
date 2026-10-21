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
                runCode([ws]) { owner.conn.send(focus) }
            } else {
                activateVSCode()
            }
            owner.conn.send(focus)
        } else {
            activateVSCode()
            for w in Store.shared.windows.values { w.conn.send(focus) }
        }
    }

    private var codeCLI: String? {
        guard let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.microsoft.VSCode") else { return nil }
        let path = app.appendingPathComponent("Contents/Resources/app/bin/code").path
        return FileManager.default.isExecutableFile(atPath: path) ? path : nil
    }

    private func runCode(_ args: [String], then: @escaping () -> Void) {
        guard let cli = codeCLI else { activateVSCode(); then(); return }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: cli)
        p.arguments = args
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        p.terminationHandler = { _ in DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { then() } }
        do { try p.run() } catch { activateVSCode(); then() }
    }

    func activateVSCode() {
        if let app = NSRunningApplication.runningApplications(withBundleIdentifier: "com.microsoft.VSCode").first {
            app.activate()
        }
    }

    // MARK: - Settings window

    func openSettings() {
        if settingsWindow == nil {
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 440, height: 360), styleMask: [.titled, .closable],
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
