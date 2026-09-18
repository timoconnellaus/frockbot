import 'package:flutter/material.dart';

import 'character/catalog.dart';
import 'client/auth.dart';
import 'client/store.dart';
import 'client/transport.dart';
import 'theme/tokens.dart';

/// What one product supplies to the Bot client.
///
/// The kit is the conversation shell, cards, protocol, transport, character
/// engine and theme machinery. Palette, cast, strings, sign-in and deep-link
/// policy stay per product. FrockBot's `main.dart` is the first consumer;
/// a second product writes the same config over its own art.
@immutable
class ProductConfig {
  /// The name drawn on the sign-in door and in the window title.
  final String name;

  /// The origin the client talks to. Empty means this build's own host.
  final String origin;

  /// Theme tokens the [ThemeData] builder reads. Omitted colours keep
  /// FrockBot's palette so a partial config still paints.
  final ProductThemeTokens theme;

  /// The characters this product draws. Keys are the ids a Bot appearance
  /// may name.
  final Map<String, CharacterDefinition> characters;

  /// The character drawn when a Bot names none, or an unknown id.
  final String defaultCharacterId;

  /// Copy on the sign-in door and a handful of host sentences.
  final ProductStrings strings;

  /// How this build signs in. The kit never constructs one itself.
  final SignIn Function(NativeApi api, LocalStore store) signIn;

  /// The Flutter package that owns character assets (`*.riv`, stills).
  /// Null means they live in this kit package.
  final String? assetPackage;

  /// Prefix for character assets, including the trailing slash.
  final String characterAssetPrefix;

  /// Deep-link hosts this build treats as its own, besides the origin.
  final List<String> deepLinkHosts;

  const ProductConfig({
    required this.name,
    required this.origin,
    required this.theme,
    required this.characters,
    required this.defaultCharacterId,
    required this.strings,
    required this.signIn,
    this.assetPackage,
    this.characterAssetPrefix = 'assets/characters/',
    this.deepLinkHosts = const [],
  });

  static ProductConfig of(BuildContext context) {
    final scope = context.dependOnInheritedWidgetOfExactType<ProductScope>();
    assert(scope != null, 'ProductConfig.of() called with no ProductScope');
    return scope!.config;
  }

  static ProductConfig? maybeOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<ProductScope>()?.config;
}

/// Host sentences a product owns. The kit never hardcodes a product name.
@immutable
class ProductStrings {
  final String tagline;
  final String pitch;
  final String unreachable;
  final String signInFailed;
  final String signInOpenFailed;
  final String signOutFailed;
  final String deepLinkFailed;

  const ProductStrings({
    required this.tagline,
    required this.pitch,
    required this.unreachable,
    required this.signInFailed,
    required this.signInOpenFailed,
    required this.signOutFailed,
    required this.deepLinkFailed,
  });
}

/// Makes [ProductConfig] available below the app entry.
class ProductScope extends InheritedWidget {
  final ProductConfig config;
  const ProductScope({
    super.key,
    required this.config,
    required super.child,
  });

  @override
  bool updateShouldNotify(ProductScope oldWidget) =>
      !identical(config, oldWidget.config);
}

/// Process-wide binding so code without a [BuildContext] can still resolve
/// the catalog and asset package. [runFrockBot] sets it before [runApp].
final class ProductBinding {
  static ProductConfig? _current;

  static ProductConfig get current {
    final config = _current;
    if (config == null) {
      throw StateError('ProductBinding.current read before runFrockBot');
    }
    return config;
  }

  static ProductConfig? get maybeCurrent => _current;

  /// Installs the product this process is. Tests may call it without
  /// [runFrockBot]; production goes through the app entry.
  static void activate(ProductConfig config) => _current = config;
}
