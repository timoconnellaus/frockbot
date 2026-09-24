/// The microphone as a Plugin's page gets it: through the host, only when the
/// User approved it, never over voice, and always with a way to stop it.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/panels/page_microphone.dart';
import 'package:frockbot_native/panels/plugin_page.dart';
import 'package:frockbot_native/voice/capture.dart';
import 'package:frockbot_native/voice/mic_ownership.dart';

import 'voice_fakes.dart';

/// A microphone the test opens, feeds and takes away.
class FakePageMicrophone implements PluginPageMicrophone {
  StreamController<Uint8List>? frames;
  Future<void> Function()? taken;
  PluginPageMicrophoneRefused? refusal;
  int opens = 0;
  int closes = 0;

  @override
  Future<Stream<Uint8List>> open({
    required Future<void> Function() taken,
  }) async {
    opens++;
    final refused = refusal;
    if (refused != null) throw refused;
    this.taken = taken;
    frames = StreamController<Uint8List>.broadcast();
    return frames!.stream;
  }

  @override
  Future<void> close() async {
    closes++;
    await frames?.close();
  }
}

void main() {
  group('who holds the microphone', () {
    test('a page gets it only when nobody holds it', () async {
      final ownership = MicOwnership();
      expect(ownership.acquireForPage(() async {}), isTrue);
      expect(ownership.owner, MicOwner.page);
      expect(ownership.acquireForPage(() async {}), isFalse);
      ownership.releasePage();
      expect(ownership.owner, MicOwner.none);
      await ownership.acquireForDictation();
      expect(ownership.acquireForPage(() async {}), isFalse);
    });

    test('dictation and a call each take it from a page', () async {
      for (final take in <Future<void> Function(MicOwnership)>[
        (ownership) => ownership.acquireForDictation(),
        (ownership) => ownership.acquireForAssistant(),
      ]) {
        final ownership = MicOwnership();
        var stopped = 0;
        ownership.acquireForPage(() async {
          stopped++;
          ownership.releasePage();
        });
        await take(ownership);
        expect(stopped, 1);
        expect(ownership.owner, isNot(MicOwner.page));
      }
    });
  });

  group('the shell lends its capture', () {
    test('unprocessed, at the page rate, and gives it back', () async {
      final ownership = MicOwnership();
      final capture = FakeVoiceCapture();
      final microphone = ShellPageMicrophone(
        ownership: ownership,
        capture: () => capture,
      );
      final frames = await microphone.open(taken: () async {});
      expect(capture.profile, VoiceCaptureProfile.instrument);
      expect(capture.sampleRate, pluginPageMicrophoneRateV1);
      expect(capture.frame, pluginPageMicrophoneFrameV1);
      final heard = <Uint8List>[];
      final subscription = frames.listen(heard.add);
      capture.emit(AudioFrame(Uint8List.fromList([1, 2]), 0, 0));
      await Future<void>.delayed(Duration.zero);
      expect(heard.single, [1, 2]);
      await subscription.cancel();
      await microphone.close();
      expect(capture.stops, 1);
      expect(ownership.owner, MicOwner.none);
    });

    test('refuses while voice holds it, and says the device refused', () async {
      final ownership = MicOwnership();
      await ownership.acquireForDictation();
      final microphone = ShellPageMicrophone(
        ownership: ownership,
        capture: FakeVoiceCapture.new,
      );
      await expectLater(
        microphone.open(taken: () async {}),
        throwsA(isA<PluginPageMicrophoneRefused>()),
      );
      final denied = MicOwnership();
      final capture = FakeVoiceCapture()
        ..failure = const MicrophoneDenied('No.');
      await expectLater(
        ShellPageMicrophone(
          ownership: denied,
          capture: () => capture,
        ).open(taken: () async {}),
        throwsA(
          isA<PluginPageMicrophoneRefused>().having(
            (refused) => refused.reason,
            'reason',
            'No.',
          ),
        ),
      );
      expect(denied.owner, MicOwner.none);
    });
  });

  group('PluginPageFrame and the microphone', () {
    late ValueChanged<Map<String, Object?>> say;
    late List<Map<String, Object?>> heard;

    Widget frame(
      FakePageMicrophone microphone, {
      List<String> abilities = const ['microphone'],
    }) => MaterialApp(
      home: Scaffold(
        body: PluginPageFrame(
          url: 'https://bot.example/plugin-pages/a.html',
          state: const {},
          pluginId: 'tuner',
          botId: 'bot-1',
          surfaceId: 'tuner',
          label: 'Tuner',
          runTool: (tool, arguments) async =>
              const PluginPageToolAnswerV1.ran('ok'),
          abilities: abilities,
          microphone: microphone,
          frameBuilder:
              (
                context, {
                required url,
                required label,
                required identity,
                required onMessage,
                required outbox,
              }) {
                say = onMessage;
                return _Listening(outbox: outbox, heard: heard);
              },
        ),
      ),
    );

    const ask = {
      'frockbotPage': 1,
      'type': 'device',
      'ability': 'microphone',
      'open': true,
    };

    setUp(() => heard = []);

    testWidgets('streams what it hears, under a sign with a Stop', (
      tester,
    ) async {
      final microphone = FakePageMicrophone();
      framesMounted = 0;
      await tester.pumpWidget(frame(microphone));
      expect(find.text('Tuner is using the microphone'), findsNothing);
      say(ask);
      await tester.pumpAndSettle();
      expect(heard.single, {
        'frockbotPage': 1,
        'type': 'device',
        'ability': 'microphone',
        'status': 'open',
        'sampleRate': 16000,
      });
      expect(find.text('Tuner is using the microphone'), findsOneWidget);

      microphone.frames!.add(Uint8List.fromList([0, 0x40]));
      await tester.pump();
      expect(heard.last, {
        'frockbotPage': 1,
        'type': 'audio',
        'pcm': base64Encode([0, 0x40]),
      });

      await tester.tap(find.text('Stop'));
      await tester.pumpAndSettle();
      expect(microphone.closes, 1);
      expect(heard.last['status'], 'closed');
      expect(heard.last['reason'], 'You stopped the microphone.');
      expect(find.text('Tuner is using the microphone'), findsNothing);
      // The bar came and went around one page, never a reloaded one.
      expect(framesMounted, 1);
    });

    testWidgets('opens nothing the User did not approve', (tester) async {
      final microphone = FakePageMicrophone();
      await tester.pumpWidget(frame(microphone, abilities: const []));
      say(ask);
      await tester.pumpAndSettle();
      expect(microphone.opens, 0);
      expect(heard.single['status'], 'closed');
      expect(
        heard.single['reason'],
        'This Plugin was not allowed the microphone.',
      );
    });

    testWidgets('tells the page why when it is refused or taken', (
      tester,
    ) async {
      final refused = FakePageMicrophone()
        ..refusal = const PluginPageMicrophoneRefused(
          'The microphone is in use by voice or dictation.',
        );
      await tester.pumpWidget(frame(refused));
      say(ask);
      await tester.pumpAndSettle();
      expect(
        heard.single['reason'],
        'The microphone is in use by voice or dictation.',
      );

      heard.clear();
      final taken = FakePageMicrophone();
      await tester.pumpWidget(frame(taken));
      say(ask);
      await tester.pumpAndSettle();
      await taken.taken!();
      await tester.pumpAndSettle();
      expect(heard.last['reason'], 'Voice took the microphone.');
      expect(taken.closes, 1);
    });

    testWidgets('closes when the app goes away or the page leaves', (
      tester,
    ) async {
      final microphone = FakePageMicrophone();
      await tester.pumpWidget(frame(microphone));
      say(ask);
      await tester.pumpAndSettle();
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      await tester.pumpAndSettle();
      expect(microphone.closes, 1);
      expect(heard.last['reason'], 'FrockBot went to the background.');
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);

      say(ask);
      await tester.pumpAndSettle();
      await tester.pumpWidget(const MaterialApp(home: SizedBox()));
      await tester.pumpAndSettle();
      expect(microphone.closes, 2);
    });
  });
}

/// Stands in for the host frame: records what the host posts to the page.
class _Listening extends StatefulWidget {
  final Stream<Map<String, Object?>> outbox;
  final List<Map<String, Object?>> heard;
  const _Listening({required this.outbox, required this.heard});

  @override
  State<_Listening> createState() => _ListeningState();
}

/// How many times a frame was put in place: more than once is a page reload.
int framesMounted = 0;

class _ListeningState extends State<_Listening> {
  StreamSubscription<Map<String, Object?>>? _subscription;

  @override
  void initState() {
    super.initState();
    framesMounted++;
    _subscription = widget.outbox.listen(widget.heard.add);
  }

  @override
  void dispose() {
    unawaited(_subscription?.cancel());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => const SizedBox.expand();
}
