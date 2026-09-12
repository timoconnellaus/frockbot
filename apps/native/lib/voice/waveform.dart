import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';

import '../theme/frock_theme.dart';

const double voiceLevelEpsilon = 0.012;
const voiceLobeTintsPerson = [
  Colors.white,
  Color(0xffffd6e3),
  FrockTheme.accentSoft,
];
const voiceLobeTintsBot = [
  FrockTheme.accentDeep,
  Color(0xffc2295b),
  Color(0xff7a0f38),
];

/// A time-based envelope: identical timing at 60 Hz and 120 Hz. Fast attack
/// follows the start of a word; a gentler release bridges gaps in PCM frames.
class VoiceEnvelope {
  double value = 0;

  static double target(double level) {
    if (!level.isFinite || level <= voiceLevelEpsilon) return 0;
    return math.min(1, math.pow(level.clamp(0, 1), 0.55) * 1.4).toDouble();
  }

  void advance(double target, double seconds) {
    final tau = target > value ? 0.065 : 0.22;
    value += (target - value) * (1 - math.exp(-seconds / tau));
    if (target == 0 && value < 0.002) value = 0;
  }
}

class _WaveFrame extends ChangeNotifier {
  final person = VoiceEnvelope();
  final bot = VoiceEnvelope();
  double personTarget = 0;
  double botTarget = 0;
  double time = 0;

  bool get resting => person.value == 0 && bot.value == 0;

  void advance(double seconds) {
    person.advance(personTarget, seconds);
    bot.advance(botTarget, seconds);
    time += seconds;
    notifyListeners();
  }

  void snap() {
    person.value = personTarget;
    bot.value = botTarget;
    notifyListeners();
  }
}

/// Audio updates change targets; vsync paints the interpolation without
/// rebuilding or laying out the composer, footer, or their controls.
class VoiceWaveform extends StatefulWidget {
  final Listenable source;
  final double Function() microphone;
  final double Function()? playback;
  final bool enabled;
  final bool onAccent;
  const VoiceWaveform({
    super.key,
    required this.source,
    required this.microphone,
    this.playback,
    this.enabled = true,
    this.onAccent = false,
  });

  @override
  State<VoiceWaveform> createState() => _VoiceWaveformState();
}

class _VoiceWaveformState extends State<VoiceWaveform>
    with SingleTickerProviderStateMixin {
  late final Ticker _ticker = createTicker(_tick);
  final _frame = _WaveFrame();
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
    if (_reducedMotion) {
      _ticker.stop();
      _frame.snap();
    } else if (!_ticker.isActive &&
        (!_frame.resting || _frame.personTarget > 0 || _frame.botTarget > 0)) {
      _last = Duration.zero;
      _ticker.start();
    }
  }

  void _tick(Duration elapsed) {
    // A backgrounded tab must not jump the wave ahead by minutes on resume.
    final seconds = ((elapsed - _last).inMicroseconds / 1e6).clamp(0.0, 0.05);
    _last = elapsed;
    _frame.advance(seconds);
    if (_frame.resting && _frame.personTarget == 0 && _frame.botTarget == 0) {
      _ticker.stop();
    }
  }

  @override
  Widget build(BuildContext context) => RepaintBoundary(
    child: ExcludeSemantics(
      child: CustomPaint(
        painter: _WavePainter(
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

class _WavePainter extends CustomPainter {
  final _WaveFrame frame;
  final Color accent;
  final bool onAccent;
  _WavePainter({
    required this.frame,
    required this.accent,
    required this.onAccent,
  }) : super(repaint: frame);

  @override
  void paint(Canvas canvas, Size size) {
    if (size.isEmpty) return;
    final middle = size.height / 2;
    final person = frame.person.value;
    final bot = frame.bot.value;
    final level = math.max(person, bot);
    final botMix = person + bot == 0 ? 0.0 : bot / (person + bot);
    final base = onAccent ? Colors.white : accent;
    canvas.drawRRect(
      RRect.fromRectAndRadius(
        Rect.fromLTWH(0, middle - 1, size.width, 2),
        const Radius.circular(1),
      ),
      Paint()..color = base.withValues(alpha: onAccent ? 0.35 : 0.22),
    );
    if (level == 0) return;
    // Fixed, overlapping ribbons evolve continuously. No random respawns or
    // per-frame speaker switches can pop the shape or its colour.
    for (var layer = 2; layer >= 0; layer--) {
      final path = Path()..moveTo(0, middle);
      for (final sign in [1.0, -1.0]) {
        for (var step = 0; step <= 80; step++) {
          final x = sign > 0 ? step / 80 : 1 - step / 80;
          final envelope = math.pow(math.sin(x * math.pi), 2).toDouble();
          final ripple =
              0.62 +
              0.25 *
                  math.sin(x * math.pi * 3 + frame.time * 2.2 + layer * 1.6) +
              0.13 * math.sin(x * math.pi * 5 - frame.time * 1.4 + layer);
          final height = level * size.height * 0.44 * envelope * ripple;
          path.lineTo(x * size.width, middle + sign * height);
        }
      }
      path.close();
      final tint = onAccent
          ? Color.lerp(
              voiceLobeTintsPerson[layer],
              voiceLobeTintsBot[layer],
              botMix,
            )!
          : Color.lerp(accent, FrockTheme.accentSoft, layer / 3)!;
      canvas.drawPath(path, Paint()..color = tint.withValues(alpha: 0.5));
    }
  }

  @override
  bool shouldRepaint(_WavePainter oldDelegate) =>
      oldDelegate.frame != frame ||
      oldDelegate.accent != accent ||
      oldDelegate.onAccent != onAccent;
}
