// swift-tools-version: 5.9
import PackageDescription

// The pure conversation reducer is also exercised independently of the iOS UI.
let package = Package(
    name: "VanessaCore",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [.library(name: "VanessaCore", targets: ["VanessaCore"])],
    targets: [
        .target(name: "VanessaCore", path: "Vanessa/Core"),
        .testTarget(name: "VanessaCoreTests", dependencies: ["VanessaCore"], path: "Tests/CoreTests"),
    ]
)
