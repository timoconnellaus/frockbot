import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/settings/voice_settings.dart';
import 'package:frockbot_native/voice/appearance.dart';
import 'package:frockbot_native/voice/player.dart';
import 'package:frockbot_native/voice/preview.dart';

class _FakePlayer extends VoicePlayer {
  int? rate;
  final chunks = <Uint8List>[];
  Completer<bool>? pendingDrain;
  var interrupts = 0;

  @override
  Future<void> configure(int sampleRate) async {
    rate = sampleRate;
  }

  @override
  void write(Uint8List chunk) {
    chunks.add(Uint8List.fromList(chunk));
  }

  @override
  Future<void> interrupt() async {
    interrupts += 1;
    chunks.clear();
    pendingDrain?.complete(false);
    pendingDrain = null;
  }

  @override
  Future<void> close() async {
    await interrupt();
  }

  @override
  double get level => 0;

  @override
  bool get playing => chunks.isNotEmpty;

  @override
  int get lossCount => 0;

  @override
  Future<bool> drain() {
    pendingDrain = Completer<bool>();
    return pendingDrain!.future;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test('wraps PCM16 and reads it back with the rate', () {
    final pcm = Uint8List.fromList([1, 2, 3, 4]);
    final wav = pcmToWavV1(pcm, sampleRate: 16000);
    final clip = wavToPcmV1(wav);
    expect(clip?.sampleRate, 16000);
    expect(clip?.pcm, pcm);
    expect(wavToPcmV1(pcm), isNull);
  });

  test('names a clip after the voice, under the bundled folder', () {
    expect(voicePreviewAssetV1('Iapetus'), 'assets/voices/Iapetus.wav');
  });

  test('hears one voice, and tapping it again stops', () async {
    final device = _FakePlayer();
    final pcm = Uint8List.fromList([9, 8, 7, 6]);
    final preview = VoicePreviewPlayer(
      createPlayer: () => device,
      loadClip: (_) async => pcmToWavV1(pcm),
    );
    addTearDown(preview.dispose);

    await preview.hear('Iapetus');
    expect(preview.playing, 'Iapetus');
    expect(device.rate, 24000);
    expect(device.chunks, [pcm]);

    await preview.hear('Iapetus');
    expect(preview.playing, isNull);
    expect(device.interrupts, 1);
  });

  test('a second voice replaces the first without waiting for drain', () async {
    final device = _FakePlayer();
    final preview = VoicePreviewPlayer(
      createPlayer: () => device,
      loadClip: (name) async =>
          pcmToWavV1(Uint8List.fromList(name == 'Puck' ? [1, 1] : [2, 2])),
    );
    addTearDown(preview.dispose);

    await preview.hear('Puck');
    await preview.hear('Kore');
    expect(preview.playing, 'Kore');
    expect(device.chunks, [
      Uint8List.fromList([2, 2]),
    ]);
    expect(device.interrupts, 1);
  });

  test('a missing clip clears the playing mark rather than hanging', () async {
    final preview = VoicePreviewPlayer(
      createPlayer: _FakePlayer.new,
      loadClip: (_) async {
        throw StateError('missing');
      },
    );
    addTearDown(preview.dispose);
    await preview.hear('Iapetus');
    expect(preview.playing, isNull);
  });

  test('every Gemini voice has a minted preview clip', () {
    for (final voice in geminiVoicesV1) {
      expect(
        File(voicePreviewAssetV1(voice.voiceName)).existsSync(),
        isTrue,
        reason: voice.voiceName,
      );
    }
  });

  testWidgets('hearing a timbre does not pick it', (tester) async {
    final device = _FakePlayer();
    final heard = <String>[];
    final preview = VoicePreviewPlayer(
      createPlayer: () => device,
      loadClip: (name) async {
        heard.add(name);
        return pcmToWavV1(Uint8List.fromList([1, 0, 2, 0]));
      },
    );
    addTearDown(preview.dispose);

    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => TextButton(
            onPressed: () => unawaited(
              pickVoiceOptionV1(
                context,
                title: 'Timbre',
                options: const [
                  (slug: 'Iapetus', label: 'Iapetus', detail: 'Clear'),
                  (slug: 'Puck', label: 'Puck', detail: 'Upbeat'),
                ],
                selected: 'Puck',
                preview: preview,
              ),
            ),
            child: const Text('Open'),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();

    expect(find.byTooltip('Hear Iapetus'), findsOneWidget);
    await tester.tap(find.byTooltip('Hear Iapetus'));
    await tester.pump();
    await tester.pump();
    expect(heard, ['Iapetus']);
    expect(preview.playing, 'Iapetus');
    expect(find.text('Timbre'), findsOneWidget);

    await tester.tap(find.text('Iapetus'));
    await tester.pumpAndSettle();
    expect(find.text('Timbre'), findsNothing);
  });
}
