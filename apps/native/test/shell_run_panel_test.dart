/// Opening a run is a request to see it, whatever the panel column was doing.
library;

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/bot_sessions.dart';
import 'package:frockbot_native/client/page_cache.dart';
import 'package:frockbot_native/shell/app_shell.dart';
import 'package:frockbot_native/shell/semantics.dart';
import 'package:frockbot_native/shell/slots.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'navigation_test.dart' show OfflineApi, identifiedBy, registration;
import 'bot_switch_test.dart' show LatchedStore;

/// The widest tier, where the panel is a column the person can collapse, with
/// one finished Turn in the transcript to ask the work of.
/// Returns the teardown, which has to run inside the test body: the framework
/// checks for pending timers before any addTearDown callback gets a turn.
Future<Future<void> Function()> pumpTripleTierShell(WidgetTester tester) async {
  tester.view.physicalSize = const Size(1200, 900);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);

  final store = LatchedStore();
  store.values['directory/test-user'] = jsonEncode({
    'schemaVersion': 1,
    'revision': 1,
    'bots': [
      registration('bot-one', 'Rosemary'),
      registration('bot-two', 'Clementine'),
    ],
  });
  store.values['selection.test-user'] = 'bot-one';
  store.values[pageCacheKey('test-user', 'bot-one')] = encodePageCache([
    {
      'schemaVersion': 1,
      'runId': 'run-a',
      'admittedAt': '2026-09-05T00:00:00.000Z',
      'input': 'do it',
      'status': 'completed',
      'events': [
        {
          'type': 'send/to-user',
          'payload': {'type': 'text', 'text': 'Done.'},
          'ordinal': 0,
        },
      ],
    },
  ], null);
  final api = OfflineApi(store);
  final sessions = BotSessions(api: api, store: store);
  final links = ValueNotifier<String?>(null);
  await tester.pumpWidget(
    MaterialApp(
      theme: FrockTheme.theme(Brightness.dark),
      home: AppShell(
        api: api,
        store: store,
        sessions: sessions,
        userId: 'test-user',
        botLinks: links,
        onSignOut: () async {},
      ),
    ),
  );
  await tester.pumpAndSettle();
  return () async {
    await tester.pumpWidget(const SizedBox());
    sessions.clear();
    links.dispose();
    api.close();
  };
}

/// The transcript's route into a run: the Turn's message actions.
Future<void> openRunFromTranscript(WidgetTester tester) async {
  await tester.longPress(find.text('do it'));
  await tester.pumpAndSettle();
  await tester.tap(find.text('Work details'));
  await tester.pumpAndSettle();
}

Future<void> closeRunView(WidgetTester tester) async {
  await tester.tap(
    find.descendant(
      of: identifiedBy(ShellIds.runViewClose),
      matching: find.byType(IconButton),
    ),
  );
  await tester.pumpAndSettle();
}

final Finder rightPanelSlot = identifiedBy(
  ShellIds.slot(ShellSlot.rightPanel.id),
);

void main() {
  testWidgets('a collapsed panel column still shows the run it is asked for', (
    tester,
  ) async {
    final teardown = await pumpTripleTierShell(tester);

    // The person puts the column away.
    expect(rightPanelSlot, findsOneWidget);
    await tester.tap(find.byTooltip('Hide the panel'));
    await tester.pumpAndSettle();
    expect(rightPanelSlot, findsNothing);

    // Asking for a Turn's work draws it rather than nothing.
    await openRunFromTranscript(tester);
    expect(identifiedBy(ShellIds.runView), findsOneWidget);

    // Asking for a run again while one is open keeps the loan on the books.
    await openRunFromTranscript(tester);
    expect(identifiedBy(ShellIds.runView), findsOneWidget);

    // Closing the run gives the column back the way the person left it.
    await closeRunView(tester);
    expect(identifiedBy(ShellIds.runView), findsNothing);
    expect(rightPanelSlot, findsNothing);
    await teardown();
  });

  testWidgets('putting the column away during a run outlasts reopening it', (
    tester,
  ) async {
    final teardown = await pumpTripleTierShell(tester);

    // The run opens over a column the person had left on screen.
    expect(rightPanelSlot, findsOneWidget);
    await openRunFromTranscript(tester);
    expect(identifiedBy(ShellIds.runView), findsOneWidget);

    // Now the person puts the column away, run and all.
    await tester.tap(find.byTooltip('Hide the panel'));
    await tester.pumpAndSettle();
    expect(identifiedBy(ShellIds.runView), findsNothing);
    expect(rightPanelSlot, findsNothing);

    // Asking for the work again borrows the column back.
    await openRunFromTranscript(tester);
    expect(identifiedBy(ShellIds.runView), findsOneWidget);

    // Closing it returns the column to the state the person last chose.
    await closeRunView(tester);
    expect(identifiedBy(ShellIds.runView), findsNothing);
    expect(rightPanelSlot, findsNothing);
    await teardown();
  });

  testWidgets('switching Bots gives a borrowed column back', (tester) async {
    final teardown = await pumpTripleTierShell(tester);

    // The person puts the column away, then borrows it for a run.
    await tester.tap(find.byTooltip('Hide the panel'));
    await tester.pumpAndSettle();
    expect(rightPanelSlot, findsNothing);
    await openRunFromTranscript(tester);
    expect(identifiedBy(ShellIds.runView), findsOneWidget);

    // Leaving the run by choosing another Bot returns the column too, rather
    // than leaving the other Bot's settings on screen.
    await tester.tap(find.byKey(const ValueKey('bot-bot-two')));
    await tester.pumpAndSettle();
    expect(identifiedBy(ShellIds.runView), findsNothing);
    expect(rightPanelSlot, findsNothing);
    await teardown();
  });
}
