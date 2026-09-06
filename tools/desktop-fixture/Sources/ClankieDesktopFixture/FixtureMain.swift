import AppKit
import Foundation

/// A local input recipient for native acceptance tests. It never synthesizes input.
@MainActor
final class Recorder {
  let role: String

  init(role: String) { self.role = role }

  func record(_ event: String, window: NSWindow? = nil, data: [String: Any] = [:]) {
    var record: [String: Any] = [
      "event": event,
      "role": self.role,
      "pid": ProcessInfo.processInfo.processIdentifier,
      "monotonic_ns": DispatchTime.now().uptimeNanoseconds,
      "app_active": NSApplication.shared.isActive,
      "frontmost_pid": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1,
    ]
    if let window {
      record["window_id"] = window.windowNumber
      record["title"] = window.title
      record["key_window"] = window.isKeyWindow
    }
    record["data"] = data
    do {
      let bytes = try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])
      FileHandle.standardOutput.write(bytes + Data([10]))
    } catch {
      FileHandle.standardError.write(Data("Fixture log failed: \(error)\n".utf8))
      NSApplication.shared.terminate(nil)
    }
  }
}

@MainActor
final class OpaqueTarget: NSView {
  let recorder: Recorder
  var clicks = 0
  private let hitRect = NSRect(x: 20, y: 25, width: 240, height: 70)

  init(frame: NSRect, recorder: Recorder) {
    self.recorder = recorder
    super.init(frame: frame)
  }

  required init?(coder: NSCoder) { nil }
  override func isAccessibilityElement() -> Bool { false }

  override func draw(_ dirtyRect: NSRect) {
    NSColor.controlBackgroundColor.setFill()
    self.bounds.fill()
    NSColor.systemBlue.setFill()
    NSBezierPath(roundedRect: self.hitRect, xRadius: 8, yRadius: 8).fill()
    let text = "Opaque target · clicks: \(self.clicks)"
    (text as NSString).draw(at: NSPoint(x: 30, y: 50), withAttributes: [
      .font: NSFont.systemFont(ofSize: 17), .foregroundColor: NSColor.white,
    ])
  }

  override func mouseDown(with event: NSEvent) {
    let point = self.convert(event.locationInWindow, from: nil)
    guard self.hitRect.contains(point) else { return }
    self.clicks += 1
    self.needsDisplay = true
    self.recorder.record("opaque_click", window: self.window, data: ["clicks": self.clicks])
  }

  override func mouseDragged(with event: NSEvent) {
    let point = self.convert(event.locationInWindow, from: nil)
    self.recorder.record("drag", window: self.window, data: ["x": point.x, "y": point.y])
  }

  override func scrollWheel(with event: NSEvent) {
    self.recorder.record("scroll", window: self.window, data: [
      "delta_x": event.scrollingDeltaX, "delta_y": event.scrollingDeltaY,
    ])
  }
}

@MainActor
final class InputTarget: NSTextView {
  let recorder: Recorder

  init(frame: NSRect, recorder: Recorder) {
    self.recorder = recorder
    super.init(frame: frame)
    self.font = .monospacedSystemFont(ofSize: 18, weight: .regular)
    self.isRichText = false
    self.setAccessibilityIdentifier("fixture-text")
    self.setAccessibilityLabel("Fixture input; use dummy text")
  }

  required init?(coder: NSCoder) { nil }

  override func keyDown(with event: NSEvent) {
    self.recorder.record("key_down", window: self.window, data: ["key_code": event.keyCode])
    super.keyDown(with: event)
  }

  override func didChangeText() {
    super.didChangeText()
    self.recorder.record("text_changed", window: self.window, data: ["text": self.string])
  }
}

@MainActor
final class Fixture: NSObject, NSApplicationDelegate, NSWindowDelegate {
  let recorder: Recorder
  let duration: TimeInterval
  var windows: [NSWindow] = []
  var heartbeat: Timer?
  var stop: Timer?

  init(role: String, duration: TimeInterval) {
    self.recorder = Recorder(role: role)
    self.duration = duration
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    let count = self.recorder.role == "target" ? 2 : 1
    for index in 1...count {
      let window = NSWindow(
        contentRect: NSRect(x: 100 + index * 40, y: 140 + index * 40, width: 520, height: 300),
        styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false
      )
      window.title = "Clankie \(self.recorder.role) fixture \(index)"
      window.isReleasedWhenClosed = false
      window.delegate = self
      let content = NSView(frame: NSRect(x: 0, y: 0, width: 520, height: 300))
      content.addSubview(OpaqueTarget(
        frame: NSRect(x: 0, y: 175, width: 520, height: 125), recorder: self.recorder
      ))
      content.addSubview(InputTarget(
        frame: NSRect(x: 20, y: 20, width: 480, height: 135), recorder: self.recorder
      ))
      window.contentView = content
      self.windows.append(window)
      window.orderBack(nil)
      self.recorder.record("window_created", window: window)
    }
    self.heartbeat = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self else { return }
        for window in self.windows { self.recorder.record("heartbeat", window: window) }
      }
    }
    self.stop = Timer.scheduledTimer(withTimeInterval: self.duration, repeats: false) { _ in
      MainActor.assumeIsolated { NSApplication.shared.terminate(nil) }
    }
  }

  func applicationDidBecomeActive(_ notification: Notification) {
    self.recorder.record("app_became_active")
  }

  func applicationDidResignActive(_ notification: Notification) {
    self.recorder.record("app_resigned_active")
  }

  func windowDidBecomeKey(_ notification: Notification) {
    self.recorder.record("window_became_key", window: notification.object as? NSWindow)
  }

  func windowDidResignKey(_ notification: Notification) {
    self.recorder.record("window_resigned_key", window: notification.object as? NSWindow)
  }

  func applicationWillTerminate(_ notification: Notification) {
    self.heartbeat?.invalidate()
    self.stop?.invalidate()
    self.recorder.record("stopped")
  }
}

@main
@MainActor
struct FixtureMain {
  static func main() {
    let args = Array(CommandLine.arguments.dropFirst())
    guard args != ["--help"], !args.isEmpty else {
      print("ClankieDesktopFixture --run target|operator --seconds 1...120")
      print("Creates test windows only with --run. Emits JSONL to stdout. Use dummy text.")
      return
    }
    guard args.count == 4, args[0] == "--run", ["target", "operator"].contains(args[1]),
      args[2] == "--seconds", let seconds = Int(args[3]), (1...120).contains(seconds)
    else {
      FileHandle.standardError.write(Data("Invalid fixture arguments. Use --help.\n".utf8))
      exit(64)
    }
    let app = NSApplication.shared
    app.setActivationPolicy(.regular)
    let fixture = Fixture(role: args[1], duration: TimeInterval(seconds))
    app.delegate = fixture
    withExtendedLifetime(fixture) { app.run() }
  }
}
