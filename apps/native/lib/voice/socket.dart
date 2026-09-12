/// The two voice sockets, opened exactly the way the state channel is.
///
/// Both routes are authenticated like `/api/bots/:id/state-channel`: the
/// native app's bearer header on the upgrade request, which is what
/// `connectSocketV1` carries on the IO platforms and what the browser's
/// cookie does instead. There is no second credential path and no query
/// token — a URL is not a place to put a bearer.
///
/// [VoiceSocket] is an interface so both controllers can be driven by a test
/// with no network at all.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:web_socket_channel/web_socket_channel.dart';

import '../client/transport.dart';
import '../client/transport_io.dart'
    if (dart.library.js_interop) '../client/transport_web.dart';

abstract interface class VoiceSocket {
  /// Text frames arrive as [String], audio as [List<int>].
  Stream<Object?> get messages;
  void sendText(String text);
  void sendBinary(Uint8List bytes);

  /// Closes with a code and a reason the server logs: the one record, from
  /// the server's side, of which path on this device ended the socket.
  Future<void> close({int code = voiceCloseNormalV1, String reason = ''});
}

/// The person, or the app, ended the call on purpose.
const voiceCloseNormalV1 = 1000;

/// The controller failed on its own and closed; the reason is its message.
const voiceCloseFailedV1 = 4001;

/// The controller was disposed while the socket was still open.
const voiceCloseDisposedV1 = 4002;

/// The call ended while the socket was still connecting, so the socket that
/// arrived belongs to nothing.
const voiceCloseAbandonedV1 = 4003;

/// A close reason may be at most 123 bytes on the wire.
String voiceCloseReasonV1(String reason) {
  const limit = 120;
  final bytes = utf8.encode(reason);
  if (bytes.length <= limit) return reason;
  var end = limit;
  while (end > 0 && (bytes[end] & 0xc0) == 0x80) {
    end--;
  }
  return utf8.decode(bytes.sublist(0, end));
}

typedef VoiceSocketOpener = Future<VoiceSocket> Function();

class ChannelVoiceSocket implements VoiceSocket {
  final WebSocketChannel channel;
  ChannelVoiceSocket(this.channel);

  @override
  Stream<Object?> get messages => channel.stream;

  @override
  void sendText(String text) => channel.sink.add(text);

  @override
  void sendBinary(Uint8List bytes) => channel.sink.add(bytes);

  @override
  Future<void> close({
    int code = voiceCloseNormalV1,
    String reason = '',
  }) async {
    try {
      await channel.sink.close(code, voiceCloseReasonV1(reason));
    } on Object {
      // A socket the network already closed needs no goodbye.
    }
  }
}

/// Opens one voice route with the app's own credentials.
Future<VoiceSocket> openVoiceSocketV1(
  NativeApi api,
  String path, {
  Map<String, String> query = const {},
  Duration timeout = const Duration(seconds: 10),
}) async {
  final origin = Uri.parse(hostedOrigin);
  final uri = origin.replace(
    // Plain HTTP only ever names the local stack.
    scheme: origin.scheme == 'http' ? 'ws' : 'wss',
    path: path,
    queryParameters: query.isEmpty ? null : query,
  );
  final channel = await connectSocketV1(
    uri,
    await api.headers(),
  ).timeout(timeout);
  return ChannelVoiceSocket(channel);
}

VoiceSocketOpener dictationSocketOpenerV1(NativeApi api) =>
    () => openVoiceSocketV1(api, '/api/voice/dictation');

VoiceSocketOpener assistantSocketOpenerV1(NativeApi api) =>
    () =>
        openVoiceSocketV1(api, '/api/voice/assistant', query: {'version': '1'});
