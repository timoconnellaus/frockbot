import AVFoundation
import Flutter
import UIKit
import UserNotifications

/// The app's own channels, registered on every engine: the implicit one the
/// scene starts with, and each one a Shorebird patch restarts into.
final class FrockBotChannels: NSObject {
  private let speaker: PcmSpeaker
  private let route: VoiceAudioRoute
  private let badge: FlutterMethodChannel

  static func register(with registry: FlutterPluginRegistry) {
    guard let registrar = registry.registrar(forPlugin: "FrockBotChannels") else { return }
    let messenger = registrar.messenger()
    // Published, so the channels live exactly as long as the engine they answer.
    registrar.publish(FrockBotChannels(messenger))
    PushNotifications.shared.bind(messenger)
  }

  private init(_ messenger: FlutterBinaryMessenger) {
    speaker = PcmSpeaker(messenger)
    route = VoiceAudioRoute(messenger)
    badge = FlutterMethodChannel(name: "com.frockbot/badge", binaryMessenger: messenger)
    super.init()
    // The home-screen badge. Dart decides the number, so the icon and the
    // sidebar cannot count differently; this only draws it.
    badge.setMethodCallHandler { call, result in
      guard call.method == "set" else {
        result(FlutterMethodNotImplemented)
        return
      }
      let count = (call.arguments as? [String: Any])?["count"] as? Int ?? 0
      if #available(iOS 16.0, *) {
        UNUserNotificationCenter.current().setBadgeCount(max(0, count)) { _ in }
      } else {
        UIApplication.shared.applicationIconBadgeNumber = max(0, count)
      }
      result(nil)
    }
  }
}

/// AVAudioPlayerNode distinguishes data consumed from data played by the
/// output. The same speaker as the Mac's (`macos/Runner/MainFlutterWindow.swift`).
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
          // A route change — a headset connecting — reconfigures the engine
          // and stops it. The device is reported failed, and Dart builds a
          // new one on the route now in use.
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

/// The audio session of a voice call, the way Android's `VoiceAudioRoute.kt`
/// holds one.
///
/// Voice-chat mode is where iOS attaches its echo canceller and lets a
/// Bluetooth headset's microphone work. It also sends a call to the earpiece,
/// which is wrong for an assistant nobody holds to their ear, so the
/// loudspeaker is the default and a worn headset takes over from it. Route
/// changes are reported as `route` events and interruptions as `focus`
/// events, as on Android. `end` restores the session `begin` found.
private final class VoiceAudioRoute {
  private let channel: FlutterMethodChannel
  private let session = AVAudioSession.sharedInstance()
  private var found: (category: AVAudioSession.Category, mode: AVAudioSession.Mode, options: AVAudioSession.CategoryOptions)?
  private var observers: [NSObjectProtocol] = []
  private var lastRoute: String?

  init(_ messenger: FlutterBinaryMessenger) {
    channel = FlutterMethodChannel(name: "com.frockbot/audio-route", binaryMessenger: messenger)
    channel.setMethodCallHandler { [weak self] call, result in
      guard let self else { return }
      switch call.method {
      case "begin":
        do {
          try self.begin()
          result(self.currentRoute())
        } catch {
          result(FlutterError(code: "audio-route", message: error.localizedDescription, details: nil))
        }
      case "end":
        self.end()
        result(nil)
      case "route":
        result(self.currentRoute())
      case "minimumCaptureBuffer":
        // Android sizes its capture buffer from the audio manager; iOS has no opinion.
        result(nil)
      default:
        result(FlutterMethodNotImplemented)
      }
    }
  }

  private func begin() throws {
    if found == nil {
      found = (session.category, session.mode, session.categoryOptions)
      let center = NotificationCenter.default
      observers = [
        center.addObserver(forName: AVAudioSession.routeChangeNotification, object: session, queue: .main) {
          [weak self] _ in self?.report()
        },
        center.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: .main) {
          [weak self] notification in self?.interrupted(notification)
        },
      ]
    }
    // The recorder's own options (record's `IosRecordConfig` defaults), so
    // opening the microphone finds the session as it wants it and changes
    // nothing under a speaker that is already playing.
    try session.setCategory(
      .playAndRecord, mode: .voiceChat,
      options: [.defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP])
    try session.setActive(true)
    report()
  }

  private func end() {
    guard let found else { return }
    self.found = nil
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
    observers = []
    lastRoute = nil
    try? session.setActive(false, options: .notifyOthersOnDeactivation)
    try? session.setCategory(found.category, mode: found.mode, options: found.options)
  }

  /// A phone call, an alarm or Siri takes the audio and gives it back. iOS
  /// does not say for how long, so every interruption is a pause the call can
  /// come back from.
  private func interrupted(_ notification: Notification) {
    guard found != nil,
          let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
          let type = AVAudioSession.InterruptionType(rawValue: raw)
    else { return }
    channel.invokeMethod("focus", arguments: ["state": type == .began ? "paused" : "regained"])
  }

  private func report() {
    guard found != nil else { return }
    let route = currentRoute()
    guard route != lastRoute else { return }
    lastRoute = route
    channel.invokeMethod("route", arguments: ["route": route as Any])
  }

  private func currentRoute() -> String? {
    guard found != nil, let output = session.currentRoute.outputs.first else { return nil }
    switch output.portType {
    case .builtInSpeaker: return "speaker"
    case .builtInReceiver: return "earpiece"
    case .bluetoothHFP, .bluetoothA2DP, .bluetoothLE: return "bluetooth"
    case .headphones, .usbAudio: return "wired"
    default: return "other"
    }
  }

  deinit { end() }
}
