/// The energy gate: when someone started, and when the room went quiet.
///
/// The gate answers two questions and no others — wake and barge-in — so
/// these are the tests for those two and for the pre-roll that makes a wake
/// worth having.
library;

import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/voice/speech_gate.dart';

import 'voice_fakes.dart';

const _frame = Duration(milliseconds: 40);
const _quiet = 0.0005;
const _speech = 0.05;

/// A gate that has heard enough of a quiet room to know what quiet is.
({SpeechGate gate, int at}) settledGate({SpeechGateConfig? config}) {
  final gate = SpeechGate(config: config ?? const SpeechGateConfig());
  var at = 0;
  for (var i = 0; i < 25; i++) {
    gate.offer(pcmFrame(_quiet), _quiet, at);
    at += _frame.inMilliseconds;
  }
  return (gate: gate, at: at);
}

void main() {
  group('onset', () {
    test('needs consecutive loud frames, not one loud moment', () {
      var (:gate, :at) = settledGate();
      // A single knock is not an onset, whatever the noise floor thinks.
      var decision = gate.offer(pcmFrame(_speech), _speech, at);
      at += 40;
      expect(decision.onset, isFalse);
      expect(decision.open, isFalse);

      decision = gate.offer(pcmFrame(_quiet), _quiet, at);
      at += 40;
      expect(decision.open, isFalse);

      for (var i = 0; i < 2; i++) {
        decision = gate.offer(pcmFrame(_speech), _speech, at);
        at += 40;
        expect(decision.onset, isFalse, reason: 'frame $i of 3');
      }
      decision = gate.offer(pcmFrame(_speech), _speech, at);
      expect(decision.onset, isTrue);
      expect(decision.open, isTrue);
    });

    test('replays the pre-roll in order, and never a frame twice', () {
      var (:gate, :at) = settledGate();
      final emitted = <int>[];
      var mark = 1;
      // Half a second of room tone, then speech. The room tone is what the
      // wake replays: the first syllable is inside it.
      for (var i = 0; i < 20; i++) {
        gate.offer(pcmFrame(_quiet, mark: mark), _quiet, at);
        mark++;
        at += 40;
      }
      final beforeOnset = mark;
      SpeechGateDecision? onset;
      for (var i = 0; i < 4; i++) {
        final decision = gate.offer(pcmFrame(_speech, mark: mark), _speech, at);
        mark++;
        at += 40;
        emitted.addAll(decision.emit.map((frame) => frame.first));
        if (decision.onset) {
          onset = decision;
          break;
        }
      }
      expect(onset, isNotNull);
      // 500 ms of pre-roll at 40 ms is thirteen frames, the newest of which
      // is the frame that opened the gate.
      expect(onset!.emit.length, 13);
      expect(emitted.last, mark - 1);
      // In order, contiguous, and reaching back before the first loud frame.
      expect(emitted, List<int>.generate(13, (i) => emitted.first + i));
      expect(emitted.first, lessThan(beforeOnset));
      expect(emitted.toSet().length, emitted.length);

      // Nothing already emitted comes back on the next frame.
      final next = gate.offer(pcmFrame(_speech, mark: mark), _speech, at);
      expect(next.emit.map((frame) => frame.first), [mark]);
    });
  });

  group('hangover', () {
    test('streams through a 600 ms pause and closes after 900 ms', () {
      var (:gate, :at) = settledGate();
      for (var i = 0; i < 5; i++) {
        gate.offer(pcmFrame(_speech), _speech, at);
        at += 40;
      }
      expect(gate.open, isTrue);
      final openedAt = at;
      final lastWordAt = at - 40;

      // A breath in the middle of a sentence: still open, still emitting.
      while (at - openedAt < 600) {
        final decision = gate.offer(pcmFrame(_quiet), _quiet, at);
        at += 40;
        expect(decision.open, isTrue, reason: '${at - openedAt} ms into the pause');
        expect(decision.emit, hasLength(1));
      }

      var closedAt = 0;
      while (gate.open && at - openedAt < 4000) {
        final decision = gate.offer(pcmFrame(_quiet), _quiet, at);
        if (decision.closed) closedAt = at;
        at += 40;
      }
      expect(gate.open, isFalse);
      // The hangover is measured from the last loud frame, not from the
      // first quiet one.
      expect(closedAt - lastWordAt, inInclusiveRange(900, 940));
      // A closed gate emits nothing at all.
      expect(gate.offer(pcmFrame(_quiet), _quiet, at).emit, isEmpty);
    });

    test('reports how long it has been quiet, for the sleep policy', () {
      var (:gate, :at) = settledGate();
      for (var i = 0; i < 5; i++) {
        gate.offer(pcmFrame(_speech), _speech, at);
        at += 40;
      }
      while (gate.open) {
        gate.offer(pcmFrame(_quiet), _quiet, at);
        at += 40;
      }
      final closed = at;
      for (var i = 0; i < 100; i++) {
        gate.offer(pcmFrame(_quiet), _quiet, at);
        at += 40;
      }
      expect(gate.quietForMs(at), at - closed + 40);
    });
  });

  group('barge-in', () {
    test('is stricter than the onset and needs to hold', () {
      var (:gate, :at) = settledGate();
      // Loud enough to open the gate, not loud enough to interrupt a reply.
      const modest = 0.02;
      for (var i = 0; i < 10; i++) {
        final decision = gate.offer(pcmFrame(modest), modest, at);
        at += 40;
        expect(decision.bargeIn, isFalse);
      }
      expect(gate.open, isTrue);

      const loud = 0.2;
      final marks = <bool>[];
      for (var i = 0; i < 6; i++) {
        marks.add(gate.offer(pcmFrame(loud), loud, at).bargeIn);
        at += 40;
      }
      // 200 ms at 40 ms is five frames; the fifth is the first that counts.
      expect(marks.take(4), everyElement(isFalse));
      expect(marks[4], isTrue);
    });
  });

  test('the RMS of a silent frame is zero and of a full-scale one is one', () {
    expect(pcm16Rms(Uint8List(64)), 0);
    expect(pcm16Rms(pcmFrame(0.5)), closeTo(0.5, 0.01));
    // An odd trailing byte is not half a sample.
    expect(pcm16Rms(Uint8List.fromList([0, 0, 7])), 0);
  });
}
