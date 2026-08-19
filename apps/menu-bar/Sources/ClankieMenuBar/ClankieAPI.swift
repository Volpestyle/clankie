import Foundation
import Security

struct ContextUsage: Decodable, Sendable {
  let tokens: Int?
  let contextWindow: Int

  var percentage: Int? {
    guard let tokens else { return nil }
    return Int((Double(tokens) / Double(contextWindow) * 100).rounded())
  }
}

struct OperatorConversation: Decodable, Identifiable, Sendable {
  let conversationId: String
  let title: String
  let updatedAt: String
  let sessionState: String
  let isDefault: Bool
  let contextUsage: ContextUsage?

  var id: String { conversationId }
}

struct ConversationEvent: Decodable, Identifiable, Sendable {
  let cursor: String
  let occurredAt: String
  let type: String
  let role: String?
  let text: String?
  let streaming: Bool?
  let phase: String?
  let name: String?
  let summary: String?

  var id: String { cursor }
}

struct VoiceRoom: Decodable, Identifiable, Sendable {
  let guildId: String
  let guildName: String?
  let channelId: String?
  let channelName: String?

  var id: String { "\(guildId):\(channelId ?? "unknown")" }
}

struct PresenceSession: Decodable, Sendable {
  let voiceRooms: [VoiceRoom]?
}

struct VoiceTranscriptEntry: Decodable, Identifiable, Sendable {
  let body: String
  let occurredAt: String
  let guildId: String
  let channelId: String
  let deliveryId: String
  let speakerId: String
  let displayName: String?
  let text: String

  var id: String { "\(body):\(deliveryId)" }
  var roomId: String { "\(guildId):\(channelId)" }
}

struct VoiceTranscriptPage: Decodable, Sendable {
  let enabled: Bool
  let entries: [VoiceTranscriptEntry]
  let nextCursor: String
  let hasMore: Bool
}

private struct ConversationListResponse: Decodable { let conversations: [OperatorConversation] }
private struct ConversationTailResponse: Decodable { let result: ConversationTailResult }
struct ConversationTailResult: Decodable {
  let status: String
  let events: [ConversationEvent]?
  let nextCursor: String?
  let hasMore: Bool?
}

private struct ListRequest: Encodable {
  let op = "list"
  let schemaVersion = 1
}

private struct CloseRequest: Encodable {
  let op = "close"
  let schemaVersion = 1
  let conversationId: String
}

private struct CloseResponse: Decodable { let closed: Bool }

private struct ReplayRequest: Encodable {
  struct Page: Encodable {
    let schemaVersion = 1
    let conversationId: String
    let surfaceClientId = "clankie-menu-bar"
    let cursor: String?
    let limit = 200
  }

  let op = "tail"
  let schemaVersion = 1
  let tail: Page
}

enum ClankieAPIError: LocalizedError {
  case invalidBaseURL
  case missingCredential
  case invalidResponse
  case server(Int, String)

  var errorDescription: String? {
    switch self {
    case .invalidBaseURL: "CLANKIE_BASE_URL is invalid."
    case .missingCredential: "The clankie_captain credential is missing from Keychain."
    case .invalidResponse: "Clankie returned an invalid response."
    case .server(let status, let body): "Clankie API \(status): \(body)"
    }
  }
}

actor ClankieAPI {
  private let baseURL: URL
  private let session: URLSession
  private var token: String?

  init() {
    let raw = ProcessInfo.processInfo.environment["CLANKIE_BASE_URL"] ?? "http://127.0.0.1:4310"
    guard let url = URL(string: raw), url.host != nil else {
      preconditionFailure("CLANKIE_BASE_URL is invalid")
    }
    baseURL = url
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 15
    configuration.timeoutIntervalForResource = 30
    configuration.waitsForConnectivity = true
    session = URLSession(configuration: configuration)
  }

  func listConversations() async throws -> [OperatorConversation] {
    let response: ConversationListResponse = try await post(
      "/operator/v1/dispatch", body: ListRequest())
    return response.conversations
  }

  func tailConversation(_ id: String, cursor: String?) async throws -> ConversationTailResult {
    let body = ReplayRequest(tail: .init(conversationId: id, cursor: cursor))
    let response: ConversationTailResponse = try await post("/operator/v1/dispatch", body: body)
    return response.result
  }

  func closeConversation(_ id: String) async throws -> Bool {
    let response: CloseResponse = try await post(
      "/operator/v1/dispatch", body: CloseRequest(conversationId: id))
    return response.closed
  }

  func listPresenceSessions() async throws -> [PresenceSession] {
    try await get("/v1/discord/presence-sessions")
  }

  func readVoiceTranscripts(cursor: String?) async throws -> VoiceTranscriptPage {
    var components = URLComponents()
    components.path = "/v1/discord/voice-transcripts"
    components.queryItems = cursor.map { [URLQueryItem(name: "cursor", value: $0)] }
    return try await get(components.string ?? "/v1/discord/voice-transcripts")
  }

  func voiceWebSocketRequest() throws -> URLRequest {
    var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
    components?.scheme = baseURL.scheme == "https" ? "wss" : "ws"
    components?.path = "/operator/v1/voice-chat"
    guard let url = components?.url else { throw ClankieAPIError.invalidBaseURL }
    var request = URLRequest(url: url)
    request.setValue("Bearer \(try captainToken())", forHTTPHeaderField: "Authorization")
    return request
  }

  func webSocketSession() -> URLSession { session }

  private func get<Response: Decodable>(_ path: String) async throws -> Response {
    try await request(path: path, method: "GET", body: Optional<Data>.none)
  }

  private func post<Response: Decodable, Body: Encodable>(_ path: String, body: Body) async throws
    -> Response
  {
    try await request(path: path, method: "POST", body: JSONEncoder().encode(body))
  }

  private func request<Response: Decodable>(path: String, method: String, body: Data?) async throws
    -> Response
  {
    guard let url = URL(string: path, relativeTo: baseURL) else {
      throw ClankieAPIError.invalidBaseURL
    }
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.httpBody = body
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("Bearer \(try captainToken())", forHTTPHeaderField: "Authorization")
    let (data, response) = try await session.data(for: request)
    guard let response = response as? HTTPURLResponse else { throw ClankieAPIError.invalidResponse }
    guard (200..<300).contains(response.statusCode) else {
      throw ClankieAPIError.server(response.statusCode, String(decoding: data, as: UTF8.self))
    }
    return try JSONDecoder().decode(Response.self, from: data)
  }

  private func captainToken() throws -> String {
    if let token { return token }
    if let override = ProcessInfo.processInfo.environment["CLANKIE_CAPTAIN_TOKEN"],
      !override.isEmpty
    {
      token = override
      return override
    }
    let query: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: "bot.clankie.credentials",
      kSecAttrAccount: "clankie_captain",
      kSecReturnData: true,
      kSecMatchLimit: kSecMatchLimitOne,
    ]
    var result: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
      let data = result as? Data,
      let credential = try? JSONDecoder().decode(Credential.self, from: data),
      credential.type == "api",
      credential.key.hasPrefix("clankie_cap_")
    else { throw ClankieAPIError.missingCredential }
    token = credential.key
    return credential.key
  }
}

private struct Credential: Decodable {
  let type: String
  let key: String
}
