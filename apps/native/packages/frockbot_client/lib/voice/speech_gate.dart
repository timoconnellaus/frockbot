/// A speech gate with a pre-roll: when someone started talking, and when the
/// room has been quiet long enough to stop paying for it.
///
/// Timing is this object's whole job — onset, hangover, pre-roll. The label
/// "this frame is speech" can come from energy (the default: an adaptive
/// floor) or from a speech probability the caller already computed, which is
/// how Silero replaces the slammed-door failure without owning the clock.
/// Either way this is not a turn detector. Nothing above it may assume noise
/// has been rejected from the audio the upstream hears.
///
/// It decides exactly two things, and the caller decides the rest:
///
/// * **Wake.** A sleeping upstream is woken by a verified onset, and the
///   pre-roll ring is replayed ahead of the live audio so the first syllable
///   is not the price of waking up.
/// * **Barge-in.** Verified speech by a stricter margin, while the assistant
///   is speaking, is offered as a reason to stop it — the controller takes it
///   only for a capture whose playback echo it can cancel.
///
/// What it must never be used for is deciding whether an individual frame is
/// worth sending once the upstream is awake. The server's transcriber decides
/// where a turn ends and needs the silence after the words to decide it —
/// about half a second — so an awake session gets a frame every 40 ms (on a
/// capture that cannot cancel its own playback, silence stands in for the
/// microphone while the reply plays; that is the controller's rule, not this
/// gate's). [quietForMs] exists for the one policy that does stop the audio:
/// two minutes of quiet while listening.
///
/// Pure Dart over a level, an optional probability and a timestamp: no audio
/// API, no timers, no clock of its own. The caller supplies the timestamps,
/// which is what lets a test run two minutes of silence in a millisecond.
library;

import 'dart:collection';
import 'dart:math' as math;
import 'dart:typed_data';

/// What a room at rest sounds like to a working microphone, and so the line
/// between a device that is hearing and one handing over nothing.
///
/// A microphone picks up a room — a fan, the building, the device's own noise
/// — so this is far below anything the gate would call speech: it is not
/// [SpeechGateConfig.floor], which is a threshold for words. Only a device
/// delivering zeros sits under it.
const voiceRoomToneLevelV1 = 0.0005;

/// The RMS of one PCM16 little-endian frame, 0..1.
///
/// An odd trailing byte is ignored rather than read as half a sample.
double pcm16Rms(Uint8List bytes) {
  final samples = bytes.lengthInBytes ~/ 2;
  if (samples == 0) return 0;
  final view = ByteData.sublistView(bytes, 0, samples * 2);
  var sum = 0.0;
  for (var i = 0; i < samples; i++) {
    final sample = view.getInt16(i * 2, Endian.little) / 32768.0;
    sum += sample * sample;
  }
  return math.sqrt(sum / samples);
}

class SpeechGateConfig {
  /// How long one frame of audio is. Everything below is counted in frames.
  final Duration frame;

  /// Energy must hold above the floor for this long before the gate opens.
  final Duration onset;

  /// The gate stays open this long after the last loud frame, so a breath
  /// mid-sentence does not read as the end of one.
  final Duration hangover;

  /// How much audio is replayed ahead of an onset.
  final Duration preRoll;

  /// How far above the noise floor a frame must be to count as speech.
  final double onsetMargin;

  /// The stricter margin used while the assistant is speaking.
  final double bargeInMargin;

  /// Barge-in needs verified speech for this long.
  final Duration bargeInHold;

  /// Nothing quieter than this is speech, however quiet the room is.
  final double floor;

  /// Speech probability at or above this is an onset, when the caller is
  /// labelling frames (Silero) rather than using energy.
  final double speechThreshold;

  /// The stricter probability used for barge-in with a labelled frame.
  final double bargeSpeechThreshold;

  const SpeechGateConfig({
    this.frame = const Duration(milliseconds: 40),
    this.onset = const Duration(milliseconds: 120),
    this.hangover = const Duration(milliseconds: 900),
    this.preRoll = const Duration(milliseconds: 500),
    this.onsetMargin = 2.5,
    this.bargeInMargin = 4.5,
    this.bargeInHold = const Duration(milliseconds: 200),
    this.floor = 0.012,
    this.speechThreshold = 0.5,
    this.bargeSpeechThreshold = 0.7,
  });

  int get onsetFrames =>
      math.max(1, (onset.inMicroseconds / frame.inMicroseconds).ceil());
  int get preRollFrames =>
      math.max(1, (preRoll.inMicroseconds / frame.inMicroseconds).ceil());
  int get bargeInFrames =>
      math.max(1, (bargeInHold.inMicroseconds / frame.inMicroseconds).ceil());
}

/// What the caller should do with the frame it just offered.
class SpeechGateDecision {
  /// The frames to send, oldest first. On an onset this is the pre-roll ring
  /// ending with the frame just offered; while open it is that frame alone;
  /// while closed it is empty.
  final List<Uint8List> emit;

  /// Whether the gate is open — or inside its hangover, which is the same
  /// thing to a caller.
  final bool open;

  /// This frame is the one that opened the gate.
  final bool onset;

  /// This frame is the one that closed it.
  final bool closed;

  /// Verified speech by the stricter margin: enough to interrupt a reply.
  final bool bargeIn;

  const SpeechGateDecision({
    required this.emit,
    required this.open,
    required this.onset,
    required this.closed,
    required this.bargeIn,
  });
}

class SpeechGate {
  final SpeechGateConfig config;
  final ListQueue<Uint8List> _ring = ListQueue<Uint8List>();
  double _noiseFloor = 0;
  int _adapted = 0;
  int _consecutive = 0;
  int _bargeConsecutive = 0;
  bool _open = false;
  int _lastVoiceAt = 0;
  int _quietSince = 0;
  int _lastAt = 0;

  SpeechGate({this.config = const SpeechGateConfig(), int startedAtMs = 0})
    : _quietSince = startedAtMs,
      _lastAt = startedAtMs;

  bool get open => _open;

  /// When the gate last closed, in the caller's own milliseconds. While the
  /// gate is open this is the moment it opened, which no caller reads.
  int get quietSince => _quietSince;

  /// How long the gate has been closed at [nowMs]; zero while it is open.
  int quietForMs(int nowMs) => _open ? 0 : math.max(0, nowMs - _quietSince);

  /// The adaptive noise floor, exposed for tests and diagnostics.
  double get noiseFloor => _noiseFloor;

  double get threshold =>
      math.max(_noiseFloor * config.onsetMargin, config.floor);

  /// Offers one frame and its level. [atMs] is the caller's clock.
  ///
  /// [speechScore] is a speech probability 0..1. When it is set, onset and
  /// barge-in read it instead of energy — that is the Silero path. The energy
  /// floor is left alone on that path: a slammed door is loud and not speech,
  /// and must not train the fallback.
  SpeechGateDecision offer(
    Uint8List frame,
    double level,
    int atMs, {
    double? speechScore,
  }) {
    _lastAt = atMs;
    final loud = speechScore != null
        ? speechScore >= config.speechThreshold
        : level >= threshold;
    // The floor only learns from quiet: adapting to speech would raise the
    // bar until nothing is speech.
    if (speechScore == null && !loud) {
      final alpha = _adapted < 10 ? 0.25 : 0.05;
      _noiseFloor = _noiseFloor * (1 - alpha) + level * alpha;
      _adapted++;
    }
    _consecutive = loud ? _consecutive + 1 : 0;

    final bargeLoud = speechScore != null
        ? speechScore >= config.bargeSpeechThreshold
        : level >=
              math.max(_noiseFloor * config.bargeInMargin, config.floor * 2);
    _bargeConsecutive = bargeLoud ? _bargeConsecutive + 1 : 0;
    final bargeIn = _bargeConsecutive >= config.bargeInFrames;

    _ring.addLast(frame);
    while (_ring.length > config.preRollFrames) {
      _ring.removeFirst();
    }

    var onset = false;
    var closed = false;
    if (_open) {
      if (loud) _lastVoiceAt = atMs;
      if (atMs - _lastVoiceAt >= config.hangover.inMilliseconds) {
        _open = false;
        closed = true;
        _quietSince = atMs;
      }
    } else if (_consecutive >= config.onsetFrames) {
      _open = true;
      onset = true;
      _lastVoiceAt = atMs;
    }

    // Draining on every emitted frame is what keeps the ring from ever
    // sending the same frame twice: what leaves is gone. The frame that
    // closes the gate is a hangover past the last word, so it stays in the
    // ring as pre-roll for whatever is said next.
    final emit = <Uint8List>[];
    if (_open) {
      emit.addAll(_ring);
      _ring.clear();
    }
    return SpeechGateDecision(
      emit: emit,
      open: _open,
      onset: onset,
      closed: closed,
      bargeIn: bargeIn,
    );
  }

  /// The pre-roll as it stands, oldest first, without disturbing the gate.
  /// This is what a wake replays when the onset itself was not the drain.
  List<Uint8List> preRoll() => List<Uint8List>.of(_ring);

  /// Drops the pre-roll: what the caller has already sent must not be sent
  /// again on the next onset.
  void clearPreRoll() => _ring.clear();

  /// Forgets the conversation but keeps the learned noise floor: a mute or a
  /// sleep is not a new room.
  void reset() {
    _ring.clear();
    _consecutive = 0;
    _bargeConsecutive = 0;
    _open = false;
    _quietSince = _lastAt;
  }
}
