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

/// The monthly subscriptions the deployment sells, cheapest first.
List<_Plan> _plans(Map data) => [
  for (final plan
      in ((data['plan'] as Map?)?['subscriptions'] as List? ?? const [])
          .whereType<Map>())
    (
      id: '${plan['id']}',
      name: '${plan['name']}',
      monthlyCents: (plan['monthlyCents'] as num?)?.toInt() ?? 0,
      includedMicros: (plan['includedMicros'] as num?)?.toInt() ?? 0,
    ),
];

/// The plan the account's subscription is on, trialling or paid. A
/// subscription recorded before plans had ids is on the first, until its next
/// provider event names one.
_Plan? _ownPlan(Map data, List<_Plan> plans) {
  final subscription = data['subscription'] as Map?;
  if (subscription == null) return null;
  final id = subscription['planId'];
  return id == null
      ? plans.firstOrNull
      : plans.where((plan) => plan.id == id).firstOrNull;
}

/// What the payments Package offers the account for [purpose], and for
/// [plan] where it names one.
List<Map> _actions(Map data, String purpose) =>
    (data['actions'] as List? ?? const [])
        .whereType<Map>()
        .where((action) => action['purpose'] == purpose)
        .toList();

Map? _action(Map data, String purpose, {String? plan}) => _actions(
  data,
  purpose,
).where((action) => plan == null || action['plan'] == plan).firstOrNull;

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
        if (tops.isNotEmpty && !tops.contains(topUpCents)) {
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

  /// Takes one of the payments Package's actions: opens its page, or asks
  /// the Package's route for one as the signed-in person and opens that.
  Future<void> _openPayment(Map action, {int? cents}) async {
    if (busy) return;
    setState(() {
      busy = true;
      message = null;
    });
    final purpose = action['purpose'];
    final key = '$purpose:${action['plan'] ?? ''}:${cents ?? 0}';
    final id = checkoutIds.putIfAbsent(key, randomId);
    final inApp = action['opens'] == 'in-app';
    try {
      final target = action['target'] as Map;
      final Object? link;
      if (target['kind'] == 'url') {
        link = target['url'];
      } else {
        final response = await widget.api.request(
          target['path'] as String,
          body: {
            'id': id,
            ...(target['body'] as Map? ?? const {}),
            'cents': ?cents,
          },
        );
        link = response is Map ? response['url'] : null;
      }
      if (link is! String) {
        throw const FormatException('Payment link is unavailable');
      }
      final origin = Uri.parse(hostedOrigin);
      final uri = origin.resolve(link);
      final hosts = (action['hosts'] as List? ?? const []).whereType<String>();
      if (uri.origin != origin.origin &&
          (uri.scheme != 'https' || !hosts.contains(uri.host))) {
        throw const FormatException('Invalid payment link');
      }
      if (!await launchUrl(
        uri,
        mode: inApp
            ? LaunchMode.inAppBrowserView
            : LaunchMode.externalApplication,
      )) {
        throw StateError('Could not open your browser');
      }
      checkoutIds.remove(key);
      if (mounted && !inApp) {
        setState(
          () => message = purpose == 'manage'
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

  Future<void> _chooseTopUp(Map action, List<int> topUps) async {
    if (topUps.isEmpty) return _openPayment(action);
    final cents = await showDialog<int>(
      context: context,
      builder: (_) => _TopUpDialog(
        topUps: topUps,
        initial: topUpCents,
        label: action['label'] as String? ?? 'Add',
      ),
    );
    if (cents == null || !mounted) return;
    setState(() => topUpCents = cents);
    await _openPayment(action, cents: cents);
  }

  /// A plan change charges now (a move up, or starting early from a trial)
  /// or at renewal (a move down), so it is confirmed first. It answers the
  /// plan it moved to, and Billing shows it rather than opening a page.
  Future<void> _changePlan(Map action, _Plan to, _Plan? from) async {
    if (busy) return;
    final data = account ?? const {};
    final trialing = data['trial'] is Map;
    final up = from == null || to.includedMicros > from.includedMicros;
    final renews = (data['subscription'] as Map?)?['periodEnd'] as num?;
    final label = action['label'] as String? ?? 'Move to ${to.name}';
    final terms = trialing
        ? 'This ends your trial and charges ${to.name}’s first month, ${_dollars(to.monthlyCents)}, now. A new billing month begins today.'
        : up
        ? '${to.name} is ${_dollars(to.monthlyCents)} a month with ${_wholeMicros(to.includedMicros)} of usage. It starts now: you are charged today and a new billing month begins. Top-ups you have stay yours.'
        : '${to.name} is ${_dollars(to.monthlyCents)} a month with ${_wholeMicros(to.includedMicros)} of usage. You stay on ${from.name} until your plan renews${renews == null ? '' : ' on ${spendDate(renews)}'}.';
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('$label?'),
        content: Text(terms),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: Text(label),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    setState(() {
      busy = true;
      message = null;
    });
    final key = 'change-plan:${to.id}';
    final id = checkoutIds.putIfAbsent(key, randomId);
    const lost =
        'Couldn’t change your plan just now. Check your connection and try again.';
    try {
      final target = action['target'] as Map;
      final response = await widget.api.request(
        target['path'] as String,
        body: {'id': id, ...(target['body'] as Map? ?? const {})},
      );
      if (response is! Map || response['plan'] != to.id) {
        throw const FormatException('Invalid plan response');
      }
      checkoutIds.remove(key);
      if (mounted) {
        setState(
          () => message = trialing
              ? 'Your ${to.name} plan has started. Your new billing month starts today.'
              : up
              ? 'You’re on ${to.name}. Your new billing month starts today.'
              : 'You’ll move to ${to.name} when your plan renews.',
        );
      }
      await _refresh();
    } on RequestFailure catch (error) {
      // A refusal is an answer, not a lost request: the next try is new.
      if (error.status == 409) checkoutIds.remove(key);
      if (mounted) {
        setState(() => message = error.status == 409 ? error.message : lost);
      }
    } catch (_) {
      if (mounted) setState(() => message = lost);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  List<int> _topUps(Map data) =>
      ((data['plan'] as Map?)?['topUpCents'] as List? ?? const [])
          .whereType<num>()
          .map((c) => c.toInt())
          .toList();

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
    final own = _ownPlan(data, plans);
    final tops = _topUps(data);
    final topUp = _action(data, 'top-up');
    final manage = _action(data, 'manage');
    int micros(String key) => (data[key] as num?)?.toInt() ?? 0;
    VoidCallback? take(Map? action, void Function(Map action) run) =>
        action != null && payments && !busy ? () => run(action) : null;
    VoidCallback? change(_Plan to) => take(
      _action(data, 'change-plan', plan: to.id),
      (action) => unawaited(_changePlan(action, to, own)),
    );
    // Credit short: the plan with more room is offered beside the answer.
    final bigger = own == null || trial != null
        ? null
        : plans
              .where((plan) => plan.includedMicros > own.includedMicros)
              .where(
                (plan) => _action(data, 'change-plan', plan: plan.id) != null,
              )
              .firstOrNull;
    // A subscribed account out of credit is told so in its own gauge; this
    // is for an account with no plan to draw on, or one under review.
    final blocked = !metered
        ? null
        : data['suspended'] == true
        ? 'Payments need review. Contact support before starting more paid work.'
        : data['canSpend'] != true && !subscribed && trial == null
        ? plans.isEmpty
              ? _hadComplimentary(data)
                    ? 'Your complimentary credit is used up. Add credit to keep them working.'
                    : 'They reply once you add credit.'
              : _hadComplimentary(data)
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
    final needsSubscription =
        (data['plan'] as Map?)?['purchasedCreditNeedsSubscription'] != false;
    return [
      if (message case final String text) _Notice(text),
      // A deployment with no payment provider sells nothing, so there is
      // nothing to be unavailable.
      if (!payments && data['paymentsProvider'] != null)
        const _Notice('Payments are not available yet.'),
      if (blocked != null) ...[
        identified(BillingIds.blocked, _Blocked(reason: blocked)),
        const SizedBox(height: 16),
      ],
      if (balance) ...[
        identified(
          BillingIds.balance,
          _FuelCard(
            fuel: _fuel(
              data,
              pace,
              DateTime.now().millisecondsSinceEpoch,
              plan: own,
              needsSubscription: needsSubscription,
            ),
            data: data,
            plan: own,
            onTopUp: take(
              topUp,
              (action) => unawaited(_chooseTopUp(action, tops)),
            ),
            moveLabel: bigger == null
                ? null
                : _action(data, 'change-plan', plan: bigger.id)?['label']
                      as String?,
            onMove: bigger == null ? null : change(bigger),
            portalLabel: manage?['label'] as String? ?? '',
            onPortal: take(manage, (action) => unawaited(_openPayment(action))),
          ),
        ),
        const SizedBox(height: 16),
      ],
      if (plans.isNotEmpty) ...[
        identified(
          BillingIds.plan,
          _PlansCard(
            plans: [
              // Only what the account is on or can buy: a plan the Package
              // offers no way to take is not for sale here.
              for (final plan in plans)
                if (plan.id == own?.id ||
                    _action(data, 'subscribe', plan: plan.id) != null ||
                    _action(data, 'change-plan', plan: plan.id) != null ||
                    ![
                      ..._actions(data, 'subscribe'),
                      ..._actions(data, 'change-plan'),
                    ].any((action) => action['plan'] != null))
                  plan,
            ],
            current: subscribed || trial != null ? own?.id : null,
            trial: trial != null,
            payments: payments,
            actionFor: (plan) =>
                _action(data, 'subscribe', plan: plan.id) ??
                _action(data, 'change-plan', plan: plan.id),
            onAction: (plan, action) => action['purpose'] == 'subscribe'
                ? take(action, (action) => unawaited(_openPayment(action)))
                : change(plan),
            upFrom: own,
            // A subscription that lapsed or is past due is mended where it
            // is kept, not bought again: the Package offers no subscribe.
            mendLabel: manage?['label'] as String? ?? '',
            onMend:
                !subscribed &&
                    trial == null &&
                    subscription != null &&
                    _actions(data, 'subscribe').isEmpty
                ? take(manage, (action) => unawaited(_openPayment(action)))
                : null,
            topUps: tops.isNotEmpty,
          ),
        ),
        const SizedBox(height: 16),
      ],
      const SizedBox(height: 16),
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

_Fuel _fuel(
  Map data,
  Map? credit,
  int now, {
  required _Plan? plan,
  required bool needsSubscription,
}) {
  int micros(String key) => (data[key] as num?)?.toInt() ?? 0;
  final subscribed = data['subscribed'] == true;
  final trial = subscribed ? null : data['trial'] as Map?;
  final subscription = data['subscription'] as Map?;
  // Every monthly allowance still live, as granted: after a move down the
  // paid month of the bigger plan runs to renewal, and after a move up the old
  // month's credit sits beside the new one.
  final granted = micros('includedGrantedMicros');
  final allowance = granted > 0 ? granted : plan?.includedMicros ?? 0;
  final trialDays =
      ((data['plan'] as Map?)?['trial'] as Map?)?['days'] as num? ?? 7;
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
          '${_percent(complimentary, whole)} of your trial credit left. ${plan?.name ?? 'Your plan'} begins ${spendDate(endsAt)}.',
      gauge: gauge(
        complimentary,
        whole,
        start: endsAt - (trialDays * _day).round(),
        until: endsAt,
      ),
      notes: reserve,
    );
  }

  // Where purchased credit stands on its own, it is simply credit.
  if (!subscribed && !needsSubscription) {
    return _Fuel(lead: '${_money(complimentary + purchased)} of credit');
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
      gauge: gauge(0, allowance),
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
      gauge: gauge(0, allowance, start: start, until: end),
      pace: short ? pace : null,
      paceTone: _Tone.warn,
      short: short,
    );
  }

  return _Fuel(
    lead: '${_percent(included, allowance)} left',
    caption: plan == null
        ? 'of this month’s plan'
        : 'of this month’s ${plan.name} plan',
    gauge: gauge(included, allowance, start: start, until: end),
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
  final _Plan? plan;
  final VoidCallback? onTopUp;

  /// The payments Package's words for moving to the plan with more room.
  final String? moveLabel;
  final VoidCallback? onMove;
  final String portalLabel;
  final VoidCallback? onPortal;
  const _FuelCard({
    required this.fuel,
    required this.data,
    required this.plan,
    required this.onTopUp,
    required this.moveLabel,
    required this.onMove,
    required this.portalLabel,
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
    final name = plan?.name ?? 'Subscribed';
    final pill = subscribed
        ? _Pill(
            periodEnd == null
                ? name
                : '$name · ${ending ? 'ends' : 'renews'} ${spendDate(periodEnd)}',
          )
        : null;
    final more = [
      if (onTopUp != null)
        OutlinedButton(onPressed: onTopUp, child: const Text('Top up')),
      if (onMove != null && moveLabel != null)
        FilledButton(onPressed: onMove, child: Text(moveLabel!)),
    ];
    final portal = onPortal == null
        ? null
        : TextButton.icon(
            onPressed: onPortal,
            iconAlignment: IconAlignment.end,
            icon: const Icon(Icons.north_east_rounded, size: 16),
            label: Text(portalLabel),
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

  /// The payments Package's word for buying it, followed by the amount.
  final String label;
  const _TopUpDialog({
    required this.topUps,
    required this.initial,
    required this.label,
  });

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
        child: Text('${widget.label} ${_dollars(cents)}'),
      ),
    ],
  );
}

/// The deployment's plans side by side, described by how much room each gives
/// the account's Bots; the credit behind it is the small print. Every button
/// is one of the payments Package's actions.
class _PlansCard extends StatelessWidget {
  final List<_Plan> plans;

  /// The plan the account is on, or null without one.
  final String? current;
  final bool trial;
  final bool payments;
  final Map? Function(_Plan plan) actionFor;
  final VoidCallback? Function(_Plan plan, Map action) onAction;

  /// The plan a change is measured from, to say when it takes effect.
  final _Plan? upFrom;
  final String mendLabel;
  final VoidCallback? onMend;

  /// Whether the deployment sells top-ups beside the plans.
  final bool topUps;
  const _PlansCard({
    required this.plans,
    required this.current,
    required this.trial,
    required this.payments,
    required this.actionFor,
    required this.onAction,
    required this.upFrom,
    required this.mendLabel,
    required this.onMend,
    required this.topUps,
  });

  String _room(_Plan plan) {
    final base = plans.first.includedMicros;
    if (plan == plans.first || base <= 0) {
      return 'Room for everyday chats and a few Routines.';
    }
    final times = plan.includedMicros / base;
    final label = times == times.roundToDouble()
        ? '${times.round()}'
        : times.toStringAsFixed(1);
    return '$label× the room, for Bots and Routines that work all day.';
  }

  /// When a change to [plan] takes effect, under its button.
  String? _after(_Plan plan, Map? action) {
    if (action?['purpose'] != 'change-plan') return null;
    if (trial) return 'Ends the trial and charges the first month now.';
    final from = upFrom;
    return from == null || plan.includedMicros > from.includedMicros
        ? 'Starts now, with a new billing month.'
        : 'Starts when your plan renews.';
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.colorScheme.onSurfaceVariant;
    final selling = current == null && onMend == null;
    return Card(
      margin: EdgeInsets.zero,
      child: LayoutBuilder(
        builder: (context, constraints) {
          final wide = constraints.maxWidth >= 560 && plans.length > 1;
          final tiles = [for (final plan in plans) _tile(context, plan, wide)];
          return Padding(
            padding: EdgeInsets.all(constraints.maxWidth >= 560 ? 24 : 18),
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
                      label: Text(mendLabel),
                    ),
                  ),
                ],
                const SizedBox(height: 14),
                Text(
                  !payments
                      ? 'Payments are not available yet.'
                      : onMend != null
                      ? 'Your subscription needs attention. Fix it in your browser.'
                      : [
                          if (selling) 'Checkout opens in your browser.',
                          if (topUps) 'Top-ups never expire.',
                          'Work pauses when credit runs out, with no overage charge.',
                          if (selling) 'Cancel any time.',
                        ].join(' '),
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
    final action = actionFor(plan);
    final down =
        action?['purpose'] == 'change-plan' &&
        !trial &&
        upFrom != null &&
        plan.includedMicros < upFrom!.includedMicros;
    final button = action == null
        ? null
        : down
        ? OutlinedButton(
            onPressed: onAction(plan, action),
            child: Text('${action['label']}'),
          )
        : FilledButton(
            onPressed: onAction(plan, action),
            child: Text('${action['label']}'),
          );
    final after = _after(plan, action);
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
            if (wide && (button != null || after != null)) const Spacer(),
            if (button != null) ...[
              const SizedBox(height: 14),
              SizedBox(width: double.infinity, child: button),
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
