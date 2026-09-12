import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/settings/bot_settings.dart';
import 'package:frockbot_native/shell/semantics.dart';
import 'package:frockbot_native/shell/sidebar.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'settings_test.dart' show SettingsApi;
import 'shell_layout_test.dart' show bot, byIdentifier;
import 'widget_test.dart' show MemoryStore;

Map<String, Object?> botSettings({
  String? pinnedAt,
  String namedBy = 'user',
  Object? model,
}) => {
  'schemaVersion': 1,
  'botId': 'alpha',
  'revision': 3,
  'profile': {
    'name': 'Inspected',
    'description': 'Reads the news',
    'namedBy': namedBy,
    'pinnedAt': ?pinnedAt,
  },
  'notifications': {'enabled': true},
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
}) async {
  tester.view.physicalSize = const Size(390, 2200);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      theme: FrockTheme.theme(Brightness.dark),
      home: Scaffold(
        body: SingleChildScrollView(
          child: BotSettingsView(controller: state, onPredict: onPredict),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('the panel follows the GrokBot order and hides the rest', (
    tester,
  ) async {
    final store = MemoryStore();
    final state = BotSettingsController(api(store, []), 'alpha');
    await open(tester, state);
    expect(find.text('Inspected avatar'), findsOneWidget);
    expect(find.text('Name'), findsOneWidget);
    expect(find.text('Label'), findsOneWidget);
    expect(find.text('Pinned'), findsOneWidget);
    expect(find.text('Description'), findsOneWidget);
    expect(
      find.text('Get notified when this Bot finishes or needs input'),
      findsOneWidget,
    );
    // No button: a change is written as it is made.
    expect(find.text('Save settings'), findsNothing);
    expect(find.byType(FilledButton), findsNothing);
    // Everything else is behind Advanced, closed.
    expect(find.text('Title'), findsNothing);
    expect(find.text('Members'), findsNothing);
    await tester.tap(find.text('Advanced'));
    await tester.pumpAndSettle();
    expect(find.text('Title'), findsOneWidget);
    expect(find.text('Hidden from sidebar'), findsOneWidget);
    expect(find.text('Named by you'), findsOneWidget);
    expect(find.text('Members'), findsOneWidget);
    expect(tester.takeException(), isNull);
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
              focusedBotId: null,
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
              onVoice: () {},
              voiceControl: VoiceControlState.idle,
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
