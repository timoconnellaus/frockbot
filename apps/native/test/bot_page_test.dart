import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/routines/page.dart';
import 'package:frockbot_native/routines/runs_row.dart';
import 'package:frockbot_native/shell/bot_page.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'settings_test.dart' show SettingsApi;
import 'widget_test.dart' show MemoryStore;

Future<void> open(
  WidgetTester tester,
  RoutineInboxController inbox, {
  void Function(RoutineRunSummary run)? onOpenRun,
}) async {
  tester.view.physicalSize = const Size(390, 1600);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      theme: FrockTheme.theme(Brightness.dark),
      home: Scaffold(
        body: BotPageView(
          botName: 'Scout',
          inbox: inbox,
          onOpenRun: onOpenRun,
          onOpenRoutines: () {},
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

RoutineInboxController inboxWith(List<Map<String, Object?>> entries) {
  final store = MemoryStore();
  return RoutineInboxController(
    SettingsApi(store, (_, _) async {
      return {
        'unacknowledged': entries
            .where((entry) => entry['failure'] == true)
            .length,
        'entries': entries,
      };
    }),
    'bot-1',
  );
}

void main() {
  testWidgets('a read that has not landed is not an empty run list', (
    tester,
  ) async {
    final store = MemoryStore();
    final entries = <Object?>[];
    final inbox = RoutineInboxController(
      SettingsApi(store, (_, _) async {
        return {'unacknowledged': 0, 'entries': entries};
      }),
      'bot-1',
    );
    addTearDown(inbox.dispose);
    await open(tester, inbox);
    // Nothing has been read yet, so the page claims nothing about the runs.
    expect(find.text('No runs yet'), findsNothing);
    expect(find.text('All Routines'), findsOneWidget);

    await inbox.load();
    await tester.pumpAndSettle();
    // The read landed and it really is empty: now the page says so.
    expect(find.text('No runs yet'), findsOneWidget);
  });

  testWidgets('a landed read draws the firings and no empty row', (
    tester,
  ) async {
    final inbox = inboxWith([
      {
        'entryId': 'e1',
        'routineId': 'r1',
        'attribution': 'Automation: Morning brief',
        'createdAt': DateTime.now().toUtc().toIso8601String(),
      },
    ]);
    addTearDown(inbox.dispose);
    await open(tester, inbox);
    await inbox.load();
    await tester.pumpAndSettle();
    expect(find.text('No runs yet'), findsNothing);
    expect(find.text('Morning brief'), findsOneWidget);
    expect(find.textContaining('Today'), findsOneWidget);
    expect(find.text('Done'), findsNothing);
    expect(find.byIcon(Icons.check_rounded), findsOneWidget);
    expect(
      find.ancestor(
        of: find.text('Morning brief'),
        matching: find.byType(Card),
      ),
      findsNothing,
    );
    expect(
      find.ancestor(of: find.text('All Routines'), matching: find.byType(Card)),
      findsOneWidget,
    );
  });

  testWidgets('a failed firing wears an x and is still a row', (tester) async {
    final inbox = inboxWith([
      {
        'entryId': 'e1',
        'routineId': 'r1',
        'attribution': 'Automation: Inbox sweep',
        'createdAt': DateTime.now()
            .toUtc()
            .subtract(const Duration(days: 1))
            .toIso8601String(),
        'failure': true,
      },
    ]);
    addTearDown(inbox.dispose);
    await open(tester, inbox);
    await inbox.load();
    await tester.pumpAndSettle();
    expect(find.text('Inbox sweep'), findsOneWidget);
    expect(find.textContaining('Yesterday'), findsOneWidget);
    expect(find.text('Needs you'), findsNothing);
    expect(find.byIcon(Icons.close_rounded), findsOneWidget);
    expect(find.byIcon(Icons.check_rounded), findsNothing);
  });

  testWidgets('a running firing wears a spinner', (tester) async {
    final inbox = inboxWith([
      {
        'entryId': 'e1',
        'routineId': 'r1',
        'attribution': 'Automation: Morning brief',
        'createdAt': DateTime.now().toUtc().toIso8601String(),
        'status': 'running',
      },
    ]);
    addTearDown(inbox.dispose);
    await open(tester, inbox);
    await inbox.load();
    await tester.pump();
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    expect(find.byIcon(Icons.check_rounded), findsNothing);
  });

  testWidgets('a recent run opens its details', (tester) async {
    RoutineRunSummary? opened;
    final inbox = inboxWith([
      {
        'entryId': 'e1',
        'routineId': 'r1',
        'attribution': 'Automation: Morning brief',
        'createdAt': DateTime.now().toUtc().toIso8601String(),
      },
    ]);
    addTearDown(inbox.dispose);
    await open(tester, inbox, onOpenRun: (run) => opened = run);
    await inbox.load();
    await tester.pumpAndSettle();
    await tester.tap(find.text('Morning brief'));
    await tester.pump();
    expect(opened?.routineId, 'r1');
    expect(opened?.name, 'Morning brief');
  });

  testWidgets('a light row keeps the name in ink and the time on the line', (
    tester,
  ) async {
    final inbox = inboxWith([
      {
        'entryId': 'e1',
        'routineId': 'r1',
        'attribution': 'Automation: Morning brief',
        'createdAt': DateTime.now().toUtc().toIso8601String(),
      },
    ]);
    addTearDown(inbox.dispose);
    tester.view.physicalSize = const Size(390, 1600);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.light),
        themeMode: ThemeMode.light,
        home: Scaffold(
          body: BotPageView(
            botName: 'Scout',
            inbox: inbox,
            onOpenRoutines: () {},
          ),
        ),
      ),
    );
    await inbox.load();
    await tester.pumpAndSettle();
    final name = tester.widget<Text>(find.text('Morning brief'));
    expect(name.style?.color, FrockTheme.ink);
    final when = tester.widget<Text>(find.textContaining('Today'));
    expect(when.style?.color, FrockTheme.inkMuted);
    expect(find.byType(RoutineRunRow), findsOneWidget);
    expect(tester.getSize(find.byType(RoutineRunRow)).height, lessThan(56));
  });
}
