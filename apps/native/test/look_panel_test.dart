import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/bot_sessions.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/shell/app_shell.dart';
import 'package:frockbot_native/shell/semantics.dart';
import 'package:frockbot_native/theme/document.dart';
import 'package:frockbot_native/theme/frock_theme.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'navigation_test.dart' show registration;
import 'shell_layout_test.dart' show byIdentifier;
import 'widget_test.dart' show MemoryStore;

Theme threadTheme(WidgetTester tester, String botId) =>
    tester.widget<Theme>(find.byKey(ValueKey('thread-theme-$botId')));

class LookHarness extends NativeApi {
  final MemoryStore memory;
  String look = 'inherit';
  int lookRevision = 0;
  LookHarness(this.memory) : super(memory);

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
        'bots': [registration('alpha', 'Alpha')],
      };
    }
    if (path == '/api/bots/lifecycles') {
      return {'schemaVersion': 1, 'lifecycles': []};
    }
    if (path == '/api/bots/identities') return {'identities': []};
    final settings = RegExp(r'^/api/bots/(\w+)/settings$').firstMatch(path);
    if (settings != null && body == null) {
      return {
        'revision': 1,
        'profile': {'name': 'Alpha'},
      };
    }
    final voice = RegExp(r'^/api/bots/(\w+)/voice$').firstMatch(path);
    if (voice != null && body == null) {
      return {'schemaVersion': 1, 'botId': voice.group(1), 'revision': 0};
    }
    final lookPath = RegExp(r'^/api/bots/(\w+)/look$').firstMatch(path);
    if (lookPath != null) {
      if (body is Map) {
        look = body['look'] as String? ?? look;
        lookRevision += 1;
        return {
          'schemaVersion': 1,
          'commandId': body['commandId'],
          'status': 'applied',
          'revision': lookRevision,
        };
      }
      return {
        'schemaVersion': 1,
        'botId': lookPath.group(1),
        'revision': lookRevision,
        'look': look,
      };
    }
    throw const FormatException('offline fixture');
  }

  @override
  Future<WebSocketChannel> socket(
    String botId, {
    String? cursor,
    String? epoch,
  }) async =>
      throw const FormatException('offline fixture');
}

void main() {
  testWidgets(
    'Look opens in the panel beside the thread and paints a chosen look',
    (tester) async {
      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final store = MemoryStore();
      final api = LookHarness(store);
      final sessions = BotSessions(api: api, store: store);
      final links = ValueNotifier<String?>(null);
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: AppShell(
            api: api,
            store: store,
            sessions: sessions,
            userId: 'u',
            botLinks: links,
            onSignOut: () async {},
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('bot-alpha')));
      await tester.pumpAndSettle();

      expect(byIdentifier(ShellIds.composer), findsOneWidget);
      expect(find.byKey(const ValueKey('thread-theme-alpha')), findsNothing);

      await tester.tap(byIdentifier(SettingsIds.botPageSettings));
      await tester.pumpAndSettle();
      await tester.ensureVisible(byIdentifier(SettingsIds.botLook));
      await tester.pumpAndSettle();
      await tester.tap(byIdentifier(SettingsIds.botLook));
      await tester.pumpAndSettle();

      expect(byIdentifier(LookIds.settings), findsOneWidget);
      expect(find.widgetWithText(AppBar, 'Look'), findsNothing);
      expect(byIdentifier(ShellIds.composer).hitTestable(), findsOneWidget);

      await tester.tap(byIdentifier(LookIds.option('studio')));
      await tester.pumpAndSettle();
      expect(api.look, 'studio');
      expect(find.byKey(const ValueKey('thread-theme-alpha')), findsOneWidget);
      expect(
        threadTheme(tester, 'alpha').data.scaffoldBackgroundColor,
        FrockTheme.fromDocument(ThemeDocument.studio).scaffoldBackgroundColor,
      );

      await tester.pumpWidget(const SizedBox());
      sessions.clear();
      links.dispose();
      await tester.pump();
    },
  );
}
