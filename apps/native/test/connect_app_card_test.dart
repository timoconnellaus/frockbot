import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/cards/chat_card.dart';
import 'package:frockbot_native/cards/connections.dart';
import 'package:frockbot_native/cards/frock_catalog/frock_catalog.dart';
import 'package:frockbot_native/shell/connect_cards.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'cards_test.dart' show cardJson;
import 'connections_test.dart' show connectionsFrame;
import 'settings_test.dart' show SettingsApi;
import 'widget_test.dart' show MemoryStore;

/// The offer the `connectors` Plugin draws, as the kernel recorded it: the
/// Bot's reason, and the app bound to what it connects.
List<Map<String, Object?>> offer({bool bound = true}) => [
  {
    'id': 'root',
    'component': 'Column',
    'children': ['reason', 'connect'],
  },
  {
    'id': 'reason',
    'component': 'Markdown',
    'text': 'So I can check your inbox for the invoice.',
  },
  {
    'id': 'connect',
    'component': 'ConnectApp',
    'app': 'gmail',
    if (bound) ...{
      'name': 'Gmail',
      'description': 'Read, search, label and send email in a Gmail account.',
      'packageId': 'connect',
      'connectionTypeId': 'connect-gmail',
    },
  },
];

/// What the account says about one app, and the presses the card made.
class FakeConnections extends ChangeNotifier implements CardConnectionsV1 {
  CardConnectionStateV1? state;
  final presses = <(String, String)>[];
  FakeConnections([this.state]);

  @override
  CardConnectionStateV1? connectionStateV1(String connectionTypeId) => state;

  @override
  Future<void> connectV1({
    required String packageId,
    required String connectionTypeId,
  }) async {
    presses.add((packageId, connectionTypeId));
  }
}

void main() {
  /// Every request the card made, so a test can say none was an action.
  late List<(String, Object?)> requests;

  Future<void> draw(
    WidgetTester tester, {
    CardConnectionsV1? connections,
    bool bound = true,
  }) async {
    requests = [];
    final api = SettingsApi(MemoryStore(), (path, body) async {
      requests.add((path, body));
      return cardJson(
        components: offer(bound: bound),
        dataModel: {},
      );
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.light),
        home: Scaffold(
          body: CardChatScope(
            api: api,
            botId: 'bot-1',
            child: CardConnectionsScope(
              connections: connections,
              child: const CardChatCard(surfaceId: 'draft-1'),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  group('ConnectApp on a card', () {
    testWidgets('draws the app the kernel named, with its door', (
      tester,
    ) async {
      final connections = FakeConnections(const CardConnectionStateV1());
      await draw(tester, connections: connections);
      expect(
        find.text('So I can check your inbox for the invoice.'),
        findsOneWidget,
      );
      expect(find.text('Gmail'), findsOneWidget);
      expect(
        find.text('Read, search, label and send email in a Gmail account.'),
        findsOneWidget,
      );
      await tester.tap(find.text('Connect Gmail'));
      await tester.pumpAndSettle();
      expect(connections.presses, [('connect', 'connect-gmail')]);
      // The press is the person's own door, never a Card action the Bot
      // receives: the only request the card made was the read that drew it.
      expect(requests.every((request) => request.$2 == null), isTrue);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('says the app is connected once the account holds it', (
      tester,
    ) async {
      await draw(
        tester,
        connections: FakeConnections(const CardConnectionStateV1(ready: 1)),
      );
      expect(find.text('Connected'), findsOneWidget);
      expect(find.byType(FilledButton), findsNothing);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('tells the person where they are while signing in', (
      tester,
    ) async {
      await draw(
        tester,
        connections: FakeConnections(const CardConnectionStateV1(opened: true)),
      );
      expect(
        find.text('Finish signing in on Gmail’s page, then come back here.'),
        findsOneWidget,
      );
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('offers no press it cannot keep', (tester) async {
      // No account to connect with — a preview.
      await draw(tester);
      expect(
        tester.widget<FilledButton>(find.byType(FilledButton)).onPressed,
        isNull,
      );
      // A component the kernel never bound names no Connection Type.
      await draw(tester, connections: FakeConnections(), bound: false);
      expect(find.text('Connect gmail'), findsOneWidget);
      expect(
        tester.widget<FilledButton>(find.byType(FilledButton)).onPressed,
        isNull,
      );
      await tester.pumpWidget(const SizedBox());
    });
  });

  group('the account behind it', () {
    test('counts the working accounts of each app', () async {
      final controller = ConnectCardsController(
        api: SettingsApi(
          MemoryStore(),
          (path, body) async => connectionsFrame(
            accounts: [
              {
                'id': 'c-1',
                'label': 'tim@example.com',
                'packageId': 'connect',
                'connectionTypeId': 'connect-gmail',
                'kind': 'connector',
                'authorization': 'grant',
              },
              {
                'id': 'c-2',
                'label': 'Team',
                'state': 'failed',
                'packageId': 'connect',
                'connectionTypeId': 'connect-slack',
                'kind': 'connector',
                'authorization': 'grant',
              },
            ],
          ),
        ),
      );
      expect(controller.connectionStateV1('connect-gmail'), isNull);
      await controller.load();
      expect(controller.connectionStateV1('connect-gmail')?.ready, 1);
      expect(controller.connectionStateV1('connect-slack')?.ready, 0);
      controller.dispose();
    });

    test('reads again when asked while a read is out', () async {
      final reads = <Completer<Object?>>[];
      final controller = ConnectCardsController(
        api: SettingsApi(MemoryStore(), (path, body) {
          final read = Completer<Object?>();
          reads.add(read);
          return read.future;
        }),
      );
      final first = controller.load();
      // The person comes back from signing in while the first read is out.
      unawaited(controller.load());
      reads.single.complete(connectionsFrame());
      await pumpEventQueue();
      expect(reads, hasLength(2));
      reads.last.complete(
        connectionsFrame(
          accounts: [
            {
              'id': 'c-1',
              'label': 'tim@example.com',
              'packageId': 'connect',
              'connectionTypeId': 'connect-gmail',
              'kind': 'connector',
              'authorization': 'grant',
            },
          ],
        ),
      );
      await first;
      expect(controller.connectionStateV1('connect-gmail')?.ready, 1);
      controller.dispose();
    });

    test('opens the app’s own sign-in, and says so', () async {
      final posts = <(String, Object?)>[];
      final opened = <Uri>[];
      final controller = ConnectCardsController(
        api: SettingsApi(MemoryStore(), (path, body) async {
          if (body == null) return connectionsFrame();
          posts.add((path, body));
          return {
            'status': 'authorizing',
            'redirectUrl': 'https://connect.example/gmail',
          };
        }),
        openBrowser: (uri) async {
          opened.add(uri);
          return true;
        },
      );
      await controller.connectV1(
        packageId: 'connect',
        connectionTypeId: 'connect-gmail',
      );
      expect(posts.single.$1, '/api/plugins/connect/connections');
      expect(posts.single.$2, containsPair('type', 'connection/start'));
      expect(
        posts.single.$2,
        containsPair('connectionTypeId', 'connect-gmail'),
      );
      expect(opened, [Uri.parse('https://connect.example/gmail')]);
      final state = controller.connectionStateV1('connect-gmail');
      expect(state?.opened, isTrue);
      expect(state?.failure, isNull);
      controller.dispose();
    });

    test('refuses a door that is not the provider’s', () async {
      final opened = <Uri>[];
      final controller = ConnectCardsController(
        api: SettingsApi(MemoryStore(), (path, body) async {
          if (body == null) return connectionsFrame();
          return {'status': 'authorizing', 'redirectUrl': 'http://evil.test'};
        }),
        openBrowser: (uri) async {
          opened.add(uri);
          return true;
        },
      );
      await controller.connectV1(
        packageId: 'connect',
        connectionTypeId: 'connect-gmail',
      );
      expect(opened, isEmpty);
      final state = controller.connectionStateV1('connect-gmail');
      expect(state?.opened, isFalse);
      expect(state?.failure, isNotNull);
      controller.dispose();
    });
  });

  test('the catalog draws ConnectApp', () {
    expect(
      frockCatalogItemsV1.map((item) => item.name),
      contains('ConnectApp'),
    );
  });
}
