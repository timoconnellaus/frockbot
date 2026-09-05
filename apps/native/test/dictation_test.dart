import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/chat_controller.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/theme/frock_theme.dart';
import 'package:frockbot_native/ui/chat_pane.dart';
import 'package:frockbot_native/ui/chat_screen.dart';
import 'package:frockbot_native/ui/frock_widgets.dart';
import 'package:frockbot_native/voice/audio.dart';
import 'package:frockbot_native/voice/dictation.dart';
import 'package:frockbot_native/voice/dictation_controller.dart';
import 'package:frockbot_native/voice/protocol.dart';

/// A dictation socket whose frames the test writes, standing in for the
/// VoiceSession Durable Object.
class FakeDictationSession implements DictationSession {
  final _frames = StreamController<DictationServerFrame>.broadcast();
  final sent = <Uint8List>[];
  bool committed = false;
  bool cancelled = false;
  bool closed = false;

  void emit(DictationServerFrame frame) => _frames.add(frame);
  @override
  Stream<DictationServerFrame> get frames => _frames.stream;
  @override
  void sendAudio(Uint8List pcm16) => sent.add(pcm16);
  @override
  void commit() => committed = true;
  @override
  void cancel() => cancelled = true;
  @override
  Future<void> close() async {
    closed = true;
  }
}

class FakeDictationBackend implements DictationBackend {
  final sessions = <FakeDictationSession>[];
  Object? openFailure;
  @override
  Future<DictationSession> open() async {
    if (openFailure != null) throw openFailure!;
    final session = FakeDictationSession();
    sessions.add(session);
    return session;
  }

  FakeDictationSession get latest => sessions.last;
}

class FakeAudio implements VoiceAudio {
  bool listening = false;
  int rate = voiceInputSampleRate;
  bool playback = true;
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
    this.playback = playback;
    onFrame = frame;
  }

  @override
  Future<void> silence() async {
    listening = false;
  }

  @override
  void play(Uint8List pcm16) {}
  @override
  Future<void> interrupt() async {}
  @override
  Future<void> dispose() async {
    listening = false;
  }
}

class MemoryStore implements LocalStore {
  final values = <String, String>{};
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> write(String key, String value) async => values[key] = value;
  @override
  Future<void> delete(String key) async => values.remove(key);
}

/// Nothing is sent in these tests; the composer only needs a controller that
/// is ready, so Send is live and the draft is saved.
class QuietTransport implements ChatTransport {
  @override
  Future<Map<String, dynamic>> page(
    String botId, {
    String? before,
    String? conversationId,
  }) async => {
    'runs': <Object>[],
    'page': {'truncated': false},
  };
  @override
  Future<void> send(String botId, String id, String text) async {}
  @override
  Future<Map<String, dynamic>?> lookup(
    String botId,
    String id, {
    bool fence = false,
  }) async => null;
  @override
  Future<Map<String, dynamic>> stop(
    String botId,
    String id,
    String commandId,
  ) async => {};
}

/// Lets the controller's asynchronous chain (microphone, socket, frame) run
/// and the composer repaint.
Future<void> flush(WidgetTester tester, [int rounds = 4]) async {
  for (var round = 0; round < rounds; round += 1) {
    await tester.runAsync(() => Future<void>.delayed(Duration.zero));
    await tester.pump(const Duration(milliseconds: 1));
  }
}

void main() {
  group('the dictation wire', () {
    test('decodes every frame the Durable Object sends', () {
      expect(
        decodeDictationServerFrame({'schemaVersion': 1, 'type': 'ready'}),
        isA<DictationReady>(),
      );
      expect(
        (decodeDictationServerFrame({
          'schemaVersion': 1,
          'type': 'delta',
          'text': 'hello',
        }) as DictationDelta).text,
        'hello',
      );
      expect(
        (decodeDictationServerFrame({
          'schemaVersion': 1,
          'type': 'transcript',
          'text': 'Hello there.',
        }) as DictationSettled).text,
        'Hello there.',
      );
      expect(
        decodeDictationServerFrame({'schemaVersion': 1, 'type': 'final'}),
        isA<DictationFinal>(),
      );
      expect(
        (decodeDictationServerFrame({
          'schemaVersion': 1,
          'type': 'error',
          'message': 'You’ve used up today’s dictation.',
        }) as DictationFailed).message,
        'You’ve used up today’s dictation.',
      );
    });

    test('refuses a frame it cannot read rather than half-applying it', () {
      expect(
        () => decodeDictationServerFrame({'schemaVersion': 2, 'type': 'ready'}),
        throwsA(isA<DictationProtocolError>()),
      );
      expect(
        () => decodeDictationServerFrame({'schemaVersion': 1, 'type': 'nope'}),
        throwsA(isA<DictationProtocolError>()),
      );
      expect(
        () => decodeDictationServerFrame({
          'schemaVersion': 1,
          'type': 'delta',
          'text': 'x' * 8193,
        }),
        throwsA(isA<DictationProtocolError>()),
      );
    });

    test('sends the rate the transcription upstream was told to expect', () {
      // `voice-upstream.ts` opens the session at 24 kHz, not the assistant's
      // 16 kHz, and 32 ms of it is 768 samples.
      expect(voiceDictationSampleRate, 24000);
      expect(voiceDictationFrameSamples, 768);
    });
  });

  group('dictated text in a draft somebody is editing', () {
    test('replaces the last tail in place, and appends once it has gone', () {
      var draft = applyDictationTail('', '', 'hello');
      expect(draft.draft, 'hello');
      draft = applyDictationTail(draft.draft, draft.tail, 'hello there');
      expect(draft.draft, 'hello there');

      // Typed before, dictated after: the typing is kept and spaced.
      draft = applyDictationTail('Note:', '', 'send it');
      expect(draft.draft, 'Note: send it');
      draft = applyDictationTail(draft.draft, draft.tail, 'send it today');
      expect(draft.draft, 'Note: send it today');

      // The tail was deleted while it was being spoken; the next words go on
      // the end rather than being forced back into a place nobody asked for.
      draft = applyDictationTail('Note:', 'send it today', 'send it tomorrow');
      expect(draft.draft, 'Note: send it tomorrow');
    });

    test('a finished segment replaces the deltas that built it', () {
      final transcript = DictationTranscript();
      transcript.delta('hello');
      transcript.delta(' ther');
      expect(transcript.text(), 'hello ther');
      transcript.settle('Hello there.');
      expect(transcript.text(), 'Hello there.');
      transcript.delta(' how');
      expect(transcript.text(), 'Hello there. how');
    });

    test('taking the tail back out leaves what was typed', () {
      expect(removeDictationTail('Note: send it', 'send it'), 'Note:');
      expect(removeDictationTail('send it', 'send it'), '');
      // A tail the person has already edited away is left alone.
      expect(removeDictationTail('Note: kept', 'send it'), 'Note: kept');
    });
  });

  group('the composer mic', () {
    Future<
      ({
        FakeDictationBackend backend,
        FakeAudio audio,
        DictationController dictation,
        ChatController chat,
      })
    >
    pumpComposer(WidgetTester tester) async {
      tester.view.physicalSize = const Size(390 * 3, 780 * 3);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);
      final store = MemoryStore();
      final chat = ChatController(
        transport: QuietTransport(),
        store: store,
        userId: 'user-1',
        botId: 'bot-1',
      );
      await chat.initialize();
      chat.connection = ConnectionState.connected;
      final backend = FakeDictationBackend();
      final audio = FakeAudio();
      final dictation = DictationController(backend: backend, audio: audio);
      addTearDown(dictation.dispose);
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: Scaffold(
            body: ChatPane(
              controller: chat,
              onReconnect: () async {},
              botName: 'Bob',
              dictation: dictation,
            ),
          ),
        ),
      );
      await tester.pump();
      return (backend: backend, audio: audio, dictation: dictation, chat: chat);
    }

    Future<void> tapMic(WidgetTester tester) async {
      await tester.tap(find.byKey(const ValueKey('dictate')));
      await flush(tester);
    }

    testWidgets('listens at 24 kHz and shows Cancel and Done', (tester) async {
      final harness = await pumpComposer(tester);
      expect(find.byKey(const ValueKey('dictate')), findsOneWidget);
      await tapMic(tester);

      expect(harness.audio.listening, isTrue);
      expect(harness.audio.rate, voiceDictationSampleRate);
      // Dictation plays nothing back, so it must not claim the speaker.
      expect(harness.audio.playback, isFalse);
      expect(harness.backend.sessions, hasLength(1));
      expect(find.byKey(const ValueKey('dictate')), findsNothing);
      expect(find.byKey(const ValueKey('dictate-cancel')), findsOneWidget);
      expect(find.byKey(const ValueKey('dictate-done')), findsOneWidget);
      // Nothing heard yet: the empty field says so.
      expect(find.text('Listening…'), findsOneWidget);
      // Send never leaves.
      expect(find.byKey(const ValueKey('send')), findsOneWidget);

      // Audio captured before `ready` still reaches the session.
      harness.audio.onFrame!(Uint8List(768 * 2));
      expect(harness.backend.latest.sent, hasLength(1));
    });

    testWidgets('deltas appear in the field, and Done keeps them editable', (
      tester,
    ) async {
      final harness = await pumpComposer(tester);
      await tapMic(tester);
      final session = harness.backend.latest;

      session.emit(const DictationReady());
      session.emit(const DictationDelta('send the'));
      await flush(tester);
      expect(find.text('send the'), findsOneWidget);
      expect(find.text('Listening…'), findsNothing);

      session.emit(const DictationDelta(' numbers'));
      await flush(tester);
      expect(find.text('send the numbers'), findsOneWidget);

      // The finished segment replaces the rough one rather than repeating it.
      session.emit(const DictationSettled('Send the numbers.'));
      await flush(tester);
      expect(find.text('Send the numbers.'), findsOneWidget);
      expect(find.text('send the numbers'), findsNothing);

      await tester.tap(find.byKey(const ValueKey('dictate-done')));
      await flush(tester);
      expect(session.committed, isTrue);
      expect(harness.audio.listening, isFalse);

      session.emit(const DictationFinal());
      await flush(tester);
      // Out of listening, text kept for editing, and not sent.
      expect(find.byKey(const ValueKey('dictate')), findsOneWidget);
      expect(find.text('Send the numbers.'), findsOneWidget);
      expect(harness.chat.pendingId, isNull);
      // The draft was saved the way typing saves it.
      expect(harness.chat.draft, 'Send the numbers.');
    });

    testWidgets('Cancel drops the dictated text and keeps what was typed', (
      tester,
    ) async {
      final harness = await pumpComposer(tester);
      await tester.enterText(find.byKey(const ValueKey('composer')), 'Note:');
      await tester.pump();
      await tapMic(tester);
      final session = harness.backend.latest;
      session.emit(const DictationReady());
      session.emit(const DictationDelta('forget this'));
      await flush(tester);
      expect(find.text('Note: forget this'), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('dictate-cancel')));
      await flush(tester);
      expect(session.cancelled, isTrue);
      expect(session.closed, isTrue);
      expect(find.text('Note:'), findsOneWidget);
      expect(find.byKey(const ValueKey('dictate')), findsOneWidget);
      expect(harness.chat.draft, 'Note:');
    });

    testWidgets('a refusal is shown in the server’s own words', (tester) async {
      final harness = await pumpComposer(tester);
      await tapMic(tester);
      harness.backend.latest.emit(
        const DictationFailed(
          'You’ve used up today’s dictation. It comes back tomorrow.',
        ),
      );
      await flush(tester);
      expect(
        find.text('You’ve used up today’s dictation. It comes back tomorrow.'),
        findsOneWidget,
      );
      expect(find.byKey(const ValueKey('dictate')), findsOneWidget);
      expect(harness.audio.listening, isFalse);

      // The sentence stays for a few seconds, then the composer is quiet.
      await tester.pump(const Duration(seconds: 7));
      expect(find.byKey(const ValueKey('dictation-notice')), findsNothing);
    });

    testWidgets('a microphone the phone refuses says so and stays idle', (
      tester,
    ) async {
      final harness = await pumpComposer(tester);
      harness.audio.refusal = const VoiceAudioRefusal(
        'FrockBot needs the microphone to hear you.',
      );
      await tapMic(tester);
      expect(
        find.text('FrockBot needs the microphone to hear you.'),
        findsOneWidget,
      );
      expect(harness.backend.sessions, isEmpty);
      expect(find.byKey(const ValueKey('dictate')), findsOneWidget);
      await tester.pump(const Duration(seconds: 7));
      expect(find.byKey(const ValueKey('dictation-notice')), findsNothing);
    });
  });

  group('Voice at the top of the screen', () {
    Future<int> pumpScreen(
      WidgetTester tester, {
      required bool bot,
      required VoidCallback onVoice,
    }) async {
      tester.view.physicalSize = const Size(390 * 3, 780 * 3);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: ChatScreen(
            bots: const [],
            selected: null,
            selectedState: BotState.none,
            onSelect: (_) {},
            onRefresh: () {},
            onSignOut: () {},
            onApplets: () {},
            onSettings: () {},
            onVoice: onVoice,
            extraActions: bot
                ? [
                    const FrockIconButton(
                      Icons.mark_chat_read_outlined,
                      key: ValueKey('mark-read'),
                      semanticLabel: 'Mark as read',
                    ),
                  ]
                : const [],
            body: const SizedBox(),
          ),
        ),
      );
      await tester.pump();
      return 0;
    }

    testWidgets('the bar opens Voice, with or without a Bot', (tester) async {
      var opened = 0;
      await pumpScreen(tester, bot: false, onVoice: () => opened += 1);
      // App-wide: it is there before a Bot is chosen.
      expect(find.byKey(const ValueKey('voice')), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('voice')));
      await tester.pump();
      expect(opened, 1);

      await pumpScreen(tester, bot: true, onVoice: () => opened += 1);
      // Voice comes first, before mark-read and Applets.
      final trailing = tester.widgetList<FrockIconButton>(
        find.byType(FrockIconButton),
      );
      final labels = trailing
          .map((button) => button.semanticLabel ?? '')
          .toList();
      expect(
        labels.where(
          (label) =>
              label == 'Voice' || label == 'Mark as read' || label == 'Applets',
        ),
        ['Voice', 'Mark as read', 'Applets'],
      );
    });
  });
}
