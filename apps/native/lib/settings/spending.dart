import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../client/transport.dart';
import '../shell/desktop_layout.dart';
import '../shell/semantics.dart';
import '../theme/controls.dart';
import '../theme/frock_theme.dart';
import '../theme/states.dart';

/// The ways the page slices spending, in the order a drill-down reaches for
/// them. The keys are the API's.
const spendDimensions = <({String key, String label, String lower})>[
  (key: 'cause', label: 'Started by', lower: 'what started it'),
  (key: 'bot', label: 'Bot', lower: 'Bot'),
  (key: 'category', label: 'What it bought', lower: 'what it bought'),
  (key: 'model', label: 'Model', lower: 'model'),
];

const spendPeriods = <({String slug, String label})>[
  (slug: '7d', label: '7 days'),
  (slug: '30d', label: '30 days'),
  (slug: '90d', label: '90 days'),
  (slug: 'billing', label: 'Billing period'),
];

/// The same periods, narrow enough for a phone's width.
const _shortPeriods = <({String slug, String label})>[
  (slug: '7d', label: '7d'),
  (slug: '30d', label: '30d'),
  (slug: '90d', label: '90d'),
  (slug: 'billing', label: 'Billing'),
];

String spendDimensionLabel(String key) =>
    spendDimensions.where((d) => d.key == key).firstOrNull?.label ?? key;

String _dimensionLower(String key) =>
    spendDimensions.where((d) => d.key == key).firstOrNull?.lower ?? key;

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
      'cause';
}

/// Money as the page shows it. A charge smaller than a cent is real but
/// would read as nothing.
String spendMoney(Object? micros) {
  final value = micros as num? ?? 0;
  if (value > 0 && value < 10000) return '< US\$0.01';
  return 'US\$${(value / 1000000).toStringAsFixed(2)}';
}

/// A cost per Turn, which is usually well under a cent.
String _perTurn(num micros, num turns) =>
    turns > 0 ? '\$${(micros / turns / 1000000).toStringAsFixed(3)}' : '—';

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

String _date(num at) {
  final time = DateTime.fromMillisecondsSinceEpoch(at.toInt()).toLocal();
  return '${_months[time.month - 1]} ${time.day}';
}

String _when(Object? at) {
  if (at is! num) return '';
  final time = DateTime.fromMillisecondsSinceEpoch(at.toInt()).toLocal();
  final hour = time.hour % 12 == 0 ? 12 : time.hour % 12;
  final minute = time.minute.toString().padLeft(2, '0');
  return '${_date(at)}, $hour:$minute ${time.hour < 12 ? 'am' : 'pm'}';
}

/// What a cause is, under its name.
String _causeKind(String key, Object? detail) {
  final kind = key.split('|').first;
  final bot = detail is String ? detail : null;
  return switch (kind) {
    'routine' => bot == null ? 'Routine' : 'Routine on $bot',
    'chat' => 'You, in chat',
    'group' => 'Group Chat',
    'voice' => 'Voice',
    'email' => 'You, by email',
    'desktop' => 'Watching or controlling it',
    'plugin' => 'A Plugin’s own page',
    _ => 'Not attributed',
  };
}

/// The colours the chart and the breakdown share: a group keeps its colour
/// from one to the other. The first is the Bot's own accent.
List<Color> _seriesColors(ColorScheme scheme) => [
  scheme.primary,
  const Color(0xffe8a33d),
  const Color(0xff2fa69d),
  const Color(0xff7b6cf0),
  const Color(0xff8a8a9c),
  const Color(0xff5e5e6e),
];

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

  void _widen(SpendFilter filter) {
    final widened = [
      for (final f in filters)
        if (f.dimension != filter.dimension) f,
    ];
    _choose(filters: widened);
  }

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
              : RefreshIndicator(
                  onRefresh: _load,
                  child: LayoutBuilder(
                    builder: (context, constraints) =>
                        _body(context, data, wide: constraints.maxWidth >= 900),
                  ),
                ),
        ),
      ),
    );
  }

  Widget _body(
    BuildContext context,
    Map<String, dynamic> data, {
    required bool wide,
  }) {
    final theme = Theme.of(context);
    final colors = _seriesColors(theme.colorScheme);
    final groups = (data['groups'] as List? ?? const [])
        .whereType<Map>()
        .toList();
    final pinned = filters.map((f) => f.dimension).toSet();
    final tabs = [
      for (final d in spendDimensions)
        if (!pinned.contains(d.key)) d,
    ];
    final canNarrow = tabs.length > 1;
    final controls = Wrap(
      spacing: 12,
      runSpacing: 12,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        FrockSegmented(
          label: 'Period',
          selected: period,
          options: wide ? spendPeriods : _shortPeriods,
          onChosen: (slug) => _choose(period: slug),
        ),
        for (final filter in filters)
          InputChip(
            label: Text(filter.label),
            avatar: Icon(
              Icons.filter_alt_outlined,
              size: 16,
              color: theme.colorScheme.primary,
            ),
            onDeleted: () => _widen(filter),
            deleteButtonTooltipMessage: 'Show all again',
          ),
      ],
    );
    final breakdown = _Breakdown(
      groups: groups,
      total: data['totalMicros'] as num? ?? 0,
      colors: colors,
      tabs: tabs,
      groupBy: groupBy,
      wide: wide,
      onTab: (key) => _choose(groupBy: key),
      onRow: canNarrow ? _narrow : null,
    );
    final turns = _TopTurns(
      turns: data['topTurns'] as List?,
      onOpenBot: widget.onOpenBot,
    );
    final chart = _DailyChart(
      days: (data['days'] as List? ?? const []).whereType<Map>().toList(),
      groups: groups,
      colors: colors,
      title: 'Each day, by ${_dimensionLower(groupBy)}',
      wide: wide,
    );
    if (wide) {
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(32, 16, 32, 40),
        children: [
          controls,
          if (message != null) _error(context),
          const SizedBox(height: 20),
          _Headline(data: data, period: period, wide: true),
          const SizedBox(height: 16),
          chart,
          const SizedBox(height: 16),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(flex: 3, child: breakdown),
              const SizedBox(width: 16),
              Expanded(flex: 2, child: turns),
            ],
          ),
        ],
      );
    }
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 32),
      children: [
        controls,
        if (message != null) _error(context),
        const SizedBox(height: 16),
        _Headline(data: data, period: period, wide: false),
        const SizedBox(height: 16),
        chart,
        const SizedBox(height: 16),
        breakdown,
        const SizedBox(height: 16),
        turns,
      ],
    );
  }

  Widget _error(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: 12),
    child: Text(
      message!,
      style: TextStyle(color: Theme.of(context).colorScheme.error),
    ),
  );
}

/// The answer before the detail: what was spent, how long the credit lasts,
/// and what drove it.
class _Headline extends StatelessWidget {
  final Map<String, dynamic> data;
  final String period;
  final bool wide;
  const _Headline({
    required this.data,
    required this.period,
    required this.wide,
  });

  @override
  Widget build(BuildContext context) {
    final cards = [
      _total(context),
      if (data['credit'] is Map) _credit(context, data['credit'] as Map),
      if (wide && data['topCause'] is Map)
        _driver(context, data['topCause'] as Map),
    ];
    if (!wide) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (var i = 0; i < cards.length; i++) ...[
            if (i > 0) const SizedBox(height: 12),
            cards[i],
          ],
        ],
      );
    }
    return IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (var i = 0; i < cards.length; i++) ...[
            if (i > 0) const SizedBox(width: 16),
            Expanded(child: cards[i]),
          ],
        ],
      ),
    );
  }

  String get _periodLabel => switch (period) {
    '7d' => 'Spent in the last 7 days',
    '90d' => 'Spent in the last 90 days',
    'billing' => 'Spent this billing period',
    _ => 'Spent in the last 30 days',
  };

  Widget _total(BuildContext context) {
    final theme = Theme.of(context);
    final total = data['totalMicros'] as num? ?? 0;
    final previous = data['previousTotalMicros'] as num? ?? 0;
    final turns = data['turns'] as num?;
    final change = previous > 0 ? (total - previous) / previous : null;
    return _Panel(
      children: [
        _Caption(_periodLabel),
        Wrap(
          spacing: 12,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            Text(
              spendMoney(total),
              style: theme.textTheme.headlineLarge?.copyWith(
                fontWeight: FontWeight.w700,
              ),
            ),
            if (change != null && change.abs() >= 0.01)
              _Change(change.toDouble()),
          ],
        ),
        _Caption(
          [
            previous > 0
                ? 'vs ${spendMoney(previous)} the period before'
                : 'Nothing spent the period before',
            if (turns != null) '$turns ${turns == 1 ? 'Turn' : 'Turns'}',
          ].join(' · '),
        ),
      ],
    );
  }

  Widget _credit(BuildContext context, Map credit) {
    final theme = Theme.of(context);
    final available = credit['availableMicros'] as num? ?? 0;
    final daily = credit['dailyMicros'] as num? ?? 0;
    final runsOut = credit['runsOutAt'] as num?;
    final renews = credit['renewsAt'] as num?;
    final short = runsOut != null && renews != null && runsOut < renews;
    final warn = theme.brightness == Brightness.dark
        ? FrockTheme.warning
        : FrockTheme.warningInk;
    final line = runsOut == null
        ? 'Nothing spent in the last week.'
        : short
        ? null
        : renews != null
        ? 'At ${spendMoney(daily)} a day it lasts past renewal on ${_date(renews)}.'
        : 'At ${spendMoney(daily)} a day it lasts until about ${_date(runsOut)}.';
    return _Panel(
      children: [
        const _Caption('Credit left'),
        Text(
          spendMoney(available),
          style: theme.textTheme.headlineLarge?.copyWith(
            fontWeight: FontWeight.w700,
          ),
        ),
        if (line != null || runsOut == null || renews == null)
          Text(line ?? '', style: theme.textTheme.bodyMedium)
        else
          Text.rich(
            TextSpan(
              style: theme.textTheme.bodyMedium,
              children: [
                TextSpan(text: 'At ${spendMoney(daily)} a day it runs out '),
                TextSpan(
                  text: 'around ${_date(runsOut)}',
                  style: TextStyle(color: warn, fontWeight: FontWeight.w600),
                ),
                TextSpan(
                  text:
                      ' — ${((renews - runsOut) / 86400000).ceil()} days before it renews.',
                ),
              ],
            ),
          ),
      ],
    );
  }

  Widget _driver(BuildContext context, Map cause) {
    final theme = Theme.of(context);
    final total = data['totalMicros'] as num? ?? 0;
    final charge = cause['chargeMicros'] as num? ?? 0;
    final turns = cause['turns'] as num? ?? 0;
    final share = total > 0 ? (charge / total * 100).round() : 0;
    final key = '${cause['key']}';
    return _Panel(
      children: [
        const _Caption('Biggest driver'),
        Text(
          '${cause['label']}',
          style: theme.textTheme.titleLarge?.copyWith(
            fontWeight: FontWeight.w600,
          ),
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
        _Caption(_causeKind(key, cause['detail'])),
        Text(
          [
            '$share% of spend',
            if (turns > 0)
              '${_perTurn(charge, turns)} a ${key.startsWith('routine') ? 'run' : 'Turn'}',
          ].join(' · '),
          style: theme.textTheme.bodyMedium,
        ),
      ],
    );
  }
}

class _Change extends StatelessWidget {
  final double change;
  const _Change(this.change);

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    final up = change > 0;
    final ink = up
        ? (dark ? FrockTheme.warning : FrockTheme.warningInk)
        : (dark ? FrockTheme.success : FrockTheme.successInk);
    final percent = '${(change.abs() * 100).round()}%';
    return Semantics(
      label: '${up ? 'Up' : 'Down'} $percent on the period before',
      child: ExcludeSemantics(
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
          decoration: BoxDecoration(
            color: ink.withValues(alpha: 0.16),
            borderRadius: BorderRadius.circular(999),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                up ? Icons.north_east_rounded : Icons.south_east_rounded,
                size: 13,
                color: ink,
              ),
              const SizedBox(width: 3),
              Text(
                percent,
                style: TextStyle(
                  color: ink,
                  fontSize: 13,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Panel extends StatelessWidget {
  final List<Widget> children;
  final EdgeInsets padding;
  const _Panel({
    required this.children,
    this.padding = const EdgeInsets.fromLTRB(20, 18, 20, 18),
  });

  @override
  Widget build(BuildContext context) => Card(
    margin: EdgeInsets.zero,
    child: Padding(
      padding: padding,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          for (var i = 0; i < children.length; i++) ...[
            if (i > 0) const SizedBox(height: 8),
            children[i],
          ],
        ],
      ),
    ),
  );
}

class _Caption extends StatelessWidget {
  final String text;
  const _Caption(this.text);

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Text(
      text,
      style: theme.textTheme.bodyMedium?.copyWith(
        color: theme.colorScheme.onSurfaceVariant,
      ),
    );
  }
}

/// A bar for each of the person's days, split by the groups the breakdown
/// lists, in the breakdown's colours.
class _DailyChart extends StatelessWidget {
  final List<Map> days;
  final List<Map> groups;
  final List<Color> colors;
  final String title;
  final bool wide;
  const _DailyChart({
    required this.days,
    required this.groups,
    required this.colors,
    required this.title,
    required this.wide,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final most = days
        .map((d) => d['chargeMicros'] as num? ?? 0)
        .fold<num>(0, math.max);
    final caption = theme.textTheme.labelSmall?.copyWith(
      color: theme.colorScheme.onSurfaceVariant,
    );
    final height = wide ? 180.0 : 140.0;
    final legend = [
      for (var i = 0; i < groups.length && i < 5; i++)
        (label: '${groups[i]['label']}', color: colors[i]),
      if (groups.length > 5) (label: 'Other', color: colors[5]),
    ];
    return _Panel(
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: Text(
                title,
                style: theme.textTheme.titleSmall?.copyWith(
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
            if (wide)
              Flexible(
                flex: 2,
                child: Wrap(
                  spacing: 14,
                  runSpacing: 6,
                  alignment: WrapAlignment.end,
                  children: [
                    for (final item in legend)
                      Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          _Swatch(item.color),
                          const SizedBox(width: 6),
                          Text(item.label, style: caption),
                        ],
                      ),
                  ],
                ),
              ),
          ],
        ),
        const SizedBox(height: 4),
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (wide)
              SizedBox(
                width: 52,
                height: height,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text(spendMoney(most), style: caption),
                    Text(spendMoney(most / 2), style: caption),
                    Text('\$0', style: caption),
                  ],
                ),
              ),
            if (wide) const SizedBox(width: 10),
            Expanded(
              child: Container(
                height: height,
                decoration: BoxDecoration(
                  border: Border(bottom: BorderSide(color: theme.dividerColor)),
                ),
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
                            child: _Bar(
                              stack: (day['stack'] as List? ?? const [])
                                  .map((v) => v as num? ?? 0)
                                  .toList(),
                              most: most,
                              height: height,
                              colors: colors,
                              empty: theme.colorScheme.onSurface.withValues(
                                alpha: 0.08,
                              ),
                            ),
                          ),
                        ),
                      ),
                  ],
                ),
              ),
            ),
          ],
        ),
        if (days.isNotEmpty)
          Padding(
            padding: EdgeInsets.only(left: wide ? 62 : 0),
            child: Row(
              children: [
                Text(spendDay('${days.first['day']}'), style: caption),
                const Spacer(),
                Text(
                  spendDay('${days[days.length ~/ 2]['day']}'),
                  style: caption,
                ),
                const Spacer(),
                Text('Today', style: caption),
              ],
            ),
          ),
      ],
    );
  }
}

class _Bar extends StatelessWidget {
  final List<num> stack;
  final num most;
  final double height;
  final List<Color> colors;
  final Color empty;
  const _Bar({
    required this.stack,
    required this.most,
    required this.height,
    required this.colors,
    required this.empty,
  });

  @override
  Widget build(BuildContext context) {
    final total = stack.fold<num>(0, (a, b) => a + b);
    if (total <= 0 || most <= 0) {
      return Align(
        alignment: Alignment.bottomCenter,
        child: Container(height: 2, color: empty),
      );
    }
    final last = stack.lastIndexWhere((v) => v > 0);
    return Column(
      mainAxisAlignment: MainAxisAlignment.end,
      children: [
        for (var i = stack.length - 1; i >= 0; i--)
          if (stack[i] > 0)
            Container(
              height: stack[i] / most * (height - 2),
              decoration: BoxDecoration(
                color: colors[math.min(i, colors.length - 1)],
                borderRadius: i == last
                    ? const BorderRadius.vertical(top: Radius.circular(3))
                    : null,
              ),
            ),
      ],
    );
  }
}

class _Swatch extends StatelessWidget {
  final Color color;
  const _Swatch(this.color);

  @override
  Widget build(BuildContext context) => Container(
    width: 10,
    height: 10,
    decoration: BoxDecoration(
      color: color,
      borderRadius: BorderRadius.circular(3),
    ),
  );
}

/// The groups of one dimension, largest first, each one tap from being the
/// whole page.
class _Breakdown extends StatelessWidget {
  final List<Map> groups;
  final num total;
  final List<Color> colors;
  final List<({String key, String label, String lower})> tabs;
  final String groupBy;
  final bool wide;
  final void Function(String key) onTab;
  final void Function(Map group)? onRow;
  const _Breakdown({
    required this.groups,
    required this.total,
    required this.colors,
    required this.tabs,
    required this.groupBy,
    required this.wide,
    required this.onTab,
    required this.onRow,
  });

  Color _color(int i) => colors[math.min(i, 5)];

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final countsTurns = groups.any((g) => g['turns'] != null);
    final header = theme.textTheme.labelSmall?.copyWith(
      color: theme.colorScheme.onSurfaceVariant,
      fontWeight: FontWeight.w600,
      letterSpacing: 0.6,
    );
    return _Panel(
      padding: const EdgeInsets.fromLTRB(12, 14, 12, 8),
      children: [
        if (tabs.length > 1)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8),
            child: Align(
              alignment: Alignment.centerLeft,
              child: SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: FrockSegmented(
                  label: 'Break down by',
                  selected: groupBy,
                  options: [
                    for (final tab in tabs) (slug: tab.key, label: tab.label),
                  ],
                  onChosen: onTab,
                ),
              ),
            ),
          ),
        if (groups.isEmpty)
          Padding(
            padding: const EdgeInsets.all(20),
            child: Text(
              'Nothing was charged in this period.',
              style: theme.textTheme.bodyMedium,
            ),
          )
        else ...[
          Padding(
            padding: const EdgeInsets.fromLTRB(8, 6, 8, 2),
            child: ClipRRect(
              borderRadius: BorderRadius.circular(5),
              child: SizedBox(
                height: 10,
                child: Row(
                  children: [
                    for (var i = 0; i < groups.length; i++)
                      if ((groups[i]['chargeMicros'] as num? ?? 0) > 0)
                        Expanded(
                          flex: math.max(
                            1,
                            ((groups[i]['chargeMicros'] as num) / total * 1000)
                                .round(),
                          ),
                          child: Container(
                            margin: EdgeInsets.only(
                              right: i == groups.length - 1 ? 0 : 2,
                            ),
                            color: _color(i),
                          ),
                        ),
                  ],
                ),
              ),
            ),
          ),
          if (wide)
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      spendDimensionLabel(groupBy).toUpperCase(),
                      style: header,
                    ),
                  ),
                  if (countsTurns) ...[
                    SizedBox(
                      width: 80,
                      child: Text(
                        'TURNS',
                        style: header,
                        textAlign: TextAlign.right,
                      ),
                    ),
                    SizedBox(
                      width: 90,
                      child: Text(
                        'PER TURN',
                        style: header,
                        textAlign: TextAlign.right,
                      ),
                    ),
                  ],
                  SizedBox(
                    width: 110,
                    child: Text(
                      'SPENT',
                      style: header,
                      textAlign: TextAlign.right,
                    ),
                  ),
                  if (onRow != null) const SizedBox(width: 26),
                ],
              ),
            ),
          for (var i = 0; i < groups.length; i++)
            _GroupRow(
              group: groups[i],
              total: total,
              color: _color(i),
              wide: wide,
              countsTurns: countsTurns,
              onTap: onRow == null ? null : () => onRow!(groups[i]),
            ),
        ],
      ],
    );
  }
}

class _GroupRow extends StatelessWidget {
  final Map group;
  final num total;
  final Color color;
  final bool wide;
  final bool countsTurns;
  final VoidCallback? onTap;
  const _GroupRow({
    required this.group,
    required this.total,
    required this.color,
    required this.wide,
    required this.countsTurns,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final charge = group['chargeMicros'] as num? ?? 0;
    final turns = group['turns'] as num?;
    final share = total > 0 ? '${(charge / total * 100).round()}%' : '—';
    final key = '${group['key']}';
    final isCause = key.contains('|');
    final detail = isCause
        ? _causeKind(key, group['detail'])
        : group['detail'] is String
        ? group['detail'] as String
        : null;
    final muted = theme.textTheme.bodySmall?.copyWith(
      color: theme.colorScheme.onSurfaceVariant,
    );
    final figures = theme.textTheme.bodyMedium?.copyWith(
      fontFeatures: const [FontFeature.tabularFigures()],
    );
    final amount = Column(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        Text(
          spendMoney(charge),
          style: figures?.copyWith(fontWeight: FontWeight.w600),
        ),
        Text(share, style: muted),
      ],
    );
    final subtitle = [
      ?detail,
      if (!wide && turns != null) '${_perTurn(charge, turns)} a Turn',
    ].join(' · ');
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(10),
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: 56),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          child: Row(
            children: [
              _Swatch(color),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '${group['label']}',
                      style: theme.textTheme.bodyLarge?.copyWith(
                        fontWeight: FontWeight.w500,
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    if (subtitle.isNotEmpty)
                      Text(
                        subtitle,
                        style: muted,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                  ],
                ),
              ),
              if (wide && countsTurns) ...[
                SizedBox(
                  width: 80,
                  child: Text(
                    turns == null ? '—' : '$turns',
                    style: figures,
                    textAlign: TextAlign.right,
                  ),
                ),
                SizedBox(
                  width: 90,
                  child: Text(
                    turns == null ? '—' : _perTurn(charge, turns),
                    style: figures,
                    textAlign: TextAlign.right,
                  ),
                ),
              ],
              if (wide) SizedBox(width: 110, child: amount) else amount,
              if (onTap != null) ...[
                const SizedBox(width: 8),
                Icon(
                  Icons.chevron_right_rounded,
                  size: 18,
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _TopTurns extends StatelessWidget {
  final List? turns;
  final void Function(String botId)? onOpenBot;
  const _TopTurns({required this.turns, required this.onOpenBot});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final list = turns?.whereType<Map>().toList();
    return _Panel(
      padding: const EdgeInsets.fromLTRB(12, 16, 12, 8),
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 8),
          child: Text(
            'Most expensive Turns',
            style: theme.textTheme.titleSmall?.copyWith(
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
        if (list == null)
          const Padding(
            padding: EdgeInsets.fromLTRB(8, 4, 8, 12),
            child: _Caption(
              'A Turn can span models and kinds of work, so this list is not narrowed by them.',
            ),
          )
        else if (list.isEmpty)
          const Padding(
            padding: EdgeInsets.fromLTRB(8, 4, 8, 12),
            child: _Caption('No Turns were charged.'),
          )
        else
          for (final turn in list.take(6))
            InkWell(
              borderRadius: BorderRadius.circular(10),
              onTap: onOpenBot == null
                  ? null
                  : () => onOpenBot!('${turn['botId']}'),
              child: ConstrainedBox(
                constraints: const BoxConstraints(minHeight: 52),
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 6,
                  ),
                  child: Row(
                    children: [
                      _Initial('${turn['bot']}'),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              '${turn['cause']}',
                              style: theme.textTheme.bodyMedium?.copyWith(
                                fontWeight: FontWeight.w500,
                              ),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            ),
                            Text(
                              '${turn['bot']} · ${_when(turn['at'])}',
                              style: theme.textTheme.bodySmall?.copyWith(
                                color: theme.colorScheme.onSurfaceVariant,
                              ),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(width: 8),
                      Text(
                        spendMoney(turn['chargeMicros']),
                        style: theme.textTheme.bodyMedium?.copyWith(
                          fontWeight: FontWeight.w600,
                          fontFeatures: const [FontFeature.tabularFigures()],
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
      ],
    );
  }
}

/// The Bot a Turn ran on, by its initial.
class _Initial extends StatelessWidget {
  final String name;
  const _Initial(this.name);

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return ExcludeSemantics(
      child: Container(
        width: 32,
        height: 32,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: scheme.primary.withValues(alpha: 0.18),
          borderRadius: BorderRadius.circular(9),
        ),
        child: Text(
          name.isEmpty ? '?' : name.characters.first.toUpperCase(),
          style: TextStyle(
            color: scheme.primary,
            fontWeight: FontWeight.w700,
            fontSize: 13,
          ),
        ),
      ),
    );
  }
}
