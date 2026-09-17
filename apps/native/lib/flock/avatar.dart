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

/// Whether `RiveNative.init()` has settled successfully.
///
/// `main()` starts the runtime without waiting for it and sets this when it
/// lands; every avatar draws its still until then and rebuilds on the flip.
/// Without the runtime a renderer factory cannot be asked for — on the web it
/// reads a field the loader never initialised and throws from `build` — so a
/// runtime that never arrives leaves the stills in place.
final ValueNotifier<bool> riveRuntimeReady = ValueNotifier<bool>(false);

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

  /// Where the eyes look, as a point in the artboard's own frame: `-1` to `1`
  /// on each axis, or nothing when there is nowhere to look. The surface
  /// that owns the pointer feeds this — the conversation pane, for the
  /// companion beside the composer — so the eyes follow a pointer anywhere
  /// over that surface rather than only over the character's own square.
  /// Written straight into the artboard on each change; nothing rebuilds.
  final ValueListenable<Offset?>? gaze;

  /// While true, the eyes may turn but the artboard is not woken to draw
  /// them, and a moment's wake already running is cut short. The surface
  /// raises it on a pointer down: the engine attaches a text field's editing
  /// element in the frames after a tap, and an artboard drawing beside the
  /// field in those frames cost the first keystroke typed into it.
  final ValueListenable<bool>? hold;
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
    this.gaze,
    this.hold,
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
  Timer? _restTimer;

  /// The last state the ticker was woken for; see `_sync`.
  String? _synced;

  /// Whether `_sync` last left the ticker running for good, as opposed to a
  /// moment's wake that `_restTimer` ends.
  bool _running = false;
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
      riveFactory: rive.Factory.flutter,
    ),
  );

  @override
  void initState() {
    super.initState();
    riveRuntimeReady.addListener(_runtimeChanged);
    widget.gaze?.addListener(_gazeChanged);
    widget.hold?.addListener(_holdChanged);
    WidgetsBinding.instance.addPostFrameCallback((_) => _scheduleQuietTwitch());
  }

  bool get _held => widget.hold?.value ?? false;

  /// A hold that begins stops a moment's wake at once; one that ends draws
  /// whatever the eyes were told meanwhile.
  void _holdChanged() {
    _sync();
    if (!_held && widget.gaze?.value != null) _wake();
  }

  /// The surface's pointer moved: the eyes turn, and a resting artboard is
  /// woken long enough to draw the turn before it rests again.
  void _gazeChanged() {
    final model = _loaded?.viewModelInstance;
    if (model == null) return;
    final at = widget.gaze?.value;
    model.number('lookX')?.value = (at?.dx ?? 0).clamp(-1.0, 1.0);
    model.number('lookY')?.value = (at?.dy ?? 0).clamp(-1.0, 1.0);
    _wake();
  }

  /// Runs the ticker for a moment. A resting artboard advances only on a
  /// change; the eyes are a change the state machine does not announce.
  void _wake() {
    final loaded = _loaded;
    if (loaded == null || _running || _held) return;
    if (MediaQuery.disableAnimationsOf(context) ||
        !TickerMode.valuesOf(context).enabled) {
      return;
    }
    _restTimer?.cancel();
    loaded.controller.active = true;
    _restTimer = Timer(const Duration(milliseconds: 700), () {
      if (!mounted || _running) return;
      _loaded?.controller.active = false;
    });
  }

  /// The runtime landed (or gave up) after this avatar first drew its still.
  void _runtimeChanged() {
    if (mounted) setState(() {});
  }

  @override
  void didUpdateWidget(CharacterAvatar oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.gaze, widget.gaze)) {
      oldWidget.gaze?.removeListener(_gazeChanged);
      widget.gaze?.addListener(_gazeChanged);
    }
    if (!identical(oldWidget.hold, widget.hold)) {
      oldWidget.hold?.removeListener(_holdChanged);
      widget.hold?.addListener(_holdChanged);
    }
    if (oldWidget.characterId != widget.characterId) {
      _loaded = null;
      _synced = null;
    }
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
    // A resting artboard is not advanced. The state machine's reduced-motion
    // pose is a still, but the widget's ticker would go on asking it for a
    // frame sixty times a second — for every Bot in the sidebar at once —
    // which is where a chat tab's whole CPU core went. The ticker runs for a
    // moment after each change so data binding and the transition back to
    // rest are drawn, then stops until the next hover or twitch wakes it.
    final definition = characterCatalogV1[_characterId]!;
    final primary = characterColourV1(widget.primary, _characterId);
    final run = TickerMode.valuesOf(context).enabled && !reduce;
    // Only a change wakes a resting artboard. `_sync` runs on every rebuild
    // of the surface around it — the composer rebuilds on each keystroke —
    // and a wake per rebuild kept the companion animating for as long as
    // anyone typed.
    final signature =
        '$run:$_held:${widget.activity}:${widget.emotion}:$primary:'
        '${_localHovered || inheritedHover || _twitching}';
    if (signature != _synced) {
      _synced = signature;
      _running = run;
      _restTimer?.cancel();
      if (_held) {
        loaded.controller.active = false;
      } else if (run) {
        loaded.controller.active = true;
      } else {
        loaded.controller.active = TickerMode.valuesOf(context).enabled;
        _restTimer = Timer(const Duration(milliseconds: 700), () {
          if (!mounted) return;
          _loaded?.controller.active = false;
        });
      }
    }
    final model = loaded.viewModelInstance;
    if (model == null) return;
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
    // A surface that feeds the gaze owns it; the square's own hover would
    // only fight it for the last word.
    if (widget.gaze != null) return;
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
      // `still` is the checked-in picture, not a paused artboard: a live
      // artboard beside the composer — even one holding its rest pose — cost
      // keystrokes typed right after a tap on the field, and the picture is
      // what the design shows at rest anyway.
      child:
          _isFlutterTest ||
              !riveRuntimeReady.value ||
              widget.motion == CharacterMotion.still
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
                _synced = null;
                _sync();
                if (widget.gaze != null) _gazeChanged();
              },
              builder: (context, state) => switch (state) {
                // Decoration only: the artboard takes no pointer and holds no
                // focus. Hover and gaze belong to the MouseRegion around it.
                rive.RiveLoaded() => ExcludeFocus(
                  child: IgnorePointer(
                    child: rive.RiveWidget(
                      controller: state.controller,
                      fit: rive.Fit.contain,
                      hitTestBehavior: rive.RiveHitTestBehavior.none,
                    ),
                  ),
                ),
                // A runtime that never arrives — a script the CSP refuses, a
                // request that hangs — leaves the loader in `RiveLoading`
                // forever rather than failing, so the still stands in for
                // waiting as well as for failure. An empty slot is never the
                // better answer: the still is what the animation replaces.
                _ => Image.asset(
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
        if (widget.gaze == null) {
          _loaded?.viewModelInstance?.number('lookX')?.value = 0;
          _loaded?.viewModelInstance?.number('lookY')?.value = 0;
        }
        _sync();
      },
      onHover: _look,
      // Its own layer: a frame the artboard redraws is then the artboard's
      // picture alone, not the composer, the thread and the sidebar with it.
      child: RepaintBoundary(child: avatar),
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
    // An unlabelled avatar is decoration and leaves nothing in the tree — not
    // even an empty image node. One of those beside the working row's label
    // made that row a branch rather than a leaf, and the words the row spoke
    // ("Stopping the previous reply…") moved from its text into an aria-label
    // nothing reading the transcript's text could see.
    if (widget.semanticsLabel == null) return ExcludeSemantics(child: result);
    return Semantics(
      // A labelled image is a node of its own. Left as an annotation it merged
      // into the nearest ancestor node — the conversation pane's, once the
      // companion sat beside the composer — and the web engine's image
      // handling then dropped that node's identifier, so `shell-conversation`
      // vanished from the accessibility tree while its contents stayed.
      container: true,
      image: true,
      label: widget.semanticsLabel,
      // Excluded below the label: the artboard publishes semantic nodes of
      // its own, with focus handling, and beside the composer those took the
      // keyboard focus the text field had — every keystroke after a tap on
      // the composer was lost. The character is one image to a screen reader,
      // not a set of controls.
      excludeSemantics: true,
      child: result,
    );
  }

  @override
  void dispose() {
    riveRuntimeReady.removeListener(_runtimeChanged);
    widget.gaze?.removeListener(_gazeChanged);
    widget.hold?.removeListener(_holdChanged);
    _quietTimer?.cancel();
    _settleTimer?.cancel();
    _restTimer?.cancel();
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
