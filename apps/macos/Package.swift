// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Mamachi",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "Mamachi", targets: ["Mamachi"]),
    ],
    targets: [
        .executableTarget(
            name: "Mamachi",
            path: "Sources/Mamachi",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("AVFoundation"),
                .linkedFramework("Carbon"),
                .linkedFramework("Security"),
                .linkedFramework("UserNotifications"),
            ]
        ),
        .testTarget(
            name: "MamachiTests",
            dependencies: ["Mamachi"],
            path: "Tests/MamachiTests"
        ),
    ],
    swiftLanguageModes: [.v5]
)
