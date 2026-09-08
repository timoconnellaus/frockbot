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

  /// A working Bot wears a ring. It is the only thing an avatar ever says
  /// about a Turn: what the Turn is doing belongs on the Work view.
  final bool working;
  const SheepAvatar({
    super.key,
    this.size = 40,
    this.background,
    this.working = false,
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
    return Container(
      padding: const EdgeInsets.all(2),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(size * 0.34),
        border: Border.all(
          color: Theme.of(context).colorScheme.primary,
          width: 2,
        ),
      ),
      child: avatar,
    );
  }
}
