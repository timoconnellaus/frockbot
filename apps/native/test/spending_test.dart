import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/settings/spending.dart';

import 'settings_test.dart' show SettingsApi;
import 'widget_test.dart' show MemoryStore;

final _runsOut = DateTime(2026, 10, 9, 12).millisecondsSinceEpoch;
final _renews = DateTime(2026, 10, 14, 12).millisecondsSinceEpoch;

Map<String, Object?> _report(
  Uri uri, {
  required List<Map<String, Object?>> groups,
  List<Map<String, Object?>>? topTurns,
  Map<String, Object?>? credit,
}) {
  final total = groups.fold<int>(
    0,
    (sum, g) => sum + (g['chargeMicros'] as int),
  );
  return {
    'groupBy': uri.queryParameters['groupBy'],
    'filters': [
      for (final entry in uri.queryParameters.entries)
        if (!{'period', 'groupBy'}.contains(entry.key))
          {
            'dimension': entry.key,
            'value': entry.value,
            'label': entry.key == 'cause' ? 'Morning digest' : entry.value,
          },
    ],
    'totalMicros': total,
    'previousTotalMicros': 432000,
    'operations': 3,
    'turns': 2,
    'days': [
      {
        'day': '2026-09-19',
        'chargeMicros': 0,
        'stack': [for (final _ in groups) 0],
      },
      {
        'day': '2026-09-20',
        'chargeMicros': total,
        'stack': [for (final g in groups) g['chargeMicros']],
      },
    ],
    'groups': groups,
    'topCause': {
      'key': 'routine|bot-1|digest',
      'label': 'Morning digest',
      'detail': 'Research',
      'chargeMicros': 510000,
      'operations': 0,
      'turns': 4,
    },
    'credit': credit,
    'topTurns': topTurns,
  };
}

const _digest = {
  'key': 'routine|bot-1|digest',
  'label': 'Morning digest',
  'detail': 'Research',
  'chargeMicros': 510000,
  'operations': 3,
  'turns': 4,
};

final _list = find
    .descendant(of: find.byType(ListView), matching: find.byType(Scrollable))
    .first;

void main() {
  test('a drill-down groups by the first slice not already pinned', () {
    expect(nextSpendGroupBy([]), 'cause');
    expect(nextSpendGroupBy(['cause']), 'bot');
    expect(nextSpendGroupBy(['cause', 'bot']), 'category');
    expect(
      spendingPath('7d', 'model', const [
        SpendFilter('cause', 'routine|bot-1|digest', 'Morning digest'),
      ]),
      '/api/billing/spending?period=7d&groupBy=model&cause=routine%7Cbot-1%7Cdigest',
    );
    expect(spendMoney(4000), '< US\$0.01');
    expect(spendMoney(0), 'US\$0.00');
    expect(spendMoney(1234567), 'US\$1.23');
    expect(spendDay('2026-09-20'), 'Sep 20');
  });

  testWidgets(
    'on a phone: the answer first, then narrow by tapping, widen again, open a Turn',
    (tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final asked = <Uri>[];
      final api = SettingsApi(MemoryStore(), (path, body) async {
        final uri = Uri.parse(path);
        asked.add(uri);
        expect(uri.path, '/api/billing/spending');
        final credit = {
          'availableMicros': 4760000,
          'dailyMicros': 340000,
          'runsOutAt': _runsOut,
          'renewsAt': _renews,
        };
        if (uri.queryParameters['groupBy'] == 'cause') {
          return _report(
            uri,
            groups: [_digest],
            topTurns: const [],
            credit: credit,
          );
        }
        return _report(
          uri,
          credit: credit,
          groups: [
            {
              'key': 'bot-1',
              'label': 'Research',
              'chargeMicros': 310000,
              'operations': 2,
              'turns': 1,
            },
          ],
          topTurns: [
            {
              'runId': 'fire-1',
              'botId': 'bot-1',
              'bot': 'Research',
              'cause': 'Morning digest',
              'at': DateTime(2026, 9, 20, 7, 5).millisecondsSinceEpoch,
              'chargeMicros': 310000,
              'operations': 2,
            },
          ],
        );
      });
      String? opened;
      await tester.pumpWidget(
        MaterialApp(
          home: SpendingPage(api: api, onOpenBot: (botId) => opened = botId),
        ),
      );
      await tester.pumpAndSettle();
      expect(asked.single.queryParameters['groupBy'], 'cause');
      expect(find.text('Spent in the last 30 days'), findsOneWidget);
      expect(find.text('US\$0.51'), findsWidgets);
      expect(find.text('18%'), findsOneWidget);
      expect(find.text('US\$4.76'), findsOneWidget);
      expect(
        find.textContaining('around Oct 9', findRichText: true),
        findsOneWidget,
      );
      // The biggest driver is a wide screen's third card.
      expect(find.text('Biggest driver'), findsNothing);

      await tester.scrollUntilVisible(
        find.text('Routine on Research · \$0.128 a Turn'),
        300,
        scrollable: _list,
      );
      await tester.ensureVisible(
        find.text('Routine on Research · \$0.128 a Turn'),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Routine on Research · \$0.128 a Turn'));
      await tester.pumpAndSettle();
      expect(asked.last.queryParameters, {
        'period': '30d',
        'groupBy': 'bot',
        'cause': 'routine|bot-1|digest',
      });

      await tester.scrollUntilVisible(
        find.textContaining('Research · Sep 20'),
        300,
        scrollable: _list,
      );
      await tester.ensureVisible(find.textContaining('Research · Sep 20'));
      await tester.pumpAndSettle();
      await tester.tap(find.textContaining('Research · Sep 20'));
      expect(opened, 'bot-1');

      await tester.scrollUntilVisible(
        find.byTooltip('Show all again'),
        -300,
        scrollable: _list,
      );
      await tester.ensureVisible(find.byTooltip('Show all again'));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Show all again'));
      await tester.pumpAndSettle();
      expect(asked.last.queryParameters.containsKey('cause'), isFalse);

      await tester.scrollUntilVisible(
        find.text('7d'),
        -300,
        scrollable: _list,
      );
      await tester.ensureVisible(find.text('7d'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('7d'));
      await tester.pumpAndSettle();
      expect(asked.last.queryParameters['period'], '7d');
      expect(find.text('Spent in the last 7 days'), findsOneWidget);
      api.close();
    },
  );

  testWidgets('wide: the biggest driver, a Turns column, and no credit card '
      'where nothing is billed', (tester) async {
    tester.view.physicalSize = const Size(1280, 1100);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final api = SettingsApi(
      MemoryStore(),
      (path, _) async =>
          _report(Uri.parse(path), groups: [_digest], topTurns: const []),
    );
    await tester.pumpWidget(MaterialApp(home: SpendingPage(api: api)));
    await tester.pumpAndSettle();
    expect(find.text('Biggest driver'), findsOneWidget);
    expect(find.text('Routine on Research'), findsWidgets);
    expect(find.text('100% of spend · \$0.128 a run'), findsOneWidget);
    expect(find.text('Credit left'), findsNothing);
    expect(find.text('TURNS'), findsOneWidget);
    expect(find.text('Each day, by what started it'), findsOneWidget);
    api.close();
  });

  testWidgets('a view finer than a Turn says why it lists no Turns', (
    tester,
  ) async {
    final api = SettingsApi(
      MemoryStore(),
      (path, _) async => _report(
        Uri.parse(path),
        groups: [
          {
            'key': 'search',
            'label': 'Web search',
            'chargeMicros': 10000,
            'operations': 1,
          },
        ],
      ),
    );
    await tester.pumpWidget(
      MaterialApp(
        home: SpendingPage(
          api: api,
          groupBy: 'category',
          filters: const [SpendFilter('model', 'x', 'x')],
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(
      find.textContaining('this list is not narrowed by them'),
      300,
      scrollable: _list,
    );
    expect(find.textContaining('Web search'), findsWidgets);
    expect(
      find.textContaining('this list is not narrowed by them'),
      findsOneWidget,
    );
    api.close();
  });
}
