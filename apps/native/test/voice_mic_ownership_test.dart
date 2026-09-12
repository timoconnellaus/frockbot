/// One microphone, one owner, and what each side owes the other.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/shell/composer.dart';
import 'package:frockbot_native/voice/assistant.dart';
import 'package:frockbot_native/voice/capture.dart';
import 'package:frockbot_native/voice/dictation.dart';
import 'package:frockbot_native/voice/mic_ownership.dart';
import 'package:frockbot_native/voice/protocol.dart';

import 'voice_fakes.dart';

/// A stand-in call with the two mute inputs the real one has.
class Call {
  bool live = false;
  bool userMuted = false;
  bool held = false;
  bool get muted => userMuted || held;

  /// What the server was told, in order. Only effective transitions belong
  /// here: the transcriber is billed, so it must sleep for a loan too.
  final List<bool> announced = [];
  int captureOpens = 0;
  int captureCloses = 0;

  Future<void> hold(bool value) async {
    final was = muted;
    held = value;
    if (muted == was) return;
    announced.add(muted);
    if (muted) {
      captureCloses++;
    } else {
      captureOpens++;
    }
  }

  void toggle(bool value) {
    final was = muted;
    userMuted = value;
    if (muted == was) return;
    announced.add(muted);
    if (muted) {
      captureCloses++;
    } else {
      captureOpens++;
    }
  }
}

class Stage {
  final MicOwnership microphone = MicOwnership();
  final Call call = Call();
  bool dictating = false;
  int flushes = 0;

  Stage() {
    microphone.assistantLive = () => call.live;
    microphone.holdAssistant = call.hold;
    microphone.dictationActive = () => dictating;
    microphone.stopDictation = () async {
      dictating = false;
      flushes++;
    };
  }
}

void main() {
  test('an unmuted call is muted for the loan and unmuted after it', () async {
    final stage = Stage()..call.live = true;
    await stage.microphone.acquireForDictation();
    expect(stage.microphone.owner, MicOwner.dictation);
    expect(stage.call.muted, isTrue, reason: 'the call survives, muted');
    // The transcriber is billed by the second, so the server is told.
    expect(stage.call.announced, [true]);
    expect(stage.call.captureCloses, 1);

    await stage.microphone.releaseDictation();
    expect(stage.call.muted, isFalse);
    expect(stage.call.announced, [true, false]);
    expect(stage.call.captureOpens, 1, reason: 'the microphone comes back on');
    expect(stage.microphone.owner, MicOwner.assistant);
  });

  test('a call the person muted first stays muted afterwards', () async {
    final stage = Stage()..call.live = true;
    stage.call.toggle(true);
    expect(stage.call.announced, [true]);

    await stage.microphone.acquireForDictation();
    await stage.microphone.releaseDictation();

    expect(stage.call.muted, isTrue, reason: 'their own choice is theirs');
    expect(stage.call.announced, [
      true,
    ], reason: 'no effective transition, so nothing was announced');
    expect(stage.call.captureOpens, 0);
  });

  test('muting during the loan leaves the call muted when it ends', () async {
    final stage = Stage()..call.live = true;
    await stage.microphone.acquireForDictation();
    expect(stage.call.announced, [true]);

    // The person reaches for the toggle while dictating.
    stage.call.toggle(true);
    await stage.microphone.releaseDictation();

    expect(stage.call.muted, isTrue);
    expect(stage.call.userMuted, isTrue);
    expect(stage.call.announced, [true], reason: 'it never came back on');
    expect(stage.call.captureOpens, 0);
  });

  test(
    'a call that ended while dictating is not brought back to life',
    () async {
      final stage = Stage()..call.live = true;
      await stage.microphone.acquireForDictation();
      expect(stage.call.muted, isTrue);

      stage.call.live = false;
      await stage.microphone.releaseDictation();
      expect(stage.microphone.owner, MicOwner.none);
    },
  );

  test('dictation with no call holds nothing', () async {
    final stage = Stage();
    await stage.microphone.acquireForDictation();
    expect(stage.call.muted, isFalse);
    expect(stage.call.announced, isEmpty);
    await stage.microphone.releaseDictation();
    expect(stage.microphone.owner, MicOwner.none);
  });

  test(
    'the assistant takes the microphone and flushes the dictation',
    () async {
      final stage = Stage()..dictating = true;
      await stage.microphone.acquireForAssistant();
      expect(
        stage.flushes,
        1,
        reason: 'the words already said reach the draft',
      );
      expect(stage.dictating, isFalse);
      expect(stage.microphone.owner, MicOwner.assistant);
    },
  );

  test('starting the assistant twice stops nothing twice', () async {
    final stage = Stage();
    await stage.microphone.acquireForAssistant();
    stage.call.live = true;
    await stage.microphone.acquireForAssistant();
    expect(stage.flushes, 0);
    expect(stage.microphone.owner, MicOwner.assistant);
  });

  // The blocker this covers: one device, two features. Dictation used to stop
  // the call's capture and never give it back, leaving a session that looked
  // live and heard nothing. This is the shell's own wiring, end to end.
  for (final terminal in ['error', 'final', 'connect failure']) {
    test(
      'dictation $terminal returns the device without pressing Stop',
      () async {
        final device = FakeVoiceCapture();
        final microphone = MicOwnership();
        final callSocket = FakeVoiceSocket();
        final dictationSocket = FakeVoiceSocket();
        final drafts = ComposerDraftStore();
        final call = AssistantSessionController(
          openSocket: () async => callSocket,
          capture: device,
          player: FakeVoicePlayer(),
        );
        final dictation = DictationController(
          openSocket: () async {
            if (terminal == 'connect failure') throw StateError('offline');
            return dictationSocket;
          },
          capture: device,
          onDraft: drafts.setDraft,
          readDraft: drafts.draftFor,
          onFinished: microphone.releaseDictation,
        );
        microphone.assistantLive = () => call.active;
        microphone.holdAssistant = call.holdMicrophone;
        microphone.dictationActive = () => dictation.active;
        await call.start();
        await settle();
        callSocket.deliver('{"type":"welcome","protocol_version":1}');
        callSocket.deliver('{"type":"status","status":"listening"}');
        await settle();
        await microphone.acquireForDictation();
        await dictation.start('bot-a');
        await settle();
        if (terminal != 'connect failure') {
          expect(call.muted, isTrue);
          dictationSocket.deliver(
            '{"schemaVersion":1,"type":"$terminal","message":"stopped"}',
          );
          await settle();
        }
        expect(dictation.active, isFalse);
        expect(call.muted, isFalse);
        expect(device.active, isTrue);
        expect(microphone.owner, MicOwner.assistant);
        final heard = callSocket.binaries.length;
        for (var i = 0; i < 8; i++) {
          device.emit(AudioFrame(pcmFrame(0.08), 0.08, i * 40));
        }
        await settle();
        expect(callSocket.binaries.length, greaterThan(heard));
        await call.end(reason: 'end-button');
        dictation.dispose();
        call.dispose();
      },
    );
  }

  test('a call is deaf for the loan and hears again after it', () async {
    final device = FakeVoiceCapture();
    final drafts = ComposerDraftStore();
    final callSocket = FakeVoiceSocket();
    final dictationSocket = FakeVoiceSocket();

    final call = AssistantSessionController(
      openSocket: () async => callSocket,
      capture: device,
      player: FakeVoicePlayer(),
    );
    final dictation = DictationController(
      openSocket: () async => dictationSocket,
      capture: device,
      onDraft: drafts.setDraft,
      readDraft: drafts.draftFor,
      finalTimeout: const Duration(milliseconds: 20),
    );
    // Plain statements: a cascade after a lambda binds inside the lambda.
    final microphone = MicOwnership();
    microphone.assistantLive = () => call.active;
    microphone.holdAssistant = (held) async => call.holdMicrophone(held);
    microphone.dictationActive = () => dictation.active;
    microphone.stopDictation = dictation.stop;

    await call.start();
    await settle();
    callSocket.deliver('{"type":"welcome","protocol_version":1}');
    callSocket.deliver('{"type":"status","status":"listening"}');
    await settle();

    var at = 0;
    Future<void> speak(int frames) async {
      for (var i = 0; i < frames; i++) {
        device.emit(AudioFrame(pcmFrame(0.08), 0.08, at));
        at += 40;
      }
      await settle();
    }

    await speak(5);
    expect(callSocket.binaries, isNotEmpty);
    final heardBefore = callSocket.binaries.length;

    // Dictation borrows the microphone, as the shell does it.
    await microphone.acquireForDictation();
    await dictation.start('bot-a');
    await settle();
    expect(call.muted, isTrue);
    expect(callSocket.texts, contains(encodeVoiceMuteV1(true)));

    dictationSocket.deliver('{"schemaVersion":1,"type":"ready"}');
    await settle();
    await speak(5);
    expect(dictationSocket.binaries, isNotEmpty, reason: 'dictation hears');
    expect(
      callSocket.binaries.length,
      heardBefore,
      reason: 'the call hears nothing while its microphone is lent out',
    );

    // Dictation gives it back, as the shell does it.
    dictationSocket.deliver('{"schemaVersion":1,"type":"final"}');
    await dictation.stop();
    await microphone.releaseDictation();
    await settle();

    expect(call.muted, isFalse);
    expect(callSocket.texts, contains(encodeVoiceMuteV1(false)));
    expect(device.active, isTrue, reason: 'the call reopened the device');

    await speak(5);
    expect(
      callSocket.binaries.length,
      greaterThan(heardBefore),
      reason: 'the call can hear again',
    );

    call.dispose();
    dictation.dispose();
    microphone.dispose();
  });

  test('the owner is announced, so the shell can draw it', () async {
    final stage = Stage();
    var changes = 0;
    stage.microphone.addListener(() => changes++);
    await stage.microphone.acquireForDictation();
    await stage.microphone.releaseDictation();
    expect(changes, 2);
    expect(stage.microphone.owner, MicOwner.none);
  });
}
