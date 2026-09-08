import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/flock/create.dart';
import 'package:frockbot_native/flock/lifecycle.dart';
import 'package:frockbot_native/flock/sheep.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'settings_test.dart' show SettingsApi;
import 'widget_test.dart' show MemoryStore;

Map<String, Object?> directory(int revision) => {
  'schemaVersion': 1,
  'revision': revision,
  'bots': <Object?>[],
};

Map<String, Object?> receipt(
  Object? commandId, {
  String status = 'applied',
  String? failure,
}) => {
  'schemaVersion': 1,
  'commandId': commandId,
  'status': status,
  'revision': 4,
  'failure': ?failure,
};

void main() {
  test('a Bot id is the name, slugged, with a suffix so two are two', () {
    expect(botIdFromNameV1('Night shift', suffix: 'abcd1234'),
        'night-shift-abcd1234');
    expect(botIdFromNameV1('  ~~~  ', suffix: 'abcd1234'), 'bot-abcd1234');
    // A letter outside a-z is dropped rather than folded onto one: an id is
            // opaque and the name is what a person reads.
    expect(
      botIdFromNameV1('Ünïcode & things!', suffix: 'abcd1234'),
      'n-code-things-abcd1234',
    );
    expect(
      botIdFromNameV1(botIdFromNameV1('x' * 200), suffix: 'abcd1234').length,
      lessThanOrEqualTo(89),
    );
  });

  test('the sheep is the background plus the canonical, and nothing else', () {
    // The wardrobe's three bands stay at the catalogue's neutral roots:
    // wearables are deferred, and a Bot this app makes must still be one a
    // wardrobe can dress when they return.
    expect(defaultSheepRecipeV1('hot-pink'), {
      'schemaVersion': 1,
      'background': 'hot-pink',
      'upper': 'upper-neutral',
      'middle': 'middle-neutral',
      'lower': 'lower-neutral',
    });
    // A colour this build does not carry is not a hole where a face should be.
    expect(
      defaultSheepRecipeV1('chartreuse')['background'],
      defaultSheepBackgroundV1,
    );
  });

  test('a create is one command, kept until the authority answers it', () async {
    final store = MemoryStore();
    final sent = <Map<String, Object?>>[];
    var lost = true;
    final api = SettingsApi(store, (path, body) async {
      if (body == null) return directory(3);
      final command = (body as Map).cast<String, Object?>();
      sent.add(command);
      if (lost) {
        lost = false;
        throw const RequestFailure('lost', null);
      }
      return receipt(command['commandId']);
    });
    final first = CreateBotController(api, store, 'tim');
    first.name = 'Night shift';
    first.background = 'lime-green';
    expect(await first.create(), isNull);
    // The command is on disk before it is sent, so the next attempt finishes
    // the Bot that was already asked for rather than making a second one.
    expect(store.values.containsKey('bot-create.tim'), isTrue);
    first.dispose();

    final next = CreateBotController(api, store, 'tim');
    await next.restore();
    expect(next.name, 'Night shift');
    expect(next.background, 'lime-green');
    final made = await next.create();
    expect(made?.botId, sent.first['botId']);
    expect(sent[1]['commandId'], sent[0]['commandId']);
    expect(store.values.containsKey('bot-create.tim'), isFalse);
    next.dispose();
    api.close();
  });

  test('a create re-fences on the revision a conflict reported', () async {
    final store = MemoryStore();
    final revisions = <Object?>[];
    var revision = 3;
    var conflicted = false;
    final api = SettingsApi(store, (path, body) async {
      if (body is! Map) return directory(revision);
      revisions.add(body['expectedRevision']);
      if (!conflicted) {
        conflicted = true;
        revision = 9;
        throw const RequestFailure('flock revision is 9', 409);
      }
      return receipt(body['commandId']);
    });
    final controller = CreateBotController(api, store, 'tim');
    controller.name = 'Alpha';
    expect(await controller.create(), isNotNull);
    expect(revisions, [3, 9]);
    controller.dispose();
    api.close();
  });

  test('a refused create says why and does not offer itself again', () async {
    final store = MemoryStore();
    final api = SettingsApi(store, (path, body) async {
      if (body == null) return directory(1);
      return receipt(
        (body as Map)['commandId'],
        status: 'rejected',
        failure: 'Bot directory limit reached',
      );
    });
    final controller = CreateBotController(api, store, 'tim');
    controller.name = 'Ninety-nine';
    expect(await controller.create(), isNull);
    expect(controller.message, 'Bot directory limit reached');
    expect(store.values.containsKey('bot-create.tim'), isFalse);
    controller.dispose();
    api.close();
  });

  testWidgets('the create sheet asks for a sheep, a name and a first message', (
    tester,
  ) async {
    final store = MemoryStore();
    final api = SettingsApi(store, (path, body) async => directory(0));
    final controller = CreateBotController(api, store, 'tim');
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: Scaffold(body: CreateBotSheet(controller: controller)),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Meet your sheep'), findsOneWidget);
    expect(find.text('Bot name'), findsOneWidget);
    expect(find.text('First message'), findsOneWidget);
    // Six colours, and no wardrobe: the deferred bands have no control.
    expect(find.byTooltip('Hot pink'), findsOneWidget);
    expect(find.text('Headwear'), findsNothing);

    // A nameless Bot is refused where the press was, before anything is sent.
    await tester.ensureVisible(find.text('Create Bot'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Create Bot'));
    await tester.pumpAndSettle();
    expect(find.text('Give this Bot a name.'), findsOneWidget);
    controller.dispose();
    api.close();
  });

  testWidgets('a Bot’s colour changes, fenced on the revision just read', (
    tester,
  ) async {
    final store = MemoryStore();
    final sent = <Map<String, Object?>>[];
    final api = SettingsApi(store, (path, body) async {
      if (body == null) {
        return {
          'schemaVersion': 1,
          'botId': 'alpha',
          'revision': 4,
          'sheep': defaultSheepRecipeV1('electric-blue'),
        };
      }
      sent.add((body as Map).cast<String, Object?>());
      return receipt(body['commandId']);
    });
    String? chosen;
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () async =>
                  chosen = await SheepColourSheet.show(
                    context,
                    api: api,
                    botId: 'alpha',
                    botName: 'Alpha',
                  ),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    expect(find.text('Alpha’s colour'), findsOneWidget);
    // No wardrobe here either: six colours and nothing else.
    expect(find.byTooltip('Hot pink'), findsOneWidget);
    await tester.tap(find.byTooltip('Hot pink'));
    await tester.pumpAndSettle();
    expect(chosen, 'hot-pink');
    expect(sent.single['type'], 'bot/update-sheep');
    // The fence is the revision the read just reported, not one held since the
    // sheet opened.
    expect(sent.single['expectedRevision'], 4);
    expect(
      (sent.single['sheep']! as Map)['background'],
      'hot-pink',
    );
    await tester.pumpWidget(const SizedBox());
    api.close();
  });

  testWidgets('the danger zone offers what the Bot’s status allows', (
    tester,
  ) async {
    final store = MemoryStore();
    final sent = <Map<String, Object?>>[];
    final api = SettingsApi(store, (path, body) async {
      sent.add((body! as Map).cast<String, Object?>());
      return {
        'schemaVersion': 1,
        'commandId': (body as Map)['commandId'],
        'botId': 'alpha',
        'status': 'applied',
        'lifecycle': {
          'schemaVersion': 1,
          'botId': 'alpha',
          'status': 'archived',
          'revision': 1,
        },
      };
    });
    final lifecycle = BotLifecycleCommands(api, store, 'tim');
    var changed = 0;
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: Scaffold(
          body: BotDangerZone(
            lifecycle: lifecycle,
            botId: 'alpha',
            botName: 'Alpha',
            archived: false,
            onChanged: () async => changed += 1,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Archive Bot'), findsOneWidget);
    expect(find.text('Restore Bot'), findsNothing);
    expect(find.text('Delete Bot'), findsOneWidget);

    // A delete asks first, and names the Bot in the question.
    await tester.tap(find.text('Delete Bot'));
    await tester.pumpAndSettle();
    expect(find.text('Delete Alpha?'), findsOneWidget);
    expect(
      find.textContaining('removes its conversation and Applets'),
      findsOneWidget,
    );
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(sent, isEmpty);

    await tester.tap(find.text('Archive Bot'));
    await tester.pumpAndSettle();
    await tester.tap(
      find.descendant(
        of: find.byType(AlertDialog),
        matching: find.widgetWithText(FilledButton, 'Archive Bot'),
      ),
    );
    await tester.pumpAndSettle();
    expect(sent.single['type'], 'bot/archive');
    expect(changed, 1);
    expect(jsonDecode(store.values['bot-lifecycle.tim'] ?? 'null'), isNull);
    await tester.pumpWidget(const SizedBox());
    lifecycle.dispose();
    api.close();
  });

  testWidgets('an archived Bot is offered restore instead of archive', (
    tester,
  ) async {
    final store = MemoryStore();
    final api = SettingsApi(store, (path, body) async => null);
    final lifecycle = BotLifecycleCommands(api, store, 'tim');
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: Scaffold(
          body: BotDangerZone(
            lifecycle: lifecycle,
            botId: 'alpha',
            botName: 'Alpha',
            archived: true,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Restore Bot'), findsOneWidget);
    expect(find.text('Archive Bot'), findsNothing);
    await tester.pumpWidget(const SizedBox());
    lifecycle.dispose();
    api.close();
  });
}
