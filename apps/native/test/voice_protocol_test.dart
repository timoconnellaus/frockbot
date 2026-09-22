/// The two wire vocabularies, and what each decoder refuses.
///
/// The dictation channel is FrockBot's own, so a frame it cannot read is a
/// protocol failure and throws. The assistant channel is the SDK's, which may
/// add a message type between releases, so an unreadable frame is ignored —
/// a live call must not end because a diagnostic changed shape.
library;

import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/voice/protocol.dart';

Object? decoded(String raw) => jsonDecode(raw);

void main() {
  group('what the client says', () {
    test('elapsed time is mm:ss and never jumps a digit', () {
      expect(formatDictationElapsedV1(Duration.zero), '00:00');
      expect(formatDictationElapsedV1(const Duration(seconds: 5)), '00:05');
      expect(formatDictationElapsedV1(const Duration(seconds: 65)), '01:05');
      expect(formatDictationElapsedV1(const Duration(minutes: 100)), '99:59');
    });

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
      const attempt = '2e780bb8-b4e9-42af-a9bc-f3f6aaf37070';
      expect(
        decoded(
          encodeVoiceOpenV1(
            attemptId: attempt,
            mode: VoiceOpeningModeV1.start,
            botId: 'bot-1',
            muted: true,
          ),
        ),
        {
          'schemaVersion': 1,
          'type': 'voice/open',
          'attemptId': attempt,
          'mode': 'start',
          'botId': 'bot-1',
          'paused': false,
          'muted': true,
        },
      );
      expect(
        decoded(
          encodeVoiceControlV1(
            attemptId: attempt,
            sequence: 1,
            action: VoiceControlActionV1.end,
          ),
        ),
        {
          'schemaVersion': 1,
          'type': 'voice/control',
          'attemptId': attempt,
          'sequence': 1,
          'action': 'end',
        },
      );
      expect(decoded(encodeAssistantInterruptV1()), {'type': 'interrupt'});
      expect(decoded(encodeVoiceSleepV1()), {
        'schemaVersion': 1,
        'type': 'voice/sleep',
      });
      expect(decoded(encodeVoiceSleepV1(paused: true)), {
        'schemaVersion': 1,
        'type': 'voice/sleep',
        'paused': true,
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
        round({'schemaVersion': 1, 'type': 'cleaning'}),
        isA<DictationCleaningV1>(),
      );
      expect(
        round<DictationCleanedV1>({
          'schemaVersion': 1,
          'type': 'cleaned',
          'text': 'Half a thought.',
        }).text,
        'Half a thought.',
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

      final delegation = round<AssistantDelegationV1>({
        'type': 'voice/delegation',
        'schemaVersion': 1,
        'botId': 'researcher',
        'botName': 'Scout',
        'runId': 'run-1',
        'state': 'answering',
      })!;
      expect(delegation.botId, 'researcher');
      expect(delegation.botName, 'Scout');
      expect(delegation.runId, 'run-1');
      expect(delegation.state, VoiceDelegationStateV1.answering);

      const attempt = '2e780bb8-b4e9-42af-a9bc-f3f6aaf37070';
      final admitted = round<AssistantVoiceAdmittedV1>({
        'type': 'voice/admitted',
        'schemaVersion': 1,
        'attemptId': attempt,
        'callId': 'call-1',
        'paused': true,
        'muted': false,
      })!;
      expect(admitted.attemptId, attempt);
      expect(admitted.callId, 'call-1');
      expect(admitted.paused, isTrue);
      expect(
        round({
          'type': 'voice/ready',
          'schemaVersion': 1,
          'attemptId': attempt,
          'callId': 'call-1',
        }),
        isA<AssistantVoiceReadyV1>(),
      );
      expect(
        round({
          'type': 'voice/open-failed',
          'schemaVersion': 1,
          'attemptId': attempt,
          'code': 'overflow',
        }),
        isA<AssistantVoiceOpenFailedV1>(),
      );
      expect(
        round({
          'type': 'voice/control-ack',
          'schemaVersion': 1,
          'attemptId': attempt,
          'sequence': 2,
        }),
        isA<AssistantVoiceControlAckV1>(),
      );
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
        '{"type":"voice/delegation","schemaVersion":1,"botId":"researcher","botName":"Scout","state":"dancing"}',
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
    expect(voiceDictationCleanupTimeoutV1, const Duration(seconds: 14));
    expect(voiceDictationConnectTimeoutV1, const Duration(seconds: 10));
    expect(voiceAssistantSleepAfterV1, const Duration(seconds: 120));
    expect(voiceAssistantPreRollV1, const Duration(milliseconds: 500));
    expect(voiceAssistantStartTimeoutV1, const Duration(seconds: 15));
    expect(voiceAssistantConnectTimeoutV1, const Duration(seconds: 10));
    expect(voiceDictationOpeningBufferBytesV1, 30 * 24000 * 2);
    expect(voiceAssistantOpeningBufferBytesV1, 10 * 16000 * 2);
    expect(voiceAssistantOpeningDeadlineV1, const Duration(seconds: 10));
  });

  test('every opening failure has one sentence a person can act on', () {
    for (final code in VoiceOpeningFailCodeV1.values) {
      final message = voiceOpeningFailMessage(code);
      expect(message, isNotEmpty);
      expect(message.endsWith('.'), isTrue, reason: message);
    }
  });

  test(
    'the assistant pcm envelope is version, uuid, little-endian sequence',
    () {
      const attempt = '2e780bb8-b4e9-42af-a9bc-f3f6aaf37070';
      final pcm = Uint8List.fromList([1, 0, 2, 0]);
      final frame = encodeVoiceAssistantPcmEnvelopeV1(
        attemptId: attempt,
        sequence: 0x01020304,
        pcm: pcm,
      );
      expect(frame.length, voiceAssistantPcmHeaderBytesV1 + 4);
      expect(frame[0], 1);
      expect(frame[17], 0x04);
      expect(frame[18], 0x03);
      expect(frame[19], 0x02);
      expect(frame[20], 0x01);
      final decoded = decodeVoiceAssistantPcmEnvelopeV1(frame)!;
      expect(decoded.attemptId, attempt);
      expect(decoded.sequence, 0x01020304);
      expect(decoded.pcm, pcm);
      expect(isVoiceAttemptIdV1(newVoiceAttemptIdV1()), isTrue);
    },
  );
}
