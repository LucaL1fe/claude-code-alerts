import AppKit
import SwiftUI

/// Our menu bar icon: four rounded squares, colored by the most urgent waiting item, with a count.
/// Clicking it opens the list in a panel that takes the keyboard (for renaming) without activating the app.
final class MenuBarController: NSObject {
    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private var panel: OverlayPanel?
    private var host: NSHostingView<AnyView>?
    private var monitors: [Any] = []
    private var appObserver: Any?
    var onOpenChange: ((Bool) -> Void)?

    override init() {
        super.init()
        item.button?.target = self
        item.button?.action = #selector(toggle)
        item.button?.imagePosition = .imageLeading
        update()
    }

    static func icon(color: NSColor?) -> NSImage {
        let size = NSSize(width: 16, height: 16)
        let img = NSImage(size: size, flipped: false) { _ in
            let c = color ?? .black
            let cell: CGFloat = 6.5
            let gap: CGFloat = 1.6
            let origin = (16 - (cell * 2 + gap)) / 2
            for (i, rect) in [
                NSRect(x: origin, y: origin + cell + gap, width: cell, height: cell),
                NSRect(x: origin + cell + gap, y: origin + cell + gap, width: cell, height: cell),
                NSRect(x: origin, y: origin, width: cell, height: cell),
                NSRect(x: origin + cell + gap, y: origin, width: cell, height: cell),
            ].enumerated() {
                c.withAlphaComponent(i == 0 ? 1 : 0.6).setFill()
                NSBezierPath(roundedRect: rect, xRadius: 2, yRadius: 2).fill()
            }
            return true
        }
        img.isTemplate = color == nil
        return img
    }

    var isOpen: Bool { panel?.isVisible ?? false }

    func update() {
        guard let button = item.button else { return }
        let waiting = Store.shared.waiting.filter { $0.kind != .mac && $0.kind != .free }
        let macOn = Store.shared.macSessionId != nil
        let kind: AState? = macOn ? .mac : waiting.first?.kind
        button.image = Self.icon(color: kind?.nsColor)
        if waiting.isEmpty {
            button.title = ""
        } else {
            button.attributedTitle = NSAttributedString(
                string: " \(waiting.count)",
                attributes: [.foregroundColor: (kind ?? .done).nsColor, .font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .bold)])
        }
        button.toolTip = waiting.isEmpty ? "Claude Code Alerts: nothing waiting" : "Claude Code Alerts: \(waiting.count) waiting"
        if isOpen {
            place()
            DispatchQueue.main.async { [weak self] in self?.place() }
        }
    }

    @objc func toggle() {
        isOpen ? close() : show()
    }

    func show() {
        if panel == nil {
            let p = OverlayPanel(rect: .zero, level: NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 3), clickThrough: false)
            p.allowKey = true
            let view = AnyView(AlertList(onClose: { [weak self] in self?.close() })
                .clipShape(RoundedRectangle(cornerRadius: 14))
                .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color.white.opacity(0.12), lineWidth: 1)))
            let h = NSHostingView(rootView: view)
            p.contentView = h
            p.hasShadow = true
            panel = p
            host = h
        }
        place()
        panel?.orderFrontRegardless()
        DispatchQueue.main.async { [weak self] in self?.place() }
        onOpenChange?(true)
        // Close on a click anywhere else, or on Escape.
        monitors.append(NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            self?.close()
        } as Any)
        appObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] note in
            let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
            if app?.bundleIdentifier != Bundle.main.bundleIdentifier, Store.shared.editingSessionId == nil { self?.close() }
        }
        monitors.append(NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] e in
            if e.keyCode == 53, Store.shared.editingSessionId == nil { self?.close(); return nil }
            return e
        } as Any)
    }

    private func place() {
        guard let panel, let host, let button = item.button, let bwin = button.window else { return }
        host.layoutSubtreeIfNeeded()
        let size = host.fittingSize
        let b = bwin.frame
        let screen = bwin.screen ?? OverlayController.mainScreen
        var x = b.midX - size.width / 2
        x = min(max(x, screen.frame.minX + 8), screen.frame.maxX - size.width - 8)
        panel.setFrame(NSRect(x: x, y: b.minY - size.height - 6, width: size.width, height: size.height), display: true)
    }

    func close() {
        monitors.forEach { NSEvent.removeMonitor($0) }
        monitors = []
        if let o = appObserver { NSWorkspace.shared.notificationCenter.removeObserver(o); appObserver = nil }
        if Store.shared.editingSessionId != nil { Rename.end() }
        guard panel?.isVisible == true else { return }
        panel?.orderOut(nil)
        onOpenChange?(false)
    }
}
