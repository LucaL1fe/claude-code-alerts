import AppKit
import SwiftUI

/// Our menu bar icon: four rounded squares, colored by the most urgent waiting item, with a count.
final class MenuBarController: NSObject, NSPopoverDelegate {
    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let popover = NSPopover()

    override init() {
        super.init()
        popover.behavior = .transient
        popover.animates = false
        popover.delegate = self
        popover.contentViewController = NSHostingController(rootView: AlertList())
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
        resize()
    }

    private func resize() {
        if popover.isShown, let vc = popover.contentViewController as? NSHostingController<AlertList> {
            popover.contentSize = vc.view.fittingSize
        }
    }

    @objc func toggle() {
        if popover.isShown {
            popover.performClose(nil)
        } else {
            show()
        }
    }

    func show() {
        guard let button = item.button else { return }
        if let vc = popover.contentViewController {
            vc.view.layoutSubtreeIfNeeded()
            popover.contentSize = vc.view.fittingSize
        }
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        popover.contentViewController?.view.window?.makeKey()
    }
}
