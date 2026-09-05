import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/auth.dart';
import 'package:frockbot_native/client/transport.dart';

import 'widget_test.dart' show MemoryStore;

class ExchangeApi extends NativeApi {
  final requests = <Object?>[];
  ExchangeApi(super.store);
  @override
  Future<Object?> request(
    String path, {
    Object? body,
    int limit = 512000,
    bool authenticated = true,
  }) async {
    expect(path, '/api/auth/native/exchange');
    expect(authenticated, isFalse);
    requests.add(body);
    return {
      'schemaVersion': 1,
      'userId': 'user-1',
      'sessionId': 'native-1',
      'sessionToken': List.filled(80, 's').join(),
      'expiresAt': DateTime.fromMillisecondsSinceEpoch(
        DateTime.now().millisecondsSinceEpoch,
        isUtc: true,
      ).add(const Duration(days: 1)).toUtc().toIso8601String(),
    };
  }
}

void main() {
  test('cold callback resumes protected PKCE state and duplicate delivery never exchanges twice', () async {
    final store = MemoryStore();
    final api = ExchangeApi(store);
    final auth = NativeSignIn(api, store);
    final state = List.filled(64, 'a').join();
    await store.write(
      'sign-in',
      jsonEncode({
        'version': 1,
        'state': state,
        'verifier': List.filled(64, 'b').join(),
        'returnUri': auth.returnUri,
        'exchangeId': 'exchange-1',
        'createdAt': DateTime.fromMillisecondsSinceEpoch(
          DateTime.now().millisecondsSinceEpoch,
          isUtc: true,
        ).toUtc().toIso8601String(),
      }),
    );
    final uri = Uri.parse(auth.returnUri).replace(
      queryParameters: {'state': state, 'code': List.filled(80, 'c').join()},
    );
    final reconstructed = NativeSignIn(api, store);
    expect(await reconstructed.accept(uri), isTrue);
    expect(await reconstructed.accept(uri), isFalse);
    expect(api.requests, hasLength(1));
    expect(jsonDecode(store.values['session']!)['userId'], 'user-1');
    expect(store.values['sign-in'], isNull);
    api.close();
  });
  test(
    'wrong state, unverified return and duplicate query cannot dispatch',
    () async {
      final store = MemoryStore();
      final api = ExchangeApi(store);
      final auth = NativeSignIn(api, store);
      await store.write(
        'sign-in',
        jsonEncode({
          'version': 1,
          'state': 'expected',
          'returnUri': auth.returnUri,
        }),
      );
      expect(
        await auth.accept(
          Uri.parse('https://evil.test/native/return/macos?state=expected'),
        ),
        isFalse,
      );
      await expectLater(
        auth.accept(Uri.parse('${auth.returnUri}?state=wrong&code=abc')),
        throwsA(isA<RequestFailure>()),
      );
      await expectLater(
        auth.accept(
          Uri.parse('${auth.returnUri}?state=expected&state=expected&code=abc'),
        ),
        throwsA(isA<RequestFailure>()),
      );
      expect(api.requests, isEmpty);
      expect(store.values['session'], isNull);
      api.close();
    },
  );
}
