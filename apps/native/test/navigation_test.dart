import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/bot_sessions.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/shell/app_shell.dart';
import 'package:frockbot_native/shell/semantics.dart';
import 'package:frockbot_native/theme/frock_theme.dart';
import 'package:frockbot_native/update/app_version.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'widget_test.dart' show MemoryStore;

class OfflineApi extends NativeApi {
  OfflineApi(super.store);
  @override
  Future<Object?> request(
    String path, {
    Object? body,
    int limit = 512000,
    bool authenticated = true,
  }) async => throw const FormatException('offline fixture');

  // A socket that is refused at once, rather than one left connecting under
  // the transport's own deadline for the length of the test.
  @override
  Future<WebSocketChannel> socket(String botId, String? cursor) async =>
      throw const FormatException('offline fixture');
}

Finder identifiedBy(String id) => find.byWidgetPredicate(
  (widget) => widget is Semantics && widget.properties.identifier == id,
);
Map<String, dynamic> registration(String botId, String name) => {
  'schemaVersion': 1,
  'botId': botId,
  'registeredAt': '2026-09-05T00:00:00.000Z',
  'initialName': name,
  'sheep': {
    'schemaVersion': 1,
    'background': 'a',
    'upper': 'b',
    'middle': 'c',
    'lower': 'd',
  },
};

void main() {
  creditTests();
  testWidgets(
    'a phone opens on the Bot list, and Back from a chat is the list',
    (tester) async {
      tester.view.physicalSize = const Size(320, 800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final store = MemoryStore();
      // The directory the last run cached: what a phone shows before the
      // network answers, and here the only answer it gets.
      store.values['directory/test-user'] = jsonEncode({
        'schemaVersion': 1,
        'revision': 1,
        'bots': [registration('bot-one', 'Rosemary')],
      });
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
      // The list is the screen: no hamburger, no drawer, the whole width.
      expect(find.byTooltip('Your Bots'), findsNothing);
      expect(tester.getSize(identifiedBy(ShellIds.sidebar)).width, 320);
      expect(
        identifiedBy(ShellIds.sidebarProfile).hitTestable(),
        findsOneWidget,
      );
      expect(identifiedBy(ShellIds.conversation), findsNothing);

      // A row opens its conversation as a page, with the way back in its bar.
      await tester.tap(find.byKey(const ValueKey('bot-bot-one')));
      await tester.pumpAndSettle();
      expect(find.widgetWithText(AppBar, 'Rosemary'), findsOneWidget);
      expect(identifiedBy(ShellIds.sidebarToggle), findsOneWidget);
      expect(identifiedBy(ShellIds.botPanelToggle), findsOneWidget);
      expect(find.byTooltip('Routines'), findsNothing);
      expect(identifiedBy(ShellIds.sidebar), findsNothing);

      // The system gesture is the same way back, and never the way out.
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      expect(identifiedBy(ShellIds.sidebar).hitTestable(), findsOneWidget);
      expect(find.widgetWithText(AppBar, 'Rosemary'), findsNothing);
      expect(find.byType(AppShell), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('bot-bot-one')));
      await tester.pumpAndSettle();
      await tester.tap(identifiedBy(ShellIds.sidebarToggle));
      await tester.pumpAndSettle();
      expect(identifiedBy(ShellIds.sidebar).hitTestable(), findsOneWidget);

      await tester.pumpWidget(const SizedBox());
      sessions.clear();
      links.dispose();
      api.close();
    },
  );

  testWidgets('the Profile page ends with the running version', (tester) async {
    tester.view.physicalSize = const Size(900, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = MemoryStore();
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
          version: () async => const AppVersion(build: '1.2.0+17', patch: 3),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(identifiedBy(ShellIds.sidebarProfile));
    await tester.pumpAndSettle();
    final version = identifiedBy(SettingsIds.profileVersion);
    expect(version, findsOneWidget);
    expect(
      find.descendant(
        of: version,
        matching: find.text('Version 1.2.0+17 · patch 3'),
      ),
      findsOneWidget,
    );
    // Below the door out, as the last thing on the page.
    final signOut = identifiedBy(SettingsIds.profileSignOut);
    expect(
      tester.getTopLeft(version).dy,
      greaterThan(tester.getBottomLeft(signOut).dy),
    );
    await tester.pumpWidget(const SizedBox());
    sessions.clear();
    links.dispose();
    api.close();
  });

  testWidgets('the Marketplace is a page on a phone and a dialog beside it', (
    tester,
  ) async {
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = MemoryStore();
    final api = OfflineApi(store);
    final sessions = BotSessions(api: api, store: store);
    final links = ValueNotifier<String?>(null);
    Widget shell() => MaterialApp(
      theme: FrockTheme.theme(Brightness.dark),
      home: AppShell(
        api: api,
        store: store,
        sessions: sessions,
        userId: 'test-user',
        botLinks: links,
        onSignOut: () async {},
      ),
    );

    // A phone: the door is in the list's bar, and it opens a page over the
    // list, with the way back in that page's bar.
    tester.view.physicalSize = const Size(320, 800);
    await tester.pumpWidget(shell());
    await tester.pumpAndSettle();
    expect(find.text('Marketplace'), findsNothing);
    await tester.tap(identifiedBy(ShellIds.sidebarMarketplace));
    await tester.pumpAndSettle();
    expect(find.widgetWithText(AppBar, 'Marketplace'), findsOneWidget);
    expect(find.byType(Dialog), findsNothing);
    expect(identifiedBy(ShellIds.sidebar), findsNothing);
    await tester.pageBack();
    await tester.pumpAndSettle();
    expect(identifiedBy(ShellIds.sidebar).hitTestable(), findsOneWidget);

    // A desktop: the door is the foot of the column, named, and it opens a
    // dialog over the shell rather than a page in place of it.
    await tester.pumpWidget(const SizedBox());
    tester.view.physicalSize = const Size(1200, 800);
    await tester.pumpWidget(shell());
    await tester.pumpAndSettle();
    final foot = identifiedBy(ShellIds.sidebarMarketplace);
    expect(
      find.descendant(of: foot, matching: find.text('Marketplace')),
      findsOneWidget,
    );
    await tester.tap(foot);
    await tester.pumpAndSettle();
    expect(find.byType(Dialog), findsOneWidget);
    expect(identifiedBy(ConnectorIds.marketplaceDialog), findsOneWidget);
    expect(find.widgetWithText(AppBar, 'Marketplace'), findsOneWidget);
    expect(identifiedBy(ShellIds.sidebar), findsOneWidget);
    await tester.tap(find.byTooltip('Close marketplace'));
    await tester.pumpAndSettle();
    expect(find.byType(Dialog), findsNothing);

    // It is not in the account sheet any more: the list is where it lives.
    await tester.tap(identifiedBy(ShellIds.sidebarProfile));
    await tester.pumpAndSettle();
    expect(identifiedBy(SettingsIds.profileMenu), findsOneWidget);
    expect(find.text('Connected apps'), findsNothing);
    expect(find.widgetWithText(ListTile, 'Marketplace'), findsNothing);

    await tester.pumpWidget(const SizedBox());
    sessions.clear();
    links.dispose();
    api.close();
  });

  testWidgets('Settings back returns to the Profile page', (tester) async {
    tester.view.physicalSize = const Size(900, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = MemoryStore();
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
    await tester.tap(identifiedBy(ShellIds.sidebarProfile));
    await tester.pumpAndSettle();
    await tester.tap(identifiedBy(SettingsIds.profileSettings));
    await tester.pumpAndSettle();
    expect(find.text('Personal details'), findsOneWidget);
    await tester.pageBack();
    await tester.pumpAndSettle();
    expect(identifiedBy(SettingsIds.profileMenu), findsOneWidget);
    expect(find.byType(BottomSheet), findsNothing);
    await tester.pumpWidget(const SizedBox());
    sessions.clear();
    links.dispose();
    api.close();
  });
}

/// An API that answers the account's balance and nothing else, so the shell
/// can be shown with a metered account while every other read is offline.
class BilledApi extends OfflineApi {
  final Map<String, Object?> billing;
  BilledApi(super.store, this.billing);
  @override
  Future<Object?> request(
    String path, {
    Object? body,
    int limit = 512000,
    bool authenticated = true,
  }) async {
    if (path == '/api/billing') return billing;
    throw const FormatException('offline fixture');
  }
}

Map<String, Object?> meteredBilling({required bool canSpend}) => {
  'metered': true,
  'paymentsAvailable': true,
  'canSpend': canSpend,
  'subscribed': false,
  'suspended': false,
  'includedMicros': 0,
  'complimentaryMicros': canSpend ? 7250000 : 0,
  'purchasedMicros': 0,
  'reservedMicros': 0,
};

void creditTests() {
  testWidgets('the Profile page opens with what the account can spend', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(900, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = MemoryStore();
    final api = BilledApi(store, meteredBilling(canSpend: true));
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
    await tester.tap(identifiedBy(ShellIds.sidebarProfile));
    await tester.pumpAndSettle();
    final credit = identifiedBy(SettingsIds.profileCredit);
    expect(credit, findsOneWidget);
    expect(
      find.descendant(
        of: credit,
        matching: find.text('US\$7.25 credit remaining'),
      ),
      findsOneWidget,
    );
    // Above the account's own rows: the first thing under the name.
    expect(
      tester.getTopLeft(credit).dy,
      lessThan(tester.getTopLeft(identifiedBy(SettingsIds.profileSettings)).dy),
    );
    await tester.tap(credit);
    await tester.pumpAndSettle();
    expect(find.text('Billing & usage'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    sessions.clear();
    links.dispose();
    api.close();
  });

  testWidgets('an account that cannot spend is told before it types', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(900, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = MemoryStore();
    store.values['directory/test-user'] = jsonEncode({
      'schemaVersion': 1,
      'revision': 1,
      'bots': [registration('bot-one', 'Rosemary')],
    });
    final api = BilledApi(store, meteredBilling(canSpend: false));
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
    await tester.tap(find.byKey(const ValueKey('bot-bot-one')));
    await tester.pumpAndSettle();
    final banner = identifiedBy(ShellIds.outOfCredit);
    expect(banner, findsOneWidget);
    expect(
      find.descendant(
        of: banner,
        matching: find.text(
          'Your Bots can’t reply until you subscribe or add credit.',
        ),
      ),
      findsOneWidget,
    );
    await tester.tap(
      find.descendant(of: banner, matching: find.text('Open Billing')),
    );
    await tester.pumpAndSettle();
    expect(find.text('Billing & usage'), findsOneWidget);
    // And the Profile says the same, in red.
    await tester.pageBack();
    await tester.pumpAndSettle();
    await tester.tap(identifiedBy(ShellIds.sidebarProfile));
    await tester.pumpAndSettle();
    expect(
      find.descendant(
        of: identifiedBy(SettingsIds.profileCredit),
        matching: find.text('No credit'),
      ),
      findsOneWidget,
    );
    await tester.pumpWidget(const SizedBox());
    sessions.clear();
    links.dispose();
    api.close();
  });
}
