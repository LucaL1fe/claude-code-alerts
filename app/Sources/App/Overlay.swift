import AppKit
import QuartzCore
import SwiftUI

/// A borderless panel that floats over every desktop and full-screen app without activating the app.
final class OverlayPanel: NSPanel {
    var allowKey = false

    init(rect: NSRect, level: NSWindow.Level, clickThrough: Bool) {
        super.init(contentRect: rect, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        isFloatingPanel = true
        self.level = level  // after isFloatingPanel, which would reset it to .floating
        hidesOnDeactivate = false
        backgroundColor = .clear
        isOpaque = false
        hasShadow = false
        ignoresMouseEvents = clickThrough
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        isReleasedWhenClosed = false
    }

    override var canBecomeKey: Bool { allowKey }

    /// Overlays may sit over the menu bar and the notch.
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
}

/// One edge of the glowing screen border: a line along the outer side and a glow fading inwards.
final class EdgeStripView: NSView {
    enum Side { case top, bottom, left, right }
    let side: Side
    var color: NSColor = .systemGreen { didSet { needsDisplay = true } }
    var lineWidth: CGFloat = 5
    var glowAlpha: CGFloat = 0.55

    init(side: Side, frame: NSRect) {
        self.side = side
        super.init(frame: frame)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func draw(_ dirtyRect: NSRect) {
        let b = bounds
        let colors = [color.withAlphaComponent(glowAlpha), color.withAlphaComponent(0)]
        let gradient = NSGradient(colors: colors)
        let line: NSRect
        let angle: CGFloat
        switch side {
        case .top: line = NSRect(x: 0, y: b.height - lineWidth, width: b.width, height: lineWidth); angle = -90
        case .bottom: line = NSRect(x: 0, y: 0, width: b.width, height: lineWidth); angle = 90
        case .left: line = NSRect(x: 0, y: 0, width: lineWidth, height: b.height); angle = 0
        case .right: line = NSRect(x: b.width - lineWidth, y: 0, width: lineWidth, height: b.height); angle = 180
        }
        gradient?.draw(in: b, angle: angle)
        color.setFill()
        line.fill()
    }
}

/// The glowing screen edge as four thin windows per screen, so nothing covers the middle of the screen
/// (other tools, such as Claude's computer use, see the screen as free).
final class EdgeSet {
    private var panels: [OverlayPanel] = []
    private var views: [EdgeStripView] = []
    private let level: NSWindow.Level
    let thickness: CGFloat
    let lineWidth: CGFloat
    let glowAlpha: CGFloat

    init(level: NSWindow.Level, thickness: CGFloat, lineWidth: CGFloat, glowAlpha: CGFloat) {
        self.level = level
        self.thickness = thickness
        self.lineWidth = lineWidth
        self.glowAlpha = glowAlpha
    }

    private func build() {
        close()
        for s in NSScreen.screens {
            let f = s.frame
            let t = thickness
            let rects: [(EdgeStripView.Side, NSRect)] = [
                (.top, NSRect(x: f.minX, y: f.maxY - t, width: f.width, height: t)),
                (.bottom, NSRect(x: f.minX, y: f.minY, width: f.width, height: t)),
                (.left, NSRect(x: f.minX, y: f.minY, width: t, height: f.height)),
                (.right, NSRect(x: f.maxX - t, y: f.minY, width: t, height: f.height)),
            ]
            for (side, r) in rects {
                let p = OverlayPanel(rect: r, level: level, clickThrough: true)
                let v = EdgeStripView(side: side, frame: NSRect(origin: .zero, size: r.size))
                v.lineWidth = lineWidth
                v.glowAlpha = glowAlpha
                p.contentView = v
                panels.append(p)
                views.append(v)
            }
        }
    }

    func show(color: NSColor, alpha: CGFloat = 1) {
        if panels.count != NSScreen.screens.count * 4 { build() }
        for v in views { v.color = color }
        for p in panels {
            p.alphaValue = alpha
            p.orderFrontRegardless()
        }
    }

    func setAlpha(_ a: CGFloat, animated: Double) {
        for p in panels {
            if animated > 0 {
                NSAnimationContext.runAnimationGroup { ctx in
                    ctx.duration = animated
                    p.animator().alphaValue = a
                }
            } else {
                p.alphaValue = a
            }
        }
    }

    func hide() { panels.forEach { $0.orderOut(nil) } }

    func close() {
        panels.forEach { $0.close() }
        panels = []
        views = []
    }

    var isShown: Bool { panels.first?.isVisible ?? false }
}

/// Owns every on-screen element: flares, the Mac ring and the pill stack.
final class OverlayController {
    private let edgeLevel = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.screenSaverWindow)))
    private let pillLevel = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 2)
    private lazy var flareSet = EdgeSet(level: edgeLevel, thickness: 64, lineWidth: 5, glowAlpha: 0.55)
    private lazy var ringSet = EdgeSet(level: edgeLevel, thickness: 4, lineWidth: 3, glowAlpha: 0.6)
    private var ringOn = false
    private var flareToken = 0
    private var pillPanel: OverlayPanel?
    private var pillHost: NSHostingView<PillStack>?
    var onMore: () -> Void = {}

    /// The screen with the menu bar (and the notch).
    static var mainScreen: NSScreen { NSScreen.screens.first ?? NSScreen.main! }

    static func menuBarHeight(_ s: NSScreen) -> CGFloat {
        max(s.frame.maxY - s.visibleFrame.maxY, s.safeAreaInsets.top, 24)
    }

    func screensChanged() {
        flareSet.close()
        ringSet.close()
        if ringOn { ringSet.show(color: AState.mac.nsColor) }
        update()
    }

    // MARK: Flare

    func flare(_ kind: AState) {
        flareToken += 1
        let token = flareToken
        flareSet.show(color: kind.nsColor, alpha: 0)
        flareSet.setAlpha(1, animated: 0.18)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in
            guard let self, self.flareToken == token else { return }
            self.flareSet.setAlpha(0, animated: 0.45)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                guard let self, self.flareToken == token else { return }
                self.flareSet.hide()
            }
        }
    }

    // MARK: Ring

    func setRing(_ on: Bool) {
        guard on != ringOn else { return }
        ringOn = on
        if on { ringSet.show(color: AState.mac.nsColor) } else { ringSet.hide() }
    }

    // MARK: Pills

    func update() {
        let store = Store.shared
        let show = !store.pills.isEmpty || store.summaryCount > 0
        if !show {
            pillPanel?.orderOut(nil)
            return
        }
        if pillPanel == nil {
            let p = OverlayPanel(rect: NSRect(x: 0, y: 0, width: 470, height: 80), level: pillLevel, clickThrough: false)
            p.allowKey = true
            let host = NSHostingView(rootView: PillStack(onMore: { [weak self] in self?.onMore() }))
            p.contentView = host
            pillPanel = p
            pillHost = host
        }
        guard let p = pillPanel, let host = pillHost else { return }
        host.layoutSubtreeIfNeeded()
        let size = host.fittingSize
        let s = Self.mainScreen
        let top = s.frame.maxY - Self.menuBarHeight(s) + 4
        p.setFrame(NSRect(x: s.frame.midX - size.width / 2, y: top - size.height, width: size.width, height: size.height), display: true)
        p.orderFrontRegardless()
    }
}
