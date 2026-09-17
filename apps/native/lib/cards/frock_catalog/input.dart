/// The input family: the answers a card can take.
///
/// Each of these writes straight into the renderer's data model, which is what
/// a press carries back to the kernel when the surface asked for it
/// (`sendDataModel`). So the Bot reads an answer the same way whatever control
/// took it, and a control never holds state of its own that the Bot cannot
/// see.
library;

import 'package:flutter/material.dart';
import 'package:genui/genui.dart';

import '../../theme/frock_theme.dart';
import 'common.dart';

/// The `{label, value}` rows a chooser was given, with anything malformed
/// dropped rather than drawn as a blank control.
List<Map<String, Object?>> _options(Object? value, {required int max}) => [
  for (final option in frockRows(value, max: max))
    if (frockString(option['label']) != null &&
        frockString(option['value']) != null)
      option,
];

/// Pick one of a handful, as chips that wrap.
final frockChoiceChips = CatalogItem(
  name: 'ChoiceChips',
  dataSchema: frockSchemaOf('ChoiceChips'),
  widgetBuilder: (itemContext) {
    final data = (itemContext.data as Map).cast<String, Object?>();
    final options = _options(data['options'], max: 12);
    final path = frockWritePathV1(data['value'], itemContext.id);
    return BoundString(
      dataContext: itemContext.dataContext,
      value: {'path': path},
      builder: (context, chosen) => Wrap(
        spacing: 8,
        runSpacing: 8,
        children: [
          for (final option in options)
            ChoiceChip(
              label: Text(frockString(option['label'])!),
              selected: chosen == frockString(option['value']),
              onSelected: (_) {
                itemContext.dataContext.update(
                  DataPath(path),
                  frockString(option['value']),
                );
                frockDispatchV1(itemContext, data['action']);
              },
            ),
        ],
      ),
    );
  },
);

/// Tick any number of a handful.
final frockMultiSelect = CatalogItem(
  name: 'MultiSelect',
  dataSchema: frockSchemaOf('MultiSelect'),
  widgetBuilder: (itemContext) {
    final data = (itemContext.data as Map).cast<String, Object?>();
    final options = _options(data['options'], max: 12);
    final path = frockWritePathV1(data['values'], itemContext.id);
    final max = data['maxSelected'] == null
        ? null
        : frockInt(data['maxSelected'], min: 1, max: 12, fallback: 1);
    final theme = Theme.of(itemContext.buildContext);
    return BoundList(
      dataContext: itemContext.dataContext,
      value: {'path': path},
      builder: (context, ticked) {
        final chosen = [
          for (final value in ticked ?? const <Object?>[])
            if (value is String) value,
        ];
        final full = max != null && chosen.length >= max;
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            for (final option in options)
              _Tick(
                label: frockString(option['label'])!,
                detail: frockString(option['detail']),
                ticked: chosen.contains(frockString(option['value'])),
                // Past the limit the unticked stop responding, rather than
                // silently dropping what was ticked first: the person chose
                // those, and a control that undid a choice they made to make
                // room for one they did not would be lying about what they
                // said.
                enabled: !full || chosen.contains(frockString(option['value'])),
                onChanged: (on) {
                  final value = frockString(option['value'])!;
                  // The order is the options' own, not the order they were
                  // ticked in, so the list the Bot reads back is the list it
                  // wrote — whatever order the person worked in.
                  final next = [
                    for (final candidate in options)
                      if (frockString(candidate['value']) == value
                          ? on
                          : chosen.contains(frockString(candidate['value'])))
                        frockString(candidate['value'])!,
                  ];
                  itemContext.dataContext.update(DataPath(path), next);
                },
              ),
            if (full)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text(
                  max == 1 ? 'Pick one.' : 'Pick up to $max.',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ),
          ],
        );
      },
    );
  },
);

class _Tick extends StatelessWidget {
  final String label;
  final String? detail;
  final bool ticked;
  final bool enabled;
  final ValueChanged<bool> onChanged;
  const _Tick({
    required this.label,
    required this.detail,
    required this.ticked,
    required this.enabled,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return InkWell(
      onTap: enabled ? () => onChanged(!ticked) : null,
      borderRadius: BorderRadius.circular(FrockTheme.radiusControl),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SizedBox.square(
              dimension: 24,
              child: Checkbox(
                value: ticked,
                onChanged: enabled ? (on) => onChanged(on ?? false) : null,
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    label,
                    style: theme.textTheme.bodyMedium?.copyWith(
                      color: enabled
                          ? theme.colorScheme.onSurface
                          : theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                  if (detail != null)
                    Text(
                      detail!,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Choose between two, three or four things that are always visible.
final frockSegmentedControl = CatalogItem(
  name: 'SegmentedControl',
  dataSchema: frockSchemaOf('SegmentedControl'),
  widgetBuilder: (itemContext) {
    final data = (itemContext.data as Map).cast<String, Object?>();
    final options = _options(data['options'], max: 4);
    if (options.isEmpty) return const SizedBox.shrink();
    final path = frockWritePathV1(data['value'], itemContext.id);
    return BoundString(
      dataContext: itemContext.dataContext,
      value: {'path': path},
      builder: (context, chosen) {
        final values = [
          for (final option in options) frockString(option['value'])!,
        ];
        // Nothing chosen is the first segment, drawn as chosen: a segmented
        // control with no segment lit reads as broken, and the first option is
        // what the card put first.
        final selected = values.contains(chosen) ? chosen! : values.first;
        return SegmentedButton<String>(
          showSelectedIcon: false,
          segments: [
            for (final option in options)
              ButtonSegment<String>(
                value: frockString(option['value'])!,
                label: Text(frockString(option['label'])!),
              ),
          ],
          selected: {selected},
          onSelectionChanged: (picked) {
            itemContext.dataContext.update(DataPath(path), picked.first);
            frockDispatchV1(itemContext, data['action']);
          },
        );
      },
    );
  },
);

/// How good was it, in stars.
final frockRating = CatalogItem(
  name: 'Rating',
  dataSchema: frockSchemaOf('Rating'),
  widgetBuilder: (itemContext) {
    final data = (itemContext.data as Map).cast<String, Object?>();
    final theme = Theme.of(itemContext.buildContext);
    final max = frockInt(data['max'], min: 3, max: 10, fallback: 5);
    final readOnly = frockBool(data['readOnly']);
    final path = frockWritePathV1(data['value'], itemContext.id);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (data['label'] != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 4),
            child: Text(
              frockString(data['label']) ?? '',
              style: theme.textTheme.bodyMedium,
            ),
          ),
        BoundNumber(
          dataContext: itemContext.dataContext,
          // A read-only rating is a fact the card was given, so it is read
          // where it was written; one being asked for lives in the data model,
          // because that is what a press carries back.
          value: readOnly ? data['value'] : {'path': path},
          builder: (context, value) {
            final stars = (value ?? 0).round().clamp(0, max);
            return Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                for (var star = 1; star <= max; star++)
                  Semantics(
                    button: !readOnly,
                    label: '$star of $max',
                    child: IconButton(
                      visualDensity: VisualDensity.compact,
                      padding: EdgeInsets.zero,
                      constraints: const BoxConstraints(
                        minWidth: 32,
                        minHeight: 32,
                      ),
                      onPressed: readOnly
                          ? null
                          : () => itemContext.dataContext.update(
                              DataPath(path),
                              // Pressing the star that is already the rating
                              // clears it, which is the only way back to none.
                              star == stars ? 0 : star,
                            ),
                      icon: Icon(
                        star <= stars ? Icons.star : Icons.star_border,
                        size: 20,
                        color: star <= stars
                            ? theme.colorScheme.primary
                            : theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ),
              ],
            );
          },
        ),
      ],
    );
  },
);

/// The family, in the order the catalog declares it.
final List<CatalogItem> frockInputItemsV1 = List.unmodifiable([
  frockChoiceChips,
  frockMultiSelect,
  frockSegmentedControl,
  frockRating,
]);
