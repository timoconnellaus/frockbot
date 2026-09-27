import 'dart:async';
import 'dart:typed_data';

import 'package:vad_plus/vad_plus.dart';

import 'speech_classifier.dart';

SpeechClassifier createPlatformSpeechClassifierV1() =>
    sileroSpeechClassifierSupportedV1()
    ? SileroSpeechClassifier()
    : const EnergySpeechClassifier();

/// Silero v6 over the frames capture already produced.
///
/// Inference is off-thread; [probability] is the last completed 32 ms
/// window, so the gate is one frame behind the microphone. Onset still
/// needs 120 ms, so that lag is inside the hold it already waits. The
/// plugin's own start/end events are ignored: [SpeechGate] owns timing.
/// [VadPlus.start] is never called — that path opens a second microphone.
class SileroSpeechClassifier implements SpeechClassifier {
  VadPlus? _vad;
  StreamSubscription<VadEvent>? _events;
  bool _ready = false;
  double _probability = 0;
  bool _disposed = false;

  @override
  bool get ready => _ready;

  @override
  double get probability => _probability;

  @override
  Future<void> prepare() async {
    if (_disposed || _vad != null) return;
    final vad = VadPlus();
    final events = vad.events.listen(_onEvent);
    try {
      await vad.initialize(config: const VadConfig());
    } on Object {
      await events.cancel();
      vad.dispose();
      return;
    }
    if (_disposed) {
      await events.cancel();
      vad.dispose();
      return;
    }
    _events = events;
    _vad = vad;
  }

  void _onEvent(VadEvent event) {
    if (event is VadFrameProcessed) {
      _probability = event.probability;
      _ready = true;
    } else if (event is VadError) {
      _ready = false;
    }
  }

  @override
  void offer(Uint8List pcm16) {
    final vad = _vad;
    if (vad == null || _disposed) return;
    vad.processAudio(_pcm16ToFloat32(pcm16));
  }

  @override
  void reset() {
    _probability = 0;
    _vad?.reset();
  }

  @override
  Future<void> dispose() async {
    _disposed = true;
    _ready = false;
    _probability = 0;
    final events = _events;
    _events = null;
    await events?.cancel();
    final vad = _vad;
    _vad = null;
    vad?.dispose();
  }
}

/// PCM16 little-endian to float −1..1, in Dart, so a hot frame does not
/// cross FFI just to scale integers.
Float32List _pcm16ToFloat32(Uint8List bytes) {
  final samples = bytes.lengthInBytes ~/ 2;
  final out = Float32List(samples);
  if (samples == 0) return out;
  final view = ByteData.sublistView(bytes, 0, samples * 2);
  for (var i = 0; i < samples; i++) {
    out[i] = view.getInt16(i * 2, Endian.little) / 32768.0;
  }
  return out;
}
