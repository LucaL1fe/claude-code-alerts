import Darwin
import Foundation
import Shared

/// One client on the socket. Hooks and CLI calls connect, send one line and go.
/// VS Code windows stay connected and receive messages back.
final class Conn {
    let fd: Int32
    let id = UUID()
    private let writeLock = NSLock()

    init(fd: Int32) { self.fd = fd }

    func send(_ msg: Msg) {
        let data = Wire.encode(msg)
        writeLock.lock()
        defer { writeLock.unlock() }
        _ = data.withUnsafeBytes { write(fd, $0.baseAddress, data.count) }
    }

    func close() { Darwin.close(fd) }
}

/// Unix-socket server. Every line is decoded and handed to `onMessage` on the main thread.
final class Server {
    var onMessage: ((Msg, Conn) -> Void)?
    var onDisconnect: ((Conn) -> Void)?
    private var listenFD: Int32 = -1

    func start() {
        let path = CCA.socketPath
        unlink(path)
        listenFD = socket(AF_UNIX, SOCK_STREAM, 0)
        guard listenFD >= 0 else { NSLog("cca: socket() failed"); return }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let maxLen = MemoryLayout.size(ofValue: addr.sun_path) - 1
        withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
            ptr.withMemoryRebound(to: CChar.self, capacity: maxLen + 1) { dst in
                _ = path.withCString { strncpy(dst, $0, maxLen) }
            }
        }
        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(listenFD, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bound == 0 else { NSLog("cca: bind() failed: \(errno)"); return }
        chmod(path, 0o600)
        listen(listenFD, 32)
        let thread = Thread { [weak self] in self?.acceptLoop() }
        thread.name = "cca-accept"
        thread.start()
    }

    private func acceptLoop() {
        while true {
            let fd = accept(listenFD, nil, nil)
            if fd < 0 { continue }
            var noSigPipe: Int32 = 1
            setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))
            let conn = Conn(fd: fd)
            let thread = Thread { [weak self] in self?.readLoop(conn) }
            thread.start()
        }
    }

    private func readLoop(_ conn: Conn) {
        var buffer = Data()
        var chunk = [UInt8](repeating: 0, count: 16384)
        while true {
            let n = read(conn.fd, &chunk, chunk.count)
            if n <= 0 { break }
            buffer.append(contentsOf: chunk[0..<n])
            while let nl = buffer.firstIndex(of: 0x0A) {
                let line = buffer[buffer.startIndex..<nl]
                buffer.removeSubrange(buffer.startIndex...nl)
                if let msg = Wire.decode(Data(line)) {
                    DispatchQueue.main.async { self.onMessage?(msg, conn) }
                }
            }
        }
        DispatchQueue.main.async { self.onDisconnect?(conn) }
        conn.close()
    }
}
