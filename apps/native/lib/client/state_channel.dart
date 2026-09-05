import 'dart:async';
import 'dart:convert';
import 'dart:io';

import '../protocol/client_wire.generated.dart' as wire;
import 'chat_controller.dart';
import 'transport.dart';

class BotStateChannel {
  final NativeApi api;
  final LocalStore store;
  final String key;
  final String botId;
  final Future<void> Function() invalidate;
  final void Function(ConnectionState) status;
  WebSocket? _socket;
  Timer? _retry;
  Timer? _deadline;
  int _epoch = 0;
  int _attempt = 0;
  bool _paused = false;
  bool _disposed = false;
  bool _dirty = false;
  bool _flushing = false;
  String? _cursor;
  BotStateChannel({
    required this.api,
    required this.store,
    required this.key,
    required this.botId,
    required this.invalidate,
    required this.status,
  });
  Future<void> connect() async {
    if (_disposed || _paused) return;
    final epoch = ++_epoch;
    _retry?.cancel();
    _deadline?.cancel();
    final old = _socket;
    _socket = null;
    await old?.close();
    status(ConnectionState.connecting);
    _dirty = false;
    try {
      final saved = await store.read(key);
      _cursor = wire.isProtocolValue('ObserverCursor', saved) ? saved : null;
      final socket = await api.socket(botId, _cursor);
      if (epoch != _epoch || _disposed || _paused) {
        await socket.close();
        return;
      }
      _socket = socket;
      _deadline = Timer(const Duration(seconds: 5), () => _failed(epoch));
      Future<void> queue = Future.value();
      socket.listen(
        (dynamic value) {
          queue = queue
              .then((_) async {
                if (epoch != _epoch) return;
                if (value is! String || utf8.encode(value).length > 4096) {
                  throw const FormatException('Invalid state frame');
                }
                final frame =
                    wire.StateFrame.fromJson(
                          decodeBoundedJson(value, maxBytes: 4096),
                        ).toJson()
                        as Map<String, dynamic>;
                final cursor = frame['cursor'] as String;
                if (frame['type'] == 'state/ready') {
                  if (cursor != _cursor) {
                    throw const FormatException('Discontinuous ready');
                  }
                  _deadline?.cancel();
                  _attempt = 0;
                  status(ConnectionState.connected);
                  return;
                }
                if (frame['type'] == 'state/event' &&
                    (_cursor == null ||
                        int.parse(cursor) != int.parse(_cursor!) + 1)) {
                  throw const FormatException('Discontinuous event');
                }
                // The cursor moves at once so the next frame checks out. It is
                // persisted only after one refresh has applied everything up
                // to it: a replayed backlog costs one fetch, not one per event,
                // so `state/ready` is processed well inside its deadline.
                _cursor = cursor;
                _dirty = true;
                _flush();
              })
              .catchError((Object _) {
                _failed(epoch);
              });
        },
        onError: (Object _) => _failed(epoch),
        onDone: () => _failed(epoch),
      );
    } catch (_) {
      _failed(epoch);
    }
  }

  /// One refresh covers every frame that arrived while the previous one ran.
  /// A refresh that fails tears the socket down like any other frame error;
  /// the reconnect replays from the last persisted cursor.
  void _flush() {
    if (_flushing) return;
    _flushing = true;
    unawaited(() async {
      try {
        while (_dirty && !_disposed) {
          _dirty = false;
          final epoch = _epoch;
          final target = _cursor;
          try {
            await invalidate();
            if (epoch != _epoch || target == null) continue;
            await store.write(key, target);
          } catch (_) {
            _failed(epoch);
            return;
          }
        }
      } finally {
        _flushing = false;
      }
    }());
  }

  void _failed(int epoch) {
    if (epoch != _epoch || _disposed) return;
    ++_epoch;
    _deadline?.cancel();
    final socket = _socket;
    _socket = null;
    unawaited(socket?.close());
    status(_paused ? ConnectionState.paused : ConnectionState.disconnected);
    if (!_paused) {
      final seconds = (1 << _attempt.clamp(0, 5)).clamp(1, 30);
      _attempt++;
      _retry = Timer(Duration(seconds: seconds), connect);
    }
  }

  void pause() {
    _paused = true;
    _retry?.cancel();
    _failed(_epoch);
  }

  void resume() {
    _paused = false;
    unawaited(connect());
  }

  void dispose() {
    _disposed = true;
    ++_epoch;
    _retry?.cancel();
    _deadline?.cancel();
    unawaited(_socket?.close());
  }
}
