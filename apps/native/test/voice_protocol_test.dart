/// The two wire vocabularies, and what each decoder refuses.
///
/// The dictation channel is FrockBot's own, so a frame it cannot read is a
/// protocol failure and throws. The assistant channel is the SDK's, which may
/// add a message type between releases, so an unreadable frame is ignored —
/// a live call must not end because a diagnostic changed shape.
library;

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/voice/protocol.dart';

Object? decoded(String raw) => jsonDecode(raw);

void main() {
  group('what the client says', () {
    test('dictation start declares the one rate the server accepts', () {
      expect(decoded(encodeDictationStartV1()), {
        'schemaVersion': 1,
        'type': 'start',
        'sampleRate': 24000,
      });
      expect(voiceDictationSampleRateV1, 24000);
      expect(decoded(encodeDictationStopV1()), {
        'schemaVersion': 1,
        'type': 'stop',
      });
    });

    test('the assistant handshake and its custom messages', () {
      expect(decoded(encodeAssistantHelloV1()), {
        'type': 'hello',
        'protocol_version': 1,
      });
      expect(decoded(encodeAssistantStartCallV1()), {
        'type': 'start_call',
        'preferred_format': 'pcm16',
      });
      expect(decoded(encodeAssistantEndCallV1()), {'type': 'end_call'});
      expect(decoded(encodeAssistantInterruptV1()), {'type': 'interrupt'});
      expect(decoded(encodeVoiceSleepV1()), {
        'schemaVersion': 1,
        'type': 'voice/sleep',
      });
      expect(decoded(encodeVoiceWakeV1()), {
        'schemaVersion': 1,
        'type': 'voice/wake',
      });
      expect(decoded(encodeVoiceMuteV1(true)), {
        'schemaVersion': 1,
        'type': 'voice/mute',
        'muted': true,
      });
    });
  });

  group('dictation frames', () {
    T round<T extends DictationServerFrameV1>(Map<String, Object?> frame) =>
        decodeDictationServerFrameV1(jsonEncode(frame)) as T;

    test('every server frame decodes to its own shape', () {
      expect(
        round({'schemaVersion': 1, 'type': 'ready'}),
        isA<DictationReadyV1>(),
      );
      expect(
        round({'schemaVersion': 1, 'type': 'final'}),
        isA<DictationFinalV1>(),
      );
      expect(
        round<DictationDeltaV1>({
          'schemaVersion': 1,
          'type': 'delta',
          'text': 'half a th',
        }).text,
        'half a th',
      );
      expect(
        round<DictationSegmentV1>({
          'schemaVersion': 1,
          'type': 'segment',
          'text': 'half a thought',
        }).text,
        'half a thought',
      );
      expect(
        round<DictationNoticeV1>({
          'schemaVersion': 1,
          'type': 'notice',
          'message': 'the opening was truncated',
        }).message,
        'the opening was truncated',
      );
      final failure = round<DictationErrorV1>({
        'schemaVersion': 1,
        'type': 'error',
        'message': 'no key',
        'code': 'unconfigured',
      });
      expect(failure.message, 'no key');
      expect(failure.code, DictationErrorCode.unconfigured);
    });

    test('an unknown code is dropped rather than carried through', () {
      expect(
        round<DictationErrorV1>({
          'schemaVersion': 1,
          'type': 'error',
          'message': 'why',
          'code': 'sideways',
        }).code,
        isNull,
      );
    });

    test('what it refuses', () {
      final refused = [
        '[]',
        '"text"',
        '{"schemaVersion":2,"type":"ready"}',
        '{"schemaVersion":1,"type":"handshake"}',
        '{"schemaVersion":1,"type":"delta"}',
        '{"schemaVersion":1,"type":"delta","text":7}',
        '{"schemaVersion":1,"type":"error"}',
        'not json at all',
      ];
      for (final frame in refused) {
        expect(
          () => decodeDictationServerFrameV1(frame),
          throwsFormatException,
          reason: frame,
        );
      }
      // Text past the wire's own limit is refused rather than truncated.
      expect(
        () => decodeDictationServerFrameV1(
          jsonEncode({
            'schemaVersion': 1,
            'type': 'delta',
            'text': 'a' * 32001,
          }),
        ),
        throwsFormatException,
      );
    });
  });

  group('assistant frames', () {
    T? round<T extends AssistantServerFrameV1>(Map<String, Object?> frame) =>
        decodeAssistantServerFrameV1(jsonEncode(frame)) as T?;

    test('the SDK vocabulary', () {
      expect(
        round<AssistantWelcomeV1>({'type': 'welcome', 'protocol_version': 1})!
            .protocolVersion,
        1,
      );
      for (final entry in {
        'idle': VoiceStatusV1.idle,
        'listening': VoiceStatusV1.listening,
        'thinking': VoiceStatusV1.thinking,
        'speaking': VoiceStatusV1.speaking,
      }.entries) {
        expect(
          round<AssistantStatusV1>({'type': 'status', 'status': entry.key})!
              .status,
          entry.value,
        );
      }
      final config = round<AssistantAudioConfigV1>({
        'type': 'audio_config',
        'format': 'pcm16',
        'sampleRate': 24000,
      })!;
      expect(config.format, 'pcm16');
      expect(config.sampleRate, 24000);
      expect(
        round({'type': 'playback_interrupt'}),
        isA<AssistantPlaybackInterruptV1>(),
      );
      final failure = round<AssistantErrorV1>({
        'type': 'error',
        'message': 'upstream refused',
        'code': 'stt',
        'retryable': false,
      })!;
      expect(failure.message, 'upstream refused');
      expect(failure.code, 'stt');
      expect(failure.retryable, isFalse);
      expect(
        round({'type': 'transcript', 'role': 'assistant', 'text': 'hello'}),
        isA<AssistantTranscriptV1>(),
      );
      expect(round({'type': 'metrics'}), isA<AssistantDiagnosticV1>());
    });

    test('the custom messages this product added', () {
      final refusal = round<AssistantRefusalV1>({
        'type': 'voice/refusal',
        'schemaVersion': 1,
        'code': 'quota',
        'message': 'used up',
      })!;
      expect(refusal.code, VoiceRefusalCodeV1.quota);
      expect(refusal.message, 'used up');

      final state = round<AssistantVoiceStateV1>({
        'type': 'voice/state',
        'schemaVersion': 1,
        'upstream': 'asleep',
        'muted': true,
      })!;
      expect(state.upstream, VoiceUpstreamStateV1.asleep);
      expect(state.muted, isTrue);
    });

    test('what it ignores, rather than ending a call over', () {
      for (final frame in [
        '[]',
        '7',
        'not json',
        '{"type":"something_new_in_the_sdk"}',
        '{"type":"status","status":"pondering"}',
        '{"type":"voice/refusal","code":"sideways","message":"?"}',
        '{"type":"voice/state","upstream":"dreaming","muted":false}',
        '{}',
      ]) {
        expect(decodeAssistantServerFrameV1(frame), isNull, reason: frame);
      }
    });

    test('every refusal has one sentence a person can act on', () {
      for (final code in VoiceRefusalCodeV1.values) {
        final message = voiceRefusalMessage(code);
        expect(message, isNotEmpty);
        expect(message.endsWith('.'), isTrue, reason: message);
      }
      expect(
        voiceRefusalMessage(VoiceRefusalCodeV1.unconfigured),
        voiceUnavailableMessage,
      );
    });
  });

  group('capabilities', () {
    test('reads the probe, and refuses another schema', () {
      final capabilities = decodeVoiceCapabilitiesV1({
        'schemaVersion': 1,
        'dictation': true,
        'assistant': false,
      });
      expect(capabilities.dictation, isTrue);
      expect(capabilities.assistant, isFalse);
      expect(
        () => decodeVoiceCapabilitiesV1({'schemaVersion': 2}),
        throwsFormatException,
      );
      expect(() => decodeVoiceCapabilitiesV1(null), throwsFormatException);
    });
  });

  test('the bounds both channels agree on', () {
    expect(voiceAssistantInputSampleRateV1, 16000);
    expect(voiceAssistantOutputSampleRateV1, 24000);
    expect(voiceAssistantFrame, const Duration(milliseconds: 40));
    expect(voiceDictationFrame, const Duration(milliseconds: 32));
    expect(voiceDictationFinalTimeoutV1, const Duration(seconds: 6));
    expect(voiceDictationConnectTimeoutV1, const Duration(seconds: 10));
    expect(voiceAssistantSleepAfterV1, const Duration(seconds: 20));
    expect(voiceAssistantPreRollV1, const Duration(milliseconds: 500));
    expect(voiceAssistantStartTimeoutV1, const Duration(seconds: 15));
    expect(voiceDictationOpeningBufferBytesV1, 30 * 24000 * 2);
    expect(voiceAssistantOpeningBufferBytesV1, 10 * 16000 * 2);
  });
}
