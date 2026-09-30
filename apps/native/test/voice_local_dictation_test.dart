/// Dictation on this Mac: the composer's controller, unchanged, driving the
/// on-device socket instead of the relay.
///
/// What is worth proving is that the local path behaves exactly like the
/// cloud one from the draft's side — the words land once, at stop, the tidy
/// swaps in through the same range and reverts — and that it never needs the
/// network to produce text: a tidy-up that fails leaves the person's words.
library;

import 'dart:async';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_client/client/store.dart';
import 'package:frockbot_client/shell/composer.dart';
import 'package:frockbot_client/voice/capture.dart';
import 'package:frockbot_client/voice/dictation.dart';
import 'package:frockbot_client/voice/local_dictation.dart';
import 'package:frockbot_client/voice/protocol.dart';

import 'voice_fakes.dart';

class FakeEngine implements LocalDictationEngine {
  final _changes = StreamController<LocalDictationStatus>.broadcast();
  LocalDictationStatus current = const LocalDictationStatus(
    phase: LocalDictationPhase.ready,
  );
  String transcript = '';
  Object? failure;
  final List<Uint8List> heard = [];
  final List<int> rates = [];
  int prepares = 0;

  @override
  Stream<LocalDictationStatus> get changes => _changes.stream;

  @override
  Future<LocalDictationStatus> status() async => current;

  @override
  Future<void> download() async {
    current = const LocalDictationStatus(
      phase: LocalDictationPhase.downloading,
      progress: 0.5,
    );
    _changes.add(current);
  }

  @override
  Future<void> remove() async {
    current = const LocalDictationStatus(phase: LocalDictationPhase.absent);
    _changes.add(current);
  }

  @override
  Future<void> prepare() async => prepares++;

  @override
  Future<String> transcribe(Uint8List pcm16, {required int sampleRate}) async {
    heard.add(pcm16);
    rates.add(sampleRate);
    final failed = failure;
    if (failed != null) throw failed;
    return transcript;
  }
}

class MemoryStore implements LocalStore {
  final Map<String, String> values = {};
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> write(String key, String value) async => values[key] = value;
  @override
  Future<void> delete(String key) async => values.remove(key);
}

class Harness {
  final FakeVoiceCapture capture = FakeVoiceCapture();
  final FakeEngine engine = FakeEngine();
  final ComposerDraftStore drafts = ComposerDraftStore();
  final List<String> cleaned = [];
  late final DictationController controller;

  Harness({DictationCleaner? cleanup, int? maxBytes}) {
    controller = DictationController(
      openSocket: () async => LocalDictationSocket(
        engine: engine,
        cleanup: cleanup == null
            ? null
            : (text) {
                cleaned.add(text);
                return cleanup(text);
              },
        maxBytes: maxBytes ?? localDictationMaxBytesV1,
      ),
      capture: capture,
      onDraft: drafts.setDraft,
      readDraft: drafts.draftFor,
    );
  }

  void speak(int mark) =>
      capture.emit(AudioFrame(pcmFrame(0.05, mark: mark), 0.05, 0));
}

const spoken = 'so um I think we should send it on Friday';

void main() {
  test(
    'transcribes the whole capture on the Mac and lands it at stop',
    () async {
      final harness = Harness()..engine.transcript = 'send it on Friday';
      await harness.controller.start('bot-a');
      await settle();
      harness.speak(1);
      harness.speak(2);
      await settle();
      expect(harness.drafts.draftFor('bot-a'), '');
      await harness.controller.stop();
      await settle();
      expect(harness.drafts.draftFor('bot-a'), 'send it on Friday');
      expect(harness.controller.state, DictationState.done);
      expect(harness.engine.rates, [voiceDictationSampleRateV1]);
      final heard = harness.engine.heard.single;
      expect(heard.length, 2 * 640 * 2);
      expect(heard[0], 1);
      expect(heard[640 * 2], 2);
      harness.controller.dispose();
    },
  );

  test(
    'tidies through the relay\'s cleanup and can put the words back',
    () async {
      final harness = Harness(
        cleanup: (_) async => 'I think we should send it on Friday.',
      )..engine.transcript = spoken;
      await harness.controller.start('bot-a');
      await settle();
      harness.speak(1);
      await harness.controller.stop();
      await settle(6);
      expect(harness.cleaned, [spoken]);
      expect(
        harness.drafts.draftFor('bot-a'),
        'I think we should send it on Friday.',
      );
      expect(harness.controller.cleaned, isTrue);
      harness.controller.revertCleanup();
      expect(harness.drafts.draftFor('bot-a'), spoken);
      harness.controller.dispose();
    },
  );

  test(
    'offline, the tidy-up fails and the person\'s own words stand',
    () async {
      final harness = Harness(
        cleanup: (_) async => throw TimeoutException('offline'),
      )..engine.transcript = spoken;
      await harness.controller.start('bot-a');
      await settle();
      harness.speak(1);
      await harness.controller.stop();
      await settle(6);
      expect(harness.drafts.draftFor('bot-a'), spoken);
      expect(harness.controller.state, DictationState.done);
      expect(harness.controller.error, isNull);
      harness.controller.dispose();
    },
  );

  test('a short transcript is not offered to the tidy-up', () async {
    final harness = Harness(cleanup: (_) async => 'Yes.')
      ..engine.transcript = 'yes';
    await harness.controller.start('bot-a');
    await settle();
    harness.speak(1);
    await harness.controller.stop();
    await settle(6);
    expect(harness.cleaned, isEmpty);
    expect(harness.drafts.draftFor('bot-a'), 'yes');
    harness.controller.dispose();
  });

  test('an engine failure is said, not sent to the cloud', () async {
    final harness = Harness()..engine.failure = StateError('no model');
    await harness.controller.start('bot-a');
    await settle();
    harness.speak(1);
    await harness.controller.stop();
    await settle();
    expect(harness.controller.state, DictationState.error);
    expect(harness.controller.error, contains('This Mac'));
    harness.controller.dispose();
  });

  test('a capture at the cap keeps its words and stops', () async {
    final harness = Harness(maxBytes: 640 * 2 * 2)
      ..engine.transcript = 'a long ramble';
    await harness.controller.start('bot-a');
    await settle();
    harness.speak(1);
    harness.speak(2);
    await settle(6);
    expect(harness.drafts.draftFor('bot-a'), 'a long ramble');
    expect(harness.controller.state, DictationState.error);
    expect(harness.controller.error, contains('five minutes'));
    harness.controller.dispose();
  });

  test('the Mac remembers its choice and warms the model for it', () async {
    final engine = FakeEngine();
    final store = MemoryStore();
    final controller = LocalDictationController(engine: engine);
    await controller.load(store);
    expect(controller.source, DictationSource.frockbot);
    expect(controller.onThisMac, isFalse);
    await controller.choose(DictationSource.thisMac);
    expect(store.values[dictationSourceKeyV1], 'this-mac');
    expect(controller.onThisMac, isTrue);
    expect(engine.prepares, 1);

    final reopened = LocalDictationController(engine: engine);
    await reopened.load(store);
    expect(reopened.source, DictationSource.thisMac);

    await reopened.remove();
    await settle();
    expect(reopened.ready, isFalse);
    await reopened.choose(DictationSource.frockbot);
    expect(reopened.onThisMac, isFalse);
    controller.dispose();
    reopened.dispose();
  });

  test('elsewhere there is no on-device choice to make', () {
    final controller = LocalDictationController();
    expect(controller.onThisMac, isFalse);
    expect(controller.supported, isFalse);
    expect(() => controller.open(), throwsStateError);
  });

  test('reads the engine\'s snapshot', () {
    final status = LocalDictationStatus.decode({
      'phase': 'downloading',
      'progress': 0.25,
      'bytesOnDisk': 120000000,
      'expectedBytes': 483105645,
      'error': '',
    });
    expect(status.phase, LocalDictationPhase.downloading);
    expect(status.progress, 0.25);
    expect(formatDictationModelSizeV1(status.expectedBytes), '483 MB');
    expect(
      LocalDictationStatus.decode(null).phase,
      LocalDictationPhase.unsupported,
    );
  });
}
