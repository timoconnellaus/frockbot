/// What a person sees that makes this client FrockBot or another product.
///
/// The application passes one [ClientBrand] to `runFrockbot`, which installs
/// it before the first frame; nothing chooses a brand at runtime (ADR 0038).
/// A pull request that writes a product name, a character or a character's
/// asset into this package instead of reading it from here is a bug.
library;

import 'dart:math' as math;

import 'package:flutter/widgets.dart';

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

/// One character a Bot can wear. The server stores only [id], as an opaque
/// string, so a brand's ids are its own.
@immutable
class CharacterDefinition {
  final String id;
  final String label;
  final Color primary;
  final Color shade;
  final Color eyes;
  final CharacterInk ink;

  /// The Rive file and the still that stands in for it, as asset keys in the
  /// application's bundle: `assets/…` for the application's own assets,
  /// `packages/<name>/assets/…` for a package's.
  final String rive;
  final String still;

  /// The Gemini voice a Bot wearing this character speaks in until someone
  /// chooses one, so two Bots never sound the same without anyone opening
  /// settings. Null falls back to the client's default voice.
  final String? voice;

  const CharacterDefinition(
    this.id,
    this.label,
    this.primary,
    this.shade,
    this.eyes, {
    required this.ink,
    required this.rive,
    required this.still,
    this.voice,
  });
}

/// Where an installed build's updates come from.
enum ClientReleaseChannel {
  /// Shorebird patches on Android and iOS, and the Sparkle feed the macOS
  /// project names on the Mac.
  shorebird,
}

@immutable
class ClientBrand {
  /// The product's name wherever a person reads it.
  final String productName;

  /// What the built-in model is called, which the server's brand names too.
  final String builtInModelName;

  /// The picture above the product name on the sign-in page. Null draws the
  /// default character there.
  final ImageProvider? signInIcon;

  /// Every character a Bot may wear, in the order the pickers show them.
  final List<CharacterDefinition> characters;

  /// The character a Bot wears when it names none, or one this build lacks.
  final String defaultCharacterId;

  /// Font families the application bundles in its own pubspec, tried after
  /// the client's typeface for any glyph it lacks.
  final List<String> fontFamilies;

  /// Null is a plain build: no code push and no desktop feed, so the
  /// application's updaters stay inert.
  final ClientReleaseChannel? releaseChannel;

  const ClientBrand({
    required this.productName,
    required this.builtInModelName,
    required this.characters,
    required this.defaultCharacterId,
    this.signInIcon,
    this.fontFamilies = const [],
    this.releaseChannel,
  });
}

ClientBrand? _installed;
Map<String, CharacterDefinition>? _catalog;

/// The brand this process runs. `runFrockbot` installs it before the first
/// frame; a test installs one before it pumps.
ClientBrand get clientBrand =>
    _installed ??
    (throw StateError('No ClientBrand installed; call runFrockbot first.'));

/// The installed brand's characters by id, in its order.
Map<String, CharacterDefinition> get characterCatalogV1 => _catalog ??= {
  for (final character in clientBrand.characters) character.id: character,
};

String get defaultCharacterIdV1 => clientBrand.defaultCharacterId;

void installClientBrand(ClientBrand brand) {
  final ids = {for (final character in brand.characters) character.id};
  if (ids.length != brand.characters.length) {
    throw ArgumentError.value(brand, 'brand', 'character ids repeat');
  }
  if (!ids.contains(brand.defaultCharacterId)) {
    throw ArgumentError.value(
      brand.defaultCharacterId,
      'defaultCharacterId',
      'is not one of the brand\'s characters',
    );
  }
  _installed = brand;
  _catalog = null;
}
