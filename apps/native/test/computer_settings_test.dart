import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/computer/client.dart';
import 'package:frockbot_native/computer/settings.dart';
import 'package:frockbot_native/settings/bot_settings.dart';
import 'package:frockbot_native/shell/semantics.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'bot_settings_test.dart' show account, botSettings;
import 'computer_test.dart' show projection;
import 'settings_test.dart' show SettingsApi;
import 'shell_layout_test.dart' show byIdentifier;
import 'widget_test.dart' show MemoryStore;

/// A Computer that answers `answer` and records every command it is sent.
({ComputerController controller, List<Object?> commands}) computer(
  Map<String, Object?> answer,
) {
  final commands = <Object?>[];
  final controller = ComputerController(
    SettingsApi(MemoryStore(), (path, body) async {
      if (body != null) {
        commands.add((body as Map)['type']);
        return {
          'version': 1,
          'commandId': body['commandId'],
          'type': body['type'],
          'status': 'applied',
          'completedAt': '2026-09-24T00:00:00.000Z',
        };
      }
      return answer;
    }),
    'bot-1',
  );
  return (controller: controller, commands: commands);
}

Map<String, Object?> checkpointed({String phase = 'ready'}) => {
  ...projection(phase: phase, viewer: false),
  'checkpoint': {'version': 1, 'createdAt': '2026-09-21T00:00:00.000Z'},
};

Future<void> show(WidgetTester tester, ComputerController controller) async {
  tester.view.physicalSize = const Size(390, 1600);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await controller.read();
  await tester.pumpWidget(
    MaterialApp(
      theme: FrockTheme.theme(Brightness.dark),
      home: ComputerSettingsPage(controller: controller),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> close(WidgetTester tester, ComputerController controller) async {
  controller.dispose();
  await tester.pumpWidget(const SizedBox.shrink());
}

void main() {
  test('reads the newest checkpoint off the projection', () {
    final state = ComputerProjection.fromJson(checkpointed());
    expect(state.checkpointAt, DateTime.utc(2026, 9, 21));
    expect(
      computerCheckpointLineV1(
        state.checkpointAt,
        now: DateTime.utc(2026, 9, 24),
      ),
      'Last checkpoint saved 3d ago',
    );
    expect(
      ComputerProjection.fromJson(projection()).checkpointAt,
      isNull,
      reason: 'a server that sends none is a Computer with none',
    );
  });

  test('a Reset is called one, not an update', () {
    final state = ComputerProjection.fromJson(
      projection(
        phase: 'updating',
        viewer: false,
        progress: {
          'version': 1,
          'kind': 'update',
          'startedAt': '2026-09-24T00:00:00.000Z',
          'updatedAt': '2026-09-24T00:00:05.000Z',
          'index': 2,
          'total': 4,
          'steps': [
            {
              'version': 1,
              'id': 'keeping-sign-ins',
              'label': 'Keeping your browser sign-ins',
              'status': 'complete',
            },
            {
              'version': 1,
              'id': 'resetting',
              'label': 'Resetting to the checkpoint',
              'status': 'active',
            },
          ],
        },
      ),
    );
    expect(computerOpeningHeadingV1(state), 'Resetting your computer');
  });

  testWidgets('says the Computer is every Bot’s before anything else', (
    tester,
  ) async {
    final held = computer(checkpointed());
    await show(tester, held.controller);

    expect(find.textContaining('shared by all your Bots'), findsOneWidget);
    expect(find.text(computerSignInsCopyV1), findsOneWidget);
    await close(tester, held.controller);
  });

  testWidgets('an Update is two gestures, and the dialog says what goes', (
    tester,
  ) async {
    final held = computer(checkpointed());
    await show(tester, held.controller);

    await tester.tap(byIdentifier(ComputerSettingsIds.update));
    await tester.pumpAndSettle();
    expect(find.text('Update the Computer?'), findsOneWidget);
    expect(find.text(computerKeptCopyV1), findsOneWidget);
    expect(find.text(computerUpdateLostCopyV1), findsOneWidget);
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(held.commands, isEmpty);

    await tester.tap(byIdentifier(ComputerSettingsIds.update));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Update'));
    await tester.pumpAndSettle();
    expect(held.commands, ['updateComputer']);
    await close(tester, held.controller);
  });

  testWidgets('a Reset names the checkpoint it goes back to', (tester) async {
    final held = computer(checkpointed());
    await show(tester, held.controller);

    await tester.tap(byIdentifier(ComputerSettingsIds.reset));
    await tester.pumpAndSettle();
    expect(find.text('Reset the Computer?'), findsOneWidget);
    expect(find.textContaining('goes back to the checkpoint saved'), findsOne);
    expect(find.text(computerResetLostCopyV1), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, 'Reset'));
    await tester.pumpAndSettle();
    expect(held.commands, ['resetComputer']);
    await close(tester, held.controller);
  });

  testWidgets('with no checkpoint, Reset waits for one to be saved', (
    tester,
  ) async {
    final held = computer(projection(viewer: false));
    await show(tester, held.controller);

    expect(find.text('No checkpoint saved yet'), findsOneWidget);
    expect(find.text('Save a checkpoint first'), findsOneWidget);
    await tester.tap(byIdentifier(ComputerSettingsIds.reset));
    await tester.pumpAndSettle();
    expect(find.text('Reset the Computer?'), findsNothing);

    await tester.tap(byIdentifier(ComputerSettingsIds.save));
    await tester.pumpAndSettle();
    expect(held.commands, ['saveCheckpoint']);
    await close(tester, held.controller);
  });

  testWidgets('a held desktop refuses both until it is released', (
    tester,
  ) async {
    final held = computer(checkpointed(phase: 'human-control'));
    await show(tester, held.controller);

    expect(find.text('Release the desktop first'), findsNWidgets(2));
    await tester.tap(byIdentifier(ComputerSettingsIds.update));
    await tester.pumpAndSettle();
    expect(find.text('Update the Computer?'), findsNothing);
    expect(held.commands, isEmpty);
    await close(tester, held.controller);
  });

  testWidgets('Bot settings has the door only where there is a Computer', (
    tester,
  ) async {
    Future<void> settings({VoidCallback? onOpenComputer}) async {
      final state = BotSettingsController(
        SettingsApi(MemoryStore(), (path, body) async {
          if (path.startsWith('/api/settings')) return account();
          return botSettings();
        }),
        'alpha',
      );
      tester.view.physicalSize = const Size(390, 2200);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: Scaffold(
            body: SingleChildScrollView(
              child: BotSettingsView(
                // A second page, not the first one handed a new controller.
                key: UniqueKey(),
                controller: state,
                onOpenComputer: onOpenComputer,
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      addTearDown(state.dispose);
    }

    await settings();
    expect(byIdentifier(SettingsIds.botComputer), findsNothing);

    var opened = 0;
    await settings(onOpenComputer: () => opened += 1);
    await tester.tap(byIdentifier(SettingsIds.botComputer));
    expect(opened, 1);
  });
}
