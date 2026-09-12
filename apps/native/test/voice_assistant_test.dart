/// The continuous voice session: the handshake, the meter, and the interrupt.
///
/// The audio policy is the thing under test. An awake upstream gets every
/// frame — OpenAI's server VAD decides where a turn ends and it needs the
/// 700 ms of silence after the words (`silence_duration_ms`) to decide it —
/// and the only thing that stops the audio is twenty
/// continuous seconds of quiet, or the person muting.
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/voice/assistant.dart';
import 'package:frockbot_native/voice/capture.dart';
import 'package:frockbot_native/voice/protocol.dart';
import 'package:frockbot_native/voice/socket.dart';

import 'voice_fakes.dart';

const _quiet = 0.0005;
const _speech = 0.08;
const _frameMs = 40;

class Harness {
  final FakeVoiceCapture capture = FakeVoiceCapture();
  final FakeVoiceSocket socket = FakeVoiceSocket();
  final FakeVoicePlayer player = FakeVoicePlayer();
  late final AssistantSessionController controller;
  int at = 0;
  int mark = 0;

  Harness({Completer<VoiceSocket>? deferred}) {
    controller = AssistantSessionController(
      openSocket: () => deferred?.future ?? Future.value(socket),
      capture: capture,
      player: player,
    );
  }

  /// Drives the handshake to `listening`, which is where a call begins.
  Future<void> live() async {
    await controller.start();
    await settle();
    socket.deliver(jsonEncode({'type': 'welcome', 'protocol_version': 1}));
    socket.deliver(
      jsonEncode({
        'type': 'audio_config',
        'format': 'pcm16',
        'sampleRate': 24000,
      }),
    );
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
  test('the handshake is welcome, hello, start_call, listening', () async {
    final harness = Harness();
    await harness.live();
    expect(harness.texts.take(2), [
      encodeAssistantHelloV1(),
      encodeAssistantStartCallV1(),
    ]);
    expect(harness.controller.status, VoiceStatusV1.listening);
    expect(harness.controller.phase, VoiceSessionPhase.live);
    expect(harness.capture.sampleRate, voiceAssistantInputSampleRateV1);
    expect(harness.capture.frame, voiceAssistantFrame);
    expect(harness.player.sampleRate, 24000);
    harness.controller.dispose();
  });

  test(
    'opening audio is held until start_call and then drained in order',
    () async {
      final deferred = Completer<VoiceSocket>();
      final harness = Harness(deferred: deferred);
      unawaited(harness.controller.start());
      await settle();
      await harness.feed(_speech, 120);
      expect(harness.audioCount, 0);

      deferred.complete(harness.socket);
      await settle();
      expect(harness.audioCount, 0, reason: 'nothing goes before start_call');

      harness.socket.deliver(
        jsonEncode({'type': 'welcome', 'protocol_version': 1}),
      );
      await settle();
      expect(harness.socket.audioMarks, [1, 2, 3]);
      harness.controller.dispose();
    },
  );

  test('an awake upstream gets every frame, pauses and all', () async {
    final harness = Harness();
    await harness.live();
    await harness.feed(_speech, 400);
    final spoken = harness.audioCount;
    expect(spoken, 10);

    // Three seconds of silence in the middle of a sentence still goes up:
    // the upstream needs it to decide the turn is over.
    await harness.feed(_quiet, 3000);
    expect(harness.audioCount, spoken + 75);

    // So does the audio while the assistant thinks and speaks.
    harness.status('thinking');
    await settle();
    await harness.feed(_quiet, 200);
    harness.status('speaking');
    await settle();
    await harness.feed(_quiet, 200);
    expect(harness.audioCount, spoken + 75 + 10);
    harness.controller.dispose();
  });

  test('twenty seconds of quiet while listening sleeps the upstream', () async {
    final harness = Harness();
    await harness.live();
    await harness.feed(_speech, 400);
    await harness.feed(_quiet, 21000);

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
    harness.controller.dispose();
  });

  test('the next onset wakes it, pre-roll first and then live', () async {
    final harness = Harness();
    await harness.live();
    await harness.feed(_quiet, 21000);
    expect(harness.controller.asleep, isTrue);
    final beforeWake = harness.audioCount;
    final wakeIndex = harness.socket.sent.length;

    // Three frames: the third is the verified onset that wakes it.
    await harness.feed(_speech, 120);
    expect(harness.controller.asleep, isFalse);
    // The wake goes out before any audio does.
    expect(harness.socket.sent[wakeIndex], encodeVoiceWakeV1());
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

  test('mute stops the frames at once and unmute waits for an onset', () async {
    final harness = Harness();
    await harness.live();
    await harness.feed(_speech, 200);
    final beforeMute = harness.audioCount;

    harness.controller.setMuted(true);
    expect(harness.texts, contains(encodeVoiceMuteV1(true)));
    await harness.feed(_speech, 400);
    expect(harness.audioCount, beforeMute);
    expect(harness.controller.muted, isTrue);

    harness.controller.setMuted(false);
    expect(harness.texts, contains(encodeVoiceMuteV1(false)));
    await harness.feed(_quiet, 400);
    expect(harness.audioCount, beforeMute, reason: 'silence does not wake it');

    await harness.feed(_speech, 200);
    expect(harness.audioCount, greaterThan(beforeMute));
    expect(harness.texts.where((t) => t == encodeVoiceWakeV1()).length, 1);
    harness.controller.dispose();
  });

  test('playback_interrupt drops everything the speaker holds', () async {
    final harness = Harness();
    await harness.live();
    harness.socket.deliver([1, 2, 3, 4]);
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
      final harness = Harness();
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

  test('ending says end_call and takes everything down', () async {
    final harness = Harness();
    await harness.live();
    await harness.controller.end(reason: 'lifecycle:paused');
    expect(harness.texts.last, encodeAssistantEndCallV1());
    expect(harness.controller.phase, VoiceSessionPhase.ended);
    expect(harness.controller.status, VoiceStatusV1.idle);
    expect(harness.capture.stops, 1);
    expect(harness.player.closed, isTrue);
    expect(harness.socket.closed, isTrue);
    expect(harness.socket.closeCode, voiceCloseNormalV1);
    expect(harness.socket.closeReason, 'lifecycle:paused');
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
      expect(harness.texts, contains(encodeVoiceMuteV1(true)));
      expect(
        harness.capture.stops,
        1,
        reason: 'the device is free for the borrower',
      );

      // Giving it back restores the call: unmuted, capturing, and heard.
      await harness.controller.holdMicrophone(false);
      await settle();
      expect(harness.controller.muted, isFalse);
      expect(harness.texts, contains(encodeVoiceMuteV1(false)));
      expect(harness.capture.starts, 2, reason: 'the stream is reopened');
      expect(harness.capture.active, isTrue);

      // And the resubscribed stream actually reaches the wire again.
      await harness.feed(_speech, 200);
      expect(harness.audioCount, greaterThan(beforeHold));
      harness.controller.dispose();
    });

    test('a call the person muted first comes back muted', () async {
      final harness = Harness();
      await harness.live();
      harness.controller.setMuted(true);
      await settle();
      final announced = harness.texts.where((t) => t.contains('voice/mute'));
      expect(announced, [encodeVoiceMuteV1(true)]);

      await harness.controller.holdMicrophone(true);
      await harness.controller.holdMicrophone(false);
      await settle();

      expect(harness.controller.muted, isTrue);
      expect(harness.controller.userMuted, isTrue);
      expect(harness.texts.where((t) => t.contains('voice/mute')), [
        encodeVoiceMuteV1(true),
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
      expect(harness.texts, contains(encodeVoiceMuteV1(true)));

      // The person reaches for the toggle while the microphone is lent out.
      harness.controller.setMuted(true);
      await harness.controller.holdMicrophone(false);
      await settle();

      expect(harness.controller.muted, isTrue);
      expect(
        harness.texts.where((t) => t == encodeVoiceMuteV1(false)),
        isEmpty,
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
        await harness.controller.end();
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
    expect(attempts, 2, reason: 'one retry, then it stops');
    expect(controller.phase, VoiceSessionPhase.error);
    expect(controller.error, contains('connection'));
    controller.dispose();
  });
}
