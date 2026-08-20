import AVFoundation
import AppKit
import Foundation
import Observation

struct VoiceActivityDetector: Sendable {
  enum Event: Equatable { case started, ended }

  var threshold: Float = 0.025
  var silenceToEnd: TimeInterval = 0.7
  private(set) var isSpeaking = false
  private var quietFor: TimeInterval = 0

  init(threshold: Float = 0.025, silenceToEnd: TimeInterval = 0.7) {
    self.threshold = threshold
    self.silenceToEnd = silenceToEnd
  }

  mutating func observe(level: Float, duration: TimeInterval) -> Event? {
    if level >= threshold {
      quietFor = 0
      if !isSpeaking {
        isSpeaking = true
        return .started
      }
      return nil
    }
    guard isSpeaking else { return nil }
    quietFor += duration
    guard quietFor >= silenceToEnd else { return nil }
    isSpeaking = false
    quietFor = 0
    return .ended
  }

  mutating func reset() {
    isSpeaking = false
    quietFor = 0
  }
}

struct LocalVoiceLine: Identifiable, Sendable {
  let id = UUID()
  let speaker: String
  let text: String
}

private struct VoiceServerEvent: Decodable {
  let type: String
  let state: String?
  let speaker: String?
  let text: String?
  let final: Bool?
  let message: String?
}

private actor VoiceSocketWriter {
  let socket: URLSessionWebSocketTask

  init(socket: URLSessionWebSocketTask) { self.socket = socket }

  func audio(_ data: Data) async throws { try await socket.send(.data(data)) }
  func commit() async throws {
    try await socket.send(.string("{\"schemaVersion\":1,\"type\":\"commit\"}"))
  }
}

@MainActor
final class AudioIO {
  private let engine = AVAudioEngine()
  private let captureMixer = AVAudioMixerNode()
  private let player = AVAudioPlayerNode()
  private let streamFormat = AVAudioFormat(standardFormatWithSampleRate: 24_000, channels: 1)!
  private var captureInstalled = false
  private var scheduledBuffers = 0
  private var drainWaiters: [CheckedContinuation<Void, Never>] = []

  func start(onPCM: @escaping @Sendable (Data, Float, TimeInterval) -> Void) throws {
    guard !engine.isRunning else { return }
    let input = engine.inputNode
    try? input.setVoiceProcessingEnabled(true)
    engine.attach(captureMixer)
    engine.attach(player)
    engine.connect(input, to: captureMixer, format: input.outputFormat(forBus: 0))
    captureMixer.outputVolume = 0
    engine.connect(captureMixer, to: engine.mainMixerNode, format: streamFormat)
    engine.connect(player, to: engine.mainMixerNode, format: streamFormat)
    installCapture(onPCM: onPCM)
    engine.prepare()
    try engine.start()
  }

  func stopCapture() {
    guard captureInstalled else { return }
    captureMixer.removeTap(onBus: 0)
    captureInstalled = false
  }

  func stop() {
    stopCapture()
    player.stop()
    engine.stop()
    engine.reset()
    scheduledBuffers = 0
    resumeDrainWaiters()
  }

  func play(_ data: Data) {
    guard data.count.isMultiple(of: 2), !data.isEmpty,
      let buffer = AVAudioPCMBuffer(
        pcmFormat: streamFormat,
        frameCapacity: AVAudioFrameCount(data.count / 2)
      ), let samples = buffer.floatChannelData?[0]
    else { return }
    buffer.frameLength = buffer.frameCapacity
    data.withUnsafeBytes { bytes in
      for index in 0..<Int(buffer.frameLength) {
        let sample = bytes.loadUnaligned(fromByteOffset: index * 2, as: Int16.self)
        samples[index] = Float(Int16(littleEndian: sample)) / Float(Int16.max)
      }
    }
    scheduledBuffers += 1
    player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
      Task { @MainActor in self?.bufferPlayed() }
    }
    if !player.isPlaying { player.play() }
  }

  func waitUntilPlaybackDrains() async {
    guard scheduledBuffers > 0 else { return }
    await withCheckedContinuation { drainWaiters.append($0) }
  }

  private func installCapture(onPCM: @escaping @Sendable (Data, Float, TimeInterval) -> Void) {
    captureMixer.installTap(onBus: 0, bufferSize: 1_200, format: streamFormat) { buffer, _ in
      guard let floats = buffer.floatChannelData?[0] else { return }
      let count = Int(buffer.frameLength)
      var pcm = [Int16](repeating: 0, count: count)
      var energy: Float = 0
      for index in 0..<count {
        let sample = max(-1, min(1, floats[index]))
        energy += sample * sample
        pcm[index] = Int16(sample * Float(Int16.max))
      }
      let level = count == 0 ? 0 : sqrt(energy / Float(count))
      let data = pcm.withUnsafeBytes { Data($0) }
      onPCM(data, level, Double(count) / 24_000)
    }
    captureInstalled = true
  }

  private func bufferPlayed() {
    scheduledBuffers = max(0, scheduledBuffers - 1)
    if scheduledBuffers == 0 { resumeDrainWaiters() }
  }

  private func resumeDrainWaiters() {
    let waiters = drainWaiters
    drainWaiters.removeAll()
    waiters.forEach { $0.resume() }
  }
}

@MainActor @Observable
final class VoiceChatController {
  enum State: String { case idle, connecting, listening, thinking, speaking, failed }
  private enum Mode { case continuous, momentary }

  private let api: ClankieAPI
  private let audio = AudioIO()
  private var socket: URLSessionWebSocketTask?
  private var writer: VoiceSocketWriter?
  private var receiveTask: Task<Void, Never>?
  private var mode: Mode?
  private var detector = VoiceActivityDetector()
  private var preRoll: [Data] = []
  private var capturing = false
  private var fnHeld = false
  private var closeAfterResponse = false

  var state: State = .idle
  var inputLevel: Float = 0
  var transcript: [LocalVoiceLine] = []
  var partialOperator = ""
  var partialClankie = ""
  var errorMessage: String?

  var isActive: Bool { state != .idle && state != .failed }

  init(api: ClankieAPI) { self.api = api }

  func toggle() {
    if isActive {
      stop()
    } else {
      Task { await start(.continuous) }
    }
  }

  func fnChanged(isDown: Bool) {
    guard fnHeld != isDown else { return }
    fnHeld = isDown
    if isDown {
      guard !isActive else { return }
      Task { await start(.momentary) }
    } else if mode == .momentary {
      finishMomentaryInput()
    }
  }

  func stop() {
    receiveTask?.cancel()
    receiveTask = nil
    socket?.cancel(with: .normalClosure, reason: nil)
    socket = nil
    writer = nil
    audio.stop()
    detector.reset()
    preRoll.removeAll()
    capturing = false
    closeAfterResponse = false
    mode = nil
    inputLevel = 0
    state = .idle
  }

  private func start(_ requestedMode: Mode) async {
    guard state == .idle || state == .failed else { return }
    errorMessage = nil
    state = .connecting
    mode = requestedMode
    guard await AVCaptureDevice.requestAccess(for: .audio) else {
      fail("Microphone access is required for local voice chat.")
      return
    }
    do {
      let request = try await api.voiceWebSocketRequest()
      let session = await api.webSocketSession()
      let socket = session.webSocketTask(with: request)
      self.socket = socket
      writer = VoiceSocketWriter(socket: socket)
      socket.resume()
      try audio.start { [weak self] data, level, duration in
        Task { @MainActor in self?.handlePCM(data, level: level, duration: duration) }
      }
      receiveTask = Task { [weak self] in await self?.receive() }
      if requestedMode == .momentary, !fnHeld { finishMomentaryInput() }
    } catch {
      fail(error.localizedDescription)
    }
  }

  private func handlePCM(_ data: Data, level: Float, duration: TimeInterval) {
    guard let writer else { return }
    inputLevel = min(1, level * 8)
    if mode == .momentary {
      Task { try? await writer.audio(data) }
      return
    }
    let event = detector.observe(level: level, duration: duration)
    if capturing {
      Task { try? await writer.audio(data) }
    } else {
      preRoll.append(data)
      if preRoll.count > 5 { preRoll.removeFirst() }
    }
    if event == .started {
      capturing = true
      let buffered = preRoll
      preRoll.removeAll()
      Task {
        for chunk in buffered { try? await writer.audio(chunk) }
      }
    } else if event == .ended {
      capturing = false
      preRoll.removeAll()
      Task { try? await writer.commit() }
    }
  }

  private func finishMomentaryInput() {
    guard closeAfterResponse == false else { return }
    closeAfterResponse = true
    audio.stopCapture()
    if let writer { Task { try? await writer.commit() } }
    Task { [weak self] in
      try? await Task.sleep(for: .seconds(12))
      guard let self, self.closeAfterResponse else { return }
      self.stop()
    }
  }

  private func receive() async {
    guard let socket else { return }
    do {
      while !Task.isCancelled {
        switch try await socket.receive() {
        case .data(let data): audio.play(data)
        case .string(let text): handleServerEvent(text)
        @unknown default: break
        }
      }
    } catch is CancellationError {
    } catch {
      fail(error.localizedDescription)
    }
  }

  private func handleServerEvent(_ text: String) {
    guard let data = text.data(using: .utf8),
      let event = try? JSONDecoder().decode(VoiceServerEvent.self, from: data)
    else { return }
    switch event.type {
    case "status":
      if let value = event.state.flatMap(State.init(rawValue:)) { state = value }
    case "transcript":
      updateTranscript(event)
    case "response_done":
      guard closeAfterResponse else { return }
      closeAfterResponse = false
      Task { [weak self] in
        guard let self else { return }
        await self.audio.waitUntilPlaybackDrains()
        self.stop()
      }
    case "error":
      if let message = event.message { errorMessage = message }
    default: break
    }
  }

  private func updateTranscript(_ event: VoiceServerEvent) {
    guard let speaker = event.speaker, let text = event.text, !text.isEmpty else { return }
    let isOperator = speaker == "operator"
    if event.final == true {
      transcript.append(
        .init(
          speaker: isOperator ? "You" : "Clankie",
          text: text
        ))
      if transcript.count > 40 { transcript.removeFirst(transcript.count - 40) }
      if isOperator { partialOperator = "" } else { partialClankie = "" }
    } else if isOperator {
      partialOperator += text
    } else {
      partialClankie += text
    }
  }

  private func fail(_ message: String) {
    stop()
    errorMessage = message
    state = .failed
  }
}

@MainActor
final class FnKeyMonitor: NSObject {
  var onChange: ((Bool) -> Void)?
  private var timer: Timer?
  private var previous = false

  override init() {
    super.init()
    timer = Timer.scheduledTimer(
      timeInterval: 0.03, target: self, selector: #selector(tick), userInfo: nil, repeats: true)
  }

  @objc private func tick() {
    let current = CGEventSource.flagsState(.combinedSessionState).contains(.maskSecondaryFn)
    guard current != previous else { return }
    previous = current
    onChange?(current)
  }
}
