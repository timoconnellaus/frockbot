import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../brand.dart';
import '../client/transport.dart';
import '../shell/desktop_layout.dart';
import '../shell/semantics.dart';
import '../theme/controls.dart';
import '../theme/frock_theme.dart';
import '../theme/rows.dart';
import '../theme/states.dart';
import 'spending.dart';

/// The plans as `/api/billing` states them; these are only what a reply
/// without them falls back to.
const _fallbackPlans = {
  'standard': (monthlyCents: 2000, includedMicros: 20000000),
  'plus': (monthlyCents: 5000, includedMicros: 60000000),
};
const _defaultTopUps = [1000, 2500, 5000];

const _day = 86400000;

/// How wide Billing reads: one column, the width of the design, centred.
const _column = 760.0;

String _money(Object? micros) =>
    'US\$${((micros as num? ?? 0) / 1000000).toStringAsFixed(2)}';

/// Whole dollars where the amount is whole: US$20, not US$20.00.
String _dollars(num cents) => cents % 100 == 0
    ? 'US\$${cents ~/ 100}'
    : 'US\$${(cents / 100).toStringAsFixed(2)}';

String _wholeMicros(num micros) => _dollars((micros / 10000).round());

typedef _Plan = ({
  String id,
  String name,
  int monthlyCents,
  int includedMicros,
});

_Plan _readPlan(Object? raw) {
  final plan = raw is Map ? raw : const {};
  final id = plan['id'] == 'plus' ? 'plus' : 'standard';
  final fallback = _fallbackPlans[id]!;
  return (
    id: id,
    name: id == 'plus' ? 'Plus' : 'Standard',
    monthlyCents:
        (plan['monthlyCents'] as num?)?.toInt() ?? fallback.monthlyCents,
    includedMicros:
        (plan['includedMicros'] as num?)?.toInt() ?? fallback.includedMicros,
  );
}

/// Both plans, Standard first.
List<_Plan> _plans(Map data) {
  final listed = (data['plans'] as List? ?? const []).map(_readPlan).toList();
  if (listed.length >= 2) return listed;
  final own = _readPlan(data['plan']);
  return [
    own.id == 'standard' ? own : _readPlan(const {'id': 'standard'}),
    own.id == 'plus' ? own : _readPlan(const {'id': 'plus'}),
  ];
}

/// Billing: what the account can spend, how to add more, and where it went.
class BillingPage extends StatefulWidget {
  final NativeApi api;

  /// Opens the conversation a Turn listed under Spending ran in.
  final void Function(String botId)? onOpenBot;

  /// Opens scrolled to Spending, for a door that asked for it by name.
  final bool showSpending;
  const BillingPage({
    super.key,
    required this.api,
    this.onOpenBot,
    this.showSpending = false,
  });

  @override
  State<BillingPage> createState() => _BillingPageState();
}

class _BillingPageState extends State<BillingPage> with WidgetsBindingObserver {
  Map<String, dynamic>? account;

  /// The account's credit and its recent pace, as Spending last read it.
  Map? pace;

  /// A read that failed before anything was shown.
  String? failure;

  /// What the page has to say about the last thing the person did.
  String? message;
  bool busy = false;
  int topUpCents = 2500;
  final Map<String, String> checkoutIds = {};
  final _spending = GlobalKey<SpendingViewState>();
  final _spendingSection = GlobalKey();
  bool _scrolledToSpending = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(_load());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // Back from checkout in the browser: the balance may have moved.
    if (state == AppLifecycleState.resumed) unawaited(_refresh());
  }

  Future<void> _refresh() async {
    await Future.wait([_load(), ?_spending.currentState?.reload()]);
  }

  Future<void> _load() async {
    try {
      final response = await widget.api.request('/api/billing');
      if (response is! Map<String, dynamic>) {
        throw const FormatException('Invalid billing response');
      }
      if (!mounted) return;
      final tops = _topUps(response);
      setState(() {
        account = response;
        failure = null;
        if (!tops.contains(topUpCents)) {
          topUpCents = tops[tops.length ~/ 2];
        }
      });
      _revealSpending();
    } catch (_) {
      if (!mounted) return;
      const text =
          'Couldn’t load your balance. Check your connection and try again.';
      setState(() {
        if (account == null) {
          failure = text;
        } else {
          message = text;
        }
      });
    }
  }

  /// A door that named Spending opens the page there, once.
  void _revealSpending() {
    if (!widget.showSpending || _scrolledToSpending) return;
    _scrolledToSpending = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final target = _spendingSection.currentContext;
      if (target == null || !target.mounted) return;
      unawaited(
        Scrollable.ensureVisible(
          target,
          duration: FrockTheme.motion(context),
          curve: Curves.easeOutCubic,
        ),
      );
    });
  }

  Future<void> _openPayment(String kind, {int? cents, String? plan}) async {
    if (busy) return;
    setState(() {
      busy = true;
      message = null;
    });
    final key = '$kind:${cents ?? plan ?? 0}';
    final id = checkoutIds.putIfAbsent(key, randomId);
    try {
      final response = await widget.api.request(
        kind == 'portal' ? '/api/billing/portal' : '/api/billing/checkout',
        body: {
          'id': id,
          if (kind != 'portal') 'kind': kind,
          'cents': ?cents,
          'plan': ?plan,
        },
      );
      if (response is! Map || response['url'] is! String) {
        throw const FormatException('Payment link is unavailable');
      }
      final uri = Uri.parse(response['url'] as String);
      if (uri.scheme != 'https' ||
          !{'checkout.stripe.com', 'billing.stripe.com'}.contains(uri.host)) {
        throw const FormatException('Invalid payment link');
      }
      if (!await launchUrl(uri, mode: LaunchMode.externalApplication)) {
        throw StateError('Could not open your browser');
      }
      checkoutIds.remove(key);
      if (mounted) {
        setState(
          () => message = kind == 'portal'
              ? 'Your plan, invoices and card are open in your browser.'
              : 'Complete payment in your browser, then return here. Your balance updates once payment is confirmed.',
        );
      }
    } catch (_) {
      if (mounted) {
        setState(
          () => message = 'Couldn’t open payment just now. Check your connection and try again.',
        );
      }
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> _chooseTopUp(List<int> topUps) async {
    final cents = await showDialog<int>(
      context: context,
      builder: (_) => _TopUpDialog(topUps: topUps, initial: topUpCents),
    );
    if (cents == null || !mounted) return;
    setState(() => topUpCents = cents);
    await _openPayment('topup', cents: cents);
  }

  /// Plus takes effect now: it is charged and starts a new billing month, so
  /// it is confirmed first.
  Future<void> _moveToPlus(_Plan plus) async {
    if (busy) return;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Move to Plus?'),
        content: Text(
          'Plus is ${_dollars(plus.monthlyCents)} a month with ${_wholeMicros(plus.includedMicros)} of usage. It starts now: you are charged today and a new billing month begins. Top-ups you have stay yours.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Move to Plus'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    setState(() {
      busy = true;
      message = null;
    });
    const key = 'plan:plus';
    final id = checkoutIds.putIfAbsent(key, randomId);
    try {
      final response = await widget.api.request(
        '/api/billing/plan',
        body: {'id': id, 'plan': 'plus'},
      );
      if (response is! Map || response['plan'] != 'plus') {
        throw const FormatException('Invalid plan response');
      }
      checkoutIds.remove(key);
      if (mounted) {
        setState(
          () =>
              message = 'You’re on Plus. Your new billing month starts today.',
        );
      }
      await _refresh();
    } on RequestFailure catch (error) {
      // A refusal is an answer, not a lost request: the next try is new.
      if (error.status == 409) checkoutIds.remove(key);
      if (mounted) {
        setState(
          () => message = error.status == 409 ? error.message : 'Couldn’t change your plan just now. Check your connection and try again.',
        );
      }
    } catch (_) {
      if (mounted) {
        setState(
          () => message = 'Couldn’t change your plan just now. Check your connection and try again.',
        );
      }
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  List<int> _topUps(Map data) {
    final listed = ((data['plan'] as Map?)?['topUpCents'] as List? ?? const [])
        .whereType<num>()
        .map((c) => c.toInt())
        .toList();
    return listed.isEmpty ? _defaultTopUps : listed;
  }

  @override
  Widget build(BuildContext context) {
    final data = account;
    return Scaffold(
      appBar: DesktopHeader(
        child: AppBar(
          title: const Text('Billing'),
          actions: [
            IconButton(
              onPressed: data == null ? null : () => unawaited(_refresh()),
              icon: const Icon(Icons.refresh_rounded),
              tooltip: 'Refresh balance',
            ),
          ],
        ),
      ),
      body: SafeArea(
        top: false,
        child: data == null
            ? failure == null
                  ? const FrockLoading(label: 'Loading your balance')
                  : FrockEmptyState(
                      icon: Icons.cloud_off_rounded,
                      title: 'Billing couldn’t load',
                      detail: failure!,
                      action: 'Try again',
                      onAction: () => unawaited(_load()),
                    )
            : RefreshIndicator(
                onRefresh: _refresh,
                child: LayoutBuilder(
                  builder: (context, constraints) {
                    final side = constraints.maxWidth > _column + 48
                        ? (constraints.maxWidth - _column) / 2
                        : constraints.maxWidth >= 600
                        ? 24.0
                        : 16.0;
                    return SingleChildScrollView(
                      physics: const AlwaysScrollableScrollPhysics(),
                      padding: EdgeInsets.fromLTRB(side, 12, side, 40),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: _sections(context, data),
                      ),
                    );
                  },
                ),
              ),
      ),
    );
  }

  List<Widget> _sections(BuildContext context, Map<String, dynamic> data) {
    final theme = Theme.of(context);
    final subscription = data['subscription'] as Map?;
    final subscribed = data['subscribed'] == true;
    final trial = subscribed ? null : data['trial'] as Map?;
    final metered = data['metered'] == true;
    final payments = data['paymentsAvailable'] == true;
    final plans = _plans(data);
    final own = _readPlan(data['plan']);
    int micros(String key) => (data[key] as num?)?.toInt() ?? 0;
    // A subscribed account out of credit is told so in its own gauge; this
    // is for an account with no plan to draw on, or one under review.
    final blocked = !metered
        ? null
        : data['suspended'] == true
        ? 'Payments need review. Contact support before starting more paid work.'
        : data['canSpend'] != true && !subscribed
        ? _hadComplimentary(data)
              ? 'Your complimentary credit is used up. Subscribe to keep them working.'
              : 'They reply once you subscribe or receive credit.'
        : null;
    final balance =
        subscribed ||
        trial != null ||
        [
          'includedMicros',
          'complimentaryMicros',
          'purchasedMicros',
          'reservedMicros',
        ].any((key) => micros(key) > 0);
    final topUps = _topUps(data);
    final canTopUp = payments && subscribed && !busy;
    final canMove = payments && subscribed && own.id == 'standard' && !busy;
    return [
      if (message case final String text) _Notice(text),
      if (!payments) const _Notice('Payments are not available yet.'),
      if (blocked != null) ...[
        identified(BillingIds.blocked, _Blocked(reason: blocked)),
        const SizedBox(height: 16),
      ],
      if (balance) ...[
        identified(
          BillingIds.balance,
          _FuelCard(
            fuel: _fuel(data, pace, DateTime.now().millisecondsSinceEpoch),
            data: data,
            plan: own,
            onTopUp: canTopUp ? () => unawaited(_chooseTopUp(topUps)) : null,
            onMoveToPlus: canMove
                ? () => unawaited(_moveToPlus(plans.last))
                : null,
            onPortal: payments && subscription != null && !busy
                ? () => unawaited(_openPayment('portal'))
                : null,
          ),
        ),
        const SizedBox(height: 16),
      ],
      identified(
        BillingIds.plan,
        _PlansCard(
          plans: plans,
          current: subscribed || trial != null ? own.id : null,
          trial: trial != null,
          selling: !subscribed && trial == null && _canSubscribe(subscription),
          payments: payments,
          // A subscription that lapsed or is past due is mended where it
          // is kept, not bought again.
          onChoose:
              !subscribed &&
                  trial == null &&
                  _canSubscribe(subscription) &&
                  payments &&
                  !busy
              ? (id) => unawaited(_openPayment('subscription', plan: id))
              : null,
          onMoveToPlus: canMove
              ? () => unawaited(_moveToPlus(plans.last))
              : null,
          onMend:
              !subscribed &&
                  trial == null &&
                  !_canSubscribe(subscription) &&
                  subscription != null &&
                  payments &&
                  !busy
              ? () => unawaited(_openPayment('portal'))
              : null,
        ),
      ),
      const SizedBox(height: 32),
      KeyedSubtree(
        key: _spendingSection,
        child: identified(
          BillingIds.spending,
          SpendingView(
            key: _spending,
            api: widget.api,
            heading: 'Spending',
            showCredit: false,
            allowanceMicros: spendAllowance(data),
            onCredit: (credit) {
              if (mounted) setState(() => pace = credit);
            },
            onOpenBot: widget.onOpenBot,
          ),
        ),
      ),
      const SizedBox(height: 32),
      identified(
        BillingIds.prices,
        FrockRowGroup(
          rows: [
            FrockRow(
              icon: Icons.sell_outlined,
              title: 'Prices',
              subtitle: _pricesLine(data['computerRate'] as Map?),
              onTap: () => Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => PricesPage(
                    computerRate: data['computerRate'] as Map? ?? const {},
                    modelRates: data['modelRates'] as Map? ?? const {},
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
      const SizedBox(height: 16),
      Text(
        'Prices in US dollars. Tax is shown at checkout.',
        textAlign: TextAlign.center,
        style: theme.textTheme.bodySmall?.copyWith(
          color: theme.colorScheme.onSurfaceVariant,
        ),
      ),
    ];
  }

  static bool _canSubscribe(Map? subscription) =>
      subscription == null ||
      {'canceled', 'incomplete_expired'}.contains(subscription['status']);

  static bool _hadComplimentary(Map data) =>
      (data['payments'] as List? ?? const []).whereType<Map>().any(
        (grant) => grant['kind'] == 'complimentary',
      );

  static String _pricesLine(Map? rate) => rate?['activeUsdPerHour'] == null
      ? 'Computer time and hosted model rates'
      : 'Computer US\$${_rate(rate!['activeUsdPerHour'] as num)} per active hour · hosted model rates';
}

/// A price as it is quoted: two places, or three when a fraction of a cent
/// matters.
String _rate(num value) {
  final three = value.toStringAsFixed(3);
  return three.endsWith('0') ? value.toStringAsFixed(2) : three;
}

/// A quiet line about the last thing the person did, or what the page can't
/// do just now.
class _Notice extends StatelessWidget {
  final String text;
  const _Notice(this.text);

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: Semantics(
        liveRegion: true,
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(
              Icons.info_outline_rounded,
              size: 18,
              color: theme.colorScheme.onSurfaceVariant,
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                text,
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Why the account's Bots cannot reply, first, in red.
class _Blocked extends StatelessWidget {
  final String reason;
  const _Blocked({required this.reason});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    // A tint of the error colour, so the card reads as red on either ground
    // without shouting over the page.
    final ink = scheme.error;
    return Semantics(
      container: true,
      liveRegion: true,
      child: Container(
        padding: const EdgeInsets.all(18),
        decoration: BoxDecoration(
          color: ink.withValues(alpha: 0.14),
          borderRadius: BorderRadius.circular(FrockTheme.radiusCard),
          border: Border.all(color: scheme.error.withValues(alpha: 0.4)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.error_outline_rounded, size: 20, color: ink),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    'Your Bots can’t reply',
                    style: theme.textTheme.titleSmall?.copyWith(
                      color: ink,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 6),
            Text(
              reason,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: scheme.onSurface.withValues(alpha: 0.85),
                height: 1.45,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

enum _Tone { calm, warn, stop }

/// What the gauge says: one large answer, the line under it, the bar, and
/// whether it runs out before the plan renews.
class _Fuel {
  final String lead;
  final _Tone leadTone;
  final String? caption;

  /// Null where there is no allowance to measure against.
  final ({double left, double held, double? pace})? gauge;
  final String? pace;
  final _Tone paceTone;

  /// Top up and Move to Plus sit beside the answer: credit is short.
  final bool short;
  final List<String> notes;
  const _Fuel({
    required this.lead,
    this.leadTone = _Tone.calm,
    this.caption,
    this.gauge,
    this.pace,
    this.paceTone = _Tone.calm,
    this.short = false,
    this.notes = const [],
  });
}

/// Whether the account has a week of history, so the last seven days' pace
/// says something about the rest of the month.
bool _hasWeek(Map data, int now) {
  final created = (data['payments'] as List? ?? const [])
      .whereType<Map>()
      .map((grant) => grant['created'])
      .whereType<num>();
  return created.isNotEmpty && created.reduce(math.min) <= now - 7 * _day;
}

/// The billing month that ends at [end]: one calendar month before it.
int _monthBefore(int end) {
  final at = DateTime.fromMillisecondsSinceEpoch(end);
  return DateTime(
    at.year,
    at.month - 1,
    at.day,
    at.hour,
    at.minute,
  ).millisecondsSinceEpoch;
}

String _percent(num part, num whole) =>
    '${whole > 0 ? (part / whole * 100).clamp(0, 100).round() : 0}%';

_Fuel _fuel(Map data, Map? credit, int now) {
  int micros(String key) => (data[key] as num?)?.toInt() ?? 0;
  final subscribed = data['subscribed'] == true;
  final trial = subscribed ? null : data['trial'] as Map?;
  final subscription = data['subscription'] as Map?;
  final plan = _readPlan(data['plan']);
  final end =
      ((subscription?['periodEnd'] ??
                  (data['paidAccess'] as Map?)?['periodEnd'])
              as num?)
          ?.toInt();
  final ending = subscription?['cancelAtPeriodEnd'] == true;
  final included = micros('includedMicros');
  final purchased = micros('purchasedMicros');
  final complimentary = micros('complimentaryMicros');
  final held = micros('reservedMicros');
  final runsOut = (credit?['runsOutAt'] as num?)?.toInt();

  ({double left, double held, double? pace}) gauge(
    int left,
    int whole, {
    int? start,
    int? until,
  }) {
    double share(int part) => whole > 0 ? (part / whole).clamp(0, 1) : 0;
    return (
      left: share(left),
      held: share(math.min(held, left)),
      pace: start == null || until == null || until <= start
          ? null
          : ((until - now) / (until - start)).clamp(0, 1).toDouble(),
    );
  }

  final reserve = [
    if (purchased > 0)
      '+ ${_money(purchased)} in reserve · used after this month’s runs out · never expires',
    if (complimentary > 0 && trial == null)
      '+ ${_money(complimentary)} complimentary credit from ${clientBrand.productName}',
  ];

  if (trial != null) {
    final endsAt = (trial['endsAt'] as num?)?.toInt() ?? now;
    final whole = (trial['creditMicros'] as num?)?.toInt() ?? 0;
    final days = math.max(0, ((endsAt - now) / _day).ceil());
    return _Fuel(
      lead: 'Trial · $days ${days == 1 ? 'day' : 'days'} left',
      caption:
          '${_percent(complimentary, whole)} of your trial credit left. ${plan.name} begins ${spendDate(endsAt)}.',
      gauge: gauge(
        complimentary,
        whole,
        start: endsAt - 7 * _day,
        until: endsAt,
      ),
      notes: reserve,
    );
  }

  if (!subscribed) {
    return _Fuel(
      lead: complimentary > 0
          ? '${_money(complimentary)} of complimentary credit'
          : 'No plan',
      caption: complimentary > 0
          ? 'From ${clientBrand.productName}. Spendable without a subscription.'
          : null,
      notes: [
        if (purchased > 0)
          '${_money(purchased)} of top-up credit · used once you subscribe again · never expires',
      ],
    );
  }

  final renews = end == null ? '' : spendDate(end);
  final start = end == null ? null : _monthBefore(end);
  if (included + purchased + complimentary <= 0) {
    return _Fuel(
      lead: end == null ? 'Paused' : 'Paused until $renews',
      leadTone: _Tone.stop,
      caption: 'This month’s allowance is used up. Top up to keep your Bots working now.',
      gauge: gauge(0, plan.includedMicros),
      short: true,
    );
  }

  // Past the date the plan renews, the pace says nothing about running out.
  final knowsPace = credit != null && _hasWeek(data, now);
  final lasts = runsOut == null || (end != null && runsOut >= end);
  final pace = !knowsPace
      ? null
      : lasts
      ? end == null
            ? null
            : 'Lasts until your plan ${ending ? 'ends' : 'renews'} on $renews'
      : 'At your pace, runs out around ${spendDate(runsOut)}';
  final short = knowsPace && !lasts;

  if (included <= 0) {
    return _Fuel(
      lead: '${_money(purchased + complimentary)} of top-up left',
      caption: end == null
          ? 'This month’s allowance is used.'
          : 'This month’s allowance is used. It renews on $renews.',
      gauge: gauge(0, plan.includedMicros, start: start, until: end),
      pace: short ? pace : null,
      paceTone: _Tone.warn,
      short: short,
    );
  }

  return _Fuel(
    lead: '${_percent(included, plan.includedMicros)} left',
    caption: 'of this month’s ${plan.name} plan',
    gauge: gauge(included, plan.includedMicros, start: start, until: end),
    pace: pace,
    paceTone: short ? _Tone.warn : _Tone.calm,
    short: short,
    notes: reserve,
  );
}

Color _ink(BuildContext context, _Tone tone) {
  final theme = Theme.of(context);
  final dark = theme.brightness == Brightness.dark;
  return switch (tone) {
    _Tone.calm => theme.colorScheme.onSurface,
    _Tone.warn => dark ? FrockTheme.warning : FrockTheme.warningInk,
    _Tone.stop => theme.colorScheme.error,
  };
}

/// Billing's first answer: how much of this month's plan is left, and
/// whether it lasts.
class _FuelCard extends StatelessWidget {
  final _Fuel fuel;
  final Map<String, dynamic> data;
  final _Plan plan;
  final VoidCallback? onTopUp;
  final VoidCallback? onMoveToPlus;
  final VoidCallback? onPortal;
  const _FuelCard({
    required this.fuel,
    required this.data,
    required this.plan,
    required this.onTopUp,
    required this.onMoveToPlus,
    required this.onPortal,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.colorScheme.onSurfaceVariant;
    final subscribed = data['subscribed'] == true;
    final subscription = data['subscription'] as Map?;
    final periodEnd =
        (subscription?['periodEnd'] ??
                (data['paidAccess'] as Map?)?['periodEnd'])
            as num?;
    final ending = subscription?['cancelAtPeriodEnd'] == true;
    final held = (data['reservedMicros'] as num? ?? 0) > 0;
    final pill = subscribed
        ? _Pill(
            periodEnd == null
                ? plan.name
                : '${plan.name} · ${ending ? 'ends' : 'renews'} ${spendDate(periodEnd)}',
          )
        : null;
    final more = [
      if (onTopUp != null)
        OutlinedButton(onPressed: onTopUp, child: const Text('Top up')),
      if (onMoveToPlus != null)
        FilledButton(
          onPressed: onMoveToPlus,
          child: const Text('Move to Plus'),
        ),
    ];
    final portal = onPortal == null
        ? null
        : TextButton.icon(
            onPressed: onPortal,
            iconAlignment: IconAlignment.end,
            icon: const Icon(Icons.north_east_rounded, size: 16),
            label: const Text('Plan, invoices & card'),
          );
    return Card(
      margin: EdgeInsets.zero,
      child: LayoutBuilder(
        builder: (context, constraints) {
          final wide = constraints.maxWidth >= 560;
          final pad = wide ? 24.0 : 18.0;
          final lead = Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                fuel.lead,
                style: theme.textTheme.headlineLarge?.copyWith(
                  fontSize: 34,
                  fontWeight: FontWeight.w700,
                  letterSpacing: -0.8,
                  color: _ink(context, fuel.leadTone),
                  fontFeatures: FrockTheme.tabularFigures,
                ),
              ),
              if (fuel.caption case final String caption) ...[
                const SizedBox(height: 2),
                Text(
                  caption,
                  style: theme.textTheme.bodyMedium?.copyWith(color: muted),
                ),
              ],
            ],
          );
          final paceLine = fuel.pace == null
              ? null
              : Text(
                  fuel.pace!,
                  style: theme.textTheme.titleSmall?.copyWith(
                    color: _ink(context, fuel.paceTone),
                    fontWeight: FontWeight.w600,
                  ),
                );
          // Short of credit, what adds more sits beside what says so.
          final beside = fuel.short && more.isNotEmpty;
          final answer = fuel.pace == null && !beside
              ? null
              : wide
              ? Row(
                  children: [
                    Expanded(child: paceLine ?? const SizedBox()),
                    if (beside)
                      for (final button in more) ...[
                        const SizedBox(width: 10),
                        button,
                      ],
                  ],
                )
              : Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    ?paceLine,
                    if (beside) ...[
                      if (paceLine != null) const SizedBox(height: 10),
                      Wrap(spacing: 10, runSpacing: 10, children: more),
                    ],
                  ],
                );
          // Plus is offered from the plan card until credit runs short.
          final actions = [
            if (!beside && onTopUp != null)
              OutlinedButton(onPressed: onTopUp, child: const Text('Top up')),
            ?portal,
          ];
          return Padding(
            padding: EdgeInsets.all(pad),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (wide)
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(child: lead),
                      ?pill,
                    ],
                  )
                else ...[
                  if (pill != null) ...[
                    Align(alignment: Alignment.centerLeft, child: pill),
                    const SizedBox(height: 12),
                  ],
                  lead,
                ],
                if (fuel.gauge case final gauge?) ...[
                  const SizedBox(height: 16),
                  _Gauge(
                    left: gauge.left,
                    held: gauge.held,
                    pace: gauge.pace,
                    tone: fuel.paceTone,
                  ),
                ],
                if (answer != null) ...[const SizedBox(height: 14), answer],
                for (final note in fuel.notes) ...[
                  const SizedBox(height: 8),
                  Text(
                    note,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: muted,
                      fontSize: 12.5,
                    ),
                  ),
                ],
                if (actions.isNotEmpty) ...[
                  const SizedBox(height: 16),
                  Wrap(
                    spacing: 10,
                    runSpacing: 10,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    children: actions,
                  ),
                ],
                const SizedBox(height: 18),
                Divider(
                  height: 1,
                  color: FrockTheme.hairline(theme.colorScheme),
                ),
                const SizedBox(height: 14),
                Text(
                  [
                    'Hosted models and your Bots’ Computers draw on your plan. When it runs out, new work pauses; there is never an overage charge.',
                    if (held && fuel.gauge != null) 'The lighter part of the bar is held for work still running.',
                  ].join(' '),
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: muted,
                    fontSize: 12.5,
                    height: 1.5,
                  ),
                ),
              ],
            ),
          );
        },
      ),
    );
  }
}

/// The share of the allowance left, what of it is held for running work, and
/// a tick where an even pace through the month would be.
class _Gauge extends StatelessWidget {
  final double left;
  final double held;
  final double? pace;
  final _Tone tone;
  const _Gauge({
    required this.left,
    required this.held,
    required this.pace,
    required this.tone,
  });

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final fill = tone == _Tone.warn ? _ink(context, tone) : scheme.primary;
    final free = math.max(0.0, left - held);
    return Semantics(
      container: true,
      label: [
        '${(left * 100).round()}% left',
        if (held > 0) '${(held * 100).round()}% of it held for work running',
        if (pace != null) 'an even pace would leave ${(pace! * 100).round()}%',
      ].join(', '),
      child: ExcludeSemantics(
        child: SizedBox(
          height: 18,
          child: LayoutBuilder(
            builder: (context, constraints) {
              final width = constraints.maxWidth;
              return Stack(
                clipBehavior: Clip.none,
                children: [
                  Positioned(
                    left: 0,
                    right: 0,
                    top: 4,
                    height: 10,
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(5),
                      child: Stack(
                        children: [
                          Positioned.fill(
                            child: ColoredBox(
                              color: scheme.onSurface.withValues(alpha: 0.08),
                            ),
                          ),
                          Positioned(
                            left: 0,
                            top: 0,
                            bottom: 0,
                            width: width * free,
                            child: ColoredBox(color: fill),
                          ),
                          Positioned(
                            left: width * free,
                            top: 0,
                            bottom: 0,
                            width: width * (left - free),
                            child: ColoredBox(
                              color: fill.withValues(alpha: 0.4),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                  if (pace != null)
                    Positioned(
                      left: (width * pace! - 1).clamp(0, width - 2),
                      top: 0,
                      bottom: 0,
                      width: 2,
                      child: DecoratedBox(
                        decoration: BoxDecoration(
                          color: scheme.onSurface.withValues(alpha: 0.7),
                          borderRadius: BorderRadius.circular(1),
                        ),
                      ),
                    ),
                ],
              );
            },
          ),
        ),
      ),
    );
  }
}

class _Pill extends StatelessWidget {
  final String text;
  const _Pill(this.text);

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    final ink = dark ? FrockTheme.success : FrockTheme.successInk;
    return Container(
      height: 30,
      padding: const EdgeInsets.symmetric(horizontal: 12),
      decoration: BoxDecoration(
        color: ink.withValues(alpha: 0.16),
        borderRadius: BorderRadius.circular(FrockTheme.radiusPill),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.check_rounded, size: 15, color: ink),
          const SizedBox(width: 6),
          Flexible(
            child: Text(
              text,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                color: ink,
                fontSize: 12.5,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// One of the plan's top-up amounts, bought in the browser.
class _TopUpDialog extends StatefulWidget {
  final List<int> topUps;
  final int initial;
  const _TopUpDialog({required this.topUps, required this.initial});

  @override
  State<_TopUpDialog> createState() => _TopUpDialogState();
}

class _TopUpDialogState extends State<_TopUpDialog> {
  late int cents = widget.initial;

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('Top up'),
    content: Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text(
          'Top-up credit is used after this month’s allowance runs out, and never expires.',
        ),
        const SizedBox(height: 16),
        FrockSegmented(
          label: 'Top-up amount',
          selected: '$cents',
          options: [
            for (final amount in widget.topUps)
              (slug: '$amount', label: _dollars(amount)),
          ],
          onChosen: (slug) => setState(() => cents = int.parse(slug)),
        ),
      ],
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.of(context).pop(),
        child: const Text('Cancel'),
      ),
      FilledButton(
        onPressed: () => Navigator.of(context).pop(cents),
        child: Text('Add ${_dollars(cents)}'),
      ),
    ],
  );
}

/// Standard beside Plus, described by how much room each gives the account's
/// Bots; the credit behind it is the small print.
class _PlansCard extends StatelessWidget {
  final List<_Plan> plans;

  /// The plan the account is on, or null without one.
  final String? current;
  final bool trial;

  /// The account can take a plan here, whether or not payments are open.
  final bool selling;
  final bool payments;
  final void Function(String id)? onChoose;
  final VoidCallback? onMoveToPlus;
  final VoidCallback? onMend;
  const _PlansCard({
    required this.plans,
    required this.current,
    required this.trial,
    required this.selling,
    required this.payments,
    required this.onChoose,
    required this.onMoveToPlus,
    required this.onMend,
  });

  String _room(_Plan plan) {
    final base = plans.first.includedMicros;
    if (plan.id == 'standard' || base <= 0) {
      return 'Room for everyday chats and a few Routines.';
    }
    final times = plan.includedMicros / base;
    final label = times == times.roundToDouble()
        ? '${times.round()}'
        : times.toStringAsFixed(1);
    return '$label× the room, for Bots and Routines that work all day.';
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.colorScheme.onSurfaceVariant;
    return Card(
      margin: EdgeInsets.zero,
      child: LayoutBuilder(
        builder: (context, constraints) {
          final wide = constraints.maxWidth >= 560;
          final tiles = [for (final plan in plans) _tile(context, plan, wide)];
          return Padding(
            padding: EdgeInsets.all(wide ? 24 : 18),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  selling ? 'Choose a plan' : 'Plans',
                  style: theme.textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 14),
                if (wide)
                  IntrinsicHeight(
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        for (var i = 0; i < tiles.length; i++) ...[
                          if (i > 0) const SizedBox(width: 12),
                          Expanded(child: tiles[i]),
                        ],
                      ],
                    ),
                  )
                else
                  for (var i = 0; i < tiles.length; i++) ...[
                    if (i > 0) const SizedBox(height: 10),
                    tiles[i],
                  ],
                if (onMend != null) ...[
                  const SizedBox(height: 16),
                  Align(
                    alignment: Alignment.centerLeft,
                    child: FilledButton.icon(
                      onPressed: onMend,
                      iconAlignment: IconAlignment.end,
                      icon: const Icon(Icons.north_east_rounded, size: 16),
                      label: const Text('Plan, invoices & card'),
                    ),
                  ),
                ],
                const SizedBox(height: 14),
                Text(
                  !payments
                      ? 'Payments are not available yet.'
                      : onMend != null
                      ? 'Your subscription needs attention. Fix it in your browser.'
                      : selling
                      ? 'A first subscription starts with a 7-day trial. Checkout opens in your browser and asks for a card. Cancel any time.'
                      : 'Top-ups never expire, and work pauses rather than running up an overage.',
                  style: theme.textTheme.bodySmall?.copyWith(color: muted),
                ),
              ],
            ),
          );
        },
      ),
    );
  }

  Widget _tile(BuildContext context, _Plan plan, bool wide) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final muted = theme.textTheme.bodySmall?.copyWith(
      color: scheme.onSurfaceVariant,
      fontSize: 12.5,
    );
    final mine = plan.id == current;
    final Widget? action = selling
        ? FilledButton(
            onPressed: onChoose == null ? null : () => onChoose!(plan.id),
            child: Text('Choose ${plan.name}'),
          )
        : plan.id == 'plus' && onMoveToPlus != null
        ? FilledButton(
            onPressed: onMoveToPlus,
            child: const Text('Move to Plus'),
          )
        : null;
    final String? after = plan.id == 'plus' && onMoveToPlus != null
        ? 'Starts now, with a new billing month.'
        : plan.id == 'standard' && current == 'plus' && !trial
        ? 'Move back at renewal, from Plan, invoices & card.'
        : null;
    return Semantics(
      container: true,
      child: Container(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 16),
        decoration: BoxDecoration(
          color: scheme.onSurface.withValues(alpha: 0.04),
          borderRadius: BorderRadius.circular(FrockTheme.radiusControl),
          border: Border.all(
            color: mine ? scheme.primary : FrockTheme.hairline(scheme),
            width: mine ? 1.5 : 1,
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    plan.name,
                    style: theme.textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                if (mine)
                  Text(
                    trial ? 'Your plan · trial' : 'Your plan',
                    style: theme.textTheme.labelMedium?.copyWith(
                      color: scheme.primary,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
              ],
            ),
            const SizedBox(height: 4),
            Row(
              crossAxisAlignment: CrossAxisAlignment.baseline,
              textBaseline: TextBaseline.alphabetic,
              children: [
                Text(
                  _dollars(plan.monthlyCents),
                  style: theme.textTheme.headlineSmall?.copyWith(
                    fontWeight: FontWeight.w700,
                    letterSpacing: -0.4,
                  ),
                ),
                const SizedBox(width: 4),
                Text('/ month', style: muted),
              ],
            ),
            const SizedBox(height: 8),
            Text(
              _room(plan),
              style: theme.textTheme.bodyMedium?.copyWith(height: 1.4),
            ),
            const SizedBox(height: 6),
            Text(
              '${_wholeMicros(plan.includedMicros)} of usage included each month',
              style: muted,
            ),
            // Side by side, the buttons line up along the bottom.
            if (wide && (action != null || after != null)) const Spacer(),
            if (action != null) ...[
              const SizedBox(height: 14),
              SizedBox(width: double.infinity, child: action),
            ],
            if (after != null) ...[
              const SizedBox(height: 8),
              Text(after, style: muted),
            ],
          ],
        ),
      ),
    );
  }
}

/// What things cost: a Computer's time, and each hosted model's tokens.
class PricesPage extends StatelessWidget {
  final Map computerRate;
  final Map modelRates;
  const PricesPage({
    super.key,
    required this.computerRate,
    required this.modelRates,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(
      color: theme.colorScheme.onSurfaceVariant,
      fontSize: 12.5,
    );
    final figures = theme.textTheme.bodyMedium?.copyWith(
      fontFeatures: FrockTheme.tabularFigures,
    );
    return Scaffold(
      appBar: DesktopHeader(child: AppBar(title: const Text('Prices'))),
      body: SafeArea(
        top: false,
        child: LayoutBuilder(
          builder: (context, constraints) {
            final wide = constraints.maxWidth >= 600;
            final side = constraints.maxWidth > _column + 48
                ? (constraints.maxWidth - _column) / 2
                : wide
                ? 24.0
                : 16.0;
            final rates = modelRates.entries.toList();
            return ListView(
              padding: EdgeInsets.fromLTRB(side, 4, side, 40),
              children: [
                const FrockSectionLabel('Computer'),
                if (computerRate.isEmpty)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(12, 0, 12, 0),
                    child: Text(
                      'Computer prices are unavailable just now.',
                      style: muted,
                    ),
                  )
                else
                  FrockRowGroup(
                    indent: 14,
                    rows: [
                      FrockRow(
                        title: 'Active time',
                        trailing: Text(
                          'US\$${_rate(computerRate['activeUsdPerHour'] as num? ?? 0)} an hour',
                          style: figures,
                        ),
                      ),
                      FrockRow(
                        title: 'Storage while idle',
                        trailing: Text(
                          'Up to ${computerRate['storageIncludedGb']} GB included',
                          style: figures,
                        ),
                      ),
                      FrockRow(
                        title: 'Watching it',
                        subtitle:
                            'Opening the viewer holds ${computerRate['viewerOpenSeconds']} seconds; it renews every ${computerRate['viewerRenewSeconds']} seconds while you watch.',
                      ),
                    ],
                  ),
                const FrockSectionLabel('Hosted models'),
                Padding(
                  padding: const EdgeInsets.fromLTRB(12, 0, 12, 10),
                  child: Text(
                    'US dollars per million tokens. A call is charged at the rate of the model that answered it, never more than the rate of the one it asked for. Your own provider sets its own prices.',
                    style: muted,
                  ),
                ),
                if (rates.isEmpty)
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 12),
                    child: Text(
                      'Model prices are unavailable just now.',
                      style: muted,
                    ),
                  )
                else
                  FrockRowGroup(
                    indent: 14,
                    rows: [
                      for (final entry in rates)
                        _modelRow(
                          '${entry.key}',
                          entry.value as Map,
                          wide: wide,
                          figures: figures,
                          muted: muted?.copyWith(fontSize: 11.5),
                        ),
                    ],
                  ),
              ],
            );
          },
        ),
      ),
    );
  }

  Widget _modelRow(
    String model,
    Map rate, {
    required bool wide,
    TextStyle? figures,
    TextStyle? muted,
  }) {
    String price(String key) => 'US\$${_rate(rate[key] as num? ?? 0)}';
    if (!wide) {
      return FrockRow(
        title: model,
        subtitle:
            'Input ${price('inputUsdPerMillion')} · cached ${price('cachedInputUsdPerMillion')} · output ${price('outputUsdPerMillion')}',
      );
    }
    Widget cell(String label, String key) => SizedBox(
      width: 110,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Text(price(key), style: figures),
          Text(label, style: muted),
        ],
      ),
    );
    return FrockRow(
      title: model,
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          cell('input', 'inputUsdPerMillion'),
          cell('cached', 'cachedInputUsdPerMillion'),
          cell('output', 'outputUsdPerMillion'),
        ],
      ),
    );
  }
}
