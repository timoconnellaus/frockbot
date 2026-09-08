import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:http/http.dart' as http;
import 'package:web_socket_channel/web_socket_channel.dart';

import '../protocol/client_wire.generated.dart' as wire;
import 'credential.dart';
import 'store.dart';
import 'transport_io.dart' if (dart.library.js_interop) 'transport_web.dart';

export 'store.dart';

/// The gateway this build talks to.
///
/// A development build is pointed at the local stack: the wireless Android dev
/// app carries `--dart-define=FROCKBOT_LOCAL_DEV=true` and talks to the host's
/// loopback, and `bun run dev:native` passes `--dart-define=FROCKBOT_ORIGIN=…`
/// directly. Left unset, the phone talks to production and the browser talks
/// to the origin it was served from — which is the deployed shape, and the
/// only one that works for a stack on an unknown port.
const localDevelopment = bool.fromEnvironment('FROCKBOT_LOCAL_DEV');
final String hostedOrigin = localDevelopment
    ? 'http://127.0.0.1:8787'
    : const String.fromEnvironment('FROCKBOT_ORIGIN').ifEmpty(defaultOriginV1);

extension on String {
  String ifEmpty(String Function() fallback) => isEmpty ? fallback() : this;
}

const clientHello = <String, Object>{
  'schemaVersion': 1,
  'protocolVersion': 1,
  'nativeVersion': '1.1.0',
  'catalogs': <Object>[],
};
String randomId() {
  final bytes = List<int>.generate(24, (_) => Random.secure().nextInt(256));
  return 'n${base64Url.encode(bytes).replaceAll('=', '')}';
}

/// Bound nesting before the platform JSON parser or generated schema recursion.
Object? decodeBoundedJson(String text, {int maxBytes = 512000}) {
  if (utf8.encode(text).length > maxBytes) {
    throw const FormatException('JSON byte limit');
  }
  var depth = 0;
  var quoted = false;
  var escaped = false;
  for (final unit in text.codeUnits) {
    if (quoted) {
      if (escaped) {
        escaped = false;
      } else if (unit == 92) {
        escaped = true;
      } else if (unit == 34) {
        quoted = false;
      }
    } else if (unit == 34) {
      quoted = true;
    } else if (unit == 123 || unit == 91) {
      if (++depth > 16) throw const FormatException('JSON depth limit');
    } else if (unit == 125 || unit == 93) {
      if (--depth < 0) throw const FormatException('Invalid JSON');
    }
  }
  return jsonDecode(text);
}

class RequestFailure implements Exception {
  final int? status;
  final String message;
  const RequestFailure(this.message, [this.status]);
  bool get refused => status != null && status! >= 400 && status! < 500;
  @override
  String toString() => message;
}

class NativeApi {
  final LocalStore store;
  final AuthCredential credential;
  final http.Client _client = httpClientV1();
  NativeApi(this.store, {AuthCredential? credential})
    : credential = credential ?? authCredentialV1(store);

  /// Learn of a session sign-in, sign-out or restore just established, so the
  /// next request does not wait on the platform keystore.
  void adoptSession(String? session) => credential.adopt(session);

  Future<Map<String, String>> headers() async {
    final authorization = await credential.authorization();
    return {
      'content-type': 'application/json',
      'x-frockbot-client': jsonEncode(clientHello),
      if (localDevelopment) 'x-frockbot-user-id': 'development',
      'authorization': ?authorization,
    };
  }

  Future<Object?> request(
    String path, {
    Object? body,
    int limit = 512000,
    bool authenticated = true,
  }) async {
    if (!path.startsWith('/') ||
        path.startsWith('//') ||
        path.contains(r'\') ||
        path.contains('#')) {
      throw const FormatException('Invalid path');
    }
    try {
      final request = http.Request(
        body == null ? 'GET' : 'POST',
        Uri.parse('$hostedOrigin$path'),
      )..followRedirects = false;
      request.headers.addAll(
        authenticated
            ? await headers()
            : {
                'content-type': 'application/json',
                'x-frockbot-client': jsonEncode(clientHello),
              },
      );
      if (body != null) request.bodyBytes = utf8.encode(jsonEncode(body));
      final response = await _client
          .send(request)
          .timeout(const Duration(seconds: 30));
      final bytes = <int>[];
      await for (final chunk in response.stream.timeout(
        const Duration(seconds: 30),
      )) {
        if (bytes.length + chunk.length > limit) {
          throw const RequestFailure('That reply is too large to show.');
        }
        bytes.addAll(chunk);
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        final message = switch (response.statusCode) {
          401 =>
            path.startsWith('/api/auth/native/')
                ? 'That sign-in couldn’t be completed. Open sign-in again to continue.'
                : 'Please sign in again.',
          400 when path.startsWith('/api/auth/native/') => 'That sign-in has expired or is unavailable on this device. Please sign in again.',
          503 when path.startsWith('/api/auth/native/') => 'Native sign-in is temporarily unavailable. Please try again in a few minutes.',
          426 => 'Update the app to continue using FrockBot.',
          // The send route refuses an over-long message with the limit in
          // it, in the product's own words. A client that restated that
          // sentence would carry a number the route is free to change, so
          // what the reader is shown is the answer's own reason where the
          // answer gave one.
          413 =>
            _refusalReason(bytes) ??
                'That message is too long. Please shorten it.',
          409 => 'That action could not be completed. Refresh and try again.',
          _ => 'FrockBot couldn’t complete that request. Please try again.',
        };
        throw RequestFailure(message, response.statusCode);
      }
      return decodeBoundedJson(utf8.decode(bytes), maxBytes: limit);
    } on RequestFailure {
      rethrow;
    } on FormatException {
      throw const RequestFailure('Couldn’t read that reply. Please reconnect.');
    } on Exception {
      throw const RequestFailure(
        'Couldn’t reach FrockBot. Check your connection and try again.',
      );
    }
  }

  /// The sentence a refusal carried, where it carried one written for the
  /// person. A body that is not JSON, or carries no `error`, or carries
  /// something longer than a sentence, is not one.
  static String? _refusalReason(List<int> bytes) {
    try {
      final body = jsonDecode(utf8.decode(bytes));
      if (body is Map && body['error'] is String) {
        final reason = body['error'] as String;
        if (reason.isNotEmpty && reason.length <= 200) return reason;
      }
    } catch (_) {
      // A refusal whose body cannot be read still has the client's own line.
    }
    return null;
  }

  Future<WebSocketChannel> socket(String botId, String? cursor) async {
    final origin = Uri.parse(hostedOrigin);
    final uri = origin.replace(
      // Plain HTTP only ever names the local stack.
      scheme: origin.scheme == 'http' ? 'ws' : 'wss',
      path: '/api/bots/$botId/state-channel',
      queryParameters: {'version': '1', 'cursor': ?cursor},
    );
    return connectSocketV1(
      uri,
      await headers(),
    ).timeout(const Duration(seconds: 5));
  }

  void close() => _client.close();
}

abstract interface class ChatTransport {
  Future<Map<String, dynamic>> page(String botId, {String? before});
  Future<void> send(String botId, String id, String text);
  Future<Map<String, dynamic>?> lookup(
    String botId,
    String id, {
    bool fence = false,
  });
  Future<Map<String, dynamic>> stop(String botId, String id, String commandId);
}

class BackendChatTransport implements ChatTransport {
  final NativeApi api;
  BackendChatTransport(this.api);
  String path(String bot) => '/api/bots/${Uri.encodeComponent(bot)}/turns';
  @override
  Future<Map<String, dynamic>> page(String botId, {String? before}) async {
    final query = Uri(queryParameters: {'before': ?before}).query;
    return wire.ConversationProjection.fromJson(
          await api.request(
            '${path(botId)}${query.isEmpty ? '' : '?$query'}',
            // The server cuts a page at 512,000 wire bytes but always admits
            // the newest finished Turn past that line, so a Bot with history
            // answers with a page the default limit refuses — and the chat
            // could never restore (Bob and Test, 2026-09-07).
            limit: 2000000,
          ),
        ).toJson()
        as Map<String, dynamic>;
  }

  @override
  Future<void> send(String botId, String id, String text) async {
    if (utf8.encode(text).length > 32000) {
      throw const RequestFailure(
        'That message is too long. Please shorten it.',
        413,
      );
    }
    final command = wire.TurnCommand.fromJson({
      'schemaVersion': 1,
      'commandId': id,
      'text': text,
    });
    final response = wire.TurnResponse.fromJson(
      await api.request(path(botId), body: command.toJson(), limit: 256000),
    );
    if (response.runId.value != id) {
      throw const RequestFailure(
        'Couldn’t confirm your message. Check its status.',
      );
    }
  }

  @override
  Future<Map<String, dynamic>?> lookup(
    String botId,
    String id, {
    bool fence = false,
  }) async {
    final response =
        wire.RunLookup.fromJson(
              await api.request(
                '${path(botId)}/${Uri.encodeComponent(id)}${fence ? '/fence' : ''}',
                body: fence
                    ? {'schemaVersion': 1, 'action': 'fence-admission'}
                    : null,
              ),
            ).toJson()
            as Map<String, dynamic>;
    final run = response['run'] as Map<String, dynamic>?;
    if (run != null && run['runId'] != id) {
      throw const FormatException('Mismatched run');
    }
    return run;
  }

  @override
  Future<Map<String, dynamic>> stop(
    String botId,
    String id,
    String commandId,
  ) async {
    final response = wire.StopReceipt.fromJson(
      await api.request(
        '${path(botId)}/${Uri.encodeComponent(id)}/stop',
        body: {
          'schemaVersion': 1,
          'action': 'stop',
          'commandId': commandId,
          'runId': id,
        },
      ),
    );
    if (response.runId.value != id || response.commandId.value != commandId) {
      throw const FormatException('Mismatched Stop receipt');
    }
    final run = response.run.toJson() as Map<String, dynamic>;
    if (run['runId'] != id) throw const FormatException('Mismatched Stop run');
    return run;
  }
}
