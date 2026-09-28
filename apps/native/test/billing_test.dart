import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_client/client/transport.dart';
import 'package:frockbot_client/settings/billing.dart';
import 'package:frockbot_client/settings/spending.dart';
import 'package:frockbot_client/shell/semantics.dart';

import 'navigation_test.dart' show identifiedBy;
import 'settings_test.dart' show SettingsApi;
import 'widget_test.dart' show MemoryStore;

const _dayMs = 86400000;
final _now = DateTime.now().millisecondsSinceEpoch;
final _renews = _now + 20 * _dayMs;

const _standard = {
  'id': 'standard',
  'monthlyCents': 2000,
  'includedMicros': 20000000,
  'topUpCents': [1000, 2500, 5000],
  'pricingVersion': 'test',
};
const _plus = {
  'id': 'plus',
  'monthlyCents': 5000,
  'includedMicros': 60000000,
  'topUpCents': [1000, 2500, 5000],
  'pricingVersion': 'test',
};

/// A month of history: the pace of the last week means something.
final _history = [
  {
    'id': 'included:a',
    'kind': 'included',
    'created': _now - 40 * _dayMs,
    'creditMicros': 20000000,
  },
];

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
  'plan': _standard,
  'plans': [_standard, _plus],
  'trial': null,
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

/// A subscribed account on [plan], with [overrides] on top.
Map<String, Object?> subscribed(
  Map<String, Object?> overrides, {
  Map<String, Object?> plan = _standard,
}) => billing({
  'subscribed': true,
  'subscription': {
    'status': 'active',
    'periodEnd': _renews,
    'cancelAtPeriodEnd': false,
  },
  'plan': plan,
  'payments': _history,
  ...overrides,
});

/// What `/api/billing/spending` answers: one Bot, and how long credit lasts
/// at a pace that runs out [runsOutIn] days from now.
Map<String, Object?> spending(Uri uri, {int runsOutIn = 30}) => {
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
      'label': 'Researcher',
      'chargeMicros': 620000,
      'operations': 4,
      'turns': 3,
    },
  ],
  'topCause': null,
  'credit': {
    'availableMicros': 31380000,
    'dailyMicros': 620000,
    'runsOutAt': _now + runsOutIn * _dayMs,
    'renewsAt': _renews,
  },
  'topTurns': <Object>[],
};

SettingsApi _api(
  Map<String, Object?> account, {
  List<(String, Object?)>? asked,
  int runsOutIn = 30,
  MemoryStore? store,
  Future<Object?> Function(Object? body)? onPlan,
}) => SettingsApi(store ?? MemoryStore(), (path, body) async {
  asked?.add((path, body));
  if (path.startsWith('/api/billing/spending')) {
    return spending(Uri.parse(path), runsOutIn: runsOutIn);
  }
  if (path == '/api/billing') return account;
  if (path == '/api/billing/plan' && onPlan != null) return onPlan(body);
  throw StateError('Payments are not reachable in a test');
});

Finder _list() => find
    .descendant(
      of: find.byType(SingleChildScrollView),
      matching: find.byType(Scrollable),
    )
    .first;

Future<void> _show(WidgetTester tester, SettingsApi api, {Size? size}) async {
  tester.view.physicalSize = size ?? const Size(1280, 1400);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(home: BillingPage(api: api)));
  await tester.pumpAndSettle();
}

Finder _inPlans(Finder finder) =>
    find.descendant(of: identifiedBy(BillingIds.plan), matching: finder);

Finder _inGauge(Finder finder) =>
    find.descendant(of: identifiedBy(BillingIds.balance), matching: finder);

void main() {
  test('a share of the plan reads plainly at every size', () {
    expect(spendShare(26000000, 20000000), '130%');
    expect(spendShare(620000, 20000000), '3.1%');
    expect(spendShare(400000, 20000000), '2%');
    expect(spendShare(10000, 20000000), '< 0.1%');
    expect(spendShare(0, 20000000), '0%');
    expect(spendAllowance(billing({})), isNull);
    expect(spendAllowance(subscribed({})), 20000000);
    expect(spendAllowance(subscribed({'metered': false})), isNull);
  });

  testWidgets('a healthy pace: the share left, lasting past renewal, and the '
      'reserve beneath it', (tester) async {
    final asked = <(String, Object?)>[];
    final api = _api(
      subscribed({
        'includedMicros': 12400000,
        'purchasedMicros': 12400000,
        'reservedMicros': 1000000,
      }),
      asked: asked,
    );
    final semantics = tester.ensureSemantics();
    await _show(tester, api);

    expect(find.widgetWithText(AppBar, 'Billing'), findsOneWidget);
    expect(find.text('62% left'), findsOneWidget);
    expect(find.text('of this month’s Standard plan'), findsOneWidget);
    expect(
      find.text('Standard · renews ${spendDate(_renews)}'),
      findsOneWidget,
    );
    expect(
      find.text('Lasts until your plan renews on ${spendDate(_renews)}'),
      findsOneWidget,
    );
    expect(
      find.text(
        '+ US\$12.40 in reserve · used after this month’s runs out · never expires',
      ),
      findsOneWidget,
    );
    // The gauge says what it shows; held credit is a lighter part of it.
    expect(
      find.bySemanticsLabel(RegExp(r'^62% left, 5% of it held')),
      findsOneWidget,
    );
    expect(
      find.textContaining('The lighter part of the bar is held'),
      findsOneWidget,
    );
    semantics.dispose();
    // No running dollar meter.
    expect(find.text('Available to spend'), findsNothing);
    expect(find.text('US\$24.80'), findsNothing);
    expect(identifiedBy(BillingIds.blocked), findsNothing);

    await tester.tap(_inGauge(find.widgetWithText(OutlinedButton, 'Top up')));
    await tester.pumpAndSettle();
    await tester.tap(
      find.descendant(
        of: find.byType(AlertDialog),
        matching: find.text('US\$50'),
      ),
    );
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

    await tester.scrollUntilVisible(
      find.text('Prices'),
      300,
      scrollable: _list(),
    );
    expect(
      find.text('Computer US\$2.75 per active hour · hosted model rates'),
      findsOneWidget,
    );
    await tester.tap(find.text('Prices'));
    await tester.pumpAndSettle();
    expect(find.widgetWithText(AppBar, 'Prices'), findsOneWidget);
    expect(find.text('US\$2.40'), findsOneWidget);
    api.close();
  });

  testWidgets('running out before renewal: the date in amber, with Top up '
      'and Move to Plus beside it', (tester) async {
    final asked = <(String, Object?)>[];
    final api = _api(
      subscribed({'includedMicros': 4000000}),
      asked: asked,
      runsOutIn: 6,
      onPlan: (body) async => {'plan': 'plus'},
    );
    await _show(tester, api, size: const Size(390, 1800));
    final runsOut = spendDate(_now + 6 * _dayMs);
    expect(find.text('20% left'), findsOneWidget);
    final line = find.text('At your pace, runs out around $runsOut');
    expect(line, findsOneWidget);
    expect(
      tester.widget<Text>(line).style?.color,
      isNot(Theme.of(tester.element(line)).colorScheme.onSurface),
    );
    expect(find.text('Lasts until', findRichText: true), findsNothing);
    final moves = _inGauge(find.widgetWithText(FilledButton, 'Move to Plus'));
    expect(moves, findsOneWidget);
    expect(_inGauge(find.text('Top up')), findsOneWidget);
    // Right under the answer on a phone, not down with the other actions.
    expect(
      tester.getTopLeft(moves).dy - tester.getBottomLeft(line).dy,
      lessThan(120),
    );

    await tester.tap(moves);
    await tester.pumpAndSettle();
    expect(find.text('Move to Plus?'), findsOneWidget);
    await tester.tap(
      find.descendant(
        of: find.byType(AlertDialog),
        matching: find.widgetWithText(FilledButton, 'Move to Plus'),
      ),
    );
    await tester.pumpAndSettle();
    final change = asked.firstWhere((a) => a.$1 == '/api/billing/plan');
    expect(change.$2, containsPair('plan', 'plus'));
    expect((change.$2! as Map)['id'], isA<String>());
    expect(
      find.text('You’re on Plus. Your new billing month starts today.'),
      findsOneWidget,
    );
    api.close();
  });

  testWidgets('a refused plan change says why', (tester) async {
    final api = _api(
      subscribed({'includedMicros': 4000000}),
      runsOutIn: 6,
      onPlan: (_) async => throw const RequestFailure(
        'Your last payment has not gone through yet.',
        409,
      ),
    );
    await _show(tester, api);
    await tester.tap(
      _inPlans(find.widgetWithText(FilledButton, 'Move to Plus')),
    );
    await tester.pumpAndSettle();
    await tester.tap(
      find.descendant(
        of: find.byType(AlertDialog),
        matching: find.widgetWithText(FilledButton, 'Move to Plus'),
      ),
    );
    await tester.pumpAndSettle();
    expect(
      find.text('Your last payment has not gone through yet.'),
      findsOneWidget,
    );
    api.close();
  });

  testWidgets('under a week of history: the share, and no date', (
    tester,
  ) async {
    final api = _api(
      subscribed({
        'includedMicros': 15000000,
        'payments': [
          {
            'id': 'included:a',
            'kind': 'included',
            'created': _now - 2 * _dayMs,
          },
        ],
      }),
      runsOutIn: 4,
    );
    await _show(tester, api);
    expect(find.text('75% left'), findsOneWidget);
    expect(find.textContaining('runs out around'), findsNothing);
    expect(find.textContaining('Lasts until'), findsNothing);
    api.close();
  });

  testWidgets('the allowance spent: the reserve in dollars leads', (
    tester,
  ) async {
    final api = _api(
      subscribed({'includedMicros': 0, 'purchasedMicros': 8400000}),
      runsOutIn: 40,
    );
    await _show(tester, api);
    expect(find.text('US\$8.40 of top-up left'), findsOneWidget);
    expect(
      find.text(
        'This month’s allowance is used. It renews on ${spendDate(_renews)}.',
      ),
      findsOneWidget,
    );
    expect(find.textContaining('in reserve'), findsNothing);
    api.close();
  });

  testWidgets('out of credit: paused until renewal, with ways to go on', (
    tester,
  ) async {
    final api = _api(subscribed({}));
    await _show(tester, api);
    expect(find.text('Paused until ${spendDate(_renews)}'), findsOneWidget);
    expect(_inGauge(find.text('Top up')), findsOneWidget);
    expect(_inGauge(find.text('Move to Plus')), findsOneWidget);
    // Told in the gauge, not again in red.
    expect(identifiedBy(BillingIds.blocked), findsNothing);
    api.close();
  });

  testWidgets('a trial: days left, measured against the trial credit', (
    tester,
  ) async {
    final ends = _now + 5 * _dayMs - 3600000;
    final api = _api(
      billing({
        'complimentaryMicros': 3000000,
        'subscription': {'status': 'trialing', 'periodEnd': ends},
        'trial': {'endsAt': ends, 'creditMicros': 5000000},
      }),
    );
    await _show(tester, api);
    expect(find.text('Trial · 5 days left'), findsOneWidget);
    expect(
      find.text(
        '60% of your trial credit left. Standard begins ${spendDate(ends)}.',
      ),
      findsOneWidget,
    );
    expect(_inPlans(find.text('Your plan · trial')), findsOneWidget);
    expect(_inPlans(find.textContaining('Choose')), findsNothing);
    expect(identifiedBy(BillingIds.blocked), findsNothing);
    api.close();
  });

  testWidgets('without a plan: Standard beside Plus, by room, then checkout '
      'for the one chosen', (tester) async {
    final asked = <(String, Object?)>[];
    final api = _api(billing({'canSpend': false}), asked: asked);
    await _show(tester, api);
    expect(identifiedBy(BillingIds.balance), findsNothing);
    expect(find.text('Choose a plan'), findsOneWidget);
    expect(_inPlans(find.text('US\$20')), findsOneWidget);
    expect(_inPlans(find.text('US\$50')), findsOneWidget);
    expect(
      _inPlans(
        find.text('3× the room, for Bots and Routines that work all day.'),
      ),
      findsOneWidget,
    );
    expect(
      _inPlans(find.text('US\$60 of usage included each month')),
      findsOneWidget,
    );
    expect(
      find.text('They reply once you subscribe or receive credit.'),
      findsOneWidget,
    );
    await tester.tap(find.widgetWithText(FilledButton, 'Choose Plus'));
    await tester.pumpAndSettle();
    expect(asked.last.$1, '/api/billing/checkout');
    expect(asked.last.$2, containsPair('kind', 'subscription'));
    expect(asked.last.$2, containsPair('plan', 'plus'));
    api.close();
  });

  testWidgets('on Plus: nothing to move to, and the way back is at renewal', (
    tester,
  ) async {
    final api = _api(subscribed({'includedMicros': 30000000}, plan: _plus));
    await _show(tester, api, size: const Size(390, 1800));
    expect(find.text('50% left'), findsOneWidget);
    expect(find.text('of this month’s Plus plan'), findsOneWidget);
    expect(find.text('Move to Plus'), findsNothing);
    expect(_inPlans(find.text('Your plan')), findsOneWidget);
    expect(
      _inPlans(find.text('Move back at renewal, from Plan, invoices & card.')),
      findsOneWidget,
    );
    api.close();
  });

  testWidgets('on Standard: Plus is offered from the plan card', (
    tester,
  ) async {
    final api = _api(subscribed({'includedMicros': 15000000}));
    await _show(tester, api);
    expect(_inPlans(find.text('Your plan')), findsOneWidget);
    expect(
      _inPlans(find.widgetWithText(FilledButton, 'Move to Plus')),
      findsOneWidget,
    );
    expect(
      _inPlans(find.text('Starts now, with a new billing month.')),
      findsOneWidget,
    );
    // A healthy account is not pressed to buy more beside its answer.
    expect(_inGauge(find.text('Move to Plus')), findsNothing);
    api.close();
  });

  testWidgets('Spending reads as shares of the plan until dollars are asked '
      'for, and remembers', (tester) async {
    final store = MemoryStore();
    final api = _api(subscribed({'includedMicros': 15000000}), store: store);
    await _show(tester, api);
    await tester.scrollUntilVisible(
      find.text('Researcher').last,
      300,
      scrollable: _list(),
    );
    await tester.pumpAndSettle();
    expect(find.text('3.1%'), findsWidgets);
    expect(find.text('OF YOUR PLAN'), findsOneWidget);
    expect(find.text('US\$0.62'), findsNothing);

    await tester.ensureVisible(find.text('Show in dollars'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Show in dollars'));
    await tester.pumpAndSettle();
    expect(find.text('US\$0.62'), findsWidgets);
    expect(find.text('3.1%'), findsNothing);
    expect(find.text('SPENT'), findsOneWidget);
    expect(store.values[spendDollarsKey], 'true');

    // Opened again, the page keeps the choice.
    await tester.pumpWidget(const SizedBox());
    await tester.pumpWidget(MaterialApp(home: BillingPage(api: api)));
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(
      find.text('Researcher').last,
      300,
      scrollable: _list(),
    );
    await tester.pumpAndSettle();
    expect(find.text('US\$0.62'), findsWidgets);
    api.close();
  });

  testWidgets(
    'complimentary credit without a plan is shown in dollars, beside the plans',
    (tester) async {
      final api = _api(
        billing({
          'complimentaryMicros': 5000000,
          'payments': [
            {'id': 'complimentary:a', 'kind': 'complimentary'},
          ],
        }),
      );
      await _show(tester, api, size: const Size(390, 1800));
      expect(find.text('US\$5.00 of complimentary credit'), findsOneWidget);
      expect(identifiedBy(BillingIds.blocked), findsNothing);
      expect(find.text('Top up'), findsNothing);
      expect(find.text('Show in dollars'), findsNothing);
      expect(
        tester
            .widget<FilledButton>(
              find.widgetWithText(FilledButton, 'Choose Standard'),
            )
            .onPressed,
        isNotNull,
      );
      api.close();
    },
  );

  testWidgets('out of complimentary credit: told why first, then the plans', (
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
    expect(
      find.text(
        'Your complimentary credit is used up. Subscribe to keep them working.',
      ),
      findsOneWidget,
    );
    expect(
      tester.getTopLeft(identifiedBy(BillingIds.blocked)).dy,
      lessThan(tester.getTopLeft(identifiedBy(BillingIds.plan)).dy),
    );
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
    expect(find.textContaining('Choose '), findsNothing);
    expect(find.text('Plans'), findsOneWidget);
    expect(find.text('Plan, invoices & card'), findsOneWidget);
    api.close();
  });

  testWidgets('billing disables purchases when payment setup is unavailable', (
    tester,
  ) async {
    final api = _api(billing({'paymentsAvailable': false, 'metered': false}));
    await _show(tester, api);
    expect(find.text('Payments are not available yet.'), findsWidgets);
    final choose = tester.widget<FilledButton>(
      find.widgetWithText(FilledButton, 'Choose Standard'),
    );
    expect(choose.onPressed, isNull);
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
      return subscribed({'includedMicros': 10000000});
    });
    await _show(tester, api);
    expect(find.text('Billing couldn’t load'), findsOneWidget);
    fail = false;
    await tester.tap(find.text('Try again'));
    await tester.pumpAndSettle();
    expect(find.text('50% left'), findsOneWidget);
    api.close();
  });

  testWidgets('a lapsed plan keeps its top-ups for when it comes back', (
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
    expect(find.text('No plan'), findsOneWidget);
    expect(
      find.text(
        'US\$12.00 of top-up credit · used once you subscribe again · never expires',
      ),
      findsOneWidget,
    );
    api.close();
  });

  testWidgets('a door that names Spending opens the page there', (
    tester,
  ) async {
    final api = _api(subscribed({'includedMicros': 6380000}));
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
