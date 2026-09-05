import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../protocol/client_wire.generated.dart' as wire;

const hostedOrigin = 'https://bot.frockbot.com';
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

abstract interface class LocalStore {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> delete(String key);
}

/// A store whose values are resident in memory, so the first frame after a
/// switch is painted without awaiting the platform.
abstract interface class SnapshotStore implements LocalStore {
  /// Whether [peek] is authoritative. While this is false a null answer only
  /// means "not loaded yet" and the asynchronous read still has to be awaited.
  bool get resident;

  /// The value already held in memory, without a platform round trip.
  String? peek(String key);
}

/// A store that can list what it holds, which a migration to another store
/// needs and ordinary reads and writes do not.
abstract interface class EnumerableStore implements LocalStore {
  Future<Map<String, String>> readAll();
}

class ProtectedStore implements LocalStore, EnumerableStore {
  final FlutterSecureStorage _storage = const FlutterSecureStorage();
  Future<void> _writes = Future.value();
  Future<void> _enqueue(Future<void> Function() operation) {
    final next = _writes.then((_) => operation());
    _writes = next.catchError((Object _) {});
    return next;
  }

  @override
  Future<String?> read(String key) async {
    await _writes;
    return _storage.read(key: 'native.v1.$key');
  }

  @override
  Future<void> write(String key, String value) =>
      _enqueue(() => _storage.write(key: 'native.v1.$key', value: value));
  @override
  Future<void> delete(String key) =>
      _enqueue(() => _storage.delete(key: 'native.v1.$key'));
  @override
  Future<Map<String, String>> readAll() async {
    await _writes;
    const prefix = 'native.v1.';
    final all = await _storage.readAll();
    return {
      for (final entry in all.entries)
        if (entry.key.startsWith(prefix))
          entry.key.substring(prefix.length): entry.value,
    };
  }
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
  final HttpClient _client = HttpClient()
    ..connectionTimeout = const Duration(seconds: 10);
  NativeApi(this.store);
  String? _authorization;
  bool _sessionKnown = false;
  Future<void>? _sessionRead;

  /// The session is the one secret this client holds, and every request needs
  /// it. It is read from the keystore once and then kept in memory; sign-in,
  /// sign-out and restore hand the new value straight in, so no request waits
  /// on the platform keystore or on writes queued ahead of it.
  void adoptSession(String? session) {
    _authorization = session == null ? null : _bearer(session);
    _sessionKnown = true;
    _sessionRead = null;
  }

  static String _bearer(String session) =>
      'Bearer ${wire.AuthSessionView.fromJson(jsonDecode(session)).sessionToken}';

  Future<String?> _authorizationHeader() async {
    if (_sessionKnown) return _authorization;
    final read = _sessionRead ??= store.read('session').then((session) {
      // A sign-in that landed while this read was in flight already holds
      // the current session and must not be overwritten by the older one.
      if (_sessionKnown) return;
      _authorization = session == null ? null : _bearer(session);
      _sessionKnown = true;
    });
    try {
      await read;
    } catch (_) {
      // A failed read stays retryable rather than caching its failure.
      if (identical(_sessionRead, read)) _sessionRead = null;
      rethrow;
    }
    return _authorization;
  }

  Future<Map<String, String>> headers() async {
    final authorization = await _authorizationHeader();
    return {
      'content-type': 'application/json',
      'x-frockbot-client': jsonEncode(clientHello),
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
      final request = await _client.openUrl(
        body == null ? 'GET' : 'POST',
        Uri.parse('$hostedOrigin$path'),
      );
      request.followRedirects = false;
      final values = authenticated
          ? await headers()
          : {
              'content-type': 'application/json',
              'x-frockbot-client': jsonEncode(clientHello),
            };
      values.forEach(request.headers.set);
      if (body != null) request.write(jsonEncode(body));
      final response = await request.close().timeout(
        const Duration(seconds: 30),
      );
      final bytes = <int>[];
      await for (final chunk in response.timeout(const Duration(seconds: 30))) {
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
          413 => 'That message is too long. Please shorten it.',
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

  Future<WebSocket> socket(String botId, String? cursor) async {
    final uri = Uri.parse(hostedOrigin).replace(
      scheme: 'wss',
      path: '/api/bots/$botId/state-channel',
      queryParameters: {'version': '1', 'cursor': ?cursor},
    );
    return WebSocket.connect(
      uri.toString(),
      headers: await headers(),
    ).timeout(const Duration(seconds: 5));
  }

  void close() => _client.close(force: true);
}

abstract interface class ChatTransport {
  Future<Map<String, dynamic>> page(
    String botId, {
    String? before,
    String? conversationId,
  });
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
  Future<Map<String, dynamic>> page(
    String botId, {
    String? before,
    String? conversationId,
  }) async {
    final query = Uri(
      queryParameters: {'before': ?before, 'conversationId': ?conversationId},
    ).query;
    return wire.ConversationProjection.fromJson(
          await api.request('${path(botId)}${query.isEmpty ? '' : '?$query'}'),
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
