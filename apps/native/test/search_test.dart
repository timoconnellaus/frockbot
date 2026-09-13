import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/search/controller.dart';
import 'package:frockbot_native/routines/page.dart';
import 'package:frockbot_native/search/overlay.dart';
import 'package:frockbot_native/shell/semantics.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'settings_test.dart' show SettingsApi;
import 'routines_test.dart' show routinesDocument;
import 'shell_layout_test.dart' show byIdentifier;
import 'voice_shell_harness.dart';
import 'widget_test.dart' show MemoryStore;

Map<String, Object?> results({
  int totalHits = 1,
  String indexState = 'ready',
  bool truncated = false,
  bool archived = false,
  String snippet = 'the ledger balanced',
  String kind = 'assistant',
}) => {
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
            'kind': kind,
            'at': '2026-09-03T23:00:00.000Z',
            'snippet': snippet,
            'deepLink': '/?bot=bot-1#turn-run-7',
          },
        ],
      },
  ],
  'page': {'truncated': truncated},
  'indexState': indexState,
};

const bots = [
  SearchBot(
    id: 'bot-1',
    name: 'Scout',
    description: 'Keeps the ledger balanced',
    unread: true,
  ),
  SearchBot(
    id: 'bot-2',
    name: 'School',
    description: 'School news and reminders',
  ),
  SearchBot(
    id: 'bot-3',
    name: 'Old Bot',
    description: 'An archived Bot',
    archived: true,
  ),
];

Future<void> pump(
  WidgetTester tester,
  SettingsApi api, {
  List<SearchBot> directory = bots,
  List<SearchAction> actions = const [],
}) async {
  await tester.pumpWidget(
    MaterialApp(
      theme: FrockTheme.theme(Brightness.dark),
      home: Scaffold(
        body: SearchOverlay(api: api, bots: directory, actions: actions),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> choose(
  WidgetTester tester,
  SearchCategory category, {
  bool phone = false,
}) async {
  if (phone) {
    await tester.tap(byIdentifier(SearchIds.filter));
    await tester.pumpAndSettle();
  }
  await tester.ensureVisible(byIdentifier(SearchIds.category(category.name)));
  await tester.pumpAndSettle();
  await tester.tap(byIdentifier(SearchIds.category(category.name)));
  await tester.pumpAndSettle();
}

Future<void> chord(
  WidgetTester tester,
  LogicalKeyboardKey key, {
  bool meta = false,
}) async {
  final modifier = meta
      ? LogicalKeyboardKey.metaLeft
      : LogicalKeyboardKey.controlLeft;
  await tester.sendKeyDownEvent(modifier);
  await tester.sendKeyEvent(key);
  await tester.sendKeyUpEvent(modifier);
  await tester.pumpAndSettle();
}

void main() {
  test('a hit and group preserve their destination, kind and server count', () {
    expect(SearchHit.decode({'runId': 'r', 'kind': 'tool'})!.kindLabel, 'Tool');
    expect(SearchHit.decode({'runId': 'r', 'kind': 'link'})!.kindLabel, 'Link');
    expect(SearchHit.decode({'kind': 'user'}), isNull);
    final group = SearchGroup.decode(
      (results(totalHits: 12, archived: true)['groups']! as List).first,
    )!;
    expect(group.totalHits, 12);
    expect(group.archived, isTrue);
    expect(group.hits.single.runId, 'run-7');
  });

  testWidgets('All immediately lists Bots and descriptions without a request', (
    tester,
  ) async {
    final read = <String>[];
    final api = SettingsApi(MemoryStore(), (path, _) async {
      read.add(path);
      return results();
    });
    await pump(tester, api);
    expect(find.text('Scout'), findsOneWidget);
    expect(find.text('Keeps the ledger balanced'), findsOneWidget);
    expect(find.text('School'), findsOneWidget);
    expect(find.text('Old Bot'), findsNothing);
    expect(read, isEmpty);
    expect(find.text('Archived Bots'), findsNothing);
    for (final category in SearchCategory.values) {
      expect(byIdentifier(SearchIds.category(category.name)), findsOneWidget);
    }
  });

  testWidgets('Bot search matches descriptions and typing is debounced', (
    tester,
  ) async {
    final read = <String>[];
    final api = SettingsApi(MemoryStore(), (path, _) async {
      read.add(path);
      return results();
    });
    await pump(tester, api);
    await choose(tester, SearchCategory.bots);
    await tester.enterText(find.byType(TextField), 'ledger');
    await tester.pumpAndSettle();
    expect(find.text('Scout'), findsOneWidget);
    expect(find.text('School'), findsNothing);
    expect(read, isEmpty);

    await choose(tester, SearchCategory.messages);
    read.clear();
    await tester.enterText(find.byType(TextField), 'l');
    await tester.pump(const Duration(milliseconds: 50));
    await tester.enterText(find.byType(TextField), 'le');
    await tester.pump(const Duration(milliseconds: 50));
    await tester.enterText(find.byType(TextField), 'ledger');
    await tester.pumpAndSettle(const Duration(milliseconds: 400));
    expect(read, ['/api/search?q=ledger&kinds=user%2Cassistant']);
    expect(find.text('the ledger balanced'), findsOneWidget);
  });

  testWidgets(
    'Files and Links browse recent indexed items and menu retains advanced controls',
    (tester) async {
      final read = <String>[];
      final api = SettingsApi(MemoryStore(), (path, _) async {
        read.add(path);
        return results();
      });
      await pump(tester, api);
      await choose(tester, SearchCategory.files);
      expect(read.last, '/api/search?q&kinds=media');
      await choose(tester, SearchCategory.links);
      expect(read.last, '/api/search?q&kinds=link');
      await choose(tester, SearchCategory.messages);
      await tester.tap(byIdentifier(SearchIds.options));
      await tester.pumpAndSettle();
      await tester.tap(
        find.widgetWithText(CheckedPopupMenuItem<String>, 'Tool output'),
      );
      await tester.pumpAndSettle();
      expect(read.last, contains('kinds=user%2Cassistant%2Ctool'));
      await tester.tap(byIdentifier(SearchIds.options));
      await tester.pumpAndSettle();
      await tester.tap(
        find.widgetWithText(CheckedPopupMenuItem<String>, 'Archived Bots'),
      );
      await tester.pumpAndSettle();
      expect(read.last, contains('includeArchived=true'));
    },
  );

  test(
    'a pending response is invalidated immediately on typing before debounce',
    () async {
      final first = Completer<Object?>();
      final api = SettingsApi(MemoryStore(), (_, _) => first.future);
      final controller = BotSearchController(api);
      controller.category = SearchCategory.messages;
      controller.query = 'ledger';
      final read = controller.run();
      controller.setQuery('new query');
      first.complete(results());
      await read;
      expect(controller.groups, isNull);
      expect(controller.answeredQuery, isNull);
      controller.dispose();
    },
  );

  test(
    'a category change prevents old message results replacing file results',
    () async {
      final old = Completer<Object?>();
      final api = SettingsApi(
        MemoryStore(),
        (path, _) async => path.contains('kinds=media')
            ? results(kind: 'media', snippet: 'invoice.pdf')
            : old.future,
      );
      final controller = BotSearchController(api);
      controller.category = SearchCategory.messages;
      final read = controller.run();
      controller.setCategory(SearchCategory.files);
      await Future<void>.delayed(Duration.zero);
      old.complete(results());
      await read;
      expect(controller.entries.single.title, 'invoice.pdf');
      controller.dispose();
    },
  );

  test(
    'routines use bounded concurrency, lazy cache and retry failed Bots only',
    () async {
      final directory = [
        for (var i = 0; i < 7; i++) SearchBot(id: 'b$i', name: 'Bot $i'),
      ];
      var active = 0;
      var peak = 0;
      var fail = true;
      final reads = <String>[];
      final api = SettingsApi(MemoryStore(), (path, _) async {
        reads.add(path);
        active++;
        if (active > peak) peak = active;
        await Future<void>.delayed(const Duration(milliseconds: 1));
        active--;
        if (path.contains('/b1/') && fail) {
          throw const FormatException('offline');
        }
        return {
          'routines': [
            {
              'routineId': 'r1',
              'name': 'School brief',
              'schedule': '30 7 * * 1-5',
              'enabled': true,
            },
          ],
        };
      });
      final controller = BotSearchController(api, bots: directory);
      controller.category = SearchCategory.routines;
      await controller.loadRoutines();
      expect(peak, lessThanOrEqualTo(3));
      expect(controller.entries, hasLength(6));
      expect(controller.failedRoutineBots, 1);
      expect(
        controller.entries.first.subtitle,
        contains('Weekdays at 7:30 AM'),
      );
      await controller.loadRoutines();
      expect(reads, hasLength(7));
      fail = false;
      await controller.loadRoutines(retry: true);
      expect(reads, hasLength(8));
      expect(controller.failedRoutineBots, 0);
      expect(controller.entries, hasLength(7));
      controller.dispose();
    },
  );

  testWidgets(
    'no results, unavailable groups and backend failure are distinct',
    (tester) async {
      var fail = false;
      final api = SettingsApi(MemoryStore(), (_, _) async {
        if (fail) throw const FormatException('synthetic backend detail');
        return results(totalHits: 0);
      });
      await pump(tester, api);
      await choose(tester, SearchCategory.groups);
      expect(find.text('Group chats aren’t available yet'), findsOneWidget);
      await choose(tester, SearchCategory.messages);
      expect(find.text('No messages yet'), findsOneWidget);
      await tester.enterText(find.byType(TextField), 'ledger');
      await tester.pumpAndSettle(const Duration(milliseconds: 400));
      expect(find.text('No results for “ledger”'), findsOneWidget);
      fail = true;
      await tester.enterText(find.byType(TextField), 'ledgers');
      await tester.pumpAndSettle(const Duration(milliseconds: 400));
      expect(find.textContaining('Search couldn’t run'), findsOneWidget);
      expect(find.textContaining('synthetic backend'), findsNothing);
    },
  );

  testWidgets(
    'arrow keys, Enter and modifier digits choose real destinations',
    (tester) async {
      final api = SettingsApi(MemoryStore(), (_, _) async => results());
      SearchSelection? chosen;
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: Builder(
            builder: (context) => Scaffold(
              body: TextButton(
                onPressed: () async => chosen = await showSearchOverlayV1(
                  context,
                  api,
                  bots: bots,
                ),
                child: const Text('Open'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Open'));
      await tester.pumpAndSettle();
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(chosen?.botId, 'bot-2');
      expect(chosen?.runId, isNull);

      await tester.tap(find.text('Open'));
      await tester.pumpAndSettle();
      await chord(tester, LogicalKeyboardKey.digit1, meta: true);
      expect(chosen?.botId, 'bot-1');

      await tester.tap(find.text('Open'));
      await tester.pumpAndSettle();
      await choose(tester, SearchCategory.messages);
      await tester.tap(find.text('the ledger balanced'));
      await tester.pumpAndSettle();
      expect(chosen?.botId, 'bot-1');
      expect(chosen?.runId, 'run-7');
    },
  );

  testWidgets(
    'phone search fills the safe area and stays usable above the IME',
    (tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      tester.view.padding = const FakeViewPadding(top: 35, bottom: 24);
      tester.view.viewInsets = const FakeViewPadding(bottom: 310);
      addTearDown(tester.view.reset);
      final api = SettingsApi(MemoryStore(), (_, _) async => results());
      await pump(tester, api);
      expect(tester.getRect(byIdentifier(SearchIds.overlay)).width, 390);
      expect(
        tester.getRect(byIdentifier(SearchIds.field)).top,
        greaterThanOrEqualTo(35),
      );
      expect(
        tester.getRect(byIdentifier(SearchIds.bot('bot-2'))).bottom,
        lessThan(534),
      );
      expect(find.text('Messages'), findsNothing);
      await tester.tap(byIdentifier(SearchIds.filter));
      await tester.pumpAndSettle();
      expect(find.text('Group Chats'), findsOneWidget);
      await tester.tap(
        find.widgetWithText(CheckedPopupMenuItem<String>, 'Files'),
      );
      await tester.pumpAndSettle();
      expect(find.text('the ledger balanced'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'shell Cmd+K and Ctrl+K open once from the composer and preserve its draft',
    (tester) async {
      final harness = VoiceShellHarness();
      await harness.mount(tester, width: 1200, brightness: Brightness.dark);
      final composer = find.descendant(
        of: byIdentifier(ShellIds.composer),
        matching: find.byType(TextField),
      );
      await tester.enterText(composer, 'Keep my draft');
      await chord(tester, LogicalKeyboardKey.keyK, meta: true);
      expect(byIdentifier(SearchIds.overlay), findsOneWidget);
      expect(find.text('Rosemary'), findsWidgets);
      await chord(tester, LogicalKeyboardKey.keyK);
      expect(byIdentifier(SearchIds.overlay), findsOneWidget);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(byIdentifier(SearchIds.overlay), findsNothing);
      expect(find.text('Keep my draft'), findsOneWidget);
      await harness.dispose(tester);
    },
  );

  testWidgets(
    'actions and routines return destinations without executing commands',
    (tester) async {
      final reads = <String>[];
      final store = MemoryStore();
      final api = SettingsApi(store, (path, body) async {
        expect(body, isNull);
        reads.add(path);
        if (path.contains('as=document')) return routinesDocument();
        return {
          'routines': [
            {
              'routineId': 'r1',
              'name': 'School brief',
              'schedule': '30 7 * * 1-5',
              'timezone': 'Australia/Sydney',
            },
          ],
        };
      });
      SearchSelection? chosen;
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: Builder(
            builder: (context) => Scaffold(
              body: TextButton(
                onPressed: () async => chosen = await showSearchOverlayV1(
                  context,
                  api,
                  bots: [bots.first],
                  actions: const [
                    SearchAction(
                      'settings',
                      'Settings: General',
                      'Personal details',
                    ),
                  ],
                ),
                child: const Text('Open'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Open'));
      await tester.pumpAndSettle();
      await choose(tester, SearchCategory.actions);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(chosen?.actionId, 'settings');
      expect(reads, isEmpty);
      await tester.tap(find.text('Open'));
      await tester.pumpAndSettle();
      await choose(tester, SearchCategory.routines);
      expect(find.textContaining('Australia/Sydney'), findsOneWidget);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(chosen?.routineId, 'r1');
      expect(chosen?.botId, 'bot-1');
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: RoutinesView(
            api: api,
            store: store,
            userId: 'u',
            botId: chosen!.botId!,
            botName: 'Scout',
            initialRoutineId: chosen!.routineId,
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(reads.last, '/api/bots/bot-1/routines?as=document&edit=r1');
    },
  );

  testWidgets('a small phone can scroll filters with its keyboard open', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(320, 568);
    tester.view.devicePixelRatio = 1;
    tester.view.padding = const FakeViewPadding(top: 24);
    tester.view.viewInsets = const FakeViewPadding(bottom: 290);
    addTearDown(tester.view.reset);
    final api = SettingsApi(
      MemoryStore(),
      (_, _) async => {'routines': <Object>[]},
    );
    await pump(tester, api);
    await tester.tap(byIdentifier(SearchIds.filter));
    await tester.pumpAndSettle();
    final actions = find.widgetWithText(
      CheckedPopupMenuItem<String>,
      'Routines',
    );
    await tester.ensureVisible(actions);
    await tester.pumpAndSettle();
    await tester.tap(actions);
    await tester.pumpAndSettle();
    expect(find.text('No routines yet'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  test('a refused rebuild restores its previous index state', () async {
    final api = SettingsApi(MemoryStore(), (path, _) async {
      if (path == '/api/search/rebuild') throw const FormatException('offline');
      return results(indexState: 'stale');
    });
    final controller = BotSearchController(api);
    controller.query = 'ledger';
    await controller.run();
    await controller.rebuild();
    expect(controller.indexState, 'stale');
    expect(controller.rebuilding, isFalse);
    expect(controller.error, isNotNull);
    controller.dispose();
  });
}
