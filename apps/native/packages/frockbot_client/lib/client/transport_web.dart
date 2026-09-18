import 'package:http/browser_client.dart';
import 'package:web/web.dart' as web;
import 'package:http/http.dart' as http;
import 'package:web_socket_channel/web_socket_channel.dart';

/// `withCredentials` is what carries the better-auth cookie; without it the
/// browser sends an anonymous request and the gateway answers 401.
http.Client httpClientV1() => BrowserClient()..withCredentials = true;

/// A browser cannot set headers on a WebSocket handshake. It does not need to:
/// the cookie authenticates the upgrade the same way it authenticates a
/// request, so [headers] is unused here.
Future<WebSocketChannel> connectSocketV1(
  Uri uri,
  Map<String, String> headers,
) async {
  final channel = WebSocketChannel.connect(uri);
  await channel.ready;
  return channel;
}

/// The browser is served by the gateway it talks to, whatever host that is.
String defaultOriginV1() => web.window.location.origin;
