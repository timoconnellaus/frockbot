import 'dart:async';

import 'package:flutter/foundation.dart'
    show debugDefaultTargetPlatformOverride;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/connections/document.dart';
import 'package:frockbot_native/connections/door.dart';
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
      'installed': true,
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
      'installed': true,
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
        'installed': true,
        'description': 'Read and post messages in Slack.',
        'icon': 'slack',
      },
  ],
};

Map<String, Object?> catalogFrame({
  int revision = 1,
  String deepSeekState = 'not-installed',
  bool deepSeekKey = false,
}) {
  final installed = deepSeekState == 'installed';
  return {
    'schemaVersion': 1,
    'ownerId': 'tim',
    'revision': revision,
    'modelInUse': 'Auto · Frock AI',
    'accounts': <Map<String, Object?>>[
      if (deepSeekKey)
        {
          'id': 'conn-deepseek',
          'label': 'DeepSeek',
          'state': 'ready',
          'packageId': 'provider-deepseek',
          'connectionTypeId': 'deepseek-account',
          'kind': 'model',
          'authorization': 'api-key',
          'detail': 'Ready',
        },
    ],
    'providers': [
      {
        'packageId': 'provider-deepseek',
        'connectionTypeId': 'deepseek-account',
        'displayName': 'DeepSeek',
        'kind': 'model',
        'authorization': 'api-key',
        'connected': deepSeekKey ? 1 : 0,
        'mayConnect': installed && !deepSeekKey,
        'installed': installed,
        'description': 'Use DeepSeek models with your own key.',
        'icon': 'deepseek',
      },
      {
        'packageId': 'connect',
        'connectionTypeId': 'connect-gmail',
        'displayName': 'Gmail',
        'kind': 'connector',
        'authorization': 'grant',
        'connected': 0,
        'mayConnect': true,
        'installed': true,
        'description': 'Read, search, label and send email in a Gmail account.',
        'icon': 'gmail',
      },
    ],
  };
}

/// A model provider that takes a key or a sign-in: two rows, one per
/// Connection Type, both named for the provider, as the server sends them.
Map<String, Object?> twoWayFrame({bool installed = true}) => {
  'schemaVersion': 1,
  'ownerId': 'tim',
  'revision': 1,
  'modelInUse': 'Auto · Frock AI',
  'accounts': <Map<String, Object?>>[],
  'providers': [
    for (final (type, authorization) in [
      ('openrouter-account', 'api-key'),
      ('openrouter-oauth', 'grant'),
    ])
      {
        'packageId': 'provider-openrouter',
        'connectionTypeId': type,
        'displayName': 'OpenRouter',
        'kind': 'model',
        'authorization': authorization,
        'connected': 0,
        'mayConnect': installed,
        'installed': installed,
        'description': 'Use OpenRouter models with your own key, or sign in.',
        'icon': 'openrouter',
      },
  ],
};

/// What the server answers a Marketplace read with: [frame]'s rows searched
/// and filtered by the read's own query string, as `connectionsFrame` does.
Map<String, Object?> served(Map<String, Object?> frame, String path) {
  final uri = Uri.parse(path);
  expect(uri.path, '/api/settings/connections');
  expect(uri.queryParameters['catalog'], '1');
  final needle = (uri.queryParameters['q'] ?? '').trim().toLowerCase();
  final kinds =
      uri.queryParameters['kinds']?.split(',') ?? const ['model', 'connector'];
  final installed = uri.queryParameters['installed'] == '1';
  return {
    ...frame,
    'providers': [
      for (final row
          in (frame['providers'] as List).cast<Map<String, Object?>>())
        if (kinds.contains(row['kind']) &&
            (!installed ||
                (row['kind'] == 'model'
                    ? row['installed'] == true
                    : (row['connected'] as int) > 0)) &&
            [
              row['displayName'],
              row['description'],
              row['kind'],
              row['packageId'],
            ].whereType<String>().join(' ').toLowerCase().contains(needle))
          row,
    ],
  };
}

/// The MCP server row as the server sends it: one keyed Connection Type whose
/// address is a Connection setting, and any servers already added.
Map<String, Object?> mcpFrame({
  int revision = 1,
  List<Map<String, Object?>> accounts = const [],
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
        'packageId': 'mcp',
        'connectionTypeId': 'mcp-server',
        'kind': 'connector',
        'authorization': account['authorization'] ?? 'none',
        'detail': account['state'] == 'failed' ? 'Not working' : 'Ready',
        if (account['failure'] != null) 'failure': account['failure'],
      },
  ],
  'providers': [
    {
      'packageId': 'mcp',
      'connectionTypeId': 'mcp-server',
      'displayName': 'MCP servers',
      'kind': 'connector',
      'authorization': 'api-key',
      'connected': accounts.length,
      'mayConnect': true,
      'installed': true,
      'description': 'Add any remote MCP server by its address. Its tools become your Bots\' tools.',
      'settings': [
        {
          'id': 'url',
          'label': 'Server address',
          'kind': 'text',
          'value': null,
          'editable': true,
        },
      ],
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

  testWidgets('a door that connected nothing says why when it closes', (
    tester,
  ) async {
    final store = MemoryStore();
    final api = SettingsApi(store, (path, body) async => connectionsFrame());
    await tester.pumpWidget(page(api, store));
    await tester.pumpAndSettle();
    connectReturnNotice.value = mcpSignInRefusalV1(403);
    connectReturns.value += 1;
    await tester.pumpAndSettle();
    expect(
      find.text(
        'That sign-in was started from another FrockBot account, so nothing was connected.',
      ),
      findsOneWidget,
    );
    expect(connectReturnNotice.value, isNull);
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

  test('each app names its own return page, and a browser tab none', () {
    addTearDown(() => debugDefaultTargetPlatformOverride = null);
    for (final (platform, client) in [
      (TargetPlatform.android, 'android'),
      (TargetPlatform.macOS, 'macos'),
      (TargetPlatform.iOS, 'ios'),
      (TargetPlatform.linux, null),
    ]) {
      debugDefaultTargetPlatformOverride = platform;
      expect(connectReturnClientV1, client, reason: platform.name);
    }
  });

  test(
    'a return link is one of this app\'s three return pages, and nothing else',
    () {
      for (final link in [
        'https://bot.frockbot.com/api/connect/callback/android?status=success',
        'frockbot://bot.frockbot.com/api/connect/callback/macos',
        'frockbot://bot.frockbot.com/api/connect/callback/ios',
      ]) {
        expect(isConnectReturnV1(Uri.parse(link)), isTrue, reason: link);
      }
      for (final link in [
        // The browser-tab page: it never opens the app.
        'https://bot.frockbot.com/api/connect/callback?status=success',
        // Each client's page only on the scheme that page hands over on.
        'frockbot://bot.frockbot.com/api/connect/callback/android',
        'https://bot.frockbot.com/api/connect/callback/macos',
        // The FrockBot Dev builds' pages belong to those apps alone.
        'frockbot-dev://bot.frockbot.com/api/connect/callback/macos-dev',
        'frockbot://bot.frockbot.com/api/connect/callback/macos-dev',
        'frockbot-dev://bot.frockbot.com/api/connect/callback/ios-dev',
        'frockbot://bot.frockbot.com/api/connect/callback/ios-dev',
        // The iPhone's page is handed over on its scheme, never claimed.
        'https://bot.frockbot.com/api/connect/callback/ios',
        // Anything else under the callback path.
        'frockbot://bot.frockbot.com/api/connect/callback/windows',
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
      final api = SettingsApi(
        store,
        (_, _) async => connectionsFrame(twoApps: true),
      );

      tester.view.physicalSize = const Size(390, 844);
      await tester.pumpWidget(page(api, store));
      await tester.pumpAndSettle();
      expect(find.widgetWithText(AppBar, 'Marketplace'), findsOneWidget);
      expect(find.text('Connected apps'), findsNothing);
      // One below the other on a phone: only the connector rows are here, and
      // Slack sits under Gmail at the same left edge.
      final gmail = tester.getRect(find.text('Gmail'));
      final slack = tester.getRect(find.text('Slack'));
      expect(slack.top, greaterThan(gmail.bottom));
      expect((slack.left - gmail.left).abs(), lessThan(1));

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
      final left = tester.getRect(find.text('Gmail'));
      final right = tester.getRect(find.text('Slack'));
      expect(right.left, greaterThan(left.right));
      expect((right.top - left.top).abs(), lessThan(1));
      // The way out is the control the page draws, since a dialog has no bar
      // of its own to go back from.
      await tester.tap(find.byTooltip('Close marketplace'));
      await tester.pumpAndSettle();
      expect(find.byType(Dialog), findsNothing);
    },
  );

  testWidgets('Marketplace catalog searches, filters, and adds a model', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1280, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = MemoryStore();
    final sent = <Map<String, Object?>>[];
    var state = 'not-installed';
    var revision = 1;
    final reads = <String>[];
    final api = SettingsApi(store, (path, body) async {
      if (body == null) {
        reads.add(path);
        return served(
          catalogFrame(revision: revision, deepSeekState: state),
          path,
        );
      }
      expect(path, '/api/settings');
      final command = (body as Map).cast<String, Object?>();
      sent.add(command);
      expect(command['type'], 'user/choose-model-provider');
      expect(command['packageId'], 'provider-deepseek');
      state = 'installed';
      revision += 1;
      return {
        'schemaVersion': 1,
        'commandId': command['commandId'],
        'revision': revision,
        'status': 'applied',
      };
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: MarketplacePage(api: api, store: store, userId: 'tim'),
      ),
    );
    await tester.pumpAndSettle();
    expect(reads, ['/api/settings/connections?catalog=1']);
    expect(find.text('DeepSeek'), findsOneWidget);
    expect(find.text('Gmail'), findsOneWidget);
    expect(find.text('Add'), findsOneWidget);

    // The search is the server's, asked for once typing pauses.
    await tester.enterText(find.byType(TextField), 'dee');
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));
    await tester.enterText(find.byType(TextField), 'deep');
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    await tester.pumpAndSettle();
    expect(reads.skip(1), ['/api/settings/connections?catalog=1&q=deep']);
    expect(find.text('DeepSeek'), findsOneWidget);
    expect(find.text('Gmail'), findsNothing);

    // A kind box is read at once, with the search as it stands.
    await tester.enterText(find.byType(TextField), '');
    await tester.tap(find.text('Connectors'));
    await tester.pumpAndSettle();
    expect(reads.last, '/api/settings/connections?catalog=1&kinds=model');
    expect(find.text('DeepSeek'), findsOneWidget);
    expect(find.text('Gmail'), findsNothing);

    final readsBeforeRefresh = reads.length;
    await tester.tap(find.byTooltip('Refresh marketplace'));
    await tester.pumpAndSettle();
    expect(reads.length, greaterThan(readsBeforeRefresh));

    await tester.tap(find.text('Add'));
    await tester.pumpAndSettle();
    expect(sent.single['type'], 'user/choose-model-provider');
    // The key is the next thing asked for, so its form is already open.
    expect(find.text('Connect'), findsOneWidget);
    expect(find.text('Connect account'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'a provider with a key and a sign-in is one card in the catalog',
    (tester) async {
      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final store = MemoryStore();
      final api = SettingsApi(
        store,
        (_, _) async => twoWayFrame(installed: false),
      );
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: MarketplacePage(api: api, store: store, userId: 'tim'),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('OpenRouter'), findsOneWidget);
      expect(find.text('Add'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('its card offers both ways in, each on its own Connection Type', (
    tester,
  ) async {
    final store = MemoryStore();
    final opened = <Uri>[];
    final sent = <Map<String, Object?>>[];
    final api = SettingsApi(store, (path, body) async {
      if (body == null) return twoWayFrame();
      final command = (body as Map).cast<String, Object?>();
      sent.add({'path': path, ...command});
      if (command['type'] == 'connection/start') {
        return {
          'schemaVersion': 1,
          'status': 'authorization-required',
          'connectionId': 'conn-oauth',
          'redirectUrl': 'https://openrouter.example/authorize',
          'expiresAt': '2026-09-11T00:10:00.000Z',
        };
      }
      return {
        'schemaVersion': 1,
        'commandId': command['commandId'],
        'connectionId': 'conn-key',
        'status': 'applied',
      };
    });
    // The Provider accounts page Models opens is the same card.
    await tester.pumpWidget(
      page(
        api,
        store,
        models: true,
        openBrowser: (uri) async {
          opened.add(uri);
          return true;
        },
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('OpenRouter'), findsOneWidget);
    // Connect opens the card on both ways rather than choosing one.
    await tester.tap(find.text('Connect'));
    await tester.pumpAndSettle();
    expect(sent, isEmpty);
    expect(find.text('Use an API key'), findsOneWidget);
    expect(find.text('Sign in'), findsOneWidget);

    await tester.tap(find.text('Sign in'));
    await tester.pumpAndSettle();
    expect(sent.single['type'], 'connection/start');
    expect(sent.single['connectionTypeId'], 'openrouter-oauth');
    expect(opened.single.toString(), 'https://openrouter.example/authorize');

    await tester.tap(find.text('Use an API key'));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.widgetWithText(TextField, 'API key'),
      'synthetic-test-key',
    );
    await tester.tap(find.widgetWithText(FilledButton, 'Connect account'));
    await tester.pumpAndSettle();
    expect(sent.last['type'], 'connection/create-api-key');
    expect(sent.last['connectionTypeId'], 'openrouter-account');
    expect(tester.takeException(), isNull);
  });

  testWidgets('a removed model that kept its key is offered again', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1280, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = MemoryStore();
    final api = SettingsApi(
      store,
      (path, _) async => served(catalogFrame(deepSeekKey: true), path),
    );
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: MarketplacePage(api: api, store: store, userId: 'tim'),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Add'), findsOneWidget);
    expect(find.text('Connected'), findsNothing);
    await tester.tap(find.text('Installed'));
    await tester.pumpAndSettle();
    expect(find.text('DeepSeek'), findsNothing);
  });

  testWidgets('a connected model leads on to choosing it', (tester) async {
    tester.view.physicalSize = const Size(1280, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = MemoryStore();
    final paths = <String>[];
    final api = SettingsApi(store, (path, body) async {
      paths.add(path);
      if (path.startsWith('/api/settings/models')) {
        return {
          'schemaVersion': 1,
          'surfaceId': 'settings-models',
          'revision': 1,
          'root': {
            'type': 'group',
            'orientation': 'column',
            'children': <Object>[],
          },
          'actions': <Object>[],
        };
      }
      return catalogFrame(deepSeekState: 'installed', deepSeekKey: true);
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: MarketplacePage(api: api, store: store, userId: 'tim'),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('DeepSeek'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Choose a model'));
    await tester.pumpAndSettle();
    expect(paths.last, startsWith('/api/settings/models'));
    expect(find.text('Models'), findsWidgets);
    expect(tester.takeException(), isNull);
  });

  testWidgets('Marketplace installed configures and removes an added model', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1280, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = MemoryStore();
    final sent = <Map<String, Object?>>[];
    var state = 'not-installed';
    var revision = 1;
    final api = SettingsApi(store, (path, body) async {
      if (body == null) {
        return served(
          catalogFrame(revision: revision, deepSeekState: state),
          path,
        );
      }
      expect(path, '/api/settings');
      final command = (body as Map).cast<String, Object?>();
      sent.add(command);
      if (command['type'] == 'user/choose-model-provider') {
        state = 'installed';
      } else {
        expect(command['type'], 'user/uninstall-package');
        expect(command['packageId'], 'provider-deepseek');
        state = 'not-installed';
      }
      revision += 1;
      return {
        'schemaVersion': 1,
        'commandId': command['commandId'],
        'revision': revision,
        'status': 'applied',
      };
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: MarketplacePage(api: api, store: store, userId: 'tim'),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Models'), findsOneWidget);
    expect(find.text('Connectors'), findsOneWidget);
    expect(find.text('Catalog'), findsOneWidget);
    expect(find.text('Installed'), findsOneWidget);

    await tester.tap(find.text('Installed'));
    await tester.pumpAndSettle();
    expect(
      find.text(
        'Nothing installed yet. Add a model or connect an app in Catalog.',
      ),
      findsOneWidget,
    );
    expect(find.text('DeepSeek'), findsNothing);

    await tester.tap(find.text('Catalog'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Add'));
    await tester.pumpAndSettle();
    expect(sent.single['type'], 'user/choose-model-provider');

    await tester.tap(find.text('Installed'));
    await tester.pumpAndSettle();
    expect(find.text('DeepSeek'), findsOneWidget);
    expect(find.text('Gmail'), findsNothing);

    await tester.tap(find.text('DeepSeek'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(TextButton, 'Remove'));
    await tester.pumpAndSettle();
    expect(find.text('Remove DeepSeek?'), findsOneWidget);
    await tester.tap(find.widgetWithText(TextButton, 'Remove').last);
    await tester.pumpAndSettle();
    expect(sent.last['type'], 'user/uninstall-package');
    expect(find.text('DeepSeek'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('Marketplace reads its next page as the list reaches its end', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1280, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = MemoryStore();
    final reads = <String>[];
    var outage = true;
    const apps = 55;
    final api = SettingsApi(store, (path, body) async {
      reads.add(path);
      final query = Uri.parse(path).queryParameters;
      final cursor = int.parse(query['cursor'] ?? '0');
      final limit = int.parse(query['limit'] ?? '50');
      if (cursor > 0 && outage) {
        outage = false;
        throw StateError('synthetic backend outage');
      }
      final end = cursor + limit < apps ? cursor + limit : apps;
      return {
        'schemaVersion': 1,
        'ownerId': 'tim',
        'revision': 1,
        'accounts': <Object>[],
        'providers': [
          for (var i = cursor; i < end; i++)
            {
              'packageId': 'connect',
              'connectionTypeId': 'connect-app-$i',
              'displayName': 'App $i',
              'kind': 'connector',
              'authorization': 'grant',
              'connected': 0,
              'mayConnect': true,
              'installed': true,
              'description': 'App number $i.',
            },
        ],
        if (end < apps) 'nextCursor': end,
      };
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: MarketplacePage(api: api, store: store, userId: 'tim'),
      ),
    );
    await tester.pumpAndSettle();
    expect(reads, ['/api/settings/connections?catalog=1']);
    final list = find
        .descendant(
          of: find.byType(CustomScrollView),
          matching: find.byType(Scrollable),
        )
        .first;

    // The end of the list asks for the next page; one that fails waits for a
    // press rather than asking again on every frame.
    await tester.scrollUntilVisible(
      find.text('Couldn’t load more. Try again'),
      600,
      scrollable: list,
    );
    await tester.pumpAndSettle();
    expect(reads.skip(1), ['/api/settings/connections?catalog=1&cursor=50']);
    await tester.tap(find.text('Couldn’t load more. Try again'));
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(find.text('App 54'), 600, scrollable: list);
    expect(reads.last, '/api/settings/connections?catalog=1&cursor=50');
    expect(find.text('Couldn’t load more. Try again'), findsNothing);

    // A read that settles a press keeps every card already drawn, so the list
    // keeps its place.
    await tester.tap(find.byTooltip('Refresh marketplace'));
    await tester.pumpAndSettle();
    expect(reads.last, '/api/settings/connections?catalog=1&limit=55');
    expect(find.text('App 54'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('Marketplace host refresh retries a failed catalog read', (
    tester,
  ) async {
    final store = MemoryStore();
    var catalogReadFailed = true;
    final api = SettingsApi(store, (path, body) async {
      expect(path, '/api/settings/connections?catalog=1');
      if (catalogReadFailed) {
        catalogReadFailed = false;
        throw StateError('synthetic backend outage');
      }
      return catalogFrame();
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: MarketplacePage(api: api, store: store, userId: 'tim'),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Marketplace couldn’t load'), findsOneWidget);

    await tester.tap(find.byTooltip('Refresh marketplace'));
    await tester.pumpAndSettle();
    expect(find.text('DeepSeek'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('turning an account off says so at once, and one row waits', (
    tester,
  ) async {
    final store = MemoryStore();
    final sent = <Map<String, Object?>>[];
    final gate = Completer<void>();
    var state = 'ready';
    final api = SettingsApi(store, (path, body) async {
      if (body == null) {
        return connectionsFrame(
          twoApps: true,
          connected: 1,
          accounts: [
            {
              'id': 'conn-1',
              'label': 'Gmail account',
              'state': state,
              'packageId': 'connect',
              'connectionTypeId': 'connect-gmail',
              'kind': 'connector',
              'authorization': 'grant',
            },
            {
              'id': 'conn-2',
              'label': 'Slack account',
              'packageId': 'connect',
              'connectionTypeId': 'connect-slack',
              'kind': 'connector',
              'authorization': 'grant',
            },
          ],
        );
      }
      sent.add((body as Map).cast<String, Object?>());
      await gate.future;
      state = 'disabled';
      return {
        'schemaVersion': 1,
        'commandId': body['commandId'],
        'connectionId': 'conn-1',
        'status': 'applied',
      };
    });
    await tester.pumpWidget(page(api, store));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Gmail'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Slack'));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Manage Gmail account'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Turn off'));
    await tester.pumpAndSettle();
    // The command is still in flight: what the row says is what this client
    // sent, and only that row is waiting on it.
    expect(sent.single['type'], 'connection/set-enabled');
    expect(sent.single['enabled'], isFalse);
    expect(find.text('Turned off'), findsOneWidget);
    PopupMenuButton<String> manage(String label) =>
        tester.widget<PopupMenuButton<String>>(
          find.ancestor(
            of: find.byTooltip('Manage $label'),
            matching: find.byType(PopupMenuButton<String>),
          ),
        );
    expect(manage('Gmail account').enabled, isFalse);
    expect(manage('Slack account').enabled, isTrue);
    gate.complete();
    await tester.pumpAndSettle();
    expect(find.text('Turned off'), findsOneWidget);
    expect(manage('Gmail account').enabled, isTrue);
  });
  group('an MCP server', () {
    test('with a token is a keyed Connection carrying its address', () {
      final action = mcpServerActionV1(
        commandId: 'c1',
        index: 0,
        connectionTypeId: 'mcp-server',
        address: Uri.parse('https://mcp.linear.app/mcp'),
        name: '',
        token: 'synthetic-token',
      );
      expect(connectionRequestV1(action).body, {
        'schemaVersion': 1,
        'type': 'connection/create-api-key',
        'commandId': 'c1',
        'packageId': 'mcp',
        'connectionTypeId': 'mcp-server',
        'label': 'mcp.linear.app',
        'apiKey': 'synthetic-token',
        'settings': {'url': 'https://mcp.linear.app/mcp'},
      });
    });

    test('without one is a plain Connection', () {
      final action = mcpServerActionV1(
        commandId: 'c2',
        index: 3,
        connectionTypeId: 'mcp-server',
        address: Uri.parse('https://mcp.example.com/sse'),
        name: ' Docs ',
        token: '',
      );
      expect(connectionRequestV1(action).body, {
        'schemaVersion': 1,
        'type': 'connection/create',
        'commandId': 'c2',
        'packageId': 'mcp',
        'connectionTypeId': 'mcp-server',
        'label': 'Docs',
        'settings': {'url': 'https://mcp.example.com/sse'},
      });
    });

    test('refuses an address that is not https before anything is sent', () {
      expect(mcpServerAddressV1('').problem, isNotNull);
      expect(mcpServerAddressV1('mcp.example.com').problem, isNotNull);
      expect(mcpServerAddressV1('http://mcp.example.com').problem, isNotNull);
      expect(
        mcpServerAddressV1(' https://mcp.example.com/mcp ').uri,
        Uri.parse('https://mcp.example.com/mcp'),
      );
    });
  });

  testWidgets('an MCP server is added by its address, with no key asked for', (
    tester,
  ) async {
    final store = MemoryStore();
    final sent = <Map<String, Object?>>[];
    final api = SettingsApi(store, (path, body) async {
      if (body == null) return mcpFrame();
      sent.add((body as Map).cast<String, Object?>());
      return {
        'schemaVersion': 1,
        'commandId': body['commandId'],
        'connectionId': 'conn-1',
        'status': 'applied',
      };
    });
    await tester.pumpWidget(page(api, store));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Connect'));
    await tester.pumpAndSettle();
    expect(find.widgetWithText(TextField, 'API key'), findsNothing);
    await tester.enterText(
      find.widgetWithText(TextField, 'Server address'),
      'mcp.example.com',
    );
    await tester.tap(find.widgetWithText(FilledButton, 'Add server'));
    await tester.pumpAndSettle();
    expect(sent, isEmpty);
    expect(find.textContaining('full https address'), findsOneWidget);
    await tester.enterText(
      find.widgetWithText(TextField, 'Server address'),
      'https://mcp.example.com/mcp',
    );
    await tester.tap(find.widgetWithText(FilledButton, 'Add server'));
    await tester.pumpAndSettle();
    expect(sent.single, {
      'schemaVersion': 1,
      'type': 'connection/create',
      'commandId': sent.single['commandId'],
      'packageId': 'mcp',
      'connectionTypeId': 'mcp-server',
      'label': 'mcp.example.com',
      'settings': {'url': 'https://mcp.example.com/mcp'},
    });
  });

  testWidgets('an MCP server refreshes its tools and is removed, not revoked', (
    tester,
  ) async {
    final store = MemoryStore();
    final sent = <Map<String, Object?>>[];
    final api = SettingsApi(store, (path, body) async {
      if (body == null) {
        return mcpFrame(
          accounts: [
            {'id': 'conn-1', 'label': 'Linear'},
          ],
        );
      }
      sent.add({'path': path, ...(body as Map).cast<String, Object?>()});
      return {
        'schemaVersion': 1,
        'commandId': body['commandId'],
        'connectionId': 'conn-1',
        'status': 'applied',
      };
    });
    await tester.pumpWidget(page(api, store));
    await tester.pumpAndSettle();
    await tester.tap(find.text('MCP servers'));
    await tester.pumpAndSettle();
    expect(find.text('Add another server'), findsOneWidget);
    await tester.tap(find.byTooltip('Manage Linear'));
    await tester.pumpAndSettle();
    expect(find.text('Refresh models'), findsNothing);
    await tester.tap(find.text('Refresh tools'));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Manage Linear'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Remove'));
    await tester.pumpAndSettle();
    expect(sent.map((request) => request['type']), [
      'connection/refresh-models',
      'connection/disconnect',
    ]);
    expect(sent.map((request) => request['path']).toSet(), {
      '/api/connections',
    });
  });

  group('an MCP server sign-in', () {
    test('a return link carrying a server\'s answer is sent back to finish', () {
      final completion = mcpSignInCompletionV1(
        Uri.parse(
          'https://bot.frockbot.com/api/connect/callback/android'
          '?mcp_state=s.1&mcp_code=c%2B1&mcp_iss=https%3A%2F%2Fauth.example'
          '&connectedAccountId=ca_1',
        ),
      )!;
      expect(completion.path, '/api/mcp/oauth/complete');
      expect(completion.body, {
        'schemaVersion': 1,
        'state': 's.1',
        'code': 'c+1',
        'iss': 'https://auth.example',
      });
      expect(
        mcpSignInCompletionV1(
          Uri.parse(
            'frockbot://bot.frockbot.com/api/connect/callback/macos'
            '?mcp_state=s.1&mcp_error=access_denied',
          ),
        )!.body,
        {'schemaVersion': 1, 'state': 's.1', 'error': 'access_denied'},
      );
      // A connected app's own return carries none, and finishes nothing.
      for (final link in [
        'https://bot.frockbot.com/api/connect/callback/android?status=success',
        'https://bot.frockbot.com/api/connect/callback/android?mcp_state=',
      ]) {
        expect(mcpSignInCompletionV1(Uri.parse(link)), isNull, reason: link);
      }
      expect(mcpSignInRefusalV1(403), contains('another FrockBot account'));
      expect(mcpSignInRefusalV1(400), contains('Sign in to the server again'));
    });

    test('is the server\'s own door, and a token change is a command', () {
      expect(
        mcpSignInRequestV1({
          'commandId': 'c1',
          'input': {
            'kind': 'sign-in',
            'connectionId': 'conn/1',
            'returnClient': 'android',
          },
        }).path,
        '/api/plugins/mcp/connections/conn%2F1/authorize',
      );
      expect(
        mcpSignInRequestV1({
          'commandId': 'c1',
          'input': {'kind': 'sign-in', 'connectionId': 'conn-1'},
        }).body,
        {
          'schemaVersion': 1,
          'type': 'connection/start',
          'commandId': 'c1',
          'connectionTypeId': 'mcp-server',
        },
      );
      final rotate = connectionRequestV1({
        'commandId': 'c2',
        'input': {
          'kind': 'rotate-api-key',
          'connectionId': 'conn-1',
          'apiKey': ' sk-new ',
        },
      });
      expect(rotate.path, '/api/connections');
      expect(rotate.body, {
        'schemaVersion': 1,
        'type': 'connection/rotate-api-key',
        'commandId': 'c2',
        'connectionId': 'conn-1',
        'apiKey': 'sk-new',
      });
      expect(
        () => connectionRequestV1({
          'commandId': 'c3',
          'input': {'kind': 'rotate-api-key', 'connectionId': 'conn-1'},
        }),
        throwsFormatException,
      );
    });
  });

  testWidgets('a server that asks for a sign-in is signed in to from its row', (
    tester,
  ) async {
    final store = MemoryStore();
    final sent = <Map<String, Object?>>[];
    final opened = <Uri>[];
    final api = SettingsApi(store, (path, body) async {
      if (body == null) {
        return mcpFrame(
          accounts: [
            {
              'id': 'conn-1',
              'label': 'Linear',
              'state': 'failed',
              'authorization': 'grant',
              'failure': 'This server asks you to sign in.',
            },
          ],
        );
      }
      sent.add({'path': path, ...(body as Map).cast<String, Object?>()});
      return {
        'schemaVersion': 1,
        'status': 'authorization-required',
        'connectionId': 'conn-1',
        'redirectUrl': 'https://auth.linear.app/authorize?state=s',
        'expiresAt': '2026-09-24T00:10:00.000Z',
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
    await tester.tap(find.text('MCP servers'));
    await tester.pumpAndSettle();
    expect(find.text('This server asks you to sign in.'), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, 'Sign in'));
    await tester.pumpAndSettle();
    expect(
      sent.single['path'],
      '/api/plugins/mcp/connections/conn-1/authorize',
    );
    expect(sent.single['type'], 'connection/start');
    expect(opened, [Uri.parse('https://auth.linear.app/authorize?state=s')]);
  });

  testWidgets('a server added without a token goes on to its sign-in', (
    tester,
  ) async {
    final store = MemoryStore();
    final sent = <Map<String, Object?>>[];
    final opened = <Uri>[];
    var added = false;
    final api = SettingsApi(store, (path, body) async {
      if (body == null) {
        return mcpFrame(
          accounts: [
            if (added)
              {
                'id': 'conn-1',
                'label': 'mcp.linear.app',
                'state': 'failed',
                'authorization': 'grant',
              },
          ],
        );
      }
      sent.add({'path': path, ...(body as Map).cast<String, Object?>()});
      if (path == '/api/connections') {
        added = true;
        return {
          'schemaVersion': 1,
          'commandId': body['commandId'],
          'connectionId': 'conn-1',
          'status': 'failed',
        };
      }
      return {
        'schemaVersion': 1,
        'status': 'authorization-required',
        'connectionId': 'conn-1',
        'redirectUrl': 'https://auth.linear.app/authorize',
        'expiresAt': '2026-09-24T00:10:00.000Z',
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
    await tester.tap(find.text('Connect'));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.widgetWithText(TextField, 'Server address'),
      'https://mcp.linear.app/mcp',
    );
    await tester.tap(find.widgetWithText(FilledButton, 'Add server'));
    await tester.pumpAndSettle();
    expect(sent.map((request) => request['path']), [
      '/api/connections',
      '/api/plugins/mcp/connections/conn-1/authorize',
    ]);
    expect(opened, [Uri.parse('https://auth.linear.app/authorize')]);
  });

  testWidgets('a server\'s token is changed in place, and a refusal said', (
    tester,
  ) async {
    final store = MemoryStore();
    final sent = <Map<String, Object?>>[];
    final api = SettingsApi(store, (path, body) async {
      if (body == null) {
        return mcpFrame(
          accounts: [
            {'id': 'conn-1', 'label': 'Work', 'authorization': 'api-key'},
          ],
        );
      }
      sent.add((body as Map).cast<String, Object?>());
      return {
        'schemaVersion': 1,
        'commandId': body['commandId'],
        'connectionId': 'conn-1',
        'status': 'failed',
      };
    });
    await tester.pumpWidget(page(api, store));
    await tester.pumpAndSettle();
    await tester.tap(find.text('MCP servers'));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Manage Work'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Change token'));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.widgetWithText(TextField, 'Access token'),
      'sk-new',
    );
    await tester.tap(find.widgetWithText(FilledButton, 'Save token'));
    await tester.pumpAndSettle();
    expect(sent.single, {
      'schemaVersion': 1,
      'type': 'connection/rotate-api-key',
      'commandId': sent.single['commandId'],
      'connectionId': 'conn-1',
      'apiKey': 'sk-new',
    });
    expect(find.text('The server didn’t take that token.'), findsOneWidget);
  });
}
