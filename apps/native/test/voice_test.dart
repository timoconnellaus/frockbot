import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/ui/frock_tokens.dart';
import 'package:frockbot_native/voice/audio.dart';
import 'package:frockbot_native/voice/controller.dart';
import 'package:frockbot_native/voice/page.dart';
import 'package:frockbot_native/voice/protocol.dart';
import 'package:frockbot_native/voice/session.dart';

/// A session whose frames the test writes, standing in for the Durable Object.
class FakeSession implements VoiceSession {
  final _frames = StreamController<VoiceServerFrame>.broadcast();
  final _audio = StreamController<Uint8List>.broadcast();
  final sent = <Uint8List>[];
  bool stopped = false;
  bool closed = false;

  void emit(VoiceServerFrame frame) => _frames.add(frame);
  @override
  Stream<VoiceServerFrame> get frames => _frames.stream;
  @override
  Stream<Uint8List> get audio => _audio.stream;
  void speak(Uint8List pcm16) => _audio.add(pcm16);
  @override
  void sendAudio(Uint8List pcm16) => sent.add(pcm16);
  @override
  Future<void> stop() async {
    stopped = true;
    await close();
  }

  @override
  Future<void> close() async {
    closed = true;
  }
}

class FakeBackend implements VoiceBackend {
  FakeBackend({this.waiting = const []});
  List<VoicePendingAnswer> waiting;
  final sessions = <FakeSession>[];
  Object? openFailure;
  int polls = 0;

  @override
  Future<VoiceSession> open(String deviceId) async {
    if (openFailure != null) throw openFailure!;
    final session = FakeSession();
    sessions.add(session);
    return session;
  }

  @override
  Future<List<VoicePendingAnswer>> pendingAnswers() async {
    polls += 1;
    return waiting;
  }

  FakeSession get latest => sessions.last;
}

class FakeAudio implements VoiceAudio {
  bool listening = false;
  int rate = voiceInputSampleRate;
  int interrupts = 0;
  bool disposed = false;
  final played = <Uint8List>[];
  Object? refusal;
  void Function(Uint8List)? onFrame;

  @override
  Future<void> listen(
    void Function(Uint8List pcm16) frame, {
    int sampleRate = voiceInputSampleRate,
    bool playback = true,
  }) async {
    if (refusal != null) throw refusal!;
    listening = true;
    rate = sampleRate;
    onFrame = frame;
  }

  @override
  Future<void> silence() async {
    listening = false;
  }

  @override
  void play(Uint8List pcm16) => played.add(pcm16);
  @override
  Future<void> interrupt() async {
    interrupts += 1;
  }

  @override
  Future<void> dispose() async {
    disposed = true;
    listening = false;
  }
}

VoicePendingAnswer answer(String bot, String text) => VoicePendingAnswer(
  answerId: 'ask-$bot',
  botId: bot,
  botName: bot == 'bob' ? 'Bob' : 'Research',
  question: 'Are the numbers in?',
  answer: text,
  answeredAt: '2026-09-05T01:00:0${bot == 'bob' ? 1 : 2}.000Z',
);

Future<void> pumpVoice(WidgetTester tester, VoiceController controller) async {
  tester.view.physicalSize = const Size(390 * 3, 780 * 3);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      theme: FrockTokens.themeData(FrockTokens.dark),
      home: VoicePage(controller: controller),
    ),
  );
  await flush(tester);
}

/// Lets an asynchronous chain (connect, pause, poll) finish and repaint.
/// `pumpAndSettle` cannot be used while paused: the pending-answer poll is a
/// periodic timer, so the tree never goes quiet.
Future<void> flush(WidgetTester tester, [int rounds = 4]) async {
  for (var round = 0; round < rounds; round += 1) {
    // Pumping alone leaves a chain of awaits part-run; `runAsync` lets the
    // real event loop finish it before the next frame is built.
    await tester.runAsync(() => Future<void>.delayed(Duration.zero));
    await tester.pump(const Duration(milliseconds: 1));
  }
}

/// Emits a frame and lets the broadcast stream and the rebuild land.
Future<void> emit(
  WidgetTester tester,
  FakeSession session,
  VoiceServerFrame frame,
) async {
  session.emit(frame);
  await flush(tester);
}

VoiceController build(
  FakeBackend backend,
  FakeAudio audio, {
  Duration pollInterval = const Duration(seconds: 30),
}) => VoiceController(
  backend: backend,
  audio: audio,
  deviceId: 'test-device',
  pollInterval: pollInterval,
);

void main() {
  group('the Voice screen', () {
    testWidgets('live shows Pause and the last two lines', (tester) async {
      final backend = FakeBackend();
      final audio = FakeAudio();
      final controller = build(backend, audio);
      await pumpVoice(tester, controller);
      await emit(tester, backend.latest, const VoiceReady('session-1', 3600));
      await tester.pump();

      expect(controller.phase, VoicePhase.listening);
      expect(find.text('Listening'), findsOneWidget);
      expect(find.text('Pause'), findsOneWidget);
      expect(find.textContaining('Pausing stops listening'), findsOneWidget);
      expect(audio.listening, isTrue);

      await emit(
        tester,
        backend.latest,
        const VoiceTranscript(
          id: 'a',
          fromUser: true,
          text: 'Ask Bob whether Sarah’s numbers are in yet.',
          at: '2026-09-05T01:00:00.000Z',
        ),
      );
      await emit(
        tester,
        backend.latest,
        const VoiceTranscript(
          id: 'b',
          fromUser: false,
          text: 'Bob says the sheet landed at 9:12.',
          at: '2026-09-05T01:00:01.000Z',
        ),
      );
      await tester.pump();
      expect(
        find.text('Ask Bob whether Sarah’s numbers are in yet.'),
        findsOneWidget,
      );
      expect(find.text('Bob says the sheet landed at 9:12.'), findsOneWidget);
    });

    testWidgets('a tool call never reaches a caption', (tester) async {
      final backend = FakeBackend();
      final controller = build(backend, FakeAudio());
      await pumpVoice(tester, controller);
      await emit(tester, backend.latest, const VoiceReady('session-1', 3600));
      await emit(
        tester,
        backend.latest,
        const VoiceToolUse(
          id: 'call-1',
          name: 'ask_bot',
          label: 'Asked Bob',
          at: '2026-09-05T01:00:00.000Z',
        ),
      );
      await tester.pump();
      expect(find.text('Asked Bob'), findsNothing);
      expect(controller.botSaid, isNull);
      expect(controller.phase, VoicePhase.listening);
    });

    testWidgets('paused with two waiting shows the rows and the count', (
      tester,
    ) async {
      final backend = FakeBackend(
        waiting: [
          answer('bob', 'Sarah replied. She wants the APAC number split.'),
          answer('research', 'Two of the three papers look strong.'),
        ],
      );
      final audio = FakeAudio();
      final controller = build(backend, audio);
      await pumpVoice(tester, controller);
      final live = backend.latest;
      await emit(tester, live, const VoiceReady('session-1', 3600));
      await tester.pump();

      await tester.tap(find.text('Pause'));
      await flush(tester);

      // Pause stops the provider session outright; nothing is sent to a Bot.
      expect(live.stopped, isTrue);
      expect(audio.listening, isFalse);
      expect(controller.phase, VoicePhase.paused);
      expect(find.text('Paused · not listening'), findsOneWidget);
      expect(find.text('WAITING FOR YOU'), findsOneWidget);
      expect(find.text('Bob'), findsOneWidget);
      expect(find.text('Research'), findsOneWidget);
      expect(
        find.text('Sarah replied. She wants the APAC number split.'),
        findsOneWidget,
      );
      expect(find.text('Resume · 2 waiting'), findsOneWidget);
      expect(
        find.textContaining('hands these to the voice agent'),
        findsOneWidget,
      );
      controller.dispose();
    });

    testWidgets('paused and quiet says so without any rows', (tester) async {
      final backend = FakeBackend();
      final controller = build(backend, FakeAudio());
      await pumpVoice(tester, controller);
      await emit(tester, backend.latest, const VoiceReady('session-1', 3600));
      await tester.pump();
      await tester.tap(find.text('Pause'));
      await flush(tester);

      expect(find.text('Resume'), findsOneWidget);
      expect(find.text('WAITING FOR YOU'), findsNothing);
      expect(
        find.textContaining('Your Bots don’t know you stepped away'),
        findsOneWidget,
      );
      controller.dispose();
    });

    testWidgets('a message that lands while paused raises the count', (
      tester,
    ) async {
      final backend = FakeBackend();
      final controller = build(
        backend,
        FakeAudio(),
        pollInterval: const Duration(milliseconds: 20),
      );
      await pumpVoice(tester, controller);
      await emit(tester, backend.latest, const VoiceReady('session-1', 3600));
      await tester.tap(find.text('Pause'));
      await flush(tester);
      expect(find.text('Resume'), findsOneWidget);

      backend.waiting = [answer('bob', 'Sarah replied.')];
      await tester.pump(const Duration(milliseconds: 25));
      await flush(tester);
      expect(find.text('Resume · 1 waiting'), findsOneWidget);
      expect(find.text('Sarah replied.'), findsOneWidget);
      controller.dispose();
    });

    testWidgets('resuming opens a new session, then goes live', (tester) async {
      final backend = FakeBackend(waiting: [answer('bob', 'Sarah replied.')]);
      final audio = FakeAudio();
      final controller = build(backend, audio);
      await pumpVoice(tester, controller);
      await emit(tester, backend.latest, const VoiceReady('session-1', 3600));
      await tester.pump();
      await tester.tap(find.text('Pause'));
      await flush(tester);

      await tester.tap(find.text('Resume · 1 waiting'));
      await tester.pump();
      expect(controller.phase, VoicePhase.resuming);
      expect(find.text('Resuming'), findsOneWidget);

      await flush(tester);
      // A second session, not the first one reopened: Resume reconnects, and
      // the kickoff on that connection is what hands the answers to the agent.
      expect(backend.sessions, hasLength(2));
      await emit(tester, backend.latest, const VoiceReady('session-2', 3500));
      await tester.pump();
      expect(controller.phase, VoicePhase.listening);
      expect(find.text('Pause'), findsOneWidget);
      // The rows are gone because the live session is speaking them.
      expect(find.text('WAITING FOR YOU'), findsNothing);
      expect(audio.listening, isTrue);
      controller.dispose();
    });

    testWidgets('close leaves voice and ends the session', (tester) async {
      final backend = FakeBackend();
      final audio = FakeAudio();
      final controller = build(backend, audio);
      tester.view.physicalSize = const Size(390 * 3, 780 * 3);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTokens.themeData(FrockTokens.dark),
          home: Builder(
            builder: (context) => Scaffold(
              body: Center(
                child: TextButton(
                  onPressed: () => Navigator.of(context).push(
                    MaterialPageRoute<void>(
                      builder: (_) => VoicePage(controller: controller),
                    ),
                  ),
                  child: const Text('Open Voice'),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Open Voice'));
      await tester.pumpAndSettle();
      await flush(tester);
      await emit(tester, backend.latest, const VoiceReady('session-1', 3600));
      await tester.pump();

      await tester.tap(find.byKey(const ValueKey('leave-voice')));
      await flush(tester);
      await tester.pumpAndSettle();
      expect(find.text('Open Voice'), findsOneWidget);
      expect(backend.latest.stopped, isTrue);
      expect(audio.disposed, isTrue);
    });

    testWidgets('a refused microphone says what to do', (tester) async {
      final backend = FakeBackend();
      final audio = FakeAudio()
        ..refusal = const VoiceAudioRefusal(
          'FrockBot needs the microphone to hear you.',
        );
      final controller = build(backend, audio);
      await pumpVoice(tester, controller);
      await tester.pump();
      expect(
        find.text('FrockBot needs the microphone to hear you.'),
        findsOneWidget,
      );
      expect(controller.phase, VoicePhase.ended);
      expect(backend.sessions, isEmpty);
    });

    testWidgets('the server taking Voice offline says why', (tester) async {
      final backend = FakeBackend();
      final controller = build(backend, FakeAudio());
      await pumpVoice(tester, controller);
      await emit(tester, backend.latest, const VoiceReady('session-1', 3600));
      await tester.pump();
      await emit(
        tester,
        backend.latest,
        const VoiceOffline(
          VoiceOfflineReason.idle,
          'Voice went offline after two quiet minutes.',
        ),
      );
      await tester.pump();
      expect(
        find.text('Voice went offline after two quiet minutes.'),
        findsOneWidget,
      );
      expect(find.text('Pause'), findsNothing);
    });

    testWidgets('speaking, then spoken over, returns to listening', (
      tester,
    ) async {
      final backend = FakeBackend();
      final audio = FakeAudio();
      final controller = build(backend, audio);
      await pumpVoice(tester, controller);
      await emit(tester, backend.latest, const VoiceReady('session-1', 3600));
      await emit(tester, backend.latest, const VoiceLiveState(speaking: true));
      await tester.pump();
      expect(find.text('Speaking'), findsOneWidget);

      backend.latest.speak(Uint8List.fromList([1, 0, 2, 0]));
      await tester.pump();
      expect(audio.played, hasLength(1));

      await emit(tester, backend.latest, const VoiceInterrupted());
      await tester.pump();
      expect(audio.interrupts, 1);
      expect(find.text('Listening'), findsOneWidget);
    });
  });

  group('the Voice protocol', () {
    test('decodes every server frame the Durable Object sends', () {
      Object? parse(String json) =>
          decodeVoiceServerFrame(jsonDecode(json) as Object);
      expect(
        parse(
          '{"schemaVersion":1,"type":"ready","sessionId":"s","'
          'quotaRemainingSeconds":10}',
        ),
        isA<VoiceReady>()
            .having((f) => f.sessionId, 'sessionId', 's')
            .having((f) => f.quotaRemainingSeconds, 'quota', 10),
      );
      expect(
        parse('{"schemaVersion":1,"type":"state","state":"speaking"}'),
        isA<VoiceLiveState>().having((f) => f.speaking, 'speaking', true),
      );
      expect(
        parse(
          '{"schemaVersion":1,"type":"transcript","id":"i","speaker":'
          '"user","text":"hi","at":"2026-09-05T01:00:00.000Z"}',
        ),
        isA<VoiceTranscript>().having((f) => f.fromUser, 'fromUser', true),
      );
      expect(
        parse(
          '{"schemaVersion":1,"type":"tool","id":"i","name":"ask_bot",'
          '"label":"Asked Bob","at":"2026-09-05T01:00:00.000Z"}',
        ),
        isA<VoiceToolUse>().having((f) => f.label, 'label', 'Asked Bob'),
      );
      expect(
        parse('{"schemaVersion":1,"type":"interrupted"}'),
        isA<VoiceInterrupted>(),
      );
      expect(
        parse(
          '{"schemaVersion":1,"type":"offline","reason":"quota",'
          '"message":"No allowance left."}',
        ),
        isA<VoiceOffline>().having(
          (f) => f.reason,
          'reason',
          VoiceOfflineReason.quota,
        ),
      );
    });

    test('refuses a frame the client cannot honestly act on', () {
      for (final json in [
        '{"schemaVersion":2,"type":"interrupted"}',
        '{"schemaVersion":1,"type":"nonsense"}',
        '{"schemaVersion":1,"type":"state","state":"dozing"}',
        '{"schemaVersion":1,"type":"ready","sessionId":"s",'
            '"quotaRemainingSeconds":-1}',
        '{"schemaVersion":1,"type":"offline","reason":"bored",'
            '"message":"x"}',
      ]) {
        expect(
          () => decodeVoiceServerFrame(jsonDecode(json) as Object),
          throwsA(isA<VoiceProtocolError>()),
          reason: json,
        );
      }
    });

    test('reads the answers waiting in the ledger and skips a bad row', () {
      final answers = decodeVoicePendingAnswers({
        'ledger': {
          'pendingAnswers': [
            {
              'schemaVersion': 1,
              'answerId': 'ask-1',
              'botId': 'bob',
              'botName': 'Bob',
              'question': 'Are the numbers in?',
              'answer': 'Sarah replied.',
              'answeredAt': '2026-09-05T01:00:00.000Z',
            },
            {'answerId': 'ask-2'},
          ],
        },
      });
      expect(answers, hasLength(1));
      expect(answers.single.botName, 'Bob');
      expect(decodeVoicePendingAnswers(null), isEmpty);
      expect(decodeVoicePendingAnswers({'ledger': {}}), isEmpty);
    });

    test('the frame the phone sends is the browser frame', () {
      expect(jsonEncode(voiceStopFrame), '{"schemaVersion":1,"type":"stop"}');
      expect(voiceInputSampleRate, 16000);
      expect(voiceOutputSampleRate, 24000);
      // 32 ms at 16 kHz, the same frame the web worklet cuts.
      expect(voiceInputFrameSamples, 512);
      expect(voiceToolNames, contains('ask_bot'));
    });
  });
}
