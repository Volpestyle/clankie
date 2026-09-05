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
  var onNode: (() -> Void)?
  var nodes: [Int: Node] = [
    1: makeNode("AXWindow", children: [2, 4]),
    2: makeNode("AXRow", label: "Song A", children: [3]),
    3: makeNode(
      "AXPopUpButton", label: "More options for Song A", actions: ["AXPress", "AXShowMenu"]),
    4: makeNode("AXMenu", actions: ["AXCancel"]),
  ]
  init() { liveTarget = target }
  func trusted() -> Bool { permission }
  func currentTarget() -> ProcessIdentity? { liveTarget }
  func foreground() -> ProcessIdentity? { front }
  func windows() throws -> [Int] { windowList }
  func node(_ handle: Int) throws -> Node {
    onNode?()
    guard let node = nodes[handle] else { throw Failure(code: "stale", message: "Destroyed") }
    return node
  }
  func perform(_ handle: Int, action: String) throws {
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

  @Test func boundsWideAndCyclicNativeGraphs() throws {
    let driver = FixtureDesktop()
    driver.nodes[1] = makeNode("AXWindow", children: [1] + Array(2...501))
    for handle in 2...16 { driver.nodes[handle] = makeNode("AXGroup", children: [1]) }
    let result = try observe(Session(driver: driver), maxNodes: 16)
    #expect(result["visited"] as? Int == 16)
    #expect(result["incomplete"] as? Bool == true)
  }
}
