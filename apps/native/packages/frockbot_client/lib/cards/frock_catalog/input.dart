/// The input family: the answers a card can take.
///
/// Each of these writes straight into the renderer's data model, which is what
/// a press carries back to the kernel when the surface asked for it
/// (`sendDataModel`). So the Bot reads an answer the same way whatever control
/// took it, and a control never holds state of its own that the Bot cannot
/// see.
library;

import 'package:a2ui_flutter/a2ui_flutter.dart';
import 'package:flutter/material.dart';

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
final frockChoiceChips = ComponentImplementation(
  name: 'ChoiceChips',
  schema: frockSchemaOf('ChoiceChips'),
  builder: (context, node, props, buildChild) {
    final options = _options(props.value('options'), max: 12);
    return frockControlV1(
      node,
      props,
      'value',
      (chosen, write) => Wrap(
        spacing: 8,
        runSpacing: 8,
        children: [
          for (final option in options)
            ChoiceChip(
              label: Text(frockString(option['label'])!),
              selected:
                  ComponentProps.asString(chosen) ==
                  frockString(option['value']),
              onSelected: (_) {
                write(frockString(option['value']));
                frockDispatchV1(props, 'action');
              },
            ),
        ],
      ),
    );
  },
);

/// Tick any number of a handful.
final frockMultiSelect = ComponentImplementation(
  name: 'MultiSelect',
  schema: frockSchemaOf('MultiSelect'),
  builder: (context, node, props, buildChild) {
    final options = _options(props.value('options'), max: 12);
    final max = props.value('maxSelected') == null
        ? null
        : frockInt(props.value('maxSelected'), min: 1, max: 12, fallback: 1);
    final theme = Theme.of(context);
    return frockControlV1(node, props, 'values', (ticked, write) {
      final chosen = [
        for (final value in ticked is List ? ticked : const <Object?>[])
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
                write(next);
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
    });
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
final frockSegmentedControl = ComponentImplementation(
  name: 'SegmentedControl',
  schema: frockSchemaOf('SegmentedControl'),
  builder: (context, node, props, buildChild) {
    final options = _options(props.value('options'), max: 4);
    if (options.isEmpty) return const SizedBox.shrink();
    return frockControlV1(node, props, 'value', (value, write) {
      final chosen = ComponentProps.asString(value);
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
          write(picked.first);
          frockDispatchV1(props, 'action');
        },
      );
    });
  },
);

/// How good was it, in stars.
final frockRating = ComponentImplementation(
  name: 'Rating',
  schema: frockSchemaOf('Rating'),
  builder: (context, node, props, buildChild) {
    final theme = Theme.of(context);
    final max = frockInt(props.value('max'), min: 3, max: 10, fallback: 5);
    final readOnly = frockBool(props.value('readOnly'));
    // A read-only rating is a fact the card was given, so it is read where
    // it was written; one being asked for lives in the data model, because
    // that is what a press carries back.
    Widget stars(Object? value, void Function(Object? value)? write) {
      final stars = (ComponentProps.asNumber(value) ?? 0).round().clamp(0, max);
      // A `Wrap`, not a `Row`: ten stars beside a label are wider than a
      // narrow card, and a rating that overflowed would be a rating the
      // person could not finish giving.
      return Wrap(
        children: [
          for (var star = 1; star <= max; star++)
            Semantics(
              button: !readOnly,
              label: '$star of $max',
              child: IconButton(
                visualDensity: VisualDensity.compact,
                padding: EdgeInsets.zero,
                constraints: const BoxConstraints(minWidth: 32, minHeight: 32),
                onPressed: write == null
                    ? null
                    // Pressing the star that is already the rating clears
                    // it, which is the only way back to none.
                    : () => write(star == stars ? 0 : star),
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
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (props.value('label') != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 4),
            child: Text(
              frockString(props.value('label')) ?? '',
              style: theme.textTheme.bodyMedium,
            ),
          ),
        if (readOnly)
          stars(props['value'], null)
        else
          frockControlV1(node, props, 'value', stars),
      ],
    );
  },
);

/// The family, in the order the catalog declares it.
final List<ComponentImplementation> frockInputItemsV1 = List.unmodifiable([
  frockChoiceChips,
  frockMultiSelect,
  frockSegmentedControl,
  frockRating,
]);
