import 'dart:async';
import 'dart:convert';

import 'package:web_socket_channel/web_socket_channel.dart';

import '../client/chat_controller.dart' show ConnectionState;
import '../client/transport.dart';
import 'model.dart';

/// Bounded well above a frame's size; a frame names only positions and ids.
const groupStateFrameMaxBytes = 4096;

/// A Group Chat's live channel. The group says where its thread is and who is
/// working on every change, and nothing more; the client reads the thread
/// over HTTP when the head moves. A lost socket reconnects with backoff, and
/// the frame that opens the new one carries the whole state again, so there
/// is no cursor to resume from.
class GroupStateChannel {
  final NativeApi api;
  final String groupId;
  final void Function(GroupState state) apply;
  final void Function(ConnectionState state) status;
  WebSocketChannel? _socket;
  Timer? _retry;
  Timer? _deadline;
  int _epoch = 0;
  int _attempt = 0;
  bool _paused = false;
  bool _disposed = false;
  ConnectionState? _reported;

  GroupStateChannel({
    required this.api,
    required this.groupId,
    required this.apply,
    required this.status,
  });

  Future<void> connect() async {
    if (_disposed || _paused) return;
    final epoch = ++_epoch;
    _retry?.cancel();
    _deadline?.cancel();
    final old = _socket;
    _socket = null;
    _report(
      _attempt == 0
          ? ConnectionState.initializing
          : ConnectionState.reconnecting,
    );
    await old?.sink.close();
    if (epoch != _epoch || _disposed || _paused) return;
    try {
      final socket = await api.groupSocket(groupId);
      if (epoch != _epoch || _disposed || _paused) {
        await socket.sink.close();
        return;
      }
      _socket = socket;
      // The group sends its state as soon as it accepts the socket.
      _deadline = Timer(const Duration(seconds: 5), () => _failed(epoch));
      socket.stream.listen(
        (dynamic value) {
          if (epoch != _epoch) return;
          try {
            if (value is! String ||
                utf8.encode(value).length > groupStateFrameMaxBytes) {
              throw const FormatException('Invalid group frame');
            }
            final state = GroupState.fromJson(
              decodeBoundedJson(value, maxBytes: groupStateFrameMaxBytes),
            );
            _deadline?.cancel();
            _attempt = 0;
            _report(ConnectionState.connected);
            apply(state);
          } catch (_) {
            _failed(epoch);
          }
        },
        onError: (Object _) => _failed(epoch),
        onDone: () => _failed(epoch),
      );
    } catch (_) {
      _failed(epoch);
    }
  }

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
    _report(_paused ? ConnectionState.paused : ConnectionState.disconnected);
    if (_paused) return;
    final seconds = (1 << _attempt.clamp(0, 5)).clamp(1, 30);
    _attempt++;
    _retry = Timer(Duration(seconds: seconds), () => unawaited(connect()));
  }

  void pause() {
    _paused = true;
    _retry?.cancel();
    _failed(_epoch);
  }

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
