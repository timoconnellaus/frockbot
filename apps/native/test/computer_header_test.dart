import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/bot_sessions.dart';
import 'package:frockbot_native/shell/app_shell.dart';
import 'package:frockbot_native/shell/chat_header.dart';
import 'package:frockbot_native/shell/chat_icons.dart';
import 'package:frockbot_native/shell/semantics.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'computer_test.dart' show projection;
import 'navigation_test.dart' show OfflineApi, identifiedBy, registration;
import 'widget_test.dart' show MemoryStore;

class ComputerHeaderApi extends OfflineApi {
  ComputerHeaderApi(super.store);
  List<Object?> events = [];
  bool started = false;
  bool completed = false;
  final commands = <Object?>[];

  @override
  Future<Object?> request(
    String path, {
    Object? body,
    int limit = 512000,
    bool authenticated = true,
  }) async {
    if (path.contains('/computer') && body != null) commands.add(body);
    if (path.endsWith('/computer')) {
      return projection(phase: 'idle', viewer: false, snapshot: false);
    }
    if (path.endsWith('/turns')) {
      return {
        'schemaVersion': 1,
        'runs': [
          if (started && path.contains('/bot-1/'))
            {
              'schemaVersion': 1,
              'runId': 'run-1',
              'admittedAt': '2026-09-05T00:00:00.000Z',
              'input': 'Use your computer',
              'status': completed ? 'completed' : 'running',
              'events': events,
              if (completed) 'outcome': {'type': 'completed', 'text': ''},
            },
        ],
        'page': {'truncated': false},
      };
    }
    return super.request(
      path,
      body: body,
      limit: limit,
      authenticated: authenticated,
    );
  }
}

void main() {
  for (final width in [390.0, 1280.0]) {
    testWidgets(
      'Bot Computer activity colors the closed viewer header at $width',
      (tester) async {
        tester.view.physicalSize = Size(width, 844);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.reset);
        final store = MemoryStore();
        store.values['directory/test-user'] = jsonEncode({
          'schemaVersion': 1,
          'revision': 1,
          'bots': [
            registration('bot-1', 'Rosemary'),
            registration('bot-2', 'Clementine'),
          ],
        });
        final api = ComputerHeaderApi(store);
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
        final chat = sessions.open('test-user', 'bot-1').controller;
        Color? iconColor() => IconTheme.of(
          tester.element(
            find.descendant(
              of: find.byTooltip('Computer'),
              matching: find.byType(ChatIcon),
            ),
          ),
        ).color;
        expect(iconColor(), isNot(computerRunningColor));
        api.started = true;
        api.events = [
          {
            'type': 'tool/call',
            'call': {
              'id': 'call-1',
              'name': 'call_dynamic_tool',
              'input': {
                'namespace': 'frockbot',
                'toolName': 'computer_exec',
                'argumentsJson': '{"command":"pwd"}',
              },
            },
          },
        ];
        await chat.invalidate();
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 250));
        expect(chat.error, isNull);
        expect(
          iconColor(),
          computerRunningColor,
          reason: 'Bot activity must turn the header blue without opening it',
        );
        if (width == 390) {
          await tester.tap(identifiedBy(ShellIds.sidebarToggle));
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 400));
        }
        await tester.tap(find.byKey(const ValueKey('bot-bot-2')));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 400));
        expect(iconColor(), isNot(computerRunningColor));
        if (width == 390) {
          await tester.tap(identifiedBy(ShellIds.sidebarToggle));
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 400));
        }
        await tester.tap(find.byKey(const ValueKey('bot-bot-1')));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 400));
        expect(iconColor(), computerRunningColor);
        api.completed = true;
        await chat.invalidate();
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 250));
        expect(iconColor(), isNot(computerRunningColor));
        expect(api.commands, isEmpty);
        await tester.pumpWidget(const SizedBox());
        sessions.clear();
        links.dispose();
        await tester.pump();
      },
    );
  }
}
