// swift-tools-version: 5.9
import PackageDescription

// DO NOT MODIFY THIS FILE - managed by Capacitor CLI commands
let package = Package(
    name: "CapApp-SPM",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "CapApp-SPM",
            targets: ["CapApp-SPM"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.5.0"),
        .package(name: "CapacitorClipboard", path: "../../../../../node_modules/.bun/@capacitor+clipboard@8.0.1+6139e07751574bda/node_modules/@capacitor/clipboard"),
        .package(name: "CapacitorLocalNotifications", path: "../../../../../node_modules/.bun/@capacitor+local-notifications@8.3.1+6139e07751574bda/node_modules/@capacitor/local-notifications")
    ],
    targets: [
        .target(
            name: "CapApp-SPM",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "CapacitorClipboard", package: "CapacitorClipboard"),
                .product(name: "CapacitorLocalNotifications", package: "CapacitorLocalNotifications")
            ]
        )
    ]
)
