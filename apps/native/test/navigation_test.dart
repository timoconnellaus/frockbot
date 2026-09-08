import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/bot_sessions.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/shell/app_shell.dart';
import 'package:frockbot_native/shell/desktop_layout.dart';
import 'package:frockbot_native/shell/semantics.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

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
}

Finder identifiedBy(String id) => find.byWidgetPredicate(
  (widget) => widget is Semantics && widget.properties.identifier == id,
);
void main() {
  testWidgets(
    'outside the hamburger menu dismisses it without activating chat',
    (tester) async {
      tester.view.physicalSize = const Size(390, 800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      var dismissed = 0;
      var chatTaps = 0;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ShellLayout(
              navOpen: true,
              panelOpen: false,
              onDismiss: () => dismissed++,
              sidebar: const SizedBox.expand(child: Text('Bots')),
              conversation: GestureDetector(
                onTap: () => chatTaps++,
                child: const SizedBox.expand(),
              ),
              rightPanel: null,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tapAt(const Offset(365, 400));
      expect(dismissed, 1);
      expect(chatTaps, 0);
    },
  );

  testWidgets('phone menu covers the header, closes outside and on Back', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(320, 800);
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
    await tester.tap(find.byTooltip('Your Bots'));
    await tester.pumpAndSettle();
    expect(tester.getTopLeft(identifiedBy(ShellIds.sidebar)).dy, 0);
    expect(tester.getSize(identifiedBy(ShellIds.sidebar)).height, 800);
    expect(
      tester.getSize(identifiedBy(ShellIds.sidebar)).width,
      lessThanOrEqualTo(272),
    );
    await tester.tapAt(const Offset(300, 20));
    await tester.pumpAndSettle();
    expect(identifiedBy(ShellIds.sidebarProfile).hitTestable(), findsNothing);
    await tester.tap(find.byTooltip('Your Bots'));
    await tester.pumpAndSettle();
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(identifiedBy(ShellIds.sidebarProfile).hitTestable(), findsNothing);
    expect(find.byTooltip('Your Bots').hitTestable(), findsOneWidget);
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
    expect(find.text('Settings'), findsOneWidget);
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
