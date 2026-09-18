/// The selected Bot's Applets: a mode of the sidebar on a wide window, a page
/// on a phone. Each row says whether the Bot owns the Applet or has it shared,
/// and only the owner's rows offer a delete.
library;

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/applets/canvas.dart';
import 'package:frockbot_native/applets/list.dart';
import 'package:frockbot_native/client/bot_sessions.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/shell/app_shell.dart';
import 'package:frockbot_native/shell/semantics.dart';
import 'package:frockbot_native/theme/frock_theme.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'applets_test.dart' show openViewer, summaryJson;
import 'bot_settings_test.dart' show account, botSettings;
import 'navigation_test.dart' show identifiedBy, registration;
import 'packages_test.dart' show catalog;
import 'settings_test.dart' show SettingsApi;
import 'widget_test.dart' show MemoryStore;

/// Two Bots. Builder owns Weekly Todos and shares it with Scout; Scout owns
/// Field Notes and shares it with Builder.
class AppletListApi extends NativeApi {
  AppletListApi(super.store, {this.onDelete});
  final requested = <String>[];
  final Future<Object?> Function(String path)? onDelete;
  bool deleted = false;

  @override
  Future<Object?> request(
    String path, {
    Object? body,
    int limit = 512000,
    bool authenticated = true,
  }) async {
    requested.add(path);
    if (path.endsWith('/package-ui')) return catalog();
    if (path == '/api/bots/bot-1/applets/open') {
      return {
        'schemaVersion': 1,
        'applets': [
          if (!deleted)
            summaryJson(
              'todo.applet',
              'Weekly Todos',
              generationId: 'g1',
              sharedWithBotIds: ['bot-2'],
            ),
          summaryJson(
            'notes.applet',
            'Field Notes',
            generationId: 'g1',
            access: 'shared',
            ownerBotId: 'bot-2',
          ),
        ],
        'focused': {'appletId': 'todo.applet', ...openViewer()},
      };
    }
    if (path.endsWith('/applets/open')) {
      return {'schemaVersion': 1, 'applets': <Object?>[]};
    }
    if (path.endsWith('/delete')) {
      final answer = await onDelete?.call(path);
      deleted = true;
      return answer ?? {'schemaVersion': 1, 'status': 'deleted'};
    }
    if (path.endsWith('/applets/focus')) return {'appletId': 'todo.applet'};
    if (path.contains('/settings') && path.startsWith('/api/bots/')) {
      return {...botSettings(), 'botId': path.split('/')[3]};
    }
    // The settings read also asks how the Bot sounds; these Bots have chosen
    // nothing, so the record carries no voice at all (ADR 0031).
    if (path.endsWith('/voice') && path.startsWith('/api/bots/')) {
      return {'schemaVersion': 1, 'botId': path.split('/')[3], 'revision': 0};
    }
    if (path.endsWith('/look') && path.startsWith('/api/bots/')) {
      return {
        'schemaVersion': 1,
        'botId': path.split('/')[3],
        'revision': 0,
        'look': 'inherit',
      };
    }
    if (path.startsWith('/api/settings')) return account();
    throw const FormatException('offline fixture');
  }

  @override
  Future<WebSocketChannel> socket(String botId, String? cursor) async =>
      throw const FormatException('offline fixture');
}

void main() {
  Future<({AppletListApi api, Future<void> Function() stop})> shell(
    WidgetTester tester, {
    Size size = const Size(1440, 900),
    Future<Object?> Function(String path)? onDelete,
  }) async {
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = MemoryStore();
    store.values['directory/test-user'] = jsonEncode({
      'schemaVersion': 1,
      'revision': 1,
      'bots': [
        registration('bot-1', 'Builder'),
        registration('bot-2', 'Scout'),
      ],
    });
    final api = AppletListApi(store, onDelete: onDelete);
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
        api.close();
      },
    );
  }

  testWidgets('the Bot page’s Applets row turns the sidebar to the Bot’s '
      'Applets, and back returns it to the Bots', (tester) async {
    final desk = await shell(tester);
    expect(identifiedBy(AppletIds.list), findsNothing);

    await tester.tap(identifiedBy(SettingsIds.botPageAppletsAll));
    await tester.pumpAndSettle();
    // In the sidebar's place, not over the conversation, and no dialog.
    expect(
      find.descendant(
        of: identifiedBy(ShellIds.sidebar),
        matching: identifiedBy(AppletIds.list),
      ),
      findsOneWidget,
    );
    expect(find.byType(AlertDialog), findsNothing);
    expect(find.byKey(const ValueKey('bot-bot-2')), findsNothing);

    // Owner and shared, the sharer named from the identities the shell holds.
    expect(identifiedBy(AppletIds.row('todo.applet')), findsOneWidget);
    expect(identifiedBy(AppletIds.row('notes.applet')), findsOneWidget);
    expect(
      find.descendant(
        of: identifiedBy(AppletIds.access('todo.applet')),
        matching: find.text('Owner'),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: identifiedBy(AppletIds.access('notes.applet')),
        matching: find.text('Shared by Scout'),
      ),
      findsOneWidget,
    );
    // A delete only where this Bot owns the Applet.
    expect(identifiedBy(AppletIds.delete('todo.applet')), findsOneWidget);
    expect(identifiedBy(AppletIds.delete('notes.applet')), findsNothing);

    await tester.tap(identifiedBy(AppletIds.listBack));
    await tester.pumpAndSettle();
    expect(identifiedBy(AppletIds.list), findsNothing);
    expect(find.byKey(const ValueKey('bot-bot-2')), findsOneWidget);
    await desk.stop();
  });

  testWidgets('a row opens its Applet, exactly as the picker did', (
    tester,
  ) async {
    final desk = await shell(tester);
    await tester.tap(identifiedBy(SettingsIds.botPageAppletsAll));
    await tester.pumpAndSettle();
    await tester.tap(identifiedBy(AppletIds.row('todo.applet')));
    await tester.pumpAndSettle();
    expect(identifiedBy(AppletIds.canvas), findsOneWidget);
    expect(desk.api.requested, contains('/api/bots/bot-1/applets/focus'));
    await desk.stop();
  });

  testWidgets('the Bot page’s Applets row is a page of its own on a phone', (
    tester,
  ) async {
    final phone = await shell(tester, size: const Size(390, 844));
    await tester.tap(identifiedBy(ShellIds.botPanelToggle));
    await tester.pumpAndSettle();
    await tester.ensureVisible(identifiedBy(SettingsIds.botPageAppletsAll));
    await tester.pumpAndSettle();
    await tester.tap(identifiedBy(SettingsIds.botPageAppletsAll));
    await tester.pumpAndSettle();
    expect(identifiedBy(AppletIds.list), findsOneWidget);
    // The page's own back is the way out; there is no sidebar to return to.
    expect(identifiedBy(AppletIds.listBack), findsNothing);
    expect(find.byType(BackButton), findsOneWidget);
    expect(find.text('Shared by Scout'), findsOneWidget);
    await tester.tap(find.byType(BackButton));
    await tester.pumpAndSettle();
    expect(identifiedBy(AppletIds.list), findsNothing);
    await phone.stop();
  });

  testWidgets('a delete names the Bots the Applet is shared with, and goes to '
      'the Bot’s own route', (tester) async {
    final desk = await shell(tester);
    await tester.tap(identifiedBy(SettingsIds.botPageAppletsAll));
    await tester.pumpAndSettle();
    await tester.tap(identifiedBy(AppletIds.delete('todo.applet')));
    await tester.pumpAndSettle();
    expect(find.text('Delete Weekly Todos?'), findsOneWidget);
    expect(find.textContaining('It is also used by Scout.'), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, 'Delete'));
    await tester.pumpAndSettle();
    expect(
      desk.api.requested,
      contains('/api/bots/bot-1/applets/todo.applet/delete'),
    );
    expect(identifiedBy(AppletIds.row('todo.applet')), findsNothing);
    expect(identifiedBy(AppletIds.row('notes.applet')), findsOneWidget);
    await desk.stop();
  });

  group('the list on its own', () {
    Future<AppletCanvasController> pump(
      WidgetTester tester,
      Future<Object?> Function(String, Object?) handler,
    ) async {
      final controller = AppletCanvasController(
        SettingsApi(MemoryStore(), handler),
        'bot-1',
      );
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: Scaffold(
            body: AppletList(
              controller: controller,
              botName: 'Builder',
              nameOf: (id) => id == 'bot-2' ? 'Scout' : null,
              onOpen: (_) {},
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      return controller;
    }

    testWidgets('deletes only after confirmation and removes the entry', (
      tester,
    ) async {
      var deleted = false;
      final controller = await pump(tester, (path, body) async {
        if (path.endsWith('/applets/open')) {
          return {
            'schemaVersion': 1,
            'applets': [
              if (!deleted) summaryJson('todo.applet', 'Weekly Todos'),
            ],
          };
        }
        if (path == '/api/bots/bot-1/applets/todo.applet/delete') {
          expect(body, {'schemaVersion': 1});
          deleted = true;
          return {'schemaVersion': 1, 'status': 'deleted'};
        }
        throw StateError(path);
      });
      await tester.tap(find.byTooltip('Delete Weekly Todos'));
      await tester.pumpAndSettle();
      // Nobody else uses it, so nobody else is named.
      expect(find.textContaining('also used by'), findsNothing);
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(deleted, isFalse);
      await tester.tap(find.byTooltip('Delete Weekly Todos'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Delete'));
      await tester.pumpAndSettle();
      expect(deleted, isTrue);
      expect(find.text('Weekly Todos'), findsNothing);
      expect(
        find.text('No Applets yet. Ask Builder to build one.'),
        findsOneWidget,
      );
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
    });

    testWidgets('deleting an Applet that is already gone is not a failure', (
      tester,
    ) async {
      var deleted = false;
      final controller = await pump(tester, (path, body) async {
        if (path.endsWith('/applets/open')) {
          return {
            'schemaVersion': 1,
            'applets': [
              if (!deleted) summaryJson('todo.applet', 'Weekly Todos'),
            ],
          };
        }
        if (path.endsWith('/delete')) {
          // Another window already deleted it, so the route answers with the
          // settled truth that there is no such Applet.
          deleted = true;
          throw const RequestFailure(
            'Applet "todo.applet" is unavailable',
            404,
          );
        }
        throw StateError(path);
      });
      await tester.tap(find.byTooltip('Delete Weekly Todos'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Delete'));
      await tester.pumpAndSettle();
      expect(
        find.text('Couldn’t delete this Applet. Try again.'),
        findsNothing,
      );
      expect(find.text('Weekly Todos'), findsNothing);
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
    });

    testWidgets('a delete refused to a Bot that is not the owner says so and '
        'keeps the row', (tester) async {
      final controller = await pump(tester, (path, body) async {
        if (path.endsWith('/applets/open')) {
          return {
            'schemaVersion': 1,
            'applets': [summaryJson('todo.applet', 'Weekly Todos')],
          };
        }
        if (path.endsWith('/delete')) {
          throw const RequestFailure('not the owner', 403, 'applet-not-owner');
        }
        throw StateError(path);
      });
      await tester.tap(find.byTooltip('Delete Weekly Todos'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Delete'));
      await tester.pumpAndSettle();
      expect(
        find.text('Only the Bot that owns Weekly Todos can delete it.'),
        findsOneWidget,
      );
      expect(identifiedBy(AppletIds.row('todo.applet')), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
    });

    testWidgets('a shared Applet whose owner is unknown still says shared', (
      tester,
    ) async {
      final controller = await pump(tester, (path, body) async {
        if (path.endsWith('/applets/open')) {
          return {
            'schemaVersion': 1,
            'applets': [
              summaryJson(
                'notes.applet',
                'Field Notes',
                access: 'shared',
                ownerBotId: 'bot-9',
              ),
            ],
          };
        }
        throw StateError(path);
      });
      expect(find.text('Shared'), findsOneWidget);
      expect(find.byTooltip('Delete Field Notes'), findsNothing);
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
    });

    testWidgets('a failed directory read offers a retry instead of the empty '
        'state', (tester) async {
      var down = true;
      final controller = await pump(tester, (path, body) async {
        if (down) throw const RequestFailure('applets are unavailable', 503);
        if (path.endsWith('/applets/open')) {
          return {
            'schemaVersion': 1,
            'applets': [summaryJson('todo.applet', 'Weekly Todos')],
          };
        }
        throw StateError(path);
      });
      expect(find.textContaining('No Applets yet'), findsNothing);
      expect(identifiedBy(AppletIds.listRetry), findsOneWidget);
      down = false;
      await tester.tap(identifiedBy(AppletIds.listRetry));
      await tester.pumpAndSettle();
      expect(find.text('Weekly Todos'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
    });

    testWidgets('a focused Applet that will not open is not a list failure', (
      tester,
    ) async {
      final controller = await pump(tester, (path, body) async {
        if (path.endsWith('/applets/open')) {
          // The open read answered, and the focused Applet is unpublished, so
          // its code is what there is to show.
          return {
            'schemaVersion': 1,
            'applets': [summaryJson('todo.applet', 'Weekly Todos')],
            'focused': {'appletId': 'todo.applet'},
          };
        }
        // The directory read answered; only this Applet's own code is down.
        throw const RequestFailure('applets are unavailable', 503);
      });
      expect(controller.failure, isNotNull);
      expect(find.text('Weekly Todos'), findsOneWidget);
      expect(identifiedBy(AppletIds.listRetry), findsNothing);
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
    });
  });
}
