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
