/// The structure family: the frame a card is read through.
///
/// `CardHeader` is the one that earns its place twice over. Step 5's live Turn
/// wrote the title-and-pill row itself, out of a `Row`, a `Text` and a
/// `StatusPill`, and at phone width the pill ran off the edge of the card —
/// the model had written the row's `justify` and `weight` the way a desktop
/// looks right. Prose in the Skill fixed the next Turn; a component fixes
/// every Turn. The header lays itself out, so there is nothing for a card to
/// get wrong, and it costs one component where the row cost three.
library;

import 'package:flutter/material.dart';
import 'package:genui/genui.dart';

import '../../theme/frock_theme.dart';
import '../../theme/initials.dart';
import 'common.dart';
import 'core.dart';
import 'tone.dart';

/// The top of a card: title, an optional quiet line, and the state pill.
final frockCardHeader = CatalogItem(
  name: 'CardHeader',
  dataSchema: frockSchemaOf('CardHeader'),
  widgetBuilder: (itemContext) {
    final data = (itemContext.data as Map).cast<String, Object?>();
    final theme = Theme.of(itemContext.buildContext);
    final tone = FrockTone.read(data['tone']);
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              FrockBoundText(
                dataContext: itemContext.dataContext,
                value: data['title'],
                maxLines: 2,
                style: theme.textTheme.titleSmall,
              ),
              if (data['subtitle'] != null)
                Padding(
                  padding: const EdgeInsets.only(top: 2),
                  child: FrockBoundText(
                    dataContext: itemContext.dataContext,
                    value: data['subtitle'],
                    maxLines: 2,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                ),
            ],
          ),
        ),
        if (data['status'] != null) ...[
          const SizedBox(width: 10),
          // Half the line, at most: the pill says a state in two or three
          // words, and a header whose pill had eaten the title would be a
          // card that no longer says what it is about.
          Flexible(
            flex: 1,
            child: Align(
              alignment: Alignment.centerRight,
              child: BoundString(
                dataContext: itemContext.dataContext,
                value: data['status'],
                builder: (context, status) => (status ?? '').isEmpty
                    ? const SizedBox.shrink()
                    : FrockStatusPillView(label: status!, tone: tone),
              ),
            ),
          ),
        ],
      ],
    );
  },
);

/// A heading that divides a long card, with a hairline under it.
final frockSectionHeader = CatalogItem(
  name: 'SectionHeader',
  dataSchema: frockSchemaOf('SectionHeader'),
  widgetBuilder: (itemContext) {
    final data = (itemContext.data as Map).cast<String, Object?>();
    final theme = Theme.of(itemContext.buildContext);
    return Padding(
      padding: const EdgeInsets.only(top: 6, bottom: 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  frockString(data['title']) ?? '',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.labelMedium?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                    fontWeight: FontWeight.w600,
                    letterSpacing: 0.4,
                  ),
                ),
              ),
              if (data['caption'] != null)
                Flexible(
                  child: FrockBoundText(
                    dataContext: itemContext.dataContext,
                    value: data['caption'],
                    maxLines: 1,
                    align: TextAlign.right,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                ),
            ],
          ),
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Divider(
              height: 1,
              thickness: 1,
              color: FrockTheme.hairline(theme.colorScheme),
            ),
          ),
        ],
      ),
    );
  },
);

/// What the host draws a callout's tone as.
IconData frockCalloutIconV1(FrockTone tone) => switch (tone) {
  FrockTone.neutral => Icons.info_outline,
  FrockTone.ready => Icons.schedule_outlined,
  FrockTone.success => Icons.check_circle_outline,
  FrockTone.warning => Icons.warning_amber_outlined,
  FrockTone.danger => Icons.error_outline,
};

/// A tinted note beside the thing the card is about.
final frockCallout = CatalogItem(
  name: 'Callout',
  dataSchema: frockSchemaOf('Callout'),
  widgetBuilder: (itemContext) {
    final data = (itemContext.data as Map).cast<String, Object?>();
    final theme = Theme.of(itemContext.buildContext);
    final tone = FrockTone.read(data['tone']);
    final colors = frockToneColorsV1(theme, tone);
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
      decoration: BoxDecoration(
        color: colors.wash,
        borderRadius: BorderRadius.circular(FrockTheme.radiusControl),
        border: Border.all(color: colors.ink.withValues(alpha: 0.24)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(frockCalloutIconV1(tone), size: 18, color: colors.ink),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                if (data['title'] != null)
                  FrockBoundText(
                    dataContext: itemContext.dataContext,
                    value: data['title'],
                    style: theme.textTheme.bodyMedium?.copyWith(
                      fontWeight: FontWeight.w600,
                      color: colors.ink,
                    ),
                  ),
                FrockBoundText(
                  dataContext: itemContext.dataContext,
                  value: data['text'],
                  style: theme.textTheme.bodyMedium,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  },
);

/// A person or an account on one line.
final frockIdentityRow = CatalogItem(
  name: 'IdentityRow',
  dataSchema: frockSchemaOf('IdentityRow'),
  widgetBuilder: (itemContext) {
    final data = (itemContext.data as Map).cast<String, Object?>();
    final theme = Theme.of(itemContext.buildContext);
    final image = frockString(data['imageUrl']);
    return Row(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        BoundString(
          dataContext: itemContext.dataContext,
          value: data['name'],
          builder: (context, name) => FrockAvatarView(
            initials: frockString(data['initials']) ?? name ?? '',
            // Anything but https was refused before the card was drawn
            // (`admitCardV1`), so this is a guard against a record that never
            // went through the seam rather than a second policy.
            imageUrl: image != null && image.startsWith('https://')
                ? image
                : null,
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              FrockBoundText(
                dataContext: itemContext.dataContext,
                value: data['name'],
                maxLines: 1,
                style: theme.textTheme.bodyMedium?.copyWith(
                  fontWeight: FontWeight.w600,
                ),
              ),
              if (data['detail'] != null)
                FrockBoundText(
                  dataContext: itemContext.dataContext,
                  value: data['detail'],
                  maxLines: 1,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
            ],
          ),
        ),
      ],
    );
  },
);

/// The avatar an `IdentityRow` draws: an image when there is one, and the
/// initials the app draws everywhere else when there is not.
class FrockAvatarView extends StatelessWidget {
  final String initials;
  final String? imageUrl;
  const FrockAvatarView({super.key, required this.initials, this.imageUrl});

  String get _letters => personInitialsV1(initials);

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return ClipOval(
      child: Container(
        width: 32,
        height: 32,
        color: theme.colorScheme.primary.withValues(alpha: 0.16),
        alignment: Alignment.center,
        child: imageUrl == null
            ? Text(
                _letters,
                style: theme.textTheme.labelMedium?.copyWith(
                  color: theme.colorScheme.primary,
                  fontWeight: FontWeight.w600,
                ),
              )
            : Image.network(
                imageUrl!,
                width: 32,
                height: 32,
                fit: BoxFit.cover,
                // An avatar that will not load is not worth a broken frame:
                // the card falls back to the letters it would have drawn.
                errorBuilder: (context, error, stack) => Text(
                  _letters,
                  style: theme.textTheme.labelMedium?.copyWith(
                    color: theme.colorScheme.primary,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
      ),
    );
  }
}

/// The family, in the order the catalog declares it.
final List<CatalogItem> frockStructureItemsV1 = List.unmodifiable([
  frockCardHeader,
  frockSectionHeader,
  frockCallout,
  frockIdentityRow,
]);
