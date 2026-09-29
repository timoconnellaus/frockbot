/// The strip across the top of the Work log: every row of the Turns on the
/// page in three lanes — what came in, the model and Jev, and what the Bot
/// did — laid out by order, by how long each took, or by the clock.
library;

import 'package:flutter/material.dart';

import '../theme/frock_theme.dart';
import 'model.dart';

enum WorkLogTimeMode { sequence, duration, clock }

const workLogLaneLabels = ['Input', 'Model · Jev', 'Tools · effects'];

class WorkLogBar {
  final WorkLogRow row;
  final int lane;
  final double start;
  final double end;
  const WorkLogBar(this.row, this.lane, this.start, this.end);
}

class WorkLogMark {
  final String label;
  final double at;
  const WorkLogMark(this.label, this.at);
}

/// Where each bar and Turn mark falls, from 0 to 1. Pure, for tests.
({
  List<WorkLogBar> bars,
  List<WorkLogMark> marks,
  Map<String, (double, double)> spans,
})
layoutWorkLogTimeline(List<WorkLogTurnView> newestFirst, WorkLogTimeMode mode) {
  final turns = newestFirst.reversed.toList();
  final raw = <(WorkLogRow, double, double)>[];
  final marks = <(String, double)>[];
  final spans = <String, (double, double)>{};
  if (turns.isEmpty) return (bars: const [], marks: const [], spans: const {});

  switch (mode) {
    case WorkLogTimeMode.sequence:
      var cursor = 0.0;
      for (final turn in turns) {
        for (final row in turn.before) {
          marks.add(('compact', cursor));
          raw.add((row, cursor, cursor + 1));
          cursor += 2;
        }
        final start = cursor;
        marks.add((turn.shortLabel, cursor));
        for (final row in turn.rows) {
          raw.add((row, cursor, cursor + 0.85));
          cursor += 1;
        }
        spans[turn.runId] = (start, cursor);
        cursor += 1.5;
      }
    case WorkLogTimeMode.duration:
      // Idle time between rows and between Turns is squeezed out: each row
      // is as long as it took, with a floor so a quick check is still seen.
      final total = turns
          .expand((turn) => turn.everything)
          .fold<int>(0, (sum, row) => sum + (row.durationMs ?? 0));
      final floor = total == 0 ? 1.0 : total * 0.006;
      final gap = total == 0 ? 2.0 : total * 0.03;
      var cursor = 0.0;
      for (final turn in turns) {
        for (final row in turn.before) {
          marks.add(('compact', cursor));
          final width = ((row.durationMs ?? 0).toDouble()).clamp(
            floor,
            double.infinity,
          );
          raw.add((row, cursor, cursor + width));
          cursor += width + gap / 2;
        }
        final start = cursor;
        marks.add((turn.shortLabel, cursor));
        for (final row in turn.rows) {
          final width = ((row.durationMs ?? 0).toDouble()).clamp(
            floor,
            double.infinity,
          );
          raw.add((row, cursor, cursor + width));
          cursor += width + floor * 0.3;
        }
        spans[turn.runId] = (start, cursor);
        cursor += gap;
      }
    case WorkLogTimeMode.clock:
      final origin = turns
          .expand((turn) => turn.everything)
          .map((row) => row.at)
          .fold<DateTime?>(null, (a, b) => a == null || b.isBefore(a) ? b : a);
      if (origin == null) {
        return (bars: const [], marks: const [], spans: const {});
      }
      double at(DateTime time) =>
          time.difference(origin).inMilliseconds.toDouble();
      final last = turns
          .expand((turn) => turn.everything)
          .map((row) => at(row.end))
          .fold<double>(0, (a, b) => a > b ? a : b);
      final floor = last == 0 ? 1.0 : last * 0.003;
      for (final turn in turns) {
        for (final row in turn.before) {
          marks.add(('compact', at(row.at)));
          raw.add((
            row,
            at(row.at),
            at(row.at) + floor.clamp(at(row.end) - at(row.at), double.infinity),
          ));
        }
        final rows = turn.rows;
        final start = rows.isEmpty ? at(turn.at) : at(rows.first.at);
        marks.add((turn.shortLabel, start));
        var end = start;
        for (final row in rows) {
          final a = at(row.at);
          final b = a + (at(row.end) - a).clamp(floor, double.infinity);
          raw.add((row, a, b));
          if (b > end) end = b;
        }
        spans[turn.runId] = (start, end);
      }
  }
  final extent = [
    for (final bar in raw) bar.$3,
    for (final span in spans.values) span.$2,
  ].fold<double>(1, (a, b) => a > b ? a : b);
  double scale(double value) => (value / extent).clamp(0, 1);
  return (
    bars: [
      for (final (row, start, end) in raw)
        WorkLogBar(row, workLogLane(row.kind), scale(start), scale(end)),
    ],
    marks: [for (final (label, at) in marks) WorkLogMark(label, scale(at))],
    spans: {
      for (final entry in spans.entries)
        entry.key: (scale(entry.value.$1), scale(entry.value.$2)),
    },
  );
}

class WorkLogTimeline extends StatelessWidget {
  final List<WorkLogTurnView> turns;
  final WorkLogTimeMode mode;
  final ValueChanged<WorkLogTimeMode> onMode;
  final String? focusRunId;
  final WorkLogRow? selected;
  final ValueChanged<WorkLogRow> onSelect;
  const WorkLogTimeline({
    super.key,
    required this.turns,
    required this.mode,
    required this.onMode,
    required this.focusRunId,
    required this.selected,
    required this.onSelect,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final subtle = scheme.onSurfaceVariant;
    final layout = layoutWorkLogTimeline(turns, mode);
    return Semantics(
      label: 'Timeline of the Turns on this page',
      child: Padding(
        padding: const EdgeInsets.fromLTRB(24, 12, 24, 10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Text(
                  'Timeline',
                  style: theme.textTheme.labelMedium?.copyWith(color: subtle),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    switch (mode) {
                      WorkLogTimeMode.sequence => 'Every row the same width',
                      WorkLogTimeMode.duration => 'Idle gaps compressed',
                      WorkLogTimeMode.clock => 'As it happened, gaps and all',
                    },
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.bodySmall?.copyWith(color: subtle),
                  ),
                ),
                _ModeSwitch(mode: mode, onMode: onMode),
              ],
            ),
            const SizedBox(height: 8),
            SizedBox(
              height: 72,
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  SizedBox(
                    width: 92,
                    child: Padding(
                      padding: const EdgeInsets.only(top: 17),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          for (final label in workLogLaneLabels)
                            SizedBox(
                              height: 18,
                              child: Text(
                                label,
                                style: theme.textTheme.bodySmall?.copyWith(
                                  color: subtle,
                                  fontSize: 11,
                                ),
                              ),
                            ),
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: LayoutBuilder(
                      builder: (context, constraints) {
                        final width = constraints.maxWidth;
                        return GestureDetector(
                          behavior: HitTestBehavior.opaque,
                          onTapUp: (details) {
                            final hit = _hit(
                              layout.bars,
                              details.localPosition,
                              width,
                            );
                            if (hit != null) onSelect(hit.row);
                          },
                          child: CustomPaint(
                            size: Size(width, 72),
                            painter: _TimelinePainter(
                              bars: layout.bars,
                              marks: layout.marks,
                              focus: focusRunId == null
                                  ? null
                                  : layout.spans[focusRunId],
                              selected: selected,
                              theme: theme,
                            ),
                          ),
                        );
                      },
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

  static WorkLogBar? _hit(List<WorkLogBar> bars, Offset at, double width) {
    WorkLogBar? best;
    var distance = double.infinity;
    for (final bar in bars) {
      final top = 18.0 + bar.lane * 18;
      if (at.dy < top - 4 || at.dy > top + 16) continue;
      final left = bar.start * width;
      final right = bar.end * width;
      final gap = at.dx < left
          ? left - at.dx
          : at.dx > right
          ? at.dx - right
          : 0.0;
      if (gap < distance && gap <= 6) {
        distance = gap;
        best = bar;
      }
    }
    return best;
  }
}

class _ModeSwitch extends StatelessWidget {
  final WorkLogTimeMode mode;
  final ValueChanged<WorkLogTimeMode> onMode;
  const _ModeSwitch({required this.mode, required this.onMode});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Container(
      padding: const EdgeInsets.all(2),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(FrockTheme.radiusPill),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (final (value, label) in const [
            (WorkLogTimeMode.sequence, 'Sequence'),
            (WorkLogTimeMode.duration, 'Duration'),
            (WorkLogTimeMode.clock, 'Clock time'),
          ])
            Semantics(
              button: true,
              selected: value == mode,
              label: 'Timeline: $label',
              excludeSemantics: true,
              child: InkWell(
                borderRadius: BorderRadius.circular(FrockTheme.radiusPill),
                onTap: () => onMode(value),
                child: Container(
                  height: 26,
                  alignment: Alignment.center,
                  padding: const EdgeInsets.symmetric(horizontal: 10),
                  decoration: BoxDecoration(
                    color: value == mode
                        ? scheme.outlineVariant
                        : Colors.transparent,
                    borderRadius: BorderRadius.circular(FrockTheme.radiusPill),
                  ),
                  child: Text(
                    label,
                    style: theme.textTheme.labelSmall?.copyWith(
                      fontSize: 11.5,
                      letterSpacing: 0,
                      fontWeight: FontWeight.w500,
                      color: value == mode
                          ? scheme.onSurface
                          : scheme.onSurfaceVariant,
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

class _TimelinePainter extends CustomPainter {
  final List<WorkLogBar> bars;
  final List<WorkLogMark> marks;
  final (double, double)? focus;
  final WorkLogRow? selected;
  final ThemeData theme;
  _TimelinePainter({
    required this.bars,
    required this.marks,
    required this.focus,
    required this.selected,
    required this.theme,
  });

  @override
  void paint(Canvas canvas, Size size) {
    final scheme = theme.colorScheme;
    final accent = FrockTheme.accentInk(theme);
    if (focus case (final start, final end)) {
      final rect = Rect.fromLTRB(
        start * size.width,
        0,
        (end * size.width).clamp(start * size.width + 2, size.width),
        size.height,
      );
      canvas.drawRect(rect, Paint()..color = accent.withValues(alpha: 0.08));
      final edge = Paint()
        ..color = accent.withValues(alpha: 0.6)
        ..strokeWidth = 1;
      canvas.drawLine(rect.topLeft, rect.bottomLeft, edge);
      canvas.drawLine(rect.topRight, rect.bottomRight, edge);
    }
    final line = Paint()
      ..color = FrockTheme.hairline(scheme)
      ..strokeWidth = 1;
    var lastLabelEnd = -double.infinity;
    for (final mark in marks) {
      final x = mark.at * size.width;
      canvas.drawLine(Offset(x, 16), Offset(x, size.height), line);
      final text = TextPainter(
        text: TextSpan(
          text: mark.label,
          style: TextStyle(
            fontFamily: 'monospace',
            fontSize: 10.5,
            color: scheme.onSurfaceVariant,
          ),
        ),
        textDirection: TextDirection.ltr,
      )..layout();
      // Labels that would collide give way to the one before them.
      if (x >= lastLabelEnd + 4 && x + text.width <= size.width + 1) {
        text.paint(canvas, Offset(x, 0));
        lastLabelEnd = x + text.width;
      }
    }
    for (final bar in bars) {
      final top = 18.0 + bar.lane * 18;
      final left = bar.start * size.width;
      final right = (bar.end * size.width).clamp(left + 2, size.width);
      final rect = RRect.fromRectAndRadius(
        Rect.fromLTRB(left, top, right, top + 12),
        const Radius.circular(3),
      );
      final color = bar.row.isError
          ? scheme.error
          : workLogKindColor(theme, bar.row.kind);
      canvas.drawRRect(rect, Paint()..color = color);
      if (identical(bar.row, selected)) {
        canvas.drawRRect(
          rect.inflate(2),
          Paint()
            ..style = PaintingStyle.stroke
            ..strokeWidth = 1.5
            ..color = scheme.onSurface,
        );
      }
    }
  }

  @override
  bool shouldRepaint(_TimelinePainter old) =>
      old.bars != bars ||
      old.focus != focus ||
      old.selected != selected ||
      old.theme != theme;
}
