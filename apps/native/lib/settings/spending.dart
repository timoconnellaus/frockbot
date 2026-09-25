import 'dart:async';

import 'package:flutter/material.dart';

import '../client/transport.dart';
import '../shell/desktop_layout.dart';
import '../shell/semantics.dart';
import '../theme/controls.dart';
import '../theme/rows.dart';
import '../theme/states.dart';

/// The ways the page slices spending, in the order a drill-down reaches for
/// them. The keys are the API's.
const spendDimensions = <({String key, String label})>[
  (key: 'bot', label: 'Bot'),
  (key: 'cause', label: 'What started it'),
  (key: 'category', label: 'What it bought'),
  (key: 'model', label: 'Model'),
  (key: 'trigger', label: 'Trigger'),
  (key: 'conversation', label: 'Conversation'),
  (key: 'plugin', label: 'Plugin'),
];

const spendPeriods = <({String slug, String label})>[
  (slug: '7d', label: '7 days'),
  (slug: '30d', label: '30 days'),
  (slug: '90d', label: '90 days'),
  (slug: 'billing', label: 'Billing period'),
];

String spendDimensionLabel(String key) =>
    spendDimensions.where((d) => d.key == key).firstOrNull?.label ?? key;

/// One narrowing the person chose: a dimension, the key of the row they
/// tapped, and how that row read.
class SpendFilter {
  final String dimension;
  final String value;
  final String label;
  const SpendFilter(this.dimension, this.value, this.label);
}

/// The Spending view the API is asked for.
String spendingPath(String period, String groupBy, List<SpendFilter> filters) {
  final query = {
    'period': period,
    'groupBy': groupBy,
    for (final filter in filters) filter.dimension: filter.value,
  };
  return Uri(path: '/api/billing/spending', queryParameters: query).toString();
}

/// What to group by after narrowing to one row: the first slice not already
/// pinned by a filter, so each tap says something new.
String nextSpendGroupBy(Iterable<String> filtered) {
  final pinned = filtered.toSet();
  return spendDimensions
          .where((d) => !pinned.contains(d.key))
          .firstOrNull
          ?.key ??
      'bot';
}

/// Money as the page shows it. A charge smaller than a cent is real but
/// would read as nothing.
String spendMoney(Object? micros) {
  final value = micros as num? ?? 0;
  if (value > 0 && value < 10000) return '< US\$0.01';
  return 'US\$${(value / 1000000).toStringAsFixed(2)}';
}

const _months = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/// `2026-09-20` as `Sep 20`.
String spendDay(String day) {
  final parts = day.split('-');
  if (parts.length != 3) return day;
  final month = int.tryParse(parts[1]);
  final date = int.tryParse(parts[2]);
  if (month == null || date == null || month < 1 || month > 12) return day;
  return '${_months[month - 1]} $date';
}

String _when(Object? at) {
  if (at is! num) return '';
  final time = DateTime.fromMillisecondsSinceEpoch(at.toInt()).toLocal();
  final minute = time.minute.toString().padLeft(2, '0');
  return '${_months[time.month - 1]} ${time.day}, ${time.hour}:$minute';
}

/// Where an account's credit went: one page, sliced and narrowed in place.
class SpendingPage extends StatefulWidget {
  final NativeApi api;

  /// Where the page opens: a Bot's settings open it narrowed to that Bot, a
  /// Routine's run log to that Routine.
  final List<SpendFilter> filters;
  final String? groupBy;

  /// Opens the conversation a Turn ran in, when the shell can.
  final void Function(String botId)? onOpenBot;
  const SpendingPage({
    super.key,
    required this.api,
    this.filters = const [],
    this.groupBy,
    this.onOpenBot,
  });

  @override
  State<SpendingPage> createState() => _SpendingPageState();
}

class _SpendingPageState extends State<SpendingPage> {
  String period = '30d';
  late String groupBy;
  late List<SpendFilter> filters;
  Map<String, dynamic>? report;
  String? message;
  bool loading = true;
  int _request = 0;

  @override
  void initState() {
    super.initState();
    filters = [...widget.filters];
    groupBy =
        widget.groupBy ?? nextSpendGroupBy(filters.map((f) => f.dimension));
    unawaited(_load());
  }

  Future<void> _load() async {
    final request = ++_request;
    setState(() {
      loading = true;
      message = null;
    });
    try {
      final answer = await widget.api.request(
        spendingPath(period, groupBy, filters),
      );
      if (answer is! Map<String, dynamic>) {
        throw const FormatException('Invalid spending response');
      }
      if (!mounted || request != _request) return;
      // The server names each filter as it reads now, which is how a Bot
      // renamed since the page opened shows its new name.
      final named = {
        for (final f
            in (answer['filters'] as List? ?? const []).whereType<Map>())
          '${f['dimension']}': '${f['label']}',
      };
      setState(() {
        report = answer;
        filters = [
          for (final f in filters)
            SpendFilter(f.dimension, f.value, named[f.dimension] ?? f.label),
        ];
      });
    } catch (_) {
      if (mounted && request == _request) {
        setState(
          () => message = 'Couldn’t load your spending. Check your connection and try again.',
        );
      }
    } finally {
      if (mounted && request == _request) setState(() => loading = false);
    }
  }

  void _choose({String? period, String? groupBy, List<SpendFilter>? filters}) {
    setState(() {
      if (period != null) this.period = period;
      if (groupBy != null) this.groupBy = groupBy;
      if (filters != null) this.filters = filters;
    });
    unawaited(_load());
  }

  void _narrow(Map group) {
    final narrowed = [
      ...filters,
      SpendFilter(groupBy, '${group['key']}', '${group['label']}'),
    ];
    _choose(
      filters: narrowed,
      groupBy: nextSpendGroupBy(narrowed.map((f) => f.dimension)),
    );
  }

  void _widen(SpendFilter filter) => _choose(
    filters: [
      for (final f in filters)
        if (f.dimension != filter.dimension) f,
    ],
  );

  @override
  Widget build(BuildContext context) {
    final data = report;
    return Scaffold(
      appBar: DesktopHeader(
        child: AppBar(
          title: const Text('Spending'),
          actions: [
            IconButton(
              tooltip: 'Refresh spending',
              onPressed: loading ? null : _load,
              icon: const Icon(Icons.refresh_rounded),
            ),
          ],
        ),
      ),
      body: SafeArea(
        top: false,
        child: identified(
          SpendingIds.page,
          data == null && loading
              ? const FrockLoading(label: 'Loading your spending')
              : data == null
              ? FrockEmptyState(
                  icon: Icons.cloud_off_rounded,
                  title: 'Spending couldn’t load',
                  detail: message ?? '',
                  action: 'Try again',
                  onAction: _load,
                )
              : RefreshIndicator(onRefresh: _load, child: _body(context, data)),
        ),
      ),
    );
  }

  Widget _body(BuildContext context, Map<String, dynamic> data) {
    final theme = Theme.of(context);
    final total = data['totalMicros'] as num? ?? 0;
    final turns = data['turns'] as num?;
    final groups = (data['groups'] as List? ?? const []).whereType<Map>();
    final days = (data['days'] as List? ?? const []).whereType<Map>().toList();
    final topTurns = data['topTurns'] as List?;
    final pinned = filters.map((f) => f.dimension).toSet();
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 32),
      children: [
        Align(
          alignment: Alignment.centerLeft,
          child: SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: FrockSegmented(
              label: 'Period',
              selected: period,
              options: spendPeriods,
              onChosen: (slug) => _choose(period: slug),
            ),
          ),
        ),
        if (filters.isNotEmpty) ...[
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final filter in filters)
                InputChip(
                  label: Text(
                    '${spendDimensionLabel(filter.dimension)}: ${filter.label}',
                  ),
                  onDeleted: () => _widen(filter),
                  deleteButtonTooltipMessage: 'Show all again',
                ),
            ],
          ),
        ],
        const SizedBox(height: 20),
        Text(
          spendMoney(total),
          style: theme.textTheme.headlineMedium,
          semanticsLabel: 'Spent ${spendMoney(total)}',
        ),
        Text(
          [
            if (turns != null) '$turns ${turns == 1 ? 'Turn' : 'Turns'}',
            '${data['operations'] ?? 0} charges',
          ].join(' · '),
          style: theme.textTheme.bodySmall?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
        if (message != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(
              message!,
              style: TextStyle(color: theme.colorScheme.error),
            ),
          ),
        const SizedBox(height: 16),
        _DailyBars(days: days),
        const FrockSectionLabel('Group by'),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final dimension in spendDimensions)
              if (!pinned.contains(dimension.key))
                ChoiceChip(
                  label: Text(dimension.label),
                  selected: groupBy == dimension.key,
                  onSelected: (_) => _choose(groupBy: dimension.key),
                ),
          ],
        ),
        const SizedBox(height: 12),
        if (groups.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 24),
            child: Text(
              'Nothing was charged in this period.',
              style: theme.textTheme.bodyMedium,
            ),
          )
        else
          FrockRowGroup(
            indent: 16,
            rows: [
              for (final group in groups)
                _GroupRow(
                  group: group,
                  total: total,
                  onTap: pinned.length + 1 < spendDimensions.length
                      ? () => _narrow(group)
                      : null,
                ),
            ],
          ),
        const FrockSectionLabel('Most expensive Turns'),
        if (topTurns == null)
          Text(
            'A Turn can span models, Plugins and kinds of work, so this list is not narrowed by them.',
            style: theme.textTheme.bodySmall,
          )
        else if (topTurns.isEmpty)
          Text('No Turns were charged.', style: theme.textTheme.bodySmall)
        else
          FrockRowGroup(
            indent: 16,
            rows: [
              for (final turn in topTurns.whereType<Map>())
                FrockRow(
                  title: '${turn['cause']}',
                  subtitle: '${turn['bot']} · ${_when(turn['at'])}',
                  trailing: Text(spendMoney(turn['chargeMicros'])),
                  chevron: widget.onOpenBot != null,
                  onTap: widget.onOpenBot == null
                      ? null
                      : () => widget.onOpenBot!('${turn['botId']}'),
                ),
            ],
          ),
      ],
    );
  }
}

class _GroupRow extends StatelessWidget {
  final Map group;
  final num total;
  final VoidCallback? onTap;
  const _GroupRow({required this.group, required this.total, this.onTap});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final charge = group['chargeMicros'] as num? ?? 0;
    final share = total > 0 ? charge / total : 0.0;
    final turns = group['turns'] as num?;
    final detail = [
      if (group['detail'] is String) group['detail'] as String,
      '${(share * 100).round()}%',
      if (turns != null) '$turns ${turns == 1 ? 'Turn' : 'Turns'}',
    ].join(' · ');
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 10, 16, 10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    '${group['label']}',
                    style: theme.textTheme.bodyLarge,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                const SizedBox(width: 12),
                Text(spendMoney(charge), style: theme.textTheme.bodyLarge),
                if (onTap != null)
                  Icon(
                    Icons.chevron_right_rounded,
                    size: 18,
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
              ],
            ),
            const SizedBox(height: 2),
            Text(
              detail,
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 6),
            ClipRRect(
              borderRadius: BorderRadius.circular(2),
              child: LinearProgressIndicator(
                value: share.toDouble(),
                minHeight: 4,
                backgroundColor: theme.colorScheme.onSurface.withValues(
                  alpha: 0.06,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// A bar for each of the person's days in the period.
class _DailyBars extends StatelessWidget {
  final List<Map> days;
  const _DailyBars({required this.days});

  @override
  Widget build(BuildContext context) {
    if (days.isEmpty) return const SizedBox.shrink();
    final theme = Theme.of(context);
    final most = days
        .map((d) => d['chargeMicros'] as num? ?? 0)
        .fold<num>(0, (a, b) => a > b ? a : b);
    final caption = theme.textTheme.labelSmall?.copyWith(
      color: theme.colorScheme.onSurfaceVariant,
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SizedBox(
          height: 88,
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              for (final day in days)
                Expanded(
                  child: Tooltip(
                    message:
                        '${spendDay('${day['day']}')}: ${spendMoney(day['chargeMicros'])}',
                    child: Padding(
                      padding: EdgeInsets.symmetric(
                        horizontal: days.length > 45 ? 0.5 : 1.5,
                      ),
                      child: FractionallySizedBox(
                        heightFactor: most > 0
                            ? ((day['chargeMicros'] as num? ?? 0) / most)
                                  .clamp(0.02, 1.0)
                                  .toDouble()
                            : 0.02,
                        alignment: Alignment.bottomCenter,
                        child: DecoratedBox(
                          decoration: BoxDecoration(
                            color: (day['chargeMicros'] as num? ?? 0) > 0
                                ? theme.colorScheme.primary
                                : theme.colorScheme.onSurface.withValues(
                                    alpha: 0.08,
                                  ),
                            borderRadius: const BorderRadius.vertical(
                              top: Radius.circular(2),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ),
        const SizedBox(height: 4),
        Row(
          children: [
            Text(spendDay('${days.first['day']}'), style: caption),
            const Spacer(),
            Text(spendDay('${days.last['day']}'), style: caption),
          ],
        ),
      ],
    );
  }
}
