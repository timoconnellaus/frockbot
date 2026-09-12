import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/shell/composer.dart';
import 'package:frockbot_native/shell/semantics.dart';
import 'package:frockbot_native/shell/sidebar.dart';
import 'package:frockbot_native/theme/frock_theme.dart';
import 'package:frockbot_native/voice/assistant.dart';
import 'package:frockbot_native/voice/dictation.dart';
import 'package:frockbot_native/voice/motion.dart';
import 'package:frockbot_native/voice/socket.dart';
import 'package:frockbot_native/voice/waveform.dart';

import 'voice_fakes.dart';
import 'voice_shell_harness.dart';

/// A socket whose close does not finish until the test says so: the window
/// where the footer has gone but the call is still tearing down.
class SlowCloseSocket extends FakeVoiceSocket {
  final Completer<void> gate = Completer<void>();

  @override
  Future<void> close({
    int code = voiceCloseNormalV1,
    String reason = '',
  }) async {
    await gate.future;
    await super.close(code: code, reason: reason);
  }
}

/// A socket whose close fails, the way a dead connection's can.
class FailingCloseSocket extends FakeVoiceSocket {
  @override
  Future<void> close({
    int code = voiceCloseNormalV1,
    String reason = '',
  }) async {
    await super.close(code: code, reason: reason);
    throw StateError('socket');
  }
}

/// A socket whose outgoing sink the peer or the OS has already closed, while
/// the stream's `done` has not been delivered yet: sends throw, closing works.
class ClosedSinkSocket extends FakeVoiceSocket {
  @override
  void sendText(String text) => throw StateError('sink');
}

/// The worst device an end can meet: nothing it is asked to do succeeds.
class HostileSocket extends FakeVoiceSocket {
  @override
  void sendText(String text) => throw StateError('sink');

  @override
  Future<void> close({
    int code = voiceCloseNormalV1,
    String reason = '',
  }) async {
    await super.close(code: code, reason: reason);
    throw StateError('socket');
  }
}

/// A recorder that fails to stop and remembers it was asked.
class HostileCapture extends FakeVoiceCapture {
  int stopAttempts = 0;

  @override
  Future<void> stop() {
    stopAttempts++;
    return super.stop();
  }
}

class FailingClosePlayer extends FakeVoicePlayer {
  @override
  Future<void> close() async {
    await super.close();
    throw StateError('speaker');
  }
}

void main() {
  for (final width in [390.0, 1280.0]) {
    for (final brightness in Brightness.values) {
      testWidgets('dictation dock in the real shell: $width $brightness', (
        tester,
      ) async {
        final semantics = tester.ensureSemantics();
        final harness = VoiceShellHarness();
        await harness.mount(tester, width: width, brightness: brightness);
        final safeBottom = width == 390 ? 34.0 : 0.0;
        final conversation = find.byWidgetPredicate(
          (widget) =>
              widget is Semantics &&
              widget.properties.identifier == ShellIds.conversation,
        );
        final chat = tester.getRect(conversation);
        final dock = find.byKey(const ValueKey('dictation-dock'));
        final stop = find.byKey(const ValueKey('dictation-stop'));
        void checkFrame() {
          final rect = tester.getRect(dock);
          expect(rect.left, chat.left);
          expect(rect.right, chat.right);
          expect(rect.bottom, greaterThanOrEqualTo(800));
          final button = tester.getRect(stop);
          expect(button.right, lessThanOrEqualTo(chat.right - 16));
          expect(button.bottom, lessThanOrEqualTo(800 - safeBottom - 16));
          expect(button.top - rect.top, greaterThanOrEqualTo(16));
          expectUnclippedControl(tester, stop);
          expect(tester.takeException(), isNull);
        }

        harness.dictationCapture.permission = Completer<void>();
        unawaited(harness.dictation.start('voice-bot'));
        await tester.pump();
        for (var frame = 0; frame < 24; frame++) {
          await tester.pump(const Duration(milliseconds: 16));
          checkFrame();
          expect(find.byType(TextField), findsNothing);
          expect(
            find.descendant(of: dock, matching: find.byType(Text)),
            findsNothing,
          );
        }
        final starting = tester.getSemantics(
          find.bySemanticsLabel('Starting dictation'),
        );
        expect(starting.flagsCollection.isLiveRegion, isTrue);
        harness.dictationCapture.permission!.complete();
        await tester.pump();
        harness.dictationSocket.deliver('{"schemaVersion":1,"type":"ready"}');
        await tester.pump();
        expect(
          find.bySemanticsLabel('Listening for dictation'),
          findsOneWidget,
        );
        harness.dictation.level.value = 0.6;
        await tester.pump(const Duration(milliseconds: 100));
        await tester.tap(stop);
        await tester.pump();
        expect(harness.dictation.state, DictationState.stopping);
        expect(tester.widget<IconButton>(stop).onPressed, isNull);
        expect(find.bySemanticsLabel('Finishing dictation'), findsWidgets);
        harness.dictationSocket.deliver(
          '{"schemaVersion":1,"type":"segment","text":"Keep this editable"}',
        );
        harness.dictationSocket.deliver('{"schemaVersion":1,"type":"final"}');
        await tester.runAsync(() => settle());
        await tester.pump();
        for (var frame = 0; frame < 14; frame++) {
          await tester.pump(const Duration(milliseconds: 16));
          checkFrame();
        }
        final before = tester.getBottomLeft(find.byType(Composer)).dy;
        await tester.pump(const Duration(milliseconds: 32));
        expect(tester.getBottomLeft(find.byType(Composer)).dy, before);
        expect(dock, findsNothing);
        final field = find.byType(TextField);
        expect(
          tester.widget<TextField>(field).controller!.text,
          'Keep this editable',
        );
        await tester.enterText(field, 'Keep this editable, with a correction');
        await tester.pump();
        expect(
          harness.sessions.open('voice-user', 'voice-bot').controller.draft,
          'Keep this editable, with a correction',
        );
        expect(
          harness.sessions.open('voice-user', 'voice-bot').controller.pending,
          isEmpty,
        );

        // Stop during entry, then enable reduced motion during the exit.
        await harness.dictation.start('voice-bot');
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 64));
        checkFrame();
        unawaited(harness.dictation.stop());
        harness.dictationSocket.deliver('{"schemaVersion":1,"type":"final"}');
        await tester.runAsync(() => settle());
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 32));
        checkFrame();
        // Reduced motion changed during exit completes in this one frame.
        harness.reducedMotion.value = true;
        await tester.pump();
        expect(dock, findsNothing);
        await harness.dictation.start('voice-bot');
        await tester.pump();
        checkFrame();
        expect(tester.getRect(dock).height, 96 + safeBottom);
        await tester.pump(const Duration(milliseconds: 300));
        final restingTickers = tester.binding.transientCallbackCount;
        harness.dictation.level.value = 0.8;
        await tester.pump();
        expect(
          tester.binding.transientCallbackCount,
          lessThanOrEqualTo(restingTickers),
        );
        await harness.dispose(tester);
        semantics.dispose();
      });
    }
  }

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
          tester.getSize(find.byKey(const ValueKey('dictation-stop'))),
          const Size(48, 48),
        );
        expect(find.bySemanticsLabel('Starting dictation'), findsOneWidget);
        expect(find.byType(TextField), findsNothing);
        expect(find.byType(Text), findsNothing);
        // Stop is usable even before microphone permission completes.
        await tester.tap(find.byTooltip('Stop dictation'));
        await tester.pump(const Duration(milliseconds: 200));
        expect(stops, 1);
        await tester.tap(find.byTooltip('Finishing dictation'));
        expect(stops, 1);
        // One line at 320 in the test font, where every glyph is a full em:
        // the height check below is about the dock leaving without a jump,
        // and a draft that wraps would make the composer taller for its own
        // reasons.
        editor.text = 'Dictated';
        focus.requestFocus();
        await tester.pump();
        await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
        expect(sends, 0);
        update(() => phase = DictationState.done);
        await tester.pumpAndSettle();
        expect(tester.getSize(find.byType(Composer)).height, initial);
        expect(editor.text, 'Dictated');
        expect(find.byTooltip('Stop dictation'), findsNothing);
        await tester.tap(find.byTooltip('Send'));
        expect(sends, 1);
        expect(tester.takeException(), isNull);
      },
    );
  }

  test('a call is still active while its teardown is in flight', () async {
    final socket = SlowCloseSocket();
    final controller = AssistantSessionController(
      openSocket: () async => socket,
      capture: FakeVoiceCapture(),
      player: FakeVoicePlayer(),
    );
    addTearDown(controller.dispose);
    await controller.start();
    expect(
      voiceControlStateV1(footerOpen: true, sessionActive: controller.active),
      VoiceControlState.active,
    );

    // End takes the footer away at once; the socket is still closing.
    final ending = controller.end(reason: 'test');
    await settle();
    expect(controller.phase, VoiceSessionPhase.ending);
    expect(
      voiceControlStateV1(footerOpen: false, sessionActive: controller.active),
      VoiceControlState.ending,
    );

    socket.gate.complete();
    await ending;
    expect(
      voiceControlStateV1(footerOpen: false, sessionActive: controller.active),
      VoiceControlState.idle,
    );
  });

  test(
    'a failing recorder or socket still ends the call and frees the control',
    () async {
      final capture = FakeVoiceCapture()..stopFailure = StateError('recorder');
      final socket = FailingCloseSocket();
      final controller = AssistantSessionController(
        openSocket: () async => socket,
        capture: capture,
        player: FakeVoicePlayer(),
      );
      await controller.start();
      await settle();

      await controller.end(reason: 'end-button');
      expect(controller.phase, VoiceSessionPhase.ended);
      expect(
        voiceControlStateV1(
          footerOpen: false,
          sessionActive: controller.active,
        ),
        VoiceControlState.idle,
      );
      expect(socket.closeReason, 'end-button');
      controller.dispose();
      await settle();
    },
    timeout: const Timeout(Duration(seconds: 10)),
  );

  test('a goodbye frame that cannot be sent still ends the call and frees the '
      'microphone', () async {
    final capture = FakeVoiceCapture();
    final socket = ClosedSinkSocket();
    final controller = AssistantSessionController(
      openSocket: () async => socket,
      capture: capture,
      player: FakeVoicePlayer(),
    );
    await controller.start();
    await settle();
    expect(capture.starts, 1);

    await controller.end(reason: 'lifecycle:paused');
    expect(controller.phase, VoiceSessionPhase.ended);
    expect(controller.active, isFalse);
    expect(
      voiceControlStateV1(footerOpen: false, sessionActive: controller.active),
      VoiceControlState.idle,
    );
    expect(capture.stops, 1);
    expect(socket.closed, isTrue);
    expect(socket.closeReason, 'lifecycle:paused');
    controller.dispose();
    await settle();
  }, timeout: const Timeout(Duration(seconds: 10)));

  test('an end whose every device step fails still frees the control and the '
      'microphone', () async {
    final capture = HostileCapture()..stopFailure = StateError('recorder');
    final socket = HostileSocket();
    final player = FailingClosePlayer();
    final controller = AssistantSessionController(
      openSocket: () async => socket,
      capture: capture,
      player: player,
    );
    await controller.start();
    await settle();
    expect(capture.starts, 1);

    await controller.end(reason: 'end-button');

    expect(controller.phase, VoiceSessionPhase.ended);
    expect(controller.active, isFalse);
    expect(
      voiceControlStateV1(footerOpen: false, sessionActive: controller.active),
      VoiceControlState.idle,
    );
    expect(capture.stopAttempts, greaterThan(0));
    expect(player.closed, isTrue);
    expect(socket.closed, isTrue);
    expect(socket.closeReason, 'end-button');
    controller.dispose();
    await settle();
  }, timeout: const Timeout(Duration(seconds: 10)));

  testWidgets(
    'a draft that arrived since the last frame still sends on Cmd+Enter',
    (tester) async {
      final editor = TextEditingController();
      final focus = FocusNode();
      addTearDown(editor.dispose);
      addTearDown(focus.dispose);
      var sends = 0;
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: Scaffold(
            body: Align(
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
                dictationState: DictationState.idle,
              ),
            ),
          ),
        ),
      );
      focus.requestFocus();
      await tester.pump();

      // A paste or a last keystroke lands in the editor; the shortcut fires
      // inside the same vsync, before any rebuild has seen the new draft.
      editor.text = 'Ship it';
      await tester.sendKeyDownEvent(LogicalKeyboardKey.metaLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft);
      expect(sends, 1);

      // An emptied draft is still refused by the same one guard.
      editor.text = '   ';
      await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
      expect(sends, 1);

      // A visible Send button uses the same live guard as the shortcuts.
      editor.text = 'Ready to send';
      await tester.pump();
      editor.clear();
      await tester.tap(find.byTooltip('Send'));
      expect(sends, 1);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'the voice control cannot invite a start while a call is ending',
    (tester) async {
      var starts = 0;
      Future<void> show(VoiceControlState state) => tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: Scaffold(
            body: ShellSidebar(
              bots: const [],
              profiles: const {},
              unread: const {},
              archived: const {},
              activeBotId: null,
              focusedBotId: null,
              workingBotId: null,
              loaded: true,
              showHidden: false,
              onSelect: (_) {},
              onCreateBot: () {},
              onSearch: () {},
              onProfile: () {},
              onMarketplace: () {},
              onVoice: () => starts++,
              voiceControl: state,
              onToggleHidden: () {},
              onRetry: () async {},
            ),
          ),
        ),
      );

      await show(VoiceControlState.ending);
      final button = find.byTooltip('Ending voice session…');
      expect(button, findsOneWidget);
      expect(
        tester
            .widget<IconButton>(
              find.ancestor(of: button, matching: find.byType(IconButton)),
            )
            .onPressed,
        isNull,
      );
      await tester.tap(button, warnIfMissed: false);
      await tester.pump();
      expect(starts, 0);

      await show(VoiceControlState.idle);
      await tester.tap(find.byTooltip('Start voice session'));
      await tester.pump();
      expect(starts, 1);
    },
  );
}
