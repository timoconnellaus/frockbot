/// The Work log: everything one Bot did, Turn by Turn and step by step.
///
/// The conversation hides how a Bot got to its reply, and the Work view shows
/// one reply's tools. This is the rest: every model request, Jev check, tool
/// call, memory and skill read, plugin effect, Computer operation, retry and
/// compaction the durable log recorded, in the words the server wrote
/// (`app/shell/work-log.ts`).
///
/// At the desk it is the conversation column's other tab, under the Bot's
/// header: a timeline across the top, the rows as a table, and the inspector
/// beside them. On a phone it is a page of its own, and a row opens as a page.
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../client/transport.dart';
import '../shell/desktop_layout.dart';
import '../shell/semantics.dart';
import '../theme/frock_theme.dart';
import '../theme/rows.dart';
import '../theme/states.dart';
import 'inspector.dart';
import 'ledger.dart';
import 'model.dart';
import 'timeline.dart';

export 'inspector.dart' show WorkLogInspector;
export 'model.dart';
export 'timeline.dart' show WorkLogTimeMode, layoutWorkLogTimeline;

/// Where the inspector goes beside the log rather than over it.
const workLogSplitWidthV1 = 960.0;

/// The Work log as a page, pushed on a phone.
class WorkLogPage extends StatelessWidget {
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
  Widget build(BuildContext context) => Scaffold(
    appBar: DesktopHeader(
      child: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text('Work log'),
            Text(
              botName,
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ),
      ),
    ),
    body: SafeArea(
      top: false,
      child: WorkLogView(api: api, botId: botId),
    ),
  );
}

/// The Work log's body, wherever it is drawn.
class WorkLogView extends StatefulWidget {
  final NativeApi api;
  final String botId;
  const WorkLogView({super.key, required this.api, required this.botId});

  @override
  State<WorkLogView> createState() => _WorkLogViewState();
}

class _WorkLogViewState extends State<WorkLogView> {
  late WorkLogController controller;
  final search = TextEditingController();
  WorkLogFilter filter = workLogFilters.first;
  WorkLogTimeMode mode = WorkLogTimeMode.duration;
  WorkLogRow? selected;

  /// The Turns drawn open. Until the reader folds or opens one, the newest is.
  Set<String>? opened;

  @override
  void initState() {
    super.initState();
    controller = WorkLogController(widget.api, widget.botId);
    unawaited(controller.load());
    search.addListener(() => setState(() {}));
  }

  @override
  void didUpdateWidget(WorkLogView old) {
    super.didUpdateWidget(old);
    if (old.botId == widget.botId && old.api == widget.api) return;
    controller.dispose();
    controller = WorkLogController(widget.api, widget.botId);
    selected = null;
    opened = null;
    unawaited(controller.load());
  }

  @override
  void dispose() {
    controller.dispose();
    search.dispose();
    super.dispose();
  }

  bool get _filtered => search.text.trim().isNotEmpty || filter.slug != 'all';

  Set<String> get _open =>
      opened ??
      {if (controller.turns.firstOrNull case final newest?) newest.runId};

  bool _isOpen(WorkLogTurnView turn) => _filtered || _open.contains(turn.runId);

  void _toggle(WorkLogTurnView turn) => setState(() {
    final next = {..._open};
    next.contains(turn.runId) ? next.remove(turn.runId) : next.add(turn.runId);
    opened = next;
  });

  bool get _allFolded => _open.isEmpty;

  void _foldAll() => setState(() {
    opened = _allFolded
        ? {for (final turn in controller.turns) turn.runId}
        : <String>{};
  });

  bool _keep(WorkLogRow row) {
    if (!row.matches(search.text.trim().toLowerCase())) return false;
    if (filter.slug == 'errors') return row.isError;
    return filter.kinds.isEmpty || filter.kinds.contains(row.kind);
  }

  WorkLogTurnView? _turnOf(WorkLogRow row) =>
      controller.turns.where((turn) => turn.runId == row.runId).firstOrNull;

  void _select(WorkLogRow row, bool split) {
    final turn = _turnOf(row);
    if (turn == null) return;
    if (split) {
      setState(() {
        selected = row;
        // A row picked on the timeline opens the Turn it is in.
        if (!_isOpen(turn)) opened = {..._open, turn.runId};
      });
      return;
    }
    unawaited(
      Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => Scaffold(
            appBar: DesktopHeader(
              child: AppBar(
                title: Text(row.label ?? workLogKindLabel(row.kind)),
              ),
            ),
            body: SafeArea(
              top: false,
              child: WorkLogInspector(row: row, turn: turn),
            ),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: controller,
    builder: (context, _) => LayoutBuilder(
      builder: (context, constraints) {
        final scheme = Theme.of(context).colorScheme;
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
        final split = constraints.maxWidth >= workLogSplitWidthV1;
        final wide = constraints.maxWidth >= workLogTableWidthV1;
        final row = selected;
        final turn = row == null ? null : _turnOf(row);
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (wide && controller.turns.isNotEmpty) ...[
              WorkLogTimeline(
                turns: controller.turns,
                mode: mode,
                onMode: (next) => setState(() => mode = next),
                focusRunId: turn?.runId ?? controller.turns.first.runId,
                selected: row,
                onSelect: (row) => _select(row, split),
              ),
              Divider(height: 1, color: FrockTheme.hairline(scheme)),
            ],
            Expanded(
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Expanded(child: _log(context, split, wide)),
                  if (split) ...[
                    VerticalDivider(
                      width: 1,
                      color: FrockTheme.hairline(scheme),
                    ),
                    SizedBox(
                      width: 420,
                      child: ColoredBox(
                        color: scheme.surface,
                        child: row == null || turn == null
                            ? const _InspectorEmpty()
                            : WorkLogInspector(
                                key: ValueKey(row.id),
                                row: row,
                                turn: turn,
                                onClose: () => setState(() => selected = null),
                              ),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ],
        );
      },
    ),
  );

  Widget _log(BuildContext context, bool split, bool wide) {
    final theme = Theme.of(context);
    final turns = controller.turns;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _toolbar(context, wide),
        Divider(height: 1, color: FrockTheme.hairline(theme.colorScheme)),
        Expanded(
          child: RefreshIndicator(
            onRefresh: controller.load,
            child: ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.only(bottom: 40),
              children: [
                if (controller.stopError case final String message)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 10, 16, 0),
                    child: Text(
                      message,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.error,
                      ),
                    ),
                  ),
                if (turns.isEmpty)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(20, 28, 20, 0),
                    child: Text(
                      'Nothing yet. Every Turn this Bot runs shows up here, '
                      'step by step.',
                      style: theme.textTheme.bodyMedium?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                  )
                else
                  WorkLogLedger(
                    turns: turns,
                    keep: _keep,
                    filtered: _filtered,
                    isOpen: _isOpen,
                    onToggle: _toggle,
                    selected: split ? selected : null,
                    onSelect: (row) => _select(row, split),
                    stopping: controller.stopping,
                    onStop: (runId) => unawaited(controller.stop(runId)),
                  ),
                if (controller.nextCursor != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Center(
                      child: controller.loadingMore
                          ? const Padding(
                              padding: EdgeInsets.all(8),
                              child: SizedBox.square(
                                dimension: 22,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                ),
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
          ),
        ),
      ],
    );
  }

  Widget _toolbar(BuildContext context, bool wide) {
    final theme = Theme.of(context);
    final field = identified(
      WorkLogIds.search,
      TextField(
        controller: search,
        style: theme.textTheme.bodySmall,
        decoration: InputDecoration(
          isDense: true,
          hintText: 'Search this Bot’s work',
          prefixIcon: const Icon(Icons.search_rounded, size: 18),
          prefixIconConstraints: const BoxConstraints(minWidth: 36),
          suffixIcon: search.text.isEmpty
              ? null
              : IconButton(
                  tooltip: 'Clear search',
                  onPressed: search.clear,
                  icon: const Icon(Icons.close_rounded, size: 16),
                ),
        ),
      ),
    );
    final chips = [
      for (final option in workLogFilters)
        identified(
          WorkLogIds.filter(option.slug),
          _FilterPill(
            option: option,
            selected: filter == option,
            onTap: () => setState(() => filter = option),
          ),
        ),
    ];
    final fold = identified(
      WorkLogIds.foldTurns,
      OutlinedButton(
        style: frockCompactButton(context),
        onPressed: _filtered ? null : _foldAll,
        child: Text(_allFolded ? 'Open Turns' : 'Fold Turns'),
      ),
    );
    final refresh = identified(
      WorkLogIds.refresh,
      IconButton(
        tooltip: 'Refresh the Work log',
        visualDensity: VisualDensity.compact,
        onPressed: controller.loading ? null : controller.load,
        icon: const Icon(Icons.refresh_rounded, size: 18),
      ),
    );
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 10, 16, 10),
      child: wide
          ? Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(width: 220, child: field),
                const SizedBox(width: 10),
                Expanded(
                  child: Wrap(spacing: 6, runSpacing: 6, children: chips),
                ),
                const SizedBox(width: 10),
                fold,
                const SizedBox(width: 4),
                refresh,
              ],
            )
          : Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                field,
                const SizedBox(height: 10),
                SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  child: Row(
                    children: [
                      for (final chip in chips) ...[
                        chip,
                        const SizedBox(width: 6),
                      ],
                    ],
                  ),
                ),
              ],
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

/// One filter, drawn as the design's small pill: the kind's dot and its name.
class _FilterPill extends StatelessWidget {
  final WorkLogFilter option;
  final bool selected;
  final VoidCallback onTap;
  const _FilterPill({
    required this.option,
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
      label: 'Show ${option.label}',
      excludeSemantics: true,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(FrockTheme.radiusPill),
        child: Container(
          height: 30,
          padding: const EdgeInsets.symmetric(horizontal: 10),
          decoration: BoxDecoration(
            color: selected ? scheme.onSurface : Colors.transparent,
            border: Border.all(
              color: selected ? scheme.onSurface : FrockTheme.hairline(scheme),
            ),
            borderRadius: BorderRadius.circular(FrockTheme.radiusPill),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (option.kinds.isNotEmpty) ...[
                Container(
                  width: 7,
                  height: 7,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: workLogKindColor(theme, option.kinds.first),
                  ),
                ),
                const SizedBox(width: 6),
              ],
              Text(
                option.label,
                style: theme.textTheme.bodySmall?.copyWith(
                  fontSize: 12,
                  fontWeight: FontWeight.w500,
                  color: selected ? scheme.surface : scheme.onSurfaceVariant,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
