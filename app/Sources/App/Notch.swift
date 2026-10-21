import AppKit
import SwiftUI

/// Hover state shared by the band and its list.
final class NotchHover: ObservableObject {
    @Published var overBand = false
    @Published var overList = false
}

/// A black band around the notch with one dot per session. Hover it to see the list.
struct NotchBandView: View {
    @ObservedObject private var store = Store.shared
    @ObservedObject var hover: NotchHover
    let notchWidth: CGFloat
    let side: CGFloat

    var body: some View {
        let sessions = store.sortedSessions
        let kind: AState? = store.macSessionId != nil ? .mac : store.waiting.first?.kind
        HStack(spacing: 0) {
            HStack {
                Spacer(minLength: 0)
                Image(nsImage: MenuBarController.icon(color: (kind ?? .idle).nsColor))
                    .resizable().frame(width: 11, height: 11)
                    .opacity(kind == nil ? 0.55 : 1)
            }
            .frame(width: side - 6)
            Spacer().frame(width: notchWidth + 12)
            HStack(spacing: 3) {
                ForEach(Array(sessions.prefix(5))) { s in
                    Circle().fill(s.state.color).frame(width: 6, height: 6)
                }
                Spacer(minLength: 0)
            }
            .frame(width: side - 6)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(UnevenRoundedRectangle(bottomLeadingRadius: 10, bottomTrailingRadius: 10).fill(Color.black))
        .onHover { hover.overBand = $0 }
    }
}

struct NotchListView: View {
    @ObservedObject var hover: NotchHover

    var body: some View {
        AlertList(width: 400, showFooter: false)
            .clipShape(RoundedRectangle(cornerRadius: 16))
            .onHover { hover.overList = $0 }
    }
}

final class NotchController {
    private var band: OverlayPanel?
    private var list: OverlayPanel?
    private var listHost: NSHostingView<NotchListView>?
    private let hover = NotchHover()
    private var hideWork: DispatchWorkItem?
    private var observer: Any?
    private let level = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 3)

    init() {
        observer = hover.objectWillChange.sink { [weak self] _ in
            DispatchQueue.main.async { self?.hoverChanged() }
        }
    }

    func rebuild() {
        band?.close()
        band = nil
        list?.close()
        list = nil
        guard AppSettings.shared.notchBand else { return }
        let s = OverlayController.mainScreen
        guard s.safeAreaInsets.top > 0, let left = s.auxiliaryTopLeftArea, let right = s.auxiliaryTopRightArea else { return }
        let h = s.safeAreaInsets.top
        let notchX = s.frame.minX + left.width
        let notchW = s.frame.width - left.width - right.width
        let side: CGFloat = 34
        let rect = NSRect(x: notchX - side, y: s.frame.maxY - h, width: notchW + side * 2, height: h)
        let p = OverlayPanel(rect: rect, level: level, clickThrough: false)
        p.contentView = NSHostingView(rootView: NotchBandView(hover: hover, notchWidth: notchW - 12, side: side))
        p.orderFrontRegardless()
        band = p
    }

    private func hoverChanged() {
        if hover.overBand || hover.overList {
            hideWork?.cancel()
            showList()
        } else {
            hideWork?.cancel()
            let work = DispatchWorkItem { [weak self] in self?.list?.orderOut(nil) }
            hideWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35, execute: work)
        }
    }

    private func showList() {
        guard let band else { return }
        if list == nil {
            let p = OverlayPanel(rect: .zero, level: level, clickThrough: false)
            p.allowKey = true
            let host = NSHostingView(rootView: NotchListView(hover: hover))
            p.contentView = host
            list = p
            listHost = host
        }
        guard let list, let host = listHost else { return }
        host.layoutSubtreeIfNeeded()
        let size = host.fittingSize
        let top = band.frame.minY + 2
        list.setFrame(NSRect(x: band.frame.midX - size.width / 2, y: top - size.height, width: size.width, height: size.height),
                      display: true)
        list.orderFrontRegardless()
    }

    /// Keeps the open list sized to its content.
    func update() {
        if list?.isVisible == true { showList() }
    }
}
