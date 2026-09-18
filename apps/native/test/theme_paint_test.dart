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

import 'bot_switch_test.dart' show LatchedStore, registration, session;

Map<String, Object?> studioDocument() => {
  'schemaVersion': 1,
  'look': 'studio',
  'tokens': {
    'surfaces': {
      'window': '#faf7f2',
      'surface': '#ffffff',
      'raised': '#f2ece4',
      'text': '#1e1d27',
      'muted': '#6d6974',
      'line': '#e7e0d9',
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
    .color!;

void main() {
  testWidgets(
    'switching to a Studio directory row paints those colours on the first pump',
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
      await tester.pumpWidget(FrockBotApp(store: store));
      await tester.pump();
      await tester.pump();
      expect(
        threadTheme(tester, 'bot-one').data.scaffoldBackgroundColor,
        FrockTheme.fromDocument(ThemeDocument.ink).scaffoldBackgroundColor,
      );
      expect(
        threadWindow(tester, 'bot-one'),
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
    },
  );

  testWidgets(
    'Inherit plus Paper paints the thread Paper and a Studio sibling does not leak',
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
      await tester.pumpWidget(FrockBotApp(store: store));
      await tester.pump();
      await tester.pump();
      final paper = FrockTheme.fromDocument(ThemeDocument.paper);
      expect(
        threadTheme(tester, 'bot-one').data.scaffoldBackgroundColor,
        paper.scaffoldBackgroundColor,
      );
      expect(threadWindow(tester, 'bot-one'), paper.scaffoldBackgroundColor);
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
      final api = NativeApi(
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
      expect(
        threadTheme(tester, 'bot-one').data.scaffoldBackgroundColor,
        FrockTheme.fromDocument(ThemeDocument.ink).scaffoldBackgroundColor,
      );
      expect(
        threadWindow(tester, 'bot-one'),
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
}
