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
import 'package:frockbot_native/shell/chat_header.dart';
import 'package:frockbot_native/shell/chat_pane.dart';
import 'package:frockbot_native/shell/desktop_layout.dart';
import 'package:frockbot_native/shell/semantics.dart';
import 'package:frockbot_native/shell/starters.dart';
import 'package:frockbot_native/theme/frock_theme.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'navigation_test.dart' show identifiedBy, registration;
import 'widget_test.dart' show MemoryStore;

/// The id the authority minted for this fixture account's General.
const generalId = 'general-0123456789abcdef';

/// Answers the Bot directory when the test says so, the bootstrap from
/// [general], and the Bot's Plugins frame from [features]; every other read is
/// offline.
class FirstRunApi extends NativeApi {
  final Completer<Map<String, dynamic>> directory = Completer();
  String? general = generalId;
  Set<String>? features;
  final accountFeatures = {'web', 'routines'};
  int featuresRevision = 0;
  bool rejectFeatureChange = false;
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
    if (path == '/api/bots/bootstrap') {
      await directory.future;
      return {'schemaVersion': 1, 'generalBotId': general};
    }
    final uri = Uri.parse(path);
    if (uri.path == '/api/settings/connections') {
      return {
        'schemaVersion': 1,
        'ownerId': 'test-user',
        'revision': 0,
        'modelInUse': 'Auto',
        'accounts': <Object>[],
        'providers': <Object>[],
      };
    }
    if (body == null &&
        [
          '/api/settings/models',
          '/api/settings/application',
        ].contains(uri.path)) {
      return {
        'schemaVersion': 1,
        'surfaceId': 'settings-${uri.path.split('/').last}',
        'revision': 0,
        'root': {
          'type': 'group',
          'orientation': 'column',
          'children': <Object>[],
        },
        'actions': <Object>[],
      };
    }
    final plugins = features;
    if (path == '/api/settings' && body is Map) {
      if (rejectFeatureChange) {
        return {'commandId': body['commandId'], 'status': 'rejected'};
      }
      final id = body['packageId'] as String;
      if (body['enabled'] == true) {
        accountFeatures.add(id);
      } else {
        accountFeatures.remove(id);
      }
      featuresRevision += 1;
      return {'commandId': body['commandId'], 'status': 'applied'};
    }
    if (path == '/api/settings/capabilities?as=document') {
      return {
        'schemaVersion': 1,
        'surfaceId': 'capabilities',
        'revision': featuresRevision,
        'root': {
          'type': 'group',
          'orientation': 'column',
          'children': [
            for (final id in ['web', 'routines'])
              {
                'type': 'action',
                'actionId': 'set-package-enabled',
                'label':
                    '${accountFeatures.contains(id) ? 'Disable' : 'Enable'} $id',
                'input': {
                  'kind': 'set-package-enabled',
                  'packageId': id,
                  'enabled': !accountFeatures.contains(id),
                },
              },
          ],
        },
        'actions': [
          {
            'id': 'set-package-enabled',
            'schema': {
              'type': 'object',
              'properties': {
                'kind': {
                  'type': 'string',
                  'enum': ['set-package-enabled'],
                },
                'packageId': {'type': 'string', 'maxLength': 128},
                'enabled': {'type': 'boolean'},
              },
              'required': ['kind', 'packageId', 'enabled'],
              'additionalProperties': false,
            },
          },
        ],
      };
    }
    if (path == '/api/bots/$generalId/plugins' && body is Map) {
      if (rejectFeatureChange) return {'status': 'rejected'};
      final id = body['pluginId'] as String;
      if (body['enabled'] == true) {
        plugins!.add(id);
      } else {
        plugins!.remove(id);
      }
      featuresRevision += 1;
      return {'status': 'applied'};
    }
    if (path == '/api/bots/$generalId/plugins?as=document' && plugins != null) {
      return {
        'schemaVersion': 1,
        'surfaceId': 'bot-plugins',
        'revision': featuresRevision,
        'root': {
          'type': 'group',
          'orientation': 'column',
          'children': [
            for (final id in ['web', 'routines'])
              {
                'type': 'action',
                'actionId': 'set-plugin-enabled',
                'label': '${plugins.contains(id) ? 'Disable' : 'Enable'} $id',
                'input': {
                  'pluginId': id,
                  'enabled': !plugins.contains(id),
                  'expectedRevision': featuresRevision,
                },
              },
          ],
        },
        'actions': [
          {
            'id': 'set-plugin-enabled',
            'schema': {
              'type': 'object',
              'properties': {
                'pluginId': {'type': 'string', 'maxLength': 128},
                'enabled': {'type': 'boolean'},
                'expectedRevision': {
                  'type': 'number',
                  'minimum': 0,
                  'maximum': 1000000,
                },
              },
              'required': ['pluginId', 'enabled', 'expectedRevision'],
              'additionalProperties': false,
            },
          },
        ],
      };
    }
    // The Bot's own settings, so the gear on its page opens a page rather than
    // the surface's "couldn't load".
    if (RegExp(r'^/api/bots/[^/]+/settings$').hasMatch(path)) {
      return {
        'schemaVersion': 1,
        'botId': generalId,
        'revision': 0,
        'profile': {'name': 'General'},
        'notifications': {'enabled': true},
      };
    }
    // The settings read also asks how the Bot sounds; General has chosen
    // nothing, so the record carries no voice at all (ADR 0031).
    final voice = RegExp(r'^/api/bots/([^/]+)/voice$').firstMatch(path);
    if (voice != null && body == null) {
      return {'schemaVersion': 1, 'botId': voice.group(1), 'revision': 0};
    }
    final look = RegExp(r'^/api/bots/([^/]+)/look$').firstMatch(path);
    if (look != null && body == null) {
      return {
        'schemaVersion': 1,
        'botId': look.group(1),
        'revision': 0,
        'look': 'inherit',
      };
    }
    if (path.endsWith('/plugins') && plugins != null) {
      return {
        'schemaVersion': 1,
        'botId': generalId,
        'revision': 0,
        'plugins': [
          for (final id in ['web', 'routines', 'image'])
            {
              'pluginId': id,
              'on': plugins.contains(id) && accountFeatures.contains(id),
            },
        ],
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
      expect(await readBotFeaturesV1(api, generalId), {'routines'});
      api.features = null;
      expect(await readBotFeaturesV1(api, generalId), isNull);
    });

    test('General is whichever Bot the authority says, or none', () async {
      final api = FirstRunApi(MemoryStore());
      addTearDown(api.close);
      api.directory.complete(directoryOf([]));
      expect(await readGeneralBotIdV1(api), generalId);
      api.general = null;
      expect(await readGeneralBotIdV1(api), isNull);
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
        botId: generalId,
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
      ValueNotifier<String?>? botLinks,
    }) async {
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final store = MemoryStore();
      if (saved != null) store.values['selection.test-user'] = saved;
      final api = FirstRunApi(store);
      final sessions = BotSessions(api: api, store: store);
      final links = botLinks ?? ValueNotifier<String?>(null);
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

    /// The overlay names the Bot at every width. A desk also keeps the
    /// composer in the conversation column; a phone is a page of its own.
    void expectConversation(String name, Size size) {
      expect(find.widgetWithText(ChatHeader, name), findsOneWidget);
      if (size.width > shellSinglePaneWidth) {
        expect(identifiedBy(ShellIds.composer), findsOneWidget);
      }
    }

    testWidgets('a first sign-in on a phone lands in General', (tester) async {
      final harness = await shell(tester, size: const Size(360, 800));
      harness.api.features = {'web'};
      harness.api.directory.complete(
        directoryOf([registration(generalId, 'General')]),
      );
      await tester.pumpAndSettle();
      expectConversation('General', const Size(360, 800));
      expect(harness.store.values['selection.test-user'], generalId);
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

    testWidgets('General refreshes starters after successful Plugins changes', (
      tester,
    ) async {
      final harness = await shell(tester, size: const Size(1600, 1000));
      harness.api.features = {'web', 'routines'};
      harness.api.directory.complete(
        directoryOf([registration(generalId, 'General')]),
      );
      await tester.pumpAndSettle();
      final conversation = tester.state(find.byType(ConversationView));
      // Plugins is behind the gear on the Bot page now, which is the panel's
      // root at this width.
      await tester.tap(identifiedBy(SettingsIds.botPageSettings).first);
      await tester.pumpAndSettle();
      await tester.tap(identifiedBy(SettingsIds.botPlugins).first);
      await tester.pumpAndSettle();

      for (final entry in {
        'web': 'research',
        'routines': 'recurring',
      }.entries) {
        final starter = identifiedBy(StarterIds.suggestion(entry.value));
        expect(starter, findsOneWidget);
        await tester.tap(find.text('Disable ${entry.key}'));
        await tester.pumpAndSettle();
        expect(starter, findsNothing);
        expect(identifiedBy(StarterIds.suggestion('project')), findsOneWidget);
        expect(
          identifiedBy(StarterIds.suggestion('specialist')),
          findsOneWidget,
        );

        await tester.tap(find.text('Enable ${entry.key}'));
        await tester.pumpAndSettle();
        expect(starter, findsOneWidget);
      }

      harness.api.rejectFeatureChange = true;
      await tester.tap(find.text('Disable web'));
      await tester.pumpAndSettle();
      expect(identifiedBy(StarterIds.suggestion('research')), findsOneWidget);
      expect(tester.state(find.byType(ConversationView)), same(conversation));
      expect(
        harness.api.requests.where((path) => path.startsWith('POST ')),
        everyElement('POST /api/bots/$generalId/plugins'),
      );
      await close(tester, harness);
    });

    for (final route in [
      'Account features',
      'Image generation',
      'Messages on your Mac',
    ]) {
      testWidgets('General refreshes starters through $route', (tester) async {
        final harness = await shell(tester, size: const Size(1600, 1000));
        harness.api.features = {'web', 'routines'};
        harness.api.directory.complete(
          directoryOf([registration(generalId, 'General')]),
        );
        await tester.pumpAndSettle();
        final conversation = tester.state(find.byType(ConversationView));

        Future<void> change(String label) async {
          if (route == 'Messages on your Mac') {
            await tester.tap(identifiedBy(ShellIds.sidebarMarketplace));
            await tester.pumpAndSettle();
            await tester.tap(find.text(route));
            await tester.pumpAndSettle();
          } else {
            await tester.tap(identifiedBy(ShellIds.sidebarProfile));
            await tester.pumpAndSettle();
            await tester.tap(
              identifiedBy(
                route == 'Account features'
                    ? 'profile-capabilities'
                    : SettingsIds.profileModels,
              ),
            );
            await tester.pumpAndSettle();
            if (route == 'Image generation') {
              await tester.tap(find.text(route));
              await tester.pumpAndSettle();
            }
          }
          if (route != 'Account features') {
            await tester.tap(
              find.text('Manage this feature in Account features'),
            );
            await tester.pumpAndSettle();
          }
          await tester.tap(find.text(label));
          await tester.pumpAndSettle();
          for (var i = 0; i < (route == 'Image generation' ? 4 : 2); i++) {
            await tester.pageBack();
            await tester.pumpAndSettle();
          }
          if (route == 'Messages on your Mac') {
            await tester.tap(find.byTooltip('Close marketplace'));
            await tester.pumpAndSettle();
          }
        }

        for (final entry in {
          'web': 'research',
          'routines': 'recurring',
        }.entries) {
          final starter = identifiedBy(StarterIds.suggestion(entry.value));
          expect(starter, findsOneWidget);
          await change('Disable ${entry.key}');
          expect(starter, findsNothing);
          expect(
            identifiedBy(StarterIds.suggestion('project')),
            findsOneWidget,
          );
          expect(
            identifiedBy(StarterIds.suggestion('specialist')),
            findsOneWidget,
          );
          await change('Enable ${entry.key}');
          expect(starter, findsOneWidget);
        }

        final reads = harness.api.requests
            .where((path) => path == '/api/bots/$generalId/plugins')
            .length;
        harness.api.rejectFeatureChange = true;
        await change('Disable web');
        expect(identifiedBy(StarterIds.suggestion('research')), findsOneWidget);
        expect(
          harness.api.requests
              .where((path) => path == '/api/bots/$generalId/plugins')
              .length,
          reads,
        );
        expect(tester.state(find.byType(ConversationView)), same(conversation));
        expect(
          harness.api.requests.where((path) => path.startsWith('POST ')),
          everyElement('POST /api/settings'),
        );
        await close(tester, harness);
      });
    }

    for (final size in [const Size(360, 800), const Size(1200, 900)]) {
      for (final pendingAtMount in [true, false]) {
        testWidgets(
          'a Bot link ${pendingAtMount ? 'at mount' : 'during loading'} '
          'opens before General at width ${size.width}',
          (tester) async {
            final links = ValueNotifier<String?>(
              pendingAtMount ? 'bot-one' : null,
            );
            final harness = await shell(tester, size: size, botLinks: links);
            if (!pendingAtMount) links.value = 'bot-one';
            await tester.pump();
            expect(links.value, 'bot-one');
            expect(harness.store.values['selection.test-user'], isNull);
            expect(
              find.textContaining('That Bot isn’t available'),
              findsNothing,
            );

            harness.api.directory.complete(
              directoryOf([
                registration(generalId, 'General'),
                registration('bot-one', 'Rosemary'),
              ]),
            );
            await tester.pumpAndSettle();
            expectConversation('Rosemary', size);
            expect(find.widgetWithText(ChatHeader, 'General'), findsNothing);
            expect(harness.store.values['selection.test-user'], 'bot-one');
            expect(links.value, isNull);
            expect(
              find.textContaining('That Bot isn’t available'),
              findsNothing,
            );
            await close(tester, harness);
          },
        );
      }
    }

    testWidgets('a saved selection is kept rather than replaced by General', (
      tester,
    ) async {
      final harness = await shell(tester, saved: 'bot-one');
      harness.api.directory.complete(
        directoryOf([
          registration(generalId, 'General'),
          registration('bot-one', 'Rosemary'),
        ]),
      );
      await tester.pumpAndSettle();
      expectConversation('Rosemary', const Size(1200, 900));
      expect(find.widgetWithText(ChatHeader, 'General'), findsNothing);
      expect(harness.store.values['selection.test-user'], 'bot-one');
      await close(tester, harness);
    });

    testWidgets(
      'a saved selection that is gone does not fall back to General',
      (tester) async {
        final harness = await shell(tester, saved: 'deleted-bot');
        harness.api.directory.complete(
          directoryOf([registration(generalId, 'General')]),
        );
        await tester.pumpAndSettle();
        expect(find.widgetWithText(ChatHeader, 'General'), findsNothing);
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
          directoryOf([registration(generalId, 'General')]),
        );
        await tester.pumpAndSettle();
        expect(profile, findsOneWidget);
        expect(harness.store.values['selection.test-user'], isNull);
        await close(tester, harness);
      },
    );

    testWidgets('a Bot merely named General is not treated as General', (
      tester,
    ) async {
      final harness = await shell(tester);
      harness.api.general = null;
      harness.api.features = {'web', 'routines'};
      harness.api.directory.complete(
        directoryOf([registration('general', 'General')]),
      );
      await tester.pumpAndSettle();
      expect(find.widgetWithText(ChatHeader, 'General'), findsNothing);
      expect(harness.store.values['selection.test-user'], isNull);
      await tester.tap(find.byKey(const ValueKey('bot-general')));
      await tester.pumpAndSettle();
      expect(find.text('What would you like to work on?'), findsOneWidget);
      expect(identifiedBy(StarterIds.list), findsNothing);
      await close(tester, harness);
    });

    testWidgets('an account without General opens nothing by itself', (
      tester,
    ) async {
      final harness = await shell(tester);
      harness.api.directory.complete(
        directoryOf([registration('bot-one', 'Rosemary')]),
      );
      await tester.pumpAndSettle();
      expect(find.widgetWithText(ChatHeader, 'Rosemary'), findsNothing);
      expect(harness.store.values['selection.test-user'], isNull);
      await close(tester, harness);
    });
  });
}
