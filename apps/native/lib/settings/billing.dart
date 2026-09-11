import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../client/transport.dart';

class BillingPage extends StatefulWidget {
  final NativeApi api;
  const BillingPage({super.key, required this.api});

  @override
  State<BillingPage> createState() => _BillingPageState();
}

class _BillingPageState extends State<BillingPage> with WidgetsBindingObserver {
  Map<String, dynamic>? account;
  String? message;
  bool busy = false;
  final Map<String, String> checkoutIds = {};

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _load();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _load();
  }

  String _money(Object? micros) =>
      'US\$${((micros as num? ?? 0) / 1000000).toStringAsFixed(2)}';

  Future<void> _load() async {
    try {
      final response = await widget.api.request('/api/billing');
      if (response is! Map<String, dynamic>) {
        throw const FormatException('Invalid billing response');
      }
      if (!mounted) return;
      setState(() {
        account = response;
        message = response['paymentsAvailable'] != true
            ? 'Payments are not available yet.'
            : response['suspended'] == true
            ? 'Payments need review. Contact support before starting more paid work.'
            : response['metered'] == true && response['canSpend'] != true
            ? 'Your Bots can’t reply until you subscribe or receive credit.'
            : null;
      });
    } catch (error) {
      if (mounted) setState(() => message = error.toString());
    }
  }

  Future<void> _openPayment(String kind, {int? cents}) async {
    if (busy) return;
    setState(() => busy = true);
    final key = '$kind:${cents ?? 0}';
    final id = checkoutIds.putIfAbsent(key, randomId);
    try {
      final response = await widget.api.request(
        kind == 'portal' ? '/api/billing/portal' : '/api/billing/checkout',
        body: {
          'id': id,
          if (kind != 'portal') 'kind': kind,
          if (cents != null) 'cents': cents,
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
          () => message = 'Complete payment in your browser, then return here. Your balance updates after payment is confirmed.',
        );
      }
    } catch (error) {
      if (mounted) setState(() => message = error.toString());
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final data = account;
    final subscription = data?['subscription'] as Map?;
    // Top-ups are bought against a subscription: they need one to be spent.
    final subscribed = data?['subscribed'] == true;
    final hasSubscription =
        subscription != null &&
        !{'canceled', 'incomplete_expired'}.contains(subscription['status']);
    final available = data?['paymentsAvailable'] == true && !busy;
    final usage = data?['usage'] as List? ?? const [];
    final summaries = data?['summaries'] as List? ?? const [];
    final rates = data?['modelRates'] as Map? ?? const {};
    final computerRate = data?['computerRate'] as Map? ?? const {};
    return Scaffold(
      appBar: AppBar(
        title: const Text('Billing & usage'),
        actions: [
          IconButton(
            onPressed: _load,
            icon: const Icon(Icons.refresh),
            tooltip: 'Refresh balance',
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          padding: const EdgeInsets.all(24),
          children: [
            Text(
              'One plan for your whole flock.',
              style: Theme.of(context).textTheme.headlineSmall,
            ),
            const SizedBox(height: 12),
            const Text('US\$29 / month · US\$15 of monthly usage credit'),
            if (message != null)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 16),
                child: Text(message!, semanticsLabel: message),
              ),
            const SizedBox(height: 24),
            _balance(
              'Monthly credit',
              data?['includedMicros'],
              'Resets each billing month. Used first.',
            ),
            if ((data?['complimentaryMicros'] as num? ?? 0) > 0)
              _balance(
                'Complimentary credit',
                data?['complimentaryMicros'],
                'Granted by FrockBot. Spendable without a subscription.',
              ),
            _balance(
              'Purchased credit',
              data?['purchasedMicros'],
              'Carries forward.',
            ),
            _balance(
              'Reserved for work',
              data?['reservedMicros'],
              'Unused credit returns when work settles.',
            ),
            const SizedBox(height: 16),
            if (!hasSubscription)
              FilledButton(
                onPressed: available
                    ? () => _openPayment('subscription')
                    : null,
                child: const Text('Subscribe — US\$29 / month'),
              ),
            if (subscription != null)
              OutlinedButton(
                onPressed: available ? () => _openPayment('portal') : null,
                child: const Text('Manage subscription & payment method'),
              ),
            const SizedBox(height: 24),
            Text('Add a top-up', style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 12),
            Wrap(
              spacing: 12,
              runSpacing: 12,
              children: [
                for (final cents in [1000, 2500, 5000])
                  OutlinedButton(
                    onPressed: available && subscribed
                        ? () => _openPayment('topup', cents: cents)
                        : null,
                    child: Text('US\$${cents ~/ 100}'),
                  ),
              ],
            ),
            const SizedBox(height: 16),
            const Text(
              'Hosted models and your cloud computer share this balance. Your own model provider bills you directly; computer usage still uses FrockBot credit. New paid work pauses when credit runs out. No automatic overage charges.',
            ),
            const SizedBox(height: 24),
            Text(
              'Computer rate',
              style: Theme.of(context).textTheme.titleLarge,
            ),
            Text(
              computerRate.isEmpty
                  ? 'Computer pricing is unavailable.'
                  : 'US\$${computerRate['activeUsdPerHour']} per active hour. Up to ${computerRate['storageIncludedGb']} GB while idle is included. Viewer time renews every ${computerRate['viewerRenewSeconds']} seconds.',
            ),
            const SizedBox(height: 24),
            Text(
              'Hosted model rates',
              style: Theme.of(context).textTheme.titleLarge,
            ),
            const Text(
              'US dollars per million tokens. Your own provider sets its own prices.',
            ),
            for (final entry in rates.entries)
              ListTile(
                contentPadding: EdgeInsets.zero,
                title: Text(entry.key.toString()),
                subtitle: Text(
                  'Input US\$${(entry.value as Map)['inputUsdPerMillion']} · cached US\$${(entry.value as Map)['cachedInputUsdPerMillion']} · output US\$${(entry.value as Map)['outputUsdPerMillion']}',
                ),
              ),
            const SizedBox(height: 24),
            Text(
              'Usage by day & Bot',
              style: Theme.of(context).textTheme.titleLarge,
            ),
            const Text('Settled charges over the past 31 days.'),
            for (final row in summaries.whereType<Map>())
              ListTile(
                contentPadding: EdgeInsets.zero,
                title: Text('${row['day']} · ${row['botId'] ?? 'Account'}'),
                subtitle: Text('${row['kind']}'),
                trailing: Text(_money(row['chargeMicros'])),
              ),
            const SizedBox(height: 24),
            Text('Recent usage', style: Theme.of(context).textTheme.titleLarge),
            if (usage.isEmpty)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 16),
                child: Text('No usage yet.'),
              ),
            for (final row in usage.whereType<Map>())
              ListTile(
                contentPadding: EdgeInsets.zero,
                title: Text(row['description'] as String? ?? 'Usage'),
                subtitle: Text(
                  '${row['status']} · ${row['botId'] ?? 'Account'}',
                ),
                trailing: Text(
                  row['settlement'] is Map
                      ? _money((row['settlement'] as Map)['chargeMicros'])
                      : 'Pending',
                ),
              ),
            const SizedBox(height: 24),
            const Text(
              'All prices are in US dollars. Any applicable tax is shown at checkout. Cancel before your next renewal; paid access continues until the end of your billing period.',
            ),
          ],
        ),
      ),
    );
  }

  Widget _balance(String title, Object? micros, String detail) => Card(
    child: Padding(
      padding: const EdgeInsets.all(20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 8),
          Text(
            account == null ? '—' : _money(micros),
            style: Theme.of(context).textTheme.headlineSmall,
          ),
          Text(detail),
        ],
      ),
    ),
  );
}
