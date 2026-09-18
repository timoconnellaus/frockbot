import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_client/routines/page.dart';
import 'package:frockbot_client/shell/bot_page.dart';
import 'package:frockbot_client/theme/frock_theme.dart';

import 'settings_test.dart' show SettingsApi;
import 'widget_test.dart' show MemoryStore;

Future<void> open(WidgetTester tester, RoutineInboxController inbox) async {
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
          onOpenRoutines: () {},
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
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
    final store = MemoryStore();
    final inbox = RoutineInboxController(
      SettingsApi(store, (_, _) async {
        return {
          'unacknowledged': 1,
          'entries': [
            {
              'entryId': 'e1',
              'routineId': 'r1',
              'attribution': 'Automation: Morning brief',
              'createdAt': DateTime.now().toUtc().toIso8601String(),
            },
          ],
        };
      }),
      'bot-1',
    );
    addTearDown(inbox.dispose);
    await open(tester, inbox);
    await inbox.load();
    await tester.pumpAndSettle();
    expect(find.text('No runs yet'), findsNothing);
    expect(find.text('Morning brief'), findsOneWidget);
  });
}
