import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart' show debugPrint;
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import '../brand.dart';
import '../protocol/client_wire.generated.dart' as wire;
import 'auth.dart';
import 'desktop_build.dart';
import 'ios_build.dart';
import 'transport.dart';

/// The app signs in to whichever server its account is on, in the browser
/// with PKCE (RFC 8252), and comes back on its own scheme: a verified link
/// could only ever name the one deployment a build was made for. On an iPhone
/// or a Mac the system's authentication session hands the return straight
/// back; on Android a Custom Tab opens and the return arrives as a link.
class NativeSignIn implements SignIn {
  final NativeApi api;
  final LocalStore store;
  final MethodChannel channel;
  bool _exchanging = false;
  NativeSignIn(
    this.api,
    this.store, {
    this.channel = const MethodChannel('frockbot/web-auth'),
  });

  /// The scheme this build answers. A development sign-in on the local stack
  /// comes back on the development scheme its debug manifest registers; an
  /// Android build asks which identity it was built as, because the released
  /// app and the development one must not answer each other's returns.
  Future<String> scheme() async {
    if (developmentAuth) return '${clientBrand.nativeScheme}-dev';
    if (Platform.isIOS) return iosSchemeV1;
    if (Platform.isMacOS) return macosSchemeV1;
    if (!Platform.isAndroid) return clientBrand.nativeScheme;
    try {
      return await channel.invokeMethod<String>('scheme') ??
          clientBrand.nativeScheme;
    } on MissingPluginException {
      return clientBrand.nativeScheme;
    }
  }

  static String get _platform => Platform.isAndroid
      ? 'android'
      : Platform.isIOS
      ? 'ios'
      : 'macos';

  /// Where the server sends this build back. The host is always `native`, so
  /// the one registration covers every server the app signs in to.
  Future<String> returnUri() async =>
      '${await scheme()}://native/return/$_platform';

  @override
  Future<bool?> start() async {
    final returnUri = await this.returnUri();
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
    if (uri.origin != api.origin || uri.path != '/native/authorize') {
      throw const RequestFailure('Couldn’t open sign-in. Please try again.');
    }
    // The local smoke completes the browser leg itself from this line rather
    // than driving Chrome's first-run screens on a fresh emulator.
    if (developmentAuth) debugPrint('FROCKBOT_DEV_AUTHORIZE $uri');
    if (Platform.isIOS || Platform.isMacOS) {
      final String? link;
      try {
        link = await channel.invokeMethod<String>('authenticate', {
          'url': uri.toString(),
          'scheme': await scheme(),
        });
      } on PlatformException {
        throw const RequestFailure('Couldn’t open sign-in. Please try again.');
      }
      if (link == null) return false;
      if (!await accept(Uri.parse(link))) {
        throw const RequestFailure(
          'That sign-in link has expired. Please sign in again.',
        );
      }
      return true;
    }
    // A Custom Tab where the browser offers one, the browser itself where not.
    if (!await launchUrl(uri, mode: LaunchMode.inAppBrowserView) &&
        !await launchUrl(uri, mode: LaunchMode.externalApplication)) {
      throw const RequestFailure(
        'Couldn’t open your browser. Please try again.',
      );
    }
    return null;
  }

  @override
  Future<bool> accept(Uri uri) async {
    if (_exchanging) return false;
    _exchanging = true;
    try {
      final stored = await store.read('sign-in');
      if (stored == null) return false;
      final pending = jsonDecode(stored) as Map<String, dynamic>;
      final returnUri = pending['returnUri'];
      if (returnUri is! String) return false;
      final expected = Uri.parse(returnUri);
      if (uri.scheme != expected.scheme ||
          uri.host != expected.host ||
          uri.port != expected.port ||
          uri.path != expected.path ||
          uri.fragment.isNotEmpty ||
          uri.userInfo.isNotEmpty) {
        return false;
      }
      if (pending['version'] != 1 ||
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
