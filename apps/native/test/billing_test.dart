import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
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

const _plan = {
  'subscriptions': [
    {
      'id': 'byo',
      'name': 'BYO',
      'monthlyCents': 500,
      'includedMicros': 0,
      'trial': false,
      'jevFairUseMicros': 2000000,
    },
    {
      'id': 'standard',
      'name': 'Standard',
      'monthlyCents': 2000,
      'includedMicros': 20000000,
    },
    {
      'id': 'plus',
      'name': 'Plus',
      'monthlyCents': 5000,
      'includedMicros': 60000000,
    },
  ],
  'trial': {'days': 7, 'creditMicros': 3000000},
  'topUpCents': [1000, 2500, 5000],
  'purchasedCreditNeedsSubscription': true,
};

const _checkout = '/api/billing/provider/checkout';
const _planPath = '/api/billing/provider/plan';

/// A month of history: the pace of the last week means something.
final _history = [
  {
    'id': 'included:a',
    'kind': 'included',
    'created': _now - 40 * _dayMs,
    'creditMicros': 20000000,
  },
];

Map<String, Object?> _changePlan(String plan, String label) => {
  'purpose': 'change-plan',
  'plan': plan,
  'label': label,
  'target': {
    'kind': 'command',
    'path': _planPath,
    'body': {'plan': plan},
  },
  'opens': 'in-app',
  'hosts': <String>[],
};

/// What the Stripe payments Package offers an account in this state, as
/// `stripeActionsV1` does: each plan to a new or ended account, the other
/// plan to a subscriber, starting now to a trial, top-ups to a subscriber and
/// the portal to any account with a subscription. Plus only where [plus].
List<Map<String, Object?>> _actions(
  Map<String, Object?> account, {
  bool plus = true,
}) {
  final subscription = account['subscription'] as Map?;
  final plans = ['byo', 'standard', if (plus) 'plus'];
  String name(String plan) => switch (plan) {
    'plus' => 'Plus',
    'byo' => 'BYO',
    _ => 'Standard',
  };
  final canSubscribe =
      subscription == null ||
      {'canceled', 'incomplete_expired'}.contains(subscription['status']);
  final trialing = subscription?['status'] == 'trialing';
  return [
    if (canSubscribe)
      for (final plan in plans)
        {
          'purpose': 'subscribe',
          'plan': plan,
          'label': 'Start ${name(plan)}',
          'target': {
            'kind': 'command',
            'path': _checkout,
            'body': {'kind': 'subscription', 'plan': plan},
          },
          'opens': 'browser',
          'hosts': ['checkout.stripe.com'],
        },
    if (trialing)
      for (final plan in plans)
        _changePlan(
          plan,
          plan == subscription!['planId']
              ? 'Start now'
              : 'Start ${name(plan)} now',
        )
    else if (account['subscribed'] == true)
      for (final plan in plans)
        if (plan != subscription?['planId'])
          _changePlan(plan, 'Move to ${name(plan)}'),
    if (account['subscribed'] == true)
      {
        'purpose': 'top-up',
        'label': 'Add',
        'target': {
          'kind': 'command',
          'path': _checkout,
          'body': {'kind': 'topup'},
        },
        'opens': 'browser',
        'hosts': ['checkout.stripe.com'],
      },
    if (subscription != null)
      {
        'purpose': 'manage',
        'label': 'Plan, invoices & card',
        'target': {'kind': 'command', 'path': '/api/billing/provider/portal'},
        'opens': 'browser',
        'hosts': ['billing.stripe.com'],
      },
  ];
}

/// What `/api/billing` answers, with [overrides] on top.
Map<String, Object?> billing(
  Map<String, Object?> overrides, {
  bool plus = true,
}) {
  final account = _billing(overrides);
  return {'actions': _actions(account, plus: plus), ...account};
}

Map<String, Object?> _billing(Map<String, Object?> overrides) => {
  'paymentsAvailable': true,
  'paymentsProvider': 'Stripe',
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
  'trial': null,
  'trialUsed': false,
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
  String plan = 'standard',
}) => billing({
  'subscribed': true,
  'subscription': {
    'status': 'active',
    'planId': plan,
    'periodEnd': _renews,
    'cancelAtPeriodEnd': false,
    'trialEnd': null,
  },
  'trialUsed': true,
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
  if (path == _planPath && onPlan != null) return onPlan(body);
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
    expect(asked.last.$1, _checkout);
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
      onPlan: (body) async => {'plan': 'plus', 'url': '/billing'},
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
    final change = asked.firstWhere((a) => a.$1 == _planPath);
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

  test(
    'a payments Package refusal reaches the person in its own words',
    () async {
      final api = NativeApi(
        MemoryStore(),
        client: MockClient(
          (request) async => http.Response(
            jsonEncode({'error': 'That plan is not available yet'}),
            409,
            headers: {'content-type': 'application/json'},
          ),
        ),
      );
      await expectLater(
        api.request(_planPath, body: {'id': 'a', 'plan': 'plus'}),
        throwsA(
          isA<RequestFailure>()
              .having((e) => e.status, 'status', 409)
              .having(
                (e) => e.message,
                'message',
                'That plan is not available yet',
              ),
        ),
      );
    },
  );

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
    final asked = <(String, Object?)>[];
    final api = _api(
      billing({
        'complimentaryMicros': 1800000,
        'subscription': {
          'status': 'trialing',
          'planId': 'standard',
          'periodEnd': ends,
          'trialEnd': ends,
          'cancelAtPeriodEnd': false,
        },
        'trial': {'endsAt': ends, 'creditMicros': 3000000},
        'trialUsed': true,
      }),
      asked: asked,
      onPlan: (body) async => {'plan': 'standard', 'url': '/billing'},
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
    expect(identifiedBy(BillingIds.blocked), findsNothing);
    // Either plan ends the trial and starts paying now.
    expect(
      _inPlans(find.widgetWithText(FilledButton, 'Start Plus now')),
      findsOneWidget,
    );
    expect(
      _inPlans(find.text('Ends the trial and charges the first month now.')),
      findsNWidgets(3),
    );
    await tester.tap(_inPlans(find.widgetWithText(FilledButton, 'Start now')));
    await tester.pumpAndSettle();
    expect(find.text('Start now?'), findsOneWidget);
    await tester.tap(
      find.descendant(
        of: find.byType(AlertDialog),
        matching: find.widgetWithText(FilledButton, 'Start now'),
      ),
    );
    await tester.pumpAndSettle();
    final start = asked.firstWhere((a) => a.$1 == _planPath);
    expect(start.$2, containsPair('plan', 'standard'));
    expect(
      find.text(
        'Your Standard plan has started. Your new billing month starts today.',
      ),
      findsOneWidget,
    );
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
    await tester.tap(find.widgetWithText(FilledButton, 'Start Plus'));
    await tester.pumpAndSettle();
    expect(asked.last.$1, _checkout);
    expect(asked.last.$2, containsPair('kind', 'subscription'));
    expect(asked.last.$2, containsPair('plan', 'plus'));
    api.close();
  });

  testWidgets(
    'on Plus: nothing to move up to, and the way back is at renewal',
    (tester) async {
      final api = _api(subscribed({'includedMicros': 30000000}, plan: 'plus'));
      await _show(tester, api, size: const Size(390, 1800));
      expect(find.text('50% left'), findsOneWidget);
      expect(find.text('of this month’s Plus plan'), findsOneWidget);
      expect(find.text('Move to Plus'), findsNothing);
      expect(_inPlans(find.text('Your plan')), findsOneWidget);
      expect(
        _inPlans(find.widgetWithText(OutlinedButton, 'Move to Standard')),
        findsOneWidget,
      );
      expect(
        _inPlans(find.text('Starts when your plan renews.')),
        findsNWidgets(2),
      );
      api.close();
    },
  );

  testWidgets('BYO is sold beside the others, for your own models, with no '
      'usage included', (tester) async {
    final asked = <(String, Object?)>[];
    final api = _api(billing({'canSpend': false}), asked: asked);
    await _show(tester, api);
    expect(_inPlans(find.text('US\$5')), findsOneWidget);
    expect(
      _inPlans(
        find.text(
          'For your own models and Computer. Jev and connected apps included.',
        ),
      ),
      findsOneWidget,
    );
    expect(
      _inPlans(
        find.text(
          'No usage included · Jev up to US\$2 a month · everything else of ours from top-ups',
        ),
      ),
      findsOneWidget,
    );
    // Standard is still measured against itself, not against BYO's nothing.
    expect(
      _inPlans(find.text('Room for everyday chats and a few Routines.')),
      findsOneWidget,
    );
    await tester.tap(find.widgetWithText(FilledButton, 'Start BYO'));
    await tester.pumpAndSettle();
    expect(asked.last.$2, containsPair('plan', 'byo'));
    api.close();
  });

  testWidgets('on BYO: the month is measured in Jev fair use, with top-ups '
      'for the rest', (tester) async {
    final account = subscribed({
      'purchasedMicros': 4000000,
      'jevFairUse': {'remainingMicros': 1500000, 'grantedMicros': 2000000},
    }, plan: 'byo');
    final api = _api(account);
    await _show(tester, api);
    expect(find.text('75% of Jev left'), findsOneWidget);
    expect(
      _inGauge(
        find.textContaining('US\$4.00 of top-up credit for our Computer'),
      ),
      findsOneWidget,
    );
    expect(spendAllowance(account), isNull);
    api.close();
  });

  testWidgets(
    'on BYO with Jev fair use and credit spent: paused, and told why',
    (tester) async {
      final api = _api(
        subscribed({
          'jevFairUse': {'remainingMicros': 0, 'grantedMicros': 2000000},
        }, plan: 'byo'),
      );
      await _show(tester, api);
      expect(find.text('Paused until ${spendDate(_renews)}'), findsOneWidget);
      expect(
        find.text(
          'This month’s Jev fair use is used up. Top up to keep your Bots replying now.',
        ),
        findsOneWidget,
      );
      expect(_inGauge(find.text('Top up')), findsOneWidget);
      api.close();
    },
  );

  testWidgets('the gauge measures every live allowance as granted', (
    tester,
  ) async {
    // Moved down to Standard: the paid Plus month still runs to renewal.
    final api = _api(
      subscribed({
        'includedMicros': 30000000,
        'includedGrantedMicros': 60000000,
      }),
    );
    await _show(tester, api);
    expect(find.text('50% left'), findsOneWidget);
    api.close();
  });

  testWidgets('Plus is not for sale where the Package offers no way to it', (
    tester,
  ) async {
    final api = _api(billing({'canSpend': false}, plus: false));
    await _show(tester, api);
    expect(_inPlans(find.text('Standard')), findsOneWidget);
    expect(_inPlans(find.text('Plus')), findsNothing);
    expect(find.textContaining('Plus'), findsNothing);
    api.close();
  });

  testWidgets('a deployment that sells no plan shows none', (tester) async {
    final api = _api(
      billing({
        'canSpend': false,
        'plan': {
          'subscriptions': <Object>[],
          'trial': null,
          'topUpCents': [1000],
          'purchasedCreditNeedsSubscription': false,
        },
      }),
    );
    await _show(tester, api);
    expect(identifiedBy(BillingIds.plan), findsNothing);
    expect(find.text('They reply once you add credit.'), findsOneWidget);
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
              find.widgetWithText(FilledButton, 'Start Standard'),
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
    expect(find.textContaining('Start '), findsNothing);
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
      find.widgetWithText(FilledButton, 'Start Standard'),
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
