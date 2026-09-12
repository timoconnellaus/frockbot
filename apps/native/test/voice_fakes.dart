/// The socket, the microphone and the speaker, without a device.
///
/// Every voice controller takes these three as interfaces for exactly this
/// reason: a call's rules — the handshake, sleep, wake, mute, barge-in, the
/// draft binding — are decisions, and a decision is testable without hardware.
library;

import 'dart:async';
import 'dart:typed_data';

import 'package:frockbot_native/voice/capture.dart';
import 'package:frockbot_native/voice/player.dart';
import 'package:frockbot_native/voice/socket.dart';

/// Lets the pending microtasks run, which is how a fake stream delivers.
Future<void> settle([int rounds = 3]) async {
  for (var i = 0; i < rounds; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

class FakeVoiceSocket implements VoiceSocket {
  final StreamController<Object?> _incoming =
      StreamController<Object?>.broadcast();
  final List<Object> sent = [];
  bool closed = false;
  int? closeCode;
  String? closeReason;

  @override
  Stream<Object?> get messages => _incoming.stream;

  @override
  void sendText(String text) => sent.add(text);

  @override
  void sendBinary(Uint8List bytes) => sent.add(bytes);

  @override
  Future<void> close({
    int code = voiceCloseNormalV1,
    String reason = '',
  }) async {
    closed = true;
    closeCode = code;
    closeReason = reason;
    if (!_incoming.isClosed) await _incoming.close();
  }

  void deliver(Object? message) => _incoming.add(message);

  /// The server's end going away: the stream finishes without the client
  /// having asked for it.
  Future<void> finish() async {
    if (!_incoming.isClosed) await _incoming.close();
  }

  List<String> get texts => sent.whereType<String>().toList();
  List<Uint8List> get binaries => sent.whereType<Uint8List>().toList();

  /// The first byte of each binary frame, which is how a test labels audio.
  List<int> get audioMarks => [for (final frame in binaries) frame.first];
}

class FakeVoiceCapture implements VoiceCapture {
  StreamController<AudioFrame> _frames =
      StreamController<AudioFrame>.broadcast();
  Object? failure;
  int? sampleRate;
  Duration? frame;
  int stops = 0;
  int starts = 0;
  bool _active = false;

  /// Stands in for the permission prompt: a start that does not finish until
  /// the test says so, which is the window an end or a dispose has to race.
  Completer<void>? permission;

  @override
  bool get active => _active;

  @override
  Future<Stream<AudioFrame>> start({
    required int sampleRate,
    required Duration frame,
  }) async {
    starts++;
    await permission?.future;
    final failed = failure;
    if (failed != null) throw failed;
    this.sampleRate = sampleRate;
    this.frame = frame;
    _active = true;
    // A restarted capture is a new stream, the way a real recorder's is.
    if (_frames.isClosed) _frames = StreamController<AudioFrame>.broadcast();
    return _frames.stream;
  }

  @override
  Future<void> stop() async {
    if (_active) stops++;
    _active = false;
  }

  void emit(AudioFrame frame) => _frames.add(frame);

  @override
  Future<void> dispose() async {
    await stop();
    if (!_frames.isClosed) await _frames.close();
  }
}

class FakeVoicePlayer extends VoicePlayer {
  final List<Uint8List> written = [];
  int interrupts = 0;
  int? sampleRate;
  bool closed = false;
  double _level = 0;

  @override
  double get level => _level;

  set level(double value) {
    _level = value;
    notifyListeners();
  }

  @override
  Future<void> configure(int sampleRate) async => this.sampleRate = sampleRate;

  @override
  void write(Uint8List chunk) => written.add(chunk);

  @override
  Future<void> interrupt() async {
    interrupts++;
    written.clear();
  }

  @override
  Future<void> close() async => closed = true;
}

/// One PCM16 frame of a constant amplitude, so its RMS is exactly [level].
///
/// [mark] is written into the first byte so a test can tell one frame from
/// another and prove the order they went up the wire in.
Uint8List pcmFrame(double level, {int samples = 640, int mark = 0}) {
  final bytes = Uint8List(samples * 2);
  final view = ByteData.sublistView(bytes);
  final value = (level * 32768).round().clamp(-32768, 32767);
  for (var i = 0; i < samples; i++) {
    view.setInt16(i * 2, value, Endian.little);
  }
  bytes[0] = mark;
  return bytes;
}
