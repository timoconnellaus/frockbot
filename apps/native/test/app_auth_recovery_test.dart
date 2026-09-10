import 'dart:convert';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/main.dart';

import 'widget_test.dart' show MemoryStore;

class RejectedSessionApi extends NativeApi {
  RejectedSessionApi(super.store);

  @override
  Future<Object?> request(
    String path, {
    Object? body,
    int limit = 512000,
    bool authenticated = true,
  }) async => throw const RequestFailure('Please sign in again.', 401);
}

void main() {
  testWidgets(
    'a rejected saved session returns to sign-in instead of an offline shell',
    (tester) async {
      final store = MemoryStore();
      store.values['session'] = jsonEncode({
        'schemaVersion': 1,
        'sessionId': 'expired-session',
        'userId': 'user-1',
        'expiresAt': '2026-09-09T00:00:00.000Z',
        'sessionToken': 'expired-token',
      });
      final api = RejectedSessionApi(store);

      await tester.pumpWidget(FrockBotApp(store: store, api: api));
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('sign-in')), findsOneWidget);
      expect(find.textContaining('You’re offline'), findsNothing);
      expect(store.values.containsKey('session'), isFalse);
    },
  );
}
