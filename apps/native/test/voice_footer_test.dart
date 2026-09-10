/// The footer: one height, one animation width, two controls, no text.
///
/// The 140 points are the point of the test. The animation is never compacted
/// for a narrow viewport — the controls are always shown and the animation is
/// the same size on a phone as on a desktop — so it is measured at both.
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/voice/assistant.dart';
import 'package:frockbot_native/voice/footer.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'voice_fakes.dart';

AssistantSessionController session(FakeVoiceSocket socket) =>
    AssistantSessionController(
      openSocket: () async => socket,
      capture: FakeVoiceCapture(),
      player: FakeVoicePlayer(),
    );

Future<void> mount(
  WidgetTester tester,
  AssistantSessionController controller, {
  required double width,
  VoidCallback? onEnd,
  bool footer = true,
}) async {
  tester.view.physicalSize = Size(width, 800);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      theme: FrockTheme.theme(Brightness.dark),
      home: Column(
        children: [
          const Expanded(child: SizedBox.expand()),
          if (footer) VoiceFooter(session: controller, onEnd: onEnd ?? () {}),
        ],
      ),
    ),
  );
  await tester.pump();
}

void main() {
  testWidgets('is 52 points tall, with a 140 point animation on a phone', (
    tester,
  ) async {
    final socket = FakeVoiceSocket();
    final controller = session(socket);
    addTearDown(controller.dispose);
    await mount(tester, controller, width: 390);

    expect(tester.getSize(find.byType(VoiceFooter)).height, voiceFooterHeight);
    expect(
      tester.getSize(find.byKey(voiceFooterAnimationKey)).width,
      voiceFooterAnimationWidth,
    );
  });

  testWidgets('the animation is the same 140 points on a desktop', (
    tester,
  ) async {
    final socket = FakeVoiceSocket();
    final controller = session(socket);
    addTearDown(controller.dispose);
    await mount(tester, controller, width: 1280);

    expect(tester.getSize(find.byType(VoiceFooter)).height, voiceFooterHeight);
    expect(
      tester.getSize(find.byKey(voiceFooterAnimationKey)).width,
      voiceFooterAnimationWidth,
    );
    // Centred on the footer itself, not on whatever is left beside the
    // controls.
    final animation = tester.getRect(find.byKey(voiceFooterAnimationKey));
    final footer = tester.getRect(find.byType(VoiceFooter));
    expect(animation.center.dx, closeTo(footer.center.dx, 0.5));
  });

  testWidgets('the mute toggle says what it does and what it is', (
    tester,
  ) async {
    final socket = FakeVoiceSocket();
    final controller = session(socket);
    addTearDown(controller.dispose);
    await mount(tester, controller, width: 390);

    expect(find.bySemanticsLabel('Mute microphone'), findsOneWidget);
    expect(find.byIcon(Icons.mic), findsWidgets);

    await tester.tap(find.bySemanticsLabel('Mute microphone'));
    await tester.pump();
    expect(controller.muted, isTrue);
    expect(find.bySemanticsLabel('Unmute microphone'), findsOneWidget);
    expect(find.byIcon(Icons.mic_off), findsOneWidget);
  });

  testWidgets('the X ends the session and takes the footer away', (
    tester,
  ) async {
    final socket = FakeVoiceSocket();
    final controller = session(socket);
    addTearDown(controller.dispose);
    var open = true;
    tester.view.physicalSize = const Size(390, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: StatefulBuilder(
          builder: (context, setState) => Column(
            children: [
              const Expanded(child: SizedBox.expand()),
              if (open)
                VoiceFooter(
                  session: controller,
                  onEnd: () => setState(() => open = false),
                ),
            ],
          ),
        ),
      ),
    );
    await tester.pump();

    expect(find.bySemanticsLabel('End voice session'), findsOneWidget);
    await tester.tap(find.bySemanticsLabel('End voice session'));
    await tester.pump();
    expect(find.byType(VoiceFooter), findsNothing);
  });

  testWidgets('says nothing: no status, no transcript, no label', (
    tester,
  ) async {
    final socket = FakeVoiceSocket();
    final controller = session(socket);
    addTearDown(controller.dispose);
    await mount(tester, controller, width: 390);

    // An idle, error-free footer carries no text at all. Everything it means
    // is in the two rows and the two controls.
    expect(find.byType(Text), findsNothing);
  });
}
