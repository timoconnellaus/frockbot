/// The microphone as a Plugin's page gets it: through the host, only when the
/// User approved it, never over voice, and always with a way to stop it.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/panels/client.dart';
import 'package:frockbot_native/panels/page_microphone.dart';
import 'package:frockbot_native/panels/plugin_page.dart';
import 'package:frockbot_native/voice/capture.dart';
import 'package:frockbot_native/voice/mic_ownership.dart';

import 'voice_fakes.dart';
import 'widget_test.dart' show MemoryStore;

/// A microphone the test opens, feeds and takes away.
class FakePageMicrophone implements PluginPageMicrophone {
  StreamController<Uint8List>? frames;
  Future<void> Function()? taken;
  PluginPageMicrophoneRefused? refusal;
  Completer<void>? granting;
  int opens = 0;
  int closes = 0;

  @override
  Future<Stream<Uint8List>> open({
    required Future<void> Function() taken,
  }) async {
    opens++;
    final refused = refusal;
    if (refused != null) throw refused;
    await granting?.future;
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

  test('a use is reported in the route\'s words, to the millisecond', () async {
    final api = ReportingApi();
    await PanelsApi(api).reportDeviceUse(
      'bot-1',
      pluginId: 'tuner',
      surfaceId: 'tuner',
      device: 'android',
      use: PluginPageDeviceUseV1(
        useId: 'nAbCdEf_1234',
        ability: 'microphone',
        // A native clock's microseconds, which the route does not take.
        startedAt: DateTime.utc(2026, 9, 24, 5, 0, 0, 0, 123),
        endedAt: DateTime.utc(2026, 9, 24, 5, 2, 14, 7, 999),
        ending: PluginPageDeviceEndingV1.taken,
      ),
    );
    expect(api.sent.single.$1, '/api/bots/bot-1/panels/device-use');
    expect(api.sent.single.$2, {
      'schemaVersion': 1,
      'useId': 'nAbCdEf_1234',
      'pluginId': 'tuner',
      'surfaceId': 'tuner',
      'ability': 'microphone',
      'device': 'android',
      'startedAt': '2026-09-24T05:00:00.000Z',
      'endedAt': '2026-09-24T05:02:14.007Z',
      'ending': 'taken',
    });
  });

  group('PluginPageFrame and the microphone', () {
    late ValueChanged<Map<String, Object?>> say;
    late List<Map<String, Object?>> heard;
    late List<PluginPageDeviceUseV1> uses;
    var clock = DateTime.utc(2026, 9, 24, 5);

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
          onDeviceUse: uses.add,
          now: () => clock,
          frameBuilder:
              (
                context, {
                required url,
                required label,
                required identity,
                required onMessage,
                required outbox,
                required onLoaded,
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

    setUp(() {
      heard = [];
      uses = [];
      clock = DateTime.utc(2026, 9, 24, 5);
    });

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

      expect(uses, isEmpty);
      clock = clock.add(const Duration(minutes: 2, seconds: 14));
      await tester.tap(find.text('Stop'));
      await tester.pumpAndSettle();
      expect(microphone.closes, 1);
      expect(heard.last['status'], 'closed');
      expect(heard.last['reason'], 'You stopped the microphone.');
      // One use, for the audit: what, how long, and how it ended.
      expect(uses, hasLength(1));
      expect(uses.single.ability, 'microphone');
      expect(uses.single.ending, PluginPageDeviceEndingV1.stopped);
      expect(
        uses.single.endedAt.difference(uses.single.startedAt),
        const Duration(minutes: 2, seconds: 14),
      );
      expect(uses.single.useId, isNotEmpty);
      expect(find.text('Tuner is using the microphone'), findsNothing);
      // The bar came and went around one page, never a reloaded one.
      expect(framesMounted, 1);
    });

    testWidgets(
      'a page that stops the microphone itself hears that it closed',
      (tester) async {
        final microphone = FakePageMicrophone();
        await tester.pumpWidget(frame(microphone));
        say(ask);
        await tester.pumpAndSettle();
        const stop = {
          'frockbotPage': 1,
          'type': 'device',
          'ability': 'microphone',
          'open': false,
        };
        say(stop);
        await tester.pumpAndSettle();
        expect(microphone.closes, 1);
        expect(heard.last, {
          'frockbotPage': 1,
          'type': 'device',
          'ability': 'microphone',
          'status': 'closed',
          'reason': 'You stopped the microphone.',
        });
        expect(uses.single.ending, PluginPageDeviceEndingV1.stopped);
        expect(find.text('Tuner is using the microphone'), findsNothing);

        // Asked again with nothing open, it still answers, so a page waiting on
        // its close is never left waiting.
        heard.clear();
        say(stop);
        await tester.pumpAndSettle();
        expect(microphone.closes, 1);
        expect(heard.single['status'], 'closed');
      },
    );

    testWidgets(
      'a page that stops while the microphone is opening is never opened to',
      (tester) async {
        final microphone = FakePageMicrophone()..granting = Completer<void>();
        await tester.pumpWidget(frame(microphone));
        const stop = {
          'frockbotPage': 1,
          'type': 'device',
          'ability': 'microphone',
          'open': false,
        };
        say(ask);
        await tester.pump();
        say(stop);
        await tester.pump();
        microphone.granting!.complete();
        await tester.pumpAndSettle();
        expect(microphone.closes, 1);
        expect(heard, isEmpty);
        expect(uses, isEmpty);
        expect(find.text('Tuner is using the microphone'), findsNothing);

        // Asked again, it opens, rather than thinking it already has.
        say(ask);
        await tester.pumpAndSettle();
        expect(microphone.opens, 2);
        expect(heard.single['status'], 'open');
      },
    );

    testWidgets(
      'a page that stops and asks again while opening gets the one open',
      (tester) async {
        final microphone = FakePageMicrophone()..granting = Completer<void>();
        await tester.pumpWidget(frame(microphone));
        say(ask);
        await tester.pump();
        say(const {
          'frockbotPage': 1,
          'type': 'device',
          'ability': 'microphone',
          'open': false,
        });
        say(ask);
        await tester.pump();
        microphone.granting!.complete();
        await tester.pumpAndSettle();
        expect(microphone.opens, 1);
        expect(microphone.closes, 0);
        expect(heard.single['status'], 'open');
        expect(find.text('Tuner is using the microphone'), findsOneWidget);
      },
    );

    testWidgets('opens nothing the User did not approve', (tester) async {
      final microphone = FakePageMicrophone();
      await tester.pumpWidget(frame(microphone, abilities: const []));
      say(ask);
      await tester.pumpAndSettle();
      expect(microphone.opens, 0);
      expect(uses, isEmpty);
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
      // A refusal was never a use; being taken ended one.
      expect(uses.map((use) => use.ending), [PluginPageDeviceEndingV1.taken]);
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
      // A page kept for the panel's return is told it no longer hears.
      expect(heard.last['status'], 'closed');
      expect(heard.last['reason'], 'You left the panel.');
      expect(uses.map((use) => use.ending), [
        PluginPageDeviceEndingV1.background,
        PluginPageDeviceEndingV1.left,
      ]);
      expect(uses.first.useId, isNot(uses.last.useId));
    });
  });
}

/// Records what the client sends, and answers as the route does.
class ReportingApi extends NativeApi {
  final sent = <(String, Object?)>[];
  ReportingApi() : super(MemoryStore());

  @override
  Future<Object?> request(
    String path, {
    Object? body,
    int limit = 512000,
    bool authenticated = true,
  }) async {
    sent.add((path, body));
    return {'status': 'recorded'};
  }
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
