/// The call's audio session: begun before the microphone, ended after the
/// speaker, and what another app's claim on the audio does to the call.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/voice/assistant.dart';
import 'package:frockbot_native/voice/capture.dart';
import 'package:frockbot_native/voice/protocol.dart';
import 'package:frockbot_native/voice/route.dart';
import 'package:frockbot_native/voice/waveform.dart';

import 'voice_fakes.dart';

class _LoggedCapture extends FakeVoiceCapture {
  final List<String> log;
  _LoggedCapture(this.log);

  @override
  Future<Stream<AudioFrame>> start({
    required int sampleRate,
    required Duration frame,
    VoiceCaptureProfile profile = VoiceCaptureProfile.dictation,
  }) {
    log.add('capture.start');
    return super.start(sampleRate: sampleRate, frame: frame, profile: profile);
  }

  @override
  Future<void> stop() {
    if (active) log.add('capture.stop');
    return super.stop();
  }
}

class _LoggedPlayer extends FakeVoicePlayer {
  final List<String> log;
  _LoggedPlayer(this.log);

  @override
  Future<void> close() {
    log.add('player.close');
    return super.close();
  }
}

class _Harness {
  final log = <String>[];
  final socket = FakeVoiceSocket();
  late final capture = _LoggedCapture(log);
  late final player = _LoggedPlayer(log);
  late final route = FakeVoiceAudioRoute(log: log);
  late final controller = AssistantSessionController(
    openSocket: () async => socket,
    capture: capture,
    player: player,
    route: route,
  );

  Future<void> open() async {
    unawaited(controller.start());
    await settle();
    socket.deliver(jsonEncode({'type': 'welcome', 'protocol_version': 1}));
    await settle();
    socket.completeOpen();
    socket.deliver(jsonEncode({'type': 'status', 'status': 'listening'}));
    await settle();
  }
}

void main() {
  test('the session is begun before the microphone opens', () async {
    final h = _Harness();
    await h.open();
    expect(h.controller.phase, VoiceSessionPhase.live);
    expect(h.log.take(2), ['route.begin', 'capture.start']);
    expect(h.capture.profile, VoiceCaptureProfile.call);
    await h.controller.end(reason: 'test');
    expect(h.log.sublist(2), ['capture.stop', 'player.close', 'route.end']);
    expect(h.route.begins, 1);
    expect(h.route.ends, 1);
  });

  test('one call has one teardown, whatever ends it', () async {
    final h = _Harness();
    await h.open();
    await h.controller.end(reason: 'test');
    expect(h.log.sublist(2), ['capture.stop', 'player.close', 'route.end']);

    // The shell disposes the session it is done with. That must not close
    // the devices a second time: the next call may already hold them.
    h.controller.dispose();
    await settle();
    expect(h.log.sublist(2), ['capture.stop', 'player.close', 'route.end']);
    expect(h.route.ends, 1);
  });

  test('a session disposed before it started never ends the session', () async {
    final h = _Harness();
    // One press replaced another before either reached the platform. This
    // session never began the audio session, so its disposal may not end the
    // one the next call is about to begin.
    h.controller.dispose();
    await settle();
    expect(h.route.begins, 0);
    expect(h.route.ends, 0);
  });

  test(
    'a session disposed before it started never begins the session',
    () async {
      final h = _Harness();
      // The shell disposed it while it waited on the call before it, and the
      // start that was already on its way must leave the audio alone: a begun
      // session nobody owns is a phone left in communication mode.
      h.controller.dispose();
      await settle();
      await h.controller.start();
      await settle(6);
      expect(h.route.begins, 0);
      expect(h.route.ends, 0);
      expect(h.capture.starts, 0);
      expect(h.controller.phase, VoiceSessionPhase.idle);
    },
  );

  test('a session disposed after it began ends the session it began', () async {
    final h = _Harness();
    h.capture.permission = Completer<void>();
    unawaited(h.controller.start());
    await settle();
    // The call holds the audio session while the person is still answering
    // the permission prompt; disposing it is what gives the session back.
    expect(h.route.begins, 1);
    expect(h.route.ends, 0);
    h.controller.dispose();
    h.capture.permission!.complete();
    await settle(6);
    expect(h.route.begins, 1);
    expect(h.route.ends, 1);
    expect(h.capture.active, isFalse);
  });

  test(
    'a call answers when its devices are closed, not when it ends',
    () async {
      final h = _Harness();
      await h.open();
      final stop = Completer<void>();
      h.capture.stopGate = stop;
      final ending = h.controller.end(reason: 'test');
      await settle();
      var released = false;
      unawaited(h.controller.released.then((_) => released = true));
      await settle();
      // The shell lends the capture and the audio session to one call at a
      // time: it waits here before the next call opens them.
      expect(released, isFalse);
      expect(h.route.ends, 0);

      stop.complete();
      await ending;
      await settle();
      expect(released, isTrue);
      expect(h.route.ends, 1);
    },
  );

  test('the call that follows is never ended by the one before it', () async {
    // The capture and the audio session are the shell's, lent to one call at
    // a time — the order the shell replaces a call that is over.
    final log = <String>[];
    final capture = _LoggedCapture(log);
    final route = FakeVoiceAudioRoute(log: log);
    (AssistantSessionController, FakeVoiceSocket) call() {
      final socket = FakeVoiceSocket();
      return (
        AssistantSessionController(
          openSocket: () async => socket,
          capture: capture,
          player: _LoggedPlayer(log),
          route: route,
        ),
        socket,
      );
    }

    Future<void> open(
      AssistantSessionController controller,
      FakeVoiceSocket socket,
    ) async {
      unawaited(controller.start());
      await settle();
      socket.deliver(jsonEncode({'type': 'welcome', 'protocol_version': 1}));
      await settle();
      socket.completeOpen();
      socket.deliver(jsonEncode({'type': 'status', 'status': 'listening'}));
      await settle();
    }

    final (first, closing) = call();
    await open(first, closing);
    await first.end(reason: 'end-button');
    first.dispose();
    await first.released;

    final (second, starting) = call();
    await open(second, starting);

    expect(log, [
      'route.begin',
      'capture.start',
      'capture.stop',
      'player.close',
      'route.end',
      'route.begin',
      'capture.start',
    ]);
    expect(second.phase, VoiceSessionPhase.live);
    await second.end(reason: 'test');
  });

  test('a failed start still ends the session it began', () async {
    final h = _Harness();
    h.capture.failure = const MicrophoneDenied();
    unawaited(h.controller.start());
    await settle(6);
    expect(h.controller.phase, VoiceSessionPhase.error);
    expect(h.route.begins, 1);
    expect(h.route.ends, 1);
  });

  test('a transient claim holds the microphone and stops the reply', () async {
    final h = _Harness();
    await h.open();
    h.socket.deliver(jsonEncode({'type': 'status', 'status': 'speaking'}));
    h.socket.deliver(Uint8List.fromList([1, 2, 3, 4]));
    await settle();
    h.route.change(VoiceFocusChange.paused);
    await settle();
    expect(h.controller.muted, isTrue);
    expect(h.controller.userMuted, isFalse);
    expect(h.socket.texts, contains(encodeAssistantInterruptV1()));
    expect(h.capture.active, isFalse);
    h.route.change(VoiceFocusChange.regained);
    await settle();
    expect(h.controller.muted, isFalse);
    expect(h.capture.active, isTrue);
    expect(h.controller.phase, VoiceSessionPhase.live);
    await h.controller.end(reason: 'test');
  });

  test('a claim for good ends the call with a sentence', () async {
    final h = _Harness();
    await h.open();
    h.route.change(VoiceFocusChange.lost);
    await settle(6);
    expect(h.controller.phase, VoiceSessionPhase.error);
    expect(h.controller.error, contains('Another app took the audio'));
    expect(h.route.ends, 1);
  });

  test('the meter mode follows the call', () async {
    final h = _Harness();
    expect(h.controller.meterMode, VoiceMeterMode.resting);
    unawaited(h.controller.start());
    expect(h.controller.meterMode, VoiceMeterMode.connecting);
    await settle();
    h.socket.deliver(jsonEncode({'type': 'welcome', 'protocol_version': 1}));
    await settle();
    h.socket.completeOpen();
    h.socket.deliver(jsonEncode({'type': 'status', 'status': 'listening'}));
    await settle();
    expect(h.controller.meterMode, VoiceMeterMode.listening);
    h.socket.deliver(jsonEncode({'type': 'status', 'status': 'thinking'}));
    await settle();
    expect(h.controller.meterMode, VoiceMeterMode.thinking);
    h.socket.deliver(jsonEncode({'type': 'status', 'status': 'speaking'}));
    await settle();
    expect(h.controller.meterMode, VoiceMeterMode.speaking);
    h.controller.setMuted(true);
    await settle();
    expect(h.controller.meterMode, VoiceMeterMode.muted);
    await h.controller.end(reason: 'test');
    expect(h.controller.meterMode, VoiceMeterMode.resting);
  });

  test('the socket is opened while the permission prompt is still up, and '
      'the handshake waits for the microphone', () async {
    final h = _Harness();
    h.capture.permission = Completer<void>();
    unawaited(h.controller.start());
    await settle();
    h.socket.deliver(jsonEncode({'type': 'welcome', 'protocol_version': 1}));
    await settle();
    // Welcomed, but the microphone is not open: nothing metered has started.
    expect(h.socket.texts, isEmpty);
    h.capture.permission!.complete();
    await settle();
    expect(h.socket.texts.first, encodeAssistantHelloV1());
    expect(h.socket.hasOpen(mode: VoiceOpeningModeV1.start), isTrue);
    await h.controller.end(reason: 'test');
  });
}
