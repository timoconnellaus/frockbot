import 'dart:async';
import 'dart:ui' show Tristate;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/bot_sessions.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/shell/app_shell.dart';
import 'package:frockbot_native/shell/semantics.dart';
import 'package:frockbot_native/theme/frock_theme.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'navigation_test.dart' show registration;
import 'shell_layout_test.dart' show byIdentifier;
import 'widget_test.dart' show MemoryStore;

/// The whole shell over a fake authority whose delete answers when the test
/// says so, and whose directory drops a Bot once its delete has applied.
class DeleteHarness extends NativeApi {
  final MemoryStore memory;
  final deleted = <String>{};
  final lifecycleWrites = <Map>[];
  Completer<void>? gate;
  String status = 'applied';
  DeleteHarness(this.memory) : super(memory);

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
        'bots': [
          for (final (id, name) in [('alpha', 'Alpha'), ('beta', 'Beta')])
            if (!deleted.contains(id)) registration(id, name),
        ],
      };
    }
    if (path == '/api/bots/lifecycles') {
      return {'schemaVersion': 1, 'lifecycles': []};
    }
    if (path == '/api/bots/identities') return {'identities': []};
    final appletImpact = RegExp(r'^/api/bots/(\w+)/applets/impact$')
        .firstMatch(path);
    if (appletImpact != null) {
      return {
        'schemaVersion': 1,
        'botId': appletImpact.group(1),
        'fingerprint': '0123456789abcdef',
        'applets': <Object?>[],
      };
    }
    final settings = RegExp(r'^/api/bots/(\w+)/settings$').firstMatch(path);
    if (settings != null && body == null) {
      return {
        'revision': 1,
        'profile': {'name': settings.group(1)},
      };
    }
    // The settings read also asks how the Bot sounds; these Bots have chosen
    // nothing, so the record carries no voice at all (ADR 0031).
    final voice = RegExp(r'^/api/bots/(\w+)/voice$').firstMatch(path);
    if (voice != null && body == null) {
      return {'schemaVersion': 1, 'botId': voice.group(1), 'revision': 0};
    }
    final look = RegExp(r'^/api/bots/(\w+)/look$').firstMatch(path);
    if (look != null && body == null) {
      return {
        'schemaVersion': 1,
        'botId': look.group(1),
        'revision': 0,
        'look': 'inherit',
      };
    }
    final lifecycle = RegExp(r'^/api/bots/(\w+)/lifecycle$').firstMatch(path);
    if (lifecycle != null && body is Map) {
      lifecycleWrites.add(body);
      await gate?.future;
      final botId = lifecycle.group(1)!;
      if (status == 'applied') deleted.add(botId);
      return {
        'schemaVersion': 1,
        'commandId': body['commandId'],
        'botId': botId,
        'status': status,
        'lifecycle': {
          'schemaVersion': 1,
          'botId': botId,
          'status': 'active',
          'revision': 1,
        },
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

class Shell {
  final store = MemoryStore();
  final links = ValueNotifier<String?>(null);
  late final api = DeleteHarness(store);
  late final sessions = BotSessions(api: api, store: store);

  Future<void> mount(WidgetTester tester, double width) async {
    tester.view.physicalSize = Size(width, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
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
  }

  Future<void> select(WidgetTester tester, String botId) async {
    await tester.tap(find.byKey(ValueKey('bot-$botId')));
    await tester.pumpAndSettle();
  }

  /// Opens Bot settings the way each tier offers it, and asks for the delete.
  /// Returns before the answer when [gate] holds it.
  Future<void> requestDelete(WidgetTester tester) async {
    final name = byIdentifier(ShellIds.botPanelToggle);
    if (name.evaluate().isNotEmpty) {
      await tester.tap(name.first);
      await tester.pumpAndSettle();
    } else if (byIdentifier(SettingsIds.botPageSettings)
        .hitTestable()
        .evaluate()
        .isEmpty) {
      await tester.tap(byIdentifier(ShellIds.rightPanelToggle));
      await tester.pumpAndSettle();
    }
    // The Bot page is the door; Settings is behind its gear, and the danger
    // rows are the last card on it.
    await tester.tap(byIdentifier(SettingsIds.botPageSettings).hitTestable());
    await tester.pumpAndSettle();
    final delete = byIdentifier(FlockIds.deleteBot);
    await tester.ensureVisible(delete);
    await tester.pumpAndSettle();
    await tester.tap(delete);
    await tester.pumpAndSettle();
    await tester.tap(
      find.descendant(
        of: find.byType(AlertDialog),
        matching: find.widgetWithText(FilledButton, 'Delete'),
      ),
    );
    await tester.pump();
  }

  Future<void> dispose(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox());
    sessions.clear();
    links.dispose();
    await tester.pump();
  }
}

void main() {
  for (final (tier, width) in [
    ('triple', 1280.0),
    ('dual', 800.0),
    ('single', 390.0),
  ]) {
    testWidgets(
      'an applied delete closes the Bot everywhere at the $tier tier',
      (tester) async {
        final shell = Shell();
        await shell.mount(tester, width);
        await shell.select(tester, 'alpha');
        expect(shell.store.values['selection.u'], 'alpha');
        await shell.requestDelete(tester);
        await tester.pumpAndSettle();

        expect(shell.api.lifecycleWrites.single['type'], 'bot/delete');
        expect(byIdentifier(FlockIds.dangerZone), findsNothing);
        expect(byIdentifier(SettingsIds.botPage), findsNothing);
        expect(byIdentifier(ShellIds.rightPanel), findsNothing);
        // The layout keeps one inert scrim mounted at wider widths; closing
        // the drawer means it no longer receives input.
        expect(byIdentifier(ShellIds.scrim).hitTestable(), findsNothing);
        expect(byIdentifier(ShellIds.composer), findsNothing);
        expect(byIdentifier(ShellIds.botPanelToggle), findsNothing);
        expect(find.byKey(const ValueKey('bot-alpha')), findsNothing);
        expect(find.byKey(const ValueKey('bot-beta')), findsOneWidget);
        expect(shell.store.values.containsKey('selection.u'), isFalse);
        await shell.dispose(tester);
      },
    );
  }

  for (final (tier, width) in [('triple', 1280.0), ('single', 390.0)]) {
    testWidgets('a pending delete keeps Bot settings open at the $tier tier', (
      tester,
    ) async {
      final shell = Shell();
      shell.api.status = 'pending';
      await shell.mount(tester, width);
      await shell.select(tester, 'alpha');
      await shell.requestDelete(tester);
      await tester.pumpAndSettle();

      expect(byIdentifier(FlockIds.dangerZone), findsOneWidget);
      expect(
        find.text('Still deleting — this will finish shortly.'),
        findsOneWidget,
      );
      if (tier == 'triple') {
        expect(find.byKey(const ValueKey('bot-alpha')), findsOneWidget);
      } else {
        // The pushed Settings page is still the one on screen.
        expect(byIdentifier(SettingsIds.botSettings), findsOneWidget);
      }
      expect(shell.store.values['selection.u'], 'alpha');
      await shell.dispose(tester);
    });
  }

  testWidgets('a refused delete keeps Bot settings open for recovery', (
    tester,
  ) async {
    final shell = Shell();
    shell.api.status = 'rejected';
    await shell.mount(tester, 1280);
    await shell.select(tester, 'alpha');
    await shell.requestDelete(tester);
    await tester.pumpAndSettle();

    expect(byIdentifier(FlockIds.dangerZone), findsOneWidget);
    expect(
      find.text(
        'That change couldn’t be completed. Refresh your Bots and try again.',
      ),
      findsOneWidget,
    );
    expect(find.byKey(const ValueKey('bot-alpha')), findsOneWidget);
    expect(shell.store.values['selection.u'], 'alpha');
    await shell.dispose(tester);
  });

  testWidgets(
    'a delete that applies after switching Bots leaves the new Bot open',
    (tester) async {
      final shell = Shell();
      shell.api.gate = Completer<void>();
      await shell.mount(tester, 1280);
      await shell.select(tester, 'alpha');
      await shell.requestDelete(tester);
      await tester.pumpAndSettle();
      expect(shell.api.lifecycleWrites, hasLength(1));

      await shell.select(tester, 'beta');
      expect(shell.store.values['selection.u'], 'beta');
      expect(
        tester
            .getSemantics(byIdentifier(ShellIds.sidebarBot('beta')))
            .flagsCollection
            .isSelected,
        Tristate.isTrue,
      );
      shell.api.gate!.complete();
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('bot-alpha')), findsNothing);
      expect(
        tester
            .getSemantics(byIdentifier(ShellIds.sidebarBot('beta')))
            .flagsCollection
            .isSelected,
        Tristate.isTrue,
      );
      expect(byIdentifier(ShellIds.rightPanel), findsOneWidget);
      expect(shell.store.values['selection.u'], 'beta');
      expect(shell.api.lifecycleWrites.single['botId'], 'alpha');
      await shell.dispose(tester);
    },
  );
}
