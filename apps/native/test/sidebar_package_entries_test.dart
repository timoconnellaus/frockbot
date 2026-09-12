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
  testWidgets('a Package entry is drawn in the Bot\'s bar, not over the list', (
    tester,
  ) async {
    // A desk: the tier that drew the entries above the list.
    tester.view.physicalSize = const Size(1440, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = MemoryStore();
    store.values['directory/test-user'] = jsonEncode({
      'schemaVersion': 1,
      'revision': 1,
      'bots': [registration('bot-1', 'Builder')],
    });
    final api = PremountApi(store);
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

    // The Bot is adopted: its Composition answered with an Applets entry whose
    // slot is `frockbot.sidebar-actions`.
    expect(api.requested.any((path) => path.endsWith('/package-ui')), isTrue);
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

    await tester.pumpWidget(const SizedBox());
    sessions.clear();
    links.dispose();
    api.close();
  });
}
