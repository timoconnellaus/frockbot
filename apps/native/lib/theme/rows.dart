import 'package:flutter/material.dart';

import 'frock_theme.dart';

/// A group of [FrockRow]s on one card, with a hairline between each pair
/// drawn from the text's left edge rather than the card's — the icons stay
/// one column and the lines read as belonging to the words.
class FrockRowGroup extends StatelessWidget {
  final List<Widget> rows;
  const FrockRowGroup({super.key, required this.rows});

  @override
  Widget build(BuildContext context) => Card(
    margin: EdgeInsets.zero,
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (var index = 0; index < rows.length; index++) ...[
          if (index > 0) const Divider(height: 1, indent: 48),
          rows[index],
        ],
      ],
    ),
  );
}

/// One destination: a glyph, a name, an optional line under it, and at the
/// end either the way in or what the row holds. Forty-six points tall, which
/// is enough for a thumb and no more.
class FrockRow extends StatelessWidget {
  final IconData? icon;
  final Widget? leading;
  final String title;
  final String? subtitle;
  final Widget? trailing;
  final bool chevron;
  final Color? color;
  final VoidCallback? onTap;
  const FrockRow({
    super.key,
    this.icon,
    this.leading,
    required this.title,
    this.subtitle,
    this.trailing,
    this.chevron = true,
    this.color,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final ink = color ?? theme.colorScheme.onSurface;
    final glyph = color ?? theme.colorScheme.onSurfaceVariant;
    return InkWell(
      onTap: onTap,
      child: ConstrainedBox(
        constraints: BoxConstraints(minHeight: subtitle == null ? 46 : 58),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 8, 12, 8),
          child: Row(
            children: [
              if (leading case final Widget mark) ...[
                mark,
                const SizedBox(width: 12),
              ] else if (icon case final IconData glyphData) ...[
                SizedBox(
                  width: 22,
                  child: Icon(glyphData, size: 20, color: glyph),
                ),
                const SizedBox(width: 12),
              ],
              Expanded(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.bodyMedium?.copyWith(
                        fontSize: 14,
                        fontWeight: FontWeight.w500,
                        letterSpacing: -0.1,
                        color: ink,
                      ),
                    ),
                    if (subtitle case final String line) ...[
                      const SizedBox(height: 2),
                      Text(
                        line,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.bodySmall?.copyWith(
                          fontSize: 12.5,
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
              if (trailing case final Widget end) ...[
                const SizedBox(width: 10),
                end,
              ],
              if (chevron && onTap != null) ...[
                const SizedBox(width: 6),
                Icon(
                  Icons.chevron_right_rounded,
                  size: 18,
                  color: theme.colorScheme.onSurfaceVariant.withValues(
                    alpha: 0.55,
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// The small uppercase heading over a group: what its rows have in common.
class FrockSectionLabel extends StatelessWidget {
  final String text;
  final EdgeInsets padding;
  const FrockSectionLabel(
    this.text, {
    super.key,
    this.padding = const EdgeInsets.fromLTRB(12, 18, 4, 6),
  });

  @override
  Widget build(BuildContext context) => Padding(
    padding: padding,
    child: Text(
      text.toUpperCase(),
      style: Theme.of(context).textTheme.labelSmall
          ?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant),
    ),
  );
}

/// A control-sized secondary button: the theme's outline, thirty-two points
/// tall, for a card's foot or a row's end.
ButtonStyle frockCompactButton(BuildContext context) {
  final theme = Theme.of(context);
  return OutlinedButton.styleFrom(
    minimumSize: const Size(0, 32),
    padding: const EdgeInsets.symmetric(horizontal: 12),
    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
    textStyle: theme.textTheme.labelMedium,
    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(9)),
    side: BorderSide(color: FrockTheme.hairline(theme.colorScheme)),
  );
}
