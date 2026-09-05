import Foundation

struct ProcessIdentity: Equatable {
  let pid: Int32
  let generation: String
  let bundle: String

  var json: [String: Any] { ["pid": pid, "generation": generation, "bundle": bundle] }
}

struct Node {
  let role: String
  let title: String
  let label: String
  let identifier: String
  let value: String
  let actions: [String]
  let children: [Int]
  let childrenIncomplete: Bool
  let enabled: Bool

  var fingerprint: [String] { [role, title, label, identifier, value] }
}

struct Failure: Error {
  let code: String
  let message: String
  var dispatched = false
}

@MainActor
protocol DesktopDriver {
  var target: ProcessIdentity { get }
  var focusChanges: Int { get }
  func trusted() -> Bool
  func currentTarget() -> ProcessIdentity?
  func foreground() -> ProcessIdentity?
  func windows() throws -> [Int]
  func node(_ handle: Int) throws -> Node
  func perform(_ handle: Int, action: String) throws
  func settle()
}

struct Request: Decodable {
  var op: String
  var window: String? = nil
  var snapshot: String? = nil
  var element: String? = nil
  var action: String? = nil
  var maxNodes: Int? = nil
  var maxDepth: Int? = nil
  var roles: [String]? = nil
}

/// One caller-owned stdio session. Native references never cross a process lifetime.
@MainActor
final class Session {
  static let maximumOutputBytes = 512 * 1024
  private let driver: any DesktopDriver
  private let allowMenuActions: Bool
  private let now: () -> TimeInterval
  private var windowHandles: [String: Int] = [:]
  private var snapshotID: String?
  private var snapshotTime: TimeInterval = 0
  private var snapshotWindow: Int?
  private var entries: [String: [(Int, Node)]] = [:]
  private var focusViolated = false
  private var initialForeground: ProcessIdentity?
  private var initialFocusEpoch: Int?

  init(
    driver: any DesktopDriver, allowMenuActions: Bool = false,
    now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }
  ) {
    self.driver = driver
    self.allowMenuActions = allowMenuActions
    self.now = now
  }

  func respond(_ request: Request) -> Data {
    let foregroundBefore = driver.foreground()
    var response: [String: Any]
    do {
      response = try handle(request)
      response["success"] = true
    } catch let failure as Failure {
      response = [
        "success": false, "code": failure.code, "message": failure.message,
        "actionDispatched": failure.dispatched, "retrySafe": !failure.dispatched,
      ]
    } catch {
      response = [
        "success": false, "code": "internal", "message": String(describing: error),
        "retrySafe": false,
      ]
    }
    response["foregroundBefore"] = foregroundBefore?.json ?? [:]
    response["foregroundAfter"] = driver.foreground()?.json ?? [:]
    let data =
      (try? JSONSerialization.data(withJSONObject: response, options: [.sortedKeys])) ?? Data()
    guard data.count <= Self.maximumOutputBytes else {
      invalidate()
      return Data(#"{"success":false,"code":"output_limit","retrySafe":false}"#.utf8)
    }
    return data
  }

  func handle(_ request: Request) throws -> [String: Any] {
    driver.settle()
    let before = try preflight()
    let focusEpoch = driver.focusChanges
    var dispatched = false
    do {
      var result: [String: Any]
      switch request.op {
      case "windows":
        invalidate()
        windowHandles.removeAll()
        let windows = try currentRoots()
        result = [
          "windows": try windows.map { handle -> [String: Any] in
            let id = UUID().uuidString
            windowHandles[id] = handle
            let node = try driver.node(handle)
            return ["id": id, "role": node.role, "title": node.title]
          }
        ]
      case "observe":
        result = try observe(request)
      case "menu":
        guard allowMenuActions else {
          throw Failure(
            code: "actions_disabled", message: "Start with --allow-menu-actions after authorization"
          )
        }
        let chain = try validate(request)
        guard let (handle, node) = chain.last else {
          throw Failure(code: "stale", message: "Empty handle ancestry")
        }
        let action = request.action ?? ""
        let allowed =
          (action == "AXShowMenu" && ["AXRow", "AXPopUpButton"].contains(node.role))
          || (action == "AXPress" && node.role == "AXPopUpButton")
          || (action == "AXCancel" && node.role == "AXMenu")
        guard allowed, node.enabled || action == "AXCancel", node.actions.contains(action) else {
          throw Failure(
            code: "unsupported_action",
            message: "Only advertised row/popup menu actions or menu cancellation are supported")
        }
        guard try preflight() == before, driver.focusChanges == focusEpoch else {
          throw Failure(code: "focus_changed", message: "Foreground changed before dispatch")
        }
        invalidate()
        do {
          try driver.perform(handle, action: action)
          dispatched = true
        } catch let failure as Failure {
          dispatched = failure.dispatched
          throw failure
        } catch {
          dispatched = true
          throw error
        }
        result = [
          "actionDispatched": true, "action": action, "effect": "unverified",
          "retrySafe": false,
          "next": "Observe again; dispatch does not prove a menu opened or closed",
        ]
      default:
        throw Failure(code: "invalid_request", message: "Expected windows, observe, or menu")
      }
      driver.settle()
      guard driver.currentTarget() == driver.target else {
        throw Failure(
          code: "target_changed", message: "Target process changed during operation",
          dispatched: dispatched)
      }
      let after = driver.foreground()
      guard after == before, driver.focusChanges == focusEpoch else {
        focusViolated = true
        invalidate()
        throw Failure(
          code: "focus_changed", message: "Foreground changed; session refuses further operations",
          dispatched: dispatched)
      }
      result["target"] = driver.target.json
      result["foregroundBefore"] = before.json
      result["foregroundAfter"] = after?.json
      result["focusChangesDuringOperation"] = driver.focusChanges - focusEpoch
      return result
    } catch let failure as Failure {
      driver.settle()
      if driver.foreground() != before || driver.focusChanges != focusEpoch {
        focusViolated = true
        invalidate()
        throw Failure(
          code: "focus_changed",
          message: "Foreground changed during a failed operation; inspect before continuing",
          dispatched: dispatched || failure.dispatched)
      }
      if dispatched { invalidate() }
      throw Failure(
        code: failure.code, message: failure.message, dispatched: dispatched || failure.dispatched)
    } catch {
      driver.settle()
      if driver.foreground() != before || driver.focusChanges != focusEpoch {
        focusViolated = true
        invalidate()
        throw Failure(
          code: "focus_changed",
          message: "Foreground changed during a failed operation; inspect before continuing",
          dispatched: dispatched)
      }
      if dispatched { invalidate() }
      throw Failure(
        code: "native_error", message: String(describing: error), dispatched: dispatched)
    }
  }

  private func preflight() throws -> ProcessIdentity {
    guard !focusViolated else {
      throw Failure(
        code: "focus_changed", message: "Start a new session after inspecting the desktop")
    }
    guard driver.trusted() else {
      throw Failure(
        code: "permission_denied",
        message: "Accessibility is not granted to this execution host; no prompt was requested")
    }
    guard driver.currentTarget() == driver.target else {
      throw Failure(code: "target_changed", message: "PID, process generation, or bundle changed")
    }
    guard let foreground = driver.foreground(), foreground != driver.target else {
      throw Failure(
        code: "not_background",
        message: "A distinct foreground app is required for background proof")
    }
    if initialForeground == nil {
      initialForeground = foreground
      initialFocusEpoch = driver.focusChanges
    }
    guard initialForeground == foreground, initialFocusEpoch == driver.focusChanges else {
      focusViolated = true
      invalidate()
      throw Failure(
        code: "focus_changed",
        message: "The session's initial foreground app or activation history changed")
    }
    return foreground
  }

  private func currentRoots() throws -> [Int] {
    let roots = try driver.windows()
    guard roots.count <= 32 else {
      throw Failure(code: "window_limit", message: "Too many AX roots")
    }
    for root in roots {
      let role = try driver.node(root).role
      guard ["AXWindow", "AXMenu"].contains(role) else {
        invalidate()
        throw Failure(
          code: "invalid_root",
          message: "AX inventory returned \(role), not a native window or menu")
      }
    }
    return roots
  }

  private func observe(_ request: Request) throws -> [String: Any] {
    let maxNodes = request.maxNodes ?? 400
    let maxDepth = request.maxDepth ?? 48
    guard (1...2000).contains(maxNodes), (1...64).contains(maxDepth),
      (request.roles?.count ?? 0) <= 16
    else {
      throw Failure(
        code: "invalid_bounds",
        message: "maxNodes must be 1...2000; maxDepth 1...64; at most 16 roles")
    }
    guard let window = request.window.flatMap({ windowHandles[$0] }),
      try currentRoots().contains(window)
    else {
      throw Failure(
        code: "stale_window", message: "Choose a current native window handle from windows")
    }
    invalidate()
    snapshotWindow = window
    snapshotID = UUID().uuidString
    snapshotTime = now()
    var output: [[String: Any]] = []
    var pending: [(Int, [(Int, Node)], Int)] = [(window, [], 0)]
    var cursor = 0
    var queued: Set<Int> = [window]
    var incomplete = false
    var visited = 0
    // Breadth first keeps a newly exposed menu from sitting behind an entire song table.
    while cursor < pending.count {
      let (handle, ancestry, depth) = pending[cursor]
      cursor += 1
      guard visited < maxNodes, now() - snapshotTime < 5 else {
        incomplete = true
        break
      }
      guard depth < maxDepth else {
        incomplete = true
        continue
      }
      let node = try driver.node(handle)
      visited += 1
      let chain = ancestry + [(handle, node)]
      let id = "e\(visited)"
      entries[id] = chain
      incomplete = incomplete || node.childrenIncomplete
      if request.roles == nil || request.roles!.contains(node.role) {
        output.append([
          "id": id, "role": node.role, "title": node.title, "label": node.label,
          "identifier": node.identifier, "value": node.value, "actions": node.actions,
          "enabled": node.enabled, "depth": depth,
        ])
      }
      for child in node.children where !queued.contains(child) {
        guard pending.count < maxNodes else {
          incomplete = true
          break
        }
        queued.insert(child)
        pending.append((child, chain, depth + 1))
      }
    }
    return [
      "snapshot": snapshotID!, "window": request.window!, "nodes": output,
      "visited": visited, "incomplete": incomplete, "expiresAfterSeconds": 30,
      "authority": "retained_native_AX_window_and_elements", "menuActionsEnabled": allowMenuActions,
    ]
  }

  private func validate(_ request: Request) throws -> [(Int, Node)] {
    guard let requested = request.snapshot, requested == snapshotID,
      now() - snapshotTime < 30, let element = request.element,
      let chain = entries[element], let window = snapshotWindow,
      try currentRoots().contains(window), chain.first?.0 == window
    else {
      throw Failure(
        code: "stale",
        message: "Snapshot/element/window is expired or belongs to another session; observe again")
    }
    if let requestedWindow = request.window, windowHandles[requestedWindow] != window {
      throw Failure(
        code: "stale_window", message: "Requested window contradicts the snapshot's native window")
    }
    var refreshed: [(Int, Node)] = []
    let started = now()
    for (index, entry) in chain.enumerated() {
      guard now() - started < 5 else {
        throw Failure(
          code: "validation_timeout", message: "Native ancestry validation exceeded its budget")
      }
      let live = try driver.node(entry.0)
      guard live.fingerprint == entry.1.fingerprint,
        index == 0 || refreshed[index - 1].1.children.contains(entry.0)
      else {
        throw Failure(
          code: "stale",
          message: "Element identity or native ancestry changed; no action dispatched")
      }
      refreshed.append((entry.0, live))
    }
    guard now() - snapshotTime < 30 else {
      throw Failure(code: "stale", message: "Snapshot expired during ancestry validation")
    }
    return refreshed
  }

  private func invalidate() {
    snapshotID = nil
    snapshotWindow = nil
    entries.removeAll()
  }
}
