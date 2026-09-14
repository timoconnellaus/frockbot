/// The Applet is a window of its own at every width.
///
/// One row of chrome — the way back, the Applet's own name, and the switch to
/// its code — with the Applet under it for the rest of the page. It used to be
/// a 380-point column at a desk, inside a panel that named it "Applet" and
/// offered a second way to close it.
library;

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/applets/canvas.dart';
import 'package:frockbot_native/client/bot_sessions.dart';
import 'package:frockbot_native/shell/app_shell.dart';
import 'package:frockbot_native/shell/semantics.dart';
import 'package:frockbot_native/theme/frock_theme.dart';
import 'package:frockbot_native/view/host_frame_io.dart'
    if (dart.library.js_interop) 'package:frockbot_native/view/host_frame_web.dart';

import 'applet_premount_test.dart' show PremountApi;
import 'navigation_test.dart' show identifiedBy, registration;
import 'widget_test.dart' show MemoryStore;

void main() {
  for (final width in [1440.0, 390.0]) {
    testWidgets('the Applet fills the window at ${width.toInt()} points', (
      tester,
    ) async {
      tester.view.physicalSize = Size(width, 900);
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

      // Nothing about the Applet is up until it is asked for, at either width:
      // it is not an entry of the panel beside the conversation.
      expect(identifiedBy(AppletIds.canvas), findsNothing);
      expect(find.text('Applet'), findsNothing);

      // The way in: the header's Applets control at a desk, the row on the
      // Bot's page on a phone. Both open the picker, and the picker opens the
      // Applet.
      if (width > 640) {
        await tester.tap(identifiedBy(AppletIds.chip));
      } else {
        await tester.tap(identifiedBy(ShellIds.botPanelToggle));
        await tester.pumpAndSettle();
        await tester.ensureVisible(identifiedBy(AppletIds.chip));
        await tester.pumpAndSettle();
        await tester.tap(identifiedBy(AppletIds.chip));
      }
      await tester.pumpAndSettle();
      await tester.tap(identifiedBy('applet-choice-todo.applet'));
      await tester.pumpAndSettle();

      // A window, not a column: the canvas is as wide as the app itself.
      final canvas = identifiedBy(AppletIds.canvas);
      expect(canvas, findsOneWidget);
      expect(tester.getSize(canvas).width, width);

      // The row names the Applet, and nothing names the host: no "Applet"
      // title over it, no panel close beside the back.
      expect(find.text('Weekly Todos'), findsOneWidget);
      expect(find.text('Applet'), findsNothing);
      expect(identifiedBy(ShellIds.rightPanelClose), findsNothing);
      expect(find.byTooltip('Close the panel'), findsNothing);

      // The live Applet is under that row and runs to the bottom of the page.
      final frame = tester.getRect(find.byType(AppletViewerFrame));
      expect(frame.width, width);
      expect(frame.top, lessThan(80));

      // The switch swaps sides and swaps with them.
      final held = tester.state(find.byType(HostFrameView));
      expect(find.byTooltip('Code'), findsOneWidget);
      await tester.tap(find.byTooltip('Code'));
      await tester.pumpAndSettle();
      expect(find.byTooltip('App'), findsOneWidget);
      // The Applet is off stage while the code is up, not gone: the same
      // document is still loaded and still connected behind it.
      expect(find.byType(AppletViewerFrame), findsNothing);
      expect(
        tester.state(find.byType(HostFrameView, skipOffstage: false)),
        same(held),
      );
      await tester.tap(find.byTooltip('App'));
      await tester.pumpAndSettle();
      expect(find.byTooltip('Code'), findsOneWidget);

      // Back is the conversation again. The page keeps its frame while it
      // slides out — a route on its way out is not rebuilt — and once it is
      // gone the shell holds one off stage again, loading behind the
      // conversation so the next open finds it ready.
      await tester.tap(find.byTooltip('Back'));
      await tester.pumpAndSettle();
      expect(identifiedBy(AppletIds.canvas), findsNothing);
      expect(find.byType(AppletViewerFrame), findsNothing);
      expect(
        find.byType(AppletViewerFrame, skipOffstage: false),
        findsOneWidget,
      );
      // One frame in the tree, not one on the page and one off stage.
      expect(find.byType(HostFrameView, skipOffstage: false), findsOneWidget);

      await tester.pumpWidget(const SizedBox());
      sessions.clear();
      links.dispose();
      api.close();
    });
  }
}
