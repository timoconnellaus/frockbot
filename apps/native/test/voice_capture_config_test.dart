/// What the recorder is asked for, platform by platform.
///
/// The seam under the Mac's silent microphone: the recorder plugin answers
/// echo cancellation on macOS by turning voice processing on at the engine's
/// input node, an input-and-output unit that hands over silence when nothing
/// renders through the same engine. These tests pin that the desk asks for a
/// plain microphone and the phone keeps its cleaning.
library;

import 'package:flutter/foundation.dart' show TargetPlatform;
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_client/voice/capture.dart';
import 'package:record/record.dart';

void main() {
  group('voiceRecordConfigV1', () {
    for (final platform in [
      TargetPlatform.macOS,
      TargetPlatform.windows,
      TargetPlatform.linux,
    ]) {
      test(
        'opens a plain microphone on $platform, for a call and for dictation',
        () {
          for (final profile in VoiceCaptureProfile.values) {
            final config = voiceRecordConfigV1(
              profile: profile,
              platform: platform,
              sampleRate: 16000,
              web: false,
              streamBufferSize: 1280,
            );
            expect(config.echoCancel, isFalse, reason: '$profile echoCancel');
            expect(config.noiseSuppress, isFalse, reason: '$profile noise');
            expect(config.autoGain, isFalse, reason: '$profile gain');
            expect(config.encoder, AudioEncoder.pcm16bits);
            expect(config.numChannels, 1);
            expect(config.sampleRate, 16000);
          }
        },
      );
    }

    for (final platform in [TargetPlatform.android, TargetPlatform.iOS]) {
      test('keeps the phone’s cleaning on $platform', () {
        for (final profile in VoiceCaptureProfile.values) {
          final config = voiceRecordConfigV1(
            profile: profile,
            platform: platform,
            sampleRate: 24000,
            web: false,
          );
          expect(config.echoCancel, isTrue, reason: '$profile echoCancel');
          expect(config.noiseSuppress, isTrue, reason: '$profile noise');
          expect(config.autoGain, isTrue, reason: '$profile gain');
          expect(config.sampleRate, 24000);
        }
      });
    }

    test('the browser keeps its own processing whatever the host is', () {
      final config = voiceRecordConfigV1(
        profile: VoiceCaptureProfile.dictation,
        platform: TargetPlatform.macOS,
        sampleRate: 16000,
        web: true,
      );
      expect(config.echoCancel, isTrue);
    });

    test('a call leaves the session alone and reads one frame per buffer', () {
      final config = voiceRecordConfigV1(
        profile: VoiceCaptureProfile.call,
        platform: TargetPlatform.android,
        sampleRate: 24000,
        web: false,
        streamBufferSize: 1920,
      );
      expect(config.audioInterruption, AudioInterruptionMode.none);
      expect(config.streamBufferSize, 1920);
      expect(
        config.androidConfig.audioManagerMode,
        AudioManagerMode.modeNormal,
      );
      expect(config.androidConfig.manageBluetooth, isFalse);
      expect(
        config.androidConfig.audioSource,
        AndroidAudioSource.voiceCommunication,
      );
      // Dictation lets the plugin manage the session, as it always has.
      final dictation = voiceRecordConfigV1(
        profile: VoiceCaptureProfile.dictation,
        platform: TargetPlatform.android,
        sampleRate: 16000,
        web: false,
      );
      expect(
        dictation.androidConfig.audioManagerMode,
        AudioManagerMode.modeInCommunication,
      );
      expect(dictation.streamBufferSize, isNull);
    });
  });
}
