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

void main() {
  testWidgets('a collapsed panel column still shows the run it is asked for', (
    tester,
  ) async {
    // The widest tier, where the panel is a column the person can collapse.
    tester.view.physicalSize = const Size(1200, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);

    final store = LatchedStore();
    store.values['directory/test-user'] = jsonEncode({
      'schemaVersion': 1,
      'revision': 1,
      'bots': [registration('bot-one', 'Rosemary')],
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

    // The person puts the column away.
    expect(
      identifiedBy(ShellIds.slot(ShellSlot.rightPanel.id)),
      findsOneWidget,
    );
    await tester.tap(find.byTooltip('Hide the panel'));
    await tester.pumpAndSettle();
    expect(identifiedBy(ShellIds.slot(ShellSlot.rightPanel.id)), findsNothing);

    // Asking for a Turn's work draws it rather than nothing.
    await tester.longPress(find.text('do it'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Work details'));
    await tester.pumpAndSettle();
    expect(identifiedBy(ShellIds.runView), findsOneWidget);

    // Asking for a run again while one is open keeps the loan on the books.
    await tester.longPress(find.text('do it'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Work details'));
    await tester.pumpAndSettle();
    expect(identifiedBy(ShellIds.runView), findsOneWidget);

    // Closing the run gives the column back the way the person left it.
    await tester.tap(
      find.descendant(
        of: identifiedBy(ShellIds.runViewClose),
        matching: find.byType(IconButton),
      ),
    );
    await tester.pumpAndSettle();
    expect(identifiedBy(ShellIds.runView), findsNothing);
    expect(identifiedBy(ShellIds.slot(ShellSlot.rightPanel.id)), findsNothing);

    await tester.pumpWidget(const SizedBox());
    sessions.clear();
    links.dispose();
    api.close();
  });
}
