/// Voice mode: the call where the thread was (ADR 0031).
///
/// The layout tests are the point. Three states share one fixed stage, so a
/// character that moved when the Bot started speaking would be a bug rather
/// than a style; the assertions compare the measured rectangles across the
/// states instead of trusting the constants.
library;

import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/flock/avatar.dart';
import 'package:frockbot_native/settings/bot_settings.dart';
import 'package:frockbot_native/settings/voice_settings.dart';
import 'package:frockbot_native/shell/composer.dart';
import 'package:frockbot_native/shell/semantics.dart';
import 'package:frockbot_native/theme/frock_theme.dart';
import 'package:frockbot_native/voice/appearance.dart';
import 'package:frockbot_native/voice/assistant.dart';
import 'package:frockbot_native/voice/capture.dart';
import 'package:frockbot_native/voice/footer.dart';
import 'package:frockbot_native/voice/voice_mode.dart';

import 'bot_settings_test.dart' show api, botSettings;
import 'shell_layout_test.dart' show byIdentifier;
import 'voice_fakes.dart';
import 'voice_shell_harness.dart';
import 'widget_test.dart' show MemoryStore;

final surfaceBoundary = GlobalKey();

/// Optional review artifact, kept outside the repository:
/// `--dart-define=VOICE_VISUAL_OUTPUT=<dir>`.
Future<void> capture(WidgetTester tester, GlobalKey key, String name) async {
  const output = String.fromEnvironment('VOICE_VISUAL_OUTPUT');
  if (output.isEmpty) return;
  // The character is an asset the Rive runtime decodes off the test's fake
  // clock; give it real time to land before the frame is read back.
  await tester.runAsync(() => Future<void>.delayed(const Duration(seconds: 1)));
  await tester.pump();
  await tester.runAsync(() async {
    final image =
        await (key.currentContext!.findRenderObject()
                as RenderRepaintBoundary)
            .toImage(pixelRatio: 2);
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    await File('$output/$name.png').writeAsBytes(bytes!.buffer.asUint8List());
    image.dispose();
  });
}

AssistantSessionController controllerFor(FakeVoiceSocket socket) =>
    AssistantSessionController(
      openSocket: () async => socket,
      capture: FakeVoiceCapture(),
      player: FakeVoicePlayer(),
    );

/// A live call: welcomed, listening, and with the shell out of the way.
Future<AssistantSessionController> live(
  WidgetTester tester,
  FakeVoiceSocket socket,
) async {
  final controller = controllerFor(socket);
  addTearDown(controller.dispose);
  await controller.start();
  await tester.pump();
  socket.deliver(jsonEncode({'type': 'welcome', 'protocol_version': 1}));
  socket.deliver(jsonEncode({'type': 'status', 'status': 'listening'}));
  await tester.pump();
  await tester.pump();
  return controller;
}

Future<void> mountSurface(
  WidgetTester tester,
  AssistantSessionController controller, {
  required double width,
  double height = 844,
  void Function(String botId)? onOpenWork,
}) async {
  tester.view.physicalSize = Size(width, height);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      theme: FrockTheme.theme(Brightness.dark),
      home: RepaintBoundary(
        key: surfaceBoundary,
        child: Scaffold(
          body: VoiceMode(
            session: controller,
            botName: 'Rosemary',
            characterId: 'dog',
            primary: '#dca258',
            onEnd: () {},
            onOpenWork: onOpenWork,
          ),
        ),
      ),
    ),
  );
  await tester.pump();
}

String delegation(String botId, String botName, String state) => jsonEncode({
  'schemaVersion': 1,
  'type': 'voice/delegation',
  'botId': botId,
  'botName': botName,
  'state': state,
});

void main() {
  testWidgets('the call replaces the thread and the composer', (tester) async {
    final harness = VoiceShellHarness();
    await harness.mount(tester, width: 1280, brightness: Brightness.dark);
    expect(find.byType(Composer), findsOneWidget);
    await harness.call.start();
    harness.showCall(botId: 'voice-bot');
    await tester.pump();

    expect(find.byType(VoiceMode), findsOneWidget);
    // Not overlaid: the thread's composer is not in the tree at all, and
    // neither is the dock the background call would wear.
    expect(find.byType(Composer), findsNothing);
    expect(find.byType(VoiceFooter), findsNothing);
    // The header keeps the name and the mark that says why the thread is gone.
    expect(find.text('Rosemary'), findsWidgets);
    expect(byIdentifier(VoiceIds.headerPill), findsOneWidget);
    expect(find.byTooltip('Your Bots'), findsNothing);
    await harness.dispose(tester);
  });

  testWidgets('a call with another Bot leaves this Bot its thread', (
    tester,
  ) async {
    final harness = VoiceShellHarness();
    await harness.mount(tester, width: 1280, brightness: Brightness.dark);
    await harness.call.start();
    // The call is open, but not on the Bot whose page this is.
    harness.showCall(botId: 'somebody-else');
    await tester.pump();

    expect(find.byType(VoiceMode), findsNothing);
    expect(find.byType(VoiceFooter), findsOneWidget);
    expect(find.byType(Composer), findsOneWidget);
    await harness.dispose(tester);
  });

  for (final width in [390.0, 1280.0]) {
    testWidgets('the stage holds still across all three states: $width', (
      tester,
    ) async {
      final socket = FakeVoiceSocket();
      final controller = await live(tester, socket);
      await mountSurface(tester, controller, width: width);

      Rect stageRect() => tester.getRect(byIdentifier(VoiceIds.stage));
      Rect avatarRect() => tester.getRect(find.byType(CharacterAvatar));
      Rect nameRect() => tester.getRect(find.text('Rosemary'));

      expect(find.text('Listening'), findsOneWidget);
      final listening = (stageRect(), avatarRect(), nameRect());

      socket.deliver(jsonEncode({'type': 'status', 'status': 'speaking'}));
      await tester.pump();
      await tester.pump();
      expect(find.text('Speaking'), findsOneWidget);
      expect((stageRect(), avatarRect(), nameRect()), listening);

      controller.pause();
      await tester.pump();
      await tester.pump();
      expect(find.text('Paused'), findsOneWidget);
      expect((stageRect(), avatarRect(), nameRect()), listening);

      // And the character is the size the design gives it, in its ring.
      expect(avatarRect().width, voiceModeAvatarSize);
      expect(stageRect().width, greaterThanOrEqualTo(voiceModeRingSize));
    });
  }

  testWidgets('no captions, no transcript: the state is one word', (
    tester,
  ) async {
    final socket = FakeVoiceSocket();
    final controller = await live(tester, socket);
    await mountSurface(tester, controller, width: 390);
    socket.deliver(
      jsonEncode({
        'type': 'transcript',
        'role': 'assistant',
        'text': 'the words it said',
      }),
    );
    await tester.pump();

    expect(find.text('the words it said'), findsNothing);
    expect(
      find.descendant(
        of: byIdentifier(VoiceIds.mode),
        matching: find.byType(TextField),
      ),
      findsNothing,
    );
  });

  testWidgets('a delegation becomes a chip, and finishing offers the Work', (
    tester,
  ) async {
    final socket = FakeVoiceSocket();
    final controller = await live(tester, socket);
    final opened = <String>[];
    await mountSurface(
      tester,
      controller,
      width: 390,
      onOpenWork: opened.add,
    );

    // An empty slot says nothing at all.
    expect(
      find.descendant(
        of: byIdentifier(VoiceIds.activity),
        matching: find.byType(Text),
      ),
      findsNothing,
    );

    socket.deliver(delegation('scout', 'Scout', 'asked'));
    await tester.pump();
    await tester.pump();
    expect(byIdentifier(VoiceIds.chip('scout')), findsOneWidget);
    expect(find.text('Scout'), findsOneWidget);
    expect(find.text('Working'), findsOneWidget);
    expect(find.text('Work'), findsNothing);

    socket.deliver(delegation('scout', 'Scout', 'answering'));
    await tester.pump();
    await tester.pump();
    // Still one chip: the ledger is per Bot, not per frame.
    expect(byIdentifier(VoiceIds.chip('scout')), findsOneWidget);
    expect(find.text('Working'), findsOneWidget);

    socket.deliver(delegation('scout', 'Scout', 'finished'));
    await tester.pump();
    await tester.pump();
    expect(find.text('Working'), findsNothing);
    expect(find.byIcon(Icons.check_rounded), findsOneWidget);
    await tester.tap(find.text('Work'));
    await tester.pump();
    expect(opened, ['scout']);
    await tester.pump(const Duration(milliseconds: 1300));
  });

  testWidgets('Pause sleeps the call; Resume wakes it with what it missed', (
    tester,
  ) async {
    final socket = FakeVoiceSocket();
    final controller = await live(tester, socket);
    await mountSurface(tester, controller, width: 390);
    socket.sent.clear();

    await tester.tap(find.bySemanticsLabel('Pause the call'));
    await tester.pump();
    await tester.pump();
    expect(
      socket.texts.map((text) => jsonDecode(text)['type']),
      contains('voice/sleep'),
    );
    expect(controller.paused, isTrue);
    expect(find.text('Paused'), findsOneWidget);
    // The bar is Resume and End now; nothing to pause, and no composer.
    expect(find.bySemanticsLabel('Pause the call'), findsNothing);
    expect(byIdentifier(VoiceIds.hangUp), findsOneWidget);

    // Work admitted before the pause lands while nobody is listening.
    socket.deliver(delegation('scout', 'Scout', 'finished'));
    socket.deliver(delegation('archie', 'Archie', 'finished'));
    await tester.pump();
    await tester.pump();
    expect(controller.finishedWhilePaused, 2);
    expect(find.text('2'), findsOneWidget);
    expect(
      find.bySemanticsLabel('Resume the call, 2 finished while paused'),
      findsOneWidget,
    );
    // The same slot lists what finished while asleep.
    expect(byIdentifier(VoiceIds.chip('scout')), findsOneWidget);
    expect(byIdentifier(VoiceIds.chip('archie')), findsOneWidget);

    socket.sent.clear();
    await tester.tap(find.bySemanticsLabel('Resume the call, 2 finished while paused'));
    await tester.pump();
    await tester.pump();
    expect(
      socket.texts.map((text) => jsonDecode(text)['type']),
      contains('voice/wake'),
    );
    expect(controller.paused, isFalse);
    expect(controller.finishedWhilePaused, 0);
    expect(find.text('Listening'), findsOneWidget);
    expect(find.bySemanticsLabel('Pause the call'), findsOneWidget);
    await tester.pump(const Duration(milliseconds: 1300));
  });

  testWidgets('a paused call sends no audio and no wake of its own', (
    tester,
  ) async {
    final socket = FakeVoiceSocket();
    final capture = FakeVoiceCapture();
    final controller = AssistantSessionController(
      openSocket: () async => socket,
      capture: capture,
      player: FakeVoicePlayer(),
    );
    addTearDown(controller.dispose);
    await controller.start();
    await tester.pump();
    socket.deliver(jsonEncode({'type': 'welcome', 'protocol_version': 1}));
    socket.deliver(jsonEncode({'type': 'status', 'status': 'listening'}));
    await tester.runAsync(() => settle());
    controller.pause();
    socket.sent.clear();
    for (var frame = 0; frame < 30; frame++) {
      capture.emit(AudioFrame(pcmFrame(0.6, mark: 7), 0.6, frame * 40));
    }
    await tester.runAsync(() => settle());

    expect(socket.binaries, isEmpty);
    expect(socket.texts, isEmpty);
  });

  testWidgets('Settings offers Voice, and the page writes one command', (
    tester,
  ) async {
    final store = MemoryStore();
    final commands = <Map<String, Object?>>[];
    final state = BotSettingsController(
      api(store, commands, bot: botSettings()),
      'alpha',
    );
    addTearDown(state.dispose);
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: Scaffold(
          body: SingleChildScrollView(
            child: BotSettingsView(controller: state, background: 'dog'),
          ),
        ),
      ),
    );
    await state.load();
    await tester.pumpAndSettle();

    // No voice of its own: the character's default, with nothing described.
    expect(find.text('Sulafat'), findsOneWidget);
    await tester.ensureVisible(byIdentifier(VoiceIds.settingsRow));
    await tester.pumpAndSettle();
    await tester.tap(byIdentifier(VoiceIds.settingsRow));
    await tester.pumpAndSettle();
    expect(byIdentifier(VoiceIds.settings), findsOneWidget);
    expect(find.text('One of 30 Gemini voices'), findsOneWidget);
    expect(find.text('Sulafat · Warm'), findsOneWidget);
    expect(find.text('Hear it'), findsNothing);

    // Accent, then attitude, then a dial: each one written as it is made.
    await tester.tap(byIdentifier(VoiceIds.accent));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Australian'));
    await tester.pumpAndSettle();
    await tester.tap(byIdentifier(VoiceIds.attitude));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Warm & friendly'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Terse'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Dry'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Natural').last);
    await tester.pumpAndSettle();
    await tester.enterText(
      find.descendant(
        of: byIdentifier(VoiceIds.custom),
        matching: find.byType(TextField),
      ),
      'Call me Tim.',
    );
    await tester.pump(botSettingsAutosaveDelay + const Duration(seconds: 1));
    await tester.pumpAndSettle();

    final last = commands.last;
    expect(last['schemaVersion'], 1);
    expect(last['type'], 'bot/update-voice');
    expect(last['commandId'], isA<String>());
    expect(last['expectedRevision'], isA<int>());
    expect(last['botId'], 'alpha');
    expect(last['voice'], {
      'schemaVersion': 1,
      'voiceName': 'Sulafat',
      'delivery': {
        'accent': 'australian',
        'attitude': 'warm-friendly',
        'turnLength': 'terse',
        'humour': 'dry',
        'disfluency': 'natural',
        'custom': 'Call me Tim.',
      },
    });
  });

  testWidgets('a Bot that has chosen a voice shows it', (tester) async {
    final store = MemoryStore();
    final state = BotSettingsController(
      api(
        store,
        [],
        bot: {
          ...botSettings(),
          'voice': {
            'schemaVersion': 1,
            'voiceName': 'Gacrux',
            'delivery': {'accent': 'irish', 'attitude': 'dry-deadpan'},
          },
        },
      ),
      'alpha',
    );
    addTearDown(state.dispose);
    tester.view.physicalSize = const Size(390, 2200);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: Scaffold(
          body: SingleChildScrollView(
            child: BotSettingsView(controller: state, background: 'dog'),
          ),
        ),
      ),
    );
    await state.load();
    await tester.pumpAndSettle();

    expect(find.text('Gacrux · Irish · Dry & deadpan'), findsOneWidget);
  });

  // The review artifacts: the real shell, at the two sizes the design was
  // drawn for, in each of the three states. A no-op without the define.
  for (final size in [(1280.0, 800.0, 'desktop'), (390.0, 844.0, 'phone')]) {
    testWidgets('voice mode reads back as an image: ${size.$3}', (
      tester,
    ) async {
      final harness = VoiceShellHarness();
      await harness.mount(
        tester,
        width: size.$1,
        height: size.$2,
        brightness: Brightness.dark,
      );
      await harness.call.start();
      harness.showCall(botId: 'voice-bot');
      harness.callSocket.deliver(
        jsonEncode({'type': 'welcome', 'protocol_version': 1}),
      );
      harness.callSocket.deliver(
        jsonEncode({'type': 'status', 'status': 'listening'}),
      );
      await tester.pump();
      harness.callSocket.deliver(
        jsonEncode({'type': 'status', 'status': 'speaking'}),
      );
      await tester.pump();
      await tester.pump();
      expect(find.text('Speaking'), findsOneWidget);
      await capture(tester, harness.boundary, 'voice-${size.$3}-speaking');

      harness.callSocket.deliver(
        jsonEncode({'type': 'status', 'status': 'listening'}),
      );
      harness.callSocket.deliver(delegation('scout', 'Scout', 'answering'));
      await tester.pump();
      await tester.pump();
      expect(find.text('Working'), findsOneWidget);
      await capture(tester, harness.boundary, 'voice-${size.$3}-working');

      harness.call.pause();
      harness.callSocket.deliver(delegation('scout', 'Scout', 'finished'));
      harness.callSocket.deliver(delegation('archie', 'Archie', 'finished'));
      await tester.pump();
      await tester.pump();
      expect(find.text('Paused'), findsOneWidget);
      await capture(tester, harness.boundary, 'voice-${size.$3}-paused');

      await tester.pump(const Duration(milliseconds: 1300));
      await harness.dispose(tester);
    });
  }

  testWidgets('the Voice page reads back as an image', (tester) async {
    final store = MemoryStore();
    final state = BotSettingsController(
      api(
        store,
        [],
        bot: {
          ...botSettings(),
          'voice': {
            'schemaVersion': 1,
            'voiceName': 'Sulafat',
            'delivery': {
              'accent': 'australian',
              'attitude': 'warm-friendly',
              'pace': 'natural',
              'turnLength': 'terse',
              'humour': 'dry',
              'disfluency': 'natural',
              'custom': 'Call me Tim. Skip the preamble.',
            },
          },
        },
      ),
      'alpha',
    );
    addTearDown(state.dispose);
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await state.load();
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: RepaintBoundary(
          key: surfaceBoundary,
          child: BotVoicePage(controller: state, characterId: 'dog'),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Sulafat · Warm'), findsOneWidget);
    expect(find.text('Australian'), findsOneWidget);
    await capture(tester, surfaceBoundary, 'voice-settings-phone');
  });

  test('the Dart voice tables mirror the TypeScript ones', () {
    expect(geminiVoicesV1.length, 30);
    expect(voiceAccentsV1.length, 11);
    expect(voiceAttitudesV1.length, 12);
    expect(defaultGeminiVoiceForCharacterV1('cat'), 'Despina');
    expect(defaultGeminiVoiceForCharacterV1('unknown-character'), 'Schedar');
    expect(voiceCustomMaxCharsV1, 500);
  });
}
