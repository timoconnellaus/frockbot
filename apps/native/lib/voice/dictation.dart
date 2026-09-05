/// The phone's end of the composer dictation protocol.
///
/// This mirrors `packages/protocol/src/voice-dictation.ts` and the browser
/// client in `apps/cloudflare/src/client/voice-dictation.ts` exactly: audio is
/// binary PCM16LE, every control is a JSON text frame, and the Durable Object
/// never forwards a provider frame verbatim. Like the assistant protocol these
/// frames sit outside the generated schema, so the decoder is written by hand
/// and kept honest by tests.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import '../client/transport.dart';

/// The `?version=` this client presents; a mismatch is refused at the door.
const int voiceDictationVersion = 1;

/// What the upstream transcription session is told to expect, and therefore
/// what the microphone must produce: PCM16LE mono at this rate.
///
/// Not the assistant's 16 kHz: the transcription session is opened with
/// `format: { type: "audio/pcm", rate: 24_000 }` (`voice-upstream.ts`).
const int voiceDictationSampleRate = 24000;

/// 32 ms at [voiceDictationSampleRate] — the browser worklet's frame.
const int voiceDictationFrameSamples = voiceDictationSampleRate * 32 ~/ 1000;

class DictationProtocolError implements Exception {
  final String message;
  const DictationProtocolError(this.message);
  @override
  String toString() => message;
}

/// A frame the VoiceSession Durable Object sent to this device.
sealed class DictationServerFrame {
  const DictationServerFrame();
}

/// The upstream session is open; queued audio may now go.
class DictationReady extends DictationServerFrame {
  const DictationReady();
}

/// Text heard so far in the segment still being spoken.
class DictationDelta extends DictationServerFrame {
  final String text;
  const DictationDelta(this.text);
}

/// One finished segment; it replaces the deltas that built it.
class DictationSettled extends DictationServerFrame {
  final String text;
  const DictationSettled(this.text);
}

/// Everything captured has been transcribed. The draft is the person's again.
class DictationFinal extends DictationServerFrame {
  const DictationFinal();
}

/// Dictation cannot continue, and [message] is a sentence to show unchanged —
/// an exhausted quota, an unconfigured deployment, a refused upstream.
class DictationFailed extends DictationServerFrame {
  final String message;
  const DictationFailed(this.message);
}

Map<String, Object?> _frame(Object? input) {
  if (input is! Map) {
    throw const DictationProtocolError('voice dictation frame must be object');
  }
  final value = Map<String, Object?>.from(input);
  if (value['schemaVersion'] != 1) {
    throw const DictationProtocolError(
      'voice dictation frame version is unsupported',
    );
  }
  return value;
}

/// Bounded for the same reason the server bounds it: a delta lands in a draft
/// somebody then sends, so an endless upstream must not grow it endlessly.
String _text(Map<String, Object?> value, String field) {
  final found = value[field];
  if (found is! String || found.length > 8192) {
    throw DictationProtocolError('voice dictation frame.$field is invalid');
  }
  return found;
}

/// Decodes one text frame. Throws [DictationProtocolError] on anything this
/// client cannot read, so a newer server's frame is dropped rather than
/// half-applied.
DictationServerFrame decodeDictationServerFrame(Object? input) {
  final value = _frame(input);
  switch (value['type']) {
    case 'ready':
      return const DictationReady();
    case 'delta':
      return DictationDelta(_text(value, 'text'));
    case 'transcript':
      return DictationSettled(_text(value, 'text'));
    case 'final':
      return const DictationFinal();
    case 'error':
      return DictationFailed(_text(value, 'message'));
    default:
      throw const DictationProtocolError(
        'voice dictation server frame type is invalid',
      );
  }
}

/// Stop capturing, transcribe what is buffered, and answer `final`.
const Map<String, Object?> dictationCommitFrame = {
  'schemaVersion': 1,
  'type': 'commit',
};

/// Throw the buffer away. What happens to the draft is the client's business.
const Map<String, Object?> dictationCancelFrame = {
  'schemaVersion': 1,
  'type': 'cancel',
};

/// One dictation socket. Short-lived: a session is one utterance.
abstract interface class DictationSession {
  /// Decoded text frames. Undecodable frames are dropped, never surfaced.
  Stream<DictationServerFrame> get frames;

  /// Queues one PCM16LE frame at [voiceDictationSampleRate]. Audio produced
  /// before `ready` is held, in order, so the first syllable is not the thing
  /// that gets lost.
  void sendAudio(Uint8List pcm16);

  void commit();
  void cancel();
  Future<void> close();
}

/// Opens dictation sockets. Faked in tests.
abstract interface class DictationBackend {
  Future<DictationSession> open();
}

/// About ten seconds at 24 kHz; a server that never says `ready` must not be
/// able to grow this list forever.
const int _maxQueuedFrames = 320;

class SocketDictationSession implements DictationSession {
  final WebSocket _socket;
  final _frames = StreamController<DictationServerFrame>.broadcast();
  final List<Uint8List> _queued = [];
  bool _ready = false;
  bool _finished = false;

  SocketDictationSession(this._socket) {
    _socket.listen(
      _receive,
      onDone: () {
        _finished = true;
        unawaited(_frames.close());
      },
      onError: (Object _) {
        if (_finished) return;
        _finished = true;
        if (!_frames.isClosed) {
          _frames.add(
            const DictationFailed(
              'The dictation connection dropped. Try again in a moment.',
            ),
          );
        }
      },
      cancelOnError: false,
    );
  }

  void _receive(Object? data) {
    // Dictation is text in one direction only; a binary frame here is noise.
    if (data is! String) return;
    DictationServerFrame frame;
    try {
      frame = decodeDictationServerFrame(
        decodeBoundedJson(data, maxBytes: 32768),
      );
    } catch (_) {
      return;
    }
    if (frame is DictationReady) {
      _ready = true;
      for (final pending in _queued) {
        _send(pending);
      }
      _queued.clear();
    }
    if (!_frames.isClosed) _frames.add(frame);
  }

  void _send(Object frame) {
    if (_socket.readyState != WebSocket.open) return;
    try {
      _socket.add(frame);
    } catch (_) {
      // A socket refusing a frame is already closing; the close event is what
      // changes what the composer says.
    }
  }

  @override
  Stream<DictationServerFrame> get frames => _frames.stream;

  @override
  void sendAudio(Uint8List pcm16) {
    if (_finished) return;
    if (!_ready) {
      if (_queued.length < _maxQueuedFrames) _queued.add(pcm16);
      return;
    }
    _send(pcm16);
  }

  @override
  void commit() => _send(jsonEncode(dictationCommitFrame));

  @override
  void cancel() => _send(jsonEncode(dictationCancelFrame));

  @override
  Future<void> close() async {
    _finished = true;
    try {
      await _socket.close(WebSocketStatus.normalClosure, 'dictation ended');
    } catch (_) {
      // Closing an already closed socket is a no-op from the caller's view.
    }
  }
}

/// The hosted backend: the same route, headers and framing as the web client.
class BackendDictation implements DictationBackend {
  final NativeApi api;
  const BackendDictation(this.api);

  @override
  Future<DictationSession> open() async {
    final uri = Uri.parse(hostedOrigin).replace(
      scheme: 'wss',
      path: '/api/voice/dictation',
      queryParameters: {'version': '$voiceDictationVersion'},
    );
    final socket = await WebSocket.connect(
      uri.toString(),
      headers: await api.headers(),
    ).timeout(const Duration(seconds: 10));
    return SocketDictationSession(socket);
  }
}

/// What has been heard so far: the finished segments, and the deltas of the
/// one still being spoken.
///
/// A provider streams a segment as deltas and then re-sends it, punctuated and
/// capitalised, as a finished transcript. Keeping the two apart is what lets
/// the finished form replace the rough one in place instead of appearing
/// twice. Mirrors `VoiceDictationTranscriptV1` on the web.
class DictationTranscript {
  final List<String> _settled = [];
  String _pending = '';

  void delta(String text) => _pending += text;

  /// One finished segment; it replaces the deltas that built it.
  void settle(String text) {
    final trimmed = text.trim();
    if (trimmed.isNotEmpty) _settled.add(trimmed);
    _pending = '';
  }

  /// Everything dictated in this session, as one string.
  String text() {
    final settled = _settled.join(' ');
    final pending = _pending.trim();
    if (settled.isEmpty) return pending;
    if (pending.isEmpty) return settled;
    return '$settled $pending';
  }

  bool get isEmpty => text().isEmpty;

  void reset() {
    _settled.clear();
    _pending = '';
  }
}

/// A draft and the exact text dictation last wrote into it.
class DictationDraft {
  final String draft;
  final String tail;
  const DictationDraft(this.draft, this.tail);
}

String _joined(String head, String tail) {
  if (head.isEmpty) return tail;
  if (tail.isEmpty) return head;
  return RegExp(r'\s$').hasMatch(head) ? '$head$tail' : '$head $tail';
}

/// Puts [next] where [previous] was, or on the end when it has gone.
///
/// `lastIndexOf`, not `indexOf`: dictating the same short word twice must
/// rewrite the second one. Nothing here reads the caret, so it holds while a
/// phone keyboard is mid-word.
DictationDraft applyDictationTail(String draft, String previous, String next) {
  if (previous.isEmpty) return DictationDraft(_joined(draft, next), next);
  final at = draft.lastIndexOf(previous);
  if (at < 0) return DictationDraft(_joined(draft, next), next);
  final before = draft.substring(0, at);
  final after = draft.substring(at + previous.length);
  return DictationDraft('$before$next$after', next);
}

/// Takes the dictated tail back out of a draft, leaving what was typed.
///
/// The separator [_joined] added is removed with it, so cancelling twice in a
/// row cannot leave a trail of spaces behind.
String removeDictationTail(String draft, String tail) {
  if (tail.isEmpty) return draft;
  final at = draft.lastIndexOf(tail);
  if (at < 0) return draft;
  final before = draft.substring(0, at);
  final after = draft.substring(at + tail.length);
  if (after.isEmpty) return before.replaceFirst(RegExp(r'\s$'), '');
  return '$before$after';
}
