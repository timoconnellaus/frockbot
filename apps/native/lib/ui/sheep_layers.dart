import 'package:flutter/foundation.dart';

import 'sheep_layers.generated.dart';

/// What a Bot looks like: the Flock's sheep recipe, one choice per tree.
/// Mirrors `SheepRecipeV1` on the wire without depending on the protocol.
@immutable
class SheepLook {
  const SheepLook({
    required this.background,
    required this.upper,
    required this.middle,
    required this.lower,
  });
  final String background;
  final String upper;
  final String middle;
  final String lower;

  /// The brand sheep: the first background and nothing on.
  static const plain = SheepLook(
    background: 'hot-pink',
    upper: 'upper-neutral',
    middle: 'middle-neutral',
    lower: 'lower-neutral',
  );

  @override
  bool operator ==(Object other) =>
      other is SheepLook &&
      other.background == background &&
      other.upper == upper &&
      other.middle == middle &&
      other.lower == lower;
  @override
  int get hashCode => Object.hash(background, upper, middle, lower);
}

/// The layers to stack for a look, bottom first: the background, the
/// canonical sheep, then each chosen node with its ancestors below the root.
/// Same order as `sheepLayerIds` in packages/plugin-flock/src/shared.ts, so a
/// Bot looks the same in the app as on the web.
List<String> sheepLayerIds(SheepLook look) {
  // A background the app does not know falls back to the first one, so the
  // tile is always coloured; a layer it does not know is simply not drawn.
  final background = sheepBackgrounds.contains(look.background)
      ? look.background
      : sheepBackgrounds.first;
  final result = <String>['background-$background', sheepCanonical];
  for (final selected in [look.upper, look.middle, look.lower]) {
    final path = <String>[];
    String? id = selected;
    // An id the app does not know (a newer layer) is skipped rather than
    // drawn as a missing image: the sheep is still a sheep.
    while (id != null && sheepLayerParents.containsKey(id)) {
      final parent = sheepLayerParents[id];
      if (parent != null) path.insert(0, id);
      id = parent;
    }
    result.addAll(path);
  }
  return result;
}

/// The asset for one layer id.
String sheepLayerAsset(String id) => 'assets/sheep/$id.webp';
