// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "DEXPanic",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "RecoveryCore", targets: ["RecoveryCore"]),
        .executable(name: "DexPanicApp", targets: ["DexPanicApp"])
    ],
    targets: [
        .target(name: "RecoveryCore"),
        .executableTarget(name: "DexPanicApp", dependencies: ["RecoveryCore"]),
        .testTarget(name: "RecoveryCoreTests", dependencies: ["RecoveryCore"])
    ]
)
