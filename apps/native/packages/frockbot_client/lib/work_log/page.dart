/// The Work log: everything one Bot did, Turn by Turn and step by step.
///
/// The conversation hides how a Bot got to its reply, and the Work view shows
/// one reply's tools. This is the rest: every model request, Jev check, tool
/// call, memory and skill read, plugin effect, Computer operation, retry and
/// compaction the durable log recorded, in the words the server wrote
/// (`app/shell/work-log.ts`). Rows open an inspector beside the log when there
/// is room for one, and as a page of their own when there is not.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../client/transport.dart';
import '../protocol/client_wire.generated.dart' as wire;
import '../shell/desktop_layout.dart';
import '../shell/semantics.dart';
import '../theme/frock_theme.dart';
import '../theme/rows.dart';
import '../theme/states.dart';
import '../theme/time.dart';

String workLogPathV1(String botId, {String? before}) {
  final path = '/api/bots/${Uri.encodeComponent(botId)}/work-log';
  return before == null
      ? path
      : '$path?before=${Uri.encodeQueryComponent(before)}';
}

/// One row, read out of its wire form once rather than on every paint.
class WorkLogRow {
  final String id;
  final int turn;
  final DateTime at;
  final String kind;
  final int? step;
  final String title;
  final String? detail;
  final int? durationMs;
  final bool isError;
  final wire.WorkLogTokens? tokens;
  final List<wire.WorkLogField> fields;
  final List<wire.WorkLogSection> sections;
  final String _haystack;

  WorkLogRow._({
    required this.id,
    required this.turn,
    required this.at,
    required this.kind,
    required this.step,
    required this.title,
    required this.detail,
    required this.durationMs,
    required this.isError,
    required this.tokens,
    required this.fields,
    required this.sections,
  }) : _haystack = [
         title,
         detail ?? '',
         for (final field in fields) '${field.label} ${field.value}',
         for (final section in sections) section.text,
       ].join('\n').toLowerCase();

  factory WorkLogRow.fromWire(String runId, int turn, wire.WorkLogEntry entry) {
    return WorkLogRow._(
      id: '$runId:${entry.seq}',
      turn: turn,
      at: DateTime.parse(entry.at.value).toLocal(),
      kind: entry.kind,
      step: entry.step,
      title: entry.title,
      detail: entry.detail,
      durationMs: entry.durationMs,
      isError: entry.isError ?? false,
      tokens: entry.tokens,
      fields: entry.fields ?? const [],
      sections: entry.sections ?? const [],
    );
  }

  bool matches(String query) => query.isEmpty || _haystack.contains(query);
}

/// One Turn, with its rows.
class WorkLogTurnView {
  final String runId;
  final int? turn;
  final DateTime at;
  final String status;
  final String via;
  final String input;
  final int? durationMs;
  final String? outcome;
  final wire.WorkLogTotals totals;
  final List<WorkLogRow> rows;
  final int omitted;

  WorkLogTurnView._({
    required this.runId,
    required this.turn,
    required this.at,
    required this.status,
    required this.via,
    required this.input,
    required this.durationMs,
    required this.outcome,
    required this.totals,
    required this.rows,
    required this.omitted,
  });

  factory WorkLogTurnView.fromWire(wire.WorkLogTurn turn) => WorkLogTurnView._(
    runId: turn.runId,
    turn: turn.turn,
    at: DateTime.parse(turn.at.value).toLocal(),
    status: turn.status,
    via: turn.via,
    input: turn.input,
    durationMs: turn.durationMs,
    outcome: turn.outcome,
    totals: turn.totals,
    rows: [
      for (final entry in turn.entries)
        WorkLogRow.fromWire(turn.runId, turn.turn ?? 0, entry),
    ],
    omitted: turn.omittedEntries ?? 0,
  );

  String get label => turn == null ? 'Turn' : 'Turn $turn';
}

/// The filters over row kinds. `All` is the absence of one.
class WorkLogFilter {
  final String slug;
  final String label;
  final Set<String> kinds;
  const WorkLogFilter(this.slug, this.label, this.kinds);
}

const workLogFilters = [
  WorkLogFilter('all', 'All', {}),
  WorkLogFilter('model', 'Model', {'model'}),
  WorkLogFilter('tools', 'Tools', {'tool'}),
  WorkLogFilter('jev', 'Jev', {'jev'}),
  WorkLogFilter('memory', 'Memory & skills', {'memory', 'skill'}),
  WorkLogFilter('plugins', 'Plugins', {'plugin'}),
  WorkLogFilter('computer', 'Computer', {'computer'}),
  WorkLogFilter('recovery', 'Recovery', {'retry', 'compaction'}),
  WorkLogFilter('errors', 'Errors', {}),
];

class WorkLogController extends ChangeNotifier {
  final NativeApi api;
  final String botId;
  WorkLogController(this.api, this.botId);

  List<WorkLogTurnView> turns = const [];
  String? nextCursor;
  bool loaded = false;
  bool loading = false;
  bool loadingMore = false;
  String? error;
  String? moreError;
  bool _closed = false;
  int _request = 0;

  void _changed() {
    if (!_closed) notifyListeners();
  }

  Future<void> load() async {
    final request = ++_request;
    loading = true;
    error = null;
    _changed();
    try {
      final page = wire.WorkLogPage.fromJson(
        await api.request(workLogPathV1(botId)),
      );
      if (request != _request) return;
      turns = page.turns.map(WorkLogTurnView.fromWire).toList();
      nextCursor = page.nextCursor;
      loaded = true;
    } catch (_) {
      if (request != _request) return;
      error =
          'Couldn’t load the Work log. Check your connection and try again.';
    } finally {
      if (request == _request) {
        loading = false;
        _changed();
      }
    }
  }

  Future<void> more() async {
    final cursor = nextCursor;
    if (cursor == null || loading || loadingMore) return;
    final request = _request;
    loadingMore = true;
    moreError = null;
    _changed();
    try {
      final page = wire.WorkLogPage.fromJson(
        await api.request(workLogPathV1(botId, before: cursor)),
      );
      if (request != _request) return;
      turns = [...turns, ...page.turns.map(WorkLogTurnView.fromWire)];
      nextCursor = page.nextCursor;
    } catch (_) {
      if (request != _request) return;
      moreError = 'Couldn’t load earlier Turns.';
    } finally {
      loadingMore = false;
      _changed();
    }
  }

  @override
  void dispose() {
    _closed = true;
    super.dispose();
  }
}

/// Where the inspector goes beside the log rather than over it.
const workLogSplitWidthV1 = 960.0;

class WorkLogPage extends StatefulWidget {
  final NativeApi api;
  final String botId;
  final String botName;
  const WorkLogPage({
    super.key,
    required this.api,
    required this.botId,
    required this.botName,
  });

  @override
  State<WorkLogPage> createState() => _WorkLogPageState();
}

class _WorkLogPageState extends State<WorkLogPage> {
  late final WorkLogController controller = WorkLogController(
    widget.api,
    widget.botId,
  );
  final search = TextEditingController();
  WorkLogFilter filter = workLogFilters.first;
  WorkLogRow? selected;
  final collapsed = <String>{};
  final expanded = <String>{};

  @override
  void initState() {
    super.initState();
    unawaited(controller.load());
    search.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    controller.dispose();
    search.dispose();
    super.dispose();
  }

  bool _open(WorkLogTurnView turn, int index) =>
      search.text.isNotEmpty ||
      filter.slug != 'all' ||
      (index == 0
          ? !collapsed.contains(turn.runId)
          : expanded.contains(turn.runId));

  void _toggle(WorkLogTurnView turn, int index) => setState(() {
    if (index == 0) {
      collapsed.contains(turn.runId)
          ? collapsed.remove(turn.runId)
          : collapsed.add(turn.runId);
    } else {
      expanded.contains(turn.runId)
          ? expanded.remove(turn.runId)
          : expanded.add(turn.runId);
    }
  });

  bool _keep(WorkLogRow row) {
    if (!row.matches(search.text.trim().toLowerCase())) return false;
    if (filter.slug == 'errors') return row.isError;
    return filter.kinds.isEmpty || filter.kinds.contains(row.kind);
  }

  void _select(WorkLogRow row, WorkLogTurnView turn, bool split) {
    if (split) {
      setState(() => selected = row);
      return;
    }
    unawaited(
      Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => Scaffold(
            appBar: DesktopHeader(
              child: AppBar(title: Text(workLogKindLabel(row.kind))),
            ),
            body: SafeArea(
              top: false,
              child: WorkLogInspector(row: row, turnLabel: turn.label),
            ),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: DesktopHeader(
      child: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text('Work log'),
            Text(
              widget.botName,
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ),
        actions: [
          ListenableBuilder(
            listenable: controller,
            builder: (context, _) => identified(
              WorkLogIds.refresh,
              IconButton(
                tooltip: 'Refresh the Work log',
                onPressed: controller.loading ? null : controller.load,
                icon: const Icon(Icons.refresh_rounded),
              ),
            ),
          ),
        ],
      ),
    ),
    body: SafeArea(
      top: false,
      child: ListenableBuilder(
        listenable: controller,
        builder: (context, _) => LayoutBuilder(
          builder: (context, constraints) {
            final split = constraints.maxWidth >= workLogSplitWidthV1;
            final log = _log(context, split);
            if (!split) return log;
            final row = selected;
            final turn = row == null
                ? null
                : controller.turns
                      .where((turn) => turn.rows.contains(row))
                      .firstOrNull;
            return Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Expanded(child: log),
                VerticalDivider(
                  width: 1,
                  color: FrockTheme.hairline(Theme.of(context).colorScheme),
                ),
                SizedBox(
                  width: 420,
                  child: row == null || turn == null
                      ? const _InspectorEmpty()
                      : WorkLogInspector(
                          key: ValueKey(row.id),
                          row: row,
                          turnLabel: turn.label,
                          onClose: () => setState(() => selected = null),
                        ),
                ),
              ],
            );
          },
        ),
      ),
    ),
  );

  Widget _log(BuildContext context, bool split) {
    final theme = Theme.of(context);
    if (!controller.loaded && controller.error != null) {
      return FrockEmptyState(
        icon: Icons.cloud_off_rounded,
        title: 'The Work log couldn’t load',
        detail: controller.error!,
        action: 'Try again',
        onAction: controller.load,
      );
    }
    if (!controller.loaded) {
      return const FrockLoading(label: 'Loading the Work log');
    }
    final turns = controller.turns;
    return RefreshIndicator(
      onRefresh: controller.load,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 40),
        children: [
          _toolbar(context),
          const SizedBox(height: 12),
          if (turns.isEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(4, 24, 4, 0),
              child: Text(
                'Nothing yet. Every Turn this Bot runs shows up here, step '
                'by step.',
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ),
          for (final (index, turn) in turns.indexed) ...[
            _TurnCard(
              turn: turn,
              open: _open(turn, index),
              onToggle: () => _toggle(turn, index),
              rows: turn.rows.where(_keep).toList(),
              filtered: search.text.isNotEmpty || filter.slug != 'all',
              selected: split ? selected : null,
              onSelect: (row) => _select(row, turn, split),
            ),
            const SizedBox(height: 10),
          ],
          if (controller.nextCursor != null)
            Center(
              child: controller.loadingMore
                  ? const Padding(
                      padding: EdgeInsets.all(8),
                      child: SizedBox.square(
                        dimension: 22,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      ),
                    )
                  : identified(
                      WorkLogIds.showEarlier,
                      OutlinedButton(
                        style: frockCompactButton(context),
                        onPressed: controller.more,
                        child: const Text('Show earlier Turns'),
                      ),
                    ),
            ),
          if (controller.moreError case final String message)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(
                message,
                textAlign: TextAlign.center,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.error,
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _toolbar(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        identified(
          WorkLogIds.search,
          TextField(
            controller: search,
            decoration: InputDecoration(
              isDense: true,
              hintText: 'Search this Bot’s work',
              prefixIcon: const Icon(Icons.search_rounded, size: 20),
              suffixIcon: search.text.isEmpty
                  ? null
                  : IconButton(
                      tooltip: 'Clear search',
                      onPressed: search.clear,
                      icon: const Icon(Icons.close_rounded, size: 18),
                    ),
            ),
          ),
        ),
        const SizedBox(height: 10),
        Wrap(
          spacing: 6,
          runSpacing: 6,
          children: [
            for (final option in workLogFilters)
              identified(
                WorkLogIds.filter(option.slug),
                ChoiceChip(
                  label: Text(option.label),
                  selected: filter == option,
                  onSelected: (_) => setState(() => filter = option),
                  avatar: option.kinds.isEmpty
                      ? null
                      : CircleAvatar(
                          radius: 4,
                          backgroundColor: workLogKindColor(
                            theme,
                            option.kinds.first,
                          ),
                        ),
                  visualDensity: VisualDensity.compact,
                ),
              ),
          ],
        ),
      ],
    );
  }
}

class _TurnCard extends StatelessWidget {
  final WorkLogTurnView turn;
  final bool open;
  final bool filtered;
  final VoidCallback onToggle;
  final List<WorkLogRow> rows;
  final WorkLogRow? selected;
  final void Function(WorkLogRow row) onSelect;
  const _TurnCard({
    required this.turn,
    required this.open,
    required this.filtered,
    required this.onToggle,
    required this.rows,
    required this.selected,
    required this.onSelect,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final muted = scheme.onSurfaceVariant;
    final totals = turn.totals;
    final summary = [
      '${totals.steps} step${totals.steps == 1 ? '' : 's'}',
      if (totals.toolCalls > 0)
        '${totals.toolCalls} tool call${totals.toolCalls == 1 ? '' : 's'}',
      if (totals.jevChecks > 0)
        '${totals.jevChecks} Jev check${totals.jevChecks == 1 ? '' : 's'}',
      if (totals.retries > 0)
        '${totals.retries} retr${totals.retries == 1 ? 'y' : 'ies'}',
      if (totals.inputTokens > 0)
        '${workLogTokens(totals.inputTokens)} in · ${workLogTokens(totals.outputTokens)} out',
      if (totals.computerMs > 0)
        'Computer ${workLogDuration(totals.computerMs)}',
      ?switch (turn.durationMs) {
        final int ms => workLogDuration(ms),
        null => null,
      },
    ].join(' · ');
    if (filtered && rows.isEmpty) return const SizedBox.shrink();
    return DecoratedBox(
      decoration: BoxDecoration(
        color: scheme.surfaceContainerLow,
        borderRadius: BorderRadius.circular(FrockTheme.radiusCard),
        border: Border.all(color: FrockTheme.hairline(scheme)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          InkWell(
            borderRadius: BorderRadius.circular(FrockTheme.radiusCard),
            onTap: onToggle,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(14, 12, 12, 12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Row(
                    children: [
                      Icon(
                        open
                            ? Icons.expand_more_rounded
                            : Icons.chevron_right_rounded,
                        size: 20,
                        color: muted,
                      ),
                      const SizedBox(width: 6),
                      Text(turn.label, style: theme.textTheme.titleSmall),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          '${turn.via} · ${clockLabel(turn.at)}',
                          overflow: TextOverflow.ellipsis,
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: muted,
                          ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      _StatusPill(status: turn.status, outcome: turn.outcome),
                    ],
                  ),
                  if (turn.input.isNotEmpty) ...[
                    const SizedBox(height: 6),
                    Text(
                      turn.input,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.bodyMedium,
                    ),
                  ],
                  const SizedBox(height: 6),
                  Text(
                    summary,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: muted,
                      fontFeatures: FrockTheme.tabularFigures,
                    ),
                  ),
                  const SizedBox(height: 8),
                  _TurnStrip(rows: turn.rows),
                ],
              ),
            ),
          ),
          if (open) ...[
            Divider(height: 1, color: FrockTheme.hairline(scheme)),
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  for (final (index, row) in rows.indexed) ...[
                    if (row.step != null &&
                        (index == 0 || rows[index - 1].step != row.step) &&
                        row.step! > 0)
                      _StepLabel(step: row.step!, rows: turn.rows),
                    _RowView(
                      row: row,
                      selected: identical(row, selected),
                      onTap: () => onSelect(row),
                    ),
                  ],
                  if (rows.isEmpty)
                    Padding(
                      padding: const EdgeInsets.all(14),
                      child: Text(
                        'Nothing recorded for this Turn.',
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: muted,
                        ),
                      ),
                    ),
                  if (turn.omitted > 0)
                    Padding(
                      padding: const EdgeInsets.fromLTRB(14, 6, 14, 8),
                      child: Text(
                        '${turn.omitted} more rows are too many to show.',
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: muted,
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// A Turn at a glance: one segment per row that took time, coloured by kind.
class _TurnStrip extends StatelessWidget {
  final List<WorkLogRow> rows;
  const _TurnStrip({required this.rows});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final timed = rows.where((row) => (row.durationMs ?? 0) > 0).toList();
    if (timed.isEmpty) return const SizedBox.shrink();
    return ExcludeSemantics(
      child: ClipRRect(
        borderRadius: BorderRadius.circular(FrockTheme.radiusPill),
        child: SizedBox(
          height: 6,
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              for (final row in timed)
                Expanded(
                  // A floor, so a Jev check beside a long model call is seen.
                  flex: (row.durationMs! ~/ 50).clamp(4, 100000),
                  child: Padding(
                    padding: const EdgeInsets.only(right: 1),
                    child: ColoredBox(
                      color: row.isError
                          ? theme.colorScheme.error
                          : workLogKindColor(theme, row.kind),
                    ),
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
  const _StepLabel({required this.step, required this.rows});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final inStep = rows.where((row) => row.step == step).toList();
    final start = inStep.first.at;
    final end = inStep
        .map((row) => row.at.add(Duration(milliseconds: row.durationMs ?? 0)))
        .reduce((a, b) => a.isAfter(b) ? a : b);
    final span = end.difference(start).inMilliseconds;
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 10, 14, 2),
      child: Row(
        children: [
          Text(
            'Step $step',
            style: theme.textTheme.labelMedium?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
          if (span > 0) ...[
            const SizedBox(width: 6),
            Text(
              workLogDuration(span),
              style: theme.textTheme.labelSmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
                fontWeight: FontWeight.w400,
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

class _RowView extends StatelessWidget {
  final WorkLogRow row;
  final bool selected;
  final VoidCallback onTap;
  const _RowView({
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
    final trailing = [
      if (tokens != null)
        '${workLogTokens(tokens.input)} in · ${workLogTokens(tokens.output)} out',
      ?switch (row.durationMs) {
        final int ms => workLogDuration(ms),
        null => null,
      },
    ].join(' · ');
    return Semantics(
      button: true,
      selected: selected,
      label: '${workLogKindLabel(row.kind)}: ${row.title}',
      excludeSemantics: true,
      child: InkWell(
        onTap: onTap,
        child: Container(
          constraints: const BoxConstraints(minHeight: 44),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
          color: selected ? scheme.primary.withValues(alpha: 0.14) : null,
          child: LayoutBuilder(
            builder: (context, constraints) {
              // Beside the title when there is room; under it on a phone.
              final compact = constraints.maxWidth < 520;
              final metrics = Text(
                trailing,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: muted,
                  fontFeatures: FrockTheme.tabularFigures,
                ),
              );
              return Row(
                children: [
                  SizedBox(
                    width: compact ? 76 : 84,
                    child: WorkLogKindTag(kind: row.kind),
                  ),
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
                        if (compact && trailing.isNotEmpty) metrics,
                      ],
                    ),
                  ),
                  if (!compact && trailing.isNotEmpty) ...[
                    const SizedBox(width: 10),
                    metrics,
                  ],
                ],
              );
            },
          ),
        ),
      ),
    );
  }
}

class _StatusPill extends StatelessWidget {
  final String status;
  final String? outcome;
  const _StatusPill({required this.status, this.outcome});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final dark = theme.brightness == Brightness.dark;
    final (label, color) = switch (status) {
      'running' => ('Running', theme.colorScheme.primary),
      'failed' => (outcome ?? 'Failed', theme.colorScheme.error),
      'cancelled' => ('Stopped', theme.colorScheme.onSurfaceVariant),
      _ => ('Completed', dark ? FrockTheme.success : FrockTheme.successInk),
    };
    return Container(
      constraints: const BoxConstraints(maxWidth: 180),
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.16),
        borderRadius: BorderRadius.circular(FrockTheme.radiusPill),
      ),
      child: Text(
        label,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: theme.textTheme.labelSmall?.copyWith(color: color),
      ),
    );
  }
}

class _InspectorEmpty extends StatelessWidget {
  const _InspectorEmpty();

  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(32),
      child: Text(
        'Pick a row to see it in full.',
        textAlign: TextAlign.center,
        style: Theme.of(context).textTheme.bodyMedium
            ?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant),
      ),
    ),
  );
}

/// One row in full: what it was, how long it took, what it used, and every
/// section the server kept of it.
class WorkLogInspector extends StatelessWidget {
  final WorkLogRow row;
  final String turnLabel;
  final VoidCallback? onClose;
  const WorkLogInspector({
    super.key,
    required this.row,
    required this.turnLabel,
    this.onClose,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final muted = scheme.onSurfaceVariant;
    final tokens = row.tokens;
    return identified(
      WorkLogIds.inspector,
      ListView(
        padding: const EdgeInsets.fromLTRB(18, 16, 18, 32),
        children: [
          Row(
            children: [
              WorkLogKindTag(kind: row.kind),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  [
                    turnLabel,
                    if (row.step case final int step when step > 0)
                      'Step $step',
                    clockLabel(row.at),
                  ].join(' › '),
                  style: theme.textTheme.bodySmall?.copyWith(color: muted),
                ),
              ),
              if (onClose != null)
                IconButton(
                  tooltip: 'Close',
                  onPressed: onClose,
                  icon: const Icon(Icons.close_rounded, size: 18),
                ),
            ],
          ),
          const SizedBox(height: 10),
          SelectableText(row.title, style: theme.textTheme.titleMedium),
          if (row.detail case final String detail) ...[
            const SizedBox(height: 4),
            Text(
              detail,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: row.isError ? scheme.error : muted,
              ),
            ),
          ],
          if (row.durationMs != null || tokens != null) ...[
            const SizedBox(height: 16),
            Wrap(
              spacing: 18,
              runSpacing: 10,
              children: [
                if (row.durationMs case final int ms)
                  _Stat(label: 'Took', value: workLogDuration(ms)),
                if (tokens != null) ...[
                  _Stat(label: 'Input', value: workLogTokens(tokens.input)),
                  if (tokens.cachedInput > 0)
                    _Stat(
                      label: 'Cached',
                      value: workLogTokens(tokens.cachedInput),
                    ),
                  _Stat(label: 'Output', value: workLogTokens(tokens.output)),
                  if (tokens.reasoning > 0)
                    _Stat(
                      label: 'Reasoning',
                      value: workLogTokens(tokens.reasoning),
                    ),
                ],
              ],
            ),
          ],
          if (row.fields.isNotEmpty) ...[
            const SizedBox(height: 18),
            for (final field in row.fields)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    SizedBox(
                      width: 116,
                      child: Text(
                        field.label,
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: muted,
                        ),
                      ),
                    ),
                    Expanded(
                      child: SelectableText(
                        field.value,
                        style: theme.textTheme.bodySmall,
                      ),
                    ),
                  ],
                ),
              ),
          ],
          for (final section in row.sections) ...[
            const SizedBox(height: 14),
            Row(
              children: [
                Expanded(
                  child: FrockSectionLabel(
                    section.label,
                    padding: EdgeInsets.zero,
                  ),
                ),
                IconButton(
                  tooltip: 'Copy ${section.label.toLowerCase()}',
                  visualDensity: VisualDensity.compact,
                  onPressed: () =>
                      Clipboard.setData(ClipboardData(text: section.text)),
                  icon: const Icon(Icons.copy_rounded, size: 16),
                ),
              ],
            ),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: scheme.surfaceContainerHigh,
                borderRadius: BorderRadius.circular(FrockTheme.radiusControl),
              ),
              child: SelectableText(
                section.text,
                style: section.mono == true
                    ? theme.textTheme.bodySmall?.copyWith(
                        fontFamily: 'monospace',
                        height: 1.5,
                      )
                    : theme.textTheme.bodyMedium?.copyWith(height: 1.5),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _Stat extends StatelessWidget {
  final String label;
  final String value;
  const _Stat({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          label,
          style: theme.textTheme.bodySmall?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
        Text(
          value,
          style: theme.textTheme.titleSmall?.copyWith(
            fontFeatures: FrockTheme.tabularFigures,
          ),
        ),
      ],
    );
  }
}

class WorkLogKindTag extends StatelessWidget {
  final String kind;
  const WorkLogKindTag({super.key, required this.kind});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final color = workLogKindColor(theme, kind);
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.14),
          borderRadius: BorderRadius.circular(4),
        ),
        child: Text(
          workLogKindLabel(kind).toUpperCase(),
          style: theme.textTheme.labelSmall?.copyWith(
            color: color,
            fontFamily: 'monospace',
            fontSize: 10,
          ),
        ),
      ),
    );
  }
}

String workLogKindLabel(String kind) => switch (kind) {
  'input' => 'Input',
  'model' => 'Model',
  'jev' => 'Jev',
  'tool' => 'Tool',
  'memory' => 'Memory',
  'skill' => 'Skill',
  'plugin' => 'Plugin',
  'computer' => 'Computer',
  'retry' => 'Retry',
  'compaction' => 'Compact',
  'send' => 'Sent',
  'task' => 'Task',
  _ => 'System',
};

/// Each kind's colour, from the flock, with a darker twin that carries on
/// paper. Kinds that sit side by side differ in lightness as well as hue.
Color workLogKindColor(ThemeData theme, String kind) {
  final dark = theme.brightness == Brightness.dark;
  Color pick(int onInk, int onPaper) => Color(dark ? onInk : onPaper);
  return switch (kind) {
    'input' => pick(0xff58c98b, 0xff1c7a4e),
    'model' => pick(0xfffc85ae, 0xffb3245f),
    'jev' => pick(0xff59c7ff, 0xff0b6fa4),
    'tool' => pick(0xffffc928, 0xff8a6000),
    'memory' || 'skill' => pick(0xffb8a6f0, 0xff6a4fc4),
    'plugin' => pick(0xffff8b27, 0xffa04e00),
    'computer' => pick(0xff7fd8c4, 0xff1f7a68),
    'task' => pick(0xffef6b4a, 0xffb03d20),
    'send' => theme.colorScheme.onSurface,
    _ => theme.colorScheme.onSurfaceVariant,
  };
}

String workLogDuration(int ms) {
  if (ms < 1000) return '$ms ms';
  if (ms < 60000) return '${(ms / 1000).toStringAsFixed(1)} s';
  final minutes = ms ~/ 60000;
  final seconds = (ms % 60000) ~/ 1000;
  return seconds == 0 ? '$minutes m' : '$minutes m $seconds s';
}

String workLogTokens(int count) {
  if (count < 1000) return '$count';
  if (count < 1000000) return '${(count / 1000).toStringAsFixed(1)}k';
  return '${(count / 1000000).toStringAsFixed(2)}M';
}
