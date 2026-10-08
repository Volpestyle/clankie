// Clankie's own lent-screen host. Apache-2.0. No borrowed desktop provider.
import AppKit
import ApplicationServices
import Carbon
import ScreenCaptureKit

func reply(_ id: String, _ ok: Bool, _ result: Any = [:]) {
  let value: [String: Any] = ["id": id, "ok": ok, "result": result]
  if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) {
    FileHandle.standardOutput.write(data + Data([10]))
  }
}
func attr(_ e: AXUIElement, _ key: String) -> CFTypeRef? {
  var value: CFTypeRef?
  return AXUIElementCopyAttributeValue(e, key as CFString, &value) == .success ? value : nil
}
func text(_ e: AXUIElement, _ key: String) -> String { (attr(e, key) as? String) ?? "" }
func frame(_ e: AXUIElement) -> CGRect? {
  guard let p = attr(e, kAXPositionAttribute), let s = attr(e, kAXSizeAttribute),
    CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID()
  else { return nil }
  var point = CGPoint.zero
  var size = CGSize.zero
  guard AXValueGetValue(p as! AXValue, .cgPoint, &point),
    AXValueGetValue(s as! AXValue, .cgSize, &size)
  else { return nil }
  return CGRect(origin: point, size: size)
}
func activity() -> UInt64 {
  let events: [CGEventType] = [
    .keyDown, .keyUp, .flagsChanged, .leftMouseDown, .rightMouseDown, .otherMouseDown, .mouseMoved,
    .scrollWheel, .leftMouseDragged, .rightMouseDragged,
  ]
  return events.reduce(0) {
    $0 &+ UInt64(CGEventSource.counterForEventType(.combinedSessionState, eventType: $1))
  }
}
func console() -> Bool {
  guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
  return session["kCGSessionOnConsoleKey"] as? Bool == true
    && session["kCGSessionLoginDoneKey"] as? Bool == true
    && (session["kCGSSessionUserIDKey"] as? NSNumber)?.uint32Value == getuid()
    && !IsSecureEventInputEnabled()
}
struct Snapshot {
  let window: SCWindow
  let app: NSRunningApplication
  let launched: Date
  let captured: TimeInterval
  let axWindow: AXUIElement?
  let elements: [String: AXUIElement]
  let labels: [String: String]
}
@MainActor final class Host: NSObject, NSWindowDelegate {
  var session = "", lease = "", consent = false, allowInput = false, injected = false, busy = false
  var heartbeat = ProcessInfo.processInfo.systemUptime, person: UInt64 = 0
  var pet: NSPanel?
  var snapshots: [String: Snapshot] = [:]
  var timer: Timer?
  var tap: CFMachPort?
  var source: CFRunLoopSource?
  var pending: [Int64: CGEventType] = [:]
  var heldKey: CGKeyCode?
  var heldButton = false
  var drainUnknown = false
  var foreign: UInt64 = 0
  var lastPerson = ProcessInfo.processInfo.systemUptime
  var nativeBusy = false
  func observerReady() -> Bool {
    guard let tap else { return false }
    return CGEvent.tapIsEnabled(tap: tap)
  }
  func installObserver() -> Bool {
    if observerReady() { return true }
    if tap != nil {
      drainUnknown = true
      return false
    }
    let types: [CGEventType] = [
      .keyDown, .keyUp, .flagsChanged, .leftMouseDown, .leftMouseUp,
      .rightMouseDown, .rightMouseUp, .otherMouseDown, .otherMouseUp, .mouseMoved,
      .scrollWheel, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged,
    ]
    let mask = types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
    tap = CGEvent.tapCreate(
      tap: .cgAnnotatedSessionEventTap, place: .tailAppendEventTap,
      options: .listenOnly, eventsOfInterest: mask,
      callback: { _, kind, event, pointer in
        guard let pointer else { return Unmanaged.passUnretained(event) }
        MainActor.assumeIsolated {
          let host = Unmanaged<Host>.fromOpaque(pointer).takeUnretainedValue()
          if kind == .tapDisabledByTimeout || kind == .tapDisabledByUserInput {
            host.drainUnknown = true
            host.fence()
          } else {
            let identity = event.getIntegerValueField(.eventSourceUserData)
            if let expected = host.pending[identity], expected == kind,
              event.getIntegerValueField(.eventSourceUnixProcessID) == Int64(getpid())
            {
              host.pending.removeValue(forKey: identity)
            } else {
              host.foreign &+= 1
              host.lastPerson = ProcessInfo.processInfo.systemUptime
              host.fence()
            }
          }
        }
        return Unmanaged.passUnretained(event)
      }, userInfo: Unmanaged.passUnretained(self).toOpaque())
    guard let tap else { return false }
    source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
    guard let source else {
      drainUnknown = true
      return false
    }
    CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
    return observerReady()
  }
  func drainProof() -> [String: Any] {
    let clean =
      observerReady() && !drainUnknown && !injected && !busy && !nativeBusy
      && pending.isEmpty && heldKey == nil && !heldButton
    return [
      "quiescent": clean, "session": session, "leaseId": lease,
      "observer": observerReady(), "uncertain": drainUnknown || injected,
      "pending": pending.count, "held": (heldKey == nil ? 0 : 1) + (heldButton ? 1 : 0),
      "busy": busy || nativeBusy,
    ]
  }
  func post(_ event: CGEvent, _ kind: CGEventType, cleanup: Bool = false) async throws {
    guard cleanup || (observerReady() && !drainUnknown && consent) else {
      throw NSError(domain: "observer", code: 1)
    }
    var identity = Int64.random(in: 1...Int64.max)
    while pending[identity] != nil { identity = Int64.random(in: 1...Int64.max) }
    pending[identity] = kind
    event.setIntegerValueField(.eventSourceUserData, value: identity)
    injected = true  // A tap acknowledgment is not target-queue drain proof.
    event.post(tap: .cgSessionEventTap)
    if !observerReady() || drainUnknown {
      drainUnknown = true
      throw NSError(domain: "cleanup_unknown", code: 1)
    }
    let deadline = ProcessInfo.processInfo.systemUptime + 1
    while pending[identity] != nil {
      guard observerReady(), !drainUnknown, ProcessInfo.processInfo.systemUptime < deadline else {
        drainUnknown = true
        throw NSError(domain: "delivery", code: 1)
      }
      try await Task.sleep(nanoseconds: 5_000_000)
    }
  }
  func cleanupInput() async {
    do {
      if let key = heldKey {
        guard let event = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: false) else {
          throw NSError(domain: "cleanup", code: 1)
        }
        try await post(event, .keyUp, cleanup: true)
        heldKey = nil
      }
      if heldButton {
        guard let location = CGEvent(source: nil)?.location,
          let event = CGEvent(
            mouseEventSource: nil, mouseType: .leftMouseUp,
            mouseCursorPosition: location, mouseButton: .left)
        else {
          throw NSError(domain: "cleanup", code: 2)
        }
        try await post(event, .leftMouseUp, cleanup: true)
        heldButton = false
      }
    } catch { drainUnknown = true }
  }
  func rawInput(
    _ input: [String: Any], _ screenshot: [String: Any], _ snapshot: Snapshot,
    _ token: String
  ) async throws {
    guard CGPreflightPostEventAccess(), observerReady(), !drainUnknown else {
      throw NSError(domain: "input_permission", code: 1)
    }
    func check() throws {
      guard valid(token, input: true),
        let app = NSRunningApplication(processIdentifier: snapshot.app.processIdentifier),
        app.launchDate == snapshot.launched, app.bundleIdentifier == snapshot.app.bundleIdentifier,
        !app.isTerminated, allowed(app),
        NSWorkspace.shared.frontmostApplication?.processIdentifier
          == snapshot.app.processIdentifier,
        let current = axWindow(snapshot.window), let original = snapshot.axWindow,
        CFEqual(current, original), frame(current) == snapshot.window.frame,
        let focusedWindow = attr(AXUIElementCreateApplication(snapshot.app.processIdentifier), kAXFocusedWindowAttribute),
        CFEqual(focusedWindow, current),
        let focused = attr(
          AXUIElementCreateApplication(snapshot.app.processIdentifier), kAXFocusedUIElementAttribute
        ),
        CFGetTypeID(focused) == AXUIElementGetTypeID(),
        text(focused as! AXUIElement, kAXSubroleAttribute) != kAXSecureTextFieldSubrole,
        let focusedOwner = attr(focused as! AXUIElement, kAXWindowAttribute), CFEqual(focusedOwner, current)
      else {
        throw NSError(domain: "input_target", code: 1)
      }
    }
    func checkPoint(_ point: CGPoint) throws {
      var hit: AXUIElement?
      guard
        AXUIElementCopyElementAtPosition(
          AXUIElementCreateSystemWide(), Float(point.x),
          Float(point.y), &hit) == .success, let hit,
        text(hit, kAXSubroleAttribute) != kAXSecureTextFieldSubrole,
        let owner = attr(hit, kAXWindowAttribute), let original = snapshot.axWindow,
        CFEqual(owner, original)
      else { throw NSError(domain: "point_target", code: 1) }
    }
    func point(_ value: Any?) throws -> CGPoint {
      guard let at = value as? [String: Any], let x = at["x"] as? Double,
        let y = at["y"] as? Double, let width = screenshot["width"] as? Double,
        let height = screenshot["height"] as? Double, x.isFinite, y.isFinite,
        x >= 0, y >= 0, x < width, y < height
      else { throw NSError(domain: "point", code: 1) }
      let point = CGPoint(
        x: snapshot.window.frame.minX + x * snapshot.window.frame.width / width,
        y: snapshot.window.frame.minY + y * snapshot.window.frame.height / height)
      try checkPoint(point)
      return point
    }
    try check()
    guard
      CGEvent(source: nil)?.flags.intersection([
        .maskCommand, .maskControl, .maskAlternate, .maskShift, .maskSecondaryFn,
      ]).isEmpty == true,
      !CGEventSource.buttonState(.combinedSessionState, button: .left),
      !CGEventSource.buttonState(.combinedSessionState, button: .right),
      !CGEventSource.buttonState(.combinedSessionState, button: .center)
    else {
      throw NSError(domain: "person_keys", code: 1)
    }
    guard let application = snapshot.axWindow.flatMap(windowPID),
      let focused = attr(AXUIElementCreateApplication(application), kAXFocusedUIElementAttribute),
      CFGetTypeID(focused) == AXUIElementGetTypeID(),
      text(focused as! AXUIElement, kAXSubroleAttribute) != kAXSecureTextFieldSubrole
    else {
      throw NSError(domain: "secure_focus", code: 1)
    }
    nativeBusy = true
    do {
      let kind = input["kind"] as? String
      if kind == "key" {
        let keys: [String: CGKeyCode] = [
          "ArrowLeft": 123, "ArrowRight": 124, "ArrowDown": 125,
          "ArrowUp": 126, "Tab": 48, "Space": 49, "Home": 115, "End": 119, "PageUp": 116,
          "PageDown": 121,
        ]
        guard let name = input["keys"] as? String, let key = keys[name],
          let down = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: false)
        else {
          throw NSError(domain: "key", code: 1)
        }
        down.flags = []
        up.flags = []
        heldKey = key
        try await post(down, .keyDown)
        try check()
        try await post(up, .keyUp, cleanup: true)
        heldKey = nil
      } else if kind == "scroll" {
        guard let amount = input["amount"] as? Int, amount >= 1, amount <= 10,
          let direction = input["direction"] as? String
        else { throw NSError(domain: "scroll", code: 1) }
        let at = try point(input["at"])
        let vertical = direction == "up" ? amount : direction == "down" ? -amount : 0
        let horizontal = direction == "left" ? amount : direction == "right" ? -amount : 0
        guard vertical != 0 || horizontal != 0,
          let event = CGEvent(
            scrollWheelEvent2Source: nil, units: .line, wheelCount: 2,
            wheel1: Int32(vertical), wheel2: Int32(horizontal), wheel3: 0)
        else {
          throw NSError(domain: "scroll", code: 2)
        }
        event.location = at
        try await post(event, .scrollWheel)
      } else if kind == "drag" {
        let from = try point(input["from"])
        let to = try point(input["to"])
        guard
          let down = CGEvent(
            mouseEventSource: nil, mouseType: .leftMouseDown,
            mouseCursorPosition: from, mouseButton: .left)
        else { throw NSError(domain: "drag", code: 1) }
        heldButton = true
        try await post(down, .leftMouseDown)
        for index in 1...8 {
          try check()
          let fraction = Double(index) / 8
          let at = CGPoint(
            x: from.x + (to.x - from.x) * fraction, y: from.y + (to.y - from.y) * fraction)
          try checkPoint(at)
          guard
            let event = CGEvent(
              mouseEventSource: nil, mouseType: .leftMouseDragged,
              mouseCursorPosition: at, mouseButton: .left)
          else { throw NSError(domain: "drag", code: 2) }
          try await post(event, .leftMouseDragged)
          try await Task.sleep(nanoseconds: 20_000_000)
        }
        try check()
        guard
          let up = CGEvent(
            mouseEventSource: nil, mouseType: .leftMouseUp,
            mouseCursorPosition: to, mouseButton: .left)
        else { throw NSError(domain: "drag", code: 3) }
        try await post(up, .leftMouseUp, cleanup: true)
        heldButton = false
      } else {
        throw NSError(domain: "kind", code: 1)
      }
      try check()
      nativeBusy = false
    } catch {
      fence()
      await cleanupInput()
      nativeBusy = false
      throw error
    }
  }
  func fence() {
    let was = consent
    consent = false
    allowInput = false
    snapshots.removeAll()
    if was { FileHandle.standardOutput.write(Data("{\"event\":\"stopped\"}\n".utf8)) }
    pet?.title = "Clankie stopped"
    if let label = pet?.contentView?.subviews.first as? NSTextField {
      label.stringValue = "🦊 Clankie stopped · lease may be held"
    }
  }
  @objc func stop() {
    fence()
  }
  func windowShouldClose(_ sender: NSWindow) -> Bool {
    stop()
    return false
  }
  func valid(_ token: String, input: Bool = false) -> Bool {
    let valid =
      token == session && !session.isEmpty && consent && pet?.isVisible == true && console()
      && CGPreflightListenEventAccess() && ProcessInfo.processInfo.systemUptime - heartbeat < 2
      && observerReady() && foreign == person && (!input || allowInput)
    if !valid { fence() }
    return valid
  }
  func showPet() {
    pet?.orderOut(nil)
    let panel = NSPanel(
      contentRect: NSRect(x: 30, y: 60, width: 370, height: 92),
      styleMask: [.titled, .closable, .nonactivatingPanel], backing: .buffered, defer: false)
    panel.title = "Clankie"
    panel.level = .floating
    panel.hidesOnDeactivate = false
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    let label = NSTextField(
      labelWithString: allowInput ? "🦊 Clankie is driving" : "🦊 Clankie is observing · input off")
    label.frame = NSRect(x: 12, y: 48, width: 350, height: 24)
    let button = NSButton(title: "Stop", target: self, action: #selector(stop))
    button.frame = NSRect(x: 12, y: 10, width: 100, height: 30)
    panel.contentView?.addSubview(label)
    panel.contentView?.addSubview(button)
    panel.delegate = self
    panel.orderFrontRegardless()
    pet = panel
  }
  func allowed(_ app: NSRunningApplication) -> Bool {
    guard let bundle = app.bundleIdentifier?.lowercased(), app.processIdentifier != getpid(),
      app.launchDate != nil
    else { return false }
    let denies = [
      "terminal", "iterm", "powershell", "systempreferences", "systemsettings", "securityagent",
      "loginwindow", "keychain", "activitymonitor", "console", "scripteditor", "automator", "xcode",
      "visualstudio", "vscode", "codex", "herdr",
    ]
    return !denies.contains(where: bundle.contains)
  }
  func selected(_ target: [String: Any]) async throws -> (SCWindow, NSRunningApplication) {
    guard let pidString = target["appId"] as? String, let pid = Int32(pidString),
      let windowString = target["windowId"] as? String, let windowID = UInt32(windowString),
      let app = NSRunningApplication(processIdentifier: pid), allowed(app)
    else { throw NSError(domain: "target", code: 1) }
    let content = try await SCShareableContent.excludingDesktopWindows(
      true, onScreenWindowsOnly: true)
    guard
      let window = content.windows.first(where: {
        $0.windowID == windowID && $0.owningApplication?.processID == pid && $0.isOnScreen
          && $0.windowLayer == 0
      }),
      window.frame.width > 0, window.frame.height > 0
    else { throw NSError(domain: "target", code: 2) }
    return (window, app)
  }
  func axWindow(_ window: SCWindow) -> AXUIElement? {
    guard AXIsProcessTrusted(), let pid = window.owningApplication?.processID else { return nil }
    let application = AXUIElementCreateApplication(pid)
    guard let windows = attr(application, kAXWindowsAttribute) as? [AXUIElement] else { return nil }
    let matching = windows.filter { element in
      guard let bounds = frame(element) else { return false }
      return abs(bounds.minX - window.frame.minX) < 1 && abs(bounds.minY - window.frame.minY) < 1
        && abs(bounds.width - window.frame.width) < 1
        && abs(bounds.height - window.frame.height) < 1
        && text(element, kAXTitleAttribute) == (window.title ?? "")
    }
    return matching.count == 1 ? matching[0] : nil
  }
  func observe(_ window: AXUIElement?) -> (
    [String: Any], [String: AXUIElement], [String: String], [[String: Any]]
  ) {
    var rows: [[String: String]] = []
    var elements: [String: AXUIElement] = [:]
    var labels: [String: String] = [:]
    var publicElements: [[String: Any]] = []
    func visit(_ element: AXUIElement, _ depth: Int) {
      if rows.count >= 160 || depth > 12 { return }
      let role = text(element, kAXRoleAttribute)
      let subrole = text(element, kAXSubroleAttribute)
      let secure = subrole == kAXSecureTextFieldSubrole
      let label = String(text(element, kAXTitleAttribute).prefix(128))
      let value = secure ? "[secure]" : String(text(element, kAXValueAttribute).prefix(2048))
      rows.append(["role": role, "label": label, "value": value])
      var actions: CFArray?
      AXUIElementCopyActionNames(element, &actions)
      if !secure, (actions as? [String])?.contains(kAXPressAction) == true {
        let id = UUID().uuidString.lowercased()
        elements[id] = element
        labels[id] = label
        publicElements.append(["id": id, "label": label, "actionable": true])
      }
      for child in (attr(element, kAXChildrenAttribute) as? [AXUIElement] ?? []).prefix(160) {
        visit(child, depth + 1)
      }
    }
    if let window { visit(window, 0) }
    let tree =
      String(
        data: (try? JSONSerialization.data(withJSONObject: rows, options: [.sortedKeys])) ?? Data(),
        encoding: .utf8) ?? ""
    var access: [String: Any] = ["tree": String(tree.prefix(8192))]
    if let window, let pid = windowPID(window),
      let focused = attr(AXUIElementCreateApplication(pid), kAXFocusedUIElementAttribute),
      CFGetTypeID(focused) == AXUIElementGetTypeID()
    {
      let e = focused as! AXUIElement
      if text(e, kAXSubroleAttribute) != kAXSecureTextFieldSubrole,
        let owner = attr(e, kAXWindowAttribute), CFEqual(owner, window)
      {
        access["focused_element"] =
          text(e, kAXRoleAttribute) + ":" + String(text(e, kAXTitleAttribute).prefix(128))
        access["document_text"] = String(text(e, kAXValueAttribute).prefix(8192))
        access["selected_text"] = String(text(e, kAXSelectedTextAttribute).prefix(8192))
      }
    }
    return (access, elements, labels, publicElements)
  }
  func windowPID(_ element: AXUIElement) -> pid_t? {
    var pid: pid_t = 0
    return AXUIElementGetPid(element, &pid) == .success ? pid : nil
  }
  func handle(_ message: [String: Any]) async {
    guard let id = message["id"] as? String, UUID(uuidString: id) != nil,
      let action = message["action"] as? String, let token = message["session"] as? String,
      let value = message["value"] as? [String: Any]
    else { return }
    // Stop and heartbeat remain independent of awaited capture/AX work.
    if action == "heartbeat" {
      heartbeat = ProcessInfo.processInfo.systemUptime
      reply(id, true)
      return
    }
    if action == "stop" {
      guard token == session, !lease.isEmpty else {
        reply(id, false)
        return
      }
      fence()
      reply(id, true, drainProof())
      return
    }
    if action == "end" {
      guard drainProof()["quiescent"] as? Bool == true, token == session else {
        reply(id, false)
        return
      }
      fence()
      lease = ""
      session = ""
      reply(id, true)
      return
    }
    if busy {
      reply(id, false)
      return
    }
    busy = true
    defer { busy = false }
    do {
      if action == "consent" {
        guard !consent, lease.isEmpty, console(),
          let conversation = value["conversationId"] as? String
        else { throw NSError(domain: "consent", code: 1) }
        let alert = NSAlert()
        alert.messageText = "Lend this screen to Clankie?"
        alert.informativeText =
          "Session: \(conversation.prefix(512))\nObserve is read-only. Allow input lets Clankie press accessible controls, append text, use navigation keys, drag and scroll. Stop or your own input ends consent. Sign-ins, codes, payments and destructive actions stay with you."
        alert.addButton(withTitle: "Observe only")
        alert.addButton(withTitle: "Cancel")
        alert.addButton(withTitle: "Allow input")
        NSApp.activate(ignoringOtherApps: true)
        let choice = alert.runModal()
        consent = choice == .alertFirstButtonReturn || choice == .alertThirdButtonReturn
        allowInput = choice == .alertThirdButtonReturn
        if !CGPreflightScreenCaptureAccess() || !CGPreflightListenEventAccess()
          || !installObserver()
          || (allowInput && !AXIsProcessTrusted())
        {
          consent = false
          allowInput = false
        }
        if consent {
          session = token
          injected = false
          heartbeat = ProcessInfo.processInfo.systemUptime
          person = foreign
          lastPerson = ProcessInfo.processInfo.systemUptime
          showPet()
        }
        reply(id, true, ["approved": consent, "allowInput": allowInput])
        return
      }
      guard valid(token), CGPreflightScreenCaptureAccess() else {
        throw NSError(domain: "permission", code: 1)
      }
      if action == "bind" {
        guard lease.isEmpty, let id = value["leaseId"] as? String else {
          throw NSError(domain: "lease", code: 1)
        }
        lease = id
        reply(message["id"] as! String, true, ["bound": true])
        return
      }
      guard !lease.isEmpty else { throw NSError(domain: "lease", code: 2) }
      if action == "inventory" {
        let content = try await SCShareableContent.excludingDesktopWindows(
          true, onScreenWindowsOnly: true)
        guard valid(token) else { throw NSError(domain: "policy", code: 1) }
        let apps = content.applications.compactMap { app -> [String: Any]? in
          guard let native = NSRunningApplication(processIdentifier: app.processID), allowed(native)
          else { return nil }
          return ["appId": String(app.processID), "name": String(app.applicationName.prefix(100))]
        }
        let pids = Set(apps.compactMap { $0["appId"] as? String })
        let windows = content.windows.filter {
          $0.isOnScreen && $0.windowLayer == 0
            && pids.contains(String($0.owningApplication?.processID ?? -1))
        }.map { window in
          [
            "appId": String(window.owningApplication!.processID),
            "windowId": String(window.windowID), "title": String((window.title ?? "").prefix(512)),
          ]
        }
        reply(
          id, true,
          [
            "complete": apps.count <= 128 && windows.count <= 128, "apps": Array(apps.prefix(128)),
            "windows": Array(windows.prefix(128)),
          ])
        return
      }
      if action == "capture" {
        guard let target = value["target"] as? [String: Any] else {
          throw NSError(domain: "target", code: 3)
        }
        let (window, app) = try await selected(target)
        let config = SCStreamConfiguration()
        config.width = min(4096, Int(window.frame.width * 2))
        config.height = min(4096, Int(window.frame.height * 2))
        config.showsCursor = false
        let image = try await SCScreenshotManager.captureImage(
          contentFilter: SCContentFilter(desktopIndependentWindow: window), configuration: config)
        guard valid(token),
          let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]),
          png.count <= 16 * 1024 * 1024
        else { throw NSError(domain: "capture", code: 1) }
        let ax = axWindow(window)
        let (access, elements, labels, publicElements) = observe(ax)
        let ref = UUID().uuidString.lowercased()
        snapshots.removeAll()
        snapshots[ref] = Snapshot(
          window: window, app: app, launched: app.launchDate!,
          captured: ProcessInfo.processInfo.systemUptime, axWindow: ax, elements: elements,
          labels: labels)
        reply(
          id, true,
          [
            "png": png.base64EncodedString(),
            "coordinates": [
              "space": "global_display_points", "origin": "top_left",
              "bounds": [
                "x": window.frame.minX, "y": window.frame.minY, "width": window.frame.width,
                "height": window.frame.height,
              ],
            ], "elements": publicElements, "accessibility": access, "reference": ref,
          ])
        return
      }
      if action == "input" {
        guard valid(token, input: true), AXIsProcessTrusted(),
          let ref = value["reference"] as? String,
          let snapshot = snapshots[ref], let windowAX = snapshot.axWindow,
          let input = value["input"] as? [String: Any], input["foreground"] as? Bool == true,
          let kind = input["kind"] as? String, let expect = input["expect"] as? [String: String],
          let field = expect["field"], let equals = expect["equals"],
          let screenshot = value["screenshot"] as? [String: Any],
          screenshot["leaseId"] as? String == lease,
          snapshot.app.launchDate == snapshot.launched, allowed(snapshot.app),
          ProcessInfo.processInfo.systemUptime - snapshot.captured < 30,
          ProcessInfo.processInfo.systemUptime - lastPerson >= 2
        else { throw NSError(domain: "input", code: 1) }
        let target: [String: Any] = [
          "appId": String(snapshot.app.processIdentifier),
          "windowId": String(snapshot.window.windowID),
        ]
        let (window, currentApp) = try await selected(target)
        guard currentApp.launchDate == snapshot.launched,
          currentApp.bundleIdentifier == snapshot.app.bundleIdentifier, !currentApp.isTerminated,
          window.frame == snapshot.window.frame, let currentAX = axWindow(window),
          CFEqual(currentAX, windowAX)
        else { throw NSError(domain: "drift", code: 1) }
        let before = observe(currentAX).0
        guard before[field] as? String != equals else { throw NSError(domain: "effect", code: 1) }
        snapshot.app.activate(options: [])
        guard valid(token, input: true),
          NSWorkspace.shared.frontmostApplication?.processIdentifier
            == snapshot.app.processIdentifier,
          let front = attr(
            AXUIElementCreateApplication(snapshot.app.processIdentifier), kAXFocusedWindowAttribute),
          CFEqual(front, windowAX)
        else { throw NSError(domain: "foreground", code: 1) }
        var result = AXError.failure
        if ["key", "drag", "scroll"].contains(kind) {
          try await rawInput(input, screenshot, snapshot, token)
          result = .success
        } else if kind == "type" {
          guard input["clear"] as? Bool != true, let append = input["text"] as? String,
            append.count <= 2048,
            !append.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
            let focused = attr(
              AXUIElementCreateApplication(snapshot.app.processIdentifier),
              kAXFocusedUIElementAttribute), CFGetTypeID(focused) == AXUIElementGetTypeID()
          else { throw NSError(domain: "text", code: 1) }
          let element = focused as! AXUIElement
          guard [kAXTextFieldRole, kAXTextAreaRole].contains(text(element, kAXRoleAttribute)),
            text(element, kAXSubroleAttribute) != kAXSecureTextFieldSubrole,
            let owner = attr(element, kAXWindowAttribute), CFEqual(owner, windowAX)
          else { throw NSError(domain: "text", code: 2) }
          var settable = DarwinBoolean(false)
          guard
            AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable)
              == .success, settable.boolValue
          else { throw NSError(domain: "text", code: 3) }
          guard let oldValue = attr(element, kAXValueAttribute) as? String else {
            throw NSError(domain: "text", code: 4)
          }
          injected = true
          result = AXUIElementSetAttributeValue(
            element, kAXValueAttribute as CFString, (oldValue + append) as CFString)
        } else {
          var element: AXUIElement?
          if kind == "element", let key = input["elementId"] as? String {
            element = snapshot.elements[key]
          }
          if kind == "click", input["button"] as? String == "left",
            let at = input["at"] as? [String: Double],
            let width = screenshot["width"] as? Double,
            let height = screenshot["height"] as? Double,
            let x = at["x"], let y = at["y"], x >= 0, y >= 0, x < width, y < height
          {
            var hit: AXUIElement?
            AXUIElementCopyElementAtPosition(
              AXUIElementCreateSystemWide(),
              Float(window.frame.minX + x * window.frame.width / width),
              Float(window.frame.minY + y * window.frame.height / height), &hit)
            if let hit, snapshot.elements.values.contains(where: { CFEqual($0, hit) }) {
              element = hit
            }
          }
          guard let element, let owner = attr(element, kAXWindowAttribute),
            CFEqual(owner, windowAX),
            snapshot.elements.contains(where: {
              CFEqual($0.value, element)
                && snapshot.labels[$0.key] == String(text(element, kAXTitleAttribute).prefix(128))
            })
          else { throw NSError(domain: "element", code: 1) }
          injected = true
          result = AXUIElementPerformAction(element, kAXPressAction as CFString)
        }
        snapshots.removeAll()
        let changed =
          result == .success && valid(token, input: true)
          && observe(windowAX).0[field] as? String == equals
        if !changed { fence() }
        reply(
          id, true,
          [
            "outcome": changed ? "confirmed" : "uncertain",
            "detail": changed
              ? "Exact changed accessibility field observed"
              : "Native effect is uncertain; stop and retain lease",
          ])
        return
      }
      throw NSError(domain: "operation", code: 1)
    } catch {
      if action == "input" { fence() }
      reply(id, false)
    }
  }
  func start() {
    timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { if let self, self.consent { _ = self.valid(self.session) } }
    }
  }
}
MainActor.assumeIsolated {
  let application = NSApplication.shared
  application.setActivationPolicy(.accessory)
  let host = Host()
  host.start()
  DispatchQueue.global().async {
    while let line = readLine() {
      if line.utf8.count > 65536 { continue }
      guard let data = line.data(using: .utf8),
        let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
      else { continue }
      DispatchQueue.main.async { Task { @MainActor in await host.handle(value) } }
    }
    DispatchQueue.main.async {
      host.fence()
      NSApp.terminate(nil)
    }
  }
  application.run()

}
