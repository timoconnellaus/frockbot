/// PCM16 playback with receipts from the device, separate from waveform level.
library;

import 'dart:async';
import 'dart:collection';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'protocol.dart' show voiceAssistantOutputSampleRateV1;
import 'speech_gate.dart' show pcm16Rms;

abstract class VoicePlayer extends ChangeNotifier {
  Future<void> configure(int sampleRate);
  void write(Uint8List chunk);
  Future<void> interrupt();
  Future<void> close();
  double get level;

  /// Includes silent samples still queued on the device.
  bool get playing;

  /// Changes whenever audio is dropped, rejected or interrupted.
  int get lossCount;

  /// True only when the complete queue has played on the device.
  Future<bool> drain();
}

class PcmVoicePlayer extends VoicePlayer {
  static const _channel = MethodChannel('com.frockbot/pcm');
  static const retryAfter = Duration(seconds: 2);
  static const _feedFrames = 30;
  static const _heldSeconds = 5;

  /// Chunks fed but not yet reported played. A receipt follows the playback
  /// head, so everything inside the device's own buffer is still in flight;
  /// the window has to be wider than that buffer by a margin the network
  /// can be late by, or the speaker pads a sentence with silence. Fifteen
  /// chunks is half a second.
  static const _ahead = 15;

  final ListQueue<Uint8List> _chunks = ListQueue<Uint8List>();
  final Map<int, double> _sent = {};
  final List<Completer<bool>> _drains = [];
  int _offset = 0;
  int _available = 0;
  int? _carry;
  int _sampleRate = voiceAssistantOutputSampleRateV1;
  static int _nextEpoch = 0;
  int _epoch = ++_nextEpoch;
  int _sequence = 0;
  int _lossCount = 0;
  bool _configured = false;
  bool _closed = false;
  bool _rebuilding = false;

  /// The epoch the shared native speaker was last asked to own, so that a
  /// delayed release cannot tear down a newer owner's device.
  int? _deviceEpoch;
  Future<void>? _setup;
  DateTime? _retryAt;

  @override
  int get lossCount => _lossCount;
  @override
  bool get playing => _sent.isNotEmpty;
  @override
  double get level => _sent.isEmpty ? 0 : _sent.values.first;
  int get _feedBytes => (_sampleRate ~/ _feedFrames) * 2;

  @override
  Future<void> configure(int sampleRate) async {
    if (_configured && sampleRate == _sampleRate) return;
    if (_configured) {
      _sampleRate = sampleRate;
      await interrupt();
      return;
    }
    _closed = false;
    _sampleRate = sampleRate;
    await _setUpDevice();
    _pump();
  }

  Future<void> _setUpDevice() {
    final pending = _setup;
    if (pending != null) return pending;
    final epoch = _epoch;
    late final Future<void> operation;
    operation = () async {
      try {
        _channel.setMethodCallHandler(_onDevice);
        _deviceEpoch = epoch;
        await _channel.invokeMethod<void>('setup', {
          'sampleRate': _sampleRate,
          'epoch': epoch,
        });
        if (epoch != _epoch || _closed) return;
        _configured = true;
        _retryAt = null;
      } on Object {
        if (epoch != _epoch || _closed) return;
        _configured = false;
        _retryAt = DateTime.now().add(retryAfter);
        _invalidateDrains();
      } finally {
        if (identical(_setup, operation)) _setup = null;
      }
    }();
    _setup = operation;
    return operation;
  }

  Future<void> _onDevice(MethodCall call) async {
    final args = call.arguments;
    if (_closed || args is! Map || args['epoch'] != _epoch) return;
    if (call.method == 'failed') {
      _feedFailed(_epoch);
      return;
    }
    if (call.method != 'played' || !_sent.containsKey(args['sequence'])) return;
    _sent.remove(args['sequence']);
    _pump();
    _completeDrains();
    notifyListeners();
  }

  @override
  void write(Uint8List chunk) {
    if (_closed || chunk.isEmpty) return;
    var bytes = chunk;
    final carry = _carry;
    if (carry != null) {
      bytes = Uint8List(chunk.length + 1)
        ..[0] = carry
        ..setRange(1, chunk.length + 1, chunk);
      _carry = null;
    }
    if (bytes.length.isOdd) {
      _carry = bytes.last;
      bytes = Uint8List.sublistView(bytes, 0, bytes.length - 1);
    }
    if (bytes.isEmpty) return;
    _chunks.addLast(bytes);
    _available += bytes.length;
    if (!_configured) {
      final limit = _sampleRate * 2 * _heldSeconds;
      while (_available > limit && _chunks.isNotEmpty) {
        _available -= _chunks.removeFirst().length - _offset;
        _offset = 0;
        _invalidateDrains();
      }
      if (_rebuilding ||
          (_retryAt != null && DateTime.now().isBefore(_retryAt!))) {
        return;
      }
      unawaited(_setUpDevice().then((_) => _pump()));
      return;
    }
    _pump();
  }

  void _pump() {
    if (_closed || !_configured) return;
    while (_available > 0 && _sent.length < _ahead) {
      final bytes = _take(math.min(_feedBytes, _available));
      final sequence = ++_sequence;
      final epoch = _epoch;
      _sent[sequence] = pcm16Rms(bytes);
      unawaited(
        _channel
            .invokeMethod<void>('feed', {
              'buffer': bytes,
              'epoch': epoch,
              'sequence': sequence,
            })
            .catchError((Object _) => _feedFailed(epoch)),
      );
    }
    notifyListeners();
  }

  void _feedFailed(int epoch) {
    if (_closed || epoch != _epoch) return;
    _epoch = ++_nextEpoch;
    _sent.clear();
    _configured = false;
    _rebuilding = false;
    _deviceEpoch = null;
    _retryAt = null;
    _invalidateDrains();
    notifyListeners();
  }

  Uint8List _take(int wanted) {
    final out = Uint8List(wanted);
    var written = 0;
    while (written < wanted && _chunks.isNotEmpty) {
      final head = _chunks.first;
      final step = math.min(head.length - _offset, wanted - written);
      out.setRange(written, written + step, head, _offset);
      written += step;
      _offset += step;
      if (_offset == head.length) {
        _chunks.removeFirst();
        _offset = 0;
      }
    }
    _available -= written;
    return out;
  }

  @override
  Future<bool> drain() {
    if (_closed || !_configured || _carry != null) return Future.value(false);
    if (_available == 0 && _sent.isEmpty) return Future.value(true);
    final done = Completer<bool>();
    _drains.add(done);
    return done.future;
  }

  void _completeDrains() {
    if (_available != 0 || _sent.isNotEmpty || _carry != null) return;
    for (final done in _drains) {
      done.complete(true);
    }
    _drains.clear();
  }

  void _invalidateDrains() {
    _lossCount++;
    for (final done in _drains) {
      done.complete(false);
    }
    _drains.clear();
  }

  void _discard() {
    _epoch = ++_nextEpoch;
    _configured = false;
    _chunks.clear();
    _sent.clear();
    _offset = _available = 0;
    _carry = null;
    _invalidateDrains();
    notifyListeners();
  }

  @override
  Future<void> interrupt() async {
    _rebuilding = true;
    _discard();
    final epoch = _epoch;
    await _setup;
    if (epoch != _epoch) return;
    await _releaseDevice();
    if (epoch != _epoch) return;
    if (!_closed) await _setUpDevice();
    if (epoch != _epoch) return;
    _rebuilding = false;
    _pump();
  }

  @override
  Future<void> close() async {
    if (_closed) return;
    _closed = true;
    _discard();
    await _setup;
    await _releaseDevice();
  }

  /// Releases only the device this player set up. A close or interrupt that
  /// resumes after another player has configured names an epoch the host no
  /// longer owns, so it leaves the newer speaker alone.
  Future<void> _releaseDevice() async {
    final owner = _deviceEpoch;
    if (owner == null) return;
    _deviceEpoch = null;
    try {
      await _channel.invokeMethod<void>('release', {'epoch': owner});
    } on Object {
      /* Already unavailable. */
    }
  }
}
