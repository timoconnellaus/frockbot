import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart' show debugPrint;
import 'package:url_launcher/url_launcher.dart';

import '../protocol/client_wire.generated.dart' as wire;
import 'auth.dart';
import 'transport.dart';

class NativeSignIn implements SignIn {
  final NativeApi api;
  final LocalStore store;
  bool _exchanging = false;
  NativeSignIn(this.api, this.store);

  /// A development sign-in comes back on a custom scheme: the local stack's
  /// origin is plain HTTP on a private address, which no App Link can name.
  String get returnUri => developmentAuth
      ? 'frockbot-dev://native/return/android'
      : '$hostedOrigin/native/return/${Platform.isAndroid ? 'android' : 'macos'}';
  @override
  Future<void> start() async {
    final verifier = '${randomId()}${randomId()}';
    final state = '${randomId()}${randomId()}';
    final command = wire.AuthStartCommand.fromJson({
      'schemaVersion': 1,
      'commandId': randomId(),
      'state': state,
      'returnUri': returnUri,
      'codeChallengeMethod': 'S256',
      'codeChallenge': base64Url
          .encode(sha256.convert(utf8.encode(verifier)).bytes)
          .replaceAll('=', ''),
    });
    await store.write(
      'sign-in',
      jsonEncode({
        'version': 1,
        'verifier': verifier,
        'state': state,
        'returnUri': returnUri,
        'exchangeId': randomId(),
        'createdAt': DateTime.now().toUtc().toIso8601String(),
      }),
    );
    final response = wire.AuthStartView.fromJson(
      await api.request(
        '/api/auth/native/start',
        body: command.toJson(),
        authenticated: false,
        limit: 8192,
      ),
    );
    final uri = Uri.parse(response.authorizationUrl.value as String);
    if (uri.origin != hostedOrigin || uri.path != '/native/authorize') {
      throw const RequestFailure('Couldn’t open sign-in. Please try again.');
    }
    // The local smoke completes the browser leg itself from this line rather
    // than driving Chrome's first-run screens on a fresh emulator.
    if (developmentAuth) debugPrint('FROCKBOT_DEV_AUTHORIZE $uri');
    if (!await launchUrl(uri, mode: LaunchMode.externalApplication)) {
      throw const RequestFailure(
        'Couldn’t open your browser. Please try again.',
      );
    }
  }

  @override
  Future<bool> accept(Uri uri) async {
    final expected = Uri.parse(returnUri);
    if (uri.scheme != expected.scheme ||
        uri.host != expected.host ||
        uri.port != expected.port ||
        uri.path != expected.path ||
        uri.fragment.isNotEmpty ||
        uri.userInfo.isNotEmpty) {
      return false;
    }
    if (_exchanging) return false;
    _exchanging = true;
    try {
      final stored = await store.read('sign-in');
      if (stored == null) return false;
      final pending = jsonDecode(stored) as Map<String, dynamic>;
      if (pending['version'] != 1 ||
          pending['returnUri'] != returnUri ||
          pending['state'] != uri.queryParameters['state'] ||
          uri.queryParametersAll.values.any((v) => v.length != 1) ||
          uri.queryParameters.keys.toSet().difference({
            'code',
            'state',
          }).isNotEmpty) {
        throw const RequestFailure(
          'That sign-in link has expired. Please sign in again.',
        );
      }
      final command = wire.AuthExchangeCommand.fromJson({
        'schemaVersion': 1,
        'commandId': pending['exchangeId'],
        'code': uri.queryParameters['code'],
        'codeVerifier': pending['verifier'],
        'state': pending['state'],
        'returnUri': returnUri,
      });
      final session = wire.AuthSessionView.fromJson(
        await api.request(
          '/api/auth/native/exchange',
          body: command.toJson(),
          authenticated: false,
          limit: 8192,
        ),
      );
      final saved = jsonEncode(session.toJson());
      await store.write('session', saved);
      // The request path reads the session from memory, so it learns of this
      // one here rather than from the keystore.
      api.adoptSession(saved);
      await store.delete('sign-in');
      return true;
    } finally {
      _exchanging = false;
    }
  }

  @override
  Future<void> signOut() async {
    final saved = await store.read('session');
    if (saved != null) {
      final session = wire.AuthSessionView.fromJson(jsonDecode(saved));
      // A failed revoke remains retryable; local deletion must not claim that
      // the server session and viewer renewals were revoked.
      if (DateTime.parse(session.expiresAt.value).isAfter(DateTime.now())) {
        final key = 'revoke/${session.sessionId.value}';
        final id = await store.read(key) ?? randomId();
        await store.write(key, id);
        try {
          await api.request(
            '/api/auth/native/revoke',
            body: {
              'schemaVersion': 1,
              'commandId': id,
              'action': 'sign-out',
              'sessionId': session.sessionId.value,
            },
          );
        } on RequestFailure catch (failure) {
          if (failure.status != 401) rethrow;
        }
        await store.delete(key);
      }
    }
    await store.delete('session');
    api.adoptSession(null);
    await store.delete('sign-in');
  }
}

SignIn signInV1(NativeApi api, LocalStore store) => NativeSignIn(api, store);
