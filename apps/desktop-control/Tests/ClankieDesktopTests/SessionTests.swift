import Foundation
import Testing

@testable import ClankieDesktop

@MainActor
final class FixtureDesktop: DesktopDriver {
  let target = ProcessIdentity(pid: 71, generation: "1000001", bundle: "com.spotify.client")
  var liveTarget: ProcessIdentity?
  var front = ProcessIdentity(pid: 72, generation: "1000002", bundle: "synthetic.editor")
  var permission = true
  var focusChanges = 0
  var windowList = [1]
  var calls: [(Int, String)] = []
  var onPerform: (() throws -> Void)?
  var onBeforePerform: (() -> Void)?
  var onNode: (() -> Void)?
  var onWindows: (() -> Void)?
  var onTrust: (() -> Void)?
  var nodes: [Int: Node] = [
    1: makeNode("AXWindow", children: [2, 4]),
    2: makeNode("AXRow", label: "Song A", children: [3]),
    3: makeNode(
      "AXPopUpButton", label: "More options for Song A", actions: ["AXPress", "AXShowMenu"]),
    4: makeNode("AXMenu", actions: ["AXCancel"]),
  ]
  init() { liveTarget = target }
  func trusted() -> Bool {
    onTrust?()
    return permission
  }
  func currentTarget() -> ProcessIdentity? { liveTarget }
  func foreground() -> ProcessIdentity? { front }
  func windows(deadline: OperationDeadline) throws -> [Int] {
    onWindows?()
    return windowList
  }
  func node(_ handle: Int, deadline: OperationDeadline) throws -> Node {
    onNode?()
    guard let node = nodes[handle] else { throw Failure(code: "stale", message: "Destroyed") }
    return node
  }
  func perform(_ handle: Int, action: String, deadline: OperationDeadline) throws {
    onBeforePerform?()
    try deadline.check()
    calls.append((handle, action))
    try onPerform?()
  }
  func settle() {}
}

func makeNode(_ role: String, label: String = "", actions: [String] = [], children: [Int] = [])
  -> Node
{
  Node(
    role: role, title: "", label: label, identifier: "", value: "", actions: actions,
    children: children, childrenIncomplete: false, enabled: true)
}

@Suite(.serialized)
@MainActor
struct SessionTests {
  private func observe(_ session: Session, maxNodes: Int? = nil) throws -> [String: Any] {
    let inventory = try session.handle(Request(op: "windows"))
    let windows = try #require(inventory["windows"] as? [[String: Any]])
    return try session.handle(
      Request(op: "observe", window: windows[0]["id"] as? String, maxNodes: maxNodes))
  }

  private func menuRequest(
    _ observation: [String: Any], role: String = "AXPopUpButton", action: String = "AXShowMenu"
  ) throws -> Request {
    let nodes = try #require(observation["nodes"] as? [[String: Any]])
    let node = try #require(nodes.first { $0["role"] as? String == role })
    return Request(
      op: "menu", snapshot: observation["snapshot"] as? String, element: node["id"] as? String,
      action: action)
  }

  private func refusal(_ data: Data) throws -> String {
    let json = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    #expect(json["success"] as? Bool == false)
    return try #require(json["code"] as? String)
  }

  @Test func retainsExactReferencesAndInvalidatesAfterOneDispatch() throws {
    let driver = FixtureDesktop()
    let session = Session(driver: driver, allowMenuActions: true)
    let observation = try observe(session)
    let request = try menuRequest(observation)
    let result = try session.handle(request)
    #expect(driver.calls.count == 1)
    #expect(driver.calls.first?.0 == 3)
    #expect(driver.calls.first?.1 == "AXShowMenu")
    #expect(result["effect"] as? String == "unverified")
    #expect(try refusal(session.respond(request)) == "stale")
    #expect(driver.calls.count == 1)
  }

  @Test func noActionsWithoutExplicitStartupOptIn() throws {
    let driver = FixtureDesktop()
    let session = Session(driver: driver)
    #expect(try refusal(session.respond(menuRequest(observe(session)))) == "actions_disabled")
    #expect(driver.calls.isEmpty)
  }

  @Test(arguments: [
    "pid", "generation", "bundle", "permission", "foreground", "window", "ancestry", "semantic",
    "destroyed", "expired", "snapshot",
  ])
  func rejectsStaleOrUnsafeTargets(reason: String) throws {
    let driver = FixtureDesktop()
    var clock = 100.0
    let session = Session(driver: driver, allowMenuActions: true, now: { clock })
    var request = try menuRequest(observe(session))
    switch reason {
    case "pid":
      driver.liveTarget = ProcessIdentity(
        pid: 99, generation: driver.target.generation, bundle: driver.target.bundle)
    case "generation":
      driver.liveTarget = ProcessIdentity(
        pid: 71, generation: "replacement", bundle: driver.target.bundle)
    case "bundle":
      driver.liveTarget = ProcessIdentity(
        pid: 71, generation: driver.target.generation, bundle: "unrelated")
    case "permission": driver.permission = false
    case "foreground": driver.front = driver.target
    case "window": driver.windowList = [99]
    case "ancestry": driver.nodes[2] = makeNode("AXRow", label: "Song A", children: [])
    case "semantic": driver.nodes[2] = makeNode("AXRow", label: "Song B", children: [3])
    case "destroyed": driver.nodes.removeValue(forKey: 3)
    case "expired": clock = 131
    case "snapshot": request.snapshot = "other-session"
    default: Issue.record("Unknown fixture")
    }
    _ = try refusal(session.respond(request))
    #expect(driver.calls.isEmpty)
  }

  @Test(arguments: ["AXRaise", "AXSetValue", "AXConfirm", "AXCancel", "AXScrollToVisible"])
  func cannotSmuggleOtherActions(action: String) throws {
    let driver = FixtureDesktop()
    let session = Session(driver: driver, allowMenuActions: true)
    #expect(
      try refusal(session.respond(menuRequest(observe(session), action: action)))
        == "unsupported_action")
    #expect(driver.calls.isEmpty)
  }

  @Test func refusesUnavailableCancelAndAllowsAdvertisedCancelOnMenu() throws {
    let driver = FixtureDesktop()
    let session = Session(driver: driver, allowMenuActions: true)
    let request = try menuRequest(observe(session), role: "AXMenu", action: "AXCancel")
    _ = try session.handle(request)
    #expect(driver.calls.first?.0 == 4)
    driver.nodes[4] = makeNode("AXMenu")
    #expect(
      try refusal(
        session.respond(menuRequest(observe(session), role: "AXMenu", action: "AXCancel")))
        == "unsupported_action")
    #expect(driver.calls.count == 1)
  }

  @Test func detectsTransientActivationAndStopsTheSession() throws {
    let driver = FixtureDesktop()
    let session = Session(driver: driver, allowMenuActions: true)
    let request = try menuRequest(observe(session))
    driver.onPerform = { driver.focusChanges += 2 }
    #expect(try refusal(session.respond(request)) == "focus_changed")
    #expect(try refusal(session.respond(Request(op: "windows"))) == "focus_changed")
    #expect(driver.calls.count == 1)
  }

  @Test func boundsTraversalAndOutputAndDoesNotInventCompleteness() throws {
    let driver = FixtureDesktop()
    let session = Session(driver: driver)
    let truncated = try observe(session, maxNodes: 2)
    #expect(truncated["visited"] as? Int == 2)
    #expect(truncated["incomplete"] as? Bool == true)
    #expect(
      try refusal(session.respond(Request(op: "observe", maxNodes: 2001))) == "invalid_bounds")
    let inventory = try session.handle(Request(op: "windows"))
    let window = try #require((inventory["windows"] as? [[String: Any]])?.first?["id"] as? String)
    driver.nodes[2] = makeNode(
      "AXRow", label: String(repeating: "x", count: Session.maximumOutputBytes))
    #expect(try refusal(session.respond(Request(op: "observe", window: window))) == "output_limit")
  }

  @Test func nativeErrorsAreIndeterminateAndNeverRetried() throws {
    let driver = FixtureDesktop()
    let session = Session(driver: driver, allowMenuActions: true)
    let request = try menuRequest(observe(session))
    driver.onPerform = {
      throw Failure(code: "ax_action", message: "Cannot complete", dispatched: true)
    }
    let json = try #require(
      JSONSerialization.jsonObject(with: session.respond(request)) as? [String: Any])
    #expect(json["actionDispatched"] as? Bool == true)
    #expect(json["retrySafe"] as? Bool == false)
    #expect(try refusal(session.respond(request)) == "stale")
    #expect(driver.calls.count == 1)
  }

  @Test func failedActionStillLatchesFocusViolation() throws {
    let driver = FixtureDesktop()
    let session = Session(driver: driver, allowMenuActions: true)
    let request = try menuRequest(observe(session))
    driver.onPerform = {
      driver.focusChanges += 2
      throw Failure(code: "ax_action", message: "Cannot complete", dispatched: true)
    }
    #expect(try refusal(session.respond(request)) == "focus_changed")
    #expect(try refusal(session.respond(Request(op: "windows"))) == "focus_changed")
  }

  @Test func preservesSessionForegroundAcrossRequests() throws {
    let driver = FixtureDesktop()
    let session = Session(driver: driver, allowMenuActions: true)
    let request = try menuRequest(observe(session))
    driver.focusChanges += 2
    #expect(try refusal(session.respond(request)) == "focus_changed")
    #expect(driver.calls.isEmpty)
  }

  @Test func snapshotCannotExpireDuringValidationOrContradictWindow() throws {
    let driver = FixtureDesktop()
    var clock = 100.0
    let session = Session(driver: driver, allowMenuActions: true, now: { clock })
    var request = try menuRequest(observe(session))
    request.window = "another-root"
    #expect(try refusal(session.respond(request)) == "stale_window")
    request.window = nil
    clock = 129
    driver.onNode = { clock += 0.6 }
    #expect(try refusal(session.respond(request)) == "stale")
    #expect(driver.calls.isEmpty)
  }

  @Test func refusesApplicationInWindowInventoryAtEveryBoundary() throws {
    let driver = FixtureDesktop()
    let session = Session(driver: driver, allowMenuActions: true)
    let observation = try observe(session)
    let request = try menuRequest(observation)
    driver.nodes[1] = makeNode("AXApplication", children: [2, 4])
    #expect(try refusal(session.respond(request)) == "invalid_root")
    #expect(try refusal(session.respond(Request(op: "windows"))) == "invalid_root")
    #expect(driver.calls.isEmpty)
    driver.nodes[1] = makeNode("AXWindow", children: [2, 4])
    let inventory = try session.handle(Request(op: "windows"))
    let window = try #require((inventory["windows"] as? [[String: Any]])?.first?["id"] as? String)
    driver.nodes[1] = makeNode("AXApplication", children: [2, 4])
    #expect(try refusal(session.respond(Request(op: "observe", window: window))) == "invalid_root")
  }

  @Test func openingWithoutCancellationCanLeaveAMenu() throws {
    let driver = FixtureDesktop()
    driver.nodes[1] = makeNode("AXWindow", children: [2])
    driver.nodes.removeValue(forKey: 4)
    let session = Session(driver: driver, allowMenuActions: true)
    let open = try menuRequest(observe(session))
    driver.onPerform = {
      driver.nodes[1] = makeNode("AXWindow", children: [2, 4])
      driver.nodes[4] = makeNode("AXMenu")
    }
    let opened = try session.handle(open)
    #expect(opened["effect"] as? String == "unverified")
    let cancel = try menuRequest(observe(session), role: "AXMenu", action: "AXCancel")
    #expect(try refusal(session.respond(cancel)) == "unsupported_action")
    #expect(driver.calls.count == 1)
    #expect(driver.nodes[4] != nil)
  }

  @Test func activationAfterOpenRefusesObservationAndCleanup() throws {
    let driver = FixtureDesktop()
    driver.nodes[1] = makeNode("AXWindow", children: [2])
    driver.nodes.removeValue(forKey: 4)
    let session = Session(driver: driver, allowMenuActions: true)
    let observation = try observe(session)
    let open = try menuRequest(observation)
    driver.onPerform = {
      driver.nodes[1] = makeNode("AXWindow", children: [2, 4])
      driver.nodes[4] = makeNode("AXMenu", actions: ["AXCancel"])
      driver.focusChanges += 2
    }
    let opened = try #require(
      JSONSerialization.jsonObject(with: session.respond(open)) as? [String: Any])
    #expect(opened["code"] as? String == "focus_changed")
    #expect(opened["actionDispatched"] as? Bool == true)
    for request in [
      Request(op: "windows"),
      Request(op: "observe", window: observation["window"] as? String),
      Request(op: "menu", action: "AXCancel"),
    ] {
      #expect(try refusal(session.respond(request)) == "focus_changed")
    }
    #expect(driver.calls.count == 1)
    #expect(driver.nodes[4] != nil)
  }

  @Test func finalValidationReadCannotExceedDeadlineAndDispatch() throws {
    let driver = FixtureDesktop()
    var clock = 100.0
    let session = Session(driver: driver, allowMenuActions: true, now: { clock })
    let open = try menuRequest(observe(session))
    var reads = 0
    driver.onNode = {
      reads += 1
      if reads == 2 { clock += 2 }
      if reads == 3 { clock += 2.99 }
      if reads == 4 { clock += 0.15 }
    }
    #expect(try refusal(session.respond(open)) == "operation_timeout")
    #expect(clock > 105)
    #expect(driver.calls.isEmpty)
    driver.onNode = nil
    #expect(try refusal(session.respond(open)) == "stale")
  }

  @Test(arguments: ["final_preflight", "native_dispatch"])
  func snapshotExpiryLimitsImmediateDispatch(boundary: String) throws {
    let driver = FixtureDesktop()
    var clock = 100.0
    let session = Session(driver: driver, allowMenuActions: true, now: { clock })
    let open = try menuRequest(observe(session))
    clock = 129.5
    var preflights = 0
    if boundary == "final_preflight" {
      driver.onTrust = {
        preflights += 1
        if preflights == 2 { clock += 1 }
      }
    } else {
      driver.onBeforePerform = { clock += 1 }
    }
    let result = try #require(
      JSONSerialization.jsonObject(with: session.respond(open)) as? [String: Any])
    #expect(result["code"] as? String == "stale")
    #expect(result["actionDispatched"] as? Bool == false)
    #expect(clock == 130.5)
    #expect(driver.calls.isEmpty)
    // Rewind only the virtual test clock to distinguish invalidation from an age check.
    clock = 129.5
    driver.onTrust = nil
    driver.onBeforePerform = nil
    #expect(try refusal(session.respond(open)) == "stale")
    #expect(driver.calls.isEmpty)
  }

  @Test func earlierOperationExpiryStillIncludesDiscoveryAndValidation() throws {
    let driver = FixtureDesktop()
    var clock = 100.0
    let session = Session(driver: driver, allowMenuActions: true, now: { clock })
    let open = try menuRequest(observe(session))
    driver.onWindows = { clock += 2.5 }
    driver.onNode = { clock += 0.7 }
    let result = try #require(
      JSONSerialization.jsonObject(with: session.respond(open)) as? [String: Any])
    #expect(result["code"] as? String == "operation_timeout")
    #expect(result["actionDispatched"] as? Bool == false)
    #expect(driver.calls.isEmpty)
  }

  @Test func deadlineAfterDispatchRetainsUncertainty() throws {
    let driver = FixtureDesktop()
    var clock = 100.0
    let session = Session(driver: driver, allowMenuActions: true, now: { clock })
    let open = try menuRequest(observe(session))
    driver.onPerform = { clock += 5.1 }
    let result = try #require(
      JSONSerialization.jsonObject(with: session.respond(open)) as? [String: Any])
    #expect(result["code"] as? String == "operation_timeout")
    #expect(result["actionDispatched"] as? Bool == true)
    #expect(result["retrySafe"] as? Bool == false)
    #expect(driver.calls.count == 1)
    #expect(try refusal(session.respond(open)) == "stale")
  }

  @Test func inventorySharesOneDeadlineAndReadsEachRootOnce() throws {
    let driver = FixtureDesktop()
    driver.windowList = Array(1...32)
    for handle in driver.windowList { driver.nodes[handle] = makeNode("AXWindow") }
    var clock = 100.0
    var reads = 0
    driver.onNode = {
      clock += 0.3
      reads += 1
    }
    let session = Session(driver: driver, now: { clock })
    #expect(try refusal(session.respond(Request(op: "windows"))) == "operation_timeout")
    #expect(clock < 105.31)
    reads = 0
    driver.onNode = { reads += 1 }
    _ = try session.handle(Request(op: "windows"))
    #expect(reads == 32)
  }

  @Test(arguments: ["windows", "observe", "menu"])
  func rootDiscoveryConsumesEveryOperationDeadline(op: String) throws {
    let driver = FixtureDesktop()
    var clock = 100.0
    let session = Session(driver: driver, allowMenuActions: true, now: { clock })
    let observation = try observe(session)
    let request =
      op == "menu"
      ? try menuRequest(observation)
      : Request(op: op, window: observation["window"] as? String)
    driver.onWindows = { clock += 5.1 }
    #expect(try refusal(session.respond(request)) == "operation_timeout")
    #expect(driver.calls.isEmpty)
  }

  @Test func deadlineIsCheckedAfterFinalPreflight() throws {
    let driver = FixtureDesktop()
    var clock = 100.0
    let session = Session(driver: driver, allowMenuActions: true, now: { clock })
    let open = try menuRequest(observe(session))
    var checks = 0
    driver.onTrust = {
      checks += 1
      if checks == 2 { clock += 5.1 }
    }
    #expect(try refusal(session.respond(open)) == "operation_timeout")
    #expect(driver.calls.isEmpty)
  }

  @Test(arguments: [true, false])
  func nativeDiscoveryRefusesIncompleteRoots(windowsTruncated: Bool) throws {
    do {
      _ = try NativeDesktop.discoverRoots(
        deadline: OperationDeadline(now: { 100 }),
        array: { name, limit in
          let all =
            name == "AXWindows" ? Array(100...(windowsTruncated ? 132 : 100)) : Array(1...65)
          return (Array(all.prefix(limit)), all.count > limit)
        }, role: { $0 == 65 ? "AXMenu" : "AXGroup" })
      Issue.record("Incomplete inventory must not silently omit the menu at child 65")
    } catch let failure as Failure {
      #expect(failure.code == "incomplete_inventory")
    }
  }

  @Test func nativeDiscoveryChecksDeadlineBetweenApplicationChildren() throws {
    var clock = 100.0
    let deadline = OperationDeadline(now: { clock })
    do {
      _ = try NativeDesktop.discoverRoots(
        deadline: deadline,
        array: { name, _ in (name == "AXWindows" ? [100] : Array(1...64), false) },
        role: { _ in
          clock += 0.3
          return "AXGroup"
        })
      Issue.record("Root discovery must share the operation deadline")
    } catch let failure as Failure {
      #expect(failure.code == "operation_timeout")
      #expect(clock < 105.31)
    }
    let roots = try NativeDesktop.discoverRoots(
      deadline: OperationDeadline(now: { 100 }),
      array: { name, _ in (name == "AXWindows" ? [100] : [100, 101, 102], false) },
      role: { $0 == 102 ? "AXGroup" : "AXMenu" })
    #expect(roots == [100, 101])
  }

  @Test func boundsWideAndCyclicNativeGraphs() throws {
    let driver = FixtureDesktop()
    driver.nodes[1] = makeNode("AXWindow", children: [1] + Array(2...501))
    for handle in 2...16 { driver.nodes[handle] = makeNode("AXGroup", children: [1]) }
    let result = try observe(Session(driver: driver), maxNodes: 16)
    #expect(result["visited"] as? Int == 16)
    #expect(result["incomplete"] as? Bool == true)
  }
}
