import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/shell/composer.dart';
import 'package:frockbot_native/theme/frock_theme.dart';
import 'package:frockbot_native/voice/dictation.dart';
import 'package:frockbot_native/voice/motion.dart';
import 'package:frockbot_native/voice/waveform.dart';

void main() {
  test(
    'speech attacks smoothly and releases more gently at any refresh rate',
    () {
      final slow = VoiceEnvelope();
      final fast = VoiceEnvelope();
      slow.advance(1, 1 / 60);
      expect(slow.value, inExclusiveRange(0, 0.3));
      for (var i = 1; i < 30; i++) {
        slow.advance(1, 1 / 60);
      }
      for (var i = 0; i < 60; i++) {
        fast.advance(1, 1 / 120);
      }
      expect(slow.value, closeTo(fast.value, 0.00001));
      expect(slow.value, greaterThan(0.99));
      slow.advance(0, 1 / 60);
      expect(slow.value, greaterThan(0.9));
      for (var i = 0; i < 120; i++) {
        slow.advance(0, 1 / 60);
      }
      expect(slow.value, 0);
      for (final invalid in [double.nan, double.infinity, -1.0, 0.01]) {
        expect(VoiceEnvelope.target(invalid), 0);
      }
      expect(VoiceEnvelope.target(100), 1);
    },
  );

  testWidgets(
    'panel enters, reverses mid-flight and removes outgoing controls',
    (tester) async {
      var visible = false;
      var taps = 0;
      late StateSetter update;
      await tester.pumpWidget(
        MaterialApp(
          home: StatefulBuilder(
            builder: (context, setState) {
              update = setState;
              return Column(
                children: [
                  const Expanded(child: SizedBox()),
                  VoiceReveal(
                    visible: visible,
                    child: SizedBox(
                      height: 100,
                      child: TextButton(
                        onPressed: () => taps++,
                        child: const Text('End call'),
                      ),
                    ),
                  ),
                ],
              );
            },
          ),
        ),
      );
      expect(find.text('End call'), findsNothing);
      update(() => visible = true);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 120));
      final entering = tester.getSize(find.byType(VoiceReveal)).height;
      expect(entering, inExclusiveRange(0, 100));
      update(() => visible = false);
      await tester.pump();
      final leaving = tester.getSize(find.byType(VoiceReveal)).height;
      expect(leaving, closeTo(entering, 0.01));
      await tester.tap(find.text('End call'), warnIfMissed: false);
      expect(taps, 0);
      await tester.pumpAndSettle();
      expect(find.text('End call'), findsNothing);
      update(() => visible = true);
      await tester.pumpAndSettle();
      expect(tester.getSize(find.byType(VoiceReveal)).height, 100);
      await tester.tap(find.text('End call'));
      expect(taps, 1);
    },
  );

  testWidgets('an outgoing panel survives its owner clearing the child', (
    tester,
  ) async {
    var visible = true;
    late StateSetter update;
    await tester.pumpWidget(
      MaterialApp(
        home: StatefulBuilder(
          builder: (context, setState) {
            update = setState;
            return Align(
              alignment: Alignment.bottomCenter,
              child: VoiceReveal(
                visible: visible,
                child: visible
                    ? const SizedBox(height: 84, child: Text('Call'))
                    : const SizedBox.shrink(),
              ),
            );
          },
        ),
      ),
    );
    await tester.pumpAndSettle();
    update(() => visible = false);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.text('Call'), findsOneWidget);
    expect(
      tester.getSize(find.byType(VoiceReveal)).height,
      inExclusiveRange(0, 84),
    );
    await tester.pumpAndSettle();
    expect(find.text('Call'), findsNothing);
    update(() => visible = true);
    await tester.pumpAndSettle();
    expect(find.text('Call'), findsOneWidget);
  });

  testWidgets('closing transfers the system inset without a layout jump', (
    tester,
  ) async {
    var visible = true;
    var exiting = false;
    late StateSetter update;
    const bodyKey = ValueKey('body');
    await tester.pumpWidget(
      MaterialApp(
        home: StatefulBuilder(
          builder: (context, setState) {
            update = setState;
            return Column(
              children: [
                Expanded(
                  child: Padding(
                    padding: EdgeInsets.only(
                      bottom: visible || exiting ? 0 : 48,
                    ),
                    child: const SizedBox.expand(key: bodyKey),
                  ),
                ),
                VoiceReveal(
                  visible: visible,
                  bottomInset: visible || exiting ? 48 : 0,
                  onHidden: () => update(() => exiting = false),
                  child: const SizedBox(height: 132),
                ),
              ],
            );
          },
        ),
      ),
    );
    await tester.pumpAndSettle();
    final openBottom = tester.getBottomLeft(find.byKey(bodyKey)).dy;
    update(() {
      visible = false;
      exiting = true;
    });
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 239));
    final almostClosed = tester.getBottomLeft(find.byKey(bodyKey)).dy;
    await tester.pumpAndSettle();
    final closed = tester.getBottomLeft(find.byKey(bodyKey)).dy;
    expect(closed - openBottom, closeTo(84, 0.01));
    expect(closed, closeTo(almostClosed, 0.1));
    expect(exiting, isFalse);
  });

  testWidgets(
    'reduced motion reveals immediately and leaves no wave ticker running',
    (tester) async {
      final level = ValueNotifier(0.4);
      addTearDown(level.dispose);
      var visible = true;
      late StateSetter update;
      await tester.pumpWidget(
        MaterialApp(
          home: MediaQuery(
            data: const MediaQueryData(disableAnimations: true),
            child: StatefulBuilder(
              builder: (context, setState) {
                update = setState;
                return Align(
                  alignment: Alignment.bottomCenter,
                  child: VoiceReveal(
                    visible: visible,
                    child: SizedBox(
                      width: 300,
                      height: 84,
                      child: VoiceWaveform(
                        source: level,
                        microphone: () => level.value,
                      ),
                    ),
                  ),
                );
              },
            ),
          ),
        ),
      );
      expect(tester.getSize(find.byType(VoiceReveal)).height, 84);
      expect(tester.binding.transientCallbackCount, 0);
      level.value = 0.8;
      await tester.pump();
      expect(tester.binding.transientCallbackCount, 0);
      update(() => visible = false);
      await tester.pump();
      expect(find.byType(VoiceWaveform), findsNothing);
      level.value = 0.5;
      await tester.pump();
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'wave ticks through release, rests in silence, and detaches its old source',
    (tester) async {
      final first = ValueNotifier(0.5);
      final second = ValueNotifier(0.0);
      addTearDown(first.dispose);
      addTearDown(second.dispose);
      Future<void> mount(ValueNotifier<double> source) => tester.pumpWidget(
        MaterialApp(
          home: Center(
            child: SizedBox(
              width: 300,
              height: 84,
              child: VoiceWaveform(
                source: source,
                microphone: () => source.value,
              ),
            ),
          ),
        ),
      );
      await mount(first);
      await tester.pump(const Duration(milliseconds: 100));
      expect(tester.binding.transientCallbackCount, greaterThan(0));
      await mount(second);
      for (var i = 0; i < 40; i++) {
        await tester.pump(const Duration(milliseconds: 50));
      }
      expect(tester.binding.transientCallbackCount, 0);
      first.value = 1;
      await tester.pump();
      expect(tester.binding.transientCallbackCount, 0);
      second.value = 0.5;
      await tester.pump();
      expect(tester.binding.transientCallbackCount, greaterThan(0));
      await tester.pumpWidget(const SizedBox());
      second.value = 0.2;
      expect(tester.binding.transientCallbackCount, 0);
      expect(tester.takeException(), isNull);
    },
  );

  for (final width in [320.0, 1280.0]) {
    testWidgets(
      'dictation start, stop, finishing and draft return at width $width',
      (tester) async {
        tester.view.physicalSize = Size(width, 800);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.reset);
        final editor = TextEditingController();
        final focus = FocusNode();
        final level = ValueNotifier(0.0);
        addTearDown(editor.dispose);
        addTearDown(focus.dispose);
        addTearDown(level.dispose);
        var phase = DictationState.idle;
        var stops = 0;
        var sends = 0;
        late StateSetter update;
        await tester.pumpWidget(
          MaterialApp(
            theme: FrockTheme.theme(Brightness.dark),
            home: Scaffold(
              body: StatefulBuilder(
                builder: (context, setState) {
                  update = setState;
                  return Align(
                    alignment: Alignment.bottomCenter,
                    child: Composer(
                      editor: editor,
                      focus: focus,
                      ready: true,
                      stoppable: false,
                      stopping: false,
                      skills: null,
                      onSend: () async => sends++,
                      onStop: () async {},
                      onChanged: (_) {},
                      onDictate: () =>
                          update(() => phase = DictationState.starting),
                      onStopDictation: () => update(() {
                        stops++;
                        phase = DictationState.stopping;
                      }),
                      dictationState: phase,
                      dictationLevel: level,
                    ),
                  );
                },
              ),
            ),
          ),
        );
        final initial = tester.getSize(find.byType(Composer)).height;
        await tester.tap(find.byTooltip('Dictate message'));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 120));
        expect(
          tester.getSize(find.byType(Composer)).height,
          greaterThan(initial),
        );
        expect(find.text('Starting…'), findsOneWidget);
        // Stop is usable even before microphone permission completes.
        await tester.tap(find.byTooltip('Stop dictation'));
        await tester.pump(const Duration(milliseconds: 200));
        expect(stops, 1);
        await tester.tap(find.byTooltip('Finishing dictation'));
        expect(stops, 1);
        editor.text = 'A dictated draft';
        focus.requestFocus();
        await tester.pump();
        await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
        expect(sends, 0);
        update(() => phase = DictationState.done);
        await tester.pumpAndSettle();
        expect(tester.getSize(find.byType(Composer)).height, initial);
        expect(editor.text, 'A dictated draft');
        expect(find.byTooltip('Stop dictation'), findsNothing);
        await tester.tap(find.byTooltip('Send'));
        expect(sends, 1);
        expect(tester.takeException(), isNull);
      },
    );
  }
}
