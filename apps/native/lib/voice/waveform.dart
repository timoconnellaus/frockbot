/// The voice meter: five pills that say who is being heard.
///
/// One object, whose motion source changes with the call. Sound from the
/// person raises the pills in white, sound from the Bot raises them in the
/// deep rose, and every state that has no sound to show is told by *how* the
/// pills move rather than by a label: a slow breath together while the call
/// connects, a regular chase while the Bot thinks, stillness while nothing is
/// being heard. Regular motion is the machine's own; irregular motion is
/// somebody's voice.
///
/// How it is drawn is what keeps it smooth. Audio arrives as targets; a
/// [Ticker] integrates every pill toward its target each display frame and
/// the painter repaints through its `repaint` listenable — no build, no
/// layout, no `setState` anywhere on the audio path, and a `RepaintBoundary`
/// keeps the footer's layer to itself. A frame is five `drawRRect` calls on
/// one reused [Paint]: nothing is allocated per frame and no path is built.
library;

import 'dart:math' as math;

import 'package:flutter/foundation.dart' show ValueListenable;
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';

import '../theme/frock_theme.dart';

const double voiceLevelEpsilon = 0.012;

/// An envelope target loud enough to be a voice rather than the room.
const double voiceSpeechTarget = 0.35;
const voiceLobeTintsPerson = [Colors.white];
const voiceLobeTintsBot = [FrockTheme.accentDeep];

/// What the meter is showing when no sound decides it.
enum VoiceMeterMode {
  /// Nothing to show: the pills rest as dots.
  resting,

  /// The call is opening: one slow breath, all pills together.
  connecting,

  /// Ready and hearing nothing: dots, still.
  listening,

  /// The Bot is composing: a regular chase along the row.
  thinking,

  /// The reply is playing: the pills follow it in the Bot's colour.
  speaking,

  /// Quiet long enough that the upstream sleeps: dim dots.
  asleep,

  /// The microphone is off: dim dots.
  muted,
}

/// A time-based envelope: identical timing at 60 Hz and 120 Hz. A fast
/// attack follows the start of a word within a couple of frames; the release
/// is slower so the gaps between syllables read as one sound.
class VoiceEnvelope {
  double value = 0;
  final double attack;
  final double release;
  VoiceEnvelope({this.attack = 0.022, this.release = 0.2});

  static double target(double level) {
    if (!level.isFinite || level <= voiceLevelEpsilon) return 0;
    return math.min(1, math.pow(level.clamp(0, 1), 0.55) * 1.4).toDouble();
  }

  void advance(double target, double seconds) {
    final tau = target > value ? attack : release;
    value += (target - value) * (1 - math.exp(-seconds / tau));
    if (target == 0 && value < 0.002) value = 0;
  }
}

const int voiceMeterBars = 5;

/// Everything the painter reads, advanced once per display frame.
class _MeterFrame extends ChangeNotifier {
  /// One envelope per pill, the middle fastest, so a word lands as a spread
  /// rather than as five identical jumps.
  final bars = [
    for (var i = 0; i < voiceMeterBars; i++)
      VoiceEnvelope(
        attack: 0.02 + 0.012 * (i - 2).abs(),
        release: 0.18 + 0.03 * (i - 2).abs(),
      ),
  ];

  /// Who the pills are coloured for: 0 the person, 1 the Bot.
  final bot = VoiceEnvelope(attack: 0.12, release: 0.3);

  /// How present the row is: 1 in a live call, lower asleep or muted.
  final presence = VoiceEnvelope(attack: 0.25, release: 0.25)..value = 1;

  double personTarget = 0;
  double botTarget = 0;
  VoiceMeterMode mode = VoiceMeterMode.resting;
  double time = 0;

  bool get selfDriven =>
      mode == VoiceMeterMode.connecting || mode == VoiceMeterMode.thinking;

  double get presenceTarget => switch (mode) {
    VoiceMeterMode.asleep || VoiceMeterMode.muted => 0.45,
    _ => 1,
  };

  /// Thinking breaks its chase for the reply or for speech, not room noise.
  double get thinkingPerson =>
      personTarget >= voiceSpeechTarget ? personTarget : 0;

  double get botMixTarget => switch (mode) {
    VoiceMeterMode.speaking => 1,
    VoiceMeterMode.thinking =>
      thinkingPerson + botTarget == 0
          ? 1
          : botTarget / (thinkingPerson + botTarget),
    _ =>
      personTarget + botTarget == 0
          ? bot.value
          : botTarget / (personTarget + botTarget),
  };

  /// The pill targets this frame: a voice, or the mode's own motion.
  double targetFor(int index) {
    var level = math.max(personTarget, botTarget);
    switch (mode) {
      case VoiceMeterMode.connecting:
        return 0.12 + 0.1 * (0.5 + 0.5 * math.sin(time * 2.6));
      case VoiceMeterMode.thinking:
        level = math.max(thinkingPerson, botTarget);
        if (level > 0) break;
        return 0.14 + 0.2 * (0.5 + 0.5 * math.sin(time * 5.2 - index * 1.1));
      default:
        break;
    }
    if (level == 0) return 0;
    // A slow drift per pill so five pills at one level are not one bar.
    final drift =
        0.62 +
        0.38 * (0.5 + 0.5 * math.sin(time * (3.1 + index * 0.7) + index));
    return math.min(1, level * drift * (index == 2 ? 1.15 : 1));
  }

  bool get resting {
    if (selfDriven) return false;
    if (personTarget > 0 || botTarget > 0) return false;
    for (final bar in bars) {
      if (bar.value != 0) return false;
    }
    return (bot.value - botMixTarget).abs() < 0.002 &&
        (presence.value - presenceTarget).abs() < 0.002;
  }

  void advance(double seconds) {
    time += seconds;
    for (var i = 0; i < bars.length; i++) {
      bars[i].advance(targetFor(i), seconds);
    }
    bot.advance(botMixTarget, seconds);
    presence.advance(presenceTarget, seconds);
    notifyListeners();
  }

  void snap() {
    for (var i = 0; i < bars.length; i++) {
      bars[i].value = targetFor(i);
    }
    bot.value = botMixTarget;
    presence.value = presenceTarget;
    notifyListeners();
  }
}

/// Audio updates change targets; vsync paints the interpolation without
/// rebuilding or laying out the composer, footer, or their controls.
class VoiceWaveform extends StatefulWidget {
  final Listenable source;
  final double Function() microphone;
  final double Function()? playback;
  final VoiceMeterMode Function()? mode;
  final bool enabled;
  final bool onAccent;
  const VoiceWaveform({
    super.key,
    required this.source,
    required this.microphone,
    this.playback,
    this.mode,
    this.enabled = true,
    this.onAccent = false,
  });

  @override
  State<VoiceWaveform> createState() => _VoiceWaveformState();
}

class _VoiceWaveformState extends State<VoiceWaveform>
    with SingleTickerProviderStateMixin {
  late final Ticker _ticker = createTicker(_tick);
  final _frame = _MeterFrame();
  Duration _last = Duration.zero;
  bool _reducedMotion = false;

  @override
  void initState() {
    super.initState();
    widget.source.addListener(_sample);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _reducedMotion = MediaQuery.disableAnimationsOf(context);
    _sample();
  }

  @override
  void didUpdateWidget(VoiceWaveform oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.source != oldWidget.source) {
      oldWidget.source.removeListener(_sample);
      widget.source.addListener(_sample);
    }
    _sample();
  }

  void _sample() {
    _frame.personTarget = widget.enabled
        ? VoiceEnvelope.target(widget.microphone())
        : 0;
    _frame.botTarget = widget.enabled
        ? VoiceEnvelope.target(widget.playback?.call() ?? 0)
        : 0;
    _frame.mode = widget.enabled
        ? widget.mode?.call() ?? VoiceMeterMode.listening
        : VoiceMeterMode.resting;
    if (_reducedMotion) {
      _ticker.stop();
      // Reduced motion shows the level and the state; it does not run the
      // machine's own motion, which would be a ticker for nothing.
      if (_frame.selfDriven) _frame.mode = VoiceMeterMode.listening;
      _frame.snap();
    } else if (!_ticker.isActive && !_frame.resting) {
      _last = Duration.zero;
      _ticker.start();
    }
  }

  void _tick(Duration elapsed) {
    // A backgrounded tab must not jump the meter ahead by minutes on resume.
    final seconds = ((elapsed - _last).inMicroseconds / 1e6).clamp(0.0, 0.05);
    _last = elapsed;
    _frame.advance(seconds);
    if (_frame.resting) _ticker.stop();
  }

  @override
  Widget build(BuildContext context) => RepaintBoundary(
    child: ExcludeSemantics(
      child: CustomPaint(
        painter: _MeterPainter(
          frame: _frame,
          accent: Theme.of(context).colorScheme.primary,
          onAccent: widget.onAccent,
        ),
        size: Size.infinite,
      ),
    ),
  );

  @override
  void dispose() {
    widget.source.removeListener(_sample);
    _ticker.dispose();
    _frame.dispose();
    super.dispose();
  }
}

class _MeterPainter extends CustomPainter {
  final _MeterFrame frame;
  final Color accent;
  final bool onAccent;
  final Paint _paint = Paint();
  _MeterPainter({
    required this.frame,
    required this.accent,
    required this.onAccent,
  }) : super(repaint: frame);

  static const double _width = 10;
  static const double _gap = 8;

  @override
  void paint(Canvas canvas, Size size) {
    if (size.isEmpty) return;
    final middle = size.height / 2;
    final rowWidth = voiceMeterBars * _width + (voiceMeterBars - 1) * _gap;
    final left = (size.width - rowWidth) / 2;
    final reach = size.height * 0.78 - _width;
    final person = onAccent ? Colors.white : accent;
    final botTint = onAccent
        ? FrockTheme.accentDeep
        : Color.lerp(accent, FrockTheme.accentDeep, 0.6)!;
    final tint = Color.lerp(person, botTint, frame.bot.value)!;
    _paint.color = tint.withValues(alpha: frame.presence.value);
    for (var i = 0; i < voiceMeterBars; i++) {
      final height = _width + reach * frame.bars[i].value;
      final x = left + i * (_width + _gap);
      canvas.drawRRect(
        RRect.fromRectAndRadius(
          Rect.fromLTWH(x, middle - height / 2, _width, height),
          const Radius.circular(_width / 2),
        ),
        _paint,
      );
    }
  }

  @override
  bool shouldRepaint(_MeterPainter oldDelegate) =>
      oldDelegate.frame != frame ||
      oldDelegate.accent != accent ||
      oldDelegate.onAccent != onAccent;
}

/// The dictation meter: a strip of bars that scrolls while the microphone is
/// open, across whatever width the row gives it.
///
/// It says a different thing from the five pills of a call. A call's meter
/// answers "who is being heard right now"; this one answers "am I still
/// recording" — so it keeps a history rather than a level, and the history
/// moves whether or not anyone is speaking. Silence is a row of dots
/// travelling left; a word is a hill travelling left with them. A strip that
/// stopped moving when nobody spoke would read as a capture that had died.
///
/// Drawn the same way as [VoiceWaveform]: a [Ticker] pushes one bar into a
/// ring buffer every [dictationBarPeriod] and the painter repaints off its
/// own listenable, so nothing above it builds or lays out per audio frame.
const double dictationBarWidth = 4;
const double dictationBarGap = 2;
const Duration dictationBarPeriod = Duration(milliseconds: 60);

/// The resting dot: silence is still drawn, or a pause would look like a gap
/// in the recording.
const double dictationBarFloor = 0.06;

class _DictationTrack extends ChangeNotifier {
  /// Newest last. Sized in [resize] from the width the painter is given.
  List<double> bars = const [];

  /// The loudest sample since the last bar was pushed: a bar is a peak, not
  /// whatever happened to be in flight at the moment the ticker fired.
  double peak = 0;
  double _carry = 0;
  bool capturing = true;

  /// Called by the painter with the width it was given, so it never notifies:
  /// a repaint raised from inside a paint is a framework assertion, and the
  /// frame doing the resizing is already drawing the result.
  void resize(int count) {
    if (bars.length == count) return;
    final next = List<double>.filled(count, 0);
    final overlap = math.min(count, bars.length);
    // Keep the newest bars: the strip grows and shrinks from its left edge.
    for (var i = 0; i < overlap; i++) {
      next[count - 1 - i] = bars[bars.length - 1 - i];
    }
    bars = next;
  }

  void sample(double level) {
    final target = VoiceEnvelope.target(level);
    if (target > peak) peak = target;
  }

  /// Advances by whole bars, so the strip travels at the same speed whatever
  /// the display's refresh rate is.
  void advance(double seconds) {
    if (bars.isEmpty) return;
    _carry += seconds;
    final period = dictationBarPeriod.inMicroseconds / 1e6;
    var pushed = false;
    while (_carry >= period) {
      _carry -= period;
      for (var i = 0; i < bars.length - 1; i++) {
        bars[i] = bars[i + 1];
      }
      bars[bars.length - 1] = capturing
          ? math.max(dictationBarFloor, peak)
          : dictationBarFloor;
      peak = 0;
      pushed = true;
    }
    if (pushed) notifyListeners();
  }
}

/// The scrolling strip beside the dictation controls.
class DictationWaveform extends StatefulWidget {
  final ValueListenable<double> level;

  /// Whether the microphone is open. A strip that is starting or finishing
  /// keeps travelling; it simply has nothing to draw but the floor.
  final bool capturing;
  const DictationWaveform({
    super.key,
    required this.level,
    this.capturing = true,
  });

  @override
  State<DictationWaveform> createState() => _DictationWaveformState();
}

class _DictationWaveformState extends State<DictationWaveform>
    with SingleTickerProviderStateMixin {
  late final Ticker _ticker = createTicker(_tick);
  final _track = _DictationTrack();
  Duration _last = Duration.zero;
  bool _reducedMotion = false;

  @override
  void initState() {
    super.initState();
    widget.level.addListener(_sample);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _reducedMotion = MediaQuery.disableAnimationsOf(context);
    _run();
  }

  @override
  void didUpdateWidget(DictationWaveform oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.level != oldWidget.level) {
      oldWidget.level.removeListener(_sample);
      widget.level.addListener(_sample);
    }
    _run();
  }

  void _run() {
    _track.capturing = widget.capturing;
    // Reduced motion keeps the level and drops the travel: the bars follow
    // what is being heard as it arrives, and no ticker runs for the scroll.
    if (_reducedMotion) {
      _ticker.stop();
      return;
    }
    if (!_ticker.isActive) {
      _last = Duration.zero;
      _ticker.start();
    }
  }

  void _sample() {
    _track.sample(widget.level.value);
    if (_reducedMotion) _track.advance(dictationBarPeriod.inMicroseconds / 1e6);
  }

  void _tick(Duration elapsed) {
    final seconds = ((elapsed - _last).inMicroseconds / 1e6).clamp(0.0, 0.25);
    _last = elapsed;
    _track.sample(widget.level.value);
    _track.advance(seconds);
  }

  @override
  Widget build(BuildContext context) => RepaintBoundary(
    child: ExcludeSemantics(
      child: CustomPaint(
        painter: _DictationPainter(
          track: _track,
          tint: Theme.of(context).colorScheme.primary,
        ),
        size: Size.infinite,
      ),
    ),
  );

  @override
  void dispose() {
    widget.level.removeListener(_sample);
    _ticker.dispose();
    _track.dispose();
    super.dispose();
  }
}

class _DictationPainter extends CustomPainter {
  final _DictationTrack track;
  final Color tint;
  final Paint _paint = Paint();
  _DictationPainter({required this.track, required this.tint})
    : super(repaint: track);

  @override
  void paint(Canvas canvas, Size size) {
    if (size.isEmpty) return;
    const pitch = dictationBarWidth + dictationBarGap;
    final count = math.max(1, ((size.width + dictationBarGap) / pitch).floor());
    track.resize(count);
    final middle = size.height / 2;
    final reach = size.height - dictationBarWidth;
    // The row is drawn from the right edge, so the newest bar is always in
    // the same place however the strip is sized.
    final right = size.width;
    _paint.color = tint;
    for (var i = 0; i < count; i++) {
      final value = track.bars[i];
      final height = dictationBarWidth + reach * value;
      final x = right - (count - i) * pitch + dictationBarGap;
      canvas.drawRRect(
        RRect.fromRectAndRadius(
          Rect.fromLTWH(x, middle - height / 2, dictationBarWidth, height),
          const Radius.circular(dictationBarWidth / 2),
        ),
        _paint,
      );
    }
  }

  @override
  bool shouldRepaint(_DictationPainter oldDelegate) =>
      oldDelegate.track != track || oldDelegate.tint != tint;
}
