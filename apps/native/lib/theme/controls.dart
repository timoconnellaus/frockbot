import 'package:flutter/material.dart';

import 'frock_theme.dart';

/// How much an icon control says about itself.
enum FrockIconButtonKind {
  /// Just the glyph, in the muted colour: chrome that should not compete.
  quiet,

  /// A hairline frame around the glyph: a header's actions, the composer's
  /// side controls.
  outlined,

  /// A faint fill: a secondary action sitting inside a field.
  tonal,

  /// The accent itself, in its own ink: the one thing to press.
  filled,
}

/// The app's icon control. Every icon button that is not a stock Material one
/// is one of these four kinds, at the size its surroundings ask for.
class FrockIconButton extends StatelessWidget {
  final Widget icon;
  final String? tooltip;
  final VoidCallback? onPressed;
  final FrockIconButtonKind kind;

  /// The painted square (or circle).
  final double extent;

  /// Whether the tap target is padded out to the platform minimum around a
  /// smaller painted control — the circle shrinks, the thing a thumb has to
  /// hit does not. Off where the extent already is the target.
  final bool padded;

  /// Defaults to a little under half the extent.
  final double? iconSize;

  /// A circle rather than a rounded square.
  final bool round;

  /// The glyph's colour, where the kind's own would say the wrong thing: a
  /// running Computer's blue, an active call's accent.
  final Color? color;

  const FrockIconButton({
    super.key,
    required this.icon,
    required this.tooltip,
    required this.onPressed,
    this.kind = FrockIconButtonKind.quiet,
    this.extent = 36,
    this.padded = false,
    this.iconSize,
    this.round = false,
    this.color,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final side = kind == FrockIconButtonKind.outlined
        ? BorderSide(color: FrockTheme.hairline(scheme))
        : BorderSide.none;
    final background = switch (kind) {
      FrockIconButtonKind.quiet || FrockIconButtonKind.outlined => null,
      FrockIconButtonKind.tonal => scheme.onSurface.withValues(alpha: 0.08),
      FrockIconButtonKind.filled => scheme.primary,
    };
    final foreground =
        color ??
        switch (kind) {
          FrockIconButtonKind.quiet => scheme.onSurfaceVariant,
          FrockIconButtonKind.outlined ||
          FrockIconButtonKind.tonal => scheme.onSurface,
          FrockIconButtonKind.filled => scheme.onPrimary,
        };
    return IconButton(
      tooltip: tooltip,
      onPressed: onPressed,
      icon: icon,
      style: IconButton.styleFrom(
        minimumSize: Size.square(extent),
        maximumSize: Size.square(extent),
        fixedSize: Size.square(extent),
        padding: EdgeInsets.zero,
        iconSize: iconSize ?? (extent * 0.47).roundToDouble(),
        tapTargetSize: padded
            ? MaterialTapTargetSize.padded
            : MaterialTapTargetSize.shrinkWrap,
        backgroundColor: background,
        foregroundColor: foreground,
        disabledBackgroundColor: kind == FrockIconButtonKind.filled
            ? scheme.onSurface.withValues(alpha: 0.06)
            : background,
        disabledForegroundColor: scheme.onSurfaceVariant.withValues(alpha: 0.5),
        shape: round
            ? CircleBorder(side: side)
            : RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(
                  extent >= 40
                      ? FrockTheme.radiusControl
                      : FrockTheme.radiusRow,
                ),
                side: side,
              ),
      ),
    );
  }
}

/// A small round mark: unread, a state, a connection. [ring] cuts it out of
/// whatever it overlaps, in that ground's colour.
class StatusDot extends StatelessWidget {
  final Color color;
  final double size;
  final Color? ring;
  const StatusDot({super.key, required this.color, this.size = 8, this.ring});

  @override
  Widget build(BuildContext context) => Container(
    width: size,
    height: size,
    decoration: BoxDecoration(
      color: color,
      shape: BoxShape.circle,
      border: ring == null ? null : Border.all(color: ring!, width: 2),
    ),
  );
}

/// A handful of mutually exclusive choices on one line. The chosen one wears
/// the accent at full strength.
class FrockSegmented extends StatelessWidget {
  final String label;
  final String? selected;
  final List<({String slug, String label})> options;
  final void Function(String slug) onChosen;
  const FrockSegmented({
    super.key,
    required this.label,
    required this.selected,
    required this.options,
    required this.onChosen,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Container(
      padding: const EdgeInsets.all(2),
      decoration: BoxDecoration(
        color: scheme.onSurface.withValues(alpha: 0.05),
        borderRadius: BorderRadius.circular(FrockTheme.radiusControl),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (final option in options)
            Semantics(
              button: true,
              selected: option.slug == selected,
              label: '$label: ${option.label}',
              child: ExcludeSemantics(
                child: InkWell(
                  onTap: () => onChosen(option.slug),
                  borderRadius: BorderRadius.circular(FrockTheme.radiusRow),
                  child: Container(
                    height: 30,
                    alignment: Alignment.center,
                    padding: const EdgeInsets.symmetric(horizontal: 10),
                    decoration: BoxDecoration(
                      color: option.slug == selected
                          ? scheme.primary
                          : Colors.transparent,
                      borderRadius: BorderRadius.circular(FrockTheme.radiusRow),
                    ),
                    child: Text(
                      option.label,
                      style: theme.textTheme.labelMedium?.copyWith(
                        fontSize: 12.5,
                        color: option.slug == selected
                            ? scheme.onPrimary
                            : scheme.onSurfaceVariant,
                        fontWeight: option.slug == selected
                            ? FontWeight.w600
                            : FontWeight.w400,
                      ),
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
