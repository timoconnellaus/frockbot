import 'dart:io';

import 'package:http/http.dart' as http;
import 'package:http/io_client.dart';
import 'package:web_socket_channel/io.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

http.Client httpClientV1() =>
    IOClient(HttpClient()..connectionTimeout = const Duration(seconds: 10));

/// The phone authenticates the handshake with the same bearer header its
/// requests carry.
Future<WebSocketChannel> connectSocketV1(
  Uri uri,
  Map<String, String> headers,
) async {
  final channel = IOWebSocketChannel.connect(uri, headers: headers);
  await channel.ready;
  return channel;
}

/// The phone has no origin of its own, so the build must name the deployment it
/// talks to. No deployment is spelled here: every release passes
/// `--dart-define=FROCKBOT_ORIGIN=…`, and a build that forgot would otherwise
/// ship pointed at somebody else's server.
String defaultOriginV1() => throw StateError(
  'This build names no deployment. Pass --dart-define=FROCKBOT_ORIGIN=<origin>.',
);
