import 'dart:async';

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

/// The monthly subscription the deployment sells, as `/api/billing` states
/// it, or none.
Map? _subscriptionPlan(Map data) =>
    (data['plan'] as Map?)?['subscription'] as Map?;

/// One thing the payments Package offers the account, by where it goes.
Map? _action(Map data, String purpose) => (data['actions'] as List? ?? const [])
    .whereType<Map>()
    .where((action) => action['purpose'] == purpose)
    .firstOrNull;

/// How wide Billing reads: one column, the width of the design, centred.
const _column = 760.0;

String _money(Object? micros) =>
    'US\$${((micros as num? ?? 0) / 1000000).toStringAsFixed(2)}';

/// Whole dollars where the amount is whole: US$20, not US$20.00.
String _dollars(num cents) => cents % 100 == 0
    ? 'US\$${cents ~/ 100}'
    : 'US\$${(cents / 100).toStringAsFixed(2)}';

String _wholeMicros(num micros) => _dollars((micros / 10000).round());

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
    final key = '$purpose:${cents ?? 0}';
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
    final subscribed = data['subscribed'] == true;
    final metered = data['metered'] == true;
    final payments = data['paymentsAvailable'] == true;
    final plan = _subscriptionPlan(data);
    final subscribe = _action(data, 'subscribe');
    final topUp = _action(data, 'top-up');
    final manage = _action(data, 'manage');
    final tops = _topUps(data);
    int micros(String key) => (data[key] as num?)?.toInt() ?? 0;
    final available = subscribed
        ? micros('includedMicros') +
              micros('complimentaryMicros') +
              micros('purchasedMicros')
        : micros('complimentaryMicros');
    final blocked = !metered
        ? null
        : data['suspended'] == true
        ? 'Payments need review. Contact support before starting more paid work.'
        : data['canSpend'] != true
        ? plan == null
              ? _hadComplimentary(data)
                    ? 'Your complimentary credit is used up. Add credit to keep them working.'
                    : 'They reply once you add credit.'
              : _hadComplimentary(data)
              ? 'Your complimentary credit is used up. Subscribe to keep them working.'
              : 'They reply once you subscribe or receive credit.'
        : subscribed && available <= 0
        ? 'You have no usage credit left. Add credit to keep them working.'
        : null;
    final balance =
        subscribed ||
        [
          'includedMicros',
          'complimentaryMicros',
          'purchasedMicros',
          'reservedMicros',
        ].any((key) => micros(key) > 0);
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
          _BalanceCard(
            data: data,
            available: available,
            pace: pace,
            plan: plan,
            topUps: tops,
            topUpCents: topUpCents,
            onTopUpChosen: (cents) => setState(() => topUpCents = cents),
            topUpLabel: topUp?['label'] as String? ?? 'Add',
            onTopUp: topUp != null && payments && !busy
                ? () => unawaited(
                    _openPayment(
                      topUp,
                      cents: tops.isEmpty ? null : topUpCents,
                    ),
                  )
                : null,
            portalLabel: manage?['label'] as String? ?? '',
            onPortal: manage != null && payments && !busy
                ? () => unawaited(_openPayment(manage))
                : null,
          ),
        ),
        const SizedBox(height: 16),
      ],
      if (!subscribed && plan != null) ...[
        identified(
          BillingIds.plan,
          _PlanCard(
            plan: plan,
            topUps: tops.isNotEmpty,
            payments: payments,
            subscribeLabel: subscribe?['label'] as String? ?? 'Subscribe',
            portalLabel: manage?['label'] as String? ?? '',
            opensHere: (subscribe ?? manage)?['opens'] == 'in-app',
            onSubscribe: subscribe != null && payments && !busy
                ? () => unawaited(_openPayment(subscribe))
                : null,
            // A subscription that lapsed or is past due is mended where it
            // is kept, not bought again: the Package offers no subscribe.
            onPortal: subscribe == null && manage != null && payments && !busy
                ? () => unawaited(_openPayment(manage))
                : null,
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

/// What the account can spend, what it is made of, and how to add more.
class _BalanceCard extends StatelessWidget {
  final Map<String, dynamic> data;
  final int available;
  final Map? pace;

  /// The monthly subscription the deployment sells, or none.
  final Map? plan;
  final List<int> topUps;
  final int topUpCents;
  final void Function(int cents) onTopUpChosen;
  final String topUpLabel;
  final VoidCallback? onTopUp;
  final String portalLabel;
  final VoidCallback? onPortal;
  const _BalanceCard({
    required this.data,
    required this.available,
    required this.pace,
    required this.plan,
    required this.topUps,
    required this.topUpCents,
    required this.onTopUpChosen,
    required this.topUpLabel,
    required this.onTopUp,
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
    final included = (plan?['includedMicros'] as num?) ?? 0;
    int micros(String key) => (data[key] as num?)?.toInt() ?? 0;
    final reserved = micros('reservedMicros');
    final parts = [
      if ((subscribed && plan != null) || micros('includedMicros') > 0)
        _Part(
          title: 'Monthly credit',
          amount:
              '${_money(micros('includedMicros'))} of ${_wholeMicros(included)} left',
          fraction: included > 0 ? micros('includedMicros') / included : 0,
          detail: periodEnd == null
              ? 'Used first. Resets each billing month.'
              : 'Used first. Resets ${spendDate(periodEnd)}.',
        ),
      if ((subscribed && topUps.isNotEmpty) || micros('purchasedMicros') > 0)
        _Part(
          title: 'Top-up credit',
          amount: _money(micros('purchasedMicros')),
          fraction: micros('purchasedMicros') > 0 ? 1 : 0,
          detail: 'Never expires.',
          soft: true,
        ),
      if (micros('complimentaryMicros') > 0)
        _Part(
          title: 'Complimentary credit',
          amount: _money(micros('complimentaryMicros')),
          fraction: 1,
          detail:
              'From ${clientBrand.productName}. Spendable without a subscription.',
          soft: true,
        ),
    ];
    final runway = pace == null ? null : spendRunway(context, pace!);
    final pill = subscribed
        ? _Pill(
            periodEnd == null
                ? 'Subscribed'
                : 'Subscribed · ${ending ? 'ends' : 'renews'} ${spendDate(periodEnd)}',
          )
        : null;
    return Card(
      margin: EdgeInsets.zero,
      child: LayoutBuilder(
        builder: (context, constraints) {
          final wide = constraints.maxWidth >= 560;
          final pad = wide ? 24.0 : 18.0;
          final total = Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Available to spend',
                style: theme.textTheme.bodyMedium?.copyWith(color: muted),
              ),
              const SizedBox(height: 4),
              Text(
                _money(available),
                style: theme.textTheme.headlineLarge?.copyWith(
                  fontSize: 40,
                  fontWeight: FontWeight.w700,
                  letterSpacing: -0.8,
                  fontFeatures: FrockTheme.tabularFigures,
                ),
              ),
            ],
          );
          return Padding(
            padding: EdgeInsets.all(pad),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (wide)
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(child: total),
                      ?pill,
                    ],
                  )
                else ...[
                  total,
                  if (pill != null) ...[
                    const SizedBox(height: 10),
                    Align(alignment: Alignment.centerLeft, child: pill),
                  ],
                ],
                if (parts.isNotEmpty) ...[
                  const SizedBox(height: 20),
                  if (wide)
                    IntrinsicHeight(
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          for (var i = 0; i < parts.length; i++) ...[
                            if (i > 0) const SizedBox(width: 12),
                            Expanded(child: parts[i]),
                          ],
                        ],
                      ),
                    )
                  else
                    for (var i = 0; i < parts.length; i++) ...[
                      if (i > 0) const SizedBox(height: 10),
                      parts[i],
                    ],
                ],
                if (onTopUp != null || onPortal != null) ...[
                  const SizedBox(height: 20),
                  _actions(context, wide: wide),
                ],
                const SizedBox(height: 18),
                Divider(
                  height: 1,
                  color: FrockTheme.hairline(theme.colorScheme),
                ),
                const SizedBox(height: 14),
                Text.rich(
                  TextSpan(
                    children: [
                      if (runway != null) ...[
                        TextSpan(
                          children: [runway],
                          style: TextStyle(color: theme.colorScheme.onSurface),
                        ),
                        const TextSpan(text: ' '),
                      ],
                      const TextSpan(
                        text: 'Hosted models and your Bots’ Computers draw on it. When it runs out, new work pauses; there is never an overage charge.',
                      ),
                      if (reserved > 0)
                        TextSpan(
                          text:
                              ' ${_money(reserved)} is held for work still running.',
                        ),
                    ],
                  ),
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

  Widget _actions(BuildContext context, {required bool wide}) {
    final theme = Theme.of(context);
    final portal = onPortal == null
        ? null
        : OutlinedButton.icon(
            onPressed: onPortal,
            iconAlignment: IconAlignment.end,
            icon: const Icon(Icons.north_east_rounded, size: 16),
            label: Text(portalLabel),
          );
    final topUp = onTopUp == null
        ? null
        : Wrap(
            spacing: 10,
            runSpacing: 10,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              if (wide)
                Text(
                  'Add credit',
                  style: theme.textTheme.bodyMedium?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              if (topUps.isNotEmpty)
                FrockSegmented(
                  label: 'Top-up amount',
                  selected: '$topUpCents',
                  options: [
                    for (final cents in topUps)
                      (slug: '$cents', label: _dollars(cents)),
                  ],
                  onChosen: (slug) => onTopUpChosen(int.parse(slug)),
                ),
              FilledButton(
                onPressed: onTopUp,
                child: Text(
                  topUps.isEmpty
                      ? topUpLabel
                      : '$topUpLabel ${_dollars(topUpCents)}',
                ),
              ),
            ],
          );
    if (wide) {
      return Row(
        children: [
          if (topUp != null) Expanded(child: topUp) else const Spacer(),
          if (portal != null) ...[const SizedBox(width: 12), portal],
        ],
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (topUp != null) ...[
          Text(
            'Add credit',
            style: theme.textTheme.bodyMedium?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: 8),
          topUp,
        ],
        if (topUp != null && portal != null) const SizedBox(height: 12),
        ?portal,
      ],
    );
  }
}

/// One kind of credit inside the balance.
class _Part extends StatelessWidget {
  final String title;
  final String amount;
  final double fraction;
  final String detail;
  final bool soft;
  const _Part({
    required this.title,
    required this.amount,
    required this.fraction,
    required this.detail,
    this.soft = false,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final muted = theme.textTheme.bodySmall?.copyWith(
      color: scheme.onSurfaceVariant,
      fontSize: 12.5,
    );
    return Semantics(
      container: true,
      child: Container(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
        decoration: BoxDecoration(
          color: scheme.onSurface.withValues(alpha: 0.05),
          borderRadius: BorderRadius.circular(FrockTheme.radiusControl),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Wrap(
              alignment: WrapAlignment.spaceBetween,
              spacing: 8,
              children: [
                Text(
                  title,
                  style: theme.textTheme.bodyMedium?.copyWith(
                    fontWeight: FontWeight.w600,
                  ),
                ),
                Text(
                  amount,
                  style: muted?.copyWith(
                    fontSize: 13,
                    fontFeatures: FrockTheme.tabularFigures,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            ExcludeSemantics(
              child: ClipRRect(
                borderRadius: BorderRadius.circular(3),
                child: SizedBox(
                  height: 6,
                  child: Stack(
                    fit: StackFit.expand,
                    children: [
                      ColoredBox(
                        color: scheme.onSurface.withValues(alpha: 0.08),
                      ),
                      FractionallySizedBox(
                        alignment: Alignment.centerLeft,
                        widthFactor: fraction.clamp(0, 1).toDouble(),
                        child: ColoredBox(
                          color: soft ? FrockTheme.accentSoft : scheme.primary,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
            const SizedBox(height: 8),
            Text(detail, style: muted),
          ],
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

/// The one plan, for an account that has not taken it.
class _PlanCard extends StatelessWidget {
  final Map plan;

  /// Whether the deployment sells top-ups beside the plan.
  final bool topUps;
  final bool payments;
  final String subscribeLabel;
  final String portalLabel;

  /// Whether the provider's page opens inside the app rather than the browser.
  final bool opensHere;
  final VoidCallback? onSubscribe;
  final VoidCallback? onPortal;
  const _PlanCard({
    required this.plan,
    required this.topUps,
    required this.payments,
    required this.subscribeLabel,
    required this.portalLabel,
    required this.opensHere,
    required this.onSubscribe,
    required this.onPortal,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.colorScheme.onSurfaceVariant;
    final monthly = (plan['monthlyCents'] as num?) ?? 0;
    final included = (plan['includedMicros'] as num?) ?? 0;
    final check = theme.brightness == Brightness.dark
        ? FrockTheme.success
        : FrockTheme.successInk;
    final points = [
      '${_wholeMicros(included)} of usage included every month',
      if (topUps) 'Top up any time. Top-ups never expire.',
      'Work pauses when credit runs out. No overage charges.',
    ];
    final mend = onPortal != null;
    return Card(
      margin: EdgeInsets.zero,
      child: LayoutBuilder(
        builder: (context, constraints) {
          final wide = constraints.maxWidth >= 560;
          final button = mend
              ? FilledButton.icon(
                  onPressed: onPortal,
                  iconAlignment: IconAlignment.end,
                  icon: const Icon(Icons.north_east_rounded, size: 16),
                  label: Text(portalLabel),
                )
              : FilledButton(
                  onPressed: onSubscribe,
                  child: Text(subscribeLabel),
                );
          return Padding(
            padding: EdgeInsets.all(wide ? 24 : 20),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  'One plan for your whole flock',
                  style: theme.textTheme.bodyMedium?.copyWith(color: muted),
                ),
                const SizedBox(height: 4),
                Row(
                  crossAxisAlignment: CrossAxisAlignment.baseline,
                  textBaseline: TextBaseline.alphabetic,
                  children: [
                    Text(
                      _dollars(monthly),
                      style: theme.textTheme.headlineLarge?.copyWith(
                        fontWeight: FontWeight.w700,
                        letterSpacing: -0.6,
                      ),
                    ),
                    const SizedBox(width: 6),
                    Text(
                      '/ month',
                      style: theme.textTheme.bodyMedium?.copyWith(color: muted),
                    ),
                  ],
                ),
                const SizedBox(height: 16),
                for (final point in points)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 10),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Padding(
                          padding: const EdgeInsets.only(top: 1),
                          child: Icon(
                            Icons.check_rounded,
                            size: 18,
                            color: check,
                          ),
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Text(
                            point,
                            style: theme.textTheme.bodyMedium?.copyWith(
                              height: 1.4,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                const SizedBox(height: 6),
                if (wide)
                  Row(
                    children: [
                      button,
                      const SizedBox(width: 14),
                      Expanded(child: _caption(context, mend)),
                    ],
                  )
                else ...[
                  SizedBox(height: 46, child: button),
                  const SizedBox(height: 8),
                  Center(child: _caption(context, mend)),
                ],
              ],
            ),
          );
        },
      ),
    );
  }

  Widget _caption(BuildContext context, bool mend) {
    final theme = Theme.of(context);
    return Text(
      !payments
          ? 'Payments are not available yet.'
          : mend
          ? 'Your subscription needs attention. Fix it ${opensHere ? 'here' : 'in your browser'}.'
          : 'Checkout opens ${opensHere ? 'here' : 'in your browser'}. Cancel any time.',
      style: theme.textTheme.bodySmall?.copyWith(
        color: theme.colorScheme.onSurfaceVariant,
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
