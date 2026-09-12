/// The footer: one height, one stage, two controls, no text.
///
/// The stage is the point of the layout tests. On a phone it is everything
/// beside the controls; on a desktop it stops at its maximum and sits centred
/// on the window, because lobes stretched across a thousand points are not a
/// meter anyone can read. Both are measured.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/voice/assistant.dart';
import 'package:frockbot_native/voice/footer.dart';
import 'package:frockbot_native/voice/waveform.dart';
import 'package:frockbot_native/voice/socket.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'voice_fakes.dart';
import 'voice_shell_harness.dart';

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
  for (final width in [390.0, 1280.0]) {
    for (final brightness in Brightness.values) {
      testWidgets('realtime dock below the actual shell: $width $brightness',
          (tester) async {
        final harness = VoiceShellHarness();
        await harness.mount(tester, width: width, brightness: brightness);
        final safeBottom = width == 390 ? 34.0 : 0.0;
        final composer = find.byKey(const ValueKey('composer'));
        final restingBottom = tester.getBottomLeft(composer).dy;
        await harness.call.start();
        harness.showCall();
        await tester.pump();
        final footer = find.byType(VoiceFooter);
        final end = find.descendant(
            of: footer, matching: find.widgetWithIcon(IconButton, Icons.close));
        void checkFrame() {
          final rect = tester.getRect(footer);
          expect(rect.left, 0);
          expect(rect.width, width);
          expect(rect.bottom, greaterThanOrEqualTo(800));
          final button = tester.getRect(end);
          expect(button.right, lessThanOrEqualTo(width - 16));
          expect(button.bottom, lessThanOrEqualTo(800 - safeBottom - 16));
          expectUnclippedControl(tester, end);
          final stage = tester.getRect(find.byKey(voiceFooterAnimationKey));
          final mute = tester.getRect(find.byTooltip('Mute microphone'));
          expect(stage.right + 16, lessThanOrEqualTo(mute.left));
          expect(find.descendant(of: footer, matching: find.byType(Text)),
              findsNothing);
          expect(tester.takeException(), isNull);
        }
        for (var frame = 0; frame < 24; frame++) {
          await tester.pump(const Duration(milliseconds: 16));
          checkFrame();
        }
        expect(tester.getRect(footer).bottom, 800);
        expect(tester.getRect(footer).height, 96 + safeBottom);
        final dockComposerBottom = tester.getBottomLeft(composer).dy;
        expect(dockComposerBottom, restingBottom - 96);
        await tester.tap(find.byTooltip('End voice session'));
        await tester.runAsync(() => settle());
        await tester.pump();
        for (var frame = 0; frame < 14; frame++) {
          await tester.pump(const Duration(milliseconds: 16));
          checkFrame();
        }
        await tester.pump(const Duration(milliseconds: 15));
        final almostClosed = tester.getBottomLeft(composer).dy;
        await tester.pump(const Duration(milliseconds: 1));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 16));
        expect(footer, findsNothing);
        expect(tester.getBottomLeft(composer).dy, restingBottom);
        expect(restingBottom, closeTo(almostClosed, 0.1));
        expect(harness.callSocket.closed, isTrue);
        expect(harness.player.closed, isTrue);
        expect(harness.shell.voiceSession, isNull);
        await harness.dispose(tester);
      });
    }
  }

  testWidgets(
    'is 96 points tall; on a phone the stage fills what is beside the controls',
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

  testWidgets('a viewport too narrow for the stage lays out without a meter', (
    tester,
  ) async {
    final socket = FakeVoiceSocket();
    final controller = session(socket);
    addTearDown(controller.dispose);
    // Narrower than the inset plus the controls: there is no lane left for
    // the meter, and the footer still lays out.
    await mount(tester, controller, width: 160);

    expect(tester.takeException(), isNull);
    expect(find.byKey(voiceFooterAnimationKey), findsNothing);
    expect(tester.getSize(find.byType(VoiceFooter)).height, voiceFooterHeight);
  });

  testWidgets('the failure stays readable beside its exit control', (
    tester,
  ) async {
    final controller = AssistantSessionController(
      openSocket: () => Future<VoiceSocket>.error(StateError('refused')),
      capture: FakeVoiceCapture(),
      player: FakeVoicePlayer(),
    );
    addTearDown(controller.dispose);
    await mount(tester, controller, width: 390);
    unawaited(controller.start());
    await tester.pump();
    await tester.pump();

    expect(controller.error, isNotNull);
    final text = tester.getRect(find.text(controller.error!));
    final footer = tester.getRect(find.byType(VoiceFooter));
    expect(text.left, greaterThanOrEqualTo(footer.left + 24));
    expect(
      text.right,
      lessThan(tester.getRect(find.byTooltip('End voice session')).left),
    );
    // Mute is gone in the error state; the way out is not.
    expect(find.bySemanticsLabel('Mute microphone'), findsNothing);
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
      material.borderRadius,
      const BorderRadius.vertical(top: Radius.circular(24)),
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
