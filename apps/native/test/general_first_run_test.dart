/// General, the Bot a new account starts with: the shell opens it on a first
/// sign-in without taking anyone's place, and its empty thread offers
/// suggestions that write into the composer and never send.
library;

import 'dart:async';

import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/bot_sessions.dart';
import 'package:frockbot_native/client/chat_controller.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/shell/app_shell.dart';
import 'package:frockbot_native/shell/chat_pane.dart';
import 'package:frockbot_native/shell/semantics.dart';
import 'package:frockbot_native/shell/starters.dart';
import 'package:frockbot_native/theme/frock_theme.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'navigation_test.dart' show identifiedBy, registration;
import 'widget_test.dart' show MemoryStore;

/// Answers the Bot directory when the test says so, and the Bot's Plugins
/// frame from [features]; every other read is offline.
class FirstRunApi extends NativeApi {
  final Completer<Map<String, dynamic>> directory = Completer();
  Set<String>? features;
  final requests = <String>[];
  FirstRunApi(super.store);

  @override
  Future<Object?> request(
    String path, {
    Object? body,
    int limit = 512000,
    bool authenticated = true,
  }) async {
    requests.add(body == null ? path : 'POST $path');
    if (path == '/api/bots') return directory.future;
    if (path == '/api/bots/lifecycles') {
      final bots = (await directory.future)['bots'] as List;
      return {
        'schemaVersion': 1,
        'lifecycles': [
          for (final bot in bots)
            {
              'schemaVersion': 1,
              'botId': (bot as Map)['botId'],
              'status': 'active',
              'revision': 0,
            },
        ],
      };
    }
    final plugins = features;
    if (path.endsWith('/plugins') && plugins != null) {
      return {
        'schemaVersion': 1,
        'botId': generalBotIdV1,
        'revision': 0,
        'plugins': [
          for (final id in ['web', 'routines', 'image'])
            {'pluginId': id, 'on': plugins.contains(id)},
        ],
      };
    }
    throw const FormatException('offline fixture');
  }

  @override
  Future<WebSocketChannel> socket(String botId, String? cursor) async =>
      throw const FormatException('offline fixture');
}

/// Records every send, which is the one thing a suggestion must never cause.
class RecordingTransport implements ChatTransport {
  final sends = <String>[];
  @override
  Future<Map<String, dynamic>> page(String botId, {String? before}) async => {
    'runs': <Object>[],
    'page': {'truncated': false},
  };
  @override
  Future<void> send(
    String botId,
    String id,
    String text, {
    String? supersedes,
    String? retryOf,
  }) async => sends.add(text);
  @override
  Future<Map<String, dynamic>?> lookup(
    String botId,
    String id, {
    bool fence = false,
  }) async => null;
  @override
  Future<Map<String, dynamic>> stop(
    String botId,
    String id,
    String commandId,
  ) async => throw UnimplementedError();
}

Map<String, dynamic> directoryOf(List<Map<String, dynamic>> bots) => {
  'schemaVersion': 1,
  'revision': bots.length,
  'bots': bots,
};

void main() {
  group('starter suggestions', () {
    test('a suggestion needing a feature the Bot does not run is left out', () {
      List<String> ids(Set<String>? features) =>
          startersForV1(features).map((starter) => starter.id).toList();
      // Unknown features offer only what needs none.
      expect(ids(null), ['project', 'specialist']);
      expect(ids({}), ['project', 'specialist']);
      expect(ids({'web'}), ['research', 'project', 'specialist']);
      expect(ids({'routines'}), ['project', 'recurring', 'specialist']);
      expect(ids({'web', 'routines'}), [
        'research',
        'project',
        'recurring',
        'specialist',
      ]);
    });

    test('the features come from the Bot’s Plugins frame', () async {
      final api = FirstRunApi(MemoryStore())..features = {'routines'};
      addTearDown(api.close);
      expect(await readBotFeaturesV1(api, generalBotIdV1), {'routines'});
      api.features = null;
      expect(await readBotFeaturesV1(api, generalBotIdV1), isNull);
    });

    test('a prefilled draft selects its first placeholder', () {
      const draft = 'Every [weekday morning], check [what to watch].';
      expect(
        starterSelectionV1(draft),
        const TextSelection(baseOffset: 6, extentOffset: 23),
      );
      expect(
        starterSelectionV1('No placeholder'),
        const TextSelection.collapsed(offset: 14),
      );
    });

    testWidgets('choosing a suggestion fills the composer and sends nothing', (
      tester,
    ) async {
      final store = MemoryStore();
      final transport = RecordingTransport();
      final controller = ChatController(
        transport: transport,
        store: store,
        userId: 'test-user',
        botId: generalBotIdV1,
      );
      controller.ready = true;
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: Scaffold(
            body: ChatPane(
              controller: controller,
              onReconnect: () async {},
              starters: startersForV1({'web', 'routines'}),
            ),
          ),
        ),
      );
      expect(identifiedBy(StarterIds.list), findsOneWidget);
      for (final id in ['research', 'project', 'recurring', 'specialist']) {
        expect(identifiedBy(StarterIds.suggestion(id)), findsOneWidget);
      }

      await tester.tap(find.byKey(const ValueKey('starter-recurring')));
      await tester.pump();
      final recurring = starterSuggestionsV1.firstWhere(
        (starter) => starter.id == 'recurring',
      );
      final field = tester.widget<TextField>(find.byType(TextField));
      expect(field.controller!.text, recurring.draft);
      expect(field.controller!.selection, starterSelectionV1(recurring.draft));
      expect(controller.draft, recurring.draft);
      expect(field.focusNode!.hasFocus, isTrue);

      // The draft is the person's to change before anything is sent.
      await tester.enterText(find.byType(TextField), 'Every Monday, check X');
      await tester.pump();
      expect(controller.draft, 'Every Monday, check X');
      expect(transport.sends, isEmpty);
      expect(controller.pending, isEmpty);

      await tester.pumpWidget(const SizedBox());
      controller.dispose();
    });

    testWidgets('an ordinary Bot’s empty thread offers no suggestions', (
      tester,
    ) async {
      final controller = ChatController(
        transport: RecordingTransport(),
        store: MemoryStore(),
        userId: 'test-user',
        botId: 'bot-one',
      );
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ChatPane(controller: controller, onReconnect: () async {}),
          ),
        ),
      );
      expect(find.text('What would you like to work on?'), findsOneWidget);
      expect(identifiedBy(StarterIds.list), findsNothing);
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
    });
  });

  group('opening General', () {
    Future<({FirstRunApi api, MemoryStore store, BotSessions sessions})> shell(
      WidgetTester tester, {
      Size size = const Size(1200, 900),
      String? saved,
    }) async {
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final store = MemoryStore();
      if (saved != null) store.values['selection.test-user'] = saved;
      final api = FirstRunApi(store);
      final sessions = BotSessions(api: api, store: store);
      final links = ValueNotifier<String?>(null);
      addTearDown(links.dispose);
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
      await tester.pump();
      return (api: api, store: store, sessions: sessions);
    }

    Future<void> close(
      WidgetTester tester,
      ({FirstRunApi api, MemoryStore store, BotSessions sessions}) harness,
    ) async {
      await tester.pumpWidget(const SizedBox());
      harness.sessions.clear();
      harness.api.close();
    }

    testWidgets('a first sign-in on a phone lands in General', (tester) async {
      final harness = await shell(tester, size: const Size(360, 800));
      harness.api.features = {'web'};
      harness.api.directory.complete(
        directoryOf([registration(generalBotIdV1, 'General')]),
      );
      await tester.pumpAndSettle();
      expect(find.widgetWithText(AppBar, 'General'), findsOneWidget);
      expect(harness.store.values['selection.test-user'], generalBotIdV1);
      expect(identifiedBy(StarterIds.suggestion('research')), findsOneWidget);
      expect(identifiedBy(StarterIds.suggestion('recurring')), findsNothing);
      // No create sheet and no tour stands between the person and General.
      expect(find.byType(BottomSheet), findsNothing);
      // Nothing was sent on the person's behalf.
      expect(
        harness.api.requests.where((path) => path.startsWith('POST ')),
        isEmpty,
      );
      await close(tester, harness);
    });

    testWidgets('a saved selection is kept rather than replaced by General', (
      tester,
    ) async {
      final harness = await shell(tester, saved: 'bot-one');
      harness.api.directory.complete(
        directoryOf([
          registration(generalBotIdV1, 'General'),
          registration('bot-one', 'Rosemary'),
        ]),
      );
      await tester.pumpAndSettle();
      expect(find.widgetWithText(AppBar, 'Rosemary'), findsOneWidget);
      expect(find.widgetWithText(AppBar, 'General'), findsNothing);
      expect(harness.store.values['selection.test-user'], 'bot-one');
      await close(tester, harness);
    });

    testWidgets(
      'a saved selection that is gone does not fall back to General',
      (tester) async {
        final harness = await shell(tester, saved: 'deleted-bot');
        harness.api.directory.complete(
          directoryOf([registration(generalBotIdV1, 'General')]),
        );
        await tester.pumpAndSettle();
        expect(find.widgetWithText(AppBar, 'General'), findsNothing);
        expect(find.text('Choose a Bot to begin'), findsOneWidget);
        await close(tester, harness);
      },
    );

    testWidgets(
      'a page already open over the shell is not covered by General',
      (tester) async {
        final harness = await shell(tester);
        await tester.tap(identifiedBy(ShellIds.sidebarProfile));
        await tester.pumpAndSettle();
        final profile = find.byWidgetPredicate(
          (widget) =>
              widget is Semantics &&
              widget.properties.identifier == SettingsIds.profileSignOut,
        );
        expect(profile, findsOneWidget);

        harness.api.directory.complete(
          directoryOf([registration(generalBotIdV1, 'General')]),
        );
        await tester.pumpAndSettle();
        expect(profile, findsOneWidget);
        expect(harness.store.values['selection.test-user'], isNull);
        await close(tester, harness);
      },
    );

    testWidgets('an account without General opens nothing by itself', (
      tester,
    ) async {
      final harness = await shell(tester);
      harness.api.directory.complete(
        directoryOf([registration('bot-one', 'Rosemary')]),
      );
      await tester.pumpAndSettle();
      expect(find.widgetWithText(AppBar, 'Rosemary'), findsNothing);
      expect(harness.store.values['selection.test-user'], isNull);
      await close(tester, harness);
    });
  });
}
