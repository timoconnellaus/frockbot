/// Voice mode: the call where the thread was (ADR 0031).
///
/// The layout tests are the point. Three states share one fixed stage, so a
/// character that moved when the Bot started speaking would be a bug rather
/// than a style; the assertions compare the measured rectangles across the
/// states instead of trusting the constants.
library;

import 'dart:async';
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
import 'package:frockbot_native/voice/protocol.dart';
import 'package:frockbot_native/voice/voice_mode.dart';

import 'bot_settings_test.dart' show account, api, botSettings;
import 'settings_test.dart' show SettingsApi;
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
        await (key.currentContext!.findRenderObject() as RenderRepaintBoundary)
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
  void Function(String botId, String runId)? onOpenWork,
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

String delegation(
  String botId,
  String botName,
  String state, {
  String? runId,
}) => jsonEncode({
  'schemaVersion': 1,
  'type': 'voice/delegation',
  'botId': botId,
  'botName': botName,
  'runId': runId ?? 'run-$botId',
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

  testWidgets('the composer is not talkable while a call is still closing', (
    tester,
  ) async {
    final harness = VoiceShellHarness();
    await harness.mount(tester, width: 1280, brightness: Brightness.dark);
    // A device slow to let go, so the teardown is still in flight while the
    // test looks at the screen.
    final stop = Completer<void>();
    harness.callCapture.stopGate = stop;
    await harness.call.start();
    harness.showCall(botId: 'voice-bot');
    await tester.pump();
    expect(find.byType(VoiceMode), findsOneWidget);

    // End the call from voice mode: the thread is back at once, and the
    // composer's voice control is held until the call has finished closing
    // rather than inviting a press the shell would refuse.
    await tester.tap(byIdentifier(VoiceIds.hangUp));
    await tester.pump();
    await tester.pump();
    final voice = find.byKey(const ValueKey('composer-voice'));
    expect(find.byType(Composer), findsOneWidget);
    expect(tester.widget<IconButton>(voice).onPressed, isNull);

    stop.complete();
    await tester.runAsync(() => settle());
    // The last of the teardown lands in the microtasks the frame flushes, and
    // the frame after that is the one carrying the released control.
    await tester.pump();
    await tester.pump();
    expect(tester.widget<IconButton>(voice).onPressed, isNotNull);
    // The footer's exit finishes on its own; the composer is talkable under
    // it, not over it.
    for (var frame = 0; frame < 20; frame++) {
      await tester.pump(const Duration(milliseconds: 16));
    }
    expect(tester.widget<IconButton>(voice).onPressed, isNotNull);
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

  testWidgets('a failed call says so where it said Listening', (tester) async {
    final socket = FakeVoiceSocket();
    final controller = await live(tester, socket);
    await mountSurface(tester, controller, width: 390);
    expect(find.text('Listening'), findsOneWidget);

    socket.deliver(
      jsonEncode({'type': 'error', 'message': 'upstream', 'code': 'upstream'}),
    );
    await tester.pump();
    await tester.pump();

    // The word stops claiming a call that is over, and the reason it is over
    // is on the surface that shows the call: the footer is the only other
    // place a failure is ever written, and voice mode does not draw it.
    expect(find.text('Listening'), findsNothing);
    expect(find.text('Call failed'), findsOneWidget);
    expect(
      find.descendant(
        of: byIdentifier(VoiceIds.modeNotice),
        matching: find.text('Voice stopped. Try again.'),
      ),
      findsOneWidget,
    );
  });

  testWidgets('a notice borrows the stage without ending the call', (
    tester,
  ) async {
    final socket = FakeVoiceSocket();
    final controller = await live(tester, socket);
    await mountSurface(tester, controller, width: 390);
    expect(controller.active, isTrue);

    // No code: one reply failed, the call carries on.
    socket.deliver(jsonEncode({'type': 'error', 'message': 'no text'}));
    await tester.pump();
    await tester.pump();

    expect(controller.active, isTrue);
    expect(find.text('Listening'), findsOneWidget);
    expect(
      find.descendant(
        of: byIdentifier(VoiceIds.modeNotice),
        matching: find.text('That reply didn’t come through. Say it again.'),
      ),
      findsOneWidget,
    );

    // A borrow, not a takeover: the line goes when its time is up, and the
    // call is left saying what it was saying.
    await tester.pump(AssistantSessionController.noticeDuration);
    await tester.pump();
    expect(byIdentifier(VoiceIds.modeNotice), findsNothing);
    expect(find.text('Listening'), findsOneWidget);
  });

  testWidgets('a call the server closed first says it ended, not Listening', (
    tester,
  ) async {
    final socket = FakeVoiceSocket();
    final controller = await live(tester, socket);
    await mountSurface(tester, controller, width: 390);
    expect(find.text('Listening'), findsOneWidget);

    // The socket's end going away with no error frame: the client already
    // knows the call is over, so the surface must stop claiming it is live —
    // without framing a call that failed at nothing as a failure.
    unawaited(socket.finish());
    await tester.runAsync(() => settle());
    await tester.pump();
    await tester.pump();

    expect(controller.active, isFalse);
    expect(controller.error, isNull);
    expect(find.text('Listening'), findsNothing);
    expect(find.text('Call failed'), findsNothing);
    expect(find.text('Call ended'), findsOneWidget);
    expect(
      find.descendant(
        of: byIdentifier(VoiceIds.modeNotice),
        matching: find.text('The call ended.'),
      ),
      findsOneWidget,
    );
  });

  testWidgets('a live call that has never heard the microphone says so once', (
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
    await tester.pump();
    await tester.pump();
    await mountSurface(tester, controller, width: 390);

    // The microphone is open and every frame is zeros: the call is live and
    // the device has carried nothing at all — not even a room. The frames are
    // the clock, so the window is run out in frames rather than in
    // waited-for seconds.
    var at = 0;
    void nothing(int ms) {
      for (var elapsed = 0; elapsed < ms; elapsed += 40) {
        capture.emit(AudioFrame(pcmFrame(0), 0, at));
        at += 40;
      }
    }

    nothing(voiceAssistantDeafNoticeAfterV1.inMilliseconds ~/ 2);
    await tester.runAsync(() => settle());
    await tester.pump();
    expect(controller.notice, isNull);
    nothing(voiceAssistantDeafNoticeAfterV1.inMilliseconds ~/ 2 + 40);
    await tester.runAsync(() => settle());
    await tester.pump();
    await tester.pump();

    expect(
      find.descendant(
        of: byIdentifier(VoiceIds.modeNotice),
        matching: find.text(
          'FrockBot isn’t hearing anything. Check the microphone in your device settings.',
        ),
      ),
      findsOneWidget,
    );
    // A notice, not an error: the call is fine, the microphone is the
    // problem, and the call goes on saying it is listening.
    expect(controller.error, isNull);
    expect(controller.active, isTrue);
    expect(find.text('Listening'), findsOneWidget);

    // Once: when the notice's four seconds are up, another window of the same
    // nothing says nothing more.
    await tester.pump(AssistantSessionController.noticeDuration);
    await tester.pump();
    expect(byIdentifier(VoiceIds.modeNotice), findsNothing);
    nothing(voiceAssistantDeafNoticeAfterV1.inMilliseconds + 40);
    await tester.runAsync(() => settle());
    await tester.pump();
    await tester.pump();
    expect(controller.notice, isNull);
    expect(byIdentifier(VoiceIds.modeNotice), findsNothing);
  });

  testWidgets('a call that has heard the microphone is never called deaf', (
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
    await tester.pump();
    await tester.pump();

    // Heard once, then silence: somebody who stopped talking on a working
    // microphone is not a microphone nobody can hear.
    var at = 0;
    capture.emit(AudioFrame(pcmFrame(0.05), 0.05, at));
    at += 40;
    for (
      var elapsed = 0;
      elapsed < voiceAssistantDeafNoticeAfterV1.inMilliseconds + 40;
      elapsed += 40
    ) {
      capture.emit(AudioFrame(pcmFrame(0), 0, at));
      at += 40;
    }
    await tester.runAsync(() => settle());
    await tester.pump();
    expect(controller.notice, isNull);
  });

  testWidgets('a delegation becomes a chip, and finishing offers the Work', (
    tester,
  ) async {
    final socket = FakeVoiceSocket();
    final controller = await live(tester, socket);
    final opened = <(String, String)>[];
    await mountSurface(
      tester,
      controller,
      width: 390,
      onOpenWork: (botId, runId) => opened.add((botId, runId)),
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
    expect(byIdentifier(VoiceIds.chip('run-scout')), findsOneWidget);
    expect(find.text('Scout'), findsOneWidget);
    expect(find.text('Working'), findsOneWidget);
    expect(find.text('Work'), findsNothing);

    socket.deliver(delegation('scout', 'Scout', 'answering'));
    await tester.pump();
    await tester.pump();
    // Still one chip: the ledger is per Turn, not per frame.
    expect(byIdentifier(VoiceIds.chip('run-scout')), findsOneWidget);
    expect(find.text('Working'), findsOneWidget);

    socket.deliver(delegation('scout', 'Scout', 'finished'));
    await tester.pump();
    await tester.pump();
    expect(find.text('Working'), findsNothing);
    expect(find.byIcon(Icons.check_rounded), findsOneWidget);
    await tester.tap(find.text('Work'));
    await tester.pump();
    expect(opened, [('scout', 'run-scout')]);
    await tester.pump(const Duration(milliseconds: 1300));
  });

  testWidgets('two hand-offs on one Bot are two chips, not one', (
    tester,
  ) async {
    final socket = FakeVoiceSocket();
    final controller = await live(tester, socket);
    final opened = <(String, String)>[];
    await mountSurface(
      tester,
      controller,
      width: 390,
      onOpenWork: (botId, runId) => opened.add((botId, runId)),
    );

    // One turn hands two tasks to the call's own Bot: two Turns, two chips.
    socket.deliver(delegation('scout', 'Scout', 'asked', runId: 'run-one'));
    socket.deliver(delegation('scout', 'Scout', 'asked', runId: 'run-two'));
    await tester.pump();
    await tester.pump();
    expect(byIdentifier(VoiceIds.chip('run-one')), findsOneWidget);
    expect(byIdentifier(VoiceIds.chip('run-two')), findsOneWidget);

    // Each chip opens its own Turn.
    socket.deliver(delegation('scout', 'Scout', 'finished', runId: 'run-two'));
    await tester.pump();
    await tester.pump();
    await tester.tap(
      find.descendant(
        of: byIdentifier(VoiceIds.chip('run-two')),
        matching: find.text('Work'),
      ),
    );
    await tester.pump();
    expect(opened, [('scout', 'run-two')]);
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
    expect(byIdentifier(VoiceIds.chip('run-scout')), findsOneWidget);
    expect(byIdentifier(VoiceIds.chip('run-archie')), findsOneWidget);

    socket.sent.clear();
    await tester.tap(
      find.bySemanticsLabel('Resume the call, 2 finished while paused'),
    );
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

  testWidgets('a choice made mid-sentence keeps the sentence', (tester) async {
    final commands = <Map<String, Object?>>[];
    final state = BotSettingsController(
      api(
        MemoryStore(),
        commands,
        bot: {
          ...botSettings(),
          'voice': {
            'schemaVersion': 1,
            'voiceName': 'Sulafat',
            'delivery': {'pace': 'natural'},
          },
        },
      ),
      'alpha',
    );
    addTearDown(state.dispose);
    tester.view.physicalSize = const Size(390, 2200);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await state.load();
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: BotVoicePage(controller: state, characterId: 'dog'),
      ),
    );
    await tester.pumpAndSettle();

    await tester.enterText(
      find.byType(TextFormField),
      'Talk like a ship captain.',
    );
    await tester.pump();
    await tester.ensureVisible(find.text('Faster'));
    await tester.tap(find.text('Faster'));
    await tester.pumpAndSettle();

    final delivery = (commands.single['voice']! as Map)['delivery']! as Map;
    expect(delivery['pace'], 'faster');
    expect(delivery['custom'], 'Talk like a ship captain.');
  });

  test(
    'a voice choice made while a save is in flight is not dropped',
    () async {
      final commands = <Map<String, Object?>>[];
      final gates = <Completer<void>>[];
      final state = BotSettingsController(
        SettingsApi(MemoryStore(), (path, body) async {
          if (body == null) {
            if (path.startsWith('/api/settings')) return account();
            return {
              ...botSettings(),
              'voice': {
                'schemaVersion': 1,
                'voiceName': 'Sulafat',
                'delivery': <String, Object?>{},
              },
            };
          }
          commands.add(Map<String, Object?>.from(body as Map));
          final gate = Completer<void>();
          gates.add(gate);
          await gate.future;
          return {
            'schemaVersion': 1,
            'commandId': body['commandId'],
            'status': 'applied',
          };
        }),
        'alpha',
      );
      addTearDown(state.dispose);
      await state.load();

      final base = state.voice!;
      final faster = base.copyWith(
        delivery: base.delivery.copyWith(pace: 'faster'),
      );
      final dry = faster.copyWith(
        delivery: faster.delivery.copyWith(humour: 'dry'),
      );
      final first = state.saveVoice(faster);
      final second = state.saveVoice(dry);
      await pumpEventQueue();
      expect(gates.length, 1);
      gates.first.complete();
      await pumpEventQueue();
      expect(gates.length, 2);
      gates.last.complete();

      expect(await first, isTrue);
      expect(await second, isTrue);
      expect(
        (commands[1]['voice']! as Map)['delivery'],
        containsPair('humour', 'dry'),
      );
      expect(state.voice!.delivery.humour, 'dry');
    },
  );

  test('the Dart voice tables mirror the TypeScript ones', () {
    expect(geminiVoicesV1.length, 30);
    expect(voiceAccentsV1.length, 11);
    expect(voiceAttitudesV1.length, 12);
    expect(defaultGeminiVoiceForCharacterV1('cat'), 'Despina');
    expect(defaultGeminiVoiceForCharacterV1('unknown-character'), 'Schedar');
    expect(voiceCustomMaxCharsV1, 500);
  });
}
