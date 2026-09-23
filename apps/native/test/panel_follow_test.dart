/// The Bot's `panel_focus` puts its page in front of the person. The pointer
/// moving under the shell opens the panel region — the column on a wide
/// window, a pushed page on a phone — and the pointer closing takes it away.
library;

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/bot_sessions.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/panels/canvas.dart';
import 'package:frockbot_native/shell/app_shell.dart';
import 'package:frockbot_native/shell/bot_page.dart';
import 'package:frockbot_native/shell/semantics.dart';
import 'package:frockbot_native/theme/frock_theme.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'navigation_test.dart' show identifiedBy, registration;
import 'panel_canvas_test.dart' show panelView;
import 'widget_test.dart' show MemoryStore;

class PanelDeskApi extends NativeApi {
  PanelDeskApi(super.store);

  Map<String, Object?> view = panelView(focused: false);

  @override
  Future<Object?> request(
    String path, {
    Object? body,
    int limit = 512000,
    bool authenticated = true,
  }) async {
    if (path == '/api/bots') {
      return {
        'schemaVersion': 1,
        'revision': 1,
        'bots': [registration('bot-1', 'Builder')],
      };
    }
    if (path == '/api/bots/lifecycles') {
      return {'schemaVersion': 1, 'lifecycles': <Object>[]};
    }
    if (path == '/api/bots/identities') return {'identities': []};
    if (path == '/api/bots/unread') {
      return {'schemaVersion': 1, 'unread': <Object>[]};
    }
    if (path.endsWith('/package-ui')) {
      return {'schemaVersion': 1, 'packages': <Object>[]};
    }
    if (path.endsWith('/panels/open')) return view;
    if (path.endsWith('/settings') && body == null) {
      return {
        'revision': 1,
        'profile': {'name': 'Builder'},
      };
    }
    if (path.endsWith('/voice') && body == null) {
      return {'schemaVersion': 1, 'botId': 'bot-1', 'revision': 0};
    }
    if (path.endsWith('/routines/inbox')) {
      return {'schemaVersion': 1, 'runs': <Object>[]};
    }
    if (path.endsWith('/plugins') && body == null) {
      return {
        'schemaVersion': 1,
        'ownerId': 'test-user',
        'revision': 0,
        'plugins': <Object>[],
      };
    }
    throw FormatException('outside this fixture: $path');
  }

  @override
  Future<WebSocketChannel> socket(
    String botId, {
    String? cursor,
    String? epoch,
  }) async => throw const FormatException('outside this fixture');
}

void main() {
  Future<({PanelDeskApi api, Future<void> Function() stop})> desk(
    WidgetTester tester,
    Size size,
  ) async {
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
    final api = PanelDeskApi(store);
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
      },
    );
  }

  // The shell's canvas. Its poll() stands in for the read a running Turn
  // makes, and the one the Turn settling makes.
  PanelCanvasController canvasOf(WidgetTester tester) => tester
      .widget<BotPageView>(find.byType(BotPageView, skipOffstage: false))
      .panels!;

  testWidgets('the Bot focusing a panel opens the column, and closing it '
      'takes it away', (tester) async {
    final shell = await desk(tester, const Size(1440, 900));
    final canvas = canvasOf(tester);
    expect(find.byType(PanelCanvas), findsNothing);

    shell.api.view = panelView(revision: 3);
    await canvas.poll();
    await tester.pumpAndSettle();
    expect(find.byType(PanelCanvas), findsOneWidget);
    expect(find.text('Hello'), findsWidgets);

    shell.api.view = panelView(focused: false);
    await canvas.poll();
    await tester.pumpAndSettle();
    expect(find.byType(PanelCanvas), findsNothing);
    expect(find.byType(BotPageView), findsOneWidget);

    await shell.stop();
  });

  testWidgets('the Bot showing the tab the person closed shows it again', (
    tester,
  ) async {
    final shell = await desk(tester, const Size(1440, 900));
    final canvas = canvasOf(tester);
    shell.api.view = panelView(revision: 3);
    await canvas.poll();
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Back'));
    await tester.pumpAndSettle();
    expect(find.byType(PanelCanvas), findsNothing);

    shell.api.view = panelView(revision: 4);
    await canvas.poll();
    await tester.pumpAndSettle();
    expect(find.byType(PanelCanvas), findsOneWidget);

    await shell.stop();
  });

  testWidgets('on a phone the panel is one pushed page', (tester) async {
    final shell = await desk(tester, const Size(400, 800));
    // A phone draws the Bot page only when it is opened from the bar.
    await tester.tap(identifiedBy(ShellIds.rightPanelToggle));
    await tester.pumpAndSettle();
    final canvas = canvasOf(tester);
    await tester.pageBack();
    await tester.pumpAndSettle();
    expect(find.byType(BotPageView), findsNothing);

    shell.api.view = panelView(revision: 3);
    await canvas.poll();
    await tester.pumpAndSettle();
    expect(find.byType(PanelCanvas), findsOneWidget);

    shell.api.view = panelView(revision: 4);
    await canvas.poll();
    await tester.pumpAndSettle();
    expect(find.byType(PanelCanvas, skipOffstage: false), findsOneWidget);

    shell.api.view = panelView(focused: false);
    await canvas.poll();
    await tester.pumpAndSettle();
    expect(find.byType(PanelCanvas, skipOffstage: false), findsNothing);

    await shell.stop();
  });
}
