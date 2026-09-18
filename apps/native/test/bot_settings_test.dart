import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_client/client/transport.dart';
import 'package:frockbot_client/settings/bot_settings.dart';
import 'package:frockbot_client/shell/semantics.dart';
import 'package:frockbot_client/shell/sidebar.dart';
import 'package:frockbot_client/theme/frock_theme.dart';

import 'settings_test.dart' show SettingsApi;
import 'shell_layout_test.dart' show bot, byIdentifier;
import 'widget_test.dart' show MemoryStore;

Map<String, Object?> botSettings({
  String? pinnedAt,
  String namedBy = 'user',
  Object? model,
  bool hidden = false,
  bool notifications = true,
}) => {
  'schemaVersion': 1,
  'botId': 'alpha',
  'revision': 3,
  'profile': {
    'name': 'Inspected',
    'description': 'Reads the news',
    'namedBy': namedBy,
    'pinnedAt': ?pinnedAt,
    if (hidden) 'hiddenFromSidebar': true,
  },
  'notifications': {'enabled': notifications},
  'packageValues': {
    if (model != null) 'custom-models': {'model': model},
  },
};

Map<String, Object?> account({bool models = true}) => {
  'schemaVersion': 1,
  'revision': 9,
  'profile': {'name': 'Tim'},
  'packages': [
    if (models)
      {'packageId': 'custom-models', 'version': '1.0.0', 'state': 'installed'},
  ],
  'connections': <Object?>[],
};

NativeApi api(
  MemoryStore store,
  List<Map<String, Object?>> commands, {
  Map<String, Object?>? bot,
  bool models = true,
}) => SettingsApi(store, (path, body) async {
  if (body != null) {
    commands.add(Map<String, Object?>.from(body as Map));
    return {
      'schemaVersion': 1,
      'commandId': body['commandId'],
      'status': 'applied',
    };
  }
  if (path.startsWith('/api/settings')) return account(models: models);
  return bot ?? botSettings();
});

/// The debounce, elapsed: what a person's pause in typing costs.
Future<void> settle(WidgetTester tester) async {
  await tester.pump(
    botSettingsAutosaveDelay + const Duration(milliseconds: 50),
  );
  await tester.pumpAndSettle();
}

Future<void> open(
  WidgetTester tester,
  BotSettingsController state, {
  void Function(SidebarProfile profile)? onPredict,
  VoidCallback? onOpenPlugins,
}) async {
  tester.view.physicalSize = const Size(390, 2200);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      theme: FrockTheme.theme(Brightness.dark),
      home: Scaffold(
        body: SingleChildScrollView(
          child: BotSettingsView(
            controller: state,
            onPredict: onPredict,
            onOpenPlugins: onOpenPlugins,
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('Settings is one page: character, About, behaviour, danger', (
    tester,
  ) async {
    final store = MemoryStore();
    final state = BotSettingsController(api(store, []), 'alpha');
    await open(tester, state);
    expect(find.text('Inspected avatar'), findsOneWidget);
    expect(find.text('ABOUT'), findsOneWidget);
    expect(find.text('Name'), findsOneWidget);
    expect(find.text('Label'), findsOneWidget);
    // Title is an About field like the others: there is no Advanced to open.
    expect(find.text('Title'), findsOneWidget);
    expect(find.text('Description'), findsOneWidget);
    expect(find.text('Advanced'), findsNothing);
    expect(find.text('BEHAVIOUR'), findsOneWidget);
    expect(find.text('Pinned'), findsOneWidget);
    expect(find.text('Notifications'), findsOneWidget);
    expect(find.text('Hidden from list'), findsOneWidget);
    expect(find.text('Also turns notifications off'), findsOneWidget);
    // No button: a change is written as it is made.
    expect(find.text('Save settings'), findsNothing);
    expect(find.byType(FilledButton), findsNothing);
    // The Members sentence is gone with the expander that held it.
    expect(find.text('Members'), findsNothing);
    // The Name field is the only place a name shows: no provenance row.
    expect(find.text('Identity'), findsNothing);
    expect(find.text('Named by you'), findsNothing);
    expect(find.text('Named by this Bot'), findsNothing);
    expect(tester.takeException(), isNull);
    state.dispose();
  });

  testWidgets('the Plugins row says how many are on, and which', (
    tester,
  ) async {
    final store = MemoryStore();
    final state = BotSettingsController(
      SettingsApi(store, (path, body) async {
        if (path.startsWith('/api/settings')) return account();
        if (path.endsWith('/plugins')) {
          return {
            'schemaVersion': 1,
            'botId': 'alpha',
            'revision': 0,
            'plugins': [
              {'pluginId': 'web', 'displayName': 'Web', 'on': true},
              {'pluginId': 'image', 'displayName': 'Image', 'on': false},
              {'pluginId': 'routines', 'displayName': 'Routines', 'on': true},
            ],
          };
        }
        return botSettings();
      }),
      'alpha',
    );
    await open(tester, state, onOpenPlugins: () {});
    expect(find.text('CAPABILITIES'), findsOneWidget);
    expect(find.text('2 on · Web, Routines'), findsOneWidget);
    state.dispose();
  });

  testWidgets('flipping a Plugin re-reads the line that summarises them', (
    tester,
  ) async {
    final store = MemoryStore();
    var on = <String>['Web'];
    final state = BotSettingsController(
      SettingsApi(store, (path, body) async {
        if (path.startsWith('/api/settings')) return account();
        if (path.endsWith('/plugins')) {
          return {
            'schemaVersion': 1,
            'botId': 'alpha',
            'revision': 0,
            'plugins': [
              for (final name in const ['Web', 'Routines'])
                {
                  'pluginId': name.toLowerCase(),
                  'displayName': name,
                  'on': on.contains(name),
                },
            ],
          };
        }
        return botSettings();
      }),
      'alpha',
    );
    await open(tester, state, onOpenPlugins: () {});
    expect(find.text('1 on · Web'), findsOneWidget);

    // The Plugins surface turned one on and told the shell so.
    on = ['Web', 'Routines'];
    await state.refreshPlugins();
    await tester.pumpAndSettle();
    expect(find.text('2 on · Web, Routines'), findsOneWidget);
    expect(find.text('1 on · Web'), findsNothing);
    state.dispose();
  });

  test('what the Plugins and Model rows say', () {
    expect(botPluginsSummaryV1(const []), 'None on');
    expect(botPluginsSummaryV1(const ['Web']), '1 on · Web');
    expect(botModelLabelV1(null), 'Follows the account model');
    expect(botModelLabelV1('gpt-6'), 'gpt-6');
    expect(botModelLabelV1(const {'model': 'gpt-6'}), 'gpt-6');
  });

  testWidgets('a name the Bot chose is not attributed in its settings', (
    tester,
  ) async {
    final store = MemoryStore();
    final state = BotSettingsController(
      api(store, [], bot: botSettings(namedBy: 'bot')),
      'alpha',
    );
    await open(tester, state);
    expect(find.text('Name'), findsOneWidget);
    expect(find.text('Hidden from list'), findsOneWidget);
    expect(find.text('Named by this Bot'), findsNothing);
    state.dispose();
  });

  testWidgets('a Bot that has never been edited still renders its settings', (
    tester,
  ) async {
    final store = MemoryStore();
    final state = BotSettingsController(
      api(store, [], bot: {...botSettings(), 'revision': 0}),
      'alpha',
    );
    await open(tester, state);
    expect(find.text('Name'), findsOneWidget);
    expect(find.text('Settings couldn’t load'), findsNothing);
    state.dispose();
  });

  testWidgets('a pause in typing writes the profile and nothing else', (
    tester,
  ) async {
    final store = MemoryStore();
    final commands = <Map<String, Object?>>[];
    final state = BotSettingsController(api(store, commands), 'alpha');
    await open(tester, state);
    await tester.enterText(find.byType(TextFormField).first, 'Renam');
    await tester.pump(const Duration(milliseconds: 300));
    // Still typing: nothing has been sent, letter by letter.
    expect(commands, isEmpty);
    await tester.enterText(find.byType(TextFormField).first, 'Renamed');
    await settle(tester);
    // The policy and the model are what the read reported, so they are not
    // written again to say so: a rename is one request.
    expect(commands.map((command) => command['type']), ['bot/set-profile']);
    expect((commands.first['profile']! as Map)['name'], 'Renamed');
    expect(find.text('Saved.'), findsOneWidget);
    // The field kept the person's focus and text through the write: what
    // they typed is what it shows, and nothing was read back over it.
    expect(
      tester
          .widget<TextFormField>(find.byType(TextFormField).first)
          .initialValue,
      'Renamed',
    );
    state.dispose();
  });

  testWidgets('a model of this Bot’s own is written when it is chosen', (
    tester,
  ) async {
    final store = MemoryStore();
    final commands = <Map<String, Object?>>[];
    final state = BotSettingsController(api(store, commands), 'alpha');
    await open(tester, state);
    state.edit(() => state.model = {'connectionId': 'work'});
    await state.save();
    expect(commands.map((command) => command['type']), [
      'bot/set-package-settings',
    ]);
    expect(commands.single['values'], {
      'model': {'connectionId': 'work'},
    });
    // And a save that changes nothing after it sends nothing at all.
    await state.save();
    expect(commands, hasLength(1));
    state.dispose();
  });

  testWidgets('a switch is written the moment it is flipped', (tester) async {
    final store = MemoryStore();
    final commands = <Map<String, Object?>>[];
    final state = BotSettingsController(api(store, commands), 'alpha');
    await open(tester, state);
    await tester.tap(find.text('Pinned'));
    await tester.pumpAndSettle();
    // A pin is one request, not three: nothing else on this surface changed.
    expect(commands.map((command) => command['type']), ['bot/set-profile']);
    final profile = commands.first['profile']! as Map;
    expect(profile['pinnedAt'], isNot(''));
    // A second write keeps the instant the first one minted, so the tile the
    // sidebar orders by does not move each time something else is saved.
    await tester.enterText(find.byType(TextFormField).first, 'Renamed');
    await settle(tester);
    expect((commands[1]['profile']! as Map)['pinnedAt'], profile['pinnedAt']);
    state.dispose();
  });

  testWidgets('the sidebar is given the pin before the command lands', (
    tester,
  ) async {
    final store = MemoryStore();
    final commands = <Map<String, Object?>>[];
    final gate = Completer<void>();
    final predicted = <SidebarProfile>[];
    final state = BotSettingsController(
      SettingsApi(store, (path, body) async {
        if (body != null) {
          commands.add(Map<String, Object?>.from(body as Map));
          await gate.future;
          return {
            'schemaVersion': 1,
            'commandId': body['commandId'],
            'status': 'applied',
          };
        }
        if (path.startsWith('/api/settings')) return account();
        return botSettings();
      }),
      'alpha',
    );
    await open(tester, state, onPredict: predicted.add);
    await tester.tap(find.text('Pinned'));
    await tester.pump();
    // The command is still on the wire, and the sidebar already has the pin.
    expect(commands, hasLength(1));
    expect(predicted.single.pinnedAt, isNotEmpty);
    // The instant predicted is the one the command carries, so the tile does
    // not jump when the authority answers.
    expect(
      predicted.single.pinnedAt,
      (commands.single['profile']! as Map)['pinnedAt'],
    );
    gate.complete();
    await tester.pumpAndSettle();
    expect(predicted, hasLength(1));
    state.dispose();
  });

  testWidgets('a refused save puts the profile back', (tester) async {
    final store = MemoryStore();
    final predicted = <SidebarProfile>[];
    final state = BotSettingsController(
      SettingsApi(store, (path, body) async {
        if (body != null) {
          return {
            'schemaVersion': 1,
            'commandId': (body as Map)['commandId'],
            'status': 'rejected',
            'failure': 'Not yours to pin.',
          };
        }
        if (path.startsWith('/api/settings')) return account();
        return botSettings();
      }),
      'alpha',
    );
    await open(tester, state, onPredict: predicted.add);
    await tester.tap(find.text('Pinned'));
    await tester.pumpAndSettle();
    // Predicted, then handed back what the authority still holds.
    expect(predicted, hasLength(2));
    expect(predicted.first.pinnedAt, isNotEmpty);
    expect(predicted.last.pinnedAt, '');
    expect(find.text('Not yours to pin.'), findsOneWidget);
    state.dispose();
  });

  testWidgets('the pinned tile moves before the save lands', (tester) async {
    final store = MemoryStore();
    final gate = Completer<void>();
    final state = BotSettingsController(
      SettingsApi(store, (path, body) async {
        if (body != null) {
          await gate.future;
          return {
            'schemaVersion': 1,
            'commandId': (body as Map)['commandId'],
            'status': 'applied',
          };
        }
        if (path.startsWith('/api/settings')) return account();
        return botSettings();
      }),
      'alpha',
    );
    tester.view.physicalSize = const Size(900, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(_Shell(state: state));
    await tester.pumpAndSettle();
    expect(byIdentifier(ShellIds.sidebarBot('alpha')), findsOneWidget);
    expect(byIdentifier(ShellIds.sidebarPinned('alpha')), findsNothing);
    await tester.tap(find.text('Pinned'));
    await tester.pump();
    // The tile is above the list while the command is still on the wire.
    expect(byIdentifier(ShellIds.sidebarPinned('alpha')), findsOneWidget);
    expect(byIdentifier(ShellIds.sidebarBot('alpha')), findsNothing);
    gate.complete();
    await tester.pumpAndSettle();
    expect(byIdentifier(ShellIds.sidebarPinned('alpha')), findsOneWidget);
    state.dispose();
  });

  testWidgets('a change made mid-save is written after it', (tester) async {
    final store = MemoryStore();
    final commands = <Map<String, Object?>>[];
    final gate = Completer<void>();
    var held = false;
    final state = BotSettingsController(
      SettingsApi(store, (path, body) async {
        if (body != null) {
          commands.add(Map<String, Object?>.from(body as Map));
          if (!held) {
            held = true;
            await gate.future;
          }
          return {
            'schemaVersion': 1,
            'commandId': body['commandId'],
            'status': 'applied',
          };
        }
        if (path.startsWith('/api/settings')) return account();
        return botSettings();
      }),
      'alpha',
    );
    await open(tester, state);
    await tester.tap(find.text('Pinned'));
    await tester.pump();
    // The first save is on the wire and held there. The next change lands
    // while it is: it must not be lost to "already saving".
    await tester.enterText(find.byType(TextFormField).first, 'Renamed');
    await settle(tester);
    expect(commands, hasLength(1));
    gate.complete();
    await settle(tester);
    await settle(tester);
    final names = [
      for (final command in commands)
        if (command['type'] == 'bot/set-profile')
          (command['profile']! as Map)['name'],
    ];
    expect(names, ['Inspected', 'Renamed']);
    state.dispose();
  });

  testWidgets('every command is fenced, and each fences on the last receipt', (
    tester,
  ) async {
    // Every configuration command carries `expectedRevision`, and the route
    // refuses one that does not: without this the whole panel saved nothing
    // and reloaded with the switch back where it started.
    final store = MemoryStore();
    final commands = <Map<String, Object?>>[];
    var applied = 3;
    final state = BotSettingsController(
      SettingsApi(store, (path, body) async {
        if (body != null) {
          commands.add(Map<String, Object?>.from(body as Map));
          return {
            'schemaVersion': 1,
            'commandId': body['commandId'],
            'revision': ++applied,
            'status': 'applied',
          };
        }
        if (path.startsWith('/api/settings')) return account();
        return botSettings();
      }),
      'alpha',
    );
    await open(tester, state);
    // Two values changed in the one save, so two commands are sent — and the
    // second fences on what the first left rather than on the read.
    await tester.enterText(find.byType(TextFormField).first, 'Renamed');
    await tester.pump(const Duration(milliseconds: 100));
    await tester.tap(find.text('Notifications'));
    await tester.pumpAndSettle();
    expect(commands.map((command) => command['type']), [
      'bot/set-profile',
      'bot/update-notifications',
    ]);
    // The read was at 3, and each applied command moved it.
    expect(commands.map((command) => command['expectedRevision']), [3, 4]);
    state.dispose();
  });

  testWidgets('a conflicting save is re-fenced once and then reported', (
    tester,
  ) async {
    // Something else wrote between the read and the press. Asking again with
    // the revision the authority now holds is what pressing Save once means.
    final store = MemoryStore();
    final commands = <Map<String, Object?>>[];
    var refused = true;
    final state = BotSettingsController(
      SettingsApi(store, (path, body) async {
        if (body != null) {
          commands.add(Map<String, Object?>.from(body as Map));
          if (refused) {
            refused = false;
            throw const RequestFailure('configuration revision is 7', 409);
          }
          return {
            'schemaVersion': 1,
            'commandId': body['commandId'],
            'revision': 8,
            'status': 'applied',
          };
        }
        if (path.startsWith('/api/settings')) return account();
        return {...botSettings(), 'revision': refused ? 3 : 7};
      }),
      'alpha',
    );
    await open(tester, state);
    await tester.tap(find.text('Notifications'));
    await tester.pumpAndSettle();
    // The refused command is the same command, asked again at the revision the
    // authority reported.
    expect(commands.map((command) => command['expectedRevision']), [3, 7]);
    expect(commands[0]['commandId'], commands[1]['commandId']);
    state.dispose();
  });

  testWidgets('an unpin clears the instant the sidebar orders by', (
    tester,
  ) async {
    final store = MemoryStore();
    final commands = <Map<String, Object?>>[];
    final state = BotSettingsController(
      api(
        store,
        commands,
        bot: botSettings(pinnedAt: '2026-01-01T00:00:00.000Z'),
      ),
      'alpha',
    );
    await open(tester, state);
    await tester.tap(find.text('Pinned'));
    await tester.pumpAndSettle();
    expect((commands.first['profile']! as Map)['pinnedAt'], '');
    state.dispose();
  });

  testWidgets('an empty name refuses before any command is sent', (
    tester,
  ) async {
    final store = MemoryStore();
    final commands = <Map<String, Object?>>[];
    final state = BotSettingsController(api(store, commands), 'alpha');
    await open(tester, state);
    await tester.enterText(find.byType(TextFormField).first, '   ');
    await settle(tester);
    expect(commands, isEmpty);
    expect(find.text('Enter a name for this Bot.'), findsOneWidget);
    // And the next keystroke that makes it a name is what gets written.
    await tester.enterText(find.byType(TextFormField).first, 'Named');
    await settle(tester);
    expect((commands.first['profile']! as Map)['name'], 'Named');
    state.dispose();
  });

  group('hiding a Bot mutes it', () {
    Switch notificationsSwitch(WidgetTester tester) => tester.widget<Switch>(
      find.descendant(
        of: byIdentifier(SettingsIds.botNotifications),
        matching: find.byType(Switch),
      ),
    );

    Future<void> tapHidden(WidgetTester tester) async {
      await tester.tap(find.text('Hidden from list'));
      await tester.pumpAndSettle();
    }

    testWidgets('Cancel leaves both settings where they were', (tester) async {
      final store = MemoryStore();
      final commands = <Map<String, Object?>>[];
      final predicted = <SidebarProfile>[];
      final state = BotSettingsController(api(store, commands), 'alpha');
      await open(tester, state, onPredict: predicted.add);
      await tapHidden(tester);
      expect(byIdentifier(SettingsIds.botHideConfirm), findsOneWidget);
      expect(
        find.textContaining('also turns off its notifications'),
        findsOneWidget,
      );
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(byIdentifier(SettingsIds.botHideConfirm), findsNothing);
      expect(state.hidden, isFalse);
      expect(state.notifications, isTrue);
      expect(notificationsSwitch(tester).value, isTrue);
      expect(commands, isEmpty);
      expect(predicted, isEmpty);
      state.dispose();
    });

    testWidgets('Confirm draws hidden and muted at once, in one command', (
      tester,
    ) async {
      final store = MemoryStore();
      final commands = <Map<String, Object?>>[];
      final predicted = <SidebarProfile>[];
      final gate = Completer<void>();
      final state = BotSettingsController(
        SettingsApi(store, (path, body) async {
          if (body != null) {
            commands.add(Map<String, Object?>.from(body as Map));
            await gate.future;
            return {
              'schemaVersion': 1,
              'commandId': body['commandId'],
              'revision': 4,
              'status': 'applied',
            };
          }
          if (path.startsWith('/api/settings')) return account();
          return botSettings();
        }),
        'alpha',
      );
      await open(tester, state, onPredict: predicted.add);
      await tapHidden(tester);
      await tester.tap(find.text('Hide and turn off'));
      await tester.pump();
      await tester.pump();
      // Still on the wire: the sidebar and both switches already show it.
      expect(predicted.single.hiddenFromSidebar, isTrue);
      expect(state.hidden, isTrue);
      expect(notificationsSwitch(tester).value, isFalse);
      expect(notificationsSwitch(tester).onChanged, isNull);
      expect(
        find.textContaining('Off while this Bot is hidden'),
        findsOneWidget,
      );
      gate.complete();
      await tester.pumpAndSettle();
      // The authority mutes in the hiding write, so nothing else is sent.
      expect(commands.map((command) => command['type']), ['bot/set-profile']);
      expect((commands.single['profile']! as Map)['hiddenFromSidebar'], true);
      expect(find.text('Saved.'), findsOneWidget);
      await state.save();
      expect(commands, hasLength(1));
      state.dispose();
    });

    testWidgets('a Bot already muted hides without a warning', (tester) async {
      final store = MemoryStore();
      final commands = <Map<String, Object?>>[];
      final state = BotSettingsController(
        api(store, commands, bot: botSettings(notifications: false)),
        'alpha',
      );
      await open(tester, state);
      await tapHidden(tester);
      expect(byIdentifier(SettingsIds.botHideConfirm), findsNothing);
      expect(commands.map((command) => command['type']), ['bot/set-profile']);
      expect(state.hidden, isTrue);
      state.dispose();
    });

    testWidgets('a refused hide puts both settings back', (tester) async {
      final store = MemoryStore();
      final predicted = <SidebarProfile>[];
      final state = BotSettingsController(
        SettingsApi(store, (path, body) async {
          if (body != null) {
            return {
              'schemaVersion': 1,
              'commandId': (body as Map)['commandId'],
              'status': 'rejected',
              'failure': 'Not yours to hide.',
            };
          }
          if (path.startsWith('/api/settings')) return account();
          return botSettings();
        }),
        'alpha',
      );
      await open(tester, state, onPredict: predicted.add);
      await tapHidden(tester);
      await tester.tap(find.text('Hide and turn off'));
      await tester.pumpAndSettle();
      expect(predicted.map((profile) => profile.hiddenFromSidebar), [
        true,
        false,
      ]);
      expect(state.hidden, isFalse);
      expect(state.notifications, isTrue);
      expect(notificationsSwitch(tester).value, isTrue);
      expect(notificationsSwitch(tester).onChanged, isNotNull);
      expect(find.text('Not yours to hide.'), findsOneWidget);
      state.dispose();
    });

    testWidgets('a hide whose answer is lost settles on what landed', (
      tester,
    ) async {
      final store = MemoryStore();
      final commands = <Map<String, Object?>>[];
      final predicted = <SidebarProfile>[];
      var landed = false;
      final state = BotSettingsController(
        SettingsApi(store, (path, body) async {
          if (body != null) {
            final command = Map<String, Object?>.from(body as Map);
            commands.add(command);
            if (command['type'] == 'bot/set-profile' && !landed) {
              // The Worker commits it; the answer never makes it back.
              landed = true;
              throw Exception('connection lost');
            }
            return {
              'schemaVersion': 1,
              'commandId': command['commandId'],
              'revision': 4,
              'status': 'applied',
            };
          }
          if (path.startsWith('/api/settings')) return account();
          return landed
              ? botSettings(hidden: true, notifications: false)
              : botSettings();
        }),
        'alpha',
      );
      await open(tester, state, onPredict: predicted.add);
      await tapHidden(tester);
      await tester.tap(find.text('Hide and turn off'));
      await tester.pumpAndSettle();
      // What the authority holds, not what the client guessed it refused.
      expect(state.hidden, isTrue);
      expect(state.notifications, isFalse);
      expect(notificationsSwitch(tester).value, isFalse);
      expect(notificationsSwitch(tester).onChanged, isNull);
      // The sidebar settles on the same answer, rather than rolling back to
      // the visible Bot it drew before the hide landed.
      expect(predicted.map((profile) => profile.hiddenFromSidebar), [
        true,
        true,
      ]);
      commands.clear();
      await tapHidden(tester);
      await tester.pumpAndSettle();
      expect(commands.map((command) => command['type']), ['bot/set-profile']);
      expect((commands.single['profile']! as Map)['hiddenFromSidebar'], false);
      // The mute the authority applied is what the switch now writes against.
      await tester.tap(find.text('Notifications'));
      await tester.pumpAndSettle();
      expect(commands.last['type'], 'bot/update-notifications');
      expect(commands.last['notifications'], {'enabled': true});
      state.dispose();
    });

    testWidgets('showing the Bot again leaves notifications off until asked', (
      tester,
    ) async {
      final store = MemoryStore();
      final commands = <Map<String, Object?>>[];
      final state = BotSettingsController(
        api(
          store,
          commands,
          bot: botSettings(hidden: true, notifications: false),
        ),
        'alpha',
      );
      await open(tester, state);
      expect(notificationsSwitch(tester).onChanged, isNull);
      await tapHidden(tester);
      expect(byIdentifier(SettingsIds.botHideConfirm), findsNothing);
      expect(commands.map((command) => command['type']), ['bot/set-profile']);
      expect(state.notifications, isFalse);
      expect(notificationsSwitch(tester).value, isFalse);
      expect(notificationsSwitch(tester).onChanged, isNotNull);
      await tester.tap(find.text('Notifications'));
      await tester.pumpAndSettle();
      expect(commands.last['type'], 'bot/update-notifications');
      expect(commands.last['notifications'], {'enabled': true});
      state.dispose();
    });
  });

  testWidgets('without the Package there is no model row to save', (
    tester,
  ) async {
    final store = MemoryStore();
    final commands = <Map<String, Object?>>[];
    final state = BotSettingsController(
      api(store, commands, models: false),
      'alpha',
    );
    await open(tester, state);
    expect(find.text('Follow the account model'), findsNothing);
    await tester.tap(find.text('Notifications'));
    await tester.pumpAndSettle();
    expect(commands.map((command) => command['type']), [
      'bot/update-notifications',
    ]);
    state.dispose();
  });
}

/// The shell's own wiring, in miniature: the sidebar draws what the profile
/// map says, and the settings surface predicts into that map the way
/// `_AppShellState.predictProfile` does.
class _Shell extends StatefulWidget {
  final BotSettingsController state;
  const _Shell({required this.state});

  @override
  State<_Shell> createState() => _ShellState();
}

class _ShellState extends State<_Shell> {
  Map<String, SidebarProfile> profiles = const {};

  @override
  Widget build(BuildContext context) => MaterialApp(
    theme: FrockTheme.theme(Brightness.dark),
    home: Scaffold(
      body: Row(
        children: [
          SizedBox(
            width: 260,
            child: ShellSidebar(
              bots: [bot('alpha', 'Inspected')],
              profiles: profiles,
              unread: const {},
              archived: const {},
              activeBotId: 'alpha',
              focusedBotId: 'alpha',
              workingBotId: null,
              loaded: true,
              showHidden: false,
              onSelect: (_) {},
              onCreateBot: () {},
              onSearch: () {},
              onProfile: () {},
              onMarketplace: () {},
              onToggleHidden: () {},
              onRetry: () async {},
            ),
          ),
          Expanded(
            child: SingleChildScrollView(
              child: BotSettingsView(
                controller: widget.state,
                onPredict: (profile) =>
                    setState(() => profiles = {...profiles, 'alpha': profile}),
              ),
            ),
          ),
        ],
      ),
    ),
  );
}
