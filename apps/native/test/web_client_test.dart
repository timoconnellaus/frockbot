import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/credential_io.dart';
import 'package:frockbot_native/client/credential_web.dart';
import 'package:frockbot_native/client/transport.dart';

import 'widget_test.dart' show MemoryStore;

String session(String token) => jsonEncode({
  'schemaVersion': 1,
  'userId': 'user-1',
  'sessionId': 'native-1',
  'sessionToken': token,
  'expiresAt': DateTime.fromMillisecondsSinceEpoch(
    DateTime.now().millisecondsSinceEpoch,
    isUtc: true,
  ).add(const Duration(days: 1)).toIso8601String(),
});

void main() {
  test(
    'the phone reads its bearer token once and adopts a newer one',
    () async {
      final store = MemoryStore();
      store.values['session'] = session(List.filled(80, 's').join());
      final api = NativeApi(store, credential: BearerCredential(store));
      expect(
        (await api.headers())['authorization'],
        'Bearer ${List.filled(80, 's').join()}',
      );
      api.adoptSession(session(List.filled(80, 't').join()));
      expect(
        (await api.headers())['authorization'],
        'Bearer ${List.filled(80, 't').join()}',
      );
      api.adoptSession(null);
      expect((await api.headers()).containsKey('authorization'), isFalse);
      api.close();
    },
  );

  test(
    'the browser sends no authorization header and stores no session',
    () async {
      final store = MemoryStore();
      final api = NativeApi(store, credential: const CookieCredential());
      expect((await api.headers()).containsKey('authorization'), isFalse);
      // A session handed to the credential is discarded: the cookie is the
      // session, and it is never in this client's hands.
      api.adoptSession(session(List.filled(80, 's').join()));
      expect((await api.headers()).containsKey('authorization'), isFalse);
      expect(store.values, isEmpty);
      api.close();
    },
  );

  test('nothing in lib/ reaches for dart:io outside an _io.dart file', () {
    final offenders = <String>[];
    for (final entity in Directory('lib').listSync(recursive: true)) {
      if (entity is! File || !entity.path.endsWith('.dart')) continue;
      if (entity.path.endsWith('_io.dart')) continue;
      if (entity.readAsStringSync().contains("import 'dart:io'")) {
        offenders.add(entity.path);
      }
    }
    expect(offenders, isEmpty);
  });
}
