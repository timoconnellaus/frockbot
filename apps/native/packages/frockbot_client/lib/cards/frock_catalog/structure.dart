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

import 'package:a2ui_flutter/a2ui_flutter.dart';
import 'package:flutter/material.dart';

import '../../shell/person_avatar.dart';
import '../../theme/frock_theme.dart';
import 'common.dart';
import 'core.dart';
import 'tone.dart';

/// The top of a card: title, an optional quiet line, and the state pill.
final frockCardHeader = ComponentImplementation(
  name: 'CardHeader',
  schema: frockSchemaOf('CardHeader'),
  builder: (context, node, props, buildChild) {
    final theme = Theme.of(context);
    final tone = FrockTone.read(props.value('tone'));
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              FrockBoundText(
                value: props['title'],
                maxLines: 2,
                style: theme.textTheme.titleSmall,
              ),
              if (frockWrittenV1(props['subtitle']))
                Padding(
                  padding: const EdgeInsets.only(top: 2),
                  child: FrockBoundText(
                    value: props['subtitle'],
                    maxLines: 2,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                ),
            ],
          ),
        ),
        if (frockWrittenV1(props['status'])) ...[
          const SizedBox(width: 10),
          // Half the line, at most: the pill says a state in two or three
          // words, and a header whose pill had eaten the title would be a
          // card that no longer says what it is about.
          Flexible(
            flex: 1,
            child: Align(
              alignment: Alignment.centerRight,
              child: switch (props.string('status') ?? '') {
                '' => const SizedBox.shrink(),
                final status => FrockStatusPillView(label: status, tone: tone),
              },
            ),
          ),
        ],
      ],
    );
  },
);

/// A heading that divides a long card, with a hairline under it.
final frockSectionHeader = ComponentImplementation(
  name: 'SectionHeader',
  schema: frockSchemaOf('SectionHeader'),
  builder: (context, node, props, buildChild) {
    final theme = Theme.of(context);
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
                  frockString(props.value('title')) ?? '',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.labelMedium?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                    fontWeight: FontWeight.w600,
                    letterSpacing: 0.4,
                  ),
                ),
              ),
              if (frockWrittenV1(props['caption']))
                Flexible(
                  child: FrockBoundText(
                    value: props['caption'],
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
final frockCallout = ComponentImplementation(
  name: 'Callout',
  schema: frockSchemaOf('Callout'),
  builder: (context, node, props, buildChild) {
    final theme = Theme.of(context);
    final tone = FrockTone.read(props.value('tone'));
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
                if (frockWrittenV1(props['title']))
                  FrockBoundText(
                    value: props['title'],
                    style: theme.textTheme.bodyMedium?.copyWith(
                      fontWeight: FontWeight.w600,
                      color: colors.ink,
                    ),
                  ),
                FrockBoundText(
                  value: props['text'],
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
final frockIdentityRow = ComponentImplementation(
  name: 'IdentityRow',
  schema: frockSchemaOf('IdentityRow'),
  builder: (context, node, props, buildChild) {
    final theme = Theme.of(context);
    final image = frockString(props.value('imageUrl'));
    return Row(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        PersonAvatar(
          name:
              frockString(props.value('initials')) ??
              props.string('name') ??
              '',
          // Anything but https was refused before the card was drawn
          // (`admitCardV1`), so this is a guard against a record that never
          // went through the seam rather than a second policy.
          imageUrl: image != null && image.startsWith('https://')
              ? image
              : null,
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              FrockBoundText(
                value: props['name'],
                maxLines: 1,
                style: theme.textTheme.bodyMedium?.copyWith(
                  fontWeight: FontWeight.w600,
                ),
              ),
              if (frockWrittenV1(props['detail']))
                FrockBoundText(
                  value: props['detail'],
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

/// The family, in the order the catalog declares it.
final List<ComponentImplementation> frockStructureItemsV1 = List.unmodifiable([
  frockCardHeader,
  frockSectionHeader,
  frockCallout,
  frockIdentityRow,
]);
