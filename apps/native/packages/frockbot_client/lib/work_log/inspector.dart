/// One row of the Work log in full: what it was, how it got there, what it
/// used and how long it took, with every section the server kept of it on the
/// tab it belongs to, and the entry itself on Raw.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../protocol/client_wire.generated.dart' as wire;
import '../shell/semantics.dart';
import '../theme/frock_theme.dart';
import '../theme/rows.dart';
import 'ledger.dart';
import 'model.dart';

const _tabLabels = {
  'summary': 'Summary',
  'prompt': 'Prompt',
  'output': 'Output',
  'tools': 'Tools',
  'input': 'Input',
  'result': 'Result',
  'raw': 'Raw',
};

class WorkLogInspector extends StatefulWidget {
  final WorkLogRow row;
  final WorkLogTurnView turn;
  final VoidCallback? onClose;
  const WorkLogInspector({
    super.key,
    required this.row,
    required this.turn,
    this.onClose,
  });

  @override
  State<WorkLogInspector> createState() => _WorkLogInspectorState();
}

class _WorkLogInspectorState extends State<WorkLogInspector> {
  String tab = 'summary';

  List<String> get _tabs => [
    'summary',
    for (final name in const ['prompt', 'output', 'tools', 'input', 'result'])
      if (widget.row.onTab(name).isNotEmpty) name,
    'raw',
  ];

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final row = widget.row;
    final tabs = _tabs;
    final shown = tabs.contains(tab) ? tab : 'summary';
    return identified(
      WorkLogIds.inspector,
      Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(18, 14, 8, 10),
            child: Row(
              children: [
                WorkLogTag(kind: row.kind),
                const SizedBox(width: 10),
                Flexible(
                  child: Text(
                    row.label ?? workLogKindLabel(row.kind),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.titleSmall,
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    [
                      widget.turn.label,
                      if (row.step case final int step when step > 0)
                        'Step $step',
                    ].join(' › '),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: scheme.onSurfaceVariant,
                    ),
                  ),
                ),
                if (widget.onClose != null)
                  IconButton(
                    tooltip: 'Close',
                    onPressed: widget.onClose,
                    icon: const Icon(Icons.close_rounded, size: 18),
                  ),
              ],
            ),
          ),
          DecoratedBox(
            decoration: BoxDecoration(
              border: Border(
                bottom: BorderSide(color: FrockTheme.hairline(scheme)),
              ),
            ),
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 12),
              child: Row(
                children: [
                  for (final name in tabs)
                    _Tab(
                      label: _tabLabels[name]!,
                      selected: name == shown,
                      onTap: () => setState(() => tab = name),
                    ),
                ],
              ),
            ),
          ),
          Expanded(
            child: ListView(
              padding: const EdgeInsets.fromLTRB(18, 16, 18, 32),
              children: switch (shown) {
                'summary' => _summary(context),
                'raw' => [
                  _Block(
                    label: 'The entry as the server sent it',
                    text: row.raw,
                    mono: true,
                  ),
                ],
                _ => [
                  for (final section in row.onTab(shown))
                    _Block(
                      label: section.label,
                      text: section.text,
                      mono: section.mono ?? false,
                    ),
                ],
              },
            ),
          ),
        ],
      ),
    );
  }

  List<Widget> _summary(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final muted = scheme.onSurfaceVariant;
    final row = widget.row;
    final turn = widget.turn;
    final retries = _retriesBefore(row, turn);
    final status = row.isError
        ? 'Failed'
        : retries.isEmpty
        ? 'Completed'
        : 'Completed after ${retries.length} retr${retries.length == 1 ? 'y' : 'ies'}';
    return [
      SelectableText(row.title, style: theme.textTheme.titleSmall),
      if (row.detail case final String detail) ...[
        const SizedBox(height: 4),
        Text(
          detail,
          style: theme.textTheme.bodySmall?.copyWith(
            color: row.isError ? scheme.error : muted,
          ),
        ),
      ],
      if (row.kind == 'jev' && row.verdict != null) ...[
        const SizedBox(height: 14),
        _Verdict(row: row),
      ],
      const SizedBox(height: 16),
      _Facts(
        facts: [
          if (row.kind != 'jev') ('Status', status),
          for (final field in row.fields) (field.label, field.value),
        ],
        statusError: row.isError,
      ),
      if (row.chain.isNotEmpty) ...[
        const SizedBox(height: 18),
        const FrockSectionLabel('How it got to run', padding: EdgeInsets.zero),
        const SizedBox(height: 10),
        _Chain(links: row.chain),
      ],
      if (row.tokens case final wire.WorkLogTokens tokens) ...[
        const SizedBox(height: 18),
        _Tokens(tokens: tokens, turn: turn),
      ],
      if (row.durationMs case final int ms) ...[
        const SizedBox(height: 18),
        _Timing(row: row, ms: ms, retries: retries),
      ],
      if (row.kind == 'jev') ...[
        const SizedBox(height: 18),
        const FrockSectionLabel('Jev this Turn', padding: EdgeInsets.zero),
        const SizedBox(height: 8),
        Wrap(
          spacing: 6,
          runSpacing: 6,
          children: [
            for (final check in turn.rows.where((r) => r.kind == 'jev'))
              _Chip(
                [
                  check.label ?? check.title,
                  if (check.durationMs case final int ms) workLogDuration(ms),
                ].join(' · '),
                highlighted: identical(check, row),
              ),
          ],
        ),
      ],
      for (final section in row.onTab('summary'))
        _Block(
          label: section.label,
          text: section.text,
          mono: section.mono ?? false,
        ),
      const SizedBox(height: 18),
      Row(
        children: [
          OutlinedButton(
            style: frockCompactButton(context),
            onPressed: () => Clipboard.setData(ClipboardData(text: row.raw)),
            child: const Text('Copy entry JSON'),
          ),
        ],
      ),
    ];
  }

  /// The retries in the same step just before a model request: the wait it
  /// spent before it was answered.
  static List<WorkLogRow> _retriesBefore(WorkLogRow row, WorkLogTurnView turn) {
    if (row.kind != 'model') return const [];
    final index = turn.rows.indexOf(row);
    final found = <WorkLogRow>[];
    for (var i = index - 1; i >= 0; i--) {
      final earlier = turn.rows[i];
      if (earlier.step != row.step || earlier.kind == 'model') break;
      if (earlier.kind == 'retry') found.add(earlier);
    }
    return found;
  }
}

class _Tab extends StatelessWidget {
  final String label;
  final bool selected;
  final VoidCallback onTap;
  const _Tab({
    required this.label,
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
      label: label,
      excludeSemantics: true,
      child: InkWell(
        onTap: onTap,
        child: Container(
          height: 40,
          alignment: Alignment.center,
          padding: const EdgeInsets.symmetric(horizontal: 10),
          decoration: BoxDecoration(
            border: Border(
              bottom: BorderSide(
                color: selected ? scheme.primary : Colors.transparent,
                width: 2,
              ),
            ),
          ),
          child: Text(
            label,
            style: theme.textTheme.bodySmall?.copyWith(
              color: selected ? scheme.onSurface : scheme.onSurfaceVariant,
              fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
            ),
          ),
        ),
      ),
    );
  }
}

class _Facts extends StatelessWidget {
  final List<(String, String)> facts;
  final bool statusError;
  const _Facts({required this.facts, required this.statusError});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final dark = theme.brightness == Brightness.dark;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final (label, value) in facts)
          Padding(
            padding: const EdgeInsets.only(bottom: 9),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(
                  width: 110,
                  child: Text(
                    label,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: scheme.onSurfaceVariant,
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                if (label == 'Status') ...[
                  Padding(
                    padding: const EdgeInsets.only(top: 4, right: 8),
                    child: Container(
                      width: 8,
                      height: 8,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: statusError
                            ? scheme.error
                            : dark
                            ? FrockTheme.success
                            : FrockTheme.successInk,
                      ),
                    ),
                  ),
                ],
                Expanded(
                  child: SelectableText(
                    value,
                    style: theme.textTheme.bodySmall,
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }
}

class _Verdict extends StatelessWidget {
  final WorkLogRow row;
  const _Verdict({required this.row});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final color = row.isError
        ? theme.colorScheme.error
        : workLogKindColor(theme, 'jev');
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(FrockTheme.radiusControl),
      ),
      child: Row(
        children: [
          Text(
            row.verdict!,
            style: theme.textTheme.titleMedium?.copyWith(color: color),
          ),
          const Spacer(),
          if (row.durationMs case final int ms)
            Text(
              workLogDuration(ms),
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
                fontFeatures: FrockTheme.tabularFigures,
              ),
            ),
        ],
      ),
    );
  }
}

class _Chain extends StatelessWidget {
  final List<WorkLogLinkView> links;
  const _Chain({required this.links});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Column(
      children: [
        for (final (index, link) in links.indexed)
          IntrinsicHeight(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                SizedBox(
                  width: 18,
                  child: Column(
                    children: [
                      const SizedBox(height: 4),
                      Container(
                        width: 10,
                        height: 10,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          color: link.isError
                              ? scheme.error
                              : workLogKindColor(theme, link.kind),
                        ),
                      ),
                      Expanded(
                        child: index == links.length - 1
                            ? const SizedBox.shrink()
                            : VerticalDivider(
                                width: 1,
                                color: FrockTheme.hairline(scheme),
                              ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.only(bottom: 12),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          link.title,
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: scheme.onSurface,
                            fontWeight: FontWeight.w500,
                          ),
                        ),
                        if (link.detail case final String detail)
                          Text(
                            detail,
                            style: theme.textTheme.bodySmall?.copyWith(
                              color: link.isError
                                  ? scheme.error
                                  : scheme.onSurfaceVariant,
                            ),
                          ),
                      ],
                    ),
                  ),
                ),
                if (link.durationMs case final int ms)
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
      ],
    );
  }
}

class _Tokens extends StatelessWidget {
  final wire.WorkLogTokens tokens;
  final WorkLogTurnView turn;
  const _Tokens({required this.tokens, required this.turn});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final cached = tokens.cachedInput.clamp(0, tokens.input);
    final fresh = tokens.input - cached;
    final parts = [
      ('Cached input', cached, scheme.onSurfaceVariant.withValues(alpha: 0.7)),
      ('New input', fresh, workLogKindColor(theme, 'model')),
      ('Reasoning', tokens.reasoning, workLogKindColor(theme, 'memory')),
      ('Output', tokens.output, workLogKindColor(theme, 'jev')),
    ];
    final total = parts.fold<int>(0, (sum, part) => sum + part.$2);
    final t = turn.totals;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const FrockSectionLabel('Tokens', padding: EdgeInsets.zero),
        const SizedBox(height: 10),
        if (total > 0)
          ExcludeSemantics(
            child: ClipRRect(
              borderRadius: BorderRadius.circular(FrockTheme.radiusPill),
              child: SizedBox(
                height: 10,
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    for (final (_, count, color) in parts)
                      if (count > 0)
                        Expanded(
                          flex: (count * 1000 ~/ total).clamp(8, 1000),
                          child: Padding(
                            padding: const EdgeInsets.only(right: 2),
                            child: ColoredBox(color: color),
                          ),
                        ),
                  ],
                ),
              ),
            ),
          ),
        const SizedBox(height: 10),
        Wrap(
          runSpacing: 6,
          children: [
            for (final (label, count, color) in parts)
              SizedBox(
                width: 180,
                child: Row(
                  children: [
                    Container(
                      width: 8,
                      height: 8,
                      decoration: BoxDecoration(
                        color: color,
                        borderRadius: BorderRadius.circular(2),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        label,
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: scheme.onSurfaceVariant,
                        ),
                      ),
                    ),
                    Text(
                      workLogCount(count),
                      style: theme.textTheme.bodySmall?.copyWith(
                        fontFeatures: FrockTheme.tabularFigures,
                      ),
                    ),
                    const SizedBox(width: 16),
                  ],
                ),
              ),
          ],
        ),
        const SizedBox(height: 8),
        Text(
          'This Turn · ${workLogTokens(t.inputTokens)} in · '
          '${workLogCount(t.outputTokens)} out · ${t.modelRequests} '
          'request${t.modelRequests == 1 ? '' : 's'}',
          style: theme.textTheme.bodySmall?.copyWith(
            color: scheme.onSurfaceVariant,
          ),
        ),
      ],
    );
  }
}

class _Timing extends StatelessWidget {
  final WorkLogRow row;
  final int ms;
  final List<WorkLogRow> retries;
  const _Timing({required this.row, required this.ms, required this.retries});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final wait = retries.fold<int>(0, (sum, r) => sum + (r.durationMs ?? 0));
    final color = row.isError
        ? scheme.error
        : workLogKindColor(theme, row.kind);
    final output = row.tokens?.output ?? 0;
    final rate = row.kind == 'model' && output > 0 && ms > 0
        ? '${(output / (ms / 1000)).round()} tok/s'
        : null;
    String two(int n) => n.toString().padLeft(2, '0');
    final at = row.at;
    final started =
        '${two(at.hour)}:${two(at.minute)}:${two(at.second)}.'
        '${at.millisecond.toString().padLeft(3, '0')}';
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const FrockSectionLabel('Timing', padding: EdgeInsets.zero),
        const SizedBox(height: 10),
        ExcludeSemantics(
          child: ClipRRect(
            borderRadius: BorderRadius.circular(6),
            child: SizedBox(
              height: 22,
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (wait > 0)
                    Expanded(
                      flex: wait,
                      child: ColoredBox(
                        color: scheme.onSurfaceVariant.withValues(alpha: 0.18),
                      ),
                    ),
                  Expanded(
                    flex: ms.clamp(1, 1 << 30),
                    child: ColoredBox(color: color),
                  ),
                ],
              ),
            ),
          ),
        ),
        const SizedBox(height: 10),
        Wrap(
          spacing: 24,
          runSpacing: 8,
          children: [
            if (wait > 0) _Stat('Retry wait', workLogDuration(wait)),
            _Stat('Took', workLogDuration(ms)),
            ?switch (rate) {
              final String value => _Stat('Output rate', value),
              null => null,
            },
          ],
        ),
        const SizedBox(height: 6),
        Text(
          'Started $started',
          style: theme.textTheme.bodySmall?.copyWith(
            color: scheme.onSurfaceVariant,
            fontFeatures: FrockTheme.tabularFigures,
          ),
        ),
      ],
    );
  }
}

class _Stat extends StatelessWidget {
  final String label;
  final String value;
  const _Stat(this.label, this.value);

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
          style: theme.textTheme.bodySmall?.copyWith(
            fontFeatures: FrockTheme.tabularFigures,
          ),
        ),
      ],
    );
  }
}

class _Chip extends StatelessWidget {
  final String text;
  final bool highlighted;
  const _Chip(this.text, {required this.highlighted});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final jev = workLogKindColor(theme, 'jev');
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
      decoration: BoxDecoration(
        color: highlighted
            ? jev.withValues(alpha: 0.16)
            : theme.colorScheme.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(FrockTheme.radiusPill),
      ),
      child: Text(
        text,
        style: theme.textTheme.bodySmall?.copyWith(
          color: highlighted ? jev : theme.colorScheme.onSurface,
        ),
      ),
    );
  }
}

class _Block extends StatelessWidget {
  final String label;
  final String text;
  final bool mono;
  const _Block({required this.label, required this.text, required this.mono});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Padding(
      padding: const EdgeInsets.only(top: 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: FrockSectionLabel(label, padding: EdgeInsets.zero),
              ),
              IconButton(
                tooltip: 'Copy ${label.toLowerCase()}',
                visualDensity: VisualDensity.compact,
                onPressed: () => Clipboard.setData(ClipboardData(text: text)),
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
              text,
              style: mono
                  ? theme.textTheme.bodySmall?.copyWith(
                      fontFamily: 'monospace',
                      height: 1.5,
                    )
                  : theme.textTheme.bodyMedium?.copyWith(height: 1.5),
            ),
          ),
        ],
      ),
    );
  }
}
