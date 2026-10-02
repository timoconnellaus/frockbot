import AVFoundation
import FlutterMacOS
import FluidAudio

/// Composer dictation transcribed on this Mac: NVIDIA Parakeet TDT 0.6B v3 on
/// Core ML, through FluidAudio. No audio leaves the Mac and nothing is billed.
///
/// The model is not in the app. It is downloaded on the person's press into
/// `~/Library/Application Support/FrockBot/dictation/`, and Remove deletes it.
/// Flutter drives this over `com.frockbot/local-dictation` (see
/// `lib/voice/local_dictation.dart`) and hands over one whole capture at stop,
/// PCM16 mono at the rate it names, the same bytes the cloud path would send.
@MainActor
final class LocalDictation {
  static let shared = LocalDictation()

  private static let version: AsrModelVersion = .v3
  /// What the v3 int8 bundle FluidAudio fetches weighs on Hugging Face, so the
  /// progress bar has a denominator before the files land.
  private static let expectedBytes: Int64 = 483_105_645

  private var channel: FlutterMethodChannel?
  /// `unsupported`, `absent`, `downloading`, `ready` or `failed`.
  private var phase = "absent"
  private var error = ""
  private var downloading: Task<Void, Never>?
  private var poll: Timer?
  private var loading: Task<AsrManager, Error>?

  /// Parakeet on Core ML needs Apple silicon; FluidAudio refuses Intel.
  private var supported: Bool { SystemInfo.isAppleSilicon }

  private var root: URL {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    return base.appendingPathComponent("FrockBot/dictation", isDirectory: true)
  }

  /// FluidAudio keeps a repo's files in a folder named after it beside the
  /// directory it is given, so this is both what it is handed and where it
  /// writes.
  private var models: URL {
    root.appendingPathComponent(Repo.parakeetV3.folderName, isDirectory: true)
  }

  private var present: Bool { AsrModels.modelsExist(at: models, version: Self.version) }

  func bind(_ messenger: FlutterBinaryMessenger) {
    let channel = FlutterMethodChannel(name: "com.frockbot/local-dictation", binaryMessenger: messenger)
    self.channel = channel
    phase = !supported ? "unsupported" : present ? "ready" : "absent"
    channel.setMethodCallHandler { [weak self] call, result in
      guard let self else { return }
      switch call.method {
      case "state": result(self.snapshot)
      case "download":
        self.download()
        result(self.snapshot)
      case "remove":
        self.remove()
        result(self.snapshot)
      case "prepare":
        if self.phase == "ready" { _ = self.manager() }
        result(nil)
      case "transcribe":
        let input = call.arguments as? [String: Any]
        guard let pcm = (input?["pcm"] as? FlutterStandardTypedData)?.data,
          let rate = input?["sampleRate"] as? Int
        else {
          result(FlutterError(code: "input", message: "Nothing to transcribe.", details: nil))
          return
        }
        Task { @MainActor in
          do {
            result(try await self.transcribe(pcm, sampleRate: rate))
          } catch {
            result(FlutterError(code: "transcribe", message: error.localizedDescription, details: nil))
          }
        }
      default: result(FlutterMethodNotImplemented)
      }
    }
  }

  private var snapshot: [String: Any] {
    let onDisk = phase == "unsupported" ? 0 : Self.size(of: root)
    var value: [String: Any] = [
      "phase": phase, "bytesOnDisk": Int(onDisk), "expectedBytes": Int(Self.expectedBytes),
      "error": error,
    ]
    if phase == "downloading" {
      value["progress"] = min(0.99, Double(onDisk) / Double(Self.expectedBytes))
    }
    return value
  }

  private func publish(_ next: String) {
    phase = next
    channel?.invokeMethod("state", arguments: snapshot)
  }

  private func download() {
    guard supported, downloading == nil, phase != "ready" else { return }
    error = ""
    publish("downloading")
    // FluidAudio's own progress restarts for each of the model's parts, so
    // the bar reads the bytes on disk instead: one number that only grows.
    poll = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
      Task { @MainActor in
        guard let self, self.phase == "downloading" else { return }
        self.publish("downloading")
      }
    }
    let target = models
    downloading = Task { @MainActor in
      var failure: Error?
      do {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try await AsrModels.download(to: target, version: Self.version)
      } catch {
        failure = error
      }
      // Remove cancelled this download and has already said so.
      if Task.isCancelled { return }
      poll?.invalidate()
      poll = nil
      downloading = nil
      if let failure {
        NSLog("local dictation download failed: \(failure)")
        error = "The dictation model didn’t download. Check your connection and try again."
      }
      publish(present ? "ready" : "failed")
      if phase == "ready" { _ = manager() }
    }
  }

  private func remove() {
    downloading?.cancel()
    downloading = nil
    poll?.invalidate()
    poll = nil
    loading?.cancel()
    loading = nil
    try? FileManager.default.removeItem(at: root)
    error = ""
    publish(supported ? "absent" : "unsupported")
  }

  /// Loads the model once. Loading compiles it for the Neural Engine, which
  /// can take seconds the first time, so the app asks for it ahead of a
  /// capture rather than at stop.
  private func manager() -> Task<AsrManager, Error> {
    if let loading { return loading }
    let directory = models
    let task = Task<AsrManager, Error> {
      let models = try await AsrModels.load(from: directory, version: Self.version)
      let manager = AsrManager(config: .default)
      try await manager.loadModels(models)
      return manager
    }
    loading = task
    return task
  }

  private func transcribe(_ pcm: Data, sampleRate: Int) async throws -> String {
    guard phase == "ready" else { throw LocalDictationError.absent }
    let loading = manager()
    let manager: AsrManager
    do {
      manager = try await loading.value
    } catch {
      // A load that failed is not kept: the next capture tries again.
      if self.loading == loading { self.loading = nil }
      throw error
    }
    var samples = try Self.resample(pcm, sampleRate: sampleRate)
    if samples.isEmpty { return "" }
    // Parakeet refuses less than its minimum; a quick "yes" is padded with
    // silence rather than lost.
    let minimum = ASRConstants.minimumRequiredSamples(forSampleRate: 16_000)
    if samples.count < minimum {
      samples.append(contentsOf: [Float](repeating: 0, count: minimum - samples.count))
    }
    var state = TdtDecoderState.make(decoderLayers: await manager.decoderLayerCount)
    let result = try await manager.transcribe(samples, decoderState: &state)
    return result.text.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  /// PCM16 little-endian mono at `sampleRate`, as 16 kHz floats.
  private static func resample(_ pcm: Data, sampleRate: Int) throws -> [Float] {
    let frames = pcm.count / 2
    guard frames > 0,
      let format = AVAudioFormat(
        commonFormat: .pcmFormatFloat32, sampleRate: Double(sampleRate), channels: 1,
        interleaved: false),
      let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)),
      let channel = buffer.floatChannelData?[0]
    else { return [] }
    pcm.withUnsafeBytes { raw in
      for index in 0..<frames {
        let sample = Int16(littleEndian: raw.loadUnaligned(fromByteOffset: index * 2, as: Int16.self))
        channel[index] = Float(sample) / 32768
      }
    }
    buffer.frameLength = AVAudioFrameCount(frames)
    return try AudioConverter().resampleBuffer(buffer)
  }

  private static func size(of directory: URL) -> Int64 {
    guard
      let files = FileManager.default.enumerator(
        at: directory, includingPropertiesForKeys: [.totalFileAllocatedSizeKey, .isRegularFileKey])
    else { return 0 }
    var total: Int64 = 0
    for case let file as URL in files {
      let values = try? file.resourceValues(forKeys: [.totalFileAllocatedSizeKey, .isRegularFileKey])
      if values?.isRegularFile == true { total += Int64(values?.totalFileAllocatedSize ?? 0) }
    }
    return total
  }
}

private enum LocalDictationError: LocalizedError {
  case absent
  var errorDescription: String? { "The dictation model isn’t on this Mac yet." }
}
