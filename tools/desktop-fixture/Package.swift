// swift-tools-version: 6.2
import PackageDescription

let package = Package(
  name: "ClankieDesktopFixture",
  platforms: [.macOS(.v15)],
  products: [.executable(name: "ClankieDesktopFixture", targets: ["ClankieDesktopFixture"])],
  targets: [.executableTarget(name: "ClankieDesktopFixture")]
)
