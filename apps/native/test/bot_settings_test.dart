import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/settings/bot_settings.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'settings_test.dart' show SettingsApi;
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

Future<void> open(WidgetTester tester, BotSettingsController state) async {
  tester.view.physicalSize = const Size(390, 2200);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      theme: FrockTheme.theme(Brightness.dark),
      home: Scaffold(
        body: SingleChildScrollView(child: BotSettingsView(controller: state)),
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
    expect(find.text('Save settings'), findsOneWidget);
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
    expect(find.text('Save settings'), findsOneWidget);
    expect(find.text('Settings couldn’t load'), findsNothing);
    state.dispose();
  });

  testWidgets('a save writes the profile, the policy and the Bot model', (
    tester,
  ) async {
    final store = MemoryStore();
    final commands = <Map<String, Object?>>[];
    final state = BotSettingsController(api(store, commands), 'alpha');
    await open(tester, state);
    await tester.enterText(find.byType(TextFormField).first, 'Renamed');
    await tester.tap(find.text('Pinned'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Save settings'));
    await tester.pumpAndSettle();
    expect(commands.map((command) => command['type']), [
      'bot/set-profile',
      'bot/update-notifications',
      'bot/set-package-settings',
    ]);
    final profile = commands.first['profile']! as Map;
    expect(profile['name'], 'Renamed');
    expect(profile['pinnedAt'], isNot(''));
    // No model was chosen, so the override is removed rather than written.
    expect(commands.last['unset'], ['model']);
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
    await tester.tap(find.text('Save settings'));
    await tester.pumpAndSettle();
    // The read was at 3, and each applied command moved it.
    expect(commands.map((command) => command['expectedRevision']), [3, 4, 5]);
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
    await tester.tap(find.text('Save settings'));
    await tester.pumpAndSettle();
    // The refused command is the same command, asked again at the revision the
    // authority reported; the two after it fence on what that one left.
    expect(commands.map((command) => command['expectedRevision']), [
      3,
      7,
      8,
      8,
    ]);
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
    await tester.tap(find.text('Save settings'));
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
    await tester.tap(find.text('Save settings'));
    await tester.pumpAndSettle();
    expect(commands, isEmpty);
    expect(find.text('Enter a name for this Bot.'), findsOneWidget);
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
    await tester.tap(find.text('Save settings'));
    await tester.pumpAndSettle();
    expect(commands.map((command) => command['type']), [
      'bot/set-profile',
      'bot/update-notifications',
    ]);
    state.dispose();
  });
}
