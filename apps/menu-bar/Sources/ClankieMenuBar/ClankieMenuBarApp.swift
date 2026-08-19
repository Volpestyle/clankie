import AppKit
import Observation
import SwiftUI

struct DiscordVoiceRoomCard: Identifiable {
  let id: String
  let guildName: String
  let channelName: String
  let entries: [VoiceTranscriptEntry]
}

@MainActor @Observable
final class AppModel {
  let api = ClankieAPI()
  let voice: VoiceChatController
  private let fnMonitor = FnKeyMonitor()

  var conversations: [OperatorConversation] = []
  var expandedConversationIDs: Set<String> = []
  var conversationEvents: [String: [ConversationEvent]] = [:]
  var expandedVoiceRoomIDs: Set<String> = []
  var presenceRooms: [String: VoiceRoom] = [:]
  var voiceEntries: [VoiceTranscriptEntry] = []
  var voiceTranscriptsEnabled = false
  var lastError: String?
  var sessionNotice: String?
  var voiceNotice: String?
  private var conversationCursors: [String: String] = [:]
  private var voiceCursor: String?

  init() {
    voice = VoiceChatController(api: api)
    fnMonitor.onChange = { [weak voice] isDown in voice?.fnChanged(isDown: isDown) }
  }

  var voiceRooms: [DiscordVoiceRoomCard] {
    let entryGroups = Dictionary(grouping: voiceEntries, by: \.roomId)
    let ids = Set(entryGroups.keys).union(presenceRooms.keys)
    return ids.map { id in
      let room = presenceRooms[id]
      let entries = entryGroups[id, default: []].sorted { $0.occurredAt < $1.occurredAt }
      return DiscordVoiceRoomCard(
        id: id,
        guildName: room?.guildName ?? "Discord",
        channelName: room?.channelName ?? "Voice channel",
        entries: entries
      )
    }.sorted { ($0.entries.last?.occurredAt ?? "") > ($1.entries.last?.occurredAt ?? "") }
  }

  func run() async {
    while !Task.isCancelled {
      await refresh()
      try? await Task.sleep(for: .seconds(1))
    }
  }

  func refresh() async {
    async let sessions: Void = refreshConversations()
    async let voices: Void = refreshVoiceRooms()
    _ = await (sessions, voices)
  }

  func toggleConversation(_ id: String) {
    if expandedConversationIDs.remove(id) == nil {
      expandedConversationIDs.insert(id)
      Task { await refreshConversation(id) }
    }
  }

  func toggleVoiceRoom(_ id: String) {
    if expandedVoiceRoomIDs.remove(id) == nil { expandedVoiceRoomIDs.insert(id) }
  }

  func clearSession(_ conversation: OperatorConversation) async {
    guard !conversation.isDefault, conversation.sessionState != "active" else { return }
    do {
      if try await api.closeConversation(conversation.id) {
        expandedConversationIDs.remove(conversation.id)
        conversationEvents.removeValue(forKey: conversation.id)
        conversationCursors.removeValue(forKey: conversation.id)
        sessionNotice = "Cleared \(conversation.title)."
      } else {
        sessionNotice = "That session is active or protected."
      }
      await refreshConversations()
    } catch {
      lastError = error.localizedDescription
    }
  }

  private func refreshConversations() async {
    do {
      conversations = try await api.listConversations()
      for id in expandedConversationIDs { await refreshConversation(id) }
      lastError = nil
    } catch {
      lastError = error.localizedDescription
    }
  }

  private func refreshConversation(_ id: String) async {
    do {
      var cursor = conversationCursors[id]
      repeat {
        let page = try await api.tailConversation(id, cursor: cursor)
        guard page.status == "page" else { break }
        let newEvents = page.events ?? []
        var events = conversationEvents[id, default: []]
        let known = Set(events.map(\.cursor))
        events.append(contentsOf: newEvents.filter { !known.contains($0.cursor) })
        conversationEvents[id] = Array(events.suffix(80))
        cursor = page.nextCursor
        conversationCursors[id] = cursor
        if page.hasMore != true { break }
      } while !Task.isCancelled
    } catch {
      lastError = error.localizedDescription
    }
  }

  private func refreshVoiceRooms() async {
    do {
      let sessions = try await api.listPresenceSessions()
      presenceRooms = Dictionary(
        uniqueKeysWithValues:
          sessions
          .flatMap { $0.voiceRooms ?? [] }
          .compactMap { room in room.channelId.map { ("\(room.guildId):\($0)", room) } })
      let page = try await api.readVoiceTranscripts(cursor: voiceCursor)
      voiceNotice = nil
      voiceTranscriptsEnabled = page.enabled
      if !page.enabled {
        voiceEntries = []
        voiceCursor = nil
        return
      }
      let known = Set(voiceEntries.map(\.id))
      voiceEntries.append(contentsOf: page.entries.filter { !known.contains($0.id) })
      voiceEntries = Array(voiceEntries.suffix(200))
      voiceCursor = page.nextCursor
    } catch ClankieAPIError.server(let status, _) where status == 404 {
      voiceNotice = "Restart Clankie to enable voice transcripts."
    } catch {
      voiceNotice = error.localizedDescription
    }
  }
}

@main
struct ClankieMenuBarApp: App {
  @State private var model = AppModel()

  var body: some Scene {
    MenuBarExtra {
      AppletView(model: model)
        .task { await model.run() }
        .preferredColorScheme(.dark)
    } label: {
      MenuBarGlyph(attention: model.voice.state == .failed)
    }
    .menuBarExtraStyle(.window)
  }
}

private struct MenuBarGlyph: View {
  let attention: Bool

  var body: some View {
    Image(nsImage: Self.image)
      .resizable()
      .renderingMode(.template)
      .frame(width: 18, height: 18)
      .overlay(alignment: .topTrailing) {
        if attention { Circle().fill(.orange).frame(width: 4, height: 4).offset(x: 2, y: -1) }
      }
      .accessibilityLabel("Clankie")
  }

  private static let image: NSImage = {
    guard let url = Bundle.module.url(forResource: "ClankieMenuBarIcon", withExtension: "svg"),
      let image = NSImage(contentsOf: url)
    else { return NSImage(size: NSSize(width: 18, height: 18)) }
    image.isTemplate = true
    return image
  }()
}

private struct AppletView: View {
  @Bindable var model: AppModel

  var body: some View {
    VStack(spacing: 0) {
      header
      Divider()
      talk
      Divider()
      ScrollView {
        LazyVStack(spacing: 5) {
          voiceSection
          sessionSection
          if let error = model.lastError ?? model.voice.errorMessage {
            Text(error).font(.caption2).foregroundStyle(.orange).frame(
              maxWidth: .infinity, alignment: .leading)
          }
        }
        .padding(14)
      }
    }
    .frame(width: 420, height: 842)
    .background(Color(hex: 0x202126))
  }

  private var header: some View {
    HStack {
      Text("Clankie").font(.system(size: 17, weight: .semibold))
      Spacer()
      Menu {
        Button("Refresh", systemImage: "arrow.clockwise") { Task { await model.refresh() } }
        Divider()
        Button("Quit", systemImage: "power", role: .destructive) {
          NSApplication.shared.terminate(nil)
        }
      } label: {
        Image(systemName: "gearshape").frame(width: 28, height: 28)
      }
      .menuStyle(.borderlessButton)
      .accessibilityLabel("Applet menu")
    }
    .padding(.horizontal, 16)
    .frame(height: 56)
  }

  private var talk: some View {
    VStack(spacing: 8) {
      Waveform(level: model.voice.inputLevel, active: model.voice.isActive)
      Text(statusTitle).font(.system(size: 13, weight: .medium))
      Text(statusDetail).font(.system(size: 12)).foregroundStyle(.secondary)
      Button {
        model.voice.toggle()
      } label: {
        Image(systemName: model.voice.isActive ? "mic.fill" : "mic")
          .font(.system(size: 16, weight: .medium))
          .foregroundStyle(Color(hex: 0x202126))
          .frame(width: 42, height: 42)
          .background(Circle().fill(Color(hex: 0xECEEF1)))
          .shadow(color: .black.opacity(0.24), radius: 8, y: 3)
      }
      .buttonStyle(.plain)
      .accessibilityLabel(model.voice.isActive ? "End voice chat" : "Start voice chat")
      .accessibilityHint("Click to toggle. Hold the Fn key to talk from anywhere.")
      Text("Click to toggle  ·  Hold fn to talk anywhere")
        .font(.system(size: 11, weight: .medium))
        .foregroundStyle(.secondary)
    }
    .frame(height: 178)
  }

  private var statusTitle: String {
    switch model.voice.state {
    case .idle: "Ready"
    case .connecting: "Connecting"
    case .listening: "Listening"
    case .thinking: "Thinking"
    case .speaking: "Speaking"
    case .failed: "Unavailable"
    }
  }

  private var statusDetail: String {
    model.voice.state == .idle ? "I’m here." : "Private local voice chat"
  }

  private var sessionSection: some View {
    VStack(spacing: 5) {
      SectionHeader(title: "PI SESSIONS", count: model.conversations.count)
      if let notice = model.sessionNotice {
        Text(notice).font(.caption2).foregroundStyle(.secondary)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      ForEach(model.conversations) { conversation in
        DisclosureCard(
          title: conversation.title,
          detail: sessionDetail(conversation),
          state: conversation.sessionState,
          expanded: model.expandedConversationIDs.contains(conversation.id),
          toggle: { model.toggleConversation(conversation.id) },
          delete: conversation.isDefault || conversation.sessionState == "active"
            ? nil
            : {
              Task { await model.clearSession(conversation) }
            }
        ) {
          ConversationTranscript(events: model.conversationEvents[conversation.id, default: []])
        }
      }
    }
  }

  private var voiceSection: some View {
    VStack(spacing: 5) {
      SectionHeader(
        title: "VOICE CHATS", count: model.voiceRooms.count + (model.voice.isActive ? 1 : 0))
      if model.voice.isActive || !model.voice.transcript.isEmpty {
        DisclosureCard(
          title: "Local · This Mac",
          detail: "private · \(model.voice.state.rawValue)",
          state: model.voice.isActive ? "active" : "waiting",
          expanded: model.expandedVoiceRoomIDs.contains("local"),
          toggle: { model.toggleVoiceRoom("local") }
        ) {
          LocalVoiceTranscript(controller: model.voice)
        }
      }
      if let notice = model.voiceNotice {
        Text(notice)
          .font(.caption)
          .foregroundStyle(.secondary)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(10)
          .background(RoundedRectangle(cornerRadius: 8).fill(Color(hex: 0x26282E)))
      } else if !model.voiceTranscriptsEnabled && model.voiceRooms.isEmpty {
        Text("Exact voice transcripts are off in /discord settings.")
          .font(.caption)
          .foregroundStyle(.secondary)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(10)
          .background(RoundedRectangle(cornerRadius: 8).fill(Color(hex: 0x26282E)))
      }
      ForEach(model.voiceRooms) { room in
        DisclosureCard(
          title: "\(room.guildName) · \(room.channelName)",
          detail: "Discord · \(room.entries.isEmpty ? "live" : "live transcript")",
          state: "active",
          expanded: model.expandedVoiceRoomIDs.contains(room.id),
          toggle: { model.toggleVoiceRoom(room.id) }
        ) {
          DiscordVoiceTranscript(entries: room.entries)
        }
      }
    }
  }

  private func sessionDetail(_ conversation: OperatorConversation) -> String {
    let context = conversation.contextUsage?.percentage.map { " · \($0)% context" } ?? ""
    return conversation.sessionState + context
  }
}

private struct Waveform: View {
  let level: Float
  let active: Bool
  private let base: [CGFloat] = [7, 13, 19, 11, 17, 9, 5]

  var body: some View {
    HStack(spacing: 4) {
      ForEach(base.indices, id: \.self) { index in
        Capsule()
          .fill(active && (index == 2 || index == 4) ? Color(hex: 0x8ADEB6) : Color(hex: 0x70737C))
          .frame(width: 3, height: max(5, base[index] * CGFloat(active ? 0.65 + level : 0.65)))
      }
    }
    .frame(width: 64, height: 22)
    .accessibilityHidden(true)
  }
}

private struct SectionHeader: View {
  let title: String
  let count: Int

  var body: some View {
    HStack {
      Text(title).font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
      Spacer()
      Text("\(count)").font(.system(size: 10, weight: .medium)).foregroundStyle(.secondary)
        .padding(.horizontal, 7).padding(.vertical, 2).background(
          Capsule().fill(Color(hex: 0x303239)))
    }
    .frame(height: 28)
  }
}

private struct DisclosureCard<Content: View>: View {
  let title: String
  let detail: String
  let state: String
  let expanded: Bool
  let toggle: () -> Void
  let delete: (() -> Void)?
  @ViewBuilder let content: () -> Content

  init(
    title: String, detail: String, state: String, expanded: Bool, toggle: @escaping () -> Void,
    delete: (() -> Void)? = nil, @ViewBuilder content: @escaping () -> Content
  ) {
    self.title = title
    self.detail = detail
    self.state = state
    self.expanded = expanded
    self.toggle = toggle
    self.delete = delete
    self.content = content
  }

  var body: some View {
    VStack(spacing: 5) {
      HStack(spacing: 4) {
        Button(action: toggle) {
          HStack(spacing: 8) {
            Image(systemName: expanded ? "chevron.down" : "chevron.right").font(.system(size: 9))
            Circle().fill(statusColor).frame(width: 6, height: 6)
            VStack(alignment: .leading, spacing: 1) {
              Text(title).font(.system(size: 12, weight: .medium)).lineLimit(1)
              Text(detail).font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
          }
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityValue(expanded ? "Expanded" : "Collapsed")
        if let delete {
          Button(role: .destructive, action: delete) {
            Image(systemName: "trash").font(.system(size: 10, weight: .medium))
              .frame(width: 24, height: 24)
          }
          .buttonStyle(.plain)
          .accessibilityLabel("Clear \(title)")
        }
      }
      if expanded { content() }
    }
    .padding(10)
    .background(RoundedRectangle(cornerRadius: 9).fill(Color(hex: expanded ? 0x292B31 : 0x26282E)))
    .overlay {
      if expanded { RoundedRectangle(cornerRadius: 9).stroke(Color(hex: 0x3C3F47)) }
    }
  }

  private var statusColor: Color {
    switch state {
    case "active": Color(hex: 0x69D7A1)
    case "failed": .red
    case "waiting": Color(hex: 0xE0B86A)
    default: Color(hex: 0x8F929A)
    }
  }
}

private struct ConversationTranscript: View {
  let events: [ConversationEvent]

  var body: some View {
    LazyVStack(spacing: 5) {
      if displayEvents.isEmpty {
        Text("Waiting for transcript…").font(.caption).foregroundStyle(.secondary)
      }
      ForEach(displayEvents) { event in
        if event.type == "message", let text = event.text {
          TranscriptBubble(speaker: event.role == "operator" ? "You" : "Clankie", text: text)
        } else {
          Text([event.name, event.phase, event.summary].compactMap { $0 }.joined(separator: " · "))
            .font(.caption2).foregroundStyle(.secondary).frame(
              maxWidth: .infinity, alignment: .leading)
        }
      }
    }
  }

  private var displayEvents: [ConversationEvent] {
    Array(
      events.filter { event in
        (event.type == "message" && event.streaming != true)
          || ["tool", "input_requested", "session"].contains(event.type)
      }.suffix(20))
  }
}

private struct LocalVoiceTranscript: View {
  let controller: VoiceChatController
  var body: some View {
    LazyVStack(spacing: 5) {
      ForEach(controller.transcript.suffix(20)) {
        TranscriptBubble(speaker: $0.speaker, text: $0.text)
      }
      if !controller.partialOperator.isEmpty {
        TranscriptBubble(speaker: "You", text: controller.partialOperator + "…")
      }
      if !controller.partialClankie.isEmpty {
        TranscriptBubble(speaker: "Clankie", text: controller.partialClankie + "…")
      }
    }
  }
}

private struct DiscordVoiceTranscript: View {
  let entries: [VoiceTranscriptEntry]
  var body: some View {
    LazyVStack(spacing: 5) {
      if entries.isEmpty {
        Text("Listening for retained speech…").font(.caption).foregroundStyle(.secondary)
      }
      ForEach(entries.suffix(20)) { entry in
        TranscriptBubble(speaker: entry.displayName ?? entry.speakerId, text: entry.text)
      }
    }
  }
}

private struct TranscriptBubble: View {
  let speaker: String
  let text: String
  var body: some View {
    VStack(alignment: .leading, spacing: 1) {
      Text(speaker).font(.system(size: 9, weight: .semibold)).foregroundStyle(
        speaker == "Clankie" ? Color(hex: 0x95DAB9) : Color(hex: 0xA6C5FF))
      Text(text).font(.system(size: 10)).textSelection(.enabled).frame(
        maxWidth: .infinity, alignment: .leading)
    }
    .padding(.horizontal, 9).padding(.vertical, 5)
    .background(
      RoundedRectangle(cornerRadius: 7).fill(Color(hex: speaker == "Clankie" ? 0x27362F : 0x32353D))
    )
  }
}

extension Color {
  fileprivate init(hex: UInt32) {
    self.init(
      red: Double((hex >> 16) & 0xff) / 255,
      green: Double((hex >> 8) & 0xff) / 255,
      blue: Double(hex & 0xff) / 255
    )
  }
}
