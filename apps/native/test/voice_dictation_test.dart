/// Composer dictation: the opening words, the commit, and whose draft it is.
///
/// The draft binding is the rule worth the most here. A capture belongs to
/// the Bot it started on, so a segment that arrives after the person has
/// switched Bots must still land in the first Bot's composer — never in the
/// one that happens to be open.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/shell/composer.dart';
import 'package:frockbot_native/voice/capture.dart';
import 'package:frockbot_native/voice/dictation.dart';
import 'package:frockbot_native/voice/protocol.dart';
import 'package:frockbot_native/voice/socket.dart';

import 'voice_fakes.dart';

String frame(String type, [Map<String, Object?> extra = const {}]) =>
    jsonEncode({'schemaVersion': 1, 'type': type, ...extra});

class Harness {
  final FakeVoiceCapture capture = FakeVoiceCapture();
  final FakeVoiceSocket socket = FakeVoiceSocket();
  final ComposerDraftStore drafts = ComposerDraftStore();
  Completer<VoiceSocket>? pending;
  late final DictationController controller;

  Harness({
    bool deferSocket = false,
    Duration? finalTimeout,
    Duration? cleanupTimeout,
  }) {
    if (deferSocket) pending = Completer<VoiceSocket>();
    controller = DictationController(
      openSocket: () => pending?.future ?? Future.value(socket),
      capture: capture,
      onDraft: drafts.setDraft,
      readDraft: drafts.draftFor,
      finalTimeout: finalTimeout ?? voiceDictationFinalTimeoutV1,
      cleanupTimeout: cleanupTimeout ?? voiceDictationCleanupTimeoutV1,
    );
  }

  void open() => pending?.complete(socket);
  void say(String type, [Map<String, Object?> extra = const {}]) =>
      socket.deliver(frame(type, extra));
  void speak(int mark, {int atMs = 0}) =>
      capture.emit(AudioFrame(pcmFrame(0.05, mark: mark), 0.05, atMs));
}

void main() {
  test('captures at the rate and frame the protocol names', () async {
    final harness = Harness();
    await harness.controller.start('bot-a');
    await settle();
    expect(harness.capture.sampleRate, voiceDictationSampleRateV1);
    expect(harness.capture.frame, voiceDictationFrame);
    expect(harness.socket.texts.first, frame('start', {'sampleRate': 24000}));
    harness.controller.dispose();
  });

  test(
    'holds the opening audio and delivers it in order after ready',
    () async {
      final harness = Harness(deferSocket: true);
      unawaited(harness.controller.start('bot-a'));
      await settle();
      // Capture runs before the socket does: these are the first words, said
      // while the connection was still being made.
      harness.speak(1);
      harness.speak(2);
      harness.speak(3);
      await settle();
      expect(harness.socket.binaries, isEmpty);

      harness.open();
      await settle();
      // The server buffers anything sent before `ready`, but the client holds
      // it anyway so the order it arrives in is the order it was said in.
      expect(harness.socket.binaries, isEmpty);
      expect(harness.socket.texts, [
        frame('start', {'sampleRate': 24000}),
      ]);

      harness.say('ready');
      await settle();
      expect(harness.socket.audioMarks, [1, 2, 3]);

      harness.speak(4);
      await settle();
      expect(harness.socket.audioMarks, [1, 2, 3, 4]);
      harness.controller.dispose();
    },
  );

  test('a stop before ready still commits and finalizes', () async {
    final harness = Harness();
    await harness.controller.start('bot-a');
    await settle();
    harness.speak(1);
    harness.speak(2);
    await settle();

    final stopped = harness.controller.stop();
    await settle();
    expect(harness.socket.audioMarks, [1, 2]);
    expect(harness.socket.texts.last, frame('stop'));
    expect(harness.controller.state, DictationState.stopping);

    harness.say('segment', {'text': 'commit this'});
    await settle();
    await stopped;
    expect(harness.controller.state, DictationState.cleaning);
    expect(harness.drafts.draftFor('bot-a'), 'commit this');
    harness.say('final');
    await settle();
    expect(harness.controller.state, DictationState.done);
    expect(harness.capture.stops, greaterThan(0));
    harness.controller.dispose();
  });

  test('live captions stay off the draft until stop lands a segment', () async {
    final harness = Harness();
    await harness.controller.start('bot-a');
    await settle();
    harness.say('ready');
    harness.say('delta', {'text': 'and a se'});
    harness.say('delta', {'text': 'and a second'});
    await settle();
    // Held internally so a waveform is not also a half-written sentence.
    expect(harness.controller.text, 'and a second');
    expect(harness.drafts.draftFor('bot-a'), '');

    final stopped = harness.controller.stop();
    await settle();
    expect(harness.drafts.draftFor('bot-a'), isEmpty);
    expect(harness.controller.state, DictationState.stopping);

    harness.say('segment', {'text': 'and a second thought'});
    await settle();
    await stopped;
    expect(harness.controller.state, DictationState.cleaning);
    expect(harness.controller.active, isFalse);
    expect(harness.drafts.draftFor('bot-a'), 'and a second thought');
    harness.controller.dispose();
  });

  test('the overlay is capturing as soon as the microphone is open', () async {
    final harness = Harness(deferSocket: true);
    await harness.controller.start('bot-a');
    await settle();
    expect(harness.controller.state, DictationState.capturing);
    expect(harness.controller.elapsed.value.inSeconds, 0);
    harness.controller.dispose();
  });

  test(
    'text that arrives after a Bot switch goes to the original Bot',
    () async {
      final harness = Harness();
      await harness.controller.start('bot-a');
      await settle();
      harness.say('ready');
      await settle();

      // The person moves to another Bot while the words are still in flight.
      harness.drafts.setDraft('bot-b', 'typed into B');
      unawaited(harness.controller.stop());
      await settle();
      harness.say('segment', {'text': 'said into A'});
      await settle();

      expect(harness.drafts.draftFor('bot-a'), 'said into A');
      expect(harness.drafts.draftFor('bot-b'), 'typed into B');
      expect(harness.controller.context, 'bot-a');
      harness.controller.dispose();
    },
  );

  test('an error keeps the words that already arrived', () async {
    final harness = Harness();
    await harness.controller.start('bot-a');
    await settle();
    harness.say('ready');
    harness.say('segment', {'text': 'half a thought'});
    await settle();
    expect(harness.drafts.draftFor('bot-a'), isEmpty);

    harness.say('error', {
      'message': 'the upstream went away',
      'code': 'upstream',
    });
    await settle();
    expect(harness.controller.state, DictationState.error);
    expect(harness.controller.error, 'the upstream went away');
    // An error flushes what was held, so a failed stop still keeps the words.
    expect(harness.drafts.draftFor('bot-a'), 'half a thought');
    expect(harness.socket.closed, isTrue);
    harness.controller.dispose();
  });

  test('a final that never comes resolves on the bounded wait', () async {
    // The bound is six seconds on the wire; the test uses a short one so it
    // proves the timeout resolves rather than how long a person waits.
    expect(voiceDictationFinalTimeoutV1, const Duration(seconds: 6));
    final harness = Harness(finalTimeout: const Duration(milliseconds: 20));
    await harness.controller.start('bot-a');
    await settle();
    harness.say('ready');
    harness.say('segment', {'text': 'never acknowledged'});
    await settle();
    expect(harness.drafts.draftFor('bot-a'), isEmpty);

    await harness.controller.stop();
    expect(harness.controller.state, DictationState.done);
    expect(harness.controller.error, isNull);
    expect(harness.drafts.draftFor('bot-a'), 'never acknowledged');
    harness.controller.dispose();
  });

  test('a refused microphone says what to do about it', () async {
    final harness = Harness();
    harness.capture.failure = const MicrophoneDenied();
    await harness.controller.start('bot-a');
    await settle();
    expect(harness.controller.state, DictationState.error);
    expect(harness.controller.error, contains('microphone'));
    harness.controller.dispose();
  });

  test('cancel abandons the capture and sends no stop', () async {
    final harness = Harness();
    await harness.controller.start('bot-a');
    await settle();
    harness.say('ready');
    await settle();
    await harness.controller.cancel();
    expect(harness.socket.texts, isNot(contains(frame('stop'))));
    expect(harness.socket.closed, isTrue);
    expect(harness.controller.active, isFalse);
    harness.controller.dispose();
  });

  test('discard takes the capture\'s words back out of the draft', () async {
    final harness = Harness();
    harness.drafts.setDraft('bot-a', 'typed first');
    await harness.controller.start('bot-a');
    await settle();
    harness.say('ready');
    await settle();
    unawaited(harness.controller.stop());
    await settle();
    harness.say('segment', {'text': 'and a thought'});
    await settle();
    expect(harness.drafts.draftFor('bot-a'), 'typed first and a thought');
    await harness.controller.discard();
    expect(harness.drafts.draftFor('bot-a'), 'typed first');
    expect(harness.controller.active, isFalse);
    harness.controller.dispose();
  });

  test('a stop while the socket is still connecting still commits', () async {
    // The blocker this covers: a capture whose socket had not finished
    // opening when Stop was pressed used to be thrown away, opening audio and
    // all. The words were said; they belong in the draft.
    final harness = Harness(deferSocket: true);
    unawaited(harness.controller.start('bot-a'));
    await settle();
    harness.speak(1);
    harness.speak(2);
    harness.speak(3);
    await settle();
    expect(harness.socket.sent, isEmpty, reason: 'there is no socket yet');

    final stopped = harness.controller.stop();
    await settle();
    expect(harness.controller.state, DictationState.stopping);
    expect(harness.socket.sent, isEmpty, reason: 'still no socket');

    // The socket finally opens, after Stop.
    harness.open();
    await settle();
    expect(harness.socket.texts.first, frame('start', {'sampleRate': 24000}));
    expect(harness.socket.audioMarks, [1, 2, 3]);
    expect(harness.socket.texts.last, frame('stop'));

    harness.say('segment', {'text': 'said before it connected'});
    await settle();
    await stopped;
    expect(harness.controller.state, DictationState.cleaning);
    expect(harness.drafts.draftFor('bot-a'), 'said before it connected');
    harness.say('final');
    await settle();
    expect(harness.controller.state, DictationState.done);
    harness.controller.dispose();
  });

  test('a stop that outlives the connect is still bounded', () async {
    final harness = Harness(
      deferSocket: true,
      finalTimeout: const Duration(milliseconds: 20),
    );
    unawaited(harness.controller.start('bot-a'));
    await settle();
    harness.speak(1);
    await settle();

    // The socket never opens at all. Stop still resolves.
    await harness.controller.stop();
    expect(harness.controller.state, DictationState.done);
    harness.controller.dispose();
  });

  test(
    'Stop before permission resolves never subscribes to late audio',
    () async {
      final harness = Harness();
      harness.capture.permission = Completer<void>();
      final started = harness.controller.start('bot-a');
      await settle();
      final stopped = harness.controller.stop();
      await settle();
      harness.capture.permission!.complete();
      await started;
      await stopped;
      expect(harness.capture.active, isFalse);
      expect(harness.controller.state, DictationState.done);
      expect(harness.socket.texts, isEmpty);
      harness.capture.emit(AudioFrame(pcmFrame(0.05), 0.05, 0));
      await settle();
      expect(harness.socket.binaries, isEmpty);
      harness.controller.dispose();
    },
  );

  group('the start fence', () {
    test(
      'cancelling at the permission prompt stops the late capture',
      () async {
        final harness = Harness();
        harness.capture.permission = Completer<void>();
        unawaited(harness.controller.start('bot-a'));
        await settle();
        expect(harness.capture.active, isFalse);

        await harness.controller.cancel();
        harness.capture.permission!.complete();
        await settle();

        expect(
          harness.capture.active,
          isFalse,
          reason: 'a capture nobody is waiting for does not start recording',
        );
        harness.capture.emit(AudioFrame(pcmFrame(0.05), 0.05, 0));
        await settle();
        expect(harness.socket.binaries, isEmpty);
        expect(harness.controller.active, isFalse);
        harness.controller.dispose();
      },
    );

    test('disposing at the permission prompt stops it too', () async {
      final harness = Harness();
      harness.capture.permission = Completer<void>();
      unawaited(harness.controller.start('bot-a'));
      await settle();

      harness.controller.dispose();
      harness.capture.permission!.complete();
      await settle();

      expect(harness.capture.active, isFalse);
      expect(harness.socket.binaries, isEmpty);
    });
  });

  // The tidy-up the server runs once a capture is finished. Everything here
  // is about the same question asked from different directions: can the
  // tidied text ever cost the person words they already have?
  group('the tidy-up after a capture', () {
    /// A finished capture whose span holds the tidied text.
    Future<Harness> tidied() async {
      final harness = Harness();
      await harness.controller.start('bot-a');
      await settle();
      harness.say('ready');
      harness.say('segment', {'text': 'um so check the Friday flights'});
      await settle();
      unawaited(harness.controller.stop());
      await settle();
      harness.say('cleaning');
      harness.say('cleaned', {'text': 'Check the Friday flights.'});
      harness.say('final');
      await settle();
      expect(harness.drafts.draftFor('bot-a'), 'Check the Friday flights.');
      return harness;
    }

    test(
      'replaces the capture\'s own span and leaves the rest alone',
      () async {
        final harness = Harness();
        harness.drafts.setDraft('bot-a', 'typed first');
        await harness.controller.start('bot-a');
        await settle();
        harness.say('ready');
        harness.say('segment', {'text': 'um so check the Friday flights'});
        await settle();
        expect(harness.drafts.draftFor('bot-a'), 'typed first');

        // A `cleaning` that arrives while the person is still speaking is not a
        // capture that has finished, and is ignored.
        harness.say('cleaning');
        await settle();
        expect(harness.controller.state, DictationState.capturing);
        expect(harness.drafts.draftFor('bot-a'), 'typed first');

        unawaited(harness.controller.stop());
        await settle();
        harness.say('cleaning');
        await settle();
        expect(harness.controller.state, DictationState.cleaning);
        expect(harness.controller.active, isFalse);
        expect(
          harness.drafts.draftFor('bot-a'),
          'typed first um so check the Friday flights',
        );

        harness.say('cleaned', {'text': 'Check the Friday flights.'});
        harness.say('final');
        await settle();

        expect(
          harness.drafts.draftFor('bot-a'),
          'typed first Check the Friday flights.',
        );
        expect(harness.controller.cleaned, isTrue);
        harness.controller.dispose();
      },
    );

    test('the raw transcript comes back on revert', () async {
      final harness = Harness();
      await harness.controller.start('bot-a');
      await settle();
      harness.say('ready');
      harness.say('segment', {'text': 'um so check the Friday flights'});
      await settle();
      unawaited(harness.controller.stop());
      await settle();
      harness.say('cleaning');
      harness.say('cleaned', {'text': 'Check the Friday flights.'});
      harness.say('final');
      await settle();
      expect(harness.drafts.draftFor('bot-a'), 'Check the Friday flights.');

      harness.controller.revertCleanup();
      expect(
        harness.drafts.draftFor('bot-a'),
        'um so check the Friday flights',
      );
      // Reverted once; there is nothing left to revert to.
      expect(harness.controller.cleaned, isFalse);
      harness.controller.revertCleanup();
      expect(
        harness.drafts.draftFor('bot-a'),
        'um so check the Friday flights',
      );
      harness.controller.dispose();
    });

    // The rule that matters most. Somebody who starts editing their own words
    // has taken the draft back; a tidy-up that lands afterwards must not take
    // it off them again.
    test('an edit inside the span refuses the tidied text', () async {
      final harness = Harness();
      await harness.controller.start('bot-a');
      await settle();
      harness.say('ready');
      harness.say('segment', {'text': 'um so check the Friday flights'});
      await settle();
      unawaited(harness.controller.stop());
      await settle();
      harness.say('cleaning');
      await settle();

      // They fix it themselves while the server is still tidying.
      harness.drafts.setDraft('bot-a', 'check the SATURDAY flights');
      harness.say('cleaned', {'text': 'Check the Friday flights.'});
      harness.say('final');
      await settle();

      expect(harness.drafts.draftFor('bot-a'), 'check the SATURDAY flights');
      expect(harness.controller.cleaned, isFalse);
      harness.controller.dispose();
    });

    // Send clears the composer. A tidy-up that arrives after that must not
    // put a message back into a field the person has emptied.
    test('a tidy-up that arrives after Send restores nothing', () async {
      final harness = Harness();
      await harness.controller.start('bot-a');
      await settle();
      harness.say('ready');
      harness.say('segment', {'text': 'um so check the Friday flights'});
      await settle();
      unawaited(harness.controller.stop());
      await settle();
      harness.say('cleaning');
      await settle();

      // Sent: the composer is empty and the capture's span is gone with it.
      harness.drafts.setDraft('bot-a', '');
      harness.say('cleaned', {'text': 'Check the Friday flights.'});
      harness.say('final');
      await settle();

      expect(harness.drafts.draftFor('bot-a'), '');
      harness.controller.dispose();
    });

    // The offer has to be withdrawn by the draft itself. Once the capture is
    // over nothing writes again, so a fence that only closes on the next write
    // would leave "Use what I said" drawn over a span that is no longer there.
    test('an edit inside the tidied span withdraws the revert offer', () async {
      final harness = await tidied();
      expect(harness.controller.cleaned, isTrue);

      harness.drafts.setDraft('bot-a', 'Check the SATURDAY flights.');
      expect(harness.controller.cleaned, isFalse);

      harness.controller.revertCleanup();
      expect(harness.drafts.draftFor('bot-a'), 'Check the SATURDAY flights.');
      harness.controller.dispose();
    });

    test('sending the draft withdraws the revert offer', () async {
      final harness = await tidied();
      harness.drafts.setDraft('bot-a', '');
      expect(harness.controller.cleaned, isFalse);

      harness.controller.revertCleanup();
      expect(harness.drafts.draftFor('bot-a'), '');
      harness.controller.dispose();
    });

    // Typing after the tidied text is not editing it: the span is still there,
    // so the offer stands and revert swaps only what the capture owns.
    test('typing after the tidied text keeps the revert offer', () async {
      final harness = await tidied();
      harness.drafts.setDraft(
        'bot-a',
        'Check the Friday flights. and the hotel',
      );
      expect(harness.controller.cleaned, isTrue);

      harness.controller.revertCleanup();
      expect(
        harness.drafts.draftFor('bot-a'),
        'um so check the Friday flights and the hotel',
      );
      harness.controller.dispose();
    });

    // A tidy-up belongs to the Bot the capture started on, exactly as every
    // segment does.
    test(
      'the tidied text lands in the composer it was dictated into',
      () async {
        final harness = Harness();
        await harness.controller.start('bot-a');
        await settle();
        harness.say('ready');
        harness.say('segment', {'text': 'um so check the Friday flights'});
        await settle();
        unawaited(harness.controller.stop());
        await settle();
        harness.drafts.setDraft('bot-b', 'typed into B');
        harness.say('cleaning');
        harness.say('cleaned', {'text': 'Check the Friday flights.'});
        harness.say('final');
        await settle();

        expect(harness.drafts.draftFor('bot-a'), 'Check the Friday flights.');
        expect(harness.drafts.draftFor('bot-b'), 'typed into B');
        harness.controller.dispose();
      },
    );

    // A server that says it is tidying and then goes quiet must not leave the
    // microphone button looking busy for the rest of the session.
    test(
      'a tidy-up that never answers ends the capture on what arrived',
      () async {
        final harness = Harness(
          finalTimeout: const Duration(milliseconds: 20),
          cleanupTimeout: const Duration(milliseconds: 40),
        );
        await harness.controller.start('bot-a');
        await settle();
        harness.say('ready');
        harness.say('segment', {'text': 'um so check the Friday flights'});
        await settle();
        unawaited(harness.controller.stop());
        await settle();
        harness.say('cleaning');
        await settle();
        expect(harness.controller.state, DictationState.cleaning);
        expect(harness.controller.active, isFalse);
        expect(
          harness.drafts.draftFor('bot-a'),
          'um so check the Friday flights',
        );

        await Future<void>.delayed(const Duration(milliseconds: 80));
        await settle();

        expect(harness.controller.state, DictationState.done);
        expect(harness.controller.error, isNull);
        expect(
          harness.drafts.draftFor('bot-a'),
          'um so check the Friday flights',
        );
        harness.controller.dispose();
      },
    );

    // Cleaning has already given the microphone back. A leftover `final` from
    // Groq must not stop whoever opened the shared device next — Talk, or
    // another dictation.
    test(
      'a leftover tidy-up does not stop a later owner of the microphone',
      () async {
        final harness = Harness();
        await harness.controller.start('bot-a');
        await settle();
        harness.say('ready');
        harness.say('segment', {'text': 'first take'});
        await settle();
        unawaited(harness.controller.stop());
        await settle();
        harness.say('cleaning');
        await settle();
        expect(harness.controller.state, DictationState.cleaning);
        expect(harness.controller.active, isFalse);
        expect(harness.capture.active, isFalse);

        await harness.capture.start(
          sampleRate: voiceDictationSampleRateV1,
          frame: voiceDictationFrame,
        );
        expect(harness.capture.active, isTrue);
        final stops = harness.capture.stops;

        harness.say('cleaned', {'text': 'First take.'});
        harness.say('final');
        await settle();

        expect(harness.controller.state, DictationState.done);
        expect(harness.capture.active, isTrue);
        expect(harness.capture.stops, stops);
        expect(harness.drafts.draftFor('bot-a'), 'First take.');
        harness.controller.dispose();
      },
    );

    // Pressing the mic again during a tidy-up used to let the leftover
    // `final` finish the new capture: increment generation, stop the
    // device, and release the microphone the new start had just taken.
    test(
      'starting during a tidy-up is not finished by the leftover session',
      () async {
        var releases = 0;
        late FakeVoiceSocket socket;
        socket = FakeVoiceSocket();
        final capture = FakeVoiceCapture();
        final drafts = ComposerDraftStore();
        final controller = DictationController(
          openSocket: () async => socket,
          capture: capture,
          onDraft: drafts.setDraft,
          readDraft: drafts.draftFor,
          onFinished: () async {
            releases++;
          },
        );
        await controller.start('bot-a');
        await settle();
        socket.deliver(frame('ready'));
        socket.deliver(frame('segment', {'text': 'first take'}));
        await settle();
        unawaited(controller.stop());
        await settle();
        socket.deliver(frame('cleaning'));
        await settle();
        expect(controller.state, DictationState.cleaning);
        expect(releases, 1);

        final leftover = socket;
        socket = FakeVoiceSocket();
        leftover.deliver(frame('final'));
        await controller.start('bot-a');
        await settle();

        expect(controller.state, DictationState.capturing);
        expect(controller.active, isTrue);
        expect(capture.active, isTrue);
        expect(releases, 1);
        expect(drafts.draftFor('bot-a'), 'first take');
        controller.dispose();
      },
    );

    // A new capture is a new span. Nothing from the last one may be reverted
    // into it.
    test('a new capture clears what the last one could revert to', () async {
      final harness = Harness();
      await harness.controller.start('bot-a');
      await settle();
      harness.say('ready');
      harness.say('segment', {'text': 'um so check the Friday flights'});
      await settle();
      unawaited(harness.controller.stop());
      await settle();
      harness.say('cleaning');
      harness.say('cleaned', {'text': 'Check the Friday flights.'});
      harness.say('final');
      await settle();
      expect(harness.controller.cleaned, isTrue);

      await harness.controller.start('bot-a');
      await settle();
      expect(harness.controller.cleaned, isFalse);
      harness.controller.dispose();
    });
  });

  group('the draft a capture owns', () {
    test('what was typed before the capture stays in front of it', () async {
      final harness = Harness();
      harness.drafts.setDraft('bot-a', 'typed first');
      await harness.controller.start('bot-a');
      await settle();
      harness.say('ready');
      unawaited(harness.controller.stop());
      await settle();
      harness.say('segment', {'text': 'and then said'});
      await settle();
      expect(harness.drafts.draftFor('bot-a'), 'typed first and then said');
      harness.controller.dispose();
    });

    test('what is typed after the words land is not written over', () async {
      final harness = Harness();
      harness.drafts.setDraft('bot-a', 'typed first');
      await harness.controller.start('bot-a');
      await settle();
      harness.say('ready');
      unawaited(harness.controller.stop());
      await settle();
      harness.say('segment', {'text': 'said'});
      await settle();
      expect(harness.drafts.draftFor('bot-a'), 'typed first said');

      // The person types on the end while the tidy-up is still coming.
      harness.drafts.setDraft('bot-a', 'typed first said and typed more');
      harness.say('cleaned', {'text': 'Said.'});
      harness.say('final');
      await settle();
      expect(
        harness.drafts.draftFor('bot-a'),
        'typed first Said. and typed more',
      );
      harness.controller.dispose();
    });

    test('an edit inside the landed transcript refuses the tidy-up', () async {
      final harness = Harness();
      await harness.controller.start('bot-a');
      await settle();
      harness.say('ready');
      unawaited(harness.controller.stop());
      await settle();
      harness.say('segment', {'text': 'recognised wrongly'});
      await settle();

      // The person corrects the transcription itself. Its span is gone, so
      // swapping in the tidy-up would lose their correction.
      harness.drafts.setDraft('bot-a', 'recognised rightly');
      harness.say('cleaned', {'text': 'Recognised wrongly.'});
      harness.say('final');
      await settle();
      expect(harness.drafts.draftFor('bot-a'), 'recognised rightly');
      harness.controller.dispose();
    });
  });

  group('the range itself', () {
    test('composes around its own span, once', () {
      final range = DictationDraftRange(before: 'before', after: 'after');
      expect(range.next('beforeafter', 'said'), 'before said after');
      expect(
        range.next('before said after', 'said more'),
        'before said more after',
      );
    });

    test('an empty transcript is the draft without it', () {
      final range = DictationDraftRange(before: 'kept');
      expect(range.next('kept', ''), 'kept');
    });

    test('fences once its span cannot be found, and stays fenced', () {
      final range = DictationDraftRange();
      expect(range.next('', 'one'), 'one');
      expect(range.next('something else entirely', 'one two'), isNull);
      expect(range.fenced, isTrue);
      expect(range.next('one', 'one two three'), isNull);
    });
  });

  group('the frame re-chunker', () {
    test('cuts an arbitrary byte stream into whole frames, losing nothing', () {
      final chunker = PcmFrameChunker(4);
      expect(chunker.add(Uint8List.fromList([1, 2, 3])), isEmpty);
      expect(chunker.pending, 3);
      expect(chunker.add(Uint8List.fromList([4, 5, 6, 7, 8, 9])), [
        [1, 2, 3, 4],
        [5, 6, 7, 8],
      ]);
      expect(chunker.pending, 1);
      expect(chunker.add(Uint8List.fromList([10, 11, 12])), [
        [9, 10, 11, 12],
      ]);
      expect(chunker.pending, 0);
    });

    test('a frame is the rate and the duration, in bytes', () {
      expect(pcmFrameBytes(24000, const Duration(milliseconds: 32)), 1536);
      expect(pcmFrameBytes(16000, const Duration(milliseconds: 40)), 1280);
    });
  });
}
