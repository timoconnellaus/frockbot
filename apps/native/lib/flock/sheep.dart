/// What a Bot looks like: the Flock's sheep, drawn by the host.
///
/// The avatar is a stack of layers over `app/flock/assets/` — a
/// background, the canonical sheep, and the wearables a recipe names. Wearables
/// are deferred (`docs/plan.md`, "a single default avatar for now"), so the two
/// layers that survive are the ones this draws, and the seven WebPs beside them
/// are the only art the app bundles.
///
/// The recipe's other three bands still travel on the wire and are still what
/// the server validates; nothing here writes them, and `defaultSheepRecipeV1`
/// pins them to the catalogue's own neutral roots so a Bot this app creates is
/// a Bot a full wardrobe can still dress later.
library;

import 'dart:math' as math;

import 'package:flutter/material.dart';

/// The backgrounds the create sheet offers, in its order. Ids are the recipe
/// values; the labels are the catalogue's own.
const sheepBackgroundsV1 = <String, String>{
  'hot-pink': 'Hot pink',
  'electric-blue': 'Electric blue',
  'lime-green': 'Lime green',
  'canary-yellow': 'Canary yellow',
  'bright-orange': 'Bright orange',
  'vivid-purple': 'Vivid purple',
};

/// What a Bot wears when nothing has chosen for it.
const defaultSheepBackgroundV1 = 'electric-blue';

/// The catalogue's neutral roots. They name no asset — `sheepLayerIds` skips a
/// node whose parent is null — so a recipe holding them is the bare sheep.
const _neutral = <String, String>{
  'upper': 'upper-neutral',
  'middle': 'middle-neutral',
  'lower': 'lower-neutral',
};

/// A recipe over one background, with every wearable band at its root.
Map<String, Object?> defaultSheepRecipeV1([String? background]) => {
  'schemaVersion': 1,
  'background': sheepBackgroundsV1.containsKey(background)
      ? background!
      : defaultSheepBackgroundV1,
  ..._neutral,
};

/// The Bot's sheep.
class SheepAvatar extends StatelessWidget {
  final double size;

  /// The recipe's background id. An id this build does not carry — a wearable
  /// catalogue that grew after the app shipped — falls back to the default
  /// rather than drawing a hole where a Bot's face should be.
  final String? background;

  /// A working Bot wears the typing badge on its corner. It is the only thing
  /// an avatar ever says about a Turn: what the Turn is doing belongs on the
  /// Work view.
  final bool working;

  /// One bounce of the badge's dots. The thread's working row sets it from the
  /// Turn's pace; everywhere else the badge keeps the default beat.
  final Duration tempo;
  const SheepAvatar({
    super.key,
    this.size = 40,
    this.background,
    this.working = false,
    this.tempo = thinkingBadgeDefaultTempo,
  });

  String get _background => sheepBackgroundsV1.containsKey(background)
      ? background!
      : defaultSheepBackgroundV1;

  @override
  Widget build(BuildContext context) {
    final avatar = ClipRRect(
      borderRadius: BorderRadius.circular(size * 0.27),
      child: SizedBox(
        width: size,
        height: size,
        child: Stack(
          fit: StackFit.expand,
          children: [
            Image.asset(
              'assets/sheep/background-$_background.webp',
              fit: BoxFit.cover,
              excludeFromSemantics: true,
            ),
            Image.asset(
              'assets/sheep/canonical.webp',
              fit: BoxFit.cover,
              excludeFromSemantics: true,
            ),
          ],
        ),
      ),
    );
    if (!working) return avatar;
    final badge = ThinkingBadge(
      height: (size * 0.38).clamp(10.0, 14.0),
      tempo: tempo,
    );
    return Stack(
      clipBehavior: Clip.none,
      children: [
        avatar,
        Positioned(
          right: -badge.height * 0.55,
          bottom: -badge.height * 0.55,
          child: badge,
        ),
      ],
    );
  }
}

/// The default beat of the typing badge.
const Duration thinkingBadgeDefaultTempo = Duration(milliseconds: 1200);

/// The typing badge: three dots in a pill, each rising in turn. The pill is
/// cut out of the avatar by a ring of the page's own colour, so it reads as
/// sitting on the corner rather than painted over it.
class ThinkingBadge extends StatefulWidget {
  final double height;
  final Duration tempo;
  const ThinkingBadge({
    super.key,
    required this.height,
    this.tempo = thinkingBadgeDefaultTempo,
  });

  @override
  State<ThinkingBadge> createState() => _ThinkingBadgeState();
}

class _ThinkingBadgeState extends State<ThinkingBadge>
    with SingleTickerProviderStateMixin {
  late final AnimationController _beat = AnimationController(
    vsync: this,
    duration: widget.tempo,
  );

  /// A person who asked for less motion gets three still dots: the controller
  /// never starts rather than animating something they cannot see.
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final still = MediaQuery.disableAnimationsOf(context);
    if (still && _beat.isAnimating) {
      _beat.stop();
    } else if (!still && !_beat.isAnimating) {
      _beat.repeat();
    }
  }

  @override
  void didUpdateWidget(ThinkingBadge oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.tempo != widget.tempo) {
      // Keep the phase so a tempo change does not make the dots jump.
      _beat.duration = widget.tempo;
      if (_beat.isAnimating) _beat.repeat(period: widget.tempo);
    }
  }

  @override
  void dispose() {
    _beat.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final height = widget.height;
    final dot = height * 0.24;
    final lift = height * 0.16;
    final cutout = Theme.of(context).scaffoldBackgroundColor;
    return Container(
      height: height + 3,
      padding: const EdgeInsets.all(1.5),
      decoration: BoxDecoration(
        color: cutout,
        borderRadius: BorderRadius.circular(height / 2 + 1.5),
      ),
      child: Container(
        height: height,
        padding: EdgeInsets.symmetric(horizontal: height * 0.32),
        decoration: BoxDecoration(
          color: scheme.primary,
          borderRadius: BorderRadius.circular(height / 2),
        ),
        child: AnimatedBuilder(
          animation: _beat,
          builder: (context, _) => Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              for (var index = 0; index < 3; index++) ...[
                if (index > 0) SizedBox(width: dot * 0.7),
                Transform.translate(
                  offset: Offset(0, -lift * _rise(_beat.value, index)),
                  child: Container(
                    width: dot,
                    height: dot,
                    decoration: BoxDecoration(
                      color: scheme.onPrimary,
                      shape: BoxShape.circle,
                    ),
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  /// How far dot [index] has risen at [t] in the beat: each dot owns a quarter
  /// of the cycle and the last quarter is rest, so the wave reads left to
  /// right with a breath between.
  static double _rise(double t, int index) {
    final local = t * 4 - index;
    if (local < 0 || local > 1) return 0;
    return math.sin(local * math.pi);
  }
}
