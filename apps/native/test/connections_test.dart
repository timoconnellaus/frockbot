import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/connections/page.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'settings_test.dart' show SettingsApi, profile;

import 'package:frockbot_native/settings/page.dart';

import 'widget_test.dart' show MemoryStore;

/// The catalog the server serves to the app: services, in their own words.
Map<String, Object?> catalog([List<Map<String, Object?>>? items]) => {
  'schemaVersion': 1,
  'items':
      items ??
      [
        {
          'id': 'slack',
          'name': 'Slack',
          'description': 'Messages, channels',
          'icon': 'https://logos.example/slack.png',
        },
        {'id': 'notion', 'name': 'Notion', 'description': 'Pages, databases'},
        {'id': 'xero', 'name': 'Xero', 'description': 'Invoices, bills'},
      ],
};

Map<String, Object?> accounts(List<Map<String, Object?>> rows) => {
  'schemaVersion': 1,
  'ownerId': 'tim',
  'revision': 1,
  'accounts': rows,
};

void main() {
  testWidgets('Settings opens Connect, and the accounts are already there', (
    tester,
  ) async {
    final store = MemoryStore();
    final api = SettingsApi(store, (path, _) async {
      if (path.endsWith('/application')) return profile();
      if (path == '/api/plugins/composio/catalog') return catalog();
      return accounts([
        {
          'id': 'work',
          'label': 'Work Gmail',
          'service': 'Gmail',
          'state': 'ready',
        },
      ]);
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: SettingsPage(api: api, store: store, userId: 'tim'),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Connect'), findsOneWidget);
    await tester.tap(find.text('Connect'));
    await tester.pumpAndSettle();
    // The connected service and the services to add, in one screen. Nothing
    // sends the User to the browser to look at their own accounts.
    expect(find.text('Gmail'), findsOneWidget);
    expect(find.text('Connected'), findsOneWidget);
    expect(find.text('Slack'), findsOneWidget);
    expect(find.text('Manage connections'), findsNothing);
    expect(find.textContaining('connector'), findsNothing);
    expect(find.textContaining('Composio'), findsNothing);
    expect(
      find.textContaining('Connections belong to you, not to a Bot'),
      findsOneWidget,
    );
  });

  testWidgets('each connection state reads as words, not as a status code', (
    tester,
  ) async {
    final api = SettingsApi(MemoryStore(), (path, _) async {
      if (path == '/api/plugins/composio/catalog') return catalog();
      return accounts([
        {
          'id': 'a',
          'label': 'Work Gmail',
          'service': 'Gmail',
          'state': 'authorizing',
        },
        {
          'id': 'b',
          'label': 'Calendar',
          'service': 'Google Calendar',
          'state': 'reconciliation-required',
        },
      ]);
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: ConnectionsPage(api: api, userId: 'tim'),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Finish signing in'), findsOneWidget);
    expect(find.text('Needs attention'), findsOneWidget);
  });

  testWidgets('search narrows the services', (tester) async {
    final api = SettingsApi(MemoryStore(), (path, _) async {
      if (path == '/api/plugins/composio/catalog') return catalog();
      return accounts([]);
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: ConnectionsPage(api: api, userId: 'tim'),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Slack'), findsOneWidget);
    expect(find.text('Xero'), findsOneWidget);
    await tester.enterText(find.byType(TextField), 'xer');
    await tester.pumpAndSettle();
    expect(find.text('Xero'), findsOneWidget);
    expect(find.text('Slack'), findsNothing);
    await tester.enterText(find.byType(TextField), 'zzzz');
    await tester.pumpAndSettle();
    expect(find.text('No services match that'), findsOneWidget);
  });

  testWidgets(
    'tapping a service starts it and opens the sign-in the server returns',
    (tester) async {
      final opened = <Uri>[];
      final store = MemoryStore();
      Map<String, Object?>? started;
      final api = SettingsApi(store, (path, body) async {
        if (path == '/api/plugins/composio/catalog') return catalog();
        if (path == '/api/plugins/composio/connections') {
          started = Map<String, Object?>.from(body! as Map);
          return {
            'schemaVersion': 1,
            'status': 'authorization-required',
            'connectionId': 'c1',
            'redirectUrl': 'https://slack.example/oauth?state=x',
            'expiresAt': '2026-09-06T23:59:00.000Z',
          };
        }
        return accounts([]);
      });
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: ConnectionsPage(
            api: api,
            userId: 'tim',
            store: store,
            openBrowser: (uri) async {
              opened.add(uri);
              return true;
            },
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Slack'));
      await tester.pumpAndSettle();
      expect(started!['type'], 'connection/start');
      expect(started!['connectionTypeId'], 'app');
      expect(started!['connectorId'], 'slack');
      expect(opened.single.host, 'slack.example');
      expect(
        find.textContaining('Finish signing in to Slack in your browser'),
        findsOneWidget,
      );
      // The name is remembered so the notice on the way back can say it.
      expect(store.values[pendingConnectionKey], 'Slack');
    },
  );

  testWidgets('a sign-in link the app cannot trust is never opened', (
    tester,
  ) async {
    final opened = <Uri>[];
    final api = SettingsApi(MemoryStore(), (path, body) async {
      if (path == '/api/plugins/composio/catalog') return catalog();
      if (path == '/api/plugins/composio/connections') {
        return {
          'schemaVersion': 1,
          'status': 'authorization-required',
          'connectionId': 'c1',
          'redirectUrl': 'http://slack.example/oauth',
          'expiresAt': '2026-09-06T23:59:00.000Z',
        };
      }
      return accounts([]);
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
    await tester.tap(find.text('Slack'));
    await tester.pumpAndSettle();
    expect(opened, isEmpty);
    expect(find.textContaining('Couldn’t start Slack'), findsOneWidget);
  });

  testWidgets('removing a connection asks first, then revokes and reloads', (
    tester,
  ) async {
    var revoked = 0;
    final api = SettingsApi(MemoryStore(), (path, body) async {
      if (path == '/api/plugins/composio/catalog') return catalog();
      if (path.endsWith('/revoke')) {
        expect(path, '/api/plugins/composio/connections/work/revoke');
        expect(body, {'schemaVersion': 1, 'type': 'connection/revoke'});
        revoked += 1;
        return {'schemaVersion': 1, 'status': 'revoked'};
      }
      return accounts(
        revoked == 0
            ? [
                {
                  'id': 'work',
                  'label': 'Work Gmail',
                  'service': 'Gmail',
                  'state': 'ready',
                },
              ]
            : [],
      );
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: ConnectionsPage(api: api, userId: 'tim'),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Gmail'));
    await tester.pumpAndSettle();
    expect(find.text('Remove Work Gmail?'), findsOneWidget);
    // Backing out changes nothing.
    await tester.tap(find.text('Keep it'));
    await tester.pumpAndSettle();
    expect(revoked, 0);
    expect(find.text('Gmail'), findsOneWidget);
    await tester.tap(find.text('Gmail'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Remove'));
    await tester.pumpAndSettle();
    expect(revoked, 1);
    expect(
      find.textContaining('Work Gmail is no longer connected'),
      findsOneWidget,
    );
  });

  testWidgets('the link back from a service names what happened', (
    tester,
  ) async {
    final store = MemoryStore();
    store.values[pendingConnectionKey] = 'Slack';
    final api = SettingsApi(store, (path, _) async {
      if (path == '/api/plugins/composio/catalog') return catalog();
      return accounts([]);
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: ConnectionsPage(
          api: api,
          userId: 'tim',
          store: store,
          outcome: connectionReturn(
            Uri.parse('https://bot.frockbot.com/?connection=composio-ready'),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.textContaining('Slack is connected'), findsOneWidget);
    expect(store.values.containsKey(pendingConnectionKey), isFalse);
  });

  test('only FrockBot’s own return link is a connection outcome', () {
    expect(
      connectionReturn(
        Uri.parse('https://bot.frockbot.com/?connection=composio-ready'),
      ),
      'ready',
    );
    expect(
      connectionReturn(
        Uri.parse(
          'https://bot.frockbot.com/?connection=composio-failed&connection_reason=nope',
        ),
      ),
      'failed',
    );
    expect(
      connectionReturn(
        Uri.parse('https://bot.frockbot.com/?connection=composio-pending'),
      ),
      'pending',
    );
    for (final url in [
      'https://evil.example/?connection=composio-ready',
      'http://bot.frockbot.com/?connection=composio-ready',
      'https://bot.frockbot.com/other?connection=composio-ready',
      'https://bot.frockbot.com/?connection=composio-ready#x',
      'https://bot.frockbot.com/?connection=composio-ready&connection=composio-failed',
      'https://bot.frockbot.com/?connection=whatever',
      'https://bot.frockbot.com/?bot=alpha',
    ]) {
      expect(connectionReturn(Uri.parse(url)), isNull, reason: url);
    }
  });

  testWidgets('a catalog the server cannot serve still shows the accounts', (
    tester,
  ) async {
    final api = SettingsApi(MemoryStore(), (path, _) async {
      if (path == '/api/plugins/composio/catalog') {
        throw const RequestFailure('synthetic backend detail');
      }
      return accounts([
        {
          'id': 'work',
          'label': 'Work Gmail',
          'service': 'Gmail',
          'state': 'ready',
        },
      ]);
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: ConnectionsPage(api: api, userId: 'tim'),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.textContaining('synthetic backend'), findsNothing);
    expect(find.text('Gmail'), findsOneWidget);
    expect(find.text('Services couldn’t load'), findsOneWidget);
  });

  testWidgets('an empty catalog says so in plain words', (tester) async {
    final api = SettingsApi(MemoryStore(), (path, _) async {
      if (path == '/api/plugins/composio/catalog') return catalog([]);
      return accounts([]);
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: ConnectionsPage(api: api, userId: 'tim'),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('No services available yet'), findsOneWidget);
  });

  testWidgets('Connect recovers from offline without showing raw errors', (
    tester,
  ) async {
    var offline = true;
    final api = SettingsApi(MemoryStore(), (path, _) async {
      if (offline) throw const RequestFailure('synthetic backend detail');
      if (path == '/api/plugins/composio/catalog') return catalog();
      return accounts([]);
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: ConnectionsPage(api: api, userId: 'tim'),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.textContaining('synthetic backend'), findsNothing);
    expect(find.text('Services couldn’t load'), findsOneWidget);
    offline = false;
    await tester.tap(find.text('Try again'));
    await tester.pumpAndSettle();
    expect(find.text('Slack'), findsOneWidget);
  });

  testWidgets('returning to the app refreshes what is connected', (
    tester,
  ) async {
    var phase = 'authorizing';
    final api = SettingsApi(MemoryStore(), (path, _) async {
      if (path == '/api/plugins/composio/catalog') return catalog();
      return accounts([
        {
          'id': 'work',
          'label': 'Work Gmail',
          'service': 'Gmail',
          'state': phase,
        },
      ]);
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: ConnectionsPage(api: api, userId: 'tim'),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Finish signing in'), findsOneWidget);
    phase = 'ready';
    // The trip out to the browser and back, as Android reports it.
    for (final phase in [
      AppLifecycleState.inactive,
      AppLifecycleState.hidden,
      AppLifecycleState.paused,
      AppLifecycleState.hidden,
      AppLifecycleState.inactive,
      AppLifecycleState.resumed,
    ]) {
      tester.binding.handleAppLifecycleStateChanged(phase);
    }
    await tester.pumpAndSettle();
    expect(find.text('Connected'), findsOneWidget);
  });

  for (final brightness in Brightness.values) {
    testWidgets('Connect stays readable at 200% text ($brightness)', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final api = SettingsApi(MemoryStore(), (path, _) async {
        if (path == '/api/plugins/composio/catalog') return catalog();
        return accounts([
          {
            'id': 'work',
            'label': 'My long work account label',
            'service': 'Google Calendar',
            'state': 'reconciliation-required',
          },
        ]);
      });
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
      expect(find.text('Needs attention'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  }
}
