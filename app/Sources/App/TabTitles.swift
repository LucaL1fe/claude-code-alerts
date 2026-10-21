import Darwin
import Foundation

/// Puts a colored dot in front of a session's terminal tab title (🟢 done, 🟠 needs you, 🟣 plan, 🔴 error),
/// by writing a title escape sequence (OSC 2) to the session's terminal. Works in VS Code (which shows the title
/// Claude Code sets) and in other terminals. While Claude works it shows its own spinner title again by itself.
final class TabTitles {
    private var written: [String: String] = [:]

    static func dot(_ state: AState) -> String? {
        switch state {
        case .input: return "🟠"
        case .review: return "🟣"
        case .done: return "🟢"
        case .error, .mac: return "🔴"
        case .background: return "⏳"
        default: return nil
        }
    }

    /// Brings every session's tab title in line with its state.
    func sync(_ sessions: [Session], enabled: Bool) {
        for s in sessions where !s.id.hasPrefix("debug-") {
            guard let tty = s.tty else { continue }
            let title: String?
            if enabled, let d = Self.dot(s.state) {
                title = "\(d) \(s.name)"
            } else if written[s.id] != nil || s.customName != nil, s.state == .idle {
                // Seen, or dots switched off: back to Claude's own style.
                title = "✳ \(s.name)"
            } else {
                title = nil
            }
            guard let title, written[s.id] != title else { continue }
            written[s.id] = title
            // Claude writes its own title when a turn ends; write again shortly after so ours wins.
            for delay in [0.0, 0.6, 2.0] {
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                    guard self?.written[s.id] == title else { return }
                    Self.write(title, to: tty)
                }
            }
        }
        let alive = Set(sessions.map(\.id))
        written = written.filter { alive.contains($0.key) }
    }

    /// Writes the name (or dot + name) of each session again, e.g. after VS Code reloaded its window.
    func restore(_ sessions: [Session], enabled: Bool) {
        for s in sessions where !s.id.hasPrefix("debug-") {
            guard let tty = s.tty else { continue }
            let title = enabled ? (Self.dot(s.state).map { "\($0) \(s.name)" } ?? "✳ \(s.name)") : "✳ \(s.name)"
            written[s.id] = title
            Self.write(title, to: tty)
        }
    }

    /// Claude started working again and draws its own title: ours is gone.
    func forget(_ sessionId: String) { written.removeValue(forKey: sessionId) }

    private static func write(_ title: String, to tty: String) {
        let clean = title.replacingOccurrences(of: "\u{07}", with: "").replacingOccurrences(of: "\u{1b}", with: "")
        // VS Code shows a Claude terminal's title only after it saw "Claude Code" in a title (that is how it detects
        // the agent, and a window reload forgets it), so that comes first.
        let seq = "\u{1b}]2;Claude Code\u{07}\u{1b}]2;\(clean)\u{07}"
        let fd = open(tty, O_WRONLY | O_NOCTTY | O_NONBLOCK)
        guard fd >= 0 else { return }
        defer { close(fd) }
        let bytes = Array(seq.utf8)
        _ = bytes.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, bytes.count) }
    }
}
