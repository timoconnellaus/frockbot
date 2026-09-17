/// The data family: a number, a proportion, a grid of rows, a sequence.
///
/// Two of these are here because the standard catalog cannot do them at all —
/// a table's columns have to line up across rows, and a timeline's rail has to
/// know which entry is last — and two because doing them by hand costs a
/// component per part and a guess at every padding.
///
/// Everything a value could be is a `DynamicString`, so a card that is
/// counting something up settles by writing pointers rather than by resending
/// its layout.
library;

import 'package:flutter/material.dart';
import 'package:genui/genui.dart';

import '../../theme/frock_theme.dart';
import 'common.dart';
import 'tone.dart';

/// One number, its name, and how it moved.
final frockMetricTile = CatalogItem(
  name: 'MetricTile',
  dataSchema: frockSchemaOf('MetricTile'),
  widgetBuilder: (itemContext) {
    final data = (itemContext.data as Map).cast<String, Object?>();
    final theme = Theme.of(itemContext.buildContext);
    final tone = FrockTone.read(data['tone']);
    final colors = frockToneColorsV1(theme, tone);
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
      decoration: BoxDecoration(
        color: theme.colorScheme.surface.withValues(alpha: 0.6),
        borderRadius: BorderRadius.circular(FrockTheme.radiusControl),
        border: Border.all(color: FrockTheme.hairline(theme.colorScheme)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.baseline,
            textBaseline: TextBaseline.alphabetic,
            children: [
              Flexible(
                child: FrockBoundText(
                  dataContext: itemContext.dataContext,
                  value: data['value'],
                  maxLines: 1,
                  style: theme.textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w600,
                    color: tone == FrockTone.neutral
                        ? theme.colorScheme.onSurface
                        : colors.ink,
                  ),
                ),
              ),
              if (data['delta'] != null) ...[
                const SizedBox(width: 6),
                Flexible(
                  child: BoundString(
                    dataContext: itemContext.dataContext,
                    value: data['delta'],
                    builder: (context, delta) =>
                        FrockDeltaView(delta: delta ?? ''),
                  ),
                ),
              ],
            ],
          ),
          const SizedBox(height: 2),
          Text(
            frockString(data['label']) ?? '',
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
          if (data['caption'] != null)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: FrockBoundText(
                dataContext: itemContext.dataContext,
                value: data['caption'],
                maxLines: 1,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ),
        ],
      ),
    );
  },
  // Two or three tiles in a `Row` is what this is for, so a tile takes its
  // share of the row rather than its natural width.
  isImplicitlyFlexible: true,
);

/// A movement, drawn from the sign the model wrote.
///
/// Which direction is good is the card's business and not the host's — a
/// falling error count is a rise — so the arrow follows the sign and the
/// colour follows nothing: the tile's own `tone` is where meaning is said.
class FrockDeltaView extends StatelessWidget {
  final String delta;
  const FrockDeltaView({super.key, required this.delta});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final trimmed = delta.trim();
    final up = trimmed.startsWith('+');
    final down = trimmed.startsWith('-') || trimmed.startsWith('−');
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (up || down)
          Icon(
            up ? Icons.arrow_upward : Icons.arrow_downward,
            size: 12,
            color: theme.colorScheme.onSurfaceVariant,
          ),
        Flexible(
          child: Text(
            trimmed,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
        ),
      ],
    );
  }
}

/// How far through something is.
final frockProgressBar = CatalogItem(
  name: 'ProgressBar',
  dataSchema: frockSchemaOf('ProgressBar'),
  widgetBuilder: (itemContext) {
    final data = (itemContext.data as Map).cast<String, Object?>();
    final theme = Theme.of(itemContext.buildContext);
    final tone = FrockTone.read(data['tone'], fallback: FrockTone.ready);
    final colors = frockToneColorsV1(theme, tone);
    final indeterminate = frockBool(data['indeterminate']);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (data['label'] != null || data['caption'] != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: Row(
              children: [
                Expanded(
                  child: FrockBoundText(
                    dataContext: itemContext.dataContext,
                    value: data['label'],
                    maxLines: 1,
                    style: theme.textTheme.bodyMedium,
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
          ),
        ClipRRect(
          borderRadius: BorderRadius.circular(999),
          child: BoundNumber(
            dataContext: itemContext.dataContext,
            value: data['value'],
            builder: (context, value) => LinearProgressIndicator(
              // A proportion outside 0..1 is clamped rather than refused: the
              // bar is a picture of progress, and a card is not worth losing
              // over a model that counted past the end.
              value: indeterminate
                  ? null
                  : ((value ?? 0).toDouble()).clamp(0.0, 1.0),
              minHeight: 6,
              backgroundColor: theme.colorScheme.onSurface.withValues(
                alpha: 0.08,
              ),
              valueColor: AlwaysStoppedAnimation<Color>(colors.ink),
            ),
          ),
        ),
      ],
    );
  },
);

/// Rows in aligned columns.
final frockDataTable = CatalogItem(
  name: 'DataTable',
  dataSchema: frockSchemaOf('DataTable'),
  widgetBuilder: (itemContext) {
    final data = (itemContext.data as Map).cast<String, Object?>();
    final theme = Theme.of(itemContext.buildContext);
    final columns = frockRows(data['columns'], max: 5);
    final rows = frockRows(data['rows'], max: 24);
    if (columns.isEmpty) return const SizedBox.shrink();
    final weights = [
      for (final column in columns)
        frockInt(column['weight'], min: 1, max: 6, fallback: 1),
    ];
    final aligns = [
      for (final column in columns)
        frockString(column['align']) == 'end'
            ? TextAlign.right
            : TextAlign.left,
    ];

    Widget cell(int index, Widget child) =>
        Expanded(flex: weights[index], child: child);

    // The columns share the card's width rather than scrolling sideways: a
    // table inside a scrolling transcript that scrolled the other way would
    // fight the thread for every drag, and at phone width the person would
    // never find the column that was off-screen.
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        Padding(
          padding: const EdgeInsets.only(bottom: 6),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              for (var index = 0; index < columns.length; index++)
                cell(
                  index,
                  Padding(
                    padding: EdgeInsets.only(right: index == 0 ? 8 : 0),
                    child: Text(
                      frockString(columns[index]['label']) ?? '',
                      maxLines: 2,
                      textAlign: aligns[index],
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ),
        Divider(
          height: 1,
          thickness: 1,
          color: FrockTheme.hairline(theme.colorScheme),
        ),
        for (final row in rows)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 7),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (var index = 0; index < columns.length; index++)
                  cell(
                    index,
                    Padding(
                      padding: EdgeInsets.only(right: index == 0 ? 8 : 0),
                      child: FrockBoundText(
                        dataContext: itemContext.dataContext,
                        // A row shorter than the header is padded rather than
                        // refused; a longer one loses its tail. Either way the
                        // columns still line up, which is the whole point.
                        value: _cellAt(row['cells'], index),
                        maxLines: 2,
                        align: aligns[index],
                        style: theme.textTheme.bodyMedium,
                      ),
                    ),
                  ),
              ],
            ),
          ),
        if (data['caption'] != null)
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Text(
              frockString(data['caption']) ?? '',
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ),
      ],
    );
  },
);

Object? _cellAt(Object? cells, int index) {
  if (cells is! List || index >= cells.length) return '';
  return cells[index];
}

/// What happened, in order, down a rail.
final frockTimeline = CatalogItem(
  name: 'Timeline',
  dataSchema: frockSchemaOf('Timeline'),
  widgetBuilder: (itemContext) {
    final data = (itemContext.data as Map).cast<String, Object?>();
    final theme = Theme.of(itemContext.buildContext);
    final entries = frockRows(data['entries'], max: 20);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        for (var index = 0; index < entries.length; index++)
          IntrinsicHeight(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                FrockTimelineRail(
                  tone: FrockTone.read(entries[index]['tone']),
                  last: index == entries.length - 1,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Padding(
                    padding: EdgeInsets.only(
                      bottom: index == entries.length - 1 ? 0 : 12,
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Expanded(
                              child: FrockBoundText(
                                dataContext: itemContext.dataContext,
                                value: entries[index]['title'],
                                style: theme.textTheme.bodyMedium?.copyWith(
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                            ),
                            if (entries[index]['time'] != null) ...[
                              const SizedBox(width: 8),
                              Text(
                                frockString(entries[index]['time']) ?? '',
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: theme.textTheme.bodySmall?.copyWith(
                                  color: theme.colorScheme.onSurfaceVariant,
                                ),
                              ),
                            ],
                          ],
                        ),
                        if (entries[index]['detail'] != null)
                          Padding(
                            padding: const EdgeInsets.only(top: 2),
                            child: FrockBoundText(
                              dataContext: itemContext.dataContext,
                              value: entries[index]['detail'],
                              style: theme.textTheme.bodySmall?.copyWith(
                                color: theme.colorScheme.onSurfaceVariant,
                              ),
                            ),
                          ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  },
);

/// One entry's dot, and the line down to the next one.
class FrockTimelineRail extends StatelessWidget {
  final FrockTone tone;
  final bool last;
  const FrockTimelineRail({super.key, required this.tone, required this.last});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = frockToneColorsV1(theme, tone);
    return SizedBox(
      width: 12,
      child: Column(
        children: [
          Container(
            margin: const EdgeInsets.only(top: 5),
            width: 8,
            height: 8,
            decoration: BoxDecoration(
              color: colors.ink,
              shape: BoxShape.circle,
            ),
          ),
          if (!last)
            Expanded(
              child: Container(
                width: 1.5,
                margin: const EdgeInsets.symmetric(vertical: 3),
                color: FrockTheme.hairline(theme.colorScheme),
              ),
            ),
        ],
      ),
    );
  }
}

/// The family, in the order the catalog declares it.
final List<CatalogItem> frockDataItemsV1 = List.unmodifiable([
  frockMetricTile,
  frockProgressBar,
  frockDataTable,
  frockTimeline,
]);
