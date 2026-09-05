/// The phone's end of the Voice assistant protocol.
///
/// This mirrors `packages/protocol/src/voice-assistant.ts` exactly, including
/// its bounds. Voice frames are deliberately outside the shared JSON schema
/// that `scripts/generate-dart-protocol.ts` generates from, so — as on the
/// TypeScript side — the decoders are written by hand and kept honest by
/// tests rather than by codegen.
library;

/// Audio is a binary PCM16LE frame; these are the client's text controls.
const int voiceAssistantVersion = 1;

/// What the microphone must produce: PCM16LE mono at this rate.
const int voiceInputSampleRate = 16000;

/// What arrives as binary frames: PCM16LE mono at this rate.
const int voiceOutputSampleRate = 24000;

/// 32 ms at [voiceInputSampleRate]; the same frame the browser sends.
const int voiceInputFrameSamples = 512;

/// The five tools the assistant may call. Anything else is dropped, so a
/// caption can never name a capability the Package does not have.
const Set<String> voiceToolNames = {
  'list_bots',
  'bot_activity',
  'memory_search',
  'pending_answers',
  'ask_bot',
};

class VoiceProtocolError implements Exception {
  final String message;
  const VoiceProtocolError(this.message);
  @override
  String toString() => message;
}

Map<String, Object?> _frame(Object? input) {
  if (input is! Map) {
    throw const VoiceProtocolError('voice assistant frame must be an object');
  }
  final value = Map<String, Object?>.from(input);
  if (value['schemaVersion'] != 1) {
    throw const VoiceProtocolError(
      'voice assistant frame version is unsupported',
    );
  }
  return value;
}

String _text(Map<String, Object?> value, String field, [int max = 8192]) {
  final found = value[field];
  if (found is! String || found.isEmpty || found.length > max) {
    throw VoiceProtocolError('voice assistant frame.$field is invalid');
  }
  return found;
}

/// A frame the VoiceSession Durable Object sent to this device.
sealed class VoiceServerFrame {
  const VoiceServerFrame();
}

/// The provider session is up. Audio queued before this may now be sent.
class VoiceReady extends VoiceServerFrame {
  final String sessionId;
  final int quotaRemainingSeconds;
  const VoiceReady(this.sessionId, this.quotaRemainingSeconds);
}

/// Whether the room is listening to you or the Bot is speaking.
class VoiceLiveState extends VoiceServerFrame {
  final bool speaking;
  const VoiceLiveState({required this.speaking});
}

/// One completed utterance. The socket never streams partial captions.
class VoiceTranscript extends VoiceServerFrame {
  final String id;

  /// True when the utterance is the User's own.
  final bool fromUser;
  final String text;
  final String at;
  const VoiceTranscript({
    required this.id,
    required this.fromUser,
    required this.text,
    required this.at,
  });
}

/// A tool the assistant used. Never shown in voice captions.
class VoiceToolUse extends VoiceServerFrame {
  final String id;
  final String name;
  final String label;
  final String at;
  const VoiceToolUse({
    required this.id,
    required this.name,
    required this.label,
    required this.at,
  });
}

/// You spoke over the Bot; whatever is queued for playback is now stale.
class VoiceInterrupted extends VoiceServerFrame {
  const VoiceInterrupted();
}

enum VoiceOfflineReason { stopped, idle, quota, error, replaced }

/// The session ended, with a sentence a person can act on.
class VoiceOffline extends VoiceServerFrame {
  final VoiceOfflineReason reason;
  final String message;
  const VoiceOffline(this.reason, this.message);
}

/// Decodes one text frame. Throws [VoiceProtocolError] on anything unknown so
/// a malformed frame is dropped rather than half-applied.
VoiceServerFrame decodeVoiceServerFrame(Object? input) {
  final value = _frame(input);
  switch (value['type']) {
    case 'ready':
      final quota = value['quotaRemainingSeconds'];
      if (quota is! int || quota < 0) {
        throw const VoiceProtocolError(
          'voice assistant frame quota is invalid',
        );
      }
      return VoiceReady(_text(value, 'sessionId', 128), quota);
    case 'state':
      final state = value['state'];
      if (state != 'listening' && state != 'speaking') {
        throw const VoiceProtocolError(
          'voice assistant frame state is invalid',
        );
      }
      return VoiceLiveState(speaking: state == 'speaking');
    case 'transcript':
      final speaker = value['speaker'];
      if (speaker != 'user' && speaker != 'assistant') {
        throw const VoiceProtocolError(
          'voice assistant frame speaker is invalid',
        );
      }
      return VoiceTranscript(
        id: _text(value, 'id', 128),
        fromUser: speaker == 'user',
        text: _text(value, 'text'),
        at: _text(value, 'at', 64),
      );
    case 'tool':
      return VoiceToolUse(
        id: _text(value, 'id', 128),
        name: _text(value, 'name', 128),
        label: _text(value, 'label', 160),
        at: _text(value, 'at', 64),
      );
    case 'interrupted':
      return const VoiceInterrupted();
    case 'offline':
      final reason = VoiceOfflineReason.values
          .where((value1) => value1.name == value['reason'])
          .firstOrNull;
      if (reason == null) {
        throw const VoiceProtocolError(
          'voice assistant frame reason is invalid',
        );
      }
      return VoiceOffline(reason, _text(value, 'message', 1024));
    default:
      throw const VoiceProtocolError(
        'voice assistant server frame type is invalid',
      );
  }
}

/// The only text control this client sends. It ends the provider session
/// outright, which is what Pause means.
const Map<String, Object?> voiceStopFrame = {
  'schemaVersion': 1,
  'type': 'stop',
};

/// A Bot answer that arrived while nobody was connected. It waits in the
/// User's ledger until a session speaks it, which is why resuming hands the
/// whole list to the agent.
class VoicePendingAnswer {
  final String answerId;
  final String botId;
  final String botName;
  final String question;
  final String answer;
  final String answeredAt;
  const VoicePendingAnswer({
    required this.answerId,
    required this.botId,
    required this.botName,
    required this.question,
    required this.answer,
    required this.answeredAt,
  });
}

String _bounded(Object? value, String field, int max) {
  if (value is! String || value.isEmpty || value.length > max) {
    throw VoiceProtocolError('voice pending answer.$field is invalid');
  }
  return value;
}

VoicePendingAnswer decodeVoicePendingAnswer(Object? input) {
  if (input is! Map) {
    throw const VoiceProtocolError('voice pending answer is invalid');
  }
  final value = Map<String, Object?>.from(input);
  return VoicePendingAnswer(
    answerId: _bounded(value['answerId'], 'answerId', 128),
    botId: _bounded(value['botId'], 'botId', 128),
    botName: _bounded(value['botName'], 'botName', 160),
    question: _bounded(value['question'], 'question', 2000),
    answer: _bounded(value['answer'], 'answer', 4000),
    answeredAt: _bounded(value['answeredAt'], 'answeredAt', 64),
  );
}

/// What `GET /api/voice` says about answers still waiting to be spoken.
///
/// The ledger already drops briefed answers and orders the rest oldest first,
/// so this list is exactly what a resumed session hands to the agent. A row
/// that cannot be decoded is skipped: one bad row must not hide the others.
List<VoicePendingAnswer> decodeVoicePendingAnswers(Object? view) {
  if (view is! Map) return const [];
  final ledger = view['ledger'];
  if (ledger is! Map) return const [];
  final answers = ledger['pendingAnswers'];
  if (answers is! List) return const [];
  final decoded = <VoicePendingAnswer>[];
  for (final answer in answers.take(32)) {
    try {
      decoded.add(decodeVoicePendingAnswer(answer));
    } catch (_) {
      continue;
    }
  }
  return decoded;
}
