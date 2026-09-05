import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/connections/page.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'settings_test.dart' show SettingsApi, profile;

import 'package:frockbot_native/settings/page.dart';

import 'widget_test.dart' show MemoryStore;

void main() {
  testWidgets('Settings opens the one Connectors home', (tester) async {
    final store = MemoryStore();
    final api = SettingsApi(
      store,
      (path, _) async => path.endsWith('/application')
          ? profile()
          : {
              'schemaVersion': 1,
              'ownerId': 'tim',
              'revision': 1,
              'accounts': [
                {
                  'id': 'work',
                  'label': 'Work Gmail',
                  'service': 'Gmail',
                  'state': 'ready',
                },
              ],
            },
    );
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: SettingsPage(api: api, store: store, userId: 'tim'),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Connectors'), findsOneWidget);
    await tester.tap(find.text('Connectors'));
    await tester.pumpAndSettle();
    expect(find.text('Work Gmail'), findsOneWidget);
    expect(find.text('Available to every Bot'), findsOneWidget);
    expect(find.text('Manage connections'), findsOneWidget);
  });

  testWidgets(
    'Connectors recovers from offline without showing raw backend errors',
    (tester) async {
      var offline = true;
      final api = SettingsApi(MemoryStore(), (_, _) async {
        if (offline) throw const RequestFailure('synthetic backend detail');
        return {
          'schemaVersion': 1,
          'ownerId': 'tim',
          'revision': 1,
          'accounts': [],
        };
      });
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: ConnectionsPage(api: api, userId: 'tim'),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.textContaining('synthetic backend'), findsNothing);
      expect(find.text('Connections couldn’t load'), findsOneWidget);
      offline = false;
      await tester.tap(find.text('Try again'));
      await tester.pumpAndSettle();
      expect(find.text('Your accounts, together'), findsOneWidget);
      expect(find.text('Manage connections'), findsOneWidget);
    },
  );
  testWidgets(
    'browser grants refresh on return and refuse an unrelated handoff',
    (tester) async {
      var phase = 'authorizing';
      var unsafe = false;
      final opened = <Uri>[];
      final api = SettingsApi(MemoryStore(), (path, body) async {
        if (body != null) {
          expect(path, '/api/auth/native/settings');
          expect(body, {'schemaVersion': 1, 'home': 'connections'});
          return {
            'schemaVersion': 1,
            'expiresAt': '2026-09-05T23:59:00.000Z',
            'authorizationUrl': unsafe
                ? 'https://unrelated.example/native/settings?state=test'
                : 'https://bot.frockbot.com/native/settings?state=test',
          };
        }
        return {
          'schemaVersion': 1,
          'ownerId': 'tim',
          'revision': 1,
          'accounts': [
            {
              'id': 'work',
              'label': 'Work Gmail',
              'service': 'Gmail',
              'state': phase,
            },
          ],
        };
      });
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: ConnectionsPage(
            api: api,
            userId: 'tim',
            openBrowser: (uri) async {
              opened.add(uri);
              return true;
            },
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Manage connections'));
      await tester.pumpAndSettle();
      expect(opened.single.host, 'bot.frockbot.com');
      phase = 'ready';
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpAndSettle();
      expect(find.text('Available to every Bot'), findsOneWidget);
      unsafe = true;
      await tester.tap(find.text('Manage connections'));
      await tester.pumpAndSettle();
      expect(opened, hasLength(1));
      expect(find.textContaining('Couldn’t open Connections'), findsOneWidget);
    },
  );
  for (final brightness in Brightness.values) {
    testWidgets(
      'Connectors keeps statuses and browser action readable at 200% ($brightness)',
      (tester) async {
        tester.view.physicalSize = const Size(390, 844);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final api = SettingsApi(
          MemoryStore(),
          (_, _) async => {
            'schemaVersion': 1,
            'ownerId': 'tim',
            'revision': 1,
            'accounts': [
              {
                'id': 'work',
                'label': 'My long work account label',
                'service': 'Google Calendar',
                'state': 'reconciliation-required',
              },
            ],
          },
        );
        await tester.pumpWidget(
          MaterialApp(
            theme: FrockTheme.theme(brightness),
            home: MediaQuery(
              data: const MediaQueryData(
                textScaler: TextScaler.linear(2),
                disableAnimations: true,
              ),
              child: ConnectionsPage(api: api, userId: 'tim'),
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text('Manage connections'), findsOneWidget);
        await tester.scrollUntilVisible(
          find.text('Connection needs to be checked'),
          200,
          scrollable: find.byType(Scrollable).first,
        );
        expect(find.text('Connection needs to be checked'), findsOneWidget);
        expect(tester.takeException(), isNull);
      },
    );
  }
}
