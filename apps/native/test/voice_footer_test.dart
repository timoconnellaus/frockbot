/// The footer: one height, one stage, two controls, no text.
///
/// The stage is the point of the layout tests. On a phone it is everything
/// beside the controls; on a desktop it stops at its maximum and sits centred
/// on the window, because lobes stretched across a thousand points are not a
/// meter anyone can read. Both are measured.
library;

import 'dart:math' as math;

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
  testWidgets(
    'is 84 points tall; on a phone the stage fills what is beside the controls',
    (tester) async {
      final socket = FakeVoiceSocket();
      final controller = session(socket);
      addTearDown(controller.dispose);
      await mount(tester, controller, width: 390);

      expect(
        tester.getSize(find.byType(VoiceFooter)).height,
        voiceFooterHeight,
      );
      final stage = tester.getRect(find.byKey(voiceFooterAnimationKey));
      expect(stage.left, voiceFooterStageInset);
      expect(
        stage.width,
        390 - voiceFooterStageInset - voiceFooterControlsWidth,
      );
      expect(stage.height, voiceFooterHeight);
      // The stage ends before the controls begin.
      final mute = tester.getRect(find.bySemanticsLabel('Mute microphone'));
      expect(stage.right, lessThanOrEqualTo(mute.left));
    },
  );

  testWidgets('on a desktop the stage stops at its maximum, centred', (
    tester,
  ) async {
    final socket = FakeVoiceSocket();
    final controller = session(socket);
    addTearDown(controller.dispose);
    await mount(tester, controller, width: 1280);

    expect(tester.getSize(find.byType(VoiceFooter)).height, voiceFooterHeight);
    final stage = tester.getRect(find.byKey(voiceFooterAnimationKey));
    expect(stage.width, voiceFooterStageMaxWidth);
    // Centred on the footer itself, not on whatever is left beside the
    // controls.
    final footer = tester.getRect(find.byType(VoiceFooter));
    expect(stage.center.dx, closeTo(footer.center.dx, 0.5));
  });

  testWidgets('the slab is the brand pink, with no top border', (tester) async {
    final socket = FakeVoiceSocket();
    final controller = session(socket);
    addTearDown(controller.dispose);
    await mount(tester, controller, width: 390);

    final material = tester.widget<Material>(
      find
          .descendant(
            of: find.byType(VoiceFooter),
            matching: find.byType(Material),
          )
          .first,
    );
    expect(material.color, FrockTheme.accent);
    expect(
      find.descendant(
        of: find.byType(VoiceFooter),
        matching: find.byType(DecoratedBox),
      ),
      findsNothing,
    );
  });

  test('the meter is only brand pinks: nothing borrowed', () {
    final hue = HSLColor.fromColor(FrockTheme.accent).hue;
    for (final tint in [...voiceLobeTintsPerson, ...voiceLobeTintsBot]) {
      final hsl = HSLColor.fromColor(tint);
      // White and the blushes have no hue to speak of; everything with
      // saturation sits on the accent's hue.
      if (hsl.saturation > 0.2) expect(hsl.hue, closeTo(hue, 12));
    }
  });

  test('a spent lobe is over; a spawned one lives out its life', () {
    final lobes = List.generate(voiceLobeCount, VoiceLobe.spent);
    expect(lobes.every((l) => l.isOver(0)), isTrue);
    final fresh = VoiceLobe.spawn(math.Random(1), 10, 0);
    expect(fresh.isOver(10), isFalse);
    expect(fresh.progress(10), 0);
    expect(fresh.progress(10 + fresh.life), 1);
    expect(fresh.isOver(10 + fresh.life), isTrue);
  });

  testWidgets('covers the bottom system inset in its own colour', (
    tester,
  ) async {
    final socket = FakeVoiceSocket();
    final controller = session(socket);
    addTearDown(controller.dispose);
    tester.view.physicalSize = const Size(390, 800);
    tester.view.devicePixelRatio = 1;
    // An Android gesture bar: 48 points of padding under the app.
    tester.view.padding = const FakeViewPadding(bottom: 48);
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: Column(
          children: [
            const Expanded(child: SizedBox.expand()),
            VoiceFooter(session: controller, onEnd: () {}),
          ],
        ),
      ),
    );
    await tester.pump();

    // The footer grows by the inset; the controls stay above it, so the
    // buttons are not under the app switcher.
    final footer = tester.getRect(find.byType(VoiceFooter));
    expect(footer.height, voiceFooterHeight + 48);
    expect(footer.bottom, 800);
    final end = tester.getRect(find.bySemanticsLabel('End voice session'));
    expect(end.bottom, lessThanOrEqualTo(800 - 48));
    final animation = tester.getRect(find.byKey(voiceFooterAnimationKey));
    expect(animation.bottom, lessThanOrEqualTo(800 - 48));
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
    // is in the slab, the meter and the two controls.
    expect(find.byType(Text), findsNothing);
  });
}
