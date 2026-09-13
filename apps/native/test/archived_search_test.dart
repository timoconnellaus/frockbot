import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/bot_sessions.dart';
import 'package:frockbot_native/search/controller.dart';
import 'package:frockbot_native/search/archived_conversation.dart';
import 'package:frockbot_native/shell/app_shell.dart';
import 'package:frockbot_native/shell/semantics.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'navigation_test.dart' show registration;
import 'search_test.dart' show chord, choose;
import 'settings_test.dart' show SettingsApi;
import 'shell_layout_test.dart' show byIdentifier;
import 'widget_test.dart' show MemoryStore;

Map<String, Object?> archivedTurn() => {
  'schemaVersion': 3,
  'runId': 'old-run',
  'admittedAt': '2026-09-01T00:00:00.000Z',
  'input': 'Old question',
  'status': 'completed',
  'events': [
    {
      'type': 'send/to-user',
      'ordinal': 0,
      'payload': {'type': 'text', 'text': 'The archived answer'},
    },
  ],
  'outcome': {'type': 'completed', 'text': 'Unspoken completion'},
};

class ArchiveHarness {
  final store = MemoryStore();
  final links = ValueNotifier<String?>(null);
  final reads = <String>[];
  final writes = <String>[];
  late final api = SettingsApi(store, (path, body) async {
    if (body != null) writes.add(path);
    reads.add(path);
    if (path == '/api/bots') {
      return {
        'schemaVersion': 1,
        'revision': 1,
        'bots': [
          registration('active', 'Current Bot'),
          registration('archived', 'Archived Bot'),
        ],
      };
    }
    if (path == '/api/bots/lifecycles') {
      return {
        'schemaVersion': 1,
        'lifecycles': [
          {
            'schemaVersion': 1,
            'botId': 'archived',
            'status': 'archived',
            'revision': 1,
          },
        ],
      };
    }
    if (path == '/api/bots/identities') return {'identities': []};
    if (path.startsWith('/api/search?')) {
      return {
        'groups': [
          if (path.contains('includeArchived=true'))
            {
              'botId': 'archived',
              'botName': 'Archived Bot',
              'archived': true,
              'hidden': false,
              'totalHits': 1,
              'hits': [
                {
                  'runId': 'old-run',
                  'kind': 'assistant',
                  'at': '2026-09-01T00:00:00.000Z',
                  'snippet': 'The archived answer',
                },
              ],
            },
        ],
        'page': {'truncated': false},
        'indexState': 'ready',
      };
    }
    if (path == '/api/bots/archived/routines') {
      return {
        'routines': [
          {
            'routineId': 'old-routine',
            'name': 'Old brief',
            'schedule': '0 9 * * *',
            'enabled': false,
          },
        ],
      };
    }
    if (path == '/api/bots/active/routines') return {'routines': []};
    if (path == '/api/bots/archived/routines/old-routine/runs') {
      return {'entries': []};
    }
    if (path == '/api/bots/archived/turns/old-run') {
      return {'schemaVersion': 1, 'state': 'terminal', 'run': archivedTurn()};
    }
    if (path.endsWith('/turns')) {
      return {
        'schemaVersion': 1,
        'runs': [],
        'page': {'truncated': false},
      };
    }
    throw const FormatException('offline fixture');
  });
  late final sessions = BotSessions(api: api, store: store);

  Future<void> mount(WidgetTester tester) async {
    tester.view.physicalSize = const Size(1200, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    store.values['chat/u/archived'] = jsonEncode({
      'version': 1,
      'draft': 'Old draft',
      'pending': [
        {'id': 'pending-old', 'text': 'Never resend this'},
      ],
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: AppShell(
          api: api,
          store: store,
          sessions: sessions,
          userId: 'u',
          botLinks: links,
          onSignOut: () async {},
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  Future<void> openWithArchive(WidgetTester tester) async {
    await chord(tester, LogicalKeyboardKey.keyK, meta: true);
    await tester.tap(byIdentifier(SearchIds.options));
    await tester.pumpAndSettle();
    await tester.tap(
      find.widgetWithText(CheckedPopupMenuItem<String>, 'Archived Bots'),
    );
    await tester.pumpAndSettle();
  }

  Future<void> dispose(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox());
    sessions.clear();
    links.dispose();
    await tester.pump();
  }
}

void main() {
  testWidgets('archived history follows its earlier-page cursor', (
    tester,
  ) async {
    const cursor = 'run-index:2026-09-01T00:00:00.000Z:old-run';
    final reads = <String>[];
    final api = SettingsApi(MemoryStore(), (path, body) async {
      expect(body, isNull);
      reads.add(path);
      return {
        'schemaVersion': 1,
        'runs': Uri.parse(path).queryParameters['before'] == cursor
            ? [archivedTurn()]
            : <Object>[],
        'page': Uri.parse(path).queryParameters['before'] == cursor
            ? {'truncated': false}
            : {'truncated': true, 'nextCursor': cursor},
      };
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: ArchivedConversationPage(
          api: api,
          bot: const SearchBot(
            id: 'archived',
            name: 'Archived Bot',
            archived: true,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(byIdentifier(ShellIds.transcriptEarlier));
    await tester.pumpAndSettle();
    expect(reads, hasLength(2));
    expect(reads.first, '/api/bots/archived/turns');
    expect(Uri.parse(reads.last).queryParameters['before'], cursor);
    expect(find.text('The archived answer'), findsOneWidget);
    expect(byIdentifier(ShellIds.transcriptEarlier), findsNothing);
  });

  testWidgets(
    'archived Bots appear only when opted in and open without creating a session or restoring sends',
    (tester) async {
      final harness = ArchiveHarness();
      await harness.mount(tester);
      expect(find.byKey(const ValueKey('bot-archived')), findsNothing);
      await chord(tester, LogicalKeyboardKey.keyK, meta: true);
      expect(byIdentifier(SearchIds.bot('archived')), findsNothing);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      await harness.openWithArchive(tester);
      expect(byIdentifier(SearchIds.bot('archived')), findsOneWidget);
      await tester.tap(byIdentifier(SearchIds.bot('archived')));
      await tester.pumpAndSettle();
      expect(byIdentifier(SearchIds.archivedConversation), findsOneWidget);
      expect(find.text('Archived · Read-only conversation'), findsOneWidget);
      expect(byIdentifier(ShellIds.composer), findsNothing);
      expect(harness.sessions.live, 0);
      expect(harness.reads, contains('/api/bots/archived/turns'));
      expect(
        harness.writes.where((path) => path.contains('archived')),
        isEmpty,
      );
      expect(
        harness.store.values['chat/u/archived'],
        contains('Never resend this'),
      );
      await harness.dispose(tester);
    },
  );

  testWidgets(
    'an archived message hit loads its older source with GET and opens no send controls',
    (tester) async {
      final harness = ArchiveHarness();
      await harness.mount(tester);
      await harness.openWithArchive(tester);
      await choose(tester, SearchCategory.messages);
      await tester.tap(byIdentifier(SearchIds.hit('old-run')));
      await tester.pumpAndSettle();
      expect(find.text('The archived answer'), findsOneWidget);
      expect(find.text('Unspoken completion'), findsNothing);
      expect(harness.reads, contains('/api/bots/archived/turns/old-run'));
      expect(byIdentifier(ShellIds.composer), findsNothing);
      expect(harness.sessions.live, 0);
      expect(
        harness.writes.where((path) => path.contains('archived')),
        isEmpty,
      );
      await harness.dispose(tester);
    },
  );

  testWidgets('archived Routine search opens its read-only run log', (
    tester,
  ) async {
    final harness = ArchiveHarness();
    await harness.mount(tester);
    await harness.openWithArchive(tester);
    await choose(tester, SearchCategory.routines);
    expect(find.text('Old brief'), findsOneWidget);
    await tester.tap(
      byIdentifier(SearchIds.routine('archived', 'old-routine')),
    );
    await tester.pumpAndSettle();
    expect(byIdentifier(RoutineIds.runLog), findsOneWidget);
    expect(
      harness.reads,
      contains('/api/bots/archived/routines/old-routine/runs'),
    );
    expect(
      harness.reads.where((path) => path.contains('as=document')),
      isEmpty,
    );
    expect(harness.sessions.live, 0);
    expect(harness.writes.where((path) => path.contains('archived')), isEmpty);
    await harness.dispose(tester);
  });
}
