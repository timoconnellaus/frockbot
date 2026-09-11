/// The voice footer: an animation, a mute toggle, and a way out.
///
/// It is trust chrome, not a feature slot. The shell draws it below the whole
/// three-tier layout so it survives a Bot switch, a page and a drawer, and
/// the app above it stays usable while a call is live.
///
/// There is no text, header, transcript, label or status here on purpose. The
/// footer says one thing — the microphone is on, and this is what it hears —
/// and the animation is the only honest way to say it. The bars are driven by
/// the real amplitude and by nothing else: when the room is silent they are
/// flat, because a line that moves while nobody speaks is a lie about what
/// the microphone is doing.
library;

import 'dart:collection';
import 'dart:math' as math;

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
const double voiceFooterHeight = 52;

/// The animation's width, on every viewport. It is never compacted: a
/// narrower phone gets the same 140 points, centred.
const double voiceFooterAnimationWidth = 140;

/// The animation itself, so a test can measure it at any viewport.
const Key voiceFooterAnimationKey = ValueKey('voice-footer-animation');

/// How many bars one row holds.
const int voiceBarCount = 24;

/// Below this, a row is silence and draws as a line rather than as bars.
const double voiceLevelEpsilon = 0.012;

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
  static const _sample = Duration(milliseconds: 33);

  late final Ticker _ticker;
  final ListQueue<double> _mic = ListQueue<double>();
  final ListQueue<double> _playback = ListQueue<double>();
  Duration _last = Duration.zero;
  double _flow = 0;

  @override
  void initState() {
    super.initState();
    for (var i = 0; i < voiceBarCount; i++) {
      _mic.addLast(0);
      _playback.addLast(0);
    }
    widget.session.addListener(_repaint);
    // The ticker runs only while a call does, and is disposed with the
    // footer. Nothing here animates when the footer is not on screen.
    _ticker = createTicker(_tick)..start();
  }

  void _repaint() {
    if (mounted) setState(() {});
  }

  void _tick(Duration elapsed) {
    if (elapsed - _last < _sample) return;
    _last = elapsed;
    final session = widget.session;
    // The user row reacts: it shows the level as it is. The AI row flows,
    // because a spoken reply is continuous and a per-frame RMS of it is not.
    _flow = _flow * 0.55 + session.playbackLevel * 0.45;
    _push(_mic, session.micLevel);
    _push(_playback, _flow);
    if (mounted) setState(() {});
  }

  void _push(ListQueue<double> history, double value) {
    history.addLast(value.isFinite ? value.clamp(0.0, 1.0) : 0.0);
    while (history.length > voiceBarCount) {
      history.removeFirst();
    }
  }

  @override
  void dispose() {
    _ticker.dispose();
    widget.session.removeListener(_repaint);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final failure = widget.session.error;
    return identified(
      VoiceIds.footer,
      Material(
        color: theme.colorScheme.surface,
        child: DecoratedBox(
          decoration: BoxDecoration(
            border: Border(
              top: BorderSide(color: theme.colorScheme.outlineVariant),
            ),
          ),
          // The body is a fixed 52 points; the padding below it is the
          // system's, and it is painted in the footer's colour.
          child: SafeArea(
            top: false,
            child: SizedBox(
              height: voiceFooterHeight,
              child: Stack(
                children: [
                  Positioned.fill(
                    child: Center(
                      child: failure == null
                          ? _animation(theme)
                          : Padding(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 96,
                              ),
                              child: Text(
                                failure,
                                maxLines: 2,
                                overflow: TextOverflow.ellipsis,
                                textAlign: TextAlign.center,
                                style: theme.textTheme.bodySmall?.copyWith(
                                  color: theme.colorScheme.error,
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
                        if (failure == null) _mute(theme),
                        identified(
                          VoiceIds.end,
                          Semantics(
                            label: 'End voice session',
                            button: true,
                            child: IconButton(
                              iconSize: 20,
                              visualDensity: VisualDensity.compact,
                              onPressed: widget.onEnd,
                              icon: const Icon(Icons.close),
                            ),
                          ),
                        ),
                        const SizedBox(width: 4),
                      ],
                    ),
                  ),
                ],
              ),
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
  Widget _mute(ThemeData theme) {
    final muted = widget.session.muted;
    return identified(
      VoiceIds.mute,
      Semantics(
        label: muted ? 'Unmute microphone' : 'Mute microphone',
        toggled: muted,
        button: true,
        child: IconButton(
          iconSize: 20,
          visualDensity: VisualDensity.compact,
          onPressed: () => widget.session.setMuted(!widget.session.userMuted),
          icon: Icon(muted ? Icons.mic_off : Icons.mic),
        ),
      ),
    );
  }

  Widget _animation(ThemeData theme) => identified(
    VoiceIds.footerAnimation,
    ExcludeSemantics(
      child: SizedBox(
        key: voiceFooterAnimationKey,
        width: voiceFooterAnimationWidth,
        height: 40,
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            _row(Icons.mic, _mic, theme.colorScheme.primary),
            const SizedBox(height: 4),
            _row(Icons.volume_up, _playback, FrockTheme.accentSoft),
          ],
        ),
      ),
    ),
  );

  Widget _row(IconData icon, ListQueue<double> history, Color colour) =>
      SizedBox(
        height: 16,
        child: Row(
          children: [
            Icon(icon, size: 11, color: colour.withValues(alpha: 0.8)),
            const SizedBox(width: 5),
            Expanded(
              child: CustomPaint(
                painter: VoiceBarsPainter(
                  history: history.toList(growable: false),
                  colour: colour,
                ),
                size: Size.infinite,
              ),
            ),
          ],
        ),
      );
}

/// Bars whose heights are a short rolling history of the real level.
///
/// A row whose whole history is under the epsilon is silence, and silence
/// draws as one faint line: twenty-four one-pixel stubs read as noise.
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
