import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/connections/document.dart';
import 'package:frockbot_native/connections/page.dart';
import 'package:frockbot_native/shell/semantics.dart';
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
  bool twoApps = false,
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
    if (twoApps)
      {
        'packageId': 'connect',
        'connectionTypeId': 'connect-slack',
        'displayName': 'Slack',
        'kind': 'connector',
        'authorization': 'grant',
        'connected': 0,
        'mayConnect': true,
        'description': 'Read and post messages in Slack.',
        'icon': 'slack',
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
    // The test platform is Android: the app names the verified link as the
    // page it can come back through.
    expect(sent.single['returnClient'], 'android');
    expect(opened.single.toString(), 'https://connect.example/go');
  });

  testWidgets(
    'only the pressed Connect shows the wait; the rest stay as they are',
    (tester) async {
      final store = MemoryStore();
      final settle = Completer<Object?>();
      final api = SettingsApi(store, (path, body) async {
        if (body == null) return connectionsFrame(twoApps: true);
        return settle.future;
      });
      await tester.pumpWidget(page(api, store, openBrowser: (_) async => true));
      await tester.pumpAndSettle();
      expect(find.text('Connect'), findsNWidgets(2));
      await tester.tap(find.text('Connect').first);
      await tester.pump();
      // Gmail's pill spins and keeps its colour; Slack's is untouched and
      // still enabled — a press on it while Gmail settles does nothing.
      expect(find.bySemanticsLabel('Connecting'), findsOneWidget);
      final pills = tester.widgetList<FilledButton>(find.byType(FilledButton));
      expect(pills.every((pill) => pill.onPressed != null), isTrue);
      await tester.tap(find.text('Connect').last, warnIfMissed: false);
      await tester.pump();
      expect(find.bySemanticsLabel('Connecting'), findsOneWidget);
      settle.complete({
        'schemaVersion': 1,
        'status': 'authorization-required',
        'connectionId': 'conn-2',
        'redirectUrl': 'https://connect.example/go',
        'expiresAt': '2026-09-11T00:10:00.000Z',
      });
      await tester.pumpAndSettle();
      expect(find.bySemanticsLabel('Connecting'), findsNothing);
    },
  );

  testWidgets('a hosted door closing into the app reads the frame again', (
    tester,
  ) async {
    final store = MemoryStore();
    var reads = 0;
    final api = SettingsApi(store, (path, body) async {
      reads += 1;
      return connectionsFrame();
    });
    await tester.pumpWidget(page(api, store));
    await tester.pumpAndSettle();
    expect(reads, 1);
    connectReturns.value += 1;
    await tester.pumpAndSettle();
    expect(reads, 2);
  });

  testWidgets('a door closing while a read is in flight still re-reads', (
    tester,
  ) async {
    final store = MemoryStore();
    final gates = <Completer<void>>[];
    var reads = 0;
    final api = SettingsApi(store, (path, body) async {
      reads += 1;
      final gate = Completer<void>();
      gates.add(gate);
      await gate.future;
      return connectionsFrame();
    });
    await tester.pumpWidget(page(api, store));
    await tester.pump();
    expect(reads, 1);
    // The return lands while the first read is still out: it must not be
    // swallowed by the read already in flight.
    connectReturns.value += 1;
    await tester.pump();
    gates.first.complete();
    await tester.pump();
    await tester.pump();
    expect(reads, 2);
    gates.last.complete();
    await tester.pumpAndSettle();
  });

  test(
    'a return link is one of this app\'s two return pages, and nothing else',
    () {
      for (final link in [
        'https://bot.frockbot.com/api/connect/callback/android?status=success',
        'frockbot://bot.frockbot.com/api/connect/callback/macos',
      ]) {
        expect(isConnectReturnV1(Uri.parse(link)), isTrue, reason: link);
      }
      for (final link in [
        // The browser-tab page: it never opens the app.
        'https://bot.frockbot.com/api/connect/callback?status=success',
        // Each client's page only on the scheme that page hands over on.
        'frockbot://bot.frockbot.com/api/connect/callback/android',
        'https://bot.frockbot.com/api/connect/callback/macos',
        // Anything else under the callback path.
        'https://bot.frockbot.com/api/connect/callback/ios',
        'https://bot.frockbot.com/api/connect/callback/android/extra',
        'https://bot.frockbot.com/native/return/android?code=1&state=2',
        'https://bot.frockbot.com/?bot=primary',
        'https://bot.frockbot.com/api/connect/callbacks',
        'http://bot.frockbot.com/api/connect/callback/android',
      ]) {
        expect(isConnectReturnV1(Uri.parse(link)), isFalse, reason: link);
      }
    },
  );

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

  testWidgets('a turned-off account reads as turned off, not connecting', (
    tester,
  ) async {
    final store = MemoryStore();
    final api = SettingsApi(
      store,
      (_, _) async => connectionsFrame(
        accounts: [
          {
            'id': 'conn-1',
            'label': 'Gmail',
            'state': 'disabled',
            'packageId': 'connect',
            'connectionTypeId': 'connect-gmail',
            'kind': 'connector',
            'authorization': 'grant',
          },
        ],
      ),
    );
    await tester.pumpWidget(page(api, store));
    await tester.pumpAndSettle();
    expect(find.text('Turned off'), findsOneWidget);
    expect(find.text('Connecting…'), findsNothing);
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

  testWidgets('a refresh that fails after a good load says so', (tester) async {
    var offline = false;
    final store = MemoryStore();
    final api = SettingsApi(store, (_, _) async {
      if (offline) throw const RequestFailure('synthetic backend detail');
      return connectionsFrame(
        connected: 1,
        accounts: [
          {
            'id': 'conn-1',
            'label': 'Work',
            'packageId': 'connect',
            'connectionTypeId': 'connect-gmail',
            'kind': 'connector',
            'authorization': 'grant',
            'state': 'authorizing',
          },
        ],
      );
    });
    await tester.pumpWidget(page(api, store));
    await tester.pumpAndSettle();
    expect(find.text('Gmail'), findsOneWidget);
    expect(find.textContaining('Couldn’t load your connectors'), findsNothing);

    offline = true;
    await tester.fling(find.byType(ListView), const Offset(0, 320), 1000);
    await tester.pumpAndSettle();

    expect(find.text('Gmail'), findsOneWidget);
    expect(find.textContaining('synthetic backend'), findsNothing);
    expect(
      find.textContaining('Couldn’t load your connectors'),
      findsOneWidget,
    );

    offline = false;
    await tester.fling(find.byType(ListView), const Offset(0, 320), 1000);
    await tester.pumpAndSettle();

    expect(find.text('Gmail'), findsOneWidget);
    expect(find.textContaining('Couldn’t load your connectors'), findsNothing);
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

  testWidgets(
    'the Marketplace is one column on a phone and three in a dialog',
    (tester) async {
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final store = MemoryStore();
      final api = SettingsApi(store, (_, _) async => connectionsFrame());

      tester.view.physicalSize = const Size(390, 844);
      await tester.pumpWidget(page(api, store));
      await tester.pumpAndSettle();
      expect(find.widgetWithText(AppBar, 'Marketplace'), findsOneWidget);
      expect(find.text('Connected apps'), findsNothing);
      // One below the other on a phone: only the connector rows are here, and
      // Gmail sits under the Mac Messages row at the same left edge.
      final mac = tester.getRect(find.text('Messages on your Mac'));
      final gmail = tester.getRect(find.text('Gmail'));
      expect(gmail.top, greaterThan(mac.bottom));
      expect((gmail.left - mac.left).abs(), lessThan(1));

      tester.view.physicalSize = const Size(1280, 900);
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: Scaffold(
            body: Builder(
              builder: (context) => Center(
                child: FilledButton(
                  onPressed: () => showDialog<void>(
                    context: context,
                    builder: (_) => MarketplaceDialog(
                      api: api,
                      store: store,
                      userId: 'tim',
                    ),
                  ),
                  child: const Text('Open'),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Open'));
      await tester.pumpAndSettle();
      expect(find.byType(Dialog), findsOneWidget);
      expect(find.widgetWithText(AppBar, 'Marketplace'), findsOneWidget);
      expect(
        find.byWidgetPredicate(
          (widget) =>
              widget is Semantics &&
              widget.properties.identifier == ConnectorIds.group('Gmail'),
        ),
        findsOneWidget,
      );
      // Two rows side by side on one line, wide.
      final left = tester.getRect(find.text('Messages on your Mac'));
      final right = tester.getRect(find.text('Gmail'));
      expect(right.left, greaterThan(left.right));
      expect((right.top - left.top).abs(), lessThan(1));
      // The way out is the control the page draws, since a dialog has no bar
      // of its own to go back from.
      await tester.tap(find.byTooltip('Close marketplace'));
      await tester.pumpAndSettle();
      expect(find.byType(Dialog), findsNothing);
    },
  );
}
