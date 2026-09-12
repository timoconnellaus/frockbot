/// The voice footer: a pink slab, a living meter, a mute toggle and a way out.
///
/// It is trust chrome, not a feature slot. The shell draws it below the whole
/// three-tier layout so it survives a Bot switch, a page and a drawer, and
/// the app above it stays usable while a call is live.
///
/// The slab is the message: while the microphone is on, the bottom of the
/// app is the brand pink, and no border or label is needed to say so. On it
/// sits one meter, not two. Soft lobes bloom on a support line, drawn
/// additively so where they overlap they go brighter; they are white and
/// pale pink while the person speaks and deep rose while the Bot does, so
/// the two voices share one shape and are told apart by weight, never by a
/// second row. The lobes are driven by the real level and by nothing else:
/// when the room is silent they collapse to the line, because a shape that
/// moves while nobody speaks is a lie about what the microphone is doing.
///
/// There is no text, header, transcript, label or status here on purpose.
library;

import 'dart:collection';
import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' show Vertices, VertexMode;

import 'package:flutter/foundation.dart' show ValueListenable;
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';

import '../shell/semantics.dart';
import '../theme/frock_theme.dart';
import 'assistant.dart';

/// The footer's height, above the system inset. It is the same on a phone
/// and on a desktop: the controls are always shown, so there is nothing to
/// compact away. On a phone the footer also covers the bottom inset — the
/// gesture bar or the navigation buttons — in its own colour, so the controls
/// sit above the app switcher rather than under it.
const double voiceFooterHeight = 84;

/// The meter's stage on a wide window. On a phone the stage is whatever is
/// left beside the controls; on a desktop it stops growing here and sits
/// centred, because lobes stretched across a thousand points are not a
/// meter anyone can read.
const double voiceFooterStageMaxWidth = 420;

/// The gap between the slab's left edge and the stage, and the room the two
/// controls keep on the right: two 40 point circles, a 10 point gap between
/// them, 16 points to the edge and 20 points to the stage.
const double voiceFooterStageInset = 20;
const double voiceFooterControlsWidth = 116;

/// The meter itself, so a test can measure it at any viewport.
const Key voiceFooterAnimationKey = ValueKey('voice-footer-animation');

/// Below this, a level is silence and the meter lies flat.
const double voiceLevelEpsilon = 0.012;

/// How many lobes share the stage. Five overlap enough to glow where they
/// cross without turning into a blur.
const int voiceLobeCount = 5;

/// The brand pink family the lobes are drawn in. Nothing here is borrowed
/// from anyone else's assistant: white and two blushes for the person,
/// three roses for the Bot, all one hue with [FrockTheme.accent].
const List<Color> voiceLobeTintsPerson = [
  Colors.white,
  Color(0xffffd6e3),
  FrockTheme.accentSoft,
  Colors.white,
  Color(0xffffe9f0),
];
const List<Color> voiceLobeTintsBot = [
  FrockTheme.accentDeep,
  Color(0xffc2295b),
  FrockTheme.accentSoft,
  Color(0xff7a0f38),
  FrockTheme.accentDeep,
];

/// Who the meter is showing right now.
enum VoiceSpeaker { nobody, person, bot }

/// One lobe: a soft bump on the support line with its own height, width and
/// place, that eases in and out over a short life and is then reborn
/// somewhere else while there is sound to show.
class VoiceLobe {
  final double amplitude;
  final double width;
  final double offset;
  final double born;
  final double life;
  final double seed;
  const VoiceLobe({
    required this.amplitude,
    required this.width,
    required this.offset,
    required this.born,
    required this.life,
    required this.seed,
  });

  /// A lobe that finished long ago, so the first frame with sound spawns
  /// a fresh one instead of showing a stale one.
  static VoiceLobe spent(int index) => VoiceLobe(
    amplitude: 0,
    width: 1,
    offset: 0,
    born: -1e9,
    life: 1,
    seed: index.toDouble(),
  );

  static VoiceLobe spawn(math.Random random, double now, int index) =>
      VoiceLobe(
        amplitude: 0.4 + random.nextDouble() * 0.6,
        width: 0.6 + random.nextDouble() * 1.2,
        offset: (random.nextDouble() - 0.5) * 2.4,
        born: now,
        life: 0.9 + random.nextDouble() * 0.9,
        seed: index.toDouble(),
      );

  /// 0 at birth, 1 at the end of its life.
  double progress(double now) => ((now - born) / life).clamp(0.0, 1.0);
  bool isOver(double now) => now - born >= life;
}

/// Turns raw levels into one that can be watched.
///
/// A microphone frame's RMS is noisy, and speech dips under the silence
/// threshold between syllables. Shown as it is, the meter steps thirty times
/// a second and blinks out in every gap. So the shown level chases the real
/// one: quickly up, so a word lands when it is spoken, and slowly down, so a
/// gap reads as a breath rather than a cut. Whose voice it is holds for a
/// moment past their last sound, so the colour does not flicker between the
/// two speakers on every pause.
class VoiceLevelFollower {
  /// Time constants of the chase, in seconds: the level closes about 63% of
  /// the gap to its target in one of these.
  static const double attack = 0.04;
  static const double release = 0.18;

  /// How long a speaker keeps the meter after their last sound.
  static const double hold = 0.25;

  double level = 0;
  VoiceSpeaker speaker = VoiceSpeaker.nobody;
  double _flow = 0;
  double _personUntil = -1;
  double _botUntil = -1;

  /// Advances the follower to [now] with the raw levels as they are now.
  /// [dt] is the time since the last step, in seconds.
  void step({
    required double now,
    required double dt,
    required double mic,
    required double playback,
  }) {
    // The Bot's level is filtered before anything else, because a spoken
    // reply is continuous and a per-frame RMS of it is not.
    _flow = _flow * 0.55 + _clean(playback) * 0.45;
    final person = _clean(mic);
    if (person > voiceLevelEpsilon) _personUntil = now + hold;
    if (_flow > voiceLevelEpsilon) _botUntil = now + hold;
    final double target;
    if (now < _personUntil) {
      speaker = VoiceSpeaker.person;
      target = person > voiceLevelEpsilon ? shape(person) : 0;
    } else if (now < _botUntil) {
      speaker = VoiceSpeaker.bot;
      target = _flow > voiceLevelEpsilon ? shape(_flow) : 0;
    } else {
      speaker = VoiceSpeaker.nobody;
      target = 0;
    }
    final tau = target > level ? attack : release;
    final k = dt <= 0 ? 1.0 : 1 - math.exp(-dt / tau);
    level += (target - level) * k;
    if (level < 0.001) level = 0;
  }

  static double _clean(double value) =>
      value.isFinite ? value.clamp(0.0, 1.0) : 0.0;

  /// A little compression: speech lives near the bottom of a linear scale
  /// and would otherwise barely move the meter.
  static double shape(double value) =>
      math.min(1.0, math.pow(value, 0.55).toDouble() * 1.4);
}

class VoiceFooter extends StatefulWidget {
  final AssistantSessionController session;

  /// Ends capture, playback and the session, and takes the footer away. It
  /// navigates nowhere: the app above the footer is where the person was.
  final VoidCallback onEnd;
  const VoiceFooter({super.key, required this.session, required this.onEnd});

  @override
  State<VoiceFooter> createState() => _VoiceFooterState();
}

class _VoiceFooterState extends State<VoiceFooter>
    with SingleTickerProviderStateMixin {
  late final Ticker _ticker;
  final math.Random _random = math.Random();

  /// What the painter reads. It is mutated in place by the ticker and the
  /// painter is told to repaint through [_frame]; nothing here calls
  /// `setState`, so a frame of the meter rebuilds no widget at all.
  final VoiceMeterModel _model = VoiceMeterModel();
  final _FrameNotifier _frame = _FrameNotifier();
  final VoiceLevelFollower _follower = VoiceLevelFollower();
  double _last = 0;

  /// The two things the chrome shows besides the meter. The session notifies
  /// on every level change during playback, thirty times a second; the
  /// footer rebuilds only when one of these actually moved.
  String? _shownError;
  bool _shownMuted = false;

  @override
  void initState() {
    super.initState();
    _shownError = widget.session.error;
    _shownMuted = widget.session.muted;
    widget.session.addListener(_sessionChanged);
    // The ticker runs only while a call does, and is disposed with the
    // footer. Nothing here animates when the footer is not on screen.
    _ticker = createTicker(_tick)..start();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // With motion turned off the meter is a still bar that only says how
    // loud: the level is information, the lobes are not.
    _model.still = MediaQuery.disableAnimationsOf(context);
  }

  void _sessionChanged() {
    final error = widget.session.error;
    final muted = widget.session.muted;
    if (error == _shownError && muted == _shownMuted) return;
    _shownError = error;
    _shownMuted = muted;
    if (mounted) setState(() {});
  }

  /// Every frame: the level chases the real one, a spent lobe is reborn
  /// while there is sound, and the painter is told to draw.
  void _tick(Duration elapsed) {
    final now = elapsed.inMicroseconds / 1e6;
    final dt = now - _last;
    _last = now;
    _model.now = now;
    final session = widget.session;
    _follower.step(
      now: now,
      dt: dt,
      mic: session.micLevel,
      playback: session.playbackLevel,
    );
    _model.level = _follower.level;
    _model.speaker = _follower.speaker;
    // A finished lobe is reborn only while there is sound: in silence the
    // last ones run out and nothing replaces them.
    final lobes = _model.lobes;
    for (var i = 0; i < lobes.length; i++) {
      if (lobes[i].isOver(now) && _model.level > 0.03) {
        lobes[i] = VoiceLobe.spawn(_random, now, i);
      }
    }
    _frame.tick();
  }

  @override
  void dispose() {
    _ticker.dispose();
    widget.session.removeListener(_sessionChanged);
    _frame.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final failure = widget.session.error;
    return identified(
      VoiceIds.footer,
      Material(
        color: theme.colorScheme.primary,
        // The body is a fixed 84 points; the padding below it is the
        // system's, and it is painted in the slab's colour.
        child: SafeArea(
          top: false,
          child: SizedBox(
            height: voiceFooterHeight,
            child: Stack(
              children: [
                Positioned.fill(
                  child: failure == null
                      ? _stage()
                      : Center(
                          child: Padding(
                            padding: const EdgeInsets.symmetric(
                              horizontal: voiceFooterControlsWidth,
                            ),
                            child: Text(
                              failure,
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                              textAlign: TextAlign.center,
                              style: theme.textTheme.bodySmall?.copyWith(
                                color: Colors.white,
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                          ),
                        ),
                ),
                Align(
                  alignment: Alignment.centerRight,
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      if (failure == null) ...[
                        _mute(),
                        const SizedBox(width: 10),
                      ],
                      identified(
                        VoiceIds.end,
                        Semantics(
                          label: 'End voice session',
                          button: true,
                          child: _circle(
                            onPressed: widget.onEnd,
                            icon: const Icon(Icons.close),
                          ),
                        ),
                      ),
                      const SizedBox(width: 16),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  /// The icon and the label say whether the microphone is on, which is the
  /// effective mute — a microphone lent to dictation is off, and saying
  /// otherwise would be a lie about the device. The press moves the person's
  /// own toggle, which is the only input this control owns: muting during a
  /// loan leaves the call muted when the loan ends.
  Widget _mute() {
    final muted = widget.session.muted;
    return identified(
      VoiceIds.mute,
      Semantics(
        label: muted ? 'Unmute microphone' : 'Mute microphone',
        toggled: muted,
        button: true,
        child: _circle(
          onPressed: () => widget.session.setMuted(!widget.session.userMuted),
          icon: Icon(muted ? Icons.mic_off : Icons.mic),
        ),
      ),
    );
  }

  /// A white glyph in a translucent white circle on the slab, 40 points,
  /// laid out at exactly that so the stage and the circles line up as
  /// designed.
  Widget _circle({required VoidCallback onPressed, required Widget icon}) =>
      IconButton(
        onPressed: onPressed,
        icon: icon,
        iconSize: 20,
        padding: EdgeInsets.zero,
        constraints: const BoxConstraints.tightFor(width: 40, height: 40),
        style: IconButton.styleFrom(
          foregroundColor: Colors.white,
          backgroundColor: Colors.white.withValues(alpha: 0.2),
          shape: const CircleBorder(),
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        ),
      );

  /// The stage: the meter's lane, beside the controls on a phone and
  /// centred at its maximum on a wide window.
  Widget _stage() => identified(
    VoiceIds.footerAnimation,
    ExcludeSemantics(
      child: LayoutBuilder(
        builder: (context, constraints) {
          final available =
              constraints.maxWidth -
              voiceFooterStageInset -
              voiceFooterControlsWidth;
          final width = math.min(
            voiceFooterStageMaxWidth,
            math.max(0.0, available),
          );
          if (width == 0) return const SizedBox.shrink();
          final left = width < available
              ? (constraints.maxWidth - width) / 2
              : voiceFooterStageInset;
          return Stack(
            children: [
              Positioned(
                left: left,
                top: 0,
                width: width,
                height: voiceFooterHeight,
                // The boundary keeps a frame of the meter from repainting
                // the whole shell beneath the footer.
                child: RepaintBoundary(
                  child: CustomPaint(
                    key: voiceFooterAnimationKey,
                    painter: VoiceLobesPainter(model: _model, repaint: _frame),
                    // It changes every frame; caching its raster is waste.
                    willChange: true,
                    size: Size.infinite,
                  ),
                ),
              ),
            ],
          );
        },
      ),
    ),
  );
}

/// A [ChangeNotifier] whose only job is to say "paint again".
class _FrameNotifier extends ChangeNotifier {
  void tick() => notifyListeners();
}

/// What the meter shows on a frame: the lobes, the level that scales them,
/// whose colour they wear and the clock they breathe to. The footer owns one
/// and mutates it in place; the painter reads it.
class VoiceMeterModel {
  final List<VoiceLobe> lobes = List.generate(voiceLobeCount, VoiceLobe.spent);
  double level = 0;
  VoiceSpeaker speaker = VoiceSpeaker.nobody;
  double now = 0;

  /// Motion is off for this person: draw a level, not a shape.
  bool still = false;
}

/// The bump `(2 / (2 + u⁴))³` tabulated over |u| in [0, [_bumpReach]) so a
/// point on a lobe costs a lookup and a multiply, not a `pow`. Past the
/// reach the bump is under 1e-5 of its peak and is drawn as flat.
const double _bumpReach = 4.0;
const int _bumpSteps = 512;
final List<double> _bumpTable = List.generate(_bumpSteps + 1, (i) {
  final u = i / _bumpSteps * _bumpReach;
  return math.pow(2 / (2 + u * u * u * u), 3).toDouble();
}, growable: false);

double _bump(double u) {
  final a = u.abs();
  if (a >= _bumpReach) return 0;
  final pos = a / _bumpReach * _bumpSteps;
  final i = pos.floor();
  final t = pos - i;
  return _bumpTable[i] * (1 - t) + _bumpTable[i + 1] * t;
}

/// Soft lobes on a support line, drawn additively.
///
/// Each lobe is a bump shaped like `(2 / (2 + u⁴))³` around its own centre,
/// eased in and out over its life and scaled by the level, with a slight
/// ripple so it breathes rather than pulses. It is drawn above and below
/// the line in one of the brand tints, and the whole set is composited with
/// [BlendMode.plus] inside one layer so crossings go brighter, the way light
/// does. At level zero nothing is drawn but the line.
///
/// It repaints when [repaint] says so and never because it was rebuilt:
/// the model is the same object frame to frame, so a rebuild of the footer
/// costs the meter nothing.
class VoiceLobesPainter extends CustomPainter {
  final VoiceMeterModel model;
  const VoiceLobesPainter({required this.model, super.repaint});

  /// Points along a lobe are this far apart on screen. The bump is smooth
  /// enough that four points to the millimetre read as a curve.
  static const double _pointSpacing = 4;

  @override
  void paint(Canvas canvas, Size size) {
    if (size.width <= 0 || size.height <= 0) return;
    final middle = size.height / 2;
    final level = model.level;
    final now = model.now;
    final speaking = level > 0;
    canvas.drawRRect(
      RRect.fromRectAndRadius(
        Rect.fromLTWH(0, middle - 1, size.width, 2),
        const Radius.circular(1),
      ),
      Paint()..color = Colors.white.withValues(alpha: speaking ? 0.9 : 0.55),
    );
    if (!speaking) return;
    final tints = model.speaker == VoiceSpeaker.bot
        ? voiceLobeTintsBot
        : voiceLobeTintsPerson;
    if (model.still) {
      _paintStill(canvas, size, middle, level, tints);
      return;
    }
    final lobes = model.lobes;
    final points = math.max(24, (size.width / _pointSpacing).ceil());
    // The layer is only as tall as the tallest lobe can reach, above and
    // below the line, so the additive pass is cheap on a phone.
    final reach = 34 * 1.12 + 1;
    final bounds = Rect.fromLTRB(0, middle - reach, size.width, middle + reach);
    canvas.saveLayer(bounds, Paint());
    for (var i = 0; i < lobes.length; i++) {
      final lobe = lobes[i];
      if (lobe.isOver(now)) continue;
      final envelope = math.sin(lobe.progress(now) * math.pi);
      final height = envelope * lobe.amplitude * level * 34;
      if (height < 0.5) continue;
      final paint = Paint()
        ..color = tints[i % tints.length].withValues(alpha: 0.55)
        ..blendMode = BlendMode.plus;
      canvas.drawVertices(
        _strip(lobe, size.width, middle, height, now, points),
        BlendMode.srcOver,
        paint,
      );
    }
    canvas.restore();
  }

  /// One lobe as a triangle strip: at each x a point above the line and its
  /// mirror below, so the strip fills the whole band the lobe covers. The
  /// renderer draws a strip as it is, where a filled path must first be
  /// tessellated on every frame.
  static Vertices _strip(
    VoiceLobe lobe,
    double width,
    double middle,
    double height,
    double now,
    int points,
  ) {
    final positions = Float32List((points + 1) * 4);
    final phase = now * 6 + lobe.seed;
    var at = 0;
    for (var p = 0; p <= points; p++) {
      final x = p / points * 6 - 3;
      final px = p / points * width;
      final bump = _bump((x - lobe.offset) / lobe.width);
      final h = bump < 1e-3
          ? 0.0
          : height * bump * (1 + 0.12 * math.sin(x * 5 + phase));
      positions[at++] = px;
      positions[at++] = middle - h;
      positions[at++] = px;
      positions[at++] = middle + h;
    }
    return Vertices.raw(VertexMode.triangleStrip, positions);
  }

  /// Reduced motion: a bar from the centre, as wide as the level, in the
  /// speaker's first tint. It moves only as the level does.
  static void _paintStill(
    Canvas canvas,
    Size size,
    double middle,
    double level,
    List<Color> tints,
  ) {
    final half = size.width / 2 * level;
    canvas.drawRRect(
      RRect.fromRectAndRadius(
        Rect.fromLTWH(size.width / 2 - half, middle - 3, half * 2, 6),
        const Radius.circular(3),
      ),
      Paint()..color = tints.first.withValues(alpha: 0.9),
    );
  }

  @override
  bool shouldRepaint(VoiceLobesPainter old) => !identical(old.model, model);
}

/// Bars whose heights are a short rolling history of the real level.
///
/// A row whose whole history is under the epsilon is silence, and silence
/// draws as one faint line: fourteen one-pixel stubs read as noise.
class VoiceBarsPainter extends CustomPainter {
  final List<double> history;
  final Color colour;
  const VoiceBarsPainter({required this.history, required this.colour});

  @override
  void paint(Canvas canvas, Size size) {
    if (size.width <= 0 || size.height <= 0) return;
    final middle = size.height / 2;
    final loudest = history.isEmpty
        ? 0.0
        : history.reduce((a, b) => a > b ? a : b);
    if (loudest < voiceLevelEpsilon) {
      canvas.drawRect(
        Rect.fromLTWH(0, middle - 0.5, size.width, 1),
        Paint()..color = colour.withValues(alpha: 0.35),
      );
      return;
    }
    final count = history.length;
    final barWidth = math.min(2.0, size.width / (count * 1.6));
    final step = count <= 1 ? 0.0 : (size.width - barWidth) / (count - 1);
    final paint = Paint()..color = colour;
    for (var i = 0; i < count; i++) {
      final value = history[i].clamp(0.0, 1.0);
      // A little compression: speech lives near the bottom of a linear scale
      // and would otherwise barely move the bar.
      final scaled = math.pow(value, 0.55).toDouble() * 1.6;
      final height = math.max(1.0, math.min(1.0, scaled) * size.height);
      canvas.drawRRect(
        RRect.fromRectAndRadius(
          Rect.fromLTWH(i * step, middle - height / 2, barWidth, height),
          const Radius.circular(1),
        ),
        paint,
      );
    }
  }

  @override
  bool shouldRepaint(VoiceBarsPainter old) =>
      old.colour != colour || !_same(old.history, history);

  static bool _same(List<double> a, List<double> b) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i] != b[i]) return false;
    }
    return true;
  }
}

/// The composer's own small animation while dictating: one row, in the
/// primary pink, driven by the capture level.
class VoiceDictationBars extends StatefulWidget {
  /// The capture level. A listenable rather than a value so that a frame of
  /// audio rebuilds these bars and nothing above them.
  final ValueListenable<double> level;
  const VoiceDictationBars({super.key, required this.level});

  @override
  State<VoiceDictationBars> createState() => _VoiceDictationBarsState();
}

class _VoiceDictationBarsState extends State<VoiceDictationBars> {
  static const _bars = 14;
  final ListQueue<double> _history = ListQueue<double>();

  @override
  void initState() {
    super.initState();
    for (var i = 0; i < _bars; i++) {
      _history.addLast(0);
    }
    widget.level.addListener(_sample);
  }

  /// No ticker: the level arrives with the audio, so the bars move exactly as
  /// often as there is something new to say, and stand still when there is
  /// not.
  void _sample() {
    final value = widget.level.value;
    _history.addLast(value.isFinite ? value.clamp(0.0, 1.0) : 0);
    while (_history.length > _bars) {
      _history.removeFirst();
    }
    if (mounted) setState(() {});
  }

  @override
  void didUpdateWidget(VoiceDictationBars old) {
    super.didUpdateWidget(old);
    if (old.level != widget.level) {
      old.level.removeListener(_sample);
      widget.level.addListener(_sample);
    }
  }

  @override
  void dispose() {
    widget.level.removeListener(_sample);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => identified(
    VoiceIds.composerDictationLevel,
    ExcludeSemantics(
      child: SizedBox(
        width: 56,
        height: 16,
        child: CustomPaint(
          painter: VoiceBarsPainter(
            history: _history.toList(growable: false),
            colour: Theme.of(context).colorScheme.primary,
          ),
        ),
      ),
    ),
  );
}
