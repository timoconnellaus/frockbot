import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/settings/billing.dart';

import 'settings_test.dart' show SettingsApi;
import 'widget_test.dart' show MemoryStore;

void main() {
  testWidgets(
    'billing shows the plan, separate balances, top-ups, and recent usage',
    (tester) async {
      final api = SettingsApi(MemoryStore(), (path, body) async {
        expect(path, '/api/billing');
        return {
          'paymentsAvailable': true,
          'canSpend': true,
          'subscription': {
            'status': 'active',
            'periodEnd': DateTime.now()
                .add(const Duration(days: 20))
                .millisecondsSinceEpoch,
          },
          'includedMicros': 12500000,
          'purchasedMicros': 7000000,
          'reservedMicros': 500000,
          'computerRate': {
            'activeUsdPerHour': 2.75,
            'storageIncludedGb': 100,
            'viewerOpenSeconds': 30,
            'viewerRenewSeconds': 30,
          },
          'usage': [
            {
              'description': 'Hosted answer',
              'status': 'settled',
              'botId': 'research',
              'settlement': {'chargeMicros': 250000},
            },
          ],
        };
      });
      await tester.pumpWidget(MaterialApp(home: BillingPage(api: api)));
      await tester.pumpAndSettle();

      expect(
        find.text('US\$29 / month · US\$15 of monthly usage credit'),
        findsOneWidget,
      );
      expect(find.text('US\$12.50'), findsOneWidget);
      expect(find.text('US\$7.00'), findsOneWidget);
      expect(find.text('US\$0.50'), findsOneWidget);
      await tester.scrollUntilVisible(find.text('US\$10'), 300);
      expect(find.text('US\$10'), findsOneWidget);
      expect(find.text('US\$25'), findsOneWidget);
      expect(find.text('US\$50'), findsOneWidget);
      await tester.scrollUntilVisible(find.text('Hosted answer'), 300);
      expect(find.text('Hosted answer'), findsOneWidget);
      expect(find.text('US\$0.25'), findsOneWidget);
      expect(
        find.textContaining('Your own model provider bills you directly'),
        findsOneWidget,
      );
      await tester.scrollUntilVisible(find.text('Computer rate'), 300);
      expect(find.textContaining('US\$2.75 per active hour'), findsOneWidget);
      expect(
        find.textContaining('100 GB while idle is included'),
        findsOneWidget,
      );
      api.close();
    },
  );

  testWidgets(
    'complimentary credit is shown, spendable, and no reason to sell a top-up',
    (tester) async {
      final api = SettingsApi(
        MemoryStore(),
        (_, _) async => {
          'paymentsAvailable': true,
          'metered': true,
          'canSpend': true,
          'subscribed': false,
          'subscription': null,
          'includedMicros': 0,
          'complimentaryMicros': 5000000,
          'purchasedMicros': 0,
          'reservedMicros': 0,
          'usage': <Object>[],
        },
      );
      await tester.pumpWidget(MaterialApp(home: BillingPage(api: api)));
      await tester.pumpAndSettle();
      expect(find.text('Complimentary credit'), findsOneWidget);
      expect(find.text('US\$5.00'), findsOneWidget);
      expect(find.textContaining('Your Bots can’t reply'), findsNothing);
      await tester.scrollUntilVisible(find.text('US\$10'), 300);
      // A top-up is bought against a subscription, and there is none yet.
      for (final label in ['US\$10', 'US\$25', 'US\$50']) {
        expect(
          tester
              .widget<OutlinedButton>(
                find.widgetWithText(OutlinedButton, label),
              )
              .onPressed,
          isNull,
        );
      }
      api.close();
    },
  );

  testWidgets('a metered account that cannot spend is told so at the top', (
    tester,
  ) async {
    final api = SettingsApi(
      MemoryStore(),
      (_, _) async => {
        'paymentsAvailable': true,
        'metered': true,
        'canSpend': false,
        'subscribed': false,
        'subscription': null,
        'includedMicros': 0,
        'complimentaryMicros': 0,
        'purchasedMicros': 0,
        'reservedMicros': 0,
        'usage': <Object>[],
      },
    );
    await tester.pumpWidget(MaterialApp(home: BillingPage(api: api)));
    await tester.pumpAndSettle();
    expect(
      find.text('Your Bots can’t reply until you subscribe or receive credit.'),
      findsOneWidget,
    );
    expect(find.text('Complimentary credit'), findsNothing);
    api.close();
  });

  testWidgets('billing disables purchases when payment setup is unavailable', (
    tester,
  ) async {
    final api = SettingsApi(
      MemoryStore(),
      (_, _) async => {
        'paymentsAvailable': false,
        'canSpend': false,
        'subscription': null,
        'includedMicros': 0,
        'purchasedMicros': 0,
        'reservedMicros': 0,
        'usage': <Object>[],
      },
    );
    await tester.pumpWidget(MaterialApp(home: BillingPage(api: api)));
    await tester.pumpAndSettle();
    expect(find.text('Payments are not available yet.'), findsOneWidget);
    await tester.scrollUntilVisible(
      find.text('Subscribe — US\$29 / month'),
      300,
    );
    final subscribe = tester.widget<FilledButton>(
      find.widgetWithText(FilledButton, 'Subscribe — US\$29 / month'),
    );
    expect(subscribe.onPressed, isNull);
    for (final label in ['US\$10', 'US\$25', 'US\$50']) {
      expect(
        tester
            .widget<OutlinedButton>(find.widgetWithText(OutlinedButton, label))
            .onPressed,
        isNull,
      );
    }
    api.close();
  });
}
