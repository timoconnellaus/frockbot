import Cocoa
import AVFoundation
import FlutterMacOS

class MainFlutterWindow: NSWindow {
  private var speaker: PcmSpeaker?
  override func awakeFromNib() {
    let flutterViewController = FlutterViewController()
    let windowFrame = self.frame
    self.contentViewController = flutterViewController
    self.setFrame(windowFrame, display: true)

    // No title bar: the app runs to the window's edge and its existing headers
    // form the chrome. The traffic lights overlay that row, and Flutter asks
    // over the channel below for a header drag to move the window.
    self.titleVisibility = .hidden
    self.titlebarAppearsTransparent = true
    self.styleMask.insert(.fullSizeContentView)
    self.isMovableByWindowBackground = false

    let window = FlutterMethodChannel(
      name: "com.frockbot/window", binaryMessenger: flutterViewController.engine.binaryMessenger)
    window.setMethodCallHandler { [weak self] call, result in
      guard let self else { return }
      switch call.method {
      case "startDrag":
        if let event = NSApp.currentEvent { self.performDrag(with: event) }
        result(nil)
      default:
        result(FlutterMethodNotImplemented)
      }
    }

    // The dock badge. Dart decides the label, including "99+", so the dock
    // and the sidebar cannot count differently; this only draws it.
    let badge = FlutterMethodChannel(
      name: "com.frockbot/badge", binaryMessenger: flutterViewController.engine.binaryMessenger)
    badge.setMethodCallHandler { call, result in
      guard call.method == "set" else {
        result(FlutterMethodNotImplemented)
        return
      }
      let label = (call.arguments as? [String: Any])?["label"] as? String
      NSApp.dockTile.badgeLabel = label?.isEmpty == false ? label : nil
      result(nil)
    }

    speaker = PcmSpeaker(flutterViewController.engine.binaryMessenger)
    RegisterGeneratedPlugins(registry: flutterViewController)
    MacMessagesBridge.shared.bind(flutterViewController.engine.binaryMessenger)
    DesktopUpdater.shared.bind(flutterViewController.engine.binaryMessenger)

    super.awakeFromNib()
  }
}


/// AVAudioPlayerNode distinguishes data consumed from data played by the output.
private final class PcmSpeaker {
  private let channel: FlutterMethodChannel
  private var engine: AVAudioEngine?
  private var player: AVAudioPlayerNode?
  private var format: AVAudioFormat?
  private var generation = 0
  private var epoch = 0
  private var configurationObserver: NSObjectProtocol?

  init(_ messenger: FlutterBinaryMessenger) {
    channel = FlutterMethodChannel(name: "com.frockbot/pcm", binaryMessenger: messenger)
    channel.setMethodCallHandler { [weak self] call, result in
      guard let self else { return }
      do {
        switch call.method {
        case "setup":
          self.release()
          guard let args = call.arguments as? [String: Any],
                let rate = args["sampleRate"] as? Int,
                let epoch = args["epoch"] as? Int,
                let format = AVAudioFormat(standardFormatWithSampleRate: Double(rate), channels: 1)
          else { throw SpeakerError.invalid }
          self.epoch = epoch
          let engine = AVAudioEngine()
          let player = AVAudioPlayerNode()
          self.engine = engine
          self.player = player
          self.format = format
          let owner = self.generation
          self.configurationObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main
          ) { [weak self] _ in
            guard let self, self.generation == owner else { return }
            self.release()
            self.channel.invokeMethod("failed", arguments: ["epoch": epoch])
          }
          engine.attach(player)
          engine.connect(player, to: engine.mainMixerNode, format: format)
          try engine.start()
          player.play()
          result(nil)
        case "feed":
          guard let args = call.arguments as? [String: Any],
                let incomingEpoch = args["epoch"] as? Int
          else { throw SpeakerError.invalid }
          // A feed from a superseded owner is ignored, never a reason to tear
          // down the device someone else now owns.
          guard incomingEpoch == self.epoch else { result(nil); return }
          guard let sequence = args["sequence"] as? Int,
                let data = args["buffer"] as? FlutterStandardTypedData,
                !data.data.isEmpty, data.data.count % 2 == 0,
                let format = self.format, let player = self.player,
                self.engine?.isRunning == true,
                let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(data.data.count / 2)),
                let samples = buffer.floatChannelData?[0]
          else { throw SpeakerError.invalid }
          buffer.frameLength = buffer.frameCapacity
          data.data.withUnsafeBytes { bytes in
            for index in 0..<Int(buffer.frameLength) {
              samples[index] = Float(Int16(littleEndian: bytes.loadUnaligned(fromByteOffset: index * 2, as: Int16.self))) / 32768
            }
          }
          let owner = self.generation
          player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            DispatchQueue.main.async {
              guard let self, self.generation == owner, self.engine?.isRunning == true,
                    self.player?.isPlaying == true else { return }
              self.channel.invokeMethod("played", arguments: ["epoch": incomingEpoch, "sequence": sequence])
            }
          }
          result(nil)
        case "release":
          // Scoped to the caller's own device: a delayed release from a
          // superseded owner leaves the current speaker playing.
          if let owner = (call.arguments as? [String: Any])?["epoch"] as? Int, owner != self.epoch {
            result(nil)
            return
          }
          self.release()
          result(nil)
        default:
          result(FlutterMethodNotImplemented)
        }
      } catch {
        self.release()
        result(FlutterError(code: "speaker", message: "Speaker is unavailable", details: nil))
      }
    }
  }

  private func release() {
    // stop() also invokes scheduled completions; they are invalid before it runs.
    generation += 1
    if let observer = configurationObserver {
      NotificationCenter.default.removeObserver(observer)
      configurationObserver = nil
    }
    player?.stop()
    engine?.stop()
    player = nil
    engine = nil
    format = nil
  }

  deinit { release() }
  private enum SpeakerError: Error { case invalid }
}
