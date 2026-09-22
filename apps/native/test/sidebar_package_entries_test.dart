/// A Package entry belongs to the Bot that declares it, so it is a row on that
/// Bot's own page. The Bot page is where the doors are now, at every tier.
library;

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/bot_sessions.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/shell/app_shell.dart';
import 'package:frockbot_native/shell/chat_header.dart';
import 'package:frockbot_native/shell/semantics.dart';
import 'package:frockbot_native/theme/frock_theme.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'navigation_test.dart' show identifiedBy, registration;
import 'packages_test.dart' show catalog;
import 'widget_test.dart' show MemoryStore;

class PackageDeskApi extends NativeApi {
  PackageDeskApi(super.store, {this.entryLabel = 'Notebook'});

  final String entryLabel;
  final requested = <String>[];

  @override
  Future<Object?> request(
    String path, {
    Object? body,
    int limit = 512000,
    bool authenticated = true,
  }) async {
    requested.add(path);
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
      return catalog(entryLabel: entryLabel);
    }
    if (path.endsWith('/panels/open')) {
      return {
        'schemaVersion': 1,
        'bag': <Object>[],
        'focus': {'pluginId': null},
        'doors': <Object>[],
      };
    }
    if (path.endsWith('/settings') && body == null) {
      return {'revision': 1, 'profile': {'name': 'Builder'}};
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
  Future<WebSocketChannel> socket(String botId, String? cursor) async =>
      throw const FormatException('outside this fixture');
}

void main() {
  Future<({PackageDeskApi api, Future<void> Function() stop})> desk(
    WidgetTester tester, {
    String entryLabel = 'Notebook',
    Size size = const Size(1440, 900),
  }) async {
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
    final api = PackageDeskApi(store, entryLabel: entryLabel);
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

  testWidgets('a Package entry is a row on the Bot page, not an icon', (
    tester,
  ) async {
    final shell = await desk(tester);

    expect(
      shell.api.requested.any((path) => path.endsWith('/package-ui')),
      isTrue,
    );
    final entry = identifiedBy(PackageIds.entry('applets', 'open'));
    expect(entry, findsOneWidget);
    expect(
      find.descendant(of: identifiedBy(SettingsIds.botPage), matching: entry),
      findsOneWidget,
    );

    expect(
      find.descendant(of: find.byType(ChatHeader), matching: entry),
      findsNothing,
    );
    expect(
      find.descendant(of: identifiedBy(ShellIds.sidebar), matching: entry),
      findsNothing,
    );

    await shell.stop();
  });

  testWidgets('duplicate Applets package entry is omitted', (tester) async {
    final shell = await desk(tester, entryLabel: 'Applets');

    expect(identifiedBy(PackageIds.entry('applets', 'open')), findsNothing);
    expect(identifiedBy(SettingsIds.botPageAppletsAll), findsNothing);

    await shell.stop();
  });

  testWidgets('a Package door that is not Applets is kept', (tester) async {
    final shell = await desk(tester, entryLabel: 'Notebook');
    expect(identifiedBy(PackageIds.entry('applets', 'open')), findsOneWidget);
    expect(find.text('Notebook'), findsOneWidget);
    await shell.stop();
  });
}
