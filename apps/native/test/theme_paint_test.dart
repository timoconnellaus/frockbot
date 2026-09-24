import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/main.dart';
import 'package:frockbot_native/theme/document.dart';
import 'package:frockbot_native/theme/frock_theme.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'bot_switch_test.dart' show LatchedStore, registration, session;

/// Theme paint never needs a live observer; refuse the socket at once so the
/// test does not leave WebSocket connect timers pending after dispose.
class ThemePaintApi extends NativeApi {
  ThemePaintApi(super.store, {super.client});

  @override
  Future<WebSocketChannel> socket(
    String botId, {
    String? cursor,
    String? epoch,
  }) async {
    throw StateError('offline');
  }
}

Map<String, Object?> studioDocument() => {
  'schemaVersion': 1,
  'look': 'studio',
  'tokens': {
    'surfaces': {
      'window': '#f5f6f9',
      'surface': '#ffffff',
      'raised': '#eceef3',
      'text': '#15151e',
      'muted': '#5c5f70',
      'line': '#dfe1e8',
      'accent': '#c23359',
      'onAccent': '#ffffff',
    },
    'type': 'manrope',
    'bubbles': {'bot': 'plain', 'me': 'accent'},
  },
};

Theme shellTheme(WidgetTester tester) =>
    tester.widget<Theme>(find.byKey(const ValueKey('shell-theme')));

Theme threadTheme(WidgetTester tester, String botId) =>
    tester.widget<Theme>(find.byKey(ValueKey('thread-theme-$botId')));

Color threadWindow(WidgetTester tester, String botId) => tester
    .widget<ColoredBox>(
      find.descendant(
        of: find.byKey(ValueKey('thread-theme-$botId')),
        matching: find.byType(ColoredBox),
      ),
    )
    .color;

Theme panelTheme(WidgetTester tester) =>
    tester.widget<Theme>(find.byKey(const ValueKey('panel-theme')));

void main() {
  testWidgets(
    'Inherit uses the account Theme as-is; Studio overlays the thread and panel',
    (tester) async {
      final store = LatchedStore();
      store.values['session'] = session('user-1');
      store.values['directory/user-1'] = jsonEncode({
        'schemaVersion': 1,
        'revision': 1,
        'bots': [
          registration('bot-one', 'Rosemary'),
          {
            ...registration('bot-two', 'Clementine'),
            'look': 'studio',
            'document': studioDocument(),
          },
        ],
      });
      store.values['selection.user-1'] = 'bot-one';
      await tester.pumpWidget(
        FrockBotApp(store: store, api: ThemePaintApi(store)),
      );
      await tester.pump();
      await tester.pump();
      final ink = FrockTheme.fromDocument(ThemeDocument.ink);
      expect(find.byKey(const ValueKey('thread-theme-bot-one')), findsNothing);
      expect(find.byKey(const ValueKey('panel-theme')), findsNothing);
      expect(
        shellTheme(tester).data.scaffoldBackgroundColor,
        ink.scaffoldBackgroundColor,
      );
      await tester.tap(find.byKey(const ValueKey('bot-bot-two')));
      await tester.pump();
      expect(
        threadTheme(tester, 'bot-two').data.scaffoldBackgroundColor,
        FrockTheme.fromDocument(ThemeDocument.studio).scaffoldBackgroundColor,
      );
      expect(
        threadWindow(tester, 'bot-two'),
        FrockTheme.fromDocument(ThemeDocument.studio).scaffoldBackgroundColor,
      );
      expect(
        panelTheme(tester).data.scaffoldBackgroundColor,
        FrockTheme.fromDocument(ThemeDocument.studio).scaffoldBackgroundColor,
      );
      expect(
        shellTheme(tester).data.scaffoldBackgroundColor,
        ink.scaffoldBackgroundColor,
      );
    },
  );

  testWidgets(
    'Inherit plus Paper paints the shell Paper and a Studio sibling does not leak',
    (tester) async {
      final store = LatchedStore();
      store.values['session'] = session('user-1');
      store.values['appearance/user-1'] = jsonEncode({
        'look': 'paper',
        'timezone': 'UTC',
      });
      store.values['directory/user-1'] = jsonEncode({
        'schemaVersion': 1,
        'revision': 1,
        'bots': [
          {...registration('bot-one', 'Rosemary'), 'look': 'inherit'},
          {
            ...registration('bot-two', 'Clementine'),
            'look': 'studio',
            'document': studioDocument(),
          },
        ],
      });
      store.values['selection.user-1'] = 'bot-one';
      await tester.pumpWidget(
        FrockBotApp(store: store, api: ThemePaintApi(store)),
      );
      await tester.pump();
      await tester.pump();
      final paper = FrockTheme.fromDocument(ThemeDocument.paper);
      expect(find.byKey(const ValueKey('thread-theme-bot-one')), findsNothing);
      expect(
        shellTheme(tester).data.colorScheme.surface,
        paper.colorScheme.surface,
      );
      await tester.tap(find.byKey(const ValueKey('bot-bot-two')));
      await tester.pump();
      expect(
        threadTheme(tester, 'bot-two').data.scaffoldBackgroundColor,
        FrockTheme.fromDocument(ThemeDocument.studio).scaffoldBackgroundColor,
      );
      expect(
        threadWindow(tester, 'bot-two'),
        FrockTheme.fromDocument(ThemeDocument.studio).scaffoldBackgroundColor,
      );
      expect(
        panelTheme(tester).data.colorScheme.surface,
        FrockTheme.fromDocument(ThemeDocument.studio).colorScheme.surface,
      );
      expect(
        shellTheme(tester).data.colorScheme.surface,
        paper.colorScheme.surface,
      );
    },
  );

  testWidgets(
    'a cached document paints before /api/bots returns, and _select never assembles',
    (tester) async {
      final store = LatchedStore();
      store.values['session'] = session('user-1');
      store.values['directory/user-1'] = jsonEncode({
        'schemaVersion': 1,
        'revision': 1,
        'bots': [
          registration('bot-one', 'Rosemary'),
          {
            ...registration('bot-two', 'Clementine'),
            'look': 'studio',
            'document': studioDocument(),
          },
        ],
      });
      store.values['selection.user-1'] = 'bot-one';
      final botsGate = Completer<void>();
      final seen = <String>[];
      final api = ThemePaintApi(
        store,
        client: MockClient((request) async {
          seen.add('${request.method} ${request.url.path}');
          if (request.url.path == '/api/bots') {
            await botsGate.future;
          }
          return http.Response(
            jsonEncode({'error': 'held'}),
            503,
            headers: {'content-type': 'application/json'},
          );
        }),
      );
      await tester.pumpWidget(FrockBotApp(store: store, api: api));
      await tester.pump();
      await tester.pump();
      expect(botsGate.isCompleted, isFalse);
      expect(find.byKey(const ValueKey('thread-theme-bot-one')), findsNothing);
      expect(
        shellTheme(tester).data.scaffoldBackgroundColor,
        FrockTheme.fromDocument(ThemeDocument.ink).scaffoldBackgroundColor,
      );
      await tester.tap(find.byKey(const ValueKey('bot-bot-two')));
      await tester.pump();
      expect(
        threadTheme(tester, 'bot-two').data.scaffoldBackgroundColor,
        FrockTheme.fromDocument(ThemeDocument.studio).scaffoldBackgroundColor,
      );
      expect(
        threadWindow(tester, 'bot-two'),
        FrockTheme.fromDocument(ThemeDocument.studio).scaffoldBackgroundColor,
      );
      expect(seen.where((path) => path.contains('/look')), isEmpty);
      botsGate.complete();
    },
  );

  testWidgets(
    'a Custom directory document overlays the thread the same frame as the switch',
    (tester) async {
      final store = LatchedStore();
      final custom = {
        ...studioDocument(),
        'tokens': {
          ...(studioDocument()['tokens']! as Map),
          'surfaces': {
            ...(studioDocument()['tokens']! as Map)['surfaces'] as Map,
            'accent': '#9c1a44',
          },
        },
      };
      store.values['session'] = session('user-1');
      store.values['directory/user-1'] = jsonEncode({
        'schemaVersion': 1,
        'revision': 1,
        'bots': [
          registration('bot-one', 'Rosemary'),
          {
            ...registration('bot-two', 'Clementine'),
            'look': 'custom',
            'document': custom,
          },
        ],
      });
      store.values['selection.user-1'] = 'bot-one';
      await tester.pumpWidget(
        FrockBotApp(store: store, api: ThemePaintApi(store)),
      );
      await tester.pump();
      await tester.pump();
      expect(find.byKey(const ValueKey('thread-theme-bot-one')), findsNothing);
      await tester.tap(find.byKey(const ValueKey('bot-bot-two')));
      await tester.pump();
      expect(
        find.byKey(const ValueKey('thread-theme-bot-two')),
        findsOneWidget,
      );
      expect(find.byKey(const ValueKey('panel-theme')), findsOneWidget);
      expect(
        threadTheme(tester, 'bot-two').data.colorScheme.primary,
        const Color(0xff9c1a44),
      );
    },
  );
}
