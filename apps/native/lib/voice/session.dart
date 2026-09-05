import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import '../client/transport.dart';
import 'protocol.dart';

/// One live connection to the User's VoiceSession Durable Object.
///
/// The socket is the whole session: there is no separate "turn off" call. A
/// [stop] ends the provider session durably; a bare [close] would only detach
/// this device, which is not what Pause means here.
abstract interface class VoiceSession {
  /// Decoded text frames. Frames that fail to decode are dropped, never
  /// surfaced, so a future server field cannot break this screen.
  Stream<VoiceServerFrame> get frames;

  /// PCM16LE mono at [voiceOutputSampleRate], as it arrived.
  Stream<Uint8List> get audio;

  /// Queues one PCM16LE frame. Audio produced before `ready` is held, in
  /// order, so the first thing said is not the thing that gets lost.
  void sendAudio(Uint8List pcm16);

  /// Ends the provider session outright.
  Future<void> stop();

  /// Drops this device without ending the session.
  Future<void> close();
}

/// Opens sessions and reads what is waiting. Faked in tests.
abstract interface class VoiceBackend {
  Future<VoiceSession> open(String deviceId);

  /// Answers waiting to be spoken, oldest first.
  Future<List<VoicePendingAnswer>> pendingAnswers();
}

/// About ten seconds at 16 kHz; a stalled server cannot grow this list.
const int _maxQueuedFrames = 320;

class SocketVoiceSession implements VoiceSession {
  final WebSocket _socket;
  final _frames = StreamController<VoiceServerFrame>.broadcast();
  final _audio = StreamController<Uint8List>.broadcast();
  final List<Uint8List> _queued = [];
  bool _ready = false;
  bool _finished = false;

  SocketVoiceSession(this._socket) {
    _socket.listen(
      _receive,
      onDone: () {
        _finished = true;
        unawaited(_frames.close());
        unawaited(_audio.close());
      },
      onError: (Object _) {
        _finished = true;
        if (!_frames.isClosed) {
          _frames.add(
            const VoiceOffline(
              VoiceOfflineReason.error,
              'Voice lost its connection. Try again.',
            ),
          );
        }
      },
      cancelOnError: false,
    );
  }

  void _receive(Object? data) {
    if (data is List<int>) {
      if (!_audio.isClosed) _audio.add(Uint8List.fromList(data));
      return;
    }
    if (data is! String) return;
    VoiceServerFrame frame;
    try {
      frame = decodeVoiceServerFrame(decodeBoundedJson(data, maxBytes: 32768));
    } catch (_) {
      return;
    }
    if (frame is VoiceReady) {
      _ready = true;
      for (final pending in _queued) {
        _send(pending);
      }
      _queued.clear();
    }
    if (!_frames.isClosed) _frames.add(frame);
  }

  void _send(Uint8List pcm16) {
    if (_socket.readyState != WebSocket.open) return;
    try {
      _socket.add(pcm16);
    } catch (_) {
      // A socket that refuses a frame is already closing; the close event is
      // the one that changes what the screen says.
    }
  }

  @override
  Stream<VoiceServerFrame> get frames => _frames.stream;
  @override
  Stream<Uint8List> get audio => _audio.stream;

  @override
  void sendAudio(Uint8List pcm16) {
    if (_finished) return;
    if (!_ready) {
      if (_queued.length < _maxQueuedFrames) _queued.add(pcm16);
      return;
    }
    _send(pcm16);
  }

  @override
  Future<void> stop() async {
    if (_socket.readyState == WebSocket.open) {
      try {
        _socket.add(jsonEncode(voiceStopFrame));
      } catch (_) {
        // Already closing; the session ends either way.
      }
    }
    await close();
  }

  @override
  Future<void> close() async {
    _finished = true;
    try {
      await _socket.close(WebSocketStatus.normalClosure, 'Voice closed');
    } catch (_) {
      // Closing an already closed socket is a no-op from the caller's view.
    }
  }
}

/// The hosted backend: the same route, headers, and framing as the web client.
class BackendVoice implements VoiceBackend {
  final NativeApi api;
  const BackendVoice(this.api);

  @override
  Future<VoiceSession> open(String deviceId) async {
    final uri = Uri.parse(hostedOrigin).replace(
      scheme: 'wss',
      path: '/api/voice/assistant',
      queryParameters: {
        'version': '$voiceAssistantVersion',
        'device': deviceId,
      },
    );
    final socket = await WebSocket.connect(
      uri.toString(),
      headers: await api.headers(),
    ).timeout(const Duration(seconds: 10));
    return SocketVoiceSession(socket);
  }

  @override
  Future<List<VoicePendingAnswer>> pendingAnswers() async =>
      decodeVoicePendingAnswers(await api.request('/api/voice'));
}

/// A device id the Durable Object will accept: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`.
///
/// It is remembered so "newest device wins" does not treat one phone as two.
Future<String> voiceDeviceId(LocalStore store) async {
  const key = 'voice.device';
  final saved = await store.read(key);
  if (saved != null &&
      RegExp(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$').hasMatch(saved)) {
    return saved;
  }
  final random = Random.secure();
  final created =
      'n${List.generate(24, (_) => random.nextInt(16).toRadixString(16)).join()}';
  await store.write(key, created);
  return created;
}
