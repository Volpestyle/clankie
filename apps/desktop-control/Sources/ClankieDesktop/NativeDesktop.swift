import AppKit
import ApplicationServices
import Darwin
import Foundation

@MainActor
final class NativeDesktop: DesktopDriver {
  let target: ProcessIdentity
  private let application: AXUIElement
  private var elements: [Int: AXUIElement] = [:]
  private var hashBuckets: [CFHashCode: [Int]] = [:]
  private var activationObserver: (any NSObjectProtocol)?
  private(set) var focusChanges = 0

  init() throws {
    guard AXIsProcessTrusted() else {
      throw Failure(
        code: "permission_denied",
        message:
          "Accessibility denied for \(CommandLine.arguments[0]); no permission prompt was requested"
      )
    }
    let apps = NSRunningApplication.runningApplications(withBundleIdentifier: "com.spotify.client")
      .filter { !$0.isTerminated }
    guard apps.count == 1, let identity = Self.identity(apps[0]) else {
      throw Failure(
        code: "target_ambiguous",
        message: "Exactly one running Spotify process with a known generation is required")
    }
    target = identity
    application = AXUIElementCreateApplication(identity.pid)
    AXUIElementSetMessagingTimeout(application, 0.15)
    activationObserver = NSWorkspace.shared.notificationCenter.addObserver(
      forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated { self?.focusChanges += 1 }
    }
  }

  static func identity(_ app: NSRunningApplication) -> ProcessIdentity? {
    var info = proc_bsdinfo()
    let size = MemoryLayout<proc_bsdinfo>.size
    guard !app.isTerminated, let bundle = app.bundleIdentifier,
      proc_pidinfo(app.processIdentifier, PROC_PIDTBSDINFO, 0, &info, Int32(size)) == Int32(size)
    else { return nil }
    return ProcessIdentity(
      pid: app.processIdentifier,
      generation: String(info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec), bundle: bundle)
  }

  func trusted() -> Bool { AXIsProcessTrusted() }
  func currentTarget() -> ProcessIdentity? {
    NSRunningApplication(processIdentifier: target.pid).flatMap(Self.identity)
  }
  func foreground() -> ProcessIdentity? {
    NSWorkspace.shared.frontmostApplication.flatMap(Self.identity)
  }
  func settle() { RunLoop.current.run(until: Date().addingTimeInterval(0.04)) }

  private func read(_ element: AXUIElement, _ name: String, deadline: OperationDeadline) throws -> (
    AXError, CFTypeRef?
  ) {
    try deadline.check()
    var value: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    return (error, value)
  }

  private func text(_ element: AXUIElement, _ name: String, deadline: OperationDeadline) throws
    -> String
  {
    let (error, value) = try read(element, name, deadline: deadline)
    guard [.success, .attributeUnsupported, .noValue].contains(error) else {
      throw Failure(code: "ax_read", message: "\(name) read failed: \(error.rawValue)")
    }
    let string = (value as? String) ?? ""
    guard string.utf8.count <= 2048 else {
      throw Failure(
        code: "text_limit",
        message: "AX attribute exceeds 2048 bytes; refusing ambiguous truncated identity")
    }
    return string
  }

  private func intern(_ element: AXUIElement, deadline: OperationDeadline) throws -> Int {
    try deadline.check()
    let hash = CFHash(element)
    if let existing = hashBuckets[hash]?.first(where: { CFEqual(elements[$0], element) }) {
      return existing
    }
    guard elements.count < 10000 else {
      throw Failure(code: "handle_limit", message: "Start a new bounded session")
    }
    let handle = elements.count + 1
    elements[handle] = element
    hashBuckets[hash, default: []].append(handle)
    AXUIElementSetMessagingTimeout(element, 0.15)
    return handle
  }

  private func array(
    _ element: AXUIElement, _ name: String, limit: Int, deadline: OperationDeadline
  ) throws -> ([Int], Bool) {
    try deadline.check()
    var count: CFIndex = 0
    let countError = AXUIElementGetAttributeValueCount(element, name as CFString, &count)
    if [.attributeUnsupported, .noValue].contains(countError) { return ([], false) }
    guard countError == .success, count >= 0 else {
      throw Failure(code: "ax_read", message: "\(name) count failed: \(countError.rawValue)")
    }
    if count == 0 { return ([], false) }
    var values: CFArray?
    try deadline.check()
    let error = AXUIElementCopyAttributeValues(
      element, name as CFString, 0, min(count, limit), &values)
    guard error == .success, let array = values as? [AXUIElement] else {
      throw Failure(code: "ax_read", message: "\(name) array failed: \(error.rawValue)")
    }
    return (try array.map { try intern($0, deadline: deadline) }, count > limit)
  }

  func windows(deadline: OperationDeadline) throws -> [Int] {
    try Self.discoverRoots(
      deadline: deadline,
      array: { try self.array(self.application, $0, limit: $1, deadline: deadline) },
      role: { handle in
        guard let element = self.elements[handle] else {
          throw Failure(code: "stale", message: "Unknown root reference")
        }
        return try self.text(element, kAXRoleAttribute, deadline: deadline)
      })
  }

  // The same discovery path runs with inert attribute readers in tests.
  static func discoverRoots(
    deadline: OperationDeadline,
    array: (String, Int) throws -> ([Int], Bool), role: (Int) throws -> String
  ) throws -> [Int] {
    try deadline.check()
    let (handles, incomplete) = try array(kAXWindowsAttribute, 32)
    try deadline.check()
    guard !incomplete else {
      throw Failure(
        code: "incomplete_inventory", message: "AXWindows exceeds 32; root inventory is incomplete")
    }
    let (appChildren, childrenIncomplete) = try array(kAXChildrenAttribute, 64)
    try deadline.check()
    guard !childrenIncomplete else {
      throw Failure(
        code: "incomplete_inventory",
        message: "Application AXChildren exceeds 64; menus may be omitted")
    }
    var roots = handles
    for child in appChildren {
      try deadline.check()
      let childRole = try role(child)
      try deadline.check()
      if childRole == "AXMenu", !roots.contains(child) { roots.append(child) }
    }
    return roots
  }

  func node(_ handle: Int, deadline: OperationDeadline) throws -> Node {
    try deadline.check()
    guard let element = elements[handle] else {
      throw Failure(code: "stale", message: "Unknown native reference")
    }
    var pid: pid_t = 0
    guard AXUIElementGetPid(element, &pid) == .success, pid == target.pid else {
      throw Failure(
        code: "stale", message: "Native reference no longer belongs to the selected PID")
    }
    let role = try text(element, kAXRoleAttribute, deadline: deadline)
    guard !role.isEmpty else {
      throw Failure(code: "stale", message: "Native element has no readable role")
    }
    var actions: CFArray?
    try deadline.check()
    let actionError = AXUIElementCopyActionNames(element, &actions)
    guard [.success, .actionUnsupported, .notImplemented].contains(actionError) else {
      throw Failure(
        code: "ax_read", message: "AX action enumeration failed: \(actionError.rawValue)")
    }
    let names = actions as? [String] ?? []
    guard names.count <= 32, names.allSatisfy({ $0.utf8.count <= 128 }) else {
      throw Failure(code: "action_limit", message: "AX action list exceeds bounds")
    }
    let (children, incomplete) = try array(
      element, kAXChildrenAttribute, limit: 250, deadline: deadline)
    let (enabledError, enabledValue) = try read(element, kAXEnabledAttribute, deadline: deadline)
    let enabled = enabledError == .success && (enabledValue as? Bool) == true
    return try Node(
      role: role, title: text(element, kAXTitleAttribute, deadline: deadline),
      label: text(element, kAXDescriptionAttribute, deadline: deadline),
      identifier: text(element, kAXIdentifierAttribute, deadline: deadline),
      value: text(element, kAXValueAttribute, deadline: deadline),
      actions: names, children: children, childrenIncomplete: incomplete, enabled: enabled)
  }

  func perform(_ handle: Int, action: String, deadline: OperationDeadline) throws {
    try deadline.check()
    guard let element = elements[handle] else {
      throw Failure(code: "stale", message: "Unknown native reference")
    }
    var pid: pid_t = 0
    guard trusted(), currentTarget() == target, AXUIElementGetPid(element, &pid) == .success,
      pid == target.pid
    else {
      throw Failure(
        code: "target_changed",
        message: "Target or permission changed immediately before native dispatch")
    }
    try deadline.check()
    let error = AXUIElementPerformAction(element, action as CFString)
    guard error == .success else {
      throw Failure(
        code: "ax_action", message: "AX action returned \(error.rawValue); effect is indeterminate",
        dispatched: true)
    }
  }

  /// Public AX has no universal CGWindowID getter. Candidate geometry is diagnostic only.
  func diagnose() throws -> [String: Any] {
    let deadline = OperationDeadline()
    settle()
    let before = foreground()
    let epoch = focusChanges
    let (windowsError, rawWindows) = try read(application, kAXWindowsAttribute, deadline: deadline)
    var candidateRows: [[String: Any]] = []
    let rawArray = rawWindows as? [AXUIElement] ?? []
    let cgWindows =
      (CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] ?? [])
      .filter { ($0[kCGWindowOwnerPID as String] as? Int) == Int(target.pid) }
    for window in rawArray.prefix(32) {
      try deadline.check()
      AXUIElementSetMessagingTimeout(window, 0.15)
      let (numberError, number) = try read(window, "AXWindowNumber", deadline: deadline)
      candidateRows.append([
        "role": try text(window, kAXRoleAttribute, deadline: deadline),
        "title": try text(window, kAXTitleAttribute, deadline: deadline),
        "windowNumberError": numberError.rawValue,
        "windowNumber": (number as? NSNumber) ?? NSNull(),
      ])
    }
    var exposure: [String: Any] = [:]
    for name in ["AXEnhancedUserInterface", "AXManualAccessibility"] {
      let (error, value) = try read(application, name, deadline: deadline)
      var settable = DarwinBoolean(false)
      try deadline.check()
      let setError = AXUIElementIsAttributeSettable(application, name as CFString, &settable)
      exposure[name] = [
        "error": error.rawValue, "value": (value as? NSNumber) ?? NSNull(),
        "settableError": setError.rawValue, "settable": settable.boolValue,
      ]
    }
    settle()
    try deadline.check()
    return [
      "trusted": trusted(), "target": target.json, "targetUnchanged": currentTarget() == target,
      "foregroundBefore": before?.json ?? [:], "foregroundAfter": foreground()?.json ?? [:],
      "focusChangesDuringOperation": focusChanges - epoch,
      "AXWindowsError": windowsError.rawValue, "AXWindowCount": rawArray.count,
      "windows": candidateRows, "exposure": exposure,
      "windowIDResolution":
        "AXWindowNumber is queried but never guessed from geometry; actions bind retained AXWindows references",
      "cgWindowIDs": cgWindows.prefix(32).compactMap { $0[kCGWindowNumber as String] as? Int },
    ]
  }
}
