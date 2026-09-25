import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/audit/activity.dart';
import 'package:frockbot_native/audit/page.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/protocol/client_wire.generated.dart' as wire;
import 'package:frockbot_native/theme/frock_theme.dart';

import 'native_session.dart';
import 'widget_test.dart' show MemoryStore;

/// The shape `activityPageV1` produces, written by hand so the Flutter side
/// is pinned to the projection's contract.
Map<String, Object?> activityPage({
  List<Map<String, Object?>>? rows,
  String? cursor,
  String indexState = 'ready',
}) => {
  'schemaVersion': 1,
  'rows':
      rows ??
      [
        {
          'botId': 'scout',
          'botName': 'Scout',
          'at': '2026-09-25T00:42:00.000Z',
          'text': 'sent an email',
          'place': 'Email',
          'approved': true,
          'runId': 'run-1',
        },
        {
          'botId': 'bob',
          'botName': 'Bob',
          'at': '2026-09-24T23:02:00.000Z',
          'text': 'ran 6 commands on its Computer',
          'place': 'Computer',
          'note': '1 failed',
          'runId': 'run-2',
        },
      ],
  'nextCursor': ?cursor,
  'indexState': indexState,
};

const directory = {
  'schemaVersion': 1,
  'revision': 0,
  'bots': [
    {
      'schemaVersion': 1,
      'botId': 'bob',
      'registeredAt': '2026-09-01T00:00:00.000Z',
      'initialName': 'Bob',
      'avatar': {
        'schemaVersion': 1,
        'characterId': 'fox',
        'primary': '#fc85ae',
      },
    },
  ],
};

Widget host(NativeApi api, MemoryStore store, {String? botId}) => MaterialApp(
  theme: FrockTheme.theme(Brightness.dark),
  home: AuditPage(
    api: api,
    store: store,
    userId: 'tim',
    botId: botId,
    now: () => DateTime.parse('2026-09-25T02:00:00.000Z').toLocal(),
  ),
);

void main() {
  group('the Activity query', () {
    test('asks for Activity, and spells out only what is not the default', () {
      expect(activityPathV1(), '/api/audit?as=activity');
      expect(
        activityPathV1(botId: 'bot-1', filter: 'commands', before: 'c2'),
        '/api/audit?botId=bot-1&filter=commands&before=c2&as=activity',
      );
      expect(activityPathV1(filter: 'everything'), '/api/audit?as=activity');
    });

    test('the filters are the four the server holds', () {
      expect(activityFilters.map((filter) => filter.slug), [
        'everything',
        'sent',
        'commands',
        'devices',
      ]);
    });
  });

  group('days', () {
    final now = DateTime(2026, 9, 25, 14);
    test('are Today, Yesterday, then the date, in local time', () {
      expect(activityDayLabel(DateTime(2026, 9, 25, 0, 5), now), 'Today');
      expect(activityDayLabel(DateTime(2026, 9, 24, 23, 55), now), 'Yesterday');
      expect(activityDayLabel(DateTime(2026, 9, 22, 9), now), 'Tue 22 Sep');
      expect(
        activityDayLabel(DateTime(2025, 9, 22, 9), now),
        'Mon 22 Sep 2025',
      );
    });

    test('cut the rows where the local day changes', () {
      final local = DateTime(2026, 9, 25, 0, 30);
      final rows = [
        for (final at in [
          local,
          local.subtract(const Duration(minutes: 20)),
          local.subtract(const Duration(minutes: 40)),
        ])
          wire.ActivityRow.fromJson({
            'botId': 'bob',
            'botName': 'Bob',
            'at': at.toUtc().toIso8601String(),
            'text': 'ran a command on its Computer',
            'place': 'Computer',
          }),
      ];
      expect(
        activityDays(rows, now).map((day) => (day.label, day.rows.length)),
        [('Today', 2), ('Yesterday', 1)],
      );
    });
  });

  testWidgets('a row says who did what, where, and what went wrong', (
    tester,
  ) async {
    final store = MemoryStore();
    final api = NativeSessionApi(store, (path, _) async {
      if (path == '/api/bots') return directory;
      return activityPage();
    });
    addTearDown(api.close);
    await tester.pumpWidget(host(api, store));
    await tester.pumpAndSettle();
    expect(find.text('Activity'), findsOneWidget);
    expect(
      find.textContaining('What your Bots did outside the conversation'),
      findsOneWidget,
    );
    expect(find.textContaining('sent an email'), findsOneWidget);
    expect(find.text('Email'), findsOneWidget);
    expect(find.text('You approved'), findsOneWidget);
    expect(find.text('1 failed'), findsOneWidget);
    expect(
      find.textContaining('Commands are kept only as a short preview'),
      findsOneWidget,
    );
    // Nothing of the old page's upkeep is left on it.
    expect(find.textContaining('Rebuild'), findsNothing);
    // The first page is kept for the next visit.
    expect(store.values.containsKey('activity-page.tim'), isTrue);
  });

  testWidgets('a filter re-reads, and Show earlier appends from the cursor', (
    tester,
  ) async {
    final store = MemoryStore();
    final read = <String>[];
    final api = NativeSessionApi(store, (path, _) async {
      if (path == '/api/bots') return directory;
      read.add(path);
      if (path.contains('before=')) {
        return activityPage(
          rows: [
            {
              'botId': 'bob',
              'botName': 'Bob',
              'at': '2026-09-20T09:00:00.000Z',
              'text': 'updated its memory',
              'place': 'Memory',
              'runId': 'run-9',
            },
          ],
        );
      }
      return activityPage(cursor: 'c2');
    });
    addTearDown(api.close);
    await tester.pumpWidget(host(api, store));
    await tester.pumpAndSettle();
    expect(read.single, '/api/audit?as=activity');

    await tester.tap(find.text('Commands'));
    await tester.pumpAndSettle();
    expect(read.last, '/api/audit?filter=commands&as=activity');

    await tester.scrollUntilVisible(find.text('Show earlier'), 200);
    await tester.tap(find.text('Show earlier'));
    await tester.pumpAndSettle();
    expect(read.last, '/api/audit?filter=commands&before=c2&as=activity');
    // Appended, not replaced.
    expect(find.textContaining('updated its memory'), findsOneWidget);
    expect(find.textContaining('ran 6 commands'), findsOneWidget);
    expect(find.text('Show earlier'), findsNothing);
  });

  testWidgets('the Bot picker narrows to one Bot', (tester) async {
    final store = MemoryStore();
    final read = <String>[];
    final api = NativeSessionApi(store, (path, _) async {
      if (path == '/api/bots') return directory;
      read.add(path);
      return activityPage();
    });
    addTearDown(api.close);
    await tester.pumpWidget(host(api, store));
    await tester.pumpAndSettle();
    await tester.tap(find.text('All Bots'));
    await tester.pumpAndSettle();
    await tester.tap(find.byType(CheckedPopupMenuItem<String>).last);
    await tester.pumpAndSettle();
    expect(read.last, '/api/audit?botId=bob&as=activity');
  });

  testWidgets('nothing yet is said, not left blank', (tester) async {
    final store = MemoryStore();
    final api = NativeSessionApi(store, (path, _) async {
      if (path == '/api/bots') return directory;
      return activityPage(rows: []);
    });
    addTearDown(api.close);
    await tester.pumpWidget(host(api, store));
    await tester.pumpAndSettle();
    expect(find.text('Nothing yet'), findsOneWidget);
    expect(
      find.text(
        'When a Bot sends, changes or runs something, it shows up here.',
      ),
      findsOneWidget,
    );
  });

  testWidgets('Activity recovers from offline without raw backend detail', (
    tester,
  ) async {
    var offline = true;
    final store = MemoryStore();
    final api = NativeSessionApi(store, (path, _) async {
      if (path == '/api/bots') return directory;
      if (offline) throw const RequestFailure('synthetic backend detail');
      return activityPage();
    });
    addTearDown(api.close);
    await tester.pumpWidget(host(api, store));
    await tester.pumpAndSettle();
    expect(find.textContaining('synthetic backend'), findsNothing);
    expect(find.text('Activity couldn’t load'), findsOneWidget);
    offline = false;
    await tester.tap(find.text('Try again'));
    await tester.pumpAndSettle();
    expect(find.textContaining('sent an email'), findsOneWidget);
  });

  testWidgets('the last page read paints before the network answers', (
    tester,
  ) async {
    final store = MemoryStore()
      ..values['activity-page.tim'] =
          '{"schemaVersion":1,"rows":[{"botId":"bob","botName":"Bob",'
          '"at":"2026-09-25T00:10:00.000Z","text":"ran a command on its '
          'Computer","place":"Computer"}],"indexState":"ready"}';
    final api = NativeSessionApi(store, (path, _) async {
      if (path == '/api/bots') return directory;
      throw const RequestFailure('offline');
    });
    addTearDown(api.close);
    await tester.pumpWidget(host(api, store));
    await tester.pumpAndSettle();
    expect(
      find.textContaining('ran a command on its Computer'),
      findsOneWidget,
    );
    // A refresh that failed says so without taking the rows away.
    expect(find.textContaining('Couldn’t load activity'), findsOneWidget);
  });
}
