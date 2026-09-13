/// A Package entry belongs to the Bot that declares it, so it is drawn in that
/// Bot's own bar. It used to be drawn above the Bot list instead, where a
/// control meaning "open this Bot's Applets" sat over the list of every Bot
/// and changed under the reader as the selection moved.
library;

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/bot_sessions.dart';
import 'package:frockbot_native/shell/app_shell.dart';
import 'package:frockbot_native/shell/chat_header.dart';
import 'package:frockbot_native/shell/semantics.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'applet_premount_test.dart' show PremountApi;
import 'navigation_test.dart' show identifiedBy, registration;
import 'widget_test.dart' show MemoryStore;

void main() {
  /// A desk-sized shell with one adopted Bot, whose Composition declares one
  /// Package entry called [entryLabel].
  /// [stop] tears the shell down: a session left running keeps a timer, and
  /// the framework checks for pending timers before any teardown callback.
  Future<({PremountApi api, Future<void> Function() stop})> desk(
    WidgetTester tester, {
    String entryLabel = 'Notebook',
    Size size = const Size(1440, 900),
  }) async {
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = MemoryStore();
    store.values['directory/test-user'] = jsonEncode({
      'schemaVersion': 1,
      'revision': 1,
      'bots': [registration('bot-1', 'Builder')],
    });
    final api = PremountApi(store, entryLabel: entryLabel);
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
    await tester.tap(find.byKey(const ValueKey('bot-bot-1')));
    await tester.pumpAndSettle();
    return (
      api: api,
      stop: () async {
        await tester.pumpWidget(const SizedBox());
        sessions.clear();
        links.dispose();
        api.close();
      },
    );
  }

  testWidgets('a Package entry is drawn in the Bot\'s bar, not over the list', (
    tester,
  ) async {
    // A desk: the tier that drew the entries above the list.
    final shell = await desk(tester);

    // The Bot is adopted: its Composition answered with an entry whose slot is
    // `frockbot.sidebar-actions`.
    expect(
      shell.api.requested.any((path) => path.endsWith('/package-ui')),
      isTrue,
    );
    final entry = identifiedBy(PackageIds.entry('applets', 'open'));
    expect(entry, findsOneWidget);

    // It is a door in the Bot's own bar, beside the Bot's name.
    expect(
      find.descendant(of: find.byType(ChatHeader), matching: entry),
      findsOneWidget,
    );
    // And nothing of this Bot's is drawn over the list of every Bot.
    expect(
      find.descendant(of: identifiedBy(ShellIds.sidebar), matching: entry),
      findsNothing,
    );

    // A phone's bar is GrokBot's three things: the entry is a row on the Bot's
    // own page there, as it was before the entries ever reached a bar.
    tester.view.physicalSize = const Size(400, 900);
    await tester.pumpAndSettle();
    expect(
      find.descendant(of: find.byType(ChatHeader), matching: entry),
      findsNothing,
    );

    await shell.stop();
  });

  testWidgets('one Applets door on a desk, the built-in one', (tester) async {
    // The Applets Package declares an entry called Applets, and this client
    // has an Applets entry of its own: the outlined window that opens the
    // built-in picker. Two buttons meaning the same thing, side by side in
    // one bar, is the duplicate this leaves out.
    final shell = await desk(tester, entryLabel: 'Applets');

    expect(
      find.descendant(
        of: find.byType(ChatHeader),
        matching: identifiedBy(PackageIds.entry('applets', 'open')),
      ),
      findsNothing,
    );
    final built = find.descendant(
      of: find.byType(ChatHeader),
      matching: identifiedBy(AppletIds.chip),
    );
    expect(built, findsOneWidget);
    // One door, named once.
    expect(find.byTooltip('Applets'), findsOneWidget);

    await shell.stop();
  });

  testWidgets('a Package door that is not Applets is kept', (tester) async {
    // Suppressing the duplicate must not take every Package destination with
    // it: another entry from the same Package is still a door in the bar.
    final shell = await desk(tester, entryLabel: 'Notebook');
    expect(
      find.descendant(
        of: find.byType(ChatHeader),
        matching: identifiedBy(PackageIds.entry('applets', 'open')),
      ),
      findsOneWidget,
    );
    expect(find.byTooltip('Notebook'), findsOneWidget);
    expect(find.byTooltip('Applets'), findsOneWidget);
    await shell.stop();
  });
}
