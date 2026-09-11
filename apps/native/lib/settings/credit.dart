import 'package:flutter/material.dart';

/// What the account can spend, as `/api/billing` answers it. Only a metered
/// deployment has one: elsewhere nothing is charged, nothing is refused, and
/// there is nothing to show.
class AccountCredit {
  /// Everything still spendable, across the three kinds of grant.
  final int availableMicros;

  /// Whether a reply would be admitted at all. False with no subscription and
  /// no complimentary credit, or with the account suspended.
  final bool canSpend;
  final bool subscribed;
  final bool suspended;
  const AccountCredit({
    required this.availableMicros,
    required this.canSpend,
    required this.subscribed,
    required this.suspended,
  });

  static AccountCredit? decode(Object? answer) {
    if (answer is! Map || answer['metered'] != true) return null;
    int micros(String key) => (answer[key] as num?)?.toInt() ?? 0;
    return AccountCredit(
      availableMicros:
          micros('includedMicros') +
          micros('complimentaryMicros') +
          micros('purchasedMicros'),
      canSpend: answer['canSpend'] == true,
      subscribed: answer['subscribed'] == true,
      suspended: answer['suspended'] == true,
    );
  }

  String get amount => 'US\$${(availableMicros / 1000000).toStringAsFixed(2)}';

  @override
  bool operator ==(Object other) =>
      other is AccountCredit &&
      other.availableMicros == availableMicros &&
      other.canSpend == canSpend &&
      other.subscribed == subscribed &&
      other.suspended == suspended;

  @override
  int get hashCode =>
      Object.hash(availableMicros, canSpend, subscribed, suspended);
}

/// The balance at the top of the Profile page: the amount, and whether a Bot
/// can reply on it. Tapping it opens Billing.
class CreditTile extends StatelessWidget {
  final AccountCredit credit;
  final VoidCallback onTap;
  const CreditTile({super.key, required this.credit, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final blocked = !credit.canSpend;
    final detail = credit.suspended
        ? 'Payments need review. Your Bots can’t reply until it’s resolved.'
        : !credit.canSpend
        ? 'Your Bots can’t reply until you subscribe or add credit.'
        : credit.subscribed
        ? 'Subscribed. Hosted models and your Computer draw on this.'
        : 'Complimentary credit. Your Bots reply while it lasts.';
    return Card(
      margin: const EdgeInsets.only(top: 12),
      color: blocked ? scheme.errorContainer : null,
      child: ListTile(
        leading: Icon(
          blocked
              ? Icons.error_outline_rounded
              : Icons.account_balance_wallet_outlined,
          color: blocked ? scheme.onErrorContainer : null,
        ),
        title: Text(
          blocked ? 'No credit' : '${credit.amount} credit remaining',
          style: TextStyle(
            fontWeight: FontWeight.w600,
            color: blocked ? scheme.onErrorContainer : null,
          ),
        ),
        subtitle: Text(
          detail,
          style: TextStyle(color: blocked ? scheme.onErrorContainer : null),
        ),
        trailing: Icon(
          Icons.chevron_right_rounded,
          color: blocked ? scheme.onErrorContainer : null,
        ),
        onTap: onTap,
      ),
    );
  }
}
