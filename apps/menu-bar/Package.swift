// swift-tools-version: 6.2
import PackageDescription

let package = Package(
  name: "ClankieMenuBar",
  platforms: [.macOS(.v15)],
  products: [.executable(name: "ClankieMenuBar", targets: ["ClankieMenuBar"])],
  targets: [
    .executableTarget(
      name: "ClankieMenuBar",
      resources: [.copy("Resources/ClankieMenuBarIcon.svg")]
    ),
    .testTarget(name: "ClankieMenuBarTests", dependencies: ["ClankieMenuBar"]),
  ]
)
