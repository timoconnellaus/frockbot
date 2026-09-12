/// The speaker: PCM16 mono played in order, and stopped the instant it must
/// be.
///
/// Audio comes down the wire in arbitrary chunks — a chunk may end on an odd
/// byte, which is half a sample — so the carry is this file's job and no
/// controller's. Barge-in is the reason [interrupt] exists: dropping the queue
/// is not enough on its own, because what has already been handed to the
/// platform would keep talking over the person, so the device queue is torn
/// down and rebuilt.
///
/// A device that will not set up is tried again a little later rather than
/// written off for the call: a platform without the plugin (the web build)
/// keeps failing quietly, while a track that was busy for a moment comes
/// back. Until it does, what arrives is held — a few seconds of it — so the
/// first successful setup plays the reply rather than its tail.
///
/// [VoicePlayer] is an interface for the same reason the capture is: an
/// assistant test must run without a speaker.
library;

import 'dart:async';
import 'dart:collection';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter_pcm_sound/flutter_pcm_sound.dart';

import 'protocol.dart' show voiceAssistantOutputSampleRateV1;
import 'speech_gate.dart' show pcm16Rms;

abstract class VoicePlayer extends ChangeNotifier {
  /// The rate the server said it is sending. Called before the first chunk
  /// and again if `audio_config` names a different one.
  Future<void> configure(int sampleRate);

  /// Queues a chunk. Boundaries are arbitrary; an odd trailing byte is
  /// carried into the next chunk.
  void write(Uint8List chunk);

  /// Stops now and drops everything queued, here and on the device.
  Future<void> interrupt();

  Future<void> close();

  /// RMS of the audio being played, 0..1. Zero when nothing is.
  double get level;
}

/// The speaker through `flutter_pcm_sound` (Android and macOS).
///
/// That plugin has no "drop what is queued" call, so [interrupt] releases the
/// device track and sets it up again. A rebuilt track is silent immediately,
/// which is what barge-in means.
class PcmVoicePlayer extends VoicePlayer {
  /// How much audio goes to the device at a time: a thirtieth of a second, so
  /// the level the footer draws is the level being heard.
  static const _feedFrames = 30;

  /// How long after a failed setup the next chunk tries again.
  static const retryAfter = Duration(seconds: 2);

  /// How much audio is held while the device is not set up: five seconds.
  static const _heldSeconds = 5;

  final ListQueue<Uint8List> _chunks = ListQueue<Uint8List>();
  int _offset = 0;
  int _available = 0;
  int? _carry;
  int _sampleRate = voiceAssistantOutputSampleRateV1;
  bool _configured = false;
  bool _settingUp = false;
  bool _idle = true;
  bool _closed = false;
  DateTime? _retryAt;
  double _level = 0;

  @override
  double get level => _level;

  int get _feedBytes => (_sampleRate ~/ _feedFrames) * 2;

  @override
  Future<void> configure(int sampleRate) async {
    if (_closed) return;
    if (_configured && sampleRate == _sampleRate) return;
    _sampleRate = sampleRate;
    await _setUpDevice();
  }

  Future<void> _setUpDevice() async {
    if (_settingUp) return;
    _settingUp = true;
    try {
      if (_configured) await FlutterPcmSound.release();
      FlutterPcmSound.setFeedCallback((_) => _pump());
      await FlutterPcmSound.setup(sampleRate: _sampleRate, channelCount: 1);
      await FlutterPcmSound.setFeedThreshold(_sampleRate ~/ _feedFrames);
      _configured = true;
      _retryAt = null;
      _idle = true;
    } on Object {
      // The call keeps going: the person still speaks and is still heard.
      // The next chunk after [retryAfter] tries the device again.
      _configured = false;
      _retryAt = DateTime.now().add(retryAfter);
    } finally {
      _settingUp = false;
    }
  }

  @override
  void write(Uint8List chunk) {
    if (_closed || chunk.isEmpty) return;
    var bytes = chunk;
    final carry = _carry;
    if (carry != null) {
      final joined = Uint8List(chunk.length + 1)
        ..[0] = carry
        ..setRange(1, chunk.length + 1, chunk);
      bytes = joined;
      _carry = null;
    }
    if (bytes.length.isOdd) {
      _carry = bytes[bytes.length - 1];
      bytes = Uint8List.sublistView(bytes, 0, bytes.length - 1);
    }
    if (bytes.isEmpty) return;
    _chunks.addLast(bytes);
    _available += bytes.length;
    if (!_configured) {
      _dropBeyondHeld();
      final retryAt = _retryAt;
      if (retryAt != null && DateTime.now().isBefore(retryAt)) return;
      unawaited(_setUpDevice().then((_) => _pump()));
      return;
    }
    if (_idle) _pump();
  }

  /// Without a device only the newest [_heldSeconds] of audio is kept.
  void _dropBeyondHeld() {
    final limit = _sampleRate * 2 * _heldSeconds;
    while (_available > limit && _chunks.isNotEmpty) {
      final head = _chunks.removeFirst();
      _available -= head.length - _offset;
      _offset = 0;
    }
  }

  void _pump() {
    if (_closed || !_configured) return;
    if (_available <= 0) {
      _idle = true;
      _setLevel(0);
      return;
    }
    _idle = false;
    final take = _take(math.min(_feedBytes, _available));
    _setLevel(pcm16Rms(take));
    try {
      unawaited(
        FlutterPcmSound.feed(PcmArrayInt16(bytes: ByteData.sublistView(take))),
      );
    } on Object {
      // This slice is lost; the next feed callback tries the next one.
    }
  }

  Uint8List _take(int wanted) {
    final out = Uint8List(wanted);
    var written = 0;
    while (written < wanted && _chunks.isNotEmpty) {
      final head = _chunks.first;
      final remaining = head.length - _offset;
      final step = math.min(remaining, wanted - written);
      out.setRange(written, written + step, head, _offset);
      written += step;
      _offset += step;
      if (_offset >= head.length) {
        _chunks.removeFirst();
        _offset = 0;
      }
    }
    _available -= written;
    return written == wanted ? out : Uint8List.sublistView(out, 0, written);
  }

  void _setLevel(double value) {
    if ((value - _level).abs() < 0.001) return;
    _level = value;
    notifyListeners();
  }

  @override
  Future<void> interrupt() async {
    _chunks.clear();
    _offset = 0;
    _available = 0;
    _carry = null;
    _setLevel(0);
    if (!_configured) return;
    await _setUpDevice();
  }

  @override
  Future<void> close() async {
    if (_closed) return;
    _closed = true;
    _chunks.clear();
    _offset = 0;
    _available = 0;
    _carry = null;
    _setLevel(0);
    if (_configured) {
      try {
        await FlutterPcmSound.release();
      } on Object {
        // Nothing is left to release.
      }
    }
    _configured = false;
  }
}
