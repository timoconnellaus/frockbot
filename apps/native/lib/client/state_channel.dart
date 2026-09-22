import 'dart:async';
import 'dart:convert';

import 'package:web_socket_channel/web_socket_channel.dart';

import '../protocol/client_wire.generated.dart' as wire;
import 'chat_controller.dart';
import 'transport.dart';

class _AssemblingPart {
  _AssemblingPart({
    required this.epoch,
    required this.cursor,
    required this.eventId,
    required this.parts,
  });
  final String epoch;
  final String cursor;
  final String eventId;
  final int parts;
  final chunks = <int, String>{};
}

class BotStateChannel {
  final NativeApi api;
  final LocalStore store;
  final String key;
  final String botId;
  final Future<void> Function(Map<String, dynamic> frame) apply;
  final ({String? epoch, String? cursor}) Function() resumeFrom;
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
  String? _publicationEpoch;
  final _pending = <Map<String, dynamic>>[];
  _AssemblingPart? _part;
  BotStateChannel({
    required this.api,
    required this.store,
    required this.key,
    required this.botId,
    required this.apply,
    required this.resumeFrom,
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
    _pending.clear();
    _part = null;
    try {
      final saved = resumeFrom();
      _cursor = wire.isProtocolValue('ObserverCursor', saved.cursor)
          ? saved.cursor
          : null;
      _publicationEpoch = wire.isProtocolValue('ObserverCursor', saved.epoch)
          ? saved.epoch
          : null;
      final socket = await api.socket(
        botId,
        cursor: _cursor,
        epoch: _publicationEpoch,
      );
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
                if (value is! String ||
                    utf8.encode(value).length > wire.stateFrameMaxBytes) {
                  throw const FormatException('Invalid state frame');
                }
                final frame =
                    wire.StateFrame.fromJson(
                          decodeBoundedJson(
                            value,
                            maxBytes: wire.stateFrameMaxBytes,
                          ),
                        ).toJson()
                        as Map<String, dynamic>;
                await _accept(frame);
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

  Future<void> _accept(Map<String, dynamic> frame) async {
    final type = frame['type'] as String;
    final cursor = frame['cursor'] as String;
    final epoch = frame['epoch'] as String?;
    if (type == 'state/part') {
      final assembled = _assemble(frame);
      if (assembled == null) return;
      await _accept(assembled);
      return;
    }
    if (type == 'state/ready') {
      if (epoch != _publicationEpoch || cursor != _cursor) {
        throw const FormatException('Discontinuous ready');
      }
      _deadline?.cancel();
      _attempt = 0;
      _hasSynchronized = true;
      _offline = false;
      _report(ConnectionState.connected);
      return;
    }
    if (type == 'state/snapshot') {
      _publicationEpoch = epoch;
      _cursor = cursor;
      _part = null;
      _pending.add(frame);
      _dirty = true;
      _flush();
      return;
    }
    if (type != 'state/update') {
      throw const FormatException('Invalid state frame');
    }
    if (epoch != _publicationEpoch) {
      throw const FormatException('Epoch mismatch');
    }
    if (_cursor == null || int.parse(cursor) != int.parse(_cursor!) + 1) {
      throw const FormatException('Discontinuous event');
    }
    _cursor = cursor;
    _pending.add(frame);
    _dirty = true;
    _flush();
  }

  Map<String, dynamic>? _assemble(Map<String, dynamic> frame) {
    final eventId = frame['eventId'] as String;
    final part = frame['part'] as int;
    final parts = frame['parts'] as int;
    final data = frame['data'] as String;
    final epoch = frame['epoch'] as String;
    final cursor = frame['cursor'] as String;
    final current = _part;
    if (current == null ||
        current.eventId != eventId ||
        current.epoch != epoch ||
        current.cursor != cursor ||
        current.parts != parts ||
        current.chunks.containsKey(part)) {
      if (part != 0) {
        throw const FormatException('Inconsistent state part');
      }
      _part = _AssemblingPart(
        epoch: epoch,
        cursor: cursor,
        eventId: eventId,
        parts: parts,
      );
    }
    final assembling = _part!;
    assembling.chunks[part] = data;
    if (assembling.chunks.length != assembling.parts) return null;
    final buffer = StringBuffer();
    for (var index = 0; index < assembling.parts; index += 1) {
      final chunk = assembling.chunks[index];
      if (chunk == null) throw const FormatException('Missing state part');
      buffer.write(chunk);
    }
    _part = null;
    final assembled = buffer.toString();
    if (utf8.encode(assembled).length > wire.stateAssembledMaxBytes) {
      throw const FormatException('Assembled state frame too large');
    }
    return wire.StateFrame.fromJson(
          decodeBoundedJson(assembled, maxBytes: wire.stateAssembledMaxBytes),
        ).toJson()
        as Map<String, dynamic>;
  }

  /// One apply covers every frame that arrived while the previous one ran.
  /// An apply that fails tears the socket down like any other frame error;
  /// the reconnect replays from the last persisted cursor.
  void _flush() {
    if (_flushing) return;
    _flushing = true;
    unawaited(() async {
      try {
        while (_dirty && !_disposed) {
          _dirty = false;
          final epoch = _epoch;
          final batch = [..._pending];
          _pending.clear();
          try {
            for (final frame in batch) {
              await apply(frame);
            }
            if (epoch != _epoch) continue;
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
    _part = null;
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
