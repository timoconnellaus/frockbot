import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/settings/billing.dart';
import 'package:frockbot_native/shell/semantics.dart';

import 'navigation_test.dart' show identifiedBy;
import 'settings_test.dart' show SettingsApi;
import 'widget_test.dart' show MemoryStore;

final _renews = DateTime(2026, 10, 12, 9).millisecondsSinceEpoch;

const _plan = {
  'currency': 'usd',
  'monthlyCents': 2000,
  'includedMicros': 15000000,
  'topUpCents': [1000, 2500, 5000],
};

/// What `/api/billing` answers, with [overrides] on top.
Map<String, Object?> billing(Map<String, Object?> overrides) => {
  'paymentsAvailable': true,
  'metered': true,
  'canSpend': true,
  'subscribed': false,
  'suspended': false,
  'subscription': null,
  'includedMicros': 0,
  'complimentaryMicros': 0,
  'purchasedMicros': 0,
  'reservedMicros': 0,
  'payments': <Object>[],
  'plan': _plan,
  'computerRate': {
    'activeUsdPerHour': 2.75,
    'storageIncludedGb': 100,
    'viewerOpenSeconds': 30,
    'viewerRenewSeconds': 30,
  },
  'modelRates': {
    '@frock/auto': {
      'inputUsdPerMillion': 0.6,
      'cachedInputUsdPerMillion': 0.15,
      'outputUsdPerMillion': 2.4,
    },
  },
  'usage': <Object>[],
  ...overrides,
};

/// What `/api/billing/spending` answers: one Bot, and how long credit lasts.
Map<String, Object?> spending(Uri uri) => {
  'groupBy': uri.queryParameters['groupBy'],
  'filters': <Object>[],
  'totalMicros': 620000,
  'previousTotalMicros': 500000,
  'operations': 4,
  'turns': 3,
  'days': [
    {
      'day': '2026-09-20',
      'chargeMicros': 620000,
      'stack': [620000],
    },
  ],
  'groups': [
    {
      'key': 'bot-1',
      'label': 'Bob',
      'chargeMicros': 620000,
      'operations': 4,
      'turns': 3,
    },
  ],
  'topCause': null,
  'credit': {
    'availableMicros': 31380000,
    'dailyMicros': 620000,
    'runsOutAt': _renews + 30 * 86400000,
    'renewsAt': _renews,
  },
  'topTurns': <Object>[],
};

SettingsApi _api(
  Map<String, Object?> account, {
  List<(String, Object?)>? asked,
}) => SettingsApi(MemoryStore(), (path, body) async {
  asked?.add((path, body));
  if (path.startsWith('/api/billing/spending')) {
    return spending(Uri.parse(path));
  }
  if (path == '/api/billing') return account;
  throw StateError('Payments are not reachable in a test');
});

Finder _list() => find
    .descendant(of: find.byType(SingleChildScrollView), matching: find.byType(Scrollable))
    .first;

Future<void> _show(WidgetTester tester, SettingsApi api, {Size? size}) async {
  tester.view.physicalSize = size ?? const Size(1280, 1400);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(home: BillingPage(api: api)));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('subscribed: one balance, its parts, add credit, and where it '
      'went below', (tester) async {
    final asked = <(String, Object?)>[];
    final api = _api(
      billing({
        'subscribed': true,
        'subscription': {
          'status': 'active',
          'periodEnd': _renews,
          'cancelAtPeriodEnd': false,
        },
        'includedMicros': 6380000,
        'purchasedMicros': 25000000,
        'reservedMicros': 420000,
      }),
      asked: asked,
    );
    await _show(tester, api);

    expect(find.byType(AppBar), findsOneWidget);
    expect(find.widgetWithText(AppBar, 'Billing'), findsOneWidget);
    expect(find.text('Available to spend'), findsOneWidget);
    expect(find.text('US\$31.38'), findsOneWidget);
    expect(find.text('Subscribed · renews Oct 12'), findsOneWidget);
    expect(find.text('US\$6.38 of US\$15 left'), findsOneWidget);
    expect(find.text('Used first. Resets Oct 12.'), findsOneWidget);
    expect(find.text('Top-up credit'), findsOneWidget);
    expect(find.text('Never expires.'), findsOneWidget);
    expect(find.text('Complimentary credit'), findsNothing);
    expect(
      find.textContaining(
        'At US\$0.62 a day, it lasts past renewal on Oct 12.',
        findRichText: true,
      ),
      findsOneWidget,
    );
    expect(
      find.textContaining(
        'US\$0.42 is held for work still running.',
        findRichText: true,
      ),
      findsOneWidget,
    );
    // Subscribed: no plan to sell and nothing in red.
    expect(identifiedBy(BillingIds.plan), findsNothing);
    expect(identifiedBy(BillingIds.blocked), findsNothing);
    expect(find.text('One plan for your whole flock.'), findsNothing);
    expect(find.text('Recent usage'), findsNothing);

    await tester.tap(find.text('US\$50'));
    await tester.pump();
    await tester.tap(find.widgetWithText(FilledButton, 'Add US\$50'));
    await tester.pumpAndSettle();
    expect(asked.last.$1, '/api/billing/checkout');
    expect(asked.last.$2, containsPair('cents', 5000));
    expect(asked.last.$2, containsPair('kind', 'topup'));
    expect(
      find.text(
        'Couldn’t open payment just now. Check your connection and try again.',
      ),
      findsOneWidget,
    );
    expect(find.text('Plan, invoices & card'), findsOneWidget);

    // Spending is a section of the page, without its own credit card.
    expect(identifiedBy(BillingIds.spending), findsOneWidget);
    expect(find.text('Spending'), findsOneWidget);
    expect(find.text('Credit left'), findsNothing);
    await tester.scrollUntilVisible(
      find.text('Spent in the last 30 days'),
      300,
      scrollable: _list(),
    );
    expect(find.text('Spent in the last 30 days'), findsOneWidget);

    await tester.scrollUntilVisible(
      find.text('Prices'),
      300,
      scrollable: _list(),
    );
    expect(
      find.text('Computer US\$2.75 per active hour · hosted model rates'),
      findsOneWidget,
    );
    expect(
      find.text('Prices in US dollars. Tax is shown at checkout.'),
      findsOneWidget,
    );
    await tester.tap(find.text('Prices'));
    await tester.pumpAndSettle();
    expect(find.widgetWithText(AppBar, 'Prices'), findsOneWidget);
    expect(find.text('US\$2.75 an hour'), findsOneWidget);
    expect(find.text('Up to 100 GB included'), findsOneWidget);
    expect(find.text('@frock/auto'), findsOneWidget);
    expect(find.text('US\$2.40'), findsOneWidget);
    api.close();
  });

  testWidgets(
    'complimentary credit is its own part, spendable, with the plan beside it',
    (tester) async {
      final api = _api(
        billing({
          'complimentaryMicros': 5000000,
          'payments': [
            {'id': 'complimentary:a', 'kind': 'complimentary'},
          ],
        }),
      );
      await _show(tester, api, size: const Size(390, 1600));
      expect(find.text('Complimentary credit'), findsOneWidget);
      expect(find.text('US\$5.00'), findsWidgets);
      expect(find.text('Monthly credit'), findsNothing);
      expect(identifiedBy(BillingIds.blocked), findsNothing);
      // A top-up is bought against a subscription, and there is none yet.
      expect(find.textContaining('Add US\$'), findsNothing);
      expect(find.text('One plan for your whole flock'), findsOneWidget);
      expect(find.text('US\$15 of usage included every month'), findsOneWidget);
      expect(
        tester
            .widget<FilledButton>(
              find.widgetWithText(FilledButton, 'Subscribe'),
            )
            .onPressed,
        isNotNull,
      );
      api.close();
    },
  );

  testWidgets('out of complimentary credit: told why first, then the plan', (
    tester,
  ) async {
    final api = _api(
      billing({
        'canSpend': false,
        'payments': [
          {'id': 'complimentary:a', 'kind': 'complimentary'},
        ],
      }),
    );
    await _show(tester, api, size: const Size(390, 1600));
    expect(find.text('Your Bots can’t reply'), findsOneWidget);
    expect(
      find.text(
        'Your complimentary credit is used up. Subscribe to keep them working.',
      ),
      findsOneWidget,
    );
    // Nothing to spend, so no balance card, only the plan.
    expect(identifiedBy(BillingIds.balance), findsNothing);
    expect(
      tester.getTopLeft(identifiedBy(BillingIds.blocked)).dy,
      lessThan(tester.getTopLeft(identifiedBy(BillingIds.plan)).dy),
    );
    expect(
      find.text('Checkout opens in your browser. Cancel any time.'),
      findsOneWidget,
    );
    api.close();
  });

  testWidgets('a new account that cannot spend is told how to start', (
    tester,
  ) async {
    final api = _api(billing({'canSpend': false}));
    await _show(tester, api);
    expect(
      find.text('They reply once you subscribe or receive credit.'),
      findsOneWidget,
    );
    api.close();
  });

  testWidgets('subscribed with nothing left: add credit, not subscribe', (
    tester,
  ) async {
    final api = _api(
      billing({
        'subscribed': true,
        'subscription': {'status': 'active', 'periodEnd': _renews},
      }),
    );
    await _show(tester, api);
    expect(
      find.text(
        'You have no usage credit left. Add credit to keep them working.',
      ),
      findsOneWidget,
    );
    expect(identifiedBy(BillingIds.plan), findsNothing);
    expect(find.widgetWithText(FilledButton, 'Add US\$25'), findsOneWidget);
    api.close();
  });

  testWidgets('a subscription past due is mended, not bought again', (
    tester,
  ) async {
    final api = _api(
      billing({
        'canSpend': false,
        'subscription': {'status': 'past_due', 'periodEnd': _renews},
      }),
    );
    await _show(tester, api);
    expect(find.widgetWithText(FilledButton, 'Subscribe'), findsNothing);
    expect(find.text('Plan, invoices & card'), findsOneWidget);
    api.close();
  });

  testWidgets('billing disables purchases when payment setup is unavailable', (
    tester,
  ) async {
    final api = _api(billing({'paymentsAvailable': false, 'metered': false}));
    await _show(tester, api);
    expect(find.text('Payments are not available yet.'), findsWidgets);
    final subscribe = tester.widget<FilledButton>(
      find.widgetWithText(FilledButton, 'Subscribe'),
    );
    expect(subscribe.onPressed, isNull);
    api.close();
  });

  testWidgets('a balance that will not load says so and tries again', (
    tester,
  ) async {
    var fail = true;
    final api = SettingsApi(MemoryStore(), (path, _) async {
      if (path.startsWith('/api/billing/spending')) {
        return spending(Uri.parse(path));
      }
      if (fail) throw StateError('offline');
      return billing({'complimentaryMicros': 1000000});
    });
    await _show(tester, api);
    expect(find.text('Billing couldn’t load'), findsOneWidget);
    fail = false;
    await tester.tap(find.text('Try again'));
    await tester.pumpAndSettle();
    expect(find.text('Available to spend'), findsOneWidget);
    api.close();
  });

  testWidgets('a lapsed plan counts only what it can still spend', (
    tester,
  ) async {
    final api = _api(
      billing({
        'canSpend': false,
        'purchasedMicros': 12000000,
        'subscription': {'status': 'canceled', 'periodEnd': _renews},
      }),
    );
    await _show(tester, api);
    expect(find.text('Your Bots can’t reply'), findsOneWidget);
    expect(identifiedBy(BillingIds.balance), findsOneWidget);
    expect(find.text('US\$0.00'), findsOneWidget);
    expect(find.text('Top-up credit'), findsOneWidget);
    expect(find.text('US\$12.00'), findsOneWidget);
    api.close();
  });

  testWidgets('Spending below the plan on a short phone still opens there', (
    tester,
  ) async {
    final api = _api(
      billing({
        'canSpend': false,
        'complimentaryMicros': 0,
        'reservedMicros': 1000000,
        'payments': [
          {'id': 'complimentary:a', 'kind': 'complimentary'},
        ],
      }),
    );
    tester.view.physicalSize = const Size(360, 560);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(home: BillingPage(api: api, showSpending: true)),
    );
    await tester.pumpAndSettle();
    expect(identifiedBy(BillingIds.plan), findsOneWidget);
    final section = tester.getTopLeft(identifiedBy(BillingIds.spending));
    expect(section.dy, lessThan(200));
    api.close();
  });

  testWidgets('a door that names Spending opens the page there', (
    tester,
  ) async {
    final api = _api(
      billing({
        'subscribed': true,
        'subscription': {'status': 'active', 'periodEnd': _renews},
        'includedMicros': 6380000,
      }),
    );
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(home: BillingPage(api: api, showSpending: true)),
    );
    await tester.pumpAndSettle();
    final section = tester.getTopLeft(identifiedBy(BillingIds.spending));
    expect(section.dy, lessThan(200));
    api.close();
  });
}
