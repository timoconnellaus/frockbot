/// The voice wire vocabulary, spelled the same as `app/voice/shared.ts`.
///
/// Two channels share this file so a frame is spelled once. Dictation is
/// FrockBot's own protocol; the assistant channel is the `@cloudflare/voice`
/// protocol version 1 plus the `voice/*` messages that SDK hands through
/// untouched. Nothing here touches a microphone, a socket or a widget: it is
/// the part both controllers and every test agree on.
///
/// A decoder here is bounded before it parses — `decodeBoundedJson` is the
/// same guard the state channel uses — because a frame arrives from the
/// network and the client is not the authority on how big it may be.
library;

import 'dart:convert';

import '../client/transport.dart' show decodeBoundedJson;

const voiceDictationPathV1 = '/api/voice/dictation';
const voiceAssistantPathV1 = '/api/voice/assistant';
const voiceCapabilitiesPathV1 = '/api/voice/capabilities';

/// What dictation captures and sends: PCM16 mono at this rate.
const voiceDictationSampleRateV1 = 24000;

/// What the assistant expects up the wire: PCM16 mono at this rate.
const voiceAssistantInputSampleRateV1 = 16000;

/// What the assistant sends down the wire: PCM16 mono at this rate.
const voiceAssistantOutputSampleRateV1 = 24000;

/// The frame each channel re-chunks capture to before sending.
const voiceDictationFrame = Duration(milliseconds: 32);
const voiceAssistantFrame = Duration(milliseconds: 40);

/// How long the client waits for the dictation socket to open.
const voiceDictationConnectTimeoutV1 = Duration(seconds: 10);

/// How long `stop` waits for `final` before flushing what it has anyway.
const voiceDictationFinalTimeoutV1 = Duration(seconds: 6);

/// Opening audio the client holds while the dictation socket opens: 30 s.
const voiceDictationOpeningBufferBytesV1 = 30 * voiceDictationSampleRateV1 * 2;

/// Opening audio the client holds before `start_call` is sent: 10 s.
const voiceAssistantOpeningBufferBytesV1 =
    10 * voiceAssistantInputSampleRateV1 * 2;

/// Quiet this long while listening and the client sleeps the upstream.
const voiceAssistantSleepAfterV1 = Duration(seconds: 20);

/// Audio replayed ahead of a wake so the first syllable reaches the model.
const voiceAssistantPreRollV1 = Duration(milliseconds: 500);

/// How long the handshake has to reach `listening` before it is a failure.
const voiceAssistantStartTimeoutV1 = Duration(seconds: 15);

/// The one retry of the initial connect happens inside this window.
const voiceAssistantConnectRetryWindowV1 = Duration(seconds: 5);

/// What a control says when the deployment has no voice keys. The controls
/// are always shown; this is what pressing one answers.
const voiceUnavailableMessage = 'Voice isn’t set up on this deployment yet.';

// ---------------------------------------------------------------------------
// Capabilities

/// `GET /api/voice/capabilities`.
class VoiceCapabilitiesV1 {
  final bool dictation;
  final bool assistant;
  const VoiceCapabilitiesV1({required this.dictation, required this.assistant});
}

VoiceCapabilitiesV1 decodeVoiceCapabilitiesV1(Object? input) {
  final value = _record(input, 'voice capabilities');
  if (value['schemaVersion'] != 1) {
    throw const FormatException('voice capabilities schemaVersion');
  }
  return VoiceCapabilitiesV1(
    dictation: value['dictation'] == true,
    assistant: value['assistant'] == true,
  );
}

// ---------------------------------------------------------------------------
// Dictation

/// The one text frame the client sends before any audio.
String encodeDictationStartV1() => jsonEncode({
  'schemaVersion': 1,
  'type': 'start',
  'sampleRate': voiceDictationSampleRateV1,
});

/// Commit what has been captured. The server answers `final` and closes.
String encodeDictationStopV1() =>
    jsonEncode({'schemaVersion': 1, 'type': 'stop'});

enum DictationErrorCode { unconfigured, upstream, timeout, limit, protocol }

sealed class DictationServerFrameV1 {
  const DictationServerFrameV1();
}

final class DictationReadyV1 extends DictationServerFrameV1 {
  const DictationReadyV1();
}

/// Interim text for the segment being spoken. Replaces the previous delta.
final class DictationDeltaV1 extends DictationServerFrameV1 {
  final String text;
  const DictationDeltaV1(this.text);
}

/// One completed utterance, appended to the committed transcript.
final class DictationSegmentV1 extends DictationServerFrameV1 {
  final String text;
  const DictationSegmentV1(this.text);
}

final class DictationFinalV1 extends DictationServerFrameV1 {
  const DictationFinalV1();
}

final class DictationNoticeV1 extends DictationServerFrameV1 {
  final String message;
  const DictationNoticeV1(this.message);
}

final class DictationErrorV1 extends DictationServerFrameV1 {
  final String message;
  final DictationErrorCode? code;
  const DictationErrorV1(this.message, [this.code]);
}

DictationServerFrameV1 decodeDictationServerFrameV1(String raw) {
  final value = _record(decodeBoundedJson(raw, maxBytes: 64000), 'frame');
  if (value['schemaVersion'] != 1) {
    throw const FormatException('dictation frame schemaVersion');
  }
  switch (value['type']) {
    case 'ready':
      return const DictationReadyV1();
    case 'final':
      return const DictationFinalV1();
    case 'delta':
      return DictationDeltaV1(_text(value['text'], 'dictation text', 32000));
    case 'segment':
      return DictationSegmentV1(_text(value['text'], 'dictation text', 32000));
    case 'notice':
      return DictationNoticeV1(
        _text(value['message'], 'dictation notice', 500),
      );
    case 'error':
      return DictationErrorV1(
        _text(value['message'], 'dictation error', 500),
        switch (value['code']) {
          'unconfigured' => DictationErrorCode.unconfigured,
          'upstream' => DictationErrorCode.upstream,
          'timeout' => DictationErrorCode.timeout,
          'limit' => DictationErrorCode.limit,
          'protocol' => DictationErrorCode.protocol,
          _ => null,
        },
      );
    default:
      throw const FormatException('dictation frame type');
  }
}

// ---------------------------------------------------------------------------
// Assistant

/// The `@cloudflare/voice` pipeline status a client mirrors.
enum VoiceStatusV1 { idle, listening, thinking, speaking }

enum VoiceUpstreamStateV1 { asleep, starting, awake }

enum VoiceRefusalCodeV1 { exclusive, superseded, quota, unconfigured }

String encodeAssistantHelloV1() =>
    jsonEncode({'type': 'hello', 'protocol_version': 1});

String encodeAssistantStartCallV1() =>
    jsonEncode({'type': 'start_call', 'preferred_format': 'pcm16'});

String encodeAssistantEndCallV1() => jsonEncode({'type': 'end_call'});

String encodeAssistantInterruptV1() => jsonEncode({'type': 'interrupt'});

String encodeVoiceSleepV1() =>
    jsonEncode({'schemaVersion': 1, 'type': 'voice/sleep'});

String encodeVoiceWakeV1() =>
    jsonEncode({'schemaVersion': 1, 'type': 'voice/wake'});

String encodeVoiceMuteV1(bool muted) =>
    jsonEncode({'schemaVersion': 1, 'type': 'voice/mute', 'muted': muted});

sealed class AssistantServerFrameV1 {
  const AssistantServerFrameV1();
}

final class AssistantWelcomeV1 extends AssistantServerFrameV1 {
  final int protocolVersion;
  const AssistantWelcomeV1(this.protocolVersion);
}

final class AssistantStatusV1 extends AssistantServerFrameV1 {
  final VoiceStatusV1 status;
  const AssistantStatusV1(this.status);
}

final class AssistantAudioConfigV1 extends AssistantServerFrameV1 {
  final String format;
  final int? sampleRate;
  const AssistantAudioConfigV1(this.format, this.sampleRate);
}

final class AssistantPlaybackInterruptV1 extends AssistantServerFrameV1 {
  const AssistantPlaybackInterruptV1();
}

final class AssistantErrorV1 extends AssistantServerFrameV1 {
  final String message;
  final String? code;
  final bool? retryable;
  const AssistantErrorV1(this.message, {this.code, this.retryable});
}

/// Every transcript shape the SDK sends. The footer shows none of them; they
/// are decoded so an unknown frame stays distinguishable from a known one.
final class AssistantTranscriptV1 extends AssistantServerFrameV1 {
  final String kind;
  final String? role;
  final String text;
  const AssistantTranscriptV1(this.kind, {this.role, this.text = ''});
}

/// Diagnostics the SDK may add between releases: decoded, then ignored.
final class AssistantDiagnosticV1 extends AssistantServerFrameV1 {
  final String kind;
  const AssistantDiagnosticV1(this.kind);
}

final class AssistantRefusalV1 extends AssistantServerFrameV1 {
  final VoiceRefusalCodeV1 code;
  final String message;
  const AssistantRefusalV1(this.code, this.message);
}

final class AssistantVoiceStateV1 extends AssistantServerFrameV1 {
  final VoiceUpstreamStateV1 upstream;
  final bool muted;
  const AssistantVoiceStateV1(this.upstream, this.muted);
}

/// One JSON text frame from the assistant socket.
///
/// Answers null rather than throwing for anything unknown or malformed: the
/// SDK may add a message type between releases and a live call must not end
/// because of one.
AssistantServerFrameV1? decodeAssistantServerFrameV1(String raw) {
  Object? parsed;
  try {
    parsed = decodeBoundedJson(raw, maxBytes: 64000);
  } on FormatException {
    return null;
  }
  if (parsed is! Map) return null;
  final value = parsed;
  final type = value['type'];
  if (type is! String) return null;
  switch (type) {
    case 'voice/refusal':
      final code = switch (value['code']) {
        'exclusive' => VoiceRefusalCodeV1.exclusive,
        'superseded' => VoiceRefusalCodeV1.superseded,
        'quota' => VoiceRefusalCodeV1.quota,
        'unconfigured' => VoiceRefusalCodeV1.unconfigured,
        _ => null,
      };
      if (code == null) return null;
      return AssistantRefusalV1(
        code,
        value['message'] is String ? value['message'] as String : '',
      );
    case 'voice/state':
      final upstream = switch (value['upstream']) {
        'asleep' => VoiceUpstreamStateV1.asleep,
        'starting' => VoiceUpstreamStateV1.starting,
        'awake' => VoiceUpstreamStateV1.awake,
        _ => null,
      };
      if (upstream == null) return null;
      return AssistantVoiceStateV1(upstream, value['muted'] == true);
    case 'welcome':
      final version = value['protocol_version'];
      return AssistantWelcomeV1(version is int ? version : 0);
    case 'status':
      final status = switch (value['status']) {
        'idle' => VoiceStatusV1.idle,
        'listening' => VoiceStatusV1.listening,
        'thinking' => VoiceStatusV1.thinking,
        'speaking' => VoiceStatusV1.speaking,
        _ => null,
      };
      return status == null ? null : AssistantStatusV1(status);
    case 'audio_config':
      final rate = value['sampleRate'];
      return AssistantAudioConfigV1(
        value['format'] is String ? value['format'] as String : '',
        rate is int ? rate : null,
      );
    case 'playback_interrupt':
      return const AssistantPlaybackInterruptV1();
    case 'error':
      final retryable = value['retryable'];
      return AssistantErrorV1(
        value['message'] is String ? value['message'] as String : '',
        code: value['code'] is String ? value['code'] as String : null,
        retryable: retryable is bool ? retryable : null,
      );
    case 'transcript':
    case 'transcript_start':
      return AssistantTranscriptV1(
        type,
        role: value['role'] == 'assistant' ? 'assistant' : 'user',
        text: value['text'] is String ? value['text'] as String : '',
      );
    case 'transcript_interim':
    case 'transcript_delta':
    case 'transcript_end':
      return AssistantTranscriptV1(
        type,
        text: value['text'] is String ? value['text'] as String : '',
      );
    case 'diagnostic':
    case 'metrics':
    case 'turn_metrics':
    case 'completion_outcome':
      return AssistantDiagnosticV1(type);
    default:
      return null;
  }
}

/// One short sentence a person can act on, for a refusal that ends the call.
String voiceRefusalMessage(VoiceRefusalCodeV1 code) => switch (code) {
  VoiceRefusalCodeV1.exclusive => 'Voice is already running on another device.',
  VoiceRefusalCodeV1.superseded => 'Voice moved to another device.',
  VoiceRefusalCodeV1.quota => 'Voice has used today’s allowance.',
  VoiceRefusalCodeV1.unconfigured => voiceUnavailableMessage,
};

// ---------------------------------------------------------------------------

Map<Object?, Object?> _record(Object? input, String label) {
  if (input is! Map) throw FormatException('$label is invalid');
  return input;
}

String _text(Object? value, String label, int maximum) {
  if (value is! String) throw FormatException('$label is invalid');
  if (value.length > maximum) throw FormatException('$label is too long');
  return value;
}
