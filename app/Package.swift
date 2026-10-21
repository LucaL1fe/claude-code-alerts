// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ClaudeCodeAlerts",
    platforms: [.macOS(.v14)],
    targets: [
        .target(name: "Shared", path: "Sources/Shared"),
        .executableTarget(name: "ClaudeCodeAlerts", dependencies: ["Shared"], path: "Sources/App"),
        .executableTarget(name: "cca", dependencies: ["Shared"], path: "Sources/CLI"),
    ],
    swiftLanguageModes: [.v5]
)
