import Foundation
import Testing

@testable import ClankieMenuBar

@Test func spokenTranscriptKeepsIdentityAndCutoffVisible() throws {
  let data = Data("""
    {"body":"bot","occurredAt":"2026-09-29T05:00:00Z","guildId":"12345","channelId":"67890",
    "deliveryId":"same","speakerId":"clankie","displayName":"Clankie","text":"Generated ending.",
    "role":"assistant","itemId":"answer","outcome":"interrupted","audioStarted":true,"textComplete":true}
    """.utf8)
  let entry = try JSONDecoder().decode(VoiceTranscriptEntry.self, from: data)
  #expect(entry.id == "bot:same:assistant:answer")
  #expect(entry.speakerLabel.contains("interrupted"))
  #expect(entry.speakerLabel.contains("audible cutoff unknown"))
}

@Test func legacyVoiceTranscriptStillDecodes() throws {
  let data = Data("""
    {"body":"bot","occurredAt":"2026-09-29T05:00:00Z","guildId":"12345","channelId":"67890",
    "deliveryId":"same","speakerId":"1234","displayName":"James","text":"Hello"}
    """.utf8)
  let entry = try JSONDecoder().decode(VoiceTranscriptEntry.self, from: data)
  #expect(entry.id == "bot:same")
  #expect(entry.speakerLabel == "James")
}
