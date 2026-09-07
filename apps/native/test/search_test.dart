import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/search/controller.dart';
import 'package:frockbot_native/search/overlay.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'settings_test.dart' show SettingsApi;
import 'widget_test.dart' show MemoryStore;

Map<String, Object?> results({
  int totalHits = 1,
  String indexState = 'ready',
  bool truncated = false,
  bool archived = false,
}) => {
  'schemaVersion': 1,
  'query': 'ledger',
  'groups': [
    if (totalHits > 0)
      {
        'botId': 'bot-1',
        'botName': 'Scout',
        'archived': archived,
        'hidden': false,
        'totalHits': totalHits,
        'hits': [
          {
            'runId': 'run-7',
            'kind': 'assistant',
            'at': '2026-09-03T23:00:00.000Z',
            'snippet': 'the ledger balanced',
            'deepLink': '/?bot=bot-1#turn-run-7',
          },
        ],
      },
  ],
  'page': {'truncated': truncated},
  'indexState': indexState,
};

Future<void> pump(WidgetTester tester, SettingsApi api) async {
  await tester.pumpWidget(
    MaterialApp(
      theme: FrockTheme.theme(Brightness.dark),
      home: Scaffold(body: SearchOverlay(api: api)),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  group('what the route answers, decoded', () {
    test('a hit reads as a kind rather than as the wire', () {
      expect(
        SearchHit.decode({
          'runId': 'run-7',
          'kind': 'user',
          'at': '',
          'snippet': 's',
        })!.kindLabel,
        'You',
      );
      expect(
        SearchHit.decode({'runId': 'r', 'kind': 'tool', 'snippet': 's'})!
            .kindLabel,
        'Tool',
      );
      // A row with no run names nothing, and is dropped rather than drawn.
      expect(SearchHit.decode({'kind': 'user'}), isNull);
      expect(SearchHit.decode('not a hit'), isNull);
    });

    test('a group keeps the route\'s own count and its labels', () {
      final group = SearchGroup.decode(
        (results(totalHits: 12, archived: true)['groups']! as List).first,
      )!;
      expect(group.totalHits, 12);
      expect(group.archived, isTrue);
      expect(group.hits.single.runId, 'run-7');
    });
  });

  testWidgets('nothing typed, nothing found and truncated are each named', (
    tester,
  ) async {
    final store = MemoryStore();
    var empty = false;
    final api = SettingsApi(
      store,
      (_, _) async => results(totalHits: empty ? 0 : 1, truncated: !empty),
    );
    await pump(tester, api);
    expect(
      find.text('Type to search every conversation this account has.'),
      findsOneWidget,
    );

    await tester.enterText(find.byType(TextField), 'ledger');
    await tester.pumpAndSettle(const Duration(milliseconds: 400));
    expect(find.text('the ledger balanced'), findsOneWidget);
    expect(
      find.textContaining('More matches than this page holds'),
      findsOneWidget,
    );

    empty = true;
    await tester.enterText(find.byType(TextField), 'ledgers');
    await tester.pumpAndSettle(const Duration(milliseconds: 400));
    expect(find.textContaining('No Turns match'), findsOneWidget);
  });

  testWidgets('one query is made for a burst of typing', (tester) async {
    final store = MemoryStore();
    final read = <String>[];
    final api = SettingsApi(store, (path, _) async {
      read.add(path);
      return results();
    });
    await pump(tester, api);
    await tester.enterText(find.byType(TextField), 'l');
    await tester.pump(const Duration(milliseconds: 50));
    await tester.enterText(find.byType(TextField), 'le');
    await tester.pump(const Duration(milliseconds: 50));
    await tester.enterText(find.byType(TextField), 'ledger');
    await tester.pumpAndSettle(const Duration(milliseconds: 400));
    expect(read, ['/api/search?q=ledger&kinds=user%2Cassistant']);
  });

  testWidgets('tool output and archived Bots are each an explicit opt-in', (
    tester,
  ) async {
    final store = MemoryStore();
    final read = <String>[];
    final api = SettingsApi(store, (path, _) async {
      read.add(path);
      return results();
    });
    await pump(tester, api);
    await tester.enterText(find.byType(TextField), 'ledger');
    await tester.pumpAndSettle(const Duration(milliseconds: 400));

    await tester.tap(find.text('Tool output'));
    await tester.pumpAndSettle(const Duration(milliseconds: 400));
    expect(read.last, contains('kinds=user%2Cassistant%2Ctool'));

    await tester.tap(find.text('Archived Bots'));
    await tester.pumpAndSettle(const Duration(milliseconds: 400));
    expect(read.last, contains('includeArchived=true'));
  });

  testWidgets('choosing a hit answers with its Bot and its Turn', (
    tester,
  ) async {
    final store = MemoryStore();
    final api = SettingsApi(store, (_, _) async => results());
    ({String botId, String runId})? chosen;
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: Builder(
          builder: (context) => Scaffold(
            body: Center(
              child: TextButton(
                onPressed: () async =>
                    chosen = await showSearchOverlayV1(context, api),
                child: const Text('Open'),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'ledger');
    await tester.pumpAndSettle(const Duration(milliseconds: 400));
    await tester.tap(find.text('the ledger balanced'));
    await tester.pumpAndSettle();
    expect(chosen?.botId, 'bot-1');
    expect(chosen?.runId, 'run-7');
  });

  testWidgets('a search that fails says so without the backend detail', (
    tester,
  ) async {
    final store = MemoryStore();
    final api = SettingsApi(
      store,
      (_, _) async => throw const FormatException('synthetic backend detail'),
    );
    await pump(tester, api);
    await tester.enterText(find.byType(TextField), 'ledger');
    await tester.pumpAndSettle(const Duration(milliseconds: 400));
    expect(find.textContaining('synthetic backend'), findsNothing);
    expect(find.text('Search couldn’t run'), findsOneWidget);
  });
}
