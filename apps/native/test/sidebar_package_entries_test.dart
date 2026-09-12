/// A Package entry belongs to the Bot that mounts it, so it is drawn on that
/// Bot's page and nowhere else. It used to be drawn above the Bot list too,
/// where a control meaning "open this Bot's Applets" sat over the list of
/// every Bot and changed under the reader as the selection moved.
library;

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/bot_sessions.dart';
import 'package:frockbot_native/shell/app_shell.dart';
import 'package:frockbot_native/shell/semantics.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'applet_premount_test.dart' show PremountApi;
import 'navigation_test.dart' show identifiedBy, registration;
import 'widget_test.dart' show MemoryStore;

void main() {
  testWidgets('a Bot\'s Package entries are never drawn beside the Bot list', (
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

    // The Bot is adopted — its Composition answered with an Applets entry
    // whose slot is `frockbot.sidebar-actions` — and no entry is on screen.
    expect(api.requested.any((path) => path.endsWith('/package-ui')), isTrue);
    expect(identifiedBy(PackageIds.entry('applets', 'open')), findsNothing);

    // The door to the Bot's Applets is on the Bot's own page, where the rest
    // of what it holds lives.
    await tester.tap(identifiedBy(ShellIds.botPanelToggle));
    await tester.pumpAndSettle();
    expect(identifiedBy(AppletIds.chip), findsWidgets);

    await tester.pumpWidget(const SizedBox());
    sessions.clear();
    links.dispose();
    api.close();
  });
}
