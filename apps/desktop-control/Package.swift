// swift-tools-version: 6.2
import PackageDescription

let package = Package(
  name: "ClankieDesktop",
  platforms: [.macOS(.v15)],
  products: [.executable(name: "clankie-desktop", targets: ["ClankieDesktop"])],
  targets: [
    .executableTarget(name: "ClankieDesktop"),
    .testTarget(name: "ClankieDesktopTests", dependencies: ["ClankieDesktop"]),
  ]
)
