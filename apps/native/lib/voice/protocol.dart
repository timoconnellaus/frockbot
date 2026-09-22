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
import 'dart:math';
import 'dart:typed_data';

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

/// How long to wait once the raw transcript has landed and the server is
/// tidying it. The field is already editable; this only bounds the leftover
/// socket so a quiet server cannot hold it open. Longer than the server's
/// own tidy bound so Groq plus Jev can finish and send `final` first.
const voiceDictationCleanupTimeoutV1 = Duration(seconds: 14);

/// How long a capture has been running, as `mm:ss`.
///
/// Caps at 99:59 so the pill's reserved width never jumps. A capture that
/// actually reaches that is already past the server's five-minute stop.
String formatDictationElapsedV1(Duration elapsed) {
  final total = elapsed.inSeconds.clamp(0, 99 * 60 + 59);
  final minutes = (total ~/ 60).toString().padLeft(2, '0');
  final seconds = (total % 60).toString().padLeft(2, '0');
  return '$minutes:$seconds';
}

/// Opening audio the client holds while the dictation socket opens: 30 s.
const voiceDictationOpeningBufferBytesV1 = 30 * voiceDictationSampleRateV1 * 2;

/// Opening audio the client holds until `voice/ready`: 10 s at the input format.
const voiceAssistantOpeningBufferSecondsV1 = 10;
const voiceAssistantOpeningBufferBytesV1 =
    voiceAssistantOpeningBufferSecondsV1 * voiceAssistantInputSampleRateV1 * 2;

/// How long the handshake has to reach `listening` before it is a failure.
const voiceAssistantStartTimeoutV1 = Duration(seconds: 15);

/// Server opening deadline; kept below the client start timeout.
const voiceAssistantOpeningDeadlineV1 = Duration(seconds: 10);

/// Quiet this long while listening and the client sleeps the upstream.
const voiceAssistantSleepAfterV1 = Duration(seconds: 120);

/// Audio replayed ahead of a wake so the first syllable reaches the model.
const voiceAssistantPreRollV1 = Duration(milliseconds: 500);

/// How long a live call may carry no signal at all before the surface says
/// the microphone is not being heard. A working microphone picks up a room;
/// one that is open and handing over nothing but zeros — what the documented
/// macOS voice-processing failure produces — never does. Counted on the
/// capture's own clock, the way the gate's quiet window is.
const voiceAssistantDeafNoticeAfterV1 = Duration(seconds: 10);

/// How long one upgrade may take. A cold voice object can spend most of
/// this starting; a shorter cut-off abandons a socket that would have
/// opened. A refused socket is retried once; a timeout is not.
const voiceAssistantConnectTimeoutV1 = Duration(seconds: 10);

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

/// The capture is transcribed and the server is tidying it. Everything said
/// is already in the draft; this only changes what the composer says.
final class DictationCleaningV1 extends DictationServerFrameV1 {
  const DictationCleaningV1();
}

/// The tidied form of everything this capture dictated, to replace its span.
final class DictationCleanedV1 extends DictationServerFrameV1 {
  final String text;
  const DictationCleanedV1(this.text);
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
    case 'cleaning':
      return const DictationCleaningV1();
    case 'cleaned':
      return DictationCleanedV1(_text(value['text'], 'dictation text', 32000));
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

enum VoiceOpeningModeV1 { start, wake, rejoin, control }

enum VoiceOpeningFailCodeV1 {
  timeout,
  cancelled,
  overflow,
  upstream,
  quota,
  unconfigured,
  exclusive,
  superseded,
  ended,
  protocol,
  gap,
}

enum VoiceControlActionV1 { pause, mute, end }

String encodeAssistantHelloV1() =>
    jsonEncode({'type': 'hello', 'protocol_version': 1});

String encodeAssistantInterruptV1() => jsonEncode({'type': 'interrupt'});

String encodeVoiceSleepV1({bool paused = false}) => jsonEncode({
  'schemaVersion': 1,
  'type': 'voice/sleep',
  if (paused) 'paused': true,
});

String encodeVoiceOpenV1({
  required String attemptId,
  required VoiceOpeningModeV1 mode,
  String? botId,
  String? callId,
  bool paused = false,
  bool muted = false,
}) => jsonEncode({
  'schemaVersion': 1,
  'type': 'voice/open',
  'attemptId': attemptId,
  'mode': mode.name,
  if (botId != null && botId.isNotEmpty) 'botId': botId,
  if (callId != null && callId.isNotEmpty) 'callId': callId,
  'paused': paused,
  'muted': muted,
});

String encodeVoiceControlV1({
  required String attemptId,
  required int sequence,
  required VoiceControlActionV1 action,
  bool? muted,
}) => jsonEncode({
  'schemaVersion': 1,
  'type': 'voice/control',
  'attemptId': attemptId,
  'sequence': sequence,
  'action': action.name,
  if (action == VoiceControlActionV1.mute) 'muted': muted == true,
});

/// Which Bot this call is with (ADR 0029). Mid-call retarget only.
String encodeVoiceTargetV1(String botId) =>
    jsonEncode({'schemaVersion': 1, 'type': 'voice/target', 'botId': botId});

String encodeVoiceSpeechV1(bool playing) => jsonEncode({
  'schemaVersion': 1,
  'type': 'voice/speech',
  'playing': playing,
});

final _uuidV4 = RegExp(
  r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
);

bool isVoiceAttemptIdV1(String value) => _uuidV4.hasMatch(value);

String newVoiceAttemptIdV1() {
  final random = Random.secure();
  final bytes = List<int>.generate(16, (_) => random.nextInt(256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  final hex = [for (final byte in bytes) byte.toRadixString(16).padLeft(2, '0')]
      .join();
  return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-'
      '${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';
}

Uint8List? voiceAttemptIdBytesV1(String id) {
  if (!isVoiceAttemptIdV1(id)) return null;
  final hex = id.replaceAll('-', '');
  return Uint8List.fromList([
    for (var i = 0; i < 16; i++)
      int.parse(hex.substring(i * 2, i * 2 + 2), radix: 16),
  ]);
}

const voiceAssistantPcmHeaderBytesV1 = 21;

Uint8List encodeVoiceAssistantPcmEnvelopeV1({
  required String attemptId,
  required int sequence,
  required Uint8List pcm,
}) {
  final attempt = voiceAttemptIdBytesV1(attemptId);
  if (attempt == null) {
    throw FormatException('voice pcm envelope attemptId');
  }
  if (pcm.length.isOdd) {
    throw FormatException('voice pcm envelope payload is misaligned');
  }
  final frame = Uint8List(voiceAssistantPcmHeaderBytesV1 + pcm.length);
  frame[0] = 1;
  frame.setRange(1, 17, attempt);
  ByteData.sublistView(frame).setUint32(17, sequence, Endian.little);
  frame.setRange(voiceAssistantPcmHeaderBytesV1, frame.length, pcm);
  return frame;
}

class VoicePcmEnvelopeV1 {
  final String attemptId;
  final int sequence;
  final Uint8List pcm;
  const VoicePcmEnvelopeV1({
    required this.attemptId,
    required this.sequence,
    required this.pcm,
  });
}

VoicePcmEnvelopeV1? decodeVoiceAssistantPcmEnvelopeV1(Uint8List bytes) {
  if (bytes.length < voiceAssistantPcmHeaderBytesV1) return null;
  if (bytes[0] != 1) return null;
  final pcmLength = bytes.length - voiceAssistantPcmHeaderBytesV1;
  if (pcmLength == 0 || pcmLength.isOdd) return null;
  final hex = [
    for (var i = 1; i < 17; i++) bytes[i].toRadixString(16).padLeft(2, '0'),
  ].join();
  final attemptId =
      '${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';
  if (!isVoiceAttemptIdV1(attemptId)) return null;
  final sequence = ByteData.sublistView(bytes).getUint32(17, Endian.little);
  return VoicePcmEnvelopeV1(
    attemptId: attemptId,
    sequence: sequence,
    pcm: bytes.sublist(voiceAssistantPcmHeaderBytesV1),
  );
}

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

enum VoiceDelegationStateV1 { asked, answering, finished }

/// Which Bot the call is with now (ADR 0029).
///
/// Sent when the call is admitted and again whenever it is handed over, by
/// the person pressing voice on another Bot or by the Bot itself calling
/// `switch_bot`. The screen follows the voice rather than guessing.
final class AssistantVoiceTargetV1 extends AssistantServerFrameV1 {
  final String botId;
  const AssistantVoiceTargetV1(this.botId);
}

final class AssistantDelegationV1 extends AssistantServerFrameV1 {
  final String botId;
  final String botName;

  /// The Turn the request became, so the activity slot can open its Work.
  final String runId;
  final VoiceDelegationStateV1 state;
  const AssistantDelegationV1(this.botId, this.botName, this.runId, this.state);
}

final class AssistantVoiceAdmittedV1 extends AssistantServerFrameV1 {
  final String attemptId;
  final String callId;
  final bool paused;
  final bool muted;
  const AssistantVoiceAdmittedV1(
    this.attemptId,
    this.callId, {
    required this.paused,
    required this.muted,
  });
}

final class AssistantVoiceReadyV1 extends AssistantServerFrameV1 {
  final String attemptId;
  final String callId;
  const AssistantVoiceReadyV1(this.attemptId, this.callId);
}

final class AssistantVoiceOpenFailedV1 extends AssistantServerFrameV1 {
  final String attemptId;
  final VoiceOpeningFailCodeV1 code;
  const AssistantVoiceOpenFailedV1(this.attemptId, this.code);
}

final class AssistantVoiceControlAckV1 extends AssistantServerFrameV1 {
  final String attemptId;
  final int sequence;
  const AssistantVoiceControlAckV1(this.attemptId, this.sequence);
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
    case 'voice/target':
      final botId = value['botId'];
      if (botId is! String || botId.isEmpty) return null;
      return AssistantVoiceTargetV1(botId);
    case 'voice/state':
      final upstream = switch (value['upstream']) {
        'asleep' => VoiceUpstreamStateV1.asleep,
        'starting' => VoiceUpstreamStateV1.starting,
        'awake' => VoiceUpstreamStateV1.awake,
        _ => null,
      };
      if (upstream == null) return null;
      return AssistantVoiceStateV1(upstream, value['muted'] == true);
    case 'voice/delegation':
      final botId = value['botId'];
      final botName = value['botName'];
      final state = switch (value['state']) {
        'asked' => VoiceDelegationStateV1.asked,
        'answering' => VoiceDelegationStateV1.answering,
        'finished' => VoiceDelegationStateV1.finished,
        _ => null,
      };
      final runId = value['runId'];
      if (botId is! String ||
          botName is! String ||
          runId is! String ||
          state == null) {
        return null;
      }
      return AssistantDelegationV1(botId, botName, runId, state);
    case 'voice/admitted':
      final attemptId = value['attemptId'];
      final callId = value['callId'];
      if (attemptId is! String ||
          !isVoiceAttemptIdV1(attemptId) ||
          callId is! String ||
          callId.isEmpty) {
        return null;
      }
      return AssistantVoiceAdmittedV1(
        attemptId,
        callId,
        paused: value['paused'] == true,
        muted: value['muted'] == true,
      );
    case 'voice/ready':
      final attemptId = value['attemptId'];
      final callId = value['callId'];
      if (attemptId is! String ||
          !isVoiceAttemptIdV1(attemptId) ||
          callId is! String ||
          callId.isEmpty) {
        return null;
      }
      return AssistantVoiceReadyV1(attemptId, callId);
    case 'voice/open-failed':
      final attemptId = value['attemptId'];
      final code = switch (value['code']) {
        'timeout' => VoiceOpeningFailCodeV1.timeout,
        'cancelled' => VoiceOpeningFailCodeV1.cancelled,
        'overflow' => VoiceOpeningFailCodeV1.overflow,
        'upstream' => VoiceOpeningFailCodeV1.upstream,
        'quota' => VoiceOpeningFailCodeV1.quota,
        'unconfigured' => VoiceOpeningFailCodeV1.unconfigured,
        'exclusive' => VoiceOpeningFailCodeV1.exclusive,
        'superseded' => VoiceOpeningFailCodeV1.superseded,
        'ended' => VoiceOpeningFailCodeV1.ended,
        'protocol' => VoiceOpeningFailCodeV1.protocol,
        'gap' => VoiceOpeningFailCodeV1.gap,
        _ => null,
      };
      if (attemptId is! String ||
          !isVoiceAttemptIdV1(attemptId) ||
          code == null) {
        return null;
      }
      return AssistantVoiceOpenFailedV1(attemptId, code);
    case 'voice/control-ack':
      final attemptId = value['attemptId'];
      final sequence = value['sequence'];
      if (attemptId is! String ||
          !isVoiceAttemptIdV1(attemptId) ||
          sequence is! int ||
          sequence < 0) {
        return null;
      }
      return AssistantVoiceControlAckV1(attemptId, sequence);
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

String voiceOpeningFailMessage(VoiceOpeningFailCodeV1 code) => switch (code) {
  VoiceOpeningFailCodeV1.timeout => 'Voice didn’t start. Try again.',
  VoiceOpeningFailCodeV1.cancelled => 'Voice didn’t start. Try again.',
  VoiceOpeningFailCodeV1.overflow =>
    'Those first words didn’t fit. Start the call again.',
  VoiceOpeningFailCodeV1.upstream =>
    'The voice service could not be reached. Try again in a moment.',
  VoiceOpeningFailCodeV1.quota => 'Voice has used today’s allowance.',
  VoiceOpeningFailCodeV1.unconfigured => voiceUnavailableMessage,
  VoiceOpeningFailCodeV1.exclusive =>
    'Voice is already running on another device.',
  VoiceOpeningFailCodeV1.superseded => 'Voice moved to another device.',
  VoiceOpeningFailCodeV1.ended => 'The call ended.',
  VoiceOpeningFailCodeV1.protocol => 'Voice didn’t start. Try again.',
  VoiceOpeningFailCodeV1.gap =>
    'That audio didn’t come through. Start the call again.',
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
