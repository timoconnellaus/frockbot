import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/document_cache.dart';
import 'package:frockbot_native/shell/transcript.dart';
import 'package:frockbot_native/telegram/page.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'settings_test.dart' show SettingsApi;
import 'widget_test.dart' show MemoryStore;

Map<String, Object?> kindOnly(String id) => {
  'id': id,
  'schema': {
    'type': 'object',
    'properties': {
      'kind': {
        'type': 'string',
        'enum': ['telegram-link', 'telegram-bot', 'telegram-unlink'],
      },
    },
    'required': ['kind'],
    'additionalProperties': false,
  },
};

/// The shape `telegramDocumentV1` produces, by hand, so the page is pinned to
/// the projection's contract.
Map<String, Object?> telegramDocument({bool linked = false}) => {
  'schemaVersion': 1,
  'surfaceId': 'telegram',
  'revision': linked ? 2 : 1,
  'root': {
    'type': 'group',
    'orientation': 'column',
    'children': [
      {'type': 'text', 'text': 'Talk to your Bots from Telegram.'},
      if (!linked)
        {
          'type': 'action',
          'actionId': 'telegram-link',
          'label': 'Link Telegram',
          'style': 'primary',
          'input': {'kind': 'telegram-link'},
        },
      if (linked) ...[
        {'type': 'text', 'text': 'Linked to @tim_o', 'style': 'status'},
        {
          'type': 'action',
          'actionId': 'telegram-unlink',
          'label': 'Unlink Telegram',
          'style': 'danger',
          'input': {'kind': 'telegram-unlink'},
        },
      ],
    ],
  },
  'actions': [kindOnly(linked ? 'telegram-unlink' : 'telegram-link')],
};

void main() {
  setUp(clearViewDocumentCacheMemory);

  testWidgets('a link is shown once, by the host, and opens Telegram', (
    tester,
  ) async {
    final store = MemoryStore();
    final paths = <String>[];
    final opened = <Uri>[];
    var linked = false;
    final api = SettingsApi(store, (path, body) async {
      paths.add(path);
      if (path == '/api/telegram/link') {
        return {
          'schemaVersion': 1,
          'code': 'C' * 32,
          'url': 'https://t.me/frock_bot?start=${'C' * 32}',
          'expiresAt': DateTime.now()
              .add(const Duration(minutes: 10))
              .toUtc()
              .toIso8601String(),
        };
      }
      return telegramDocument(linked: linked);
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: TelegramPage(
          api: api,
          store: store,
          userId: 'tim',
          open: (url) async {
            opened.add(url);
            return true;
          },
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Finish in Telegram'), findsNothing);

    await tester.tap(find.text('Link Telegram'));
    await tester.pumpAndSettle();
    expect(paths, contains('/api/telegram/link'));
    expect(find.text('Finish in Telegram'), findsOneWidget);
    expect(find.textContaining('It works once'), findsOneWidget);

    await tester.tap(find.text('Open Telegram'));
    await tester.pumpAndSettle();
    expect(opened, [Uri.parse('https://t.me/frock_bot?start=${'C' * 32}')]);

    // The person pressed Start and came back: the link has done its job.
    linked = true;
    final state = tester.state(find.byType(TelegramPage)) as dynamic;
    await (state.controller as TelegramController).load();
    await tester.pumpAndSettle();
    expect(find.text('Finish in Telegram'), findsNothing);
    expect(find.text('Linked to @tim_o'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    api.close();
  });

  testWidgets('unlinking lands on its own route', (tester) async {
    final store = MemoryStore();
    final posted = <String>[];
    final api = SettingsApi(store, (path, body) async {
      if (body != null) {
        posted.add(path);
        return {'schemaVersion': 1, 'status': 'unlinked'};
      }
      return telegramDocument(linked: true);
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: TelegramPage(api: api, store: store, userId: 'tim'),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Unlink Telegram'));
    await tester.pumpAndSettle();
    expect(posted, ['/api/telegram/unlink']);
    await tester.pumpWidget(const SizedBox());
    api.close();
  });

  test('a Bot choice carries the chosen Bot to its route', () async {
    final store = MemoryStore();
    final bodies = <Object?>[];
    final api = SettingsApi(store, (path, body) async {
      bodies.add(body);
      return {'schemaVersion': 1, 'status': 'applied'};
    });
    final controller = TelegramController(api);
    await controller.dispatch({
      'commandId': 'c1',
      'input': {'kind': 'telegram-bot', telegramBotFieldV1: 'research'},
    });
    expect(bodies, [
      {'botId': 'research'},
    ]);
    controller.dispose();
    api.close();
  });

  group('a message written in Telegram', () {
    Map<String, dynamic> run({Map<String, Object?>? via}) => {
      'runId': 'tg-1',
      'input': 'Hello from the bus',
      'status': 'completed',
      'admittedAt': '2026-09-24T01:00:00.000Z',
      'via': ?via,
      'events': const [],
    };

    test('is the person’s own message, marked where it came from', () {
      final lines = projectRuns([
        run(via: {'kind': 'telegram'}),
      ]);
      final mine = lines.singleWhere((line) => line.role == LineRole.user);
      expect(mine.text, 'Hello from the bus');
      expect(mine.via, 'telegram');
      expect(lines.where((line) => line.exchange != null), isEmpty);
      expect(
        projectRuns([run()]).singleWhere((line) => line.role == LineRole.user)
            .via,
        isNull,
      );
    });

    testWidgets('says so under the bubble', (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: Scaffold(
            body: TranscriptView(
              lines: projectRuns([
                run(via: {'kind': 'telegram'}),
              ]),
              loading: false,
              hasEarlier: false,
              background: 'hot-pink',
              onRefresh: ({older = false}) async {},
              onOpenRun: (_) {},
              storageKey: 'telegram-caption',
            ),
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 400));
      expect(find.text('Hello from the bus'), findsOneWidget);
      expect(find.text('via Telegram'), findsOneWidget);
    });
  });
}
