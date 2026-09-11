/// A phone pre-mounts the live Applet's frame the moment the Bot is adopted
/// and moves it into the canvas page when that is pushed, so the tap that
/// opens the Applet presents a document that is already loaded.
library;

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/applets/canvas.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/shell/app_shell.dart';
import 'package:frockbot_native/shell/semantics.dart';
import 'package:frockbot_native/client/bot_sessions.dart';
import 'package:frockbot_native/theme/frock_theme.dart';
import 'package:frockbot_native/view/host_frame_io.dart'
    if (dart.library.js_interop) 'package:frockbot_native/view/host_frame_web.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'applets_test.dart' show applet, openViewer;
import 'bot_settings_test.dart' show account, botSettings;
import 'navigation_test.dart' show identifiedBy, registration;
import 'packages_test.dart' show catalog;
import 'widget_test.dart' show MemoryStore;

/// The routes an adopted Bot with one published Applet answers; everything
/// else is offline, which the shell tolerates.
class PremountApi extends NativeApi {
  PremountApi(super.store);
  final requested = <String>[];

  @override
  Future<Object?> request(
    String path, {
    Object? body,
    int limit = 512000,
    bool authenticated = true,
  }) async {
    requested.add(path);
    if (path.endsWith('/package-ui')) return catalog();
    if (path.endsWith('/applets/open')) {
      return {
        'schemaVersion': 1,
        'applets': [applet(generationId: 'g1').toJson()],
        'focused': {'appletId': 'todo.applet', ...openViewer()},
      };
    }
    if (path.endsWith('/applets/focus')) return {'appletId': 'todo.applet'};
    // The Bot's page draws its rows — the Applets row among them — under its
    // settings, so the settings have to load for the row to be there.
    if (path.endsWith('/bots/bot-1/settings')) {
      return {...botSettings(), 'botId': 'bot-1'};
    }
    if (path.startsWith('/api/settings')) return account();
    throw const FormatException('offline fixture');
  }

  @override
  Future<WebSocketChannel> socket(String botId, String? cursor) async =>
      throw const FormatException('offline fixture');
}

void main() {
  testWidgets(
    'a phone holds the live frame off stage and hands it to the page',
    (tester) async {
      tester.view.physicalSize = const Size(390, 844);
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

      // Adopted, and the frame is already there — off stage, behind the
      // conversation, loading its page — before anything about Applets is
      // tapped.
      expect(
        find.byType(AppletViewerFrame, skipOffstage: false),
        findsOneWidget,
      );
      expect(find.byType(AppletViewerFrame), findsNothing);
      final held = tester.state(
        find.byType(HostFrameView, skipOffstage: false),
      );

      // The Applets row, the picker, the one Applet: the page comes up holding
      // the same frame rather than building another.
      await tester.tap(identifiedBy(ShellIds.botPanelToggle));
      await tester.pumpAndSettle();
      // The row sits under the settings, below the fold on a phone.
      await tester.ensureVisible(identifiedBy(AppletIds.chip));
      await tester.pumpAndSettle();
      await tester.tap(identifiedBy(AppletIds.chip));
      await tester.pumpAndSettle();
      await tester.tap(identifiedBy('applet-choice-todo.applet'));
      await tester.pumpAndSettle();
      expect(identifiedBy(AppletIds.canvas), findsOneWidget);
      expect(find.byType(AppletViewerFrame), findsOneWidget);
      expect(tester.state(find.byType(HostFrameView)), same(held));
      // One frame in the tree, not one on the page and one off stage.
      expect(find.byType(HostFrameView, skipOffstage: false), findsOneWidget);

      // Opening from the picker posted the focus and read the open route; it
      // did not read the source.
      final afterTap = api.requested.skip(
        api.requested.indexWhere((path) => path.endsWith('/applets/focus')),
      );
      expect(afterTap.first, endsWith('/applets/focus'));
      expect(afterTap.skip(1).first, endsWith('/applets/open'));
      expect(afterTap.any((path) => path.endsWith('/source')), isFalse);

      // Back. The page keeps its frame while it slides out — a route on its
      // way out is not rebuilt, so the frame cannot move during the exit —
      // and once it is gone the shell holds a fresh frame off stage again,
      // loading, so the next open finds one ready.
      await tester.tap(identifiedBy(AppletIds.close));
      await tester.pumpAndSettle();
      expect(find.byType(AppletViewerFrame), findsNothing);
      expect(
        find.byType(AppletViewerFrame, skipOffstage: false),
        findsOneWidget,
      );

      await tester.pumpWidget(const SizedBox());
      sessions.clear();
      links.dispose();
      api.close();
    },
  );
}
