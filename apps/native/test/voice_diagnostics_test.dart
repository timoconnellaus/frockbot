/// The opt-in latency diagnostics, from the seams they are actually read at.
///
/// Every test here drives the real controller, the real socket query and the
/// real player callback: what is asserted is the line an operator would read
/// out of the development build's stdout, not a second construction of it.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/voice/assistant.dart';
import 'package:frockbot_native/voice/capture.dart';
import 'package:frockbot_native/voice/diagnostics.dart';
import 'package:frockbot_native/voice/player.dart';
import 'package:frockbot_native/voice/socket.dart';

import 'voice_fakes.dart';

const _trace = '6f1a2b3c-4d5e-4f60-8a1b-2c3d4e5f6071';
const _deaf = 0.0;
const _quiet = 0.0005;
const _speech = 0.08;
const _frameMs = 40;

class Harness {
  final FakeVoiceCapture capture = FakeVoiceCapture();
  final FakeVoiceSocket socket = FakeVoiceSocket();
  final FakeVoicePlayer player = FakeVoicePlayer();
  final FakeVoiceAudioRoute route = FakeVoiceAudioRoute();
  final List<String> lines = [];
  late final AssistantSessionController controller;
  int at = 0;
  int mark = 0;

  Harness({bool diagnostics = true, Completer<VoiceSocket>? deferred}) {
    controller = AssistantSessionController(
      openSocket: () => deferred?.future ?? Future.value(socket),
      capture: capture,
      player: player,
      route: route,
      diagnostics: diagnostics
          ? VoiceDiagnostics(trace: _trace, sink: lines.add)
          : null,
    );
  }

  /// Every diagnostic line, decoded. A line that is not one is a failure in
  /// itself: nothing else may be written under this prefix.
  List<Map<String, Object?>> get timings => [
    for (final line in lines)
      jsonDecode(line.substring('voice timing '.length))
          as Map<String, Object?>,
  ];

  List<String> get events => [
    for (final timing in timings) timing['event'] as String,
  ];

  Map<String, Object?> only(String event) =>
      timings.firstWhere((timing) => timing['event'] == event);

  Future<void> live() async {
    await controller.start();
    await settle();
    socket.deliver(jsonEncode({'type': 'welcome', 'protocol_version': 1}));
    socket.deliver(jsonEncode({'type': 'status', 'status': 'listening'}));
    await settle();
  }

  Future<void> feed(double level, {int frames = 1}) async {
    for (var i = 0; i < frames; i++) {
      capture.emit(AudioFrame(pcmFrame(level, mark: ++mark % 251), level, at));
      at += _frameMs;
    }
    await settle();
  }
}

void main() {
  test('a build that did not opt in has no diagnostics at all', () {
    expect(voiceDiagnosticsEnabledV1, isFalse);
    expect(voiceDiagnosticsV1(), isNull);
    expect(assistantSocketQueryV1(), {'version': '1'});
  });

  test('the socket carries the trace only when there is one', () {
    expect(
      assistantSocketQueryV1(
        diagnostics: VoiceDiagnostics(trace: _trace, sink: (_) {}),
      ),
      {'version': '1', 'trace': _trace},
    );
    // Whatever else a caller invents, the wire carries a UUID or nothing.
    expect(
      assistantSocketQueryV1(
        diagnostics: VoiceDiagnostics(trace: 'not-a-uuid', sink: (_) {}),
      ),
      {'version': '1'},
    );
    expect(isVoiceTraceIdV1(VoiceDiagnostics(sink: (_) {}).trace), isTrue);
  });

  test('a call without diagnostics writes nothing anywhere', () async {
    final printed = <String>[];
    await runZoned(
      () async {
        final harness = Harness(diagnostics: false);
        await harness.live();
        await harness.feed(_speech, frames: 4);
        harness.socket.deliver(Uint8List(320));
        await settle();
        await harness.controller.end(reason: 'hang-up');
        expect(harness.lines, isEmpty);
      },
      zoneSpecification: ZoneSpecification(
        print: (Zone self, ZoneDelegate parent, Zone zone, String line) =>
            printed.add(line),
      ),
    );
    expect(printed, isEmpty);
  });

  test('the default sink is print, which is what the build captures', () {
    final printed = <String>[];
    runZoned(
      () => VoiceDiagnostics(trace: _trace).mark('probe'),
      zoneSpecification: ZoneSpecification(
        print: (Zone self, ZoneDelegate parent, Zone zone, String line) =>
            printed.add(line),
      ),
    );
    expect(printed, hasLength(1));
    expect(printed.single, startsWith('voice timing {'));
  });

  test('one call walks the seams in order under one id', () async {
    final harness = Harness();
    await harness.live();
    expect(
      harness.events,
      containsAllInOrder([
        'controller.start',
        'route.begin',
        'route.ready',
        'capture.open',
        'capture.ready',
        'socket.welcome',
        'call.start-sent',
        'call.listening',
      ]),
    );
    // The socket is opened beside the devices, not after them.
    expect(harness.events, containsAllInOrder(['socket.open', 'socket.ready']));
    for (final timing in harness.timings) {
      expect(timing['trace'], _trace);
      expect(timing['side'], 'client');
      expect(timing['elapsedMs'], isA<int>());
      expect(
        DateTime.parse(timing['at']! as String).isUtc,
        isTrue,
        reason: 'the wall stamp is UTC so two machines compare',
      );
    }
    expect(harness.only('socket.open')['attempt'], 1);
    expect(harness.only('call.start-sent')['openingFrames'], isA<int>());
  });

  test('a held capture is bounded by its own two lines', () async {
    final harness = Harness();
    harness.capture.permission = Completer<void>();
    final starting = harness.controller.start();
    await settle();
    // The prompt is up: the microphone has been asked for and has not
    // answered, and the socket's own boundary has already landed.
    expect(harness.events, contains('capture.open'));
    expect(harness.events, isNot(contains('capture.ready')));
    expect(harness.events, contains('socket.ready'));
    harness.capture.permission!.complete();
    await starting;
    await settle();
    expect(harness.events, contains('capture.ready'));
    expect(
      harness.events.indexOf('capture.ready'),
      greaterThan(harness.events.indexOf('socket.ready')),
      reason: 'the permission prompt, not the network, was the slow part',
    );
  });

  test('a socket held open is bounded by its own two lines', () async {
    final deferred = Completer<VoiceSocket>();
    final harness = Harness(deferred: deferred);
    unawaited(harness.controller.start());
    await settle();
    expect(harness.events, contains('socket.open'));
    expect(harness.events, isNot(contains('socket.ready')));
    // The microphone is open while the upgrade is still in flight, which is
    // the whole point of starting them together.
    expect(harness.events, contains('capture.ready'));
    deferred.complete(harness.socket);
    await settle();
    expect(harness.events, contains('socket.ready'));
  });

  test('the microphone reports nothing, something and speech apart', () async {
    final harness = Harness();
    await harness.live();
    await harness.feed(_deaf, frames: 2);
    expect(harness.only('microphone.first-frame')['silent'], isTrue);
    expect(harness.events, isNot(contains('microphone.first-signal')));
    await harness.feed(_quiet, frames: 2);
    expect(harness.events, contains('microphone.first-signal'));
    expect(harness.events, isNot(contains('microphone.first-speech')));
    await harness.feed(_speech, frames: 12);
    expect(harness.events, contains('microphone.first-speech'));
    // Each is the first of its kind and nothing else: a hundred frames is
    // still one line.
    await harness.feed(_speech, frames: 20);
    expect(
      harness.events.where((event) => event == 'microphone.first-frame'),
      hasLength(1),
    );
  });

  test('the reply arrives, is fed, and is played, in order', () async {
    final harness = Harness();
    await harness.live();
    harness.socket.deliver(Uint8List(640));
    await settle();
    expect(harness.only('audio.first-down')['bytes'], 640);
    // The speaker's own seam: the controller lent the player a plain
    // callback, and these two are what a real device answers with.
    harness.player.onDiagnostic!(voicePlayerFirstFeedV1);
    harness.player.onDiagnostic!(voicePlayerFirstPlayedV1);
    harness.player.onDiagnostic!(voicePlayerFirstPlayedV1);
    expect(
      harness.events,
      containsAllInOrder([
        'audio.first-down',
        voicePlayerFirstFeedV1,
        voicePlayerFirstPlayedV1,
      ]),
    );
    expect(
      harness.events.where((event) => event == voicePlayerFirstPlayedV1),
      hasLength(1),
    );
  });

  test('the call ending, and failing, each say so once', () async {
    final harness = Harness();
    await harness.live();
    await harness.controller.end(reason: 'hang-up');
    expect(harness.only('call.end')['reason'], 'hang-up');
    // The teardown gives the speaker back: no call may go on being told
    // about a player the next one owns.
    expect(harness.player.onDiagnostic, isNull);

    final failing = Harness();
    failing.capture.failure = MicrophoneDenied('Microphone access is off.');
    await failing.controller.start();
    await settle();
    expect(failing.events, contains('call.failed'));
    expect(
      failing.lines.join('\n'),
      isNot(contains('Microphone')),
      reason: 'the sentence is for the person, not the log',
    );
  });

  test('nothing anyone said reaches a diagnostic line', () async {
    final harness = Harness();
    await harness.live();
    harness.socket.deliver(
      jsonEncode({
        'type': 'transcript',
        'role': 'user',
        'text': 'my passphrase is hunter2',
      }),
    );
    harness.socket.deliver(
      jsonEncode({'type': 'transcript_delta', 'text': 'the account number is'}),
    );
    harness.socket.deliver(
      jsonEncode({
        'type': 'error',
        'message': 'That reply named a secret nobody should log.',
      }),
    );
    await settle();
    await harness.feed(_speech, frames: 4);
    final written = harness.lines.join('\n');
    for (final forbidden in [
      'hunter2',
      'passphrase',
      'account number',
      'secret',
      'Authorization',
      'Bearer',
    ]) {
      expect(written, isNot(contains(forbidden)));
    }
    // And every key that is written is one this client named.
    const allowed = {
      'trace',
      'side',
      'event',
      'elapsedMs',
      'at',
      'attempt',
      'silent',
      'bytes',
      'openingFrames',
      'reason',
      'phase',
    };
    for (final timing in harness.timings) {
      expect(timing.keys, everyElement(isIn(allowed)));
    }
  });
}
