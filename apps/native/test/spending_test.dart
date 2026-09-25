import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/settings/spending.dart';

import 'settings_test.dart' show SettingsApi;
import 'widget_test.dart' show MemoryStore;

Map<String, Object?> _report(
  Uri uri, {
  required List<Map<String, Object?>> groups,
  List<Map<String, Object?>>? topTurns,
}) => {
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
  'totalMicros': groups.fold<int>(
    0,
    (sum, g) => sum + (g['chargeMicros'] as int),
  ),
  'operations': 3,
  'turns': 2,
  'days': [
    {'day': '2026-09-19', 'chargeMicros': 0},
    {'day': '2026-09-20', 'chargeMicros': 510000},
  ],
  'groups': groups,
  'topTurns': topTurns,
};

final _list = find
    .descendant(of: find.byType(ListView), matching: find.byType(Scrollable))
    .first;

void main() {
  test('a drill-down groups by the first slice not already pinned', () {
    expect(nextSpendGroupBy([]), 'bot');
    expect(nextSpendGroupBy(['bot']), 'cause');
    expect(nextSpendGroupBy(['bot', 'cause']), 'category');
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
    'narrows to a Routine by tapping it, widens again, and opens a Turn',
    (tester) async {
      final asked = <Uri>[];
      final api = SettingsApi(MemoryStore(), (path, body) async {
        final uri = Uri.parse(path);
        asked.add(uri);
        expect(uri.path, '/api/billing/spending');
        if (uri.queryParameters['groupBy'] == 'cause') {
          return _report(
            uri,
            groups: [
              {
                'key': 'routine|bot-1|digest',
                'label': 'Morning digest',
                'detail': 'Research',
                'chargeMicros': 510000,
                'operations': 3,
                'turns': 2,
              },
            ],
            topTurns: const [],
          );
        }
        return _report(
          uri,
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
          home: SpendingPage(
            api: api,
            groupBy: 'cause',
            onOpenBot: (botId) => opened = botId,
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('US\$0.51'), findsWidgets);
      expect(find.text('Morning digest'), findsOneWidget);
      expect(find.textContaining('Research · 100% · 2 Turns'), findsOneWidget);

      await tester.tap(find.text('Morning digest'));
      await tester.pumpAndSettle();
      expect(asked.last.queryParameters, {
        'period': '30d',
        'groupBy': 'bot',
        'cause': 'routine|bot-1|digest',
      });
      expect(find.text('What started it: Morning digest'), findsOneWidget);

      await tester.scrollUntilVisible(
        find.textContaining('Research · Sep 20'),
        300,
        scrollable: _list,
      );
      await tester.tap(find.textContaining('Research · Sep 20'));
      expect(opened, 'bot-1');

      await tester.scrollUntilVisible(
        find.text('What started it: Morning digest'),
        -300,
        scrollable: _list,
      );
      await tester.tap(find.byTooltip('Show all again'));
      await tester.pumpAndSettle();
      expect(asked.last.queryParameters.containsKey('cause'), isFalse);

      await tester.scrollUntilVisible(
        find.text('7 days'),
        -300,
        scrollable: _list,
      );
      await tester.tap(find.text('7 days'));
      await tester.pumpAndSettle();
      expect(asked.last.queryParameters['period'], '7d');
      api.close();
    },
  );

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
    expect(find.textContaining('Web search'), findsOneWidget);
    await tester.scrollUntilVisible(
      find.textContaining('this list is not narrowed by them'),
      300,
      scrollable: _list,
    );
    expect(
      find.textContaining('this list is not narrowed by them'),
      findsOneWidget,
    );
    api.close();
  });
}
