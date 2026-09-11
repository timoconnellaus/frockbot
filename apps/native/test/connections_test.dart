import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/connections/document.dart';
import 'package:frockbot_native/connections/page.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'settings_test.dart' show SettingsApi;
import 'widget_test.dart' show MemoryStore;

/// The `ConnectionsFrame` the server produces, written by hand so the Flutter
/// side is pinned to the frame's contract rather than to whatever the server
/// happens to emit today: one keyed model provider, one hosted-grant app.
Map<String, Object?> connectionsFrame({
  int revision = 1,
  List<Map<String, Object?>> accounts = const [],
  bool mayConnect = true,
  int connected = 0,
}) => {
  'schemaVersion': 1,
  'ownerId': 'tim',
  'revision': revision,
  'modelInUse': 'Auto · Frock AI',
  'accounts': [
    for (final account in accounts)
      {
        'id': account['id'],
        'label': account['label'],
        'state': account['state'] ?? 'ready',
        'packageId': account['packageId'] ?? 'provider-ollama-cloud',
        'connectionTypeId':
            account['connectionTypeId'] ?? 'ollama-cloud-account',
        'kind': account['kind'] ?? 'model',
        'authorization': account['authorization'] ?? 'api-key',
        if (account['detail'] != null) 'detail': account['detail'],
        if (account['failure'] != null) 'failure': account['failure'],
      },
  ],
  'providers': [
    {
      'packageId': 'provider-ollama-cloud',
      'connectionTypeId': 'ollama-cloud-account',
      'displayName': 'Ollama Cloud',
      'kind': 'model',
      'authorization': 'api-key',
      'connected': connected,
      'mayConnect': mayConnect,
      'settings': [
        {
          'id': 'api-base-url',
          'label': 'API base URL',
          'kind': 'text',
          'value': null,
          'editable': true,
        },
      ],
    },
    {
      'packageId': 'connect',
      'connectionTypeId': 'connect-gmail',
      'displayName': 'Gmail',
      'kind': 'connector',
      'authorization': 'grant',
      'connected': connected,
      'mayConnect': true,
      'description': 'Read, search, label and send email in a Gmail account.',
      'icon': 'gmail',
    },
  ],
};

Widget page(
  SettingsApi api,
  MemoryStore store, {
  bool models = false,
  Future<bool> Function(Uri)? openBrowser,
}) => MaterialApp(
  theme: FrockTheme.theme(Brightness.dark),
  home: ConnectionsPage(
    api: api,
    store: store,
    userId: 'tim',
    models: models,
    openBrowser: openBrowser,
  ),
);

void main() {
  group('the projection read back', () {
    test('a connect action becomes the credential route\'s command', () {
      expect(
        connectionRequestV1({
          'commandId': 'c1',
          'revision': 3,
          'actionId': 'connect-0',
          'input': {
            'kind': 'connect-api-key',
            'packageId': 'provider-ollama-cloud',
            'connectionTypeId': 'ollama-cloud-account',
            'c0.label': 'Local Ollama',
            'c0.key': 'synthetic-test-key',
            'c0.s.api-base-url': 'http://127.0.0.1:9999',
          },
        }).body,
        {
          'schemaVersion': 1,
          'type': 'connection/create-api-key',
          'commandId': 'c1',
          'packageId': 'provider-ollama-cloud',
          'connectionTypeId': 'ollama-cloud-account',
          'label': 'Local Ollama',
          'apiKey': 'synthetic-test-key',
          'settings': {'api-base-url': 'http://127.0.0.1:9999'},
        },
      );
    });

    test('an untouched Connection setting is not part of the command', () {
      final request = connectionRequestV1({
        'commandId': 'c2',
        'actionId': 'connect-0',
        'input': {
          'kind': 'connect-api-key',
          'packageId': 'provider-ollama-cloud',
          'connectionTypeId': 'ollama-cloud-account',
          'c0.label': 'Local Ollama',
          'c0.key': 'synthetic-test-key',
          'c0.s.api-base-url': '',
        },
      });
      expect(request.body.containsKey('settings'), isFalse);
    });

    test('a revocation goes to the Package\'s own route', () {
      final request = connectionRequestV1({
        'commandId': 'c3',
        'actionId': 'revoke',
        'input': {
          'kind': 'revoke',
          'packageId': 'connector-calendar',
          'connectionId': 'work',
        },
      });
      expect(
        request.path,
        '/api/plugins/connector-calendar/connections/work/revoke',
      );
      expect(request.body['type'], 'connection/revoke');
    });

    test('disconnecting never revokes upstream on the person\'s behalf', () {
      expect(
        connectionRequestV1({
          'commandId': 'c4',
          'actionId': 'disconnect',
          'input': {'kind': 'disconnect', 'connectionId': 'work'},
        }).body,
        containsPair('revokeUpstream', false),
      );
    });

    test('an action naming no kind Connectors takes is refused', () {
      expect(
        () => connectionRequestV1({
          'commandId': 'c5',
          'actionId': 'save-0',
          'input': {'sectionId': 'profile'},
        }),
        throwsA(isA<FormatException>()),
      );
    });
  });

  testWidgets('a key is typed once, sent once, and never read back', (
    tester,
  ) async {
    final store = MemoryStore();
    final sent = <Map<String, Object?>>[];
    var revision = 1;
    final api = SettingsApi(store, (path, body) async {
      if (body == null) return connectionsFrame(revision: revision);
      sent.add((body as Map).cast<String, Object?>());
      revision = 2;
      return {
        'schemaVersion': 1,
        'commandId': body['commandId'],
        'connectionId': 'conn-1',
        'status': 'applied',
      };
    });
    await tester.pumpWidget(page(api, store, models: true));
    await tester.pumpAndSettle();
    expect(find.text('Model in use: Auto · Frock AI'), findsOneWidget);
    // Only model providers are on the Models page.
    expect(find.text('Gmail'), findsNothing);

    await tester.tap(find.text('Connect'));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.widgetWithText(TextField, 'Account name'),
      'Local Ollama',
    );
    await tester.enterText(
      find.widgetWithText(TextField, 'API key'),
      'synthetic-test-key',
    );
    await tester.tap(find.widgetWithText(FilledButton, 'Connect account'));
    await tester.pumpAndSettle();

    expect(sent.single['apiKey'], 'synthetic-test-key');
    expect(sent.single['label'], 'Local Ollama');
    expect(sent.single['type'], 'connection/create-api-key');
    // The frame that comes back carries no key, and the widget that took one
    // starts empty again rather than holding a credential in memory.
    expect(find.text('synthetic-test-key'), findsNothing);
  });

  testWidgets('a connect with no key refuses before anything is sent', (
    tester,
  ) async {
    final store = MemoryStore();
    final sent = <Object?>[];
    final api = SettingsApi(store, (path, body) async {
      if (body == null) return connectionsFrame();
      sent.add(body);
      return {'commandId': 'x', 'status': 'applied'};
    });
    await tester.pumpWidget(page(api, store, models: true));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Connect'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Connect account'));
    await tester.pumpAndSettle();
    expect(sent, isEmpty);
    expect(find.text('This account still needs a key.'), findsOneWidget);
  });

  testWidgets('a hosted grant opens the checked destination and nothing else', (
    tester,
  ) async {
    final store = MemoryStore();
    final opened = <Uri>[];
    final sent = <Map<String, Object?>>[];
    final api = SettingsApi(store, (path, body) async {
      if (body == null) return connectionsFrame();
      sent.add({'path': path, ...(body as Map).cast<String, Object?>()});
      return {
        'schemaVersion': 1,
        'status': 'authorization-required',
        'connectionId': 'conn-2',
        'redirectUrl': 'https://connect.example/go',
        'expiresAt': '2026-09-11T00:10:00.000Z',
      };
    });
    await tester.pumpWidget(
      page(
        api,
        store,
        openBrowser: (uri) async {
          opened.add(uri);
          return true;
        },
      ),
    );
    await tester.pumpAndSettle();
    // The app's card carries its own mark and says what it gives a Bot.
    expect(find.byType(Image), findsOneWidget);
    expect(
      find.text('Read, search, label and send email in a Gmail account.'),
      findsOneWidget,
    );
    await tester.tap(find.text('Connect'));
    await tester.pumpAndSettle();
    expect(sent.single['path'], '/api/plugins/connect/connections');
    expect(sent.single['type'], 'connection/start');
    expect(sent.single['connectionTypeId'], 'connect-gmail');
    expect(opened.single.toString(), 'https://connect.example/go');
  });

  testWidgets('a second account is offered once one is connected', (
    tester,
  ) async {
    final store = MemoryStore();
    final api = SettingsApi(
      store,
      (_, _) async => connectionsFrame(
        connected: 1,
        accounts: [
          {
            'id': 'conn-1',
            'label': 'Gmail',
            'packageId': 'connect',
            'connectionTypeId': 'connect-gmail',
            'kind': 'connector',
            'authorization': 'grant',
            'detail': 'Ready',
          },
        ],
      ),
    );
    await tester.pumpWidget(page(api, store));
    await tester.pumpAndSettle();
    // Collapsed, the row says only that it is connected; opening it shows
    // the account and the way to add another.
    expect(find.text('Connected'), findsOneWidget);
    expect(find.text('Add another account'), findsNothing);
    await tester.tap(find.text('Gmail'));
    await tester.pumpAndSettle();
    expect(find.text('Add another account'), findsOneWidget);
    expect(find.text('Ready'), findsOneWidget);
    await tester.tap(find.byTooltip('Manage Gmail'));
    await tester.pumpAndSettle();
    expect(find.text('Turn off'), findsOneWidget);
    expect(find.text('Disconnect'), findsOneWidget);
  });

  testWidgets('Connectors recovers from offline without raw backend detail', (
    tester,
  ) async {
    var offline = true;
    final store = MemoryStore();
    final api = SettingsApi(store, (_, _) async {
      if (offline) throw const RequestFailure('synthetic backend detail');
      return connectionsFrame(
        connected: 1,
        accounts: [
          {
            'id': 'conn-1',
            'label': 'Local Ollama',
            'detail': 'Ready · model list up to date',
          },
        ],
        mayConnect: false,
      );
    });
    await tester.pumpWidget(page(api, store, models: true));
    await tester.pumpAndSettle();
    expect(find.textContaining('synthetic backend'), findsNothing);
    expect(find.text('Provider accounts couldn’t load'), findsOneWidget);
    offline = false;
    await tester.tap(find.text('Try again'));
    await tester.pumpAndSettle();
    expect(find.text('Connect account'), findsNothing);
    await tester.tap(find.text('Ollama Cloud'));
    await tester.pumpAndSettle();
    expect(find.text('Ready · model list up to date'), findsOneWidget);
  });

  for (final brightness in Brightness.values) {
    testWidgets('Connectors stays readable at 200% ($brightness)', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final store = MemoryStore();
      final api = SettingsApi(
        store,
        (_, _) async => connectionsFrame(
          connected: 1,
          accounts: [
            {
              'id': 'conn-1',
              'label': 'My long work account label',
              'state': 'failed',
              'packageId': 'connect',
              'connectionTypeId': 'connect-gmail',
              'kind': 'connector',
              'authorization': 'grant',
              'detail': 'Not working',
              'failure': 'Sign-in didn’t finish. Connect it again.',
            },
          ],
        ),
      );
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(brightness),
          home: MediaQuery(
            data: const MediaQueryData(
              textScaler: TextScaler.linear(2),
              disableAnimations: true,
            ),
            child: ConnectionsPage(api: api, store: store, userId: 'tim'),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Needs attention'), findsOneWidget);
      await tester.tap(find.text('Gmail'));
      await tester.pumpAndSettle();
      expect(find.text('My long work account label'), findsOneWidget);
      expect(
        find.text('Sign-in didn’t finish. Connect it again.'),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    });
  }
}
