import 'package:flutter/material.dart';

import '../../theme/frock_theme.dart';

/// What a state means, and what the host draws it in.
///
/// A Card names a tone, never a colour: the palette is the app's, so a Bot's
/// card and a Plugin's card and the host's own chrome all say "done" in the
/// same green, and a card cannot paint itself into looking like something it
/// is not.
enum FrockTone {
  neutral,
  ready,
  success,
  warning,
  danger;

  /// The tone a component named, or [neutral] for anything else. An unknown
  /// tone is not worth refusing a card over — the schema already says which
  /// five there are, and a sixth reads as "no particular state".
  static FrockTone read(Object? value, {FrockTone fallback = neutral}) =>
      FrockTone.values.firstWhere(
        (tone) => tone.name == value,
        orElse: () => fallback,
      );
}

/// The ink and the wash one tone is drawn with, against this brightness.
@immutable
class FrockToneColors {
  final Color ink;
  final Color wash;
  const FrockToneColors({required this.ink, required this.wash});
}

/// A tone in the app's own colours. The wash is the ink at a tenth, which is
/// the pill's fill everywhere it appears.
FrockToneColors frockToneColorsV1(ThemeData theme, FrockTone tone) {
  final scheme = theme.colorScheme;
  final dark = theme.brightness == Brightness.dark;
  final ink = switch (tone) {
    FrockTone.neutral => scheme.onSurfaceVariant,
    FrockTone.ready => scheme.primary,
    FrockTone.success => dark ? FrockTheme.success : FrockTheme.successInk,
    FrockTone.warning => dark ? FrockTheme.warning : FrockTheme.warningInk,
    FrockTone.danger => scheme.error,
  };
  return FrockToneColors(ink: ink, wash: ink.withValues(alpha: 0.12));
}
