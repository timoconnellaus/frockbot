/// The animated character shared by every surface that represents a Bot.
library;

import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:rive/rive.dart' as rive;

// flutter_tester cannot host Rive Native's renderer. Keep widget tests on the
// checked-in still while release/debug apps exercise the real artboard.
bool get _isFlutterTest => WidgetsBinding.instance.runtimeType
    .toString()
    .contains('TestWidgetsFlutterBinding');

enum CharacterActivity {
  idle,
  thinking,
  working,
  needsAttention,
  success,
  still,
}

enum CharacterEmotion {
  neutral,
  excited,
  sad,
  tired,
  curious,
  content,
  surprised,
  uncertain,
}

enum CharacterMotion { active, quiet, still }

@immutable
class CharacterDefinition {
  final String id;
  final String label;
  final Color primary;
  final Color shade;
  final Color eyes;
  const CharacterDefinition(
    this.id,
    this.label,
    this.primary,
    this.shade,
    this.eyes,
  );
}

const characterCatalogV1 = <String, CharacterDefinition>{
  'pixel': CharacterDefinition(
    'pixel',
    'Pixel',
    Color(0xfffc85ae),
    Color(0xffa95d75),
    Color(0xfffcf6e3),
  ),
  'guardian': CharacterDefinition(
    'guardian',
    'Guardian',
    Color(0xff3c3543),
    Color(0xff211d26),
    Color(0xffffeee0),
  ),
  'sunny': CharacterDefinition(
    'sunny',
    'Sunny',
    Color(0xffffc928),
    Color(0xffd99a00),
    Color(0xfffff6df),
  ),
  'chill': CharacterDefinition(
    'chill',
    'Chill',
    Color(0xff59c7ff),
    Color(0xff258dc5),
    Color(0xfff4fbff),
  ),
  'nudge': CharacterDefinition(
    'nudge',
    'Nudge',
    Color(0xffff8b27),
    Color(0xffc95b12),
    Color(0xfffff4e9),
  ),
  'fox': CharacterDefinition(
    'fox',
    'Fox',
    Color(0xffef6b4a),
    Color(0xffae402b),
    Color(0xfffff0dc),
  ),
  'dog': CharacterDefinition(
    'dog',
    'Dog',
    Color(0xffdca258),
    Color(0xffb67c39),
    Color(0xfffff1d3),
  ),
  'goat': CharacterDefinition(
    'goat',
    'Goat',
    Color(0xffd8c8ab),
    Color(0xff9d8968),
    Color(0xfffff8e8),
  ),
  'cow': CharacterDefinition(
    'cow',
    'Cow',
    Color(0xfff4eee4),
    Color(0xffb9a99a),
    Color(0xfffff8e8),
  ),
  'cat': CharacterDefinition(
    'cat',
    'Cat',
    Color(0xff8b72d9),
    Color(0xff5942a0),
    Color(0xfffff2dc),
  ),
  'rabbit': CharacterDefinition(
    'rabbit',
    'Rabbit',
    Color(0xffd7b9f1),
    Color(0xff9d78be),
    Color(0xfffff7e8),
  ),
};

const defaultCharacterIdV1 = 'pixel';

Map<String, Object?> defaultAvatarAppearanceV1([
  String? characterId,
  Color? primary,
]) {
  final character =
      characterCatalogV1[characterId] ??
      characterCatalogV1[defaultCharacterIdV1]!;
  final colour = primary ?? character.primary;
  return {
    'schemaVersion': 1,
    'characterId': character.id,
    'primary':
        '#${colour.toARGB32().toRadixString(16).padLeft(8, '0').substring(2)}',
  };
}

Color characterColourV1(String? value, String characterId) {
  final fallback =
      characterCatalogV1[characterId]?.primary ??
      characterCatalogV1[defaultCharacterIdV1]!.primary;
  if (value == null || !RegExp(r'^#[0-9a-fA-F]{6}$').hasMatch(value)) {
    return fallback;
  }
  return Color(int.parse(value.substring(1), radix: 16) | 0xff000000);
}

class CharacterHoverScope extends InheritedWidget {
  final bool hovered;
  const CharacterHoverScope({
    super.key,
    required this.hovered,
    required super.child,
  });

  static bool of(BuildContext context) =>
      context
          .dependOnInheritedWidgetOfExactType<CharacterHoverScope>()
          ?.hovered ??
      false;

  @override
  bool updateShouldNotify(CharacterHoverScope oldWidget) =>
      hovered != oldWidget.hovered;
}

/// A Bot's character. The Rive artboard is transparent; its parent owns the backdrop.
class CharacterAvatar extends StatefulWidget {
  final double size;
  final String? characterId;
  final String? background;
  final String? primary;
  final CharacterActivity activity;
  final CharacterEmotion emotion;
  final CharacterMotion motion;
  final bool enableGaze;
  final bool workingRing;
  final bool working;
  final Duration tempo;
  final String? semanticsLabel;

  const CharacterAvatar({
    super.key,
    this.size = 40,
    this.characterId,
    this.background,
    this.primary,
    this.activity = CharacterActivity.idle,
    this.emotion = CharacterEmotion.neutral,
    this.motion = CharacterMotion.active,
    this.enableGaze = false,
    this.workingRing = false,
    this.working = false,
    this.tempo = thinkingBadgeDefaultTempo,
    this.semanticsLabel,
  });

  @override
  State<CharacterAvatar> createState() => _CharacterAvatarState();
}

class _CharacterAvatarState extends State<CharacterAvatar> {
  static final _loaders = <String, rive.FileLoader>{};
  final _random = math.Random();
  rive.RiveLoaded? _loaded;
  Timer? _quietTimer;
  Timer? _settleTimer;
  bool _localHovered = false;
  bool _twitching = false;

  String get _characterId =>
      characterCatalogV1.containsKey(widget.characterId ?? widget.background)
      ? (widget.characterId ?? widget.background)!
      : defaultCharacterIdV1;

  rive.FileLoader get _loader => _loaders.putIfAbsent(
    _characterId,
    () => rive.FileLoader.fromAsset(
      'assets/characters/$_characterId.riv',
      riveFactory: rive.Factory.rive,
    ),
  );

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _scheduleQuietTwitch());
  }

  @override
  void didUpdateWidget(CharacterAvatar oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.characterId != widget.characterId) _loaded = null;
    _scheduleQuietTwitch();
    _sync();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _scheduleQuietTwitch();
    _sync();
  }

  void _scheduleQuietTwitch() {
    _quietTimer?.cancel();
    if (!mounted ||
        widget.motion != CharacterMotion.quiet ||
        !TickerMode.valuesOf(context).enabled ||
        MediaQuery.disableAnimationsOf(context)) {
      return;
    }
    _quietTimer = Timer(
      Duration(milliseconds: 7000 + _random.nextInt(11000)),
      () {
        if (!mounted) return;
        setState(() => _twitching = true);
        _sync();
        _settleTimer?.cancel();
        _settleTimer = Timer(const Duration(milliseconds: 850), () {
          if (!mounted) return;
          setState(() => _twitching = false);
          _sync();
          _scheduleQuietTwitch();
        });
      },
    );
  }

  void _sync() {
    final loaded = _loaded;
    if (loaded == null) return;
    final inheritedHover = CharacterHoverScope.of(context);
    final reduce =
        MediaQuery.disableAnimationsOf(context) ||
        widget.motion == CharacterMotion.still ||
        (widget.motion == CharacterMotion.quiet &&
            !_twitching &&
            !_localHovered &&
            !inheritedHover);
    loaded.controller.active = TickerMode.valuesOf(context).enabled;
    final model = loaded.viewModelInstance;
    if (model == null) return;
    final definition = characterCatalogV1[_characterId]!;
    final primary = characterColourV1(widget.primary, _characterId);
    final hsl = HSLColor.fromColor(primary);
    final shade = hsl
        .withLightness((hsl.lightness * 0.72).clamp(0.12, 0.65))
        .toColor();
    model.number('activity')?.value = widget.activity.index.toDouble();
    model.number('emotion')?.value = widget.emotion.index.toDouble();
    model.boolean('hovered')?.value =
        _localHovered || inheritedHover || _twitching;
    model.boolean('reducedMotion')?.value = reduce;
    model.color('primary')?.value = primary;
    model.color('shade')?.value = shade;
    model.color('eyeColor')?.value = definition.eyes;
  }

  void _look(PointerHoverEvent event) {
    if (!widget.enableGaze ||
        defaultTargetPlatform == TargetPlatform.android ||
        defaultTargetPlatform == TargetPlatform.iOS) {
      return;
    }
    final model = _loaded?.viewModelInstance;
    if (model == null) return;
    model.number('lookX')?.value =
        ((event.localPosition.dx / widget.size) * 2 - 1).clamp(-1.0, 1.0);
    model.number('lookY')?.value =
        ((event.localPosition.dy / widget.size) * 2 - 1).clamp(-1.0, 1.0);
  }

  @override
  Widget build(BuildContext context) {
    final avatar = SizedBox.square(
      dimension: widget.size,
      child: _isFlutterTest
          ? Image.asset(
              'assets/characters/$_characterId.png',
              fit: BoxFit.contain,
              excludeFromSemantics: true,
            )
          : rive.RiveWidgetBuilder(
              key: ValueKey(_characterId),
              fileLoader: _loader,
              dataBind: rive.DataBind.auto(),
              onLoaded: (loaded) {
                _loaded = loaded;
                _sync();
              },
              builder: (context, state) => switch (state) {
                rive.RiveLoaded() => rive.RiveWidget(
                  controller: state.controller,
                  fit: rive.Fit.contain,
                  hitTestBehavior: rive.RiveHitTestBehavior.none,
                ),
                rive.RiveLoading() => const SizedBox.shrink(),
                rive.RiveFailed() => Image.asset(
                  'assets/characters/$_characterId.png',
                  fit: BoxFit.contain,
                  excludeFromSemantics: true,
                ),
              },
            ),
    );
    final interactive = MouseRegion(
      onEnter: (_) {
        setState(() => _localHovered = true);
        _sync();
      },
      onExit: (_) {
        setState(() => _localHovered = false);
        _loaded?.viewModelInstance?.number('lookX')?.value = 0;
        _loaded?.viewModelInstance?.number('lookY')?.value = 0;
        _sync();
      },
      onHover: _look,
      child: avatar,
    );
    Widget result = widget.workingRing
        ? Container(
            padding: const EdgeInsets.all(2),
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              border: Border.all(
                color: Theme.of(context).colorScheme.primary,
                width: 2,
              ),
            ),
            child: interactive,
          )
        : interactive;
    if (widget.working) {
      final badge = ThinkingBadge(
        height: (widget.size * 0.38).clamp(10.0, 14.0),
        tempo: widget.tempo,
      );
      result = Stack(
        clipBehavior: Clip.none,
        children: [
          result,
          Positioned(
            right: -badge.height * 0.55,
            bottom: -badge.height * 0.55,
            child: badge,
          ),
        ],
      );
    }
    return Semantics(
      image: true,
      label: widget.semanticsLabel,
      excludeSemantics: widget.semanticsLabel == null,
      child: result,
    );
  }

  @override
  void dispose() {
    _quietTimer?.cancel();
    _settleTimer?.cancel();
    super.dispose();
  }
}

const Duration thinkingBadgeDefaultTempo = Duration(milliseconds: 1200);

/// Three dots on a working Bot. The thread adjusts the beat to its live pace;
/// compact avatar surfaces use the steady default.
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
    return Container(
      height: height + 3,
      padding: const EdgeInsets.all(1.5),
      decoration: BoxDecoration(
        color: Theme.of(context).scaffoldBackgroundColor,
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

  static double _rise(double t, int index) {
    final local = t * 4 - index;
    if (local < 0 || local > 1) return 0;
    return math.sin(local * math.pi);
  }
}
