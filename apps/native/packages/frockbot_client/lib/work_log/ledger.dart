/// The rows of the Work log: a table where there is room for one, one row
/// per thing that happened, grouped by Turn and step; and on a phone the same
/// rows stacked, with their numbers under the words.
library;

import 'package:flutter/material.dart';

import '../shell/semantics.dart';
import '../theme/frock_theme.dart';
import '../theme/rows.dart';
import '../theme/time.dart';
import 'model.dart';

/// Where the ledger is drawn as a table rather than as stacked rows.
const workLogTableWidthV1 = 640.0;

const _numberWidth = 30.0;
const _kindWidth = 84.0;
const _inputWidth = 62.0;
const _outputWidth = 54.0;
const _timeWidth = 70.0;
const _gap = 10.0;

class WorkLogLedger extends StatelessWidget {
  final List<WorkLogTurnView> turns;
  final bool Function(WorkLogRow row) keep;
  final bool filtered;
  final bool Function(WorkLogTurnView turn) isOpen;
  final ValueChanged<WorkLogTurnView> onToggle;
  final WorkLogRow? selected;
  final ValueChanged<WorkLogRow> onSelect;
  final Set<String> stopping;
  final ValueChanged<String> onStop;
  const WorkLogLedger({
    super.key,
    required this.turns,
    required this.keep,
    required this.filtered,
    required this.isOpen,
    required this.onToggle,
    required this.selected,
    required this.onSelect,
    required this.stopping,
    required this.onStop,
  });

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) {
      final table = constraints.maxWidth >= workLogTableWidthV1;
      final children = <Widget>[if (table) const _ColumnHeads()];
      for (final turn in turns) {
        final rows = turn.rows.where(keep).toList();
        final before = turn.before.where(keep).toList();
        if (filtered && rows.isEmpty && before.isEmpty) continue;
        for (final row in before) {
          children.add(
            _BetweenTurns(
              row: row,
              selected: identical(row, selected),
              onTap: () => onSelect(row),
            ),
          );
        }
        final open = isOpen(turn);
        children.add(
          _TurnHead(
            turn: turn,
            open: open,
            table: table,
            onToggle: () => onToggle(turn),
            stopping: stopping.contains(turn.runId),
            onStop: () => onStop(turn.runId),
          ),
        );
        if (!open) continue;
        int? step;
        for (final row in rows) {
          if (row.step != null && row.step! > 0 && row.step != step) {
            step = row.step;
            children.add(
              _StepLabel(step: step!, rows: turn.rows, table: table),
            );
          }
          children.add(
            table
                ? _TableRow(
                    row: row,
                    selected: identical(row, selected),
                    onTap: () => onSelect(row),
                  )
                : _StackedRow(
                    row: row,
                    selected: identical(row, selected),
                    onTap: () => onSelect(row),
                  ),
          );
        }
        if (turn.omitted > 0) {
          children.add(
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 6, 16, 4),
              child: Text(
                '${turn.omitted} more rows are too many to show.',
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
              ),
            ),
          );
        }
        if (!filtered) children.add(_TurnFoot(turn: turn, table: table));
        children.add(const SizedBox(height: 10));
      }
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: children,
      );
    },
  );
}

TextStyle? _caps(ThemeData theme) => theme.textTheme.labelSmall?.copyWith(
  color: theme.colorScheme.onSurfaceVariant,
  fontSize: 11,
  letterSpacing: 0.5,
);

class _ColumnHeads extends StatelessWidget {
  const _ColumnHeads();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final style = _caps(theme);
    return ExcludeSemantics(
      child: Container(
        height: 30,
        padding: const EdgeInsets.symmetric(horizontal: 16),
        decoration: BoxDecoration(
          border: Border(
            bottom: BorderSide(color: FrockTheme.hairline(theme.colorScheme)),
          ),
        ),
        child: Row(
          children: [
            SizedBox(
              width: _numberWidth,
              child: Text('#', style: style),
            ),
            const SizedBox(width: _gap),
            SizedBox(
              width: _kindWidth,
              child: Text('KIND', style: style),
            ),
            const SizedBox(width: _gap),
            Expanded(child: Text('WHAT HAPPENED', style: style)),
            _cell('INPUT', _inputWidth, style),
            _cell('OUTPUT', _outputWidth, style),
            _cell('TIME', _timeWidth, style),
          ],
        ),
      ),
    );
  }
}

Widget _cell(String text, double width, TextStyle? style) => Padding(
  padding: const EdgeInsets.only(left: _gap),
  child: SizedBox(
    width: width,
    child: Text(
      text,
      textAlign: TextAlign.right,
      maxLines: 1,
      overflow: TextOverflow.clip,
      style: style,
    ),
  ),
);

class _TurnHead extends StatelessWidget {
  final WorkLogTurnView turn;
  final bool open;
  final bool table;
  final VoidCallback onToggle;
  final bool stopping;
  final VoidCallback onStop;
  const _TurnHead({
    required this.turn,
    required this.open,
    required this.table,
    required this.onToggle,
    required this.stopping,
    required this.onStop,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final muted = scheme.onSurfaceVariant;
    final figures = theme.textTheme.bodySmall?.copyWith(
      color: muted,
      fontFeatures: FrockTheme.tabularFigures,
    );
    final t = turn.totals;
    final errors = turn.errors;
    final pills = <Widget>[
      if (open || turn.status != 'completed') _StatusPill(turn: turn),
      if (!open && errors > 0)
        _Pill('$errors error${errors == 1 ? '' : 's'}', scheme.error),
      if (turn.status == 'running')
        identified(
          WorkLogIds.stop(turn.runId),
          TextButton(
            style: frockCompactButton(context),
            onPressed: stopping ? null : onStop,
            child: Text(stopping ? 'Stopping…' : 'Stop'),
          ),
        ),
    ];
    final title = Row(
      children: [
        Icon(
          open ? Icons.expand_more_rounded : Icons.chevron_right_rounded,
          size: 18,
          color: muted,
        ),
        const SizedBox(width: 8),
        Text(turn.label, style: theme.textTheme.titleSmall),
        const SizedBox(width: 10),
        Flexible(
          child: Text(
            [
              turn.via,
              clockLabel(turn.at),
              if (table && !open && turn.input.isNotEmpty) turn.input,
            ].join(' · '),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: theme.textTheme.bodySmall?.copyWith(color: muted),
          ),
        ),
        if (table) ...[
          const SizedBox(width: 10),
          if (!open) ...[
            Flexible(
              child: Text(
                turn.summary(),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: scheme.onSurfaceVariant.withValues(alpha: 0.8),
                ),
              ),
            ),
            const SizedBox(width: 8),
          ],
          for (final pill in pills) ...[pill, const SizedBox(width: 6)],
        ],
      ],
    );
    return Semantics(
      button: true,
      expanded: open,
      child: InkWell(
        onTap: onToggle,
        child: Container(
          constraints: const BoxConstraints(minHeight: 44),
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
          decoration: BoxDecoration(
            color: open ? scheme.surfaceContainerHigh : null,
            border: Border(
              bottom: BorderSide(color: FrockTheme.hairline(scheme)),
            ),
          ),
          child: table
              ? Row(
                  children: [
                    Expanded(child: title),
                    if (open) ...[
                      _cell(workLogTokens(t.inputTokens), _inputWidth, figures),
                      _cell(
                        workLogCount(t.outputTokens),
                        _outputWidth,
                        figures,
                      ),
                    ],
                    _cell(
                      turn.durationMs == null
                          ? '—'
                          : workLogDuration(turn.durationMs!),
                      _timeWidth,
                      figures,
                    ),
                  ],
                )
              : Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    title,
                    if (pills.isNotEmpty) ...[
                      const SizedBox(height: 6),
                      Wrap(spacing: 6, runSpacing: 6, children: pills),
                    ],
                    if (turn.input.isNotEmpty) ...[
                      const SizedBox(height: 4),
                      Text(
                        turn.input,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.bodyMedium,
                      ),
                    ],
                    const SizedBox(height: 4),
                    Text(
                      [
                        turn.summary(jev: false),
                        if (t.inputTokens > 0)
                          '${workLogTokens(t.inputTokens)} in · ${workLogTokens(t.outputTokens)} out',
                        if (turn.durationMs != null)
                          workLogDuration(turn.durationMs!),
                      ].join(' · '),
                      style: figures,
                    ),
                  ],
                ),
        ),
      ),
    );
  }
}

class _BetweenTurns extends StatelessWidget {
  final WorkLogRow row;
  final bool selected;
  final VoidCallback onTap;
  const _BetweenTurns({
    required this.row,
    required this.selected,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Semantics(
      button: true,
      selected: selected,
      label: 'Between Turns: ${row.title}',
      excludeSemantics: true,
      child: InkWell(
        onTap: onTap,
        child: Container(
          constraints: const BoxConstraints(minHeight: 40),
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
          decoration: BoxDecoration(
            color: selected
                ? scheme.primary.withValues(alpha: 0.14)
                : scheme.surfaceContainerLow,
            border: Border(
              bottom: BorderSide(color: FrockTheme.hairline(scheme)),
            ),
          ),
          child: Row(
            children: [
              const WorkLogTag(kind: 'compaction', text: 'BETWEEN TURNS'),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  [row.title, ?row.detail].join(' · '),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: row.isError ? scheme.error : scheme.onSurfaceVariant,
                  ),
                ),
              ),
              if (row.durationMs case final int ms)
                Text(
                  workLogDuration(ms),
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: scheme.onSurfaceVariant,
                    fontFeatures: FrockTheme.tabularFigures,
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _StepLabel extends StatelessWidget {
  final int step;
  final List<WorkLogRow> rows;
  final bool table;
  const _StepLabel({
    required this.step,
    required this.rows,
    required this.table,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.colorScheme.onSurfaceVariant;
    final inStep = rows.where((row) => row.step == step).toList();
    final start = inStep.first.at;
    final end = inStep
        .map((row) => row.end)
        .reduce((a, b) => a.isAfter(b) ? a : b);
    final span = end.difference(start).inMilliseconds;
    return Padding(
      padding: EdgeInsets.fromLTRB(
        table ? 16 + _numberWidth + _gap + _kindWidth + _gap : 16,
        10,
        16,
        4,
      ),
      child: Row(
        children: [
          Text(
            'Step $step',
            style: theme.textTheme.labelMedium?.copyWith(
              color: muted,
              fontSize: 11.5,
            ),
          ),
          if (span > 0) ...[
            const SizedBox(width: 8),
            Text(
              workLogDuration(span),
              style: theme.textTheme.bodySmall?.copyWith(
                color: muted.withValues(alpha: 0.8),
                fontSize: 11.5,
              ),
            ),
          ],
          const SizedBox(width: 10),
          Expanded(
            child: Divider(
              height: 1,
              color: FrockTheme.hairline(theme.colorScheme),
            ),
          ),
        ],
      ),
    );
  }
}

class _TableRow extends StatelessWidget {
  final WorkLogRow row;
  final bool selected;
  final VoidCallback onTap;
  const _TableRow({
    required this.row,
    required this.selected,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final muted = scheme.onSurfaceVariant;
    final figures = theme.textTheme.bodySmall?.copyWith(
      color: muted,
      fontFeatures: FrockTheme.tabularFigures,
    );
    final mono = row.kind == 'tool' || row.kind == 'plugin';
    final tokens = row.tokens;
    return _Selectable(
      row: row,
      selected: selected,
      onTap: onTap,
      child: Container(
        constraints: const BoxConstraints(minHeight: 32),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
        child: Row(
          children: [
            SizedBox(
              width: _numberWidth,
              child: Text(
                '${row.number}',
                style: figures?.copyWith(
                  fontFamily: 'monospace',
                  fontSize: 10.5,
                ),
              ),
            ),
            const SizedBox(width: _gap),
            SizedBox(
              width: _kindWidth,
              child: Align(
                alignment: Alignment.centerLeft,
                child: WorkLogTag(kind: row.kind),
              ),
            ),
            const SizedBox(width: _gap),
            Expanded(
              child: Padding(
                padding: EdgeInsets.only(
                  left: workLogIndented(row.kind) ? 18 : 0,
                ),
                child: Row(
                  children: [
                    Flexible(
                      child: Text(
                        row.title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: mono
                            ? theme.textTheme.bodySmall?.copyWith(
                                fontFamily: 'monospace',
                                color: scheme.onSurface,
                              )
                            : theme.textTheme.bodyMedium?.copyWith(
                                fontSize: 13,
                              ),
                      ),
                    ),
                    if (row.detail case final String detail) ...[
                      const SizedBox(width: 10),
                      Flexible(
                        child: Text(
                          detail,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: row.isError ? scheme.error : muted,
                          ),
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ),
            _cell(
              tokens == null ? '—' : workLogTokens(tokens.input),
              _inputWidth,
              figures,
            ),
            _cell(
              tokens == null ? '—' : workLogCount(tokens.output),
              _outputWidth,
              figures,
            ),
            _cell(
              row.durationMs == null ? '—' : workLogDuration(row.durationMs!),
              _timeWidth,
              figures,
            ),
          ],
        ),
      ),
    );
  }
}

class _StackedRow extends StatelessWidget {
  final WorkLogRow row;
  final bool selected;
  final VoidCallback onTap;
  const _StackedRow({
    required this.row,
    required this.selected,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final muted = scheme.onSurfaceVariant;
    final tokens = row.tokens;
    final metrics = [
      if (tokens != null)
        '${workLogTokens(tokens.input)} in · ${workLogTokens(tokens.output)} out',
      if (row.durationMs case final int ms) workLogDuration(ms),
    ].join(' · ');
    return _Selectable(
      row: row,
      selected: selected,
      onTap: onTap,
      child: Container(
        constraints: const BoxConstraints(minHeight: 44),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
        child: Row(
          children: [
            SizedBox(width: 78, child: WorkLogTag(kind: row.kind)),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    row.title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.bodyMedium,
                  ),
                  if (row.detail case final String detail)
                    Text(
                      detail,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: row.isError ? scheme.error : muted,
                      ),
                    ),
                  if (metrics.isNotEmpty)
                    Text(
                      metrics,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: muted,
                        fontSize: 11.5,
                        fontFeatures: FrockTheme.tabularFigures,
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

class _Selectable extends StatelessWidget {
  final WorkLogRow row;
  final bool selected;
  final VoidCallback onTap;
  final Widget child;
  const _Selectable({
    required this.row,
    required this.selected,
    required this.onTap,
    required this.child,
  });

  @override
  Widget build(BuildContext context) {
    final accent = FrockTheme.accentInk(Theme.of(context));
    return Semantics(
      button: true,
      selected: selected,
      label: '${workLogKindLabel(row.kind)}: ${row.title}',
      excludeSemantics: true,
      child: InkWell(
        onTap: onTap,
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: selected ? accent.withValues(alpha: 0.14) : null,
            border: selected
                ? Border(left: BorderSide(color: accent, width: 2))
                : null,
          ),
          child: child,
        ),
      ),
    );
  }
}

class _TurnFoot extends StatelessWidget {
  final WorkLogTurnView turn;
  final bool table;
  const _TurnFoot({required this.turn, required this.table});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final (dot, words) = _status(theme, turn);
    final t = turn.totals;
    final metrics = [
      if (t.inputTokens > 0)
        '${workLogTokens(t.inputTokens)} in · ${workLogCount(t.outputTokens)} out',
      if (turn.durationMs != null) workLogDuration(turn.durationMs!),
    ].join(' · ');
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 6, 16, 0),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerLow,
        borderRadius: BorderRadius.circular(FrockTheme.radiusRow),
      ),
      child: Row(
        children: [
          Container(
            width: 8,
            height: 8,
            decoration: BoxDecoration(color: dot, shape: BoxShape.circle),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Wrap(
              spacing: 10,
              runSpacing: 2,
              children: [
                Text(
                  turn.status == 'running'
                      ? 'Still running'
                      : 'Turn ended · $words',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: scheme.onSurface,
                    fontWeight: FontWeight.w500,
                  ),
                ),
                Text(
                  turn.summary(),
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: scheme.onSurfaceVariant,
                  ),
                ),
                if (!table)
                  Text(
                    metrics,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: scheme.onSurfaceVariant,
                      fontFeatures: FrockTheme.tabularFigures,
                    ),
                  ),
              ],
            ),
          ),
          if (table) ...[
            const SizedBox(width: 10),
            Text(
              metrics,
              style: theme.textTheme.bodySmall?.copyWith(
                color: scheme.onSurfaceVariant,
                fontFeatures: FrockTheme.tabularFigures,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

(Color, String) _status(ThemeData theme, WorkLogTurnView turn) {
  final dark = theme.brightness == Brightness.dark;
  return switch (turn.status) {
    'running' => (theme.colorScheme.primary, 'Running'),
    'failed' => (theme.colorScheme.error, turn.outcome ?? 'Failed'),
    'cancelled' => (theme.colorScheme.onSurfaceVariant, 'Stopped'),
    _ => (dark ? FrockTheme.success : FrockTheme.successInk, 'Completed'),
  };
}

class _StatusPill extends StatelessWidget {
  final WorkLogTurnView turn;
  const _StatusPill({required this.turn});

  @override
  Widget build(BuildContext context) {
    final (color, label) = _status(Theme.of(context), turn);
    return _Pill(label, color);
  }
}

class _Pill extends StatelessWidget {
  final String text;
  final Color color;
  const _Pill(this.text, this.color);

  @override
  Widget build(BuildContext context) => Container(
    constraints: const BoxConstraints(maxWidth: 200),
    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
    decoration: BoxDecoration(
      color: color.withValues(alpha: 0.16),
      borderRadius: BorderRadius.circular(FrockTheme.radiusPill),
    ),
    child: Text(
      text,
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: Theme.of(context).textTheme.labelSmall
          ?.copyWith(color: color, letterSpacing: 0),
    ),
  );
}

/// A row's kind, as a small monospaced tag in its colour.
class WorkLogTag extends StatelessWidget {
  final String kind;

  /// Words other than the kind's own name.
  final String? text;
  const WorkLogTag({super.key, required this.kind, this.text});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final color = workLogKindColor(theme, kind);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(4),
      ),
      child: Text(
        text ?? workLogKindLabel(kind).toUpperCase(),
        style: theme.textTheme.labelSmall?.copyWith(
          color: color,
          fontFamily: 'monospace',
          fontSize: 10,
          letterSpacing: 0.5,
          fontWeight: FontWeight.w500,
        ),
      ),
    );
  }
}
