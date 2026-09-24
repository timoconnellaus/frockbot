/// The animated character shared by every surface that represents a Bot.
library;

import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
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

/// Opaque pixels of a still, in the still's own canvas. The conversation
/// companion sizes itself to this silhouette so the empty frame around a
/// drawing is not part of the height from the top of the thread.
@immutable
class CharacterInk {
  final double canvasWidth;
  final double canvasHeight;
  final double left;
  final double top;
  final double width;
  final double height;
  const CharacterInk({
    required this.canvasWidth,
    required this.canvasHeight,
    required this.left,
    required this.top,
    required this.width,
    required this.height,
  });

  Size boxForHeight(double inkHeight) =>
      Size(inkHeight * width / height, inkHeight);

  /// Where the silhouette sits in a square the canvas is contained in, as
  /// fractions of the square.
  Rect get withinSquare {
    final scale = 1 / math.max(canvasWidth, canvasHeight);
    return Rect.fromLTWH(
      (1 - canvasWidth * scale) / 2 + left * scale,
      (1 - canvasHeight * scale) / 2 + top * scale,
      width * scale,
      height * scale,
    );
  }
}

@immutable
class CharacterDefinition {
  final String id;
  final String label;
  final Color primary;
  final Color shade;
  final Color eyes;
  final CharacterInk ink;
  const CharacterDefinition(
    this.id,
    this.label,
    this.primary,
    this.shade,
    this.eyes, {
    required this.ink,
  });
}

const characterCatalogV1 = <String, CharacterDefinition>{
  'pixel': CharacterDefinition(
    'pixel',
    'Pixel',
    Color(0xfffc85ae),
    Color(0xffa95d75),
    Color(0xfffcf6e3),
    ink: CharacterInk(
      canvasWidth: 640,
      canvasHeight: 760,
      left: 98,
      top: 113,
      width: 447,
      height: 585,
    ),
  ),
  'guardian': CharacterDefinition(
    'guardian',
    'Guardian',
    Color(0xff3c3543),
    Color(0xff211d26),
    Color(0xffffeee0),
    ink: CharacterInk(
      canvasWidth: 457,
      canvasHeight: 615,
      left: 25,
      top: 119,
      width: 421,
      height: 464,
    ),
  ),
  'sunny': CharacterDefinition(
    'sunny',
    'Sunny',
    Color(0xffffc928),
    Color(0xffd99a00),
    Color(0xfffff6df),
    ink: CharacterInk(
      canvasWidth: 457,
      canvasHeight: 615,
      left: 11,
      top: 146,
      width: 421,
      height: 438,
    ),
  ),
  'chill': CharacterDefinition(
    'chill',
    'Chill',
    Color(0xff59c7ff),
    Color(0xff258dc5),
    Color(0xfff4fbff),
    ink: CharacterInk(
      canvasWidth: 457,
      canvasHeight: 615,
      left: 29,
      top: 98,
      width: 402,
      height: 491,
    ),
  ),
  'nudge': CharacterDefinition(
    'nudge',
    'Nudge',
    Color(0xffff8b27),
    Color(0xffc95b12),
    Color(0xfffff4e9),
    ink: CharacterInk(
      canvasWidth: 457,
      canvasHeight: 615,
      left: 29,
      top: 191,
      width: 403,
      height: 400,
    ),
  ),
  'fox': CharacterDefinition(
    'fox',
    'Fox',
    Color(0xffef6b4a),
    Color(0xffae402b),
    Color(0xfffff0dc),
    ink: CharacterInk(
      canvasWidth: 457,
      canvasHeight: 615,
      left: 17,
      top: 134,
      width: 423,
      height: 459,
    ),
  ),
  'dog': CharacterDefinition(
    'dog',
    'Dog',
    Color(0xffdca258),
    Color(0xffb67c39),
    Color(0xfffff1d3),
    ink: CharacterInk(
      canvasWidth: 457,
      canvasHeight: 615,
      left: 28,
      top: 24,
      width: 362,
      height: 568,
    ),
  ),
  'goat': CharacterDefinition(
    'goat',
    'Goat',
    Color(0xffd8c8ab),
    Color(0xff9d8968),
    Color(0xfffff8e8),
    ink: CharacterInk(
      canvasWidth: 457,
      canvasHeight: 615,
      left: 19,
      top: 70,
      width: 420,
      height: 520,
    ),
  ),
  'cow': CharacterDefinition(
    'cow',
    'Cow',
    Color(0xfff4eee4),
    Color(0xffb9a99a),
    Color(0xfffff8e8),
    ink: CharacterInk(
      canvasWidth: 457,
      canvasHeight: 615,
      left: 18,
      top: 176,
      width: 425,
      height: 416,
    ),
  ),
  'cat': CharacterDefinition(
    'cat',
    'Cat',
    Color(0xff8b72d9),
    Color(0xff5942a0),
    Color(0xfffff2dc),
    ink: CharacterInk(
      canvasWidth: 457,
      canvasHeight: 615,
      left: 25,
      top: 102,
      width: 411,
      height: 487,
    ),
  ),
  'rabbit': CharacterDefinition(
    'rabbit',
    'Rabbit',
    Color(0xffd7b9f1),
    Color(0xff9d78be),
    Color(0xfffff7e8),
    ink: CharacterInk(
      canvasWidth: 457,
      canvasHeight: 615,
      left: 49,
      top: 31,
      width: 358,
      height: 560,
    ),
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

/// What every avatar of one Bot shares, so the Bot moves as one wherever it
/// is drawn at once — the sidebar, the conversation header, the end of its
/// thread: one twitch, one greeting, one place the eyes look. An avatar that
/// names no Bot — a picker, a preview — has a presence of its own.
class _Presence {
  final String? botId;
  _Presence(this.botId);

  static final _shared = <String, _Presence>{};
  static final _random = math.Random();

  final _avatars = <_CharacterAvatarState>{};

  /// The avatars under a pointer, or in a row a pointer is over.
  final _hovers = <_CharacterAvatarState>{};

  /// The avatars that twitch between Turns: quiet ones, with motion allowed.
  final _twitchers = <_CharacterAvatarState>{};
  bool twitching = false;
  Timer? _twitchTimer;
  Timer? _settleTimer;

  /// Where the eyes look, fed by the one avatar whose surface owns a pointer.
  Offset? gaze;
  _CharacterAvatarState? _looker;

  bool get greeting => _hovers.isNotEmpty;

  static _Presence attach(String? botId, _CharacterAvatarState avatar) {
    final presence = botId == null
        ? _Presence(null)
        : _shared.putIfAbsent(botId, () => _Presence(botId));
    presence._avatars.add(avatar);
    return presence;
  }

  void detach(_CharacterAvatarState avatar) {
    _avatars.remove(avatar);
    hover(avatar, false);
    twitch(avatar, false);
    if (identical(_looker, avatar)) look(avatar, null);
    if (_avatars.isEmpty && botId != null) _shared.remove(botId);
  }

  void hover(_CharacterAvatarState avatar, bool hovered) {
    final was = greeting;
    hovered ? _hovers.add(avatar) : _hovers.remove(avatar);
    if (greeting != was) _syncAll();
  }

  void twitch(_CharacterAvatarState avatar, bool wants) {
    wants ? _twitchers.add(avatar) : _twitchers.remove(avatar);
    if (_twitchers.isNotEmpty) {
      if (_twitchTimer == null && _settleTimer == null) _scheduleTwitch();
      return;
    }
    _twitchTimer?.cancel();
    _settleTimer?.cancel();
    _twitchTimer = _settleTimer = null;
    if (twitching) {
      twitching = false;
      _syncAll();
    }
  }

  void _scheduleTwitch() {
    _twitchTimer = Timer(
      Duration(milliseconds: 7000 + _random.nextInt(11000)),
      () {
        _twitchTimer = null;
        twitching = true;
        _syncAll();
        _settleTimer = Timer(const Duration(milliseconds: 850), () {
          _settleTimer = null;
          twitching = false;
          _syncAll();
          if (_twitchers.isNotEmpty) _scheduleTwitch();
        });
      },
    );
  }

  void look(_CharacterAvatarState avatar, Offset? at) {
    _looker = at == null ? null : avatar;
    gaze = at;
    for (final each in [..._avatars]) {
      each._look();
    }
  }

  /// Every avatar of the Bot is told in the same call, so a greeting starts
  /// on the same frame everywhere it is drawn. Only the artboards are told:
  /// nothing rebuilds, which is what lets a change that lands while another
  /// widget builds reach them all.
  void _syncAll() {
    for (final each in [..._avatars]) {
      each._sync();
    }
  }
}

/// A Bot's character. The Rive artboard is transparent; its parent owns the backdrop.
class CharacterAvatar extends StatefulWidget {
  final double size;

  /// Which Bot this is. Every avatar of one Bot on screen moves as one: it
  /// twitches, greets a pointer and looks where it is looking together, and
  /// its working light is on the one clock every working light shares.
  final String? botId;
  final String? characterId;
  final String? background;
  final String? primary;
  final CharacterActivity activity;
  final CharacterEmotion emotion;
  final CharacterMotion motion;

  /// Where the eyes look, as a point in the artboard's own frame: `-1` to `1`
  /// on each axis, or nothing when there is nowhere to look. The surface
  /// that owns the pointer feeds this — the conversation pane, for the
  /// companion in the thread overlay — so the eyes follow a pointer anywhere
  /// over that surface rather than only over the character's own square.
  /// Written straight into the artboard on each change; nothing rebuilds.
  final ValueListenable<Offset?>? gaze;

  /// Size [size] as the silhouette's height and clip the empty canvas around
  /// the drawing. Compact squares in the list keep this off; the conversation
  /// companion turns it on so every character shares one inset from the top.
  final bool cropToInk;

  /// While true, the eyes may turn but the artboard is not woken to draw
  /// them, and a moment's wake already running is cut short. The surface
  /// raises it on a pointer down: the engine attaches a text field's editing
  /// element in the frames after a tap, and an artboard drawing beside the
  /// field in those frames cost the first keystroke typed into it.
  final ValueListenable<bool>? hold;

  /// The Bot is working in the conversation this surface stands for. Every
  /// surface draws that one way — the drawing held in place, the eyes ahead,
  /// and [WorkingSheen]'s light crossing it — so a working Bot looks the same
  /// in the sidebar, in the header and at the end of its thread, whatever
  /// [activity] and [motion] each passes. It is about the conversation, not
  /// the Bot: a Bot answering in a group lights the group, and its own row
  /// and its own chat stay at rest.
  final bool working;
  final String? semanticsLabel;

  const CharacterAvatar({
    super.key,
    this.size = 40,
    this.botId,
    this.characterId,
    this.background,
    this.primary,
    this.activity = CharacterActivity.idle,
    this.emotion = CharacterEmotion.neutral,
    this.motion = CharacterMotion.active,
    this.gaze,
    this.hold,
    this.working = false,
    this.cropToInk = false,
    this.semanticsLabel,
  });

  @override
  State<CharacterAvatar> createState() => _CharacterAvatarState();
}

class _CharacterAvatarState extends State<CharacterAvatar> {
  static final _loaders = <String, rive.FileLoader>{};
  rive.RiveLoaded? _loaded;
  Timer? _restTimer;
  late _Presence _presence;

  /// Keeps the artboard's state when the working light is put over it or
  /// taken off: the light is a layer above the same drawing.
  final _figureKey = GlobalKey();

  /// The last state the ticker was woken for; see `_sync`.
  String? _synced;

  /// Where the eyes were last pointed; see `_look`.
  Offset? _lookedAt;

  /// Whether `_sync` last left the ticker running for good, as opposed to a
  /// moment's wake that `_restTimer` ends.
  bool _running = false;
  bool _localHovered = false;

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
    _presence = _Presence.attach(widget.botId, this);
    riveRuntimeReady.addListener(_runtimeChanged);
    widget.gaze?.addListener(_gazeChanged);
    widget.hold?.addListener(_holdChanged);
  }

  bool get _held => widget.hold?.value ?? false;

  /// A hold that begins stops a moment's wake at once; one that ends draws
  /// whatever the eyes were told meanwhile.
  void _holdChanged() {
    _sync();
    if (!_held && _presence.gaze != null) _wake();
  }

  /// The surface's pointer moved: the Bot looks there, wherever it is drawn.
  void _gazeChanged() => _presence.look(this, widget.gaze?.value);

  /// Working holds the drawing where it is, as still does: the light
  /// crossing it is the motion, and it is the same everywhere.
  bool get _heldStill =>
      widget.working || widget.motion == CharacterMotion.still;

  /// Whether the artboard greets: a pointer over any avatar of the Bot, or
  /// the Bot's twitch.
  @visibleForTesting
  bool get greeting =>
      !_heldStill && (_presence.greeting || _presence.twitching);

  /// Where the eyes look: where the Bot looks, or ahead while it works.
  @visibleForTesting
  Offset? get looking => widget.working ? null : _presence.gaze;

  /// Turns the eyes to where the Bot is looking and wakes a resting artboard
  /// long enough to draw the turn before it rests again.
  void _look() {
    final model = _loaded?.viewModelInstance;
    if (model == null) return;
    final at = looking;
    final look = Offset(
      (at?.dx ?? 0).clamp(-1.0, 1.0),
      (at?.dy ?? 0).clamp(-1.0, 1.0),
    );
    if (look == _lookedAt) return;
    _lookedAt = look;
    model.number('lookX')?.value = look.dx;
    model.number('lookY')?.value = look.dy;
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
      if (widget.gaze != null || identical(_presence._looker, this)) {
        _gazeChanged();
      }
    }
    if (!identical(oldWidget.hold, widget.hold)) {
      oldWidget.hold?.removeListener(_holdChanged);
      widget.hold?.addListener(_holdChanged);
    }
    if (oldWidget.botId != widget.botId) {
      _presence.detach(this);
      _presence = _Presence.attach(widget.botId, this);
      _lookedAt = null;
    }
    if (oldWidget.characterId != widget.characterId) {
      _loaded = null;
      _synced = null;
      _lookedAt = null;
    }
    _share();
    _sync();
    _look();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _share();
    _sync();
  }

  /// Out of the tree, even for a moment, this avatar is no part of the Bot's
  /// presence: a greeting or a glance that lands meanwhile never reaches an
  /// element that may not look anything up.
  @override
  void deactivate() {
    _presence.detach(this);
    super.deactivate();
  }

  @override
  void activate() {
    super.activate();
    _presence = _Presence.attach(widget.botId, this);
    _share();
  }

  /// Tells the Bot's presence what this avatar adds to it: a pointer over it
  /// or its row, and whether it is one that twitches between Turns.
  void _share() {
    _presence.hover(this, _localHovered || CharacterHoverScope.of(context));
    _presence.twitch(
      this,
      widget.motion == CharacterMotion.quiet &&
          !widget.working &&
          TickerMode.valuesOf(context).enabled &&
          !MediaQuery.disableAnimationsOf(context),
    );
  }

  void _sync() {
    final loaded = _loaded;
    if (loaded == null) return;
    final hovered = greeting;
    final reduce =
        MediaQuery.disableAnimationsOf(context) ||
        _heldStill ||
        (widget.motion == CharacterMotion.quiet && !hovered);
    final activity = widget.working
        ? CharacterActivity.working
        : widget.activity;
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
        '$run:$_held:$activity:${widget.emotion}:$primary:$hovered';
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
    model.number('activity')?.value = activity.index.toDouble();
    model.number('emotion')?.value = widget.emotion.index.toDouble();
    model.boolean('hovered')?.value = hovered;
    model.boolean('reducedMotion')?.value = reduce;
    model.color('primary')?.value = primary;
    model.color('shade')?.value = shade;
    model.color('eyeColor')?.value = definition.eyes;
  }

  /// The live artboard, filling [size], or the checked-in still until the
  /// runtime is ready.
  ///
  /// [CharacterMotion.still] is the artboard held at rest, not the still:
  /// the picture only comes in the character's catalogue colour, so a paused
  /// call swapped the Bot's own colour for it. A resting artboard is not
  /// advanced, and a composer beside one guards its field with
  /// [CharacterAvatar.hold].
  Widget _figure(Size size, {required BoxFit fit}) => SizedBox(
    width: size.width,
    height: size.height,
    child: _isFlutterTest || !riveRuntimeReady.value
        ? Image.asset(
            'assets/characters/$_characterId.png',
            fit: fit,
            excludeFromSemantics: true,
          )
        : _LiveCharacter(
            key: ValueKey(_characterId),
            loader: _loader,
            onLoaded: (loaded) {
              _loaded = loaded;
              _synced = null;
              _lookedAt = null;
              _sync();
              _look();
            },
            // A runtime that never arrives — a script the CSP refuses, a
            // request that hangs — leaves the file loading forever rather
            // than failing, so the still stands in for waiting as well as for
            // failure. An empty slot is never the better answer: the still is
            // what the animation replaces.
            still: Image.asset(
              'assets/characters/$_characterId.png',
              fit: fit,
              excludeFromSemantics: true,
            ),
          ),
  );

  @override
  Widget build(BuildContext context) {
    final ink =
        (characterCatalogV1[_characterId] ??
                characterCatalogV1[defaultCharacterIdV1]!)
            .ink;
    final Widget avatar;
    if (widget.cropToInk) {
      final scale = widget.size / ink.height;
      final box = ink.boxForHeight(widget.size);
      avatar = ClipRect(
        child: SizedBox(
          width: box.width,
          height: box.height,
          child: Stack(
            children: [
              Positioned(
                left: -ink.left * scale,
                top: -ink.top * scale,
                child: _figure(
                  Size(ink.canvasWidth * scale, ink.canvasHeight * scale),
                  fit: BoxFit.fill,
                ),
              ),
            ],
          ),
        ),
      );
    } else {
      avatar = _figure(Size.square(widget.size), fit: BoxFit.contain);
    }
    // Its own layer: a frame the artboard redraws is then the artboard's
    // picture alone, not the composer, the thread and the sidebar with it.
    Widget figure = RepaintBoundary(key: _figureKey, child: avatar);
    if (widget.working) {
      figure = WorkingSheen(
        // The silhouette, not the box: a square in the sidebar keeps empty
        // canvas around the drawing that the header's crop does not, and the
        // light has to meet the drawing at the same moment in both.
        across: widget.cropToInk
            ? const Rect.fromLTWH(0, 0, 1, 1)
            : ink.withinSquare,
        child: figure,
      );
    }
    final result = MouseRegion(
      onEnter: (_) {
        _localHovered = true;
        _share();
      },
      onExit: (_) {
        _localHovered = false;
        _share();
      },
      child: figure,
    );
    // An unlabelled avatar is decoration and leaves nothing in the tree — not
    // even an empty image node. One of those beside the working row's label
    // made that row a branch rather than a leaf, and the words the row spoke
    // ("Stopping…") moved from its text into an aria-label
    // nothing reading the transcript's text could see.
    if (widget.semanticsLabel == null) return ExcludeSemantics(child: result);
    return Semantics(
      // A labelled image is a node of its own. Left as an annotation it merged
      // into the nearest ancestor node — the conversation pane's, once the
      // companion sat in the thread — and the web engine's image handling
      // then dropped that node's identifier, so `shell-conversation` vanished
      // from the accessibility tree while its contents stayed.
      container: true,
      image: true,
      label: widget.semanticsLabel,
      // Excluded below the label: the artboard publishes semantic nodes of
      // its own, with focus handling, and those took the keyboard focus the
      // text field had — every keystroke after a tap on the composer was
      // lost. The character is one image to a screen reader, not a set of
      // controls.
      excludeSemantics: true,
      child: result,
    );
  }

  @override
  void dispose() {
    riveRuntimeReady.removeListener(_runtimeChanged);
    widget.gaze?.removeListener(_gazeChanged);
    widget.hold?.removeListener(_holdChanged);
    _restTimer?.cancel();
    super.dispose();
  }
}

/// One character's artboard, bound to its view model — `RiveWidgetBuilder`,
/// except that a file already decoded is bound before the first frame.
///
/// The builder awaits its loader even when the file is cached, so every
/// avatar a new screen mounted drew a frame of the still first: the
/// character in its catalogue colour, then the Bot's own colour a frame
/// later. [onLoaded] runs before the artboard is built, so the colour it
/// writes is the one the first frame draws.
class _LiveCharacter extends StatefulWidget {
  final rive.FileLoader loader;
  final ValueChanged<rive.RiveLoaded> onLoaded;
  final Widget still;
  const _LiveCharacter({
    super.key,
    required this.loader,
    required this.onLoaded,
    required this.still,
  });

  @override
  State<_LiveCharacter> createState() => _LiveCharacterState();
}

class _LiveCharacterState extends State<_LiveCharacter> {
  rive.RiveLoaded? _loaded;

  @override
  void initState() {
    super.initState();
    final file = widget.loader.fileSync;
    if (file != null) {
      _bind(file);
      return;
    }
    widget.loader.file().then((file) {
      if (mounted) setState(() => _bind(file));
    }, onError: (Object _) {});
  }

  void _bind(rive.File file) {
    rive.RiveWidgetController? controller;
    try {
      controller = rive.RiveWidgetController(file);
      _loaded = rive.RiveLoaded(
        file: file,
        controller: controller,
        viewModelInstance: controller.dataBind(rive.DataBind.auto()),
      );
    } on Exception {
      controller?.dispose();
      return;
    }
    widget.onLoaded(_loaded!);
  }

  @override
  void dispose() {
    // The file stays: it is the loader's, shared by every avatar of this
    // character.
    _loaded?.controller.dispose();
    _loaded?.viewModelInstance?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final loaded = _loaded;
    if (loaded == null) return widget.still;
    // Decoration only: the artboard takes no pointer and holds no focus.
    // Hover and gaze belong to the MouseRegion around it.
    return ExcludeFocus(
      child: IgnorePointer(
        child: rive.RiveWidget(
          controller: loaded.controller,
          fit: rive.Fit.contain,
          hitTestBehavior: rive.RiveHitTestBehavior.none,
        ),
      ),
    );
  }
}

/// How long one pass of the working light takes, with its rest.
const Duration workingSheenCycle = Duration(milliseconds: 2400);

/// How much of each cycle the light spends crossing; the rest is rest.
const double workingSheenSweep = 0.35;

/// Where the middle of the working light is at [time] on the frame clock, in
/// widths of what it crosses: from just off the left edge to just off the
/// right, where it waits for the next pass.
double workingSheenAt(Duration time) {
  final cycle = workingSheenCycle.inMicroseconds;
  final phase = time.inMicroseconds % cycle / cycle;
  final crossed = (phase / workingSheenSweep).clamp(0.0, 1.0);
  return -0.3 + 1.6 * Curves.easeInOut.transform(crossed);
}

/// While a Bot works, a light crosses its character and rests for a beat: the
/// light moves, the drawing does not. Every sheen reads the one frame clock
/// rather than a clock of its own, so a Bot in the sidebar, in the
/// conversation header and at the end of its thread shines at the same
/// moment, however long each has been on screen. It is painted over the
/// child's own pixels, so the live artboard and the still it falls back to
/// shine alike, and a group's faces shine as one picture.
///
/// A person who asked for less motion sees the light hold still across the
/// middle: the Bot still reads as working everywhere it is drawn, and nothing
/// moves.
class WorkingSheen extends StatefulWidget {
  /// The part of the child the light crosses, as fractions of its size.
  final Rect across;
  final Widget child;
  const WorkingSheen({
    super.key,
    required this.child,
    this.across = const Rect.fromLTWH(0, 0, 1, 1),
  });

  @override
  State<WorkingSheen> createState() => _WorkingSheenState();
}

class _WorkingSheenState extends State<WorkingSheen>
    with SingleTickerProviderStateMixin {
  /// Just off the right edge, where the light waits between passes.
  static const double _parked = 1.3;

  late final Ticker _ticker = createTicker(
    (_) => _light.value = workingSheenAt(
      SchedulerBinding.instance.currentFrameTimeStamp,
    ),
  );
  final _light = ValueNotifier<double>(_parked);

  /// Where the middle of the light is now, in widths of what it crosses.
  @visibleForTesting
  double get light => _light.value;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (MediaQuery.disableAnimationsOf(context)) {
      _ticker.stop();
      _light.value = 0.5;
    } else if (!_ticker.isActive) {
      _ticker.start();
    }
  }

  @override
  void dispose() {
    _ticker.dispose();
    _light.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ValueListenableBuilder<double>(
    valueListenable: _light,
    child: widget.child,
    // Only the light's position changes from frame to frame; while it waits
    // off the edge nothing is rebuilt at all.
    builder: (context, at, child) => ShaderMask(
      blendMode: BlendMode.srcATop,
      shaderCallback: (bounds) {
        final across = widget.across;
        final span = Rect.fromLTWH(
          bounds.left + across.left * bounds.width,
          bounds.top + across.top * bounds.height,
          across.width * bounds.width,
          across.height * bounds.height,
        );
        return LinearGradient(
          begin: const Alignment(-1, -0.35),
          end: const Alignment(1, 0.35),
          colors: const [
            Color(0x00FFFFFF),
            Color(0xB3FFFFFF),
            Color(0x00FFFFFF),
          ],
          stops: const [0.38, 0.5, 0.62],
          transform: _SheenAt((at - 0.5) * span.width),
        ).createShader(span);
      },
      child: child,
    ),
  );
}

class _SheenAt extends GradientTransform {
  final double dx;
  const _SheenAt(this.dx);

  @override
  Matrix4 transform(Rect bounds, {TextDirection? textDirection}) =>
      Matrix4.translationValues(dx, 0, 0);
}
