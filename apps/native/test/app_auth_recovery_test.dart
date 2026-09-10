import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/main.dart';

import 'widget_test.dart' show MemoryStore;

/// A keystore that accepts a session but refuses to give it up, which is how a
/// platform keystore fails on the device.
class UndeletableStore extends MemoryStore {
  @override
  Future<void> delete(String key) async =>
      throw StateError('storage unavailable');
}

String savedSession() => jsonEncode({
  'schemaVersion': 1,
  'sessionId': 'expired-session',
  'userId': 'user-1',
  'expiresAt': '2026-09-09T00:00:00.000Z',
  'sessionToken': 'expired-token',
});

http.Response refused() =>
    http.Response(jsonEncode({'error': 'Unauthorized'}), 401);

/// A gateway that refuses every read this client authenticates.
NativeApi rejecting(MemoryStore store) => NativeApi(
  store,
  client: MockClient((request) async => refused()),
);

/// A gateway that knows the account but refuses everything the shell then
/// reads, which is a bearer revoked while the app is resident.
NativeApi rejectingAfterIdentity(MemoryStore store) => NativeApi(
  store,
  client: MockClient((request) async {
    if (request.url.path == '/api/identity') {
      return http.Response(
        jsonEncode({
          'schemaVersion': 1,
          'userId': 'user-1',
          'isAdmin': false,
        }),
        200,
        headers: {'content-type': 'application/json'},
      );
    }
    return refused();
  }),
);

/// The deep-link stream is a platform channel with no implementation under
/// the test binding, and its refusal is not what any of this is about.
void withoutDeepLinks(WidgetTester tester) {
  final messenger = tester.binding.defaultBinaryMessenger;
  for (final channel in const [
    MethodChannel('com.llfbandit.app_links/events'),
    MethodChannel('com.llfbandit.app_links/messages'),
  ]) {
    messenger.setMockMethodCallHandler(channel, (_) async => null);
    addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
  }
}

/// The transport's own reads run on real timers, so the fake clock a widget
/// test pumps on has to stand aside for them before the next frame.
Future<void> answer(WidgetTester tester) async {
  for (var round = 0; round < 4; round++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 20)),
    );
    await tester.pumpAndSettle();
  }
}

void main() {
  testWidgets(
    'a rejected saved session returns to sign-in instead of an offline shell',
    (tester) async {
      withoutDeepLinks(tester);
      final store = MemoryStore();
      store.values['session'] = savedSession();

      await tester.pumpWidget(
        FrockBotApp(store: store, api: rejecting(store)),
      );
      await answer(tester);

      expect(find.byKey(const ValueKey('sign-in')), findsOneWidget);
      expect(find.textContaining('You’re offline'), findsNothing);
      expect(store.values.containsKey('session'), isFalse);
    },
  );

  testWidgets('the rejected session says why sign-in is being asked again', (
    tester,
  ) async {
    withoutDeepLinks(tester);
    final store = MemoryStore();
    store.values['session'] = savedSession();

    await tester.pumpWidget(FrockBotApp(store: store, api: rejecting(store)));
    await answer(tester);

    expect(find.textContaining('Please sign in again.'), findsOneWidget);
  });

  testWidgets('nobody signed in yet is not told their session ended', (
    tester,
  ) async {
    withoutDeepLinks(tester);
    final store = MemoryStore();

    await tester.pumpWidget(FrockBotApp(store: store, api: rejecting(store)));
    await answer(tester);

    expect(find.byKey(const ValueKey('sign-in')), findsOneWidget);
    expect(find.textContaining('Please sign in again.'), findsNothing);
  });

  testWidgets('a keystore that cannot delete still returns to sign-in', (
    tester,
  ) async {
    withoutDeepLinks(tester);
    final store = UndeletableStore();
    store.values['session'] = savedSession();

    await tester.pumpWidget(FrockBotApp(store: store, api: rejecting(store)));
    await answer(tester);

    expect(find.byKey(const ValueKey('sign-in')), findsOneWidget);
    expect(find.textContaining('You’re offline'), findsNothing);
  });

  testWidgets(
    'a bearer rejected after the shell opens returns to sign-in, not offline',
    (tester) async {
      withoutDeepLinks(tester);
      final store = MemoryStore();
      store.values['session'] = savedSession();

      await tester.pumpWidget(
        FrockBotApp(store: store, api: rejectingAfterIdentity(store)),
      );
      await answer(tester);

      expect(find.byKey(const ValueKey('sign-in')), findsOneWidget);
      expect(find.textContaining('You’re offline'), findsNothing);
      expect(store.values.containsKey('session'), isFalse);
    },
  );
}
