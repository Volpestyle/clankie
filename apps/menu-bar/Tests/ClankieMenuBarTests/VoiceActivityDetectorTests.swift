import Testing

@testable import ClankieMenuBar

@Test func voiceActivityEndsAfterSustainedSilence() {
  var detector = VoiceActivityDetector(threshold: 0.02, silenceToEnd: 0.2)
  #expect(detector.observe(level: 0.03, duration: 0.05) == .started)
  #expect(detector.observe(level: 0, duration: 0.1) == nil)
  #expect(detector.observe(level: 0, duration: 0.1) == .ended)
}
