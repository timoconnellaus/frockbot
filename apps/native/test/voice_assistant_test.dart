/// The continuous voice session: the handshake, the meter, and the interrupt.
///
/// The audio policy is the thing under test. An awake upstream gets a frame
/// every 40 ms — the server's transcriber decides where a turn ends and it
/// needs the half second of silence after the words to decide it — silence in
/// place of the microphone while the reply plays on a capture that cannot
/// cancel its own playback, and the only thing that stops the audio is two
/// minutes of quiet, or the person muting.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/voice/assistant.dart';
import 'package:frockbot_native/voice/capture.dart';
import 'package:frockbot_native/voice/connect_sound.dart';
import 'package:frockbot_native/voice/protocol.dart';
import 'package:frockbot_native/voice/socket.dart';
import 'package:frockbot_native/voice/speech_classifier.dart';

import 'voice_fakes.dart';

/// The room at rest, and the nothing a deaf device hands over: zeros.
const _quiet = 0.0005;
const _deaf = 0.0;
const _speech = 0.08;
const _frameMs = 40;

class Harness {
  late final FakeVoiceCapture capture;
  FakeVoiceSocket socket = FakeVoiceSocket();
  final FakeVoicePlayer player = FakeVoicePlayer();
  late final AssistantSessionController controller;
  late VoiceSocket Function() opener;
  final RecordingConnectSound? chime;
  int at = 0;
  int mark = 0;

  Harness({
    Completer<VoiceSocket>? deferred,
    bool cancelsPlaybackEcho = false,
    SpeechClassifier? speechClassifier,
    bool recordChime = false,
  }) : chime = recordChime ? RecordingConnectSound() : null {
    capture = FakeVoiceCapture(cancelsPlaybackEcho: cancelsPlaybackEcho);
    opener = () => socket;
    controller = AssistantSessionController(
      openSocket: () => deferred?.future ?? Future.value(opener()),
      capture: capture,
      player: player,
      speechClassifier: speechClassifier ?? const EnergySpeechClassifier(),
      connectSound: chime ?? const SilentVoiceConnectSound(),
    );
  }

  /// Drives the handshake to `listening`, which is where a call begins.
  Future<void> live() async {
    await controller.start();
    await settle();
    socket.deliver(jsonEncode({'type': 'welcome', 'protocol_version': 1}));
    await settle();
    socket.deliver(
      jsonEncode({
        'type': 'audio_config',
        'format': 'pcm16',
        'sampleRate': 24000,
      }),
    );
    socket.completeOpen();
    socket.deliver(jsonEncode({'type': 'status', 'status': 'listening'}));
    await settle();
  }

  void status(String value) =>
      socket.deliver(jsonEncode({'type': 'status', 'status': value}));

  /// Feeds [ms] of audio at one level, in protocol frames.
  Future<void> feed(double level, int ms) async {
    for (var elapsed = 0; elapsed < ms; elapsed += _frameMs) {
      capture.emit(AudioFrame(pcmFrame(level, mark: ++mark % 251), level, at));
      at += _frameMs;
    }
    await settle();
  }

  int get audioCount => socket.binaries.length;
  List<String> get texts => socket.texts;
}

void main() {
  test('the handshake is welcome, hello, voice/open, listening', () async {
    final harness = Harness();
    await harness.live();
    expect(harness.texts.first, encodeAssistantHelloV1());
    expect(harness.socket.hasOpen(mode: VoiceOpeningModeV1.start), isTrue);
    expect(harness.controller.status, VoiceStatusV1.listening);
    expect(harness.controller.phase, VoiceSessionPhase.live);
    expect(harness.capture.sampleRate, voiceAssistantInputSampleRateV1);
    expect(harness.capture.frame, voiceAssistantFrame);
    expect(harness.player.sampleRate, 24000);
    harness.controller.dispose();
  });

  test('the connect sound plays once, on the first listening', () async {
    final harness = Harness(recordChime: true);
    await harness.controller.start();
    await settle();
    expect(harness.chime!.plays, 0, reason: 'not before the call is up');

    harness.socket.deliver(
      jsonEncode({'type': 'welcome', 'protocol_version': 1}),
    );
    harness.socket.deliver(
      jsonEncode({
        'type': 'audio_config',
        'format': 'pcm16',
        'sampleRate': 24000,
      }),
    );
    await settle();
    expect(harness.chime!.plays, 0);

    harness.status('listening');
    await settle();
    expect(harness.chime!.plays, 1);

    harness.status('speaking');
    await settle();
    harness.status('listening');
    await settle();
    expect(
      harness.chime!.plays,
      1,
      reason: 'a later listening is not a connect',
    );
    harness.controller.dispose();
  });

  test(
    'opening audio is held until voice/ready and then drained in order',
    () async {
      final deferred = Completer<VoiceSocket>();
      final harness = Harness(deferred: deferred);
      unawaited(harness.controller.start());
      await settle();
      await harness.feed(_speech, 120);
      expect(harness.audioCount, 0);

      deferred.complete(harness.socket);
      await settle();
      expect(harness.audioCount, 0, reason: 'nothing goes before voice/open');

      harness.socket.deliver(
        jsonEncode({'type': 'welcome', 'protocol_version': 1}),
      );
      await settle();
      expect(harness.audioCount, 0, reason: 'held until voice/ready');
      harness.socket.completeOpen();
      await settle();
      expect(harness.socket.audioMarks, [1, 2, 3]);
      harness.controller.dispose();
    },
  );

  test('opening overflow fails with an explicit retry', () async {
    final deferred = Completer<VoiceSocket>();
    final harness = Harness(deferred: deferred);
    unawaited(harness.controller.start());
    await settle();
    harness.capture.emit(
      AudioFrame(Uint8List(voiceAssistantOpeningBufferBytesV1), _speech, 0),
    );
    await settle();
    expect(harness.controller.phase, isNot(VoiceSessionPhase.error));
    harness.capture.emit(AudioFrame(Uint8List(2), _speech, 40));
    await settle();
    expect(harness.controller.phase, VoiceSessionPhase.error);
    expect(
      harness.controller.error,
      voiceOpeningFailMessage(VoiceOpeningFailCodeV1.overflow),
    );
    harness.controller.dispose();
  });

  test('an awake upstream gets a frame every 40 ms, pauses and all', () async {
    final harness = Harness();
    await harness.live();
    await harness.feed(_speech, 400);
    final spoken = harness.audioCount;
    expect(spoken, 10);

    // Three seconds of silence in the middle of a sentence still goes up:
    // the upstream needs it to decide the turn is over.
    await harness.feed(_quiet, 3000);
    expect(harness.audioCount, spoken + 75);

    // So does the audio while the assistant thinks.
    harness.status('thinking');
    await settle();
    await harness.feed(_quiet, 200);
    expect(harness.audioCount, spoken + 75 + 5);
    expect(
      harness.socket.audioMarks.sublist(spoken + 75),
      everyElement(isNot(0)),
    );

    // While it speaks the cadence holds but the frames are silent: the
    // upstream stays awake and its detector never hears the speaker.
    harness.status('speaking');
    await settle();
    await harness.feed(_quiet, 200);
    expect(harness.audioCount, spoken + 75 + 10);
    final whileSpeaking = harness.socket.pcmPayloads.sublist(spoken + 75 + 5);
    expect(whileSpeaking, everyElement(everyElement(0)));
    harness.controller.dispose();
  });

  test('an AEC capture streams audio and retains local barge-in', () async {
    final harness = Harness(cancelsPlaybackEcho: true);
    await harness.live();
    await harness.feed(_quiet, 600);
    harness.status('speaking');
    await settle();
    // Gemini hears the cleaned microphone from the start. The local gate
    // stops playback only as a latency optimisation; it does not decide
    // which audio reaches Gemini.
    final before = harness.audioCount;
    await harness.feed(0.3, 400);
    expect(harness.player.interrupts, 1);
    final interruptAt = harness.socket.sent.indexOf(
      encodeAssistantInterruptV1(),
    );
    expect(interruptAt, greaterThan(0));
    // Real audio was continuous before and after the local interrupt, with no
    // held-frame replay and no duplicate frame.
    final frames = harness.socket.sent;
    final beforeInterrupt = frames
        .sublist(0, interruptAt)
        .whereType<Uint8List>()
        .skip(before);
    expect(beforeInterrupt, isNotEmpty);
    final beforePcm = [
      for (final frame in beforeInterrupt)
        decodeVoiceAssistantPcmEnvelopeV1(frame)?.pcm ?? frame,
    ];
    expect(beforePcm, everyElement(isNot(everyElement(0))));
    final real = frames.sublist(interruptAt + 1).whereType<Uint8List>();
    expect(real, isNotEmpty);
    final marks = [
      for (final frame in real)
        (decodeVoiceAssistantPcmEnvelopeV1(frame)?.pcm ?? frame).first,
    ];
    expect(marks, everyElement(isNot(0)));
    for (var i = 1; i < marks.length; i++) {
      expect(marks[i], (marks[i - 1] + 1) % 251, reason: 'frame $i');
    }
    expect(harness.socket.binaries.length - before, 10);

    // Once the reply is over, ordinary frames again.
    harness.status('listening');
    await settle();
    final resumed = harness.audioCount;
    await harness.feed(_speech, 80);
    expect(harness.audioCount, resumed + 2);
    expect(harness.socket.audioMarks.sublist(resumed), everyElement(isNot(0)));
    harness.controller.dispose();
  });

  test(
    'a capture without AEC cannot barge in or send speaker energy upstream',
    () async {
      final harness = Harness();
      await harness.live();
      await harness.feed(_quiet, 600);
      harness.status('speaking');
      await settle();

      final before = harness.audioCount;
      await harness.feed(0.3, 400);

      expect(harness.player.interrupts, 0);
      expect(harness.texts, isNot(contains(encodeAssistantInterruptV1())));
      expect(
        harness.socket.pcmPayloads.sublist(before),
        everyElement(everyElement(0)),
      );

      harness.status('listening');
      await settle();
      final afterPlayback = harness.audioCount;
      await harness.feed(_speech, 80);
      expect(
        harness.socket.pcmPayloads.sublist(afterPlayback),
        everyElement(isNot(everyElement(0))),
      );
      harness.controller.dispose();
    },
  );

  test(
    'a wake while the reply is audible sends no speaker energy upstream',
    () async {
      // The state where the pre-roll ring holds the speaker rather than the
      // person: the reply is playing, the person mutes and unmutes before the
      // speaker has drained, and the reopened microphone hands the gate the
      // model's own voice. The onset may wake the upstream, but what it
      // replays is not the model's words.
      final harness = Harness();
      await harness.live();
      await harness.feed(_quiet, 600);
      harness.status('speaking');
      await settle();

      harness.controller.setMuted(true);
      await settle();
      harness.controller.setMuted(false);
      await settle();

      final before = harness.audioCount;
      await harness.feed(0.3, 200);
      expect(harness.socket.hasOpen(mode: VoiceOpeningModeV1.wake), isTrue);
      expect(harness.audioCount, before, reason: 'held until voice/ready');
      harness.socket.completeOpen();
      await settle();
      final replayed = harness.socket.pcmPayloads.sublist(before);
      expect(replayed, isNotEmpty);
      expect(replayed, everyElement(everyElement(0)));
      // The cadence is unmoved: silence takes the bytes' place, no frame is
      // dropped and no frame is repeated.
      expect(harness.audioCount - before, 5);
      harness.controller.dispose();
    },
  );

  test(
    'the speaker still playing after the server moved on counts as a reply',
    () async {
      final harness = Harness();
      await harness.live();
      harness.status('speaking');
      await settle();
      harness.status('listening');
      harness.player.level = 0.2;
      await settle();
      final before = harness.audioCount;
      await harness.feed(_quiet, 200);
      expect(
        harness.socket.pcmPayloads.sublist(before),
        everyElement(everyElement(0)),
      );
      harness.player.level = 0;
      await settle();
      final after = harness.audioCount;
      await harness.feed(_quiet, 80);
      expect(harness.socket.audioMarks.sublist(after), everyElement(isNot(0)));
      harness.controller.dispose();
    },
  );

  test('a reply that fails is a notice, not the end of the call', () async {
    final harness = Harness();
    await harness.live();
    harness.socket.deliver(
      jsonEncode({'type': 'error', 'message': 'TTS failed for a sentence'}),
    );
    await settle();
    expect(harness.controller.phase, VoiceSessionPhase.live);
    expect(harness.controller.error, isNull);
    expect(harness.controller.notice, contains('didn’t come through'));
    expect(harness.controller.active, isTrue);
    expect(harness.socket.closed, isFalse);
    expect(harness.capture.stops, 0);
    // The call still hears the person.
    final before = harness.audioCount;
    await harness.feed(_speech, 80);
    expect(harness.audioCount, before + 2);
    await harness.controller.end(reason: 'end-button');
    expect(harness.controller.notice, isNull);
    harness.controller.dispose();
  });

  test('a delegated Bot stays on the voice bar through its answer', () async {
    final harness = Harness();
    await harness.live();
    harness.socket.deliver(
      jsonEncode({
        'schemaVersion': 1,
        'type': 'voice/delegation',
        'botId': 'researcher',
        'botName': 'Scout',
        'runId': 'run-scout',
        'state': 'asked',
      }),
    );
    await settle();
    expect(harness.controller.delegatedBotId, 'researcher');
    expect(harness.controller.delegatedBotName, 'Scout');
    expect(harness.controller.delegationState, VoiceDelegationStateV1.asked);

    harness.socket.deliver(
      jsonEncode({
        'schemaVersion': 1,
        'type': 'voice/delegation',
        'botId': 'researcher',
        'botName': 'Scout',
        'runId': 'run-scout',
        'state': 'answering',
      }),
    );
    await settle();
    expect(
      harness.controller.delegationState,
      VoiceDelegationStateV1.answering,
    );

    await harness.controller.end(reason: 'end-button');
    expect(harness.controller.delegatedBotId, isNull);
    expect(harness.controller.delegationState, isNull);
    harness.controller.dispose();
  });

  test(
    'two hand-offs to the same Bot are two entries, each its own Turn',
    () async {
      final harness = Harness();
      await harness.live();
      void delegation(String runId, String state) {
        harness.socket.deliver(
          jsonEncode({
            'schemaVersion': 1,
            'type': 'voice/delegation',
            'botId': 'researcher',
            'botName': 'Scout',
            'runId': runId,
            'state': state,
          }),
        );
      }

      // Every voice hand-off is the call's own Bot, so a ledger kept per Bot
      // would collapse these two onto one entry and lose the first Turn.
      delegation('run-one', 'asked');
      await settle();
      delegation('run-two', 'asked');
      await settle();
      expect(harness.controller.delegations.map((entry) => entry.runId), [
        'run-one',
        'run-two',
      ]);

      harness.controller.pause();
      delegation('run-one', 'finished');
      await settle();
      delegation('run-two', 'finished');
      await settle();
      expect(harness.controller.delegations.map((entry) => entry.runId), [
        'run-one',
        'run-two',
      ]);
      expect(
        harness.controller.delegations.every((entry) => entry.finished),
        isTrue,
      );
      expect(harness.controller.finishedWhilePaused, 2);

      await harness.controller.end(reason: 'end-button');
      harness.controller.dispose();
    },
  );

  test('a call the server has already ended is not a notice', () async {
    final harness = Harness();
    await harness.live();
    harness.socket.deliver(
      jsonEncode({
        'type': 'error',
        'message': 'Speech recognition connection was lost',
        'code': 'stt_connection_lost',
        'stage': 'stt',
        'retryable': true,
      }),
    );
    await settle();
    expect(harness.controller.phase, VoiceSessionPhase.error);
    expect(harness.controller.error, isNotNull);
    expect(harness.controller.notice, isNull);
    expect(harness.controller.active, isFalse);
    expect(harness.socket.closed, isTrue);
    expect(harness.capture.stops, 1);
    // Nothing more is sent into a call nobody is listening on.
    final before = harness.audioCount;
    await harness.feed(_speech, 80);
    expect(harness.audioCount, before);
    harness.controller.dispose();
  });

  test('two minutes of quiet while listening sleeps the upstream', () async {
    final harness = Harness();
    await harness.live();
    await harness.feed(_speech, 400);
    await harness.feed(_quiet, 121000);

    expect(harness.texts, contains(encodeVoiceSleepV1()));
    expect(
      harness.texts.where((text) => text == encodeVoiceSleepV1()).length,
      1,
      reason: 'the upstream is told once, not once a frame',
    );
    expect(harness.controller.asleep, isTrue);
    expect(harness.controller.upstream, VoiceUpstreamStateV1.asleep);

    final asleepAt = harness.audioCount;
    await harness.feed(_quiet, 2000);
    expect(harness.audioCount, asleepAt, reason: 'a sleeping upstream is free');

    harness.socket.deliver(
      jsonEncode({
        'type': 'voice/state',
        'schemaVersion': 1,
        'upstream': 'starting',
        'muted': false,
      }),
    );
    await settle();
    expect(harness.controller.asleep, isFalse);
    expect(harness.controller.paused, isFalse);
    expect(harness.controller.upstream, VoiceUpstreamStateV1.starting);
    harness.controller.dispose();
  });

  test('a Pause does not follow a server wake', () async {
    final harness = Harness();
    await harness.live();
    harness.controller.pause();
    expect(harness.socket.hasControl(VoiceControlActionV1.pause), isTrue);
    expect(harness.controller.paused, isTrue);
    expect(harness.controller.asleep, isTrue);

    harness.socket.deliver(
      jsonEncode({
        'type': 'voice/state',
        'schemaVersion': 1,
        'upstream': 'starting',
        'muted': false,
      }),
    );
    await settle();
    expect(harness.controller.paused, isTrue);
    expect(harness.controller.asleep, isTrue);
    harness.controller.dispose();
  });

  test(
    'leaving the screen pauses, stops the microphone, and keeps the socket',
    () async {
      final harness = Harness();
      await harness.live();
      expect(harness.capture.starts, 1);
      await harness.controller.leaveForeground();
      expect(harness.socket.hasControl(VoiceControlActionV1.pause), isTrue);
      expect(harness.controller.paused, isTrue);
      expect(harness.controller.asleep, isTrue);
      expect(harness.controller.active, isTrue);
      expect(harness.controller.phase, VoiceSessionPhase.live);
      expect(harness.socket.closed, isFalse);
      expect(harness.capture.stops, 1);
      expect(harness.capture.active, isFalse);

      harness.socket.deliver(
        jsonEncode({
          'type': 'voice/state',
          'schemaVersion': 1,
          'upstream': 'starting',
          'muted': false,
        }),
      );
      await settle();
      expect(
        harness.controller.paused,
        isTrue,
        reason: 'away is Pause until return',
      );
      expect(harness.controller.asleep, isTrue);

      await harness.controller.enterForeground();
      await settle();
      expect(harness.controller.paused, isFalse);
      expect(harness.socket.hasOpen(mode: VoiceOpeningModeV1.wake), isTrue);
      expect(harness.capture.starts, 2);
      expect(harness.capture.active, isTrue);
      expect(harness.socket.closed, isFalse);
      harness.controller.dispose();
    },
  );

  test(
    'a Pause the person started stays paused after a round trip away',
    () async {
      final harness = Harness();
      await harness.live();
      harness.controller.pause();
      await harness.controller.leaveForeground();
      expect(harness.capture.stops, 1);
      expect(harness.socket.closed, isFalse);

      await harness.controller.enterForeground();
      await settle();
      expect(harness.controller.paused, isTrue);
      expect(harness.socket.openCount(mode: VoiceOpeningModeV1.wake), 0);
      expect(harness.capture.starts, 2);
      harness.controller.dispose();
    },
  );

  test(
    'a socket that dies while away keeps the call and rejoins on return',
    () async {
      final harness = Harness();
      await harness.live();
      await harness.controller.leaveForeground();
      await harness.socket.finish();
      await settle();
      expect(harness.controller.phase, VoiceSessionPhase.live);
      expect(harness.controller.active, isTrue);
      expect(harness.controller.endedLine, isNull);
      expect(harness.controller.paused, isTrue);

      final next = FakeVoiceSocket();
      harness.opener = () => next;
      await harness.controller.enterForeground();
      await settle();
      next.deliver(jsonEncode({'type': 'welcome', 'protocol_version': 1}));
      await settle();
      next.completeOpen();
      next.deliver(
        jsonEncode({
          'type': 'audio_config',
          'format': 'pcm16',
          'sampleRate': 24000,
        }),
      );
      next.deliver(jsonEncode({'type': 'status', 'status': 'listening'}));
      await settle();
      expect(next.hasOpen(mode: VoiceOpeningModeV1.rejoin), isTrue);
      expect(next.hasOpen(mode: VoiceOpeningModeV1.wake), isTrue);
      expect(harness.controller.paused, isFalse);
      expect(harness.controller.phase, VoiceSessionPhase.live);
      expect(harness.controller.endedLine, isNull);
      expect(harness.capture.starts, 2);
      harness.controller.dispose();
    },
  );

  test('a socket that dies while paused keeps the call and rejoins', () async {
    final harness = Harness();
    await harness.live();
    final next = FakeVoiceSocket();
    harness.opener = () => next;
    harness.controller.pause();
    await harness.socket.finish();
    await settle();
    expect(harness.controller.phase, VoiceSessionPhase.live);
    expect(harness.controller.paused, isTrue);
    expect(harness.controller.endedLine, isNull);

    next.deliver(jsonEncode({'type': 'welcome', 'protocol_version': 1}));
    await settle();
    next.completeOpen(paused: true);
    next.deliver(jsonEncode({'type': 'status', 'status': 'listening'}));
    await settle();
    expect(next.hasOpen(mode: VoiceOpeningModeV1.rejoin, paused: true), isTrue);
    expect(harness.controller.paused, isTrue);
    expect(harness.controller.active, isTrue);
    harness.controller.dispose();
  });

  test('hanging up after a dropped pause still sends hang-up', () async {
    final harness = Harness();
    await harness.live();
    final next = FakeVoiceSocket();
    harness.opener = () => next;
    harness.controller.pause();
    await harness.socket.finish();
    await settle();
    next.deliver(jsonEncode({'type': 'welcome', 'protocol_version': 1}));
    await settle();
    next.completeOpen(paused: true);
    next.deliver(jsonEncode({'type': 'status', 'status': 'listening'}));
    await settle();

    await harness.controller.end(reason: 'end-button');
    expect(next.hasControl(VoiceControlActionV1.end), isTrue);
    expect(harness.controller.phase, VoiceSessionPhase.ended);
    expect(harness.controller.endedLine, isNull);
    harness.controller.dispose();
  });

  test('the next onset wakes it, pre-roll first and then live', () async {
    final harness = Harness();
    await harness.live();
    await harness.feed(_quiet, 121000);
    expect(harness.controller.asleep, isTrue);
    final beforeWake = harness.audioCount;

    // Three frames: the third is the verified onset that wakes it.
    await harness.feed(_speech, 120);
    expect(harness.controller.asleep, isFalse);
    // The wake goes out before any audio does.
    expect(harness.socket.hasOpen(mode: VoiceOpeningModeV1.wake), isTrue);
    expect(harness.audioCount, beforeWake, reason: 'held until voice/ready');
    harness.socket.completeOpen();
    await settle();
    // 500 ms of pre-roll at 40 ms, ending with the frame that woke it.
    expect(harness.audioCount - beforeWake, 13);

    await harness.feed(_speech, 80);
    expect(harness.audioCount - beforeWake, 15);
    // The pre-roll and the live frames after the wake are one unbroken run:
    // the pre-roll reaches back before the onset and the live frames carry on
    // from it, with nothing repeated and nothing skipped.
    final marks = harness.socket.audioMarks.sublist(beforeWake);
    for (var i = 1; i < marks.length; i++) {
      // The mark is a byte, so it wraps; contiguity is what is being read.
      expect(
        marks[i],
        (marks[i - 1] + 1) % 251,
        reason: 'frame $i is out of order',
      );
    }
    harness.controller.dispose();
  });

  test(
    'a speech classifier, not energy, decides when a sleeping call wakes',
    () async {
      final classifier = ScriptedSpeechClassifier(score: 0.1);
      final harness = Harness(speechClassifier: classifier);
      await harness.live();
      await harness.feed(_quiet, 121000);
      expect(harness.controller.asleep, isTrue);
      final before = harness.audioCount;

      // Loud energy, not speech: a slammed door must not spend a wake.
      await harness.feed(_speech, 400);
      expect(harness.controller.asleep, isTrue);
      expect(harness.audioCount, before);
      expect(harness.socket.openCount(mode: VoiceOpeningModeV1.wake), 0);

      classifier.score = 0.9;
      await harness.feed(_quiet, 120);
      expect(harness.controller.asleep, isFalse);
      expect(harness.socket.hasOpen(mode: VoiceOpeningModeV1.wake), isTrue);
      expect(harness.audioCount, before, reason: 'held until voice/ready');
      harness.socket.completeOpen();
      await settle();
      expect(harness.audioCount, greaterThan(before));
      harness.controller.dispose();
    },
  );

  test('mute stops the frames at once and unmute waits for an onset', () async {
    final harness = Harness();
    await harness.live();
    await harness.feed(_speech, 200);
    final beforeMute = harness.audioCount;

    harness.controller.setMuted(true);
    expect(
      harness.socket.hasControl(VoiceControlActionV1.mute, muted: true),
      isTrue,
    );
    await harness.feed(_speech, 400);
    expect(harness.audioCount, beforeMute);
    expect(harness.controller.muted, isTrue);

    harness.controller.setMuted(false);
    expect(
      harness.socket.hasControl(VoiceControlActionV1.mute, muted: false),
      isTrue,
    );
    await harness.feed(_quiet, 400);
    expect(harness.audioCount, beforeMute, reason: 'silence does not wake it');

    await harness.feed(_speech, 200);
    expect(harness.socket.hasOpen(mode: VoiceOpeningModeV1.wake), isTrue);
    expect(harness.audioCount, beforeMute, reason: 'held until voice/ready');
    harness.socket.completeOpen();
    await settle();
    expect(harness.audioCount, greaterThan(beforeMute));
    expect(harness.socket.openCount(mode: VoiceOpeningModeV1.wake), 1);
    harness.controller.dispose();
  });

  test('playback_interrupt drops everything the speaker holds', () async {
    final harness = Harness();
    await harness.live();
    harness.socket.deliverPcm([1, 2, 3, 4]);
    await settle();
    expect(harness.player.written, hasLength(1));

    harness.socket.deliver(jsonEncode({'type': 'playback_interrupt'}));
    await settle();
    expect(harness.player.interrupts, 1);
    expect(harness.player.written, isEmpty);
    harness.controller.dispose();
  });

  test(
    'barge-in interrupts only on verified speech, and only while speaking',
    () async {
      final harness = Harness(cancelsPlaybackEcho: true);
      await harness.live();
      // Establish what quiet sounds like, then talk at a level that opens the
      // gate but is not verified speech.
      await harness.feed(_quiet, 600);
      await harness.feed(0.02, 600);
      expect(harness.player.interrupts, 0);

      // Loud, but the assistant is not speaking: nothing to interrupt.
      await harness.feed(0.3, 400);
      expect(harness.player.interrupts, 0);
      expect(harness.texts, isNot(contains(encodeAssistantInterruptV1())));

      harness.status('speaking');
      await settle();
      await harness.feed(0.02, 400);
      expect(harness.player.interrupts, 0, reason: 'the strict margin holds');

      await harness.feed(0.3, 400);
      expect(harness.player.interrupts, 1);
      expect(
        harness.texts.where((t) => t == encodeAssistantInterruptV1()).length,
        1,
        reason: 'one interrupt per reply, not one a frame',
      );
      harness.controller.dispose();
    },
  );

  test(
    'barge-in follows the classifier when energy would have interrupted',
    () async {
      final classifier = ScriptedSpeechClassifier(score: 0.55);
      final harness = Harness(
        cancelsPlaybackEcho: true,
        speechClassifier: classifier,
      );
      await harness.live();
      await harness.feed(_quiet, 600);
      harness.status('speaking');
      await settle();
      await harness.feed(0.3, 400);
      expect(
        harness.player.interrupts,
        0,
        reason: '0.55 is onset, not barge-in',
      );

      classifier.score = 0.85;
      await harness.feed(_quiet, 200);
      expect(harness.player.interrupts, 1);
      expect(harness.texts, contains(encodeAssistantInterruptV1()));
      harness.controller.dispose();
    },
  );

  test('a refusal ends the call with one sentence', () async {
    final harness = Harness();
    await harness.live();
    harness.socket.deliver(
      jsonEncode({
        'type': 'voice/refusal',
        'schemaVersion': 1,
        'code': 'quota',
        'message': 'used up',
      }),
    );
    await settle();
    expect(harness.controller.phase, VoiceSessionPhase.error);
    expect(
      harness.controller.error,
      voiceRefusalMessage(VoiceRefusalCodeV1.quota),
    );
    expect(harness.controller.active, isFalse);
    expect(harness.capture.stops, 1);
    expect(harness.player.closed, isTrue);
    expect(harness.socket.closed, isTrue);
    // The server's log is the only record of why this device hung up.
    expect(harness.socket.closeCode, voiceCloseFailedV1);
    expect(
      harness.socket.closeReason,
      voiceRefusalMessage(VoiceRefusalCodeV1.quota),
    );
    harness.controller.dispose();
  });

  test('ending says hang-up and takes everything down', () async {
    final harness = Harness();
    await harness.live();
    await harness.controller.end(reason: 'lifecycle:paused');
    expect(harness.socket.hasControl(VoiceControlActionV1.end), isTrue);
    expect(harness.controller.phase, VoiceSessionPhase.ended);
    // The person's own end has nothing to explain: their surface is going
    // away, and the line about the call ending is only for one nobody asked
    // for.
    expect(harness.controller.endedLine, isNull);
    expect(harness.controller.status, VoiceStatusV1.idle);
    expect(harness.capture.stops, 1);
    expect(harness.player.closed, isTrue);
    expect(harness.socket.closed, isTrue);
    expect(harness.socket.closeCode, voiceCloseNormalV1);
    expect(harness.socket.closeReason, 'lifecycle:paused');
    harness.controller.dispose();
  });

  test(
    'a server that closes first names the path and says the call ended',
    () async {
      final harness = Harness();
      await harness.live();
      await harness.socket.finish();
      await settle();
      expect(harness.controller.phase, VoiceSessionPhase.ended);
      // The socket completing with no error frame is the call being over, not
      // the call having failed: the surface says the first, never the second.
      expect(harness.controller.error, isNull);
      expect(harness.controller.endedLine, 'The call ended.');
      expect(harness.socket.closed, isTrue);
      expect(harness.socket.closeCode, voiceCloseNormalV1);
      expect(harness.socket.closeReason, 'server-closed');
      harness.controller.dispose();
    },
  );

  test(
    'the deaf window is measured on the clock the capture is running',
    () async {
      final harness = Harness();
      await harness.live();
      // The capture opened before the handshake finished, so the call goes live
      // seconds into its clock, and the window starts there. A deaf device
      // hands over zeros.
      harness.at = 3000;
      await harness.feed(_deaf, 6000);
      expect(harness.controller.notice, isNull);

      // Muting closes the device and unmuting opens it again: the frames carry
      // a clock from zero, and ten seconds of nothing is ten seconds of that
      // one, not ten seconds counted from the clock the device had before.
      harness.controller.setMuted(true);
      await settle();
      harness.controller.setMuted(false);
      await settle();
      harness.at = 0;
      await harness.feed(
        _deaf,
        voiceAssistantDeafNoticeAfterV1.inMilliseconds + _frameMs,
      );

      expect(harness.controller.notice, isNotNull);
      expect(harness.controller.error, isNull);
      expect(harness.controller.active, isTrue);
      harness.controller.dispose();
    },
  );

  test('a room at rest is a microphone being heard, not a deaf one', () async {
    final harness = Harness();
    await harness.live();
    // Room tone: a working microphone in a room nobody is talking in. It
    // carries signal, none of it speech — every frame is below the gate's
    // floor, where words start — and however long it goes on it is hearing,
    // never the flat nothing a deaf device hands over.
    await harness.feed(
      _quiet,
      voiceAssistantDeafNoticeAfterV1.inMilliseconds + 2000,
    );
    expect(harness.controller.notice, isNull);
    expect(harness.controller.error, isNull);
    expect(harness.controller.active, isTrue);
    harness.controller.dispose();
  });

  test('a socket that arrives after the call ended is abandoned', () async {
    final deferred = Completer<VoiceSocket>();
    final harness = Harness(deferred: deferred);
    unawaited(harness.controller.start());
    await settle();
    await harness.controller.end(reason: 'lifecycle:paused');
    expect(harness.socket.closed, isFalse);

    deferred.complete(harness.socket);
    await settle();
    expect(harness.socket.closed, isTrue);
    expect(harness.socket.closeCode, voiceCloseAbandonedV1);
    expect(harness.socket.closeReason, 'abandoned-connect');
    harness.controller.dispose();
  });

  test('disposing a live call closes the socket as disposed', () async {
    final harness = Harness();
    await harness.live();
    harness.controller.dispose();
    await settle();
    expect(harness.socket.closed, isTrue);
    expect(harness.socket.closeCode, voiceCloseDisposedV1);
    expect(harness.socket.closeReason, 'disposed');
  });

  group('the microphone loan', () {
    test('a held microphone mutes the call and releases the device', () async {
      final harness = Harness();
      await harness.live();
      await harness.feed(_speech, 200);
      final beforeHold = harness.audioCount;
      expect(harness.capture.stops, 0);

      // Dictation borrows the microphone.
      await harness.controller.holdMicrophone(true);
      expect(harness.controller.muted, isTrue);
      expect(harness.controller.userMuted, isFalse);
      // The transcriber is billed by the second, so it sleeps for the loan.
      expect(
        harness.socket.hasControl(VoiceControlActionV1.mute, muted: true),
        isTrue,
      );
      expect(
        harness.capture.stops,
        1,
        reason: 'the device is free for the borrower',
      );

      // Giving it back restores the call: unmuted, capturing, and heard.
      await harness.controller.holdMicrophone(false);
      await settle();
      expect(harness.controller.muted, isFalse);
      expect(
        harness.socket.hasControl(VoiceControlActionV1.mute, muted: false),
        isTrue,
      );
      expect(harness.capture.starts, 2, reason: 'the stream is reopened');
      expect(harness.capture.active, isTrue);

      // And the resubscribed stream actually reaches the wire again.
      await harness.feed(_speech, 200);
      expect(harness.socket.hasOpen(mode: VoiceOpeningModeV1.wake), isTrue);
      harness.socket.completeOpen();
      await settle();
      expect(harness.audioCount, greaterThan(beforeHold));
      harness.controller.dispose();
    });

    test('a call the person muted first comes back muted', () async {
      final harness = Harness();
      await harness.live();
      harness.controller.setMuted(true);
      await settle();
      expect(harness.socket.muteAnnouncements, [true]);

      await harness.controller.holdMicrophone(true);
      await harness.controller.holdMicrophone(false);
      await settle();

      expect(harness.controller.muted, isTrue);
      expect(harness.controller.userMuted, isTrue);
      expect(harness.socket.muteAnnouncements, [
        true,
      ], reason: 'nothing was ever unmuted on their behalf');
      final beforeFrames = harness.audioCount;
      await harness.feed(_speech, 400);
      expect(harness.audioCount, beforeFrames);
      harness.controller.dispose();
    });

    test('muting during the loan survives the release', () async {
      final harness = Harness();
      await harness.live();
      await harness.controller.holdMicrophone(true);
      expect(
        harness.socket.hasControl(VoiceControlActionV1.mute, muted: true),
        isTrue,
      );

      // The person reaches for the toggle while the microphone is lent out.
      harness.controller.setMuted(true);
      await harness.controller.holdMicrophone(false);
      await settle();

      expect(harness.controller.muted, isTrue);
      expect(
        harness.socket.hasControl(VoiceControlActionV1.mute, muted: false),
        isFalse,
      );
      expect(harness.capture.active, isFalse);
      harness.controller.dispose();
    });
  });

  group('the start fence', () {
    test(
      'ending while the permission prompt is up stops the capture',
      () async {
        final harness = Harness();
        harness.capture.permission = Completer<void>();
        unawaited(harness.controller.start());
        await settle();
        expect(harness.capture.active, isFalse, reason: 'still at the prompt');

        // The person gives up on the prompt and closes the footer.
        await harness.controller.end(reason: 'end-button');
        harness.capture.permission!.complete();
        await settle();

        expect(
          harness.capture.active,
          isFalse,
          reason: 'a capture nobody is waiting for does not start recording',
        );
        expect(harness.controller.active, isFalse);

        // Anything the resurrected stream emits reaches nothing.
        harness.capture.emit(AudioFrame(pcmFrame(_speech), _speech, 0));
        await settle();
        expect(harness.socket.binaries, isEmpty);
        harness.controller.dispose();
      },
    );

    test('disposing while the permission prompt is up stops it too', () async {
      final harness = Harness();
      harness.capture.permission = Completer<void>();
      unawaited(harness.controller.start());
      await settle();

      harness.controller.dispose();
      harness.capture.permission!.complete();
      await settle();

      expect(harness.capture.active, isFalse);
      expect(harness.socket.binaries, isEmpty);
    });
  });

  test('a slow connect that still opens is kept', () async {
    final opening = Completer<VoiceSocket>();
    var attempts = 0;
    final socket = FakeVoiceSocket();
    final controller = AssistantSessionController(
      openSocket: () {
        attempts++;
        return opening.future;
      },
      capture: FakeVoiceCapture(),
      player: FakeVoicePlayer(),
      connectTimeout: const Duration(milliseconds: 200),
    );
    unawaited(controller.start());
    await Future<void>.delayed(const Duration(milliseconds: 50));
    expect(attempts, 1, reason: 'still waiting on the first upgrade');
    opening.complete(socket);
    await settle();
    expect(socket.closed, isFalse);
    expect(controller.phase, isNot(VoiceSessionPhase.error));
    controller.dispose();
  });

  test('a socket that arrives after the connect window is abandoned', () async {
    final pending = <Completer<VoiceSocket>>[];
    final socket = FakeVoiceSocket();
    final controller = AssistantSessionController(
      openSocket: () {
        final opening = Completer<VoiceSocket>();
        pending.add(opening);
        return opening.future;
      },
      capture: FakeVoiceCapture(),
      player: FakeVoicePlayer(),
      connectTimeout: const Duration(milliseconds: 20),
    );
    await controller.start();
    await settle();
    expect(pending, hasLength(1), reason: 'a timeout is not retried');
    expect(controller.phase, VoiceSessionPhase.error);

    pending.first.complete(socket);
    await settle();
    expect(socket.closed, isTrue);
    expect(socket.closeCode, voiceCloseAbandonedV1);
    expect(socket.closeReason, 'abandoned-connect');
    controller.dispose();
  });

  test('a connect that never works is an error, not a loop', () async {
    var attempts = 0;
    final controller = AssistantSessionController(
      openSocket: () {
        attempts++;
        return Future<VoiceSocket>.error(StateError('refused'));
      },
      capture: FakeVoiceCapture(),
      player: FakeVoicePlayer(),
    );
    await controller.start();
    await settle();
    expect(attempts, 2, reason: 'a refused socket is retried once');
    expect(controller.phase, VoiceSessionPhase.error);
    expect(controller.error, contains('connection'));
    controller.dispose();
  });
}
