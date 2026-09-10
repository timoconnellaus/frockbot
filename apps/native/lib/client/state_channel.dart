import 'dart:async';
import 'dart:convert';

import 'package:web_socket_channel/web_socket_channel.dart';

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
  WebSocketChannel? _socket;
  Timer? _retry;
  Timer? _deadline;
  int _epoch = 0;
  int _attempt = 0;
  bool _paused = false;
  bool _disposed = false;
  bool _dirty = false;
  bool _flushing = false;
  bool _hasSynchronized = false;
  bool _offline = false;
  ConnectionState? _reported;
  String? _cursor;
  BotStateChannel({
    required this.api,
    required this.store,
    required this.key,
    required this.botId,
    required this.invalidate,
    required this.status,
  });
  Future<void> connect() => _connect(reportProgress: true);

  Future<void> _connect({required bool reportProgress}) async {
    if (_disposed || _paused) return;
    final epoch = ++_epoch;
    _retry?.cancel();
    _deadline?.cancel();
    final old = _socket;
    _socket = null;
    if (reportProgress) {
      _report(
        _offline
            ? ConnectionState.disconnected
            : !_hasSynchronized && _attempt == 0
            ? ConnectionState.initializing
            : ConnectionState.reconnecting,
      );
    }
    await old?.sink.close();
    if (epoch != _epoch || _disposed || _paused) return;
    _dirty = false;
    try {
      final saved = await store.read(key);
      _cursor = wire.isProtocolValue('ObserverCursor', saved) ? saved : null;
      final socket = await api.socket(botId, _cursor);
      if (epoch != _epoch || _disposed || _paused) {
        await socket.sink.close();
        return;
      }
      _socket = socket;
      _deadline = Timer(const Duration(seconds: 5), () => _failed(epoch));
      Future<void> queue = Future.value();
      socket.stream.listen(
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
                  _hasSynchronized = true;
                  _offline = false;
                  _report(ConnectionState.connected);
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

  /// The status a listener already holds is not worth repeating: an offline
  /// banner that survives a retry must not be torn down and rebuilt for a
  /// state it never left.
  void _report(ConnectionState state) {
    if (_reported == state) return;
    _reported = state;
    status(state);
  }

  void _failed(int epoch) {
    if (epoch != _epoch || _disposed) return;
    ++_epoch;
    _deadline?.cancel();
    final socket = _socket;
    _socket = null;
    unawaited(socket?.sink.close());
    if (!_paused) _offline = true;
    _report(_paused ? ConnectionState.paused : ConnectionState.disconnected);
    if (!_paused) {
      final seconds = (1 << _attempt.clamp(0, 5)).clamp(1, 30);
      _attempt++;
      // Keep the actionable offline state stable while an automatic attempt
      // runs. A successful ready frame clears it; another failure leaves it in
      // place instead of making the banner flicker on every backoff cycle.
      _retry = Timer(
        Duration(seconds: seconds),
        () => unawaited(_connect(reportProgress: false)),
      );
    }
  }

  void pause() {
    _paused = true;
    _retry?.cancel();
    _failed(_epoch);
  }

  /// Only a channel the app actually stopped has anything to resume. The
  /// lifecycle reports `inactive` for a notification banner or the app
  /// switcher and reports it again on the way back, so a live socket would
  /// otherwise be torn down and rebuilt for a trip the person never took.
  void resume() {
    if (!_paused) return;
    _paused = false;
    unawaited(connect());
  }

  void dispose() {
    _disposed = true;
    ++_epoch;
    _retry?.cancel();
    _deadline?.cancel();
    unawaited(_socket?.sink.close());
  }
}
