/// Labels a capture frame as speech, or declines to.
///
/// [SpeechGate] owns onset, hangover and pre-roll. This object answers only
/// "is this speech?": energy never does, which is why a slammed door still
/// wakes an energy-only call. Silero replaces that label on the platforms
/// that can run the model. The browser, the test VM and a native prepare
/// that failed keep energy, so a missing ONNX runtime is a worse detector,
/// never a broken call.
///
/// Nothing here opens a microphone. Capture already owns the device; a
/// classifier that opened a second one would fight it.
library;

import 'dart:typed_data';

import 'package:flutter/foundation.dart'
    show TargetPlatform, defaultTargetPlatform, kIsWeb;

import 'speech_classifier_stub.dart'
    if (dart.library.io) 'speech_classifier_io.dart';

/// The speech/not-speech label for one PCM16 frame.
abstract interface class SpeechClassifier {
  /// Whether [probability] is a speech score the gate should trust.
  ///
  /// False is energy: the model is not up, or this platform does not run
  /// it. The gate then uses the frame's RMS against its own floor.
  bool get ready;

  /// Latest speech probability, 0..1. Ignored unless [ready].
  double get probability;

  /// The next capture frame. Energy is a no-op; Silero runs the model.
  void offer(Uint8List pcm16);

  /// Loads the model. Energy is already ready to decline. Failure leaves
  /// [ready] false, which is the energy fallback.
  Future<void> prepare();

  /// Forgets RNN state: a mute or a pause is not the next utterance.
  void reset();

  /// Releases the model. The instance is not reused.
  Future<void> dispose();
}

/// The default label: none. The gate keeps its energy floor.
class EnergySpeechClassifier implements SpeechClassifier {
  const EnergySpeechClassifier();

  @override
  bool get ready => false;

  @override
  double get probability => 0;

  @override
  void offer(Uint8List pcm16) {}

  @override
  Future<void> prepare() async {}

  @override
  void reset() {}

  @override
  Future<void> dispose() async {}
}

/// Platforms whose plugin ships an ONNX runtime and the Silero v6 model.
bool sileroSpeechClassifierSupportedV1({
  TargetPlatform? platform,
  bool web = kIsWeb,
}) {
  if (web) return false;
  return switch (platform ?? defaultTargetPlatform) {
    TargetPlatform.android ||
    TargetPlatform.iOS ||
    TargetPlatform.macOS => true,
    _ => false,
  };
}

/// Silero on Android, iOS and macOS; energy everywhere else, including the
/// browser `bot.frockbot.com` serves. Web has no ONNX runtime we can load
/// under `script-src 'self'`, and a CDN copy would be a second origin.
SpeechClassifier createSpeechClassifierV1() =>
    createPlatformSpeechClassifierV1();
