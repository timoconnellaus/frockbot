import 'dart:async';

import 'package:flutter/material.dart';

import '../client/transport.dart';
import '../shell/semantics.dart';
import '../theme/states.dart';

/// The amounts an admin is offered. Anything else is typed.
const creditPresetCents = [500, 1000, 2500, 5000];

/// The one write against an account's ledger: an amount and why.
class CreditDialog extends StatefulWidget {
  final String account;
  const CreditDialog({super.key, required this.account});

  @override
  State<CreditDialog> createState() => _CreditDialogState();
}

class _CreditDialogState extends State<CreditDialog> {
  int? cents;
  final custom = TextEditingController();
  final reason = TextEditingController();

  @override
  void dispose() {
    custom.dispose();
    reason.dispose();
    super.dispose();
  }

  int? get chosen {
    if (cents != null) return cents;
    final typed = double.tryParse(custom.text.trim());
    if (typed == null || typed <= 0 || typed > 1000) return null;
    return (typed * 100).round();
  }

  @override
  Widget build(BuildContext context) {
    final amount = chosen;
    final ready = amount != null && reason.text.trim().isNotEmpty;
    return identified(
      AdminIds.creditDialog,
      AlertDialog(
        title: Text('Add credit for ${widget.account}'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Wrap(
              spacing: 8,
              children: [
                for (final preset in creditPresetCents)
                  identified(
                    AdminIds.creditAmount(preset),
                    ChoiceChip(
                      label: Text('US\$${preset ~/ 100}'),
                      selected: cents == preset,
                      onSelected: (_) => setState(() {
                        cents = preset;
                        custom.clear();
                      }),
                    ),
                  ),
              ],
            ),
            const SizedBox(height: 12),
            TextField(
              controller: custom,
              keyboardType: const TextInputType.numberWithOptions(
                decimal: true,
              ),
              decoration: const InputDecoration(
                labelText: 'Or another amount, in US dollars',
                helperText: 'Up to US\$1,000 at a time.',
              ),
              onChanged: (_) => setState(() => cents = null),
            ),
            const SizedBox(height: 12),
            identified(
              AdminIds.creditReason,
              TextField(
                controller: reason,
                decoration: const InputDecoration(
                  labelText: 'Reason',
                  helperText: 'Kept with the grant.',
                ),
                onChanged: (_) => setState(() {}),
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('Cancel'),
          ),
          identified(
            AdminIds.creditConfirm,
            FilledButton(
              onPressed: ready
                  ? () =>
                        Navigator.of(context)
                            .pop((cents: amount, reason: reason.text.trim()))
                  : null,
              child: const Text('Add credit'),
            ),
          ),
        ],
      ),
    );
  }
}

/// Admin: the decisions this app makes for the deployment rather than for
/// an account — whether anyone new may sign up, and which accounts hold
/// Applets.
///
/// It is not a document surface. The deployment policy is not a User's
/// settings: it belongs to the deployment, is refused for anyone who is not an
/// admin, and carries its own revision, so it reads and writes its own route
/// rather than borrowing the settings projection. Account features are the
/// same shape of decision, made one account at a time.
class AdminPage extends StatefulWidget {
  final NativeApi api;
  const AdminPage({super.key, required this.api});

  @override
  State<AdminPage> createState() => _AdminPageState();
}

class _AdminPageState extends State<AdminPage> {
  Map<String, Object?>? policy;
  List<Map<String, Object?>>? accounts;
  bool busy = false;
  bool refused = false;
  String? message;
  String? accountsMessage;

  @override
  void initState() {
    super.initState();
    unawaited(load());
  }

  Future<void> load() async {
    if (busy) return;
    setState(() {
      busy = true;
      message = null;
    });
    try {
      final answer = await widget.api.request('/api/admin/policy');
      if (mounted) {
        setState(() {
          policy = ((answer as Map?) ?? const {}).cast<String, Object?>();
          refused = false;
        });
      }
      await loadAccounts();
    } on RequestFailure catch (failure) {
      if (mounted) {
        setState(() {
          policy = null;
          refused = failure.refused;
          message = failure.refused
              ? 'This account isn’t an admin of this deployment.'
              : 'Couldn’t reach FrockBot. Check your connection and try again.';
        });
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          policy = null;
          message =
              'Couldn’t reach FrockBot. Check your connection and try again.';
        });
      }
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  /// The accounts and what each holds. Separate from the policy read so a
  /// list that cannot load leaves the signups switch usable.
  Future<void> loadAccounts() async {
    try {
      final answer = await widget.api.request('/api/admin/users');
      final listed = (((answer as Map?) ?? const {})['users'] as List?) ?? [];
      if (mounted) {
        setState(() {
          accounts = [
            for (final user in listed.cast<Map>()) user.cast<String, Object?>(),
          ];
          accountsMessage = null;
        });
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          accounts = null;
          accountsMessage = 'Couldn’t load the accounts. Refresh to try again.';
        });
      }
    }
  }

  Future<void> setSignups(bool open) async {
    final current = policy;
    if (current == null || busy) return;
    setState(() {
      busy = true;
      message = null;
    });
    try {
      final answer = await widget.api.request(
        '/api/admin/policy',
        body: {
          'schemaVersion': 1,
          'type': 'deployment/set-signups',
          'open': open,
          'revision': current['revision'],
        },
      );
      if (mounted) {
        setState(
          () => policy = ((answer as Map?) ?? const {}).cast<String, Object?>(),
        );
      }
    } catch (_) {
      if (mounted) {
        setState(
          () => message = 'That change didn’t stick. Refresh and try again.',
        );
      }
      await load();
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  /// Credit given by hand. The id is minted here, once per dialog, so the
  /// request can land twice and grant once.
  Future<void> grantCredit(String userId, int cents, String reason) async {
    if (busy) return;
    setState(() {
      busy = true;
      accountsMessage = null;
    });
    try {
      final answer = await widget.api.request(
        '/api/admin/users/${Uri.encodeComponent(userId)}/credit',
        body: {
          'schemaVersion': 1,
          'type': 'user/grant-credit',
          'id': randomId(),
          'cents': cents,
          'reason': reason,
        },
      );
      if (mounted) {
        setState(() {
          accounts = [
            for (final account in accounts ?? const <Map<String, Object?>>[])
              if (account['userId'] == userId)
                {...account, 'billing': answer}
              else
                account,
          ];
        });
      }
    } catch (_) {
      await loadAccounts();
      if (mounted && accountsMessage == null) {
        setState(
          () => accountsMessage =
              'That credit didn’t land. Refresh and try again.',
        );
      }
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> _askCredit(String userId, String title) async {
    final grant = await showDialog<({int cents, String reason})>(
      context: context,
      builder: (_) => CreditDialog(account: title),
    );
    if (grant == null) return;
    await grantCredit(userId, grant.cents, grant.reason);
  }

  Future<void> setApplets(String userId, bool enabled) async {
    if (busy) return;
    setState(() {
      busy = true;
      accountsMessage = null;
    });
    try {
      final answer = await widget.api.request(
        '/api/admin/users/${Uri.encodeComponent(userId)}/features',
        body: {
          'schemaVersion': 1,
          'type': 'user/set-features',
          'applets': enabled,
        },
      );
      if (mounted) {
        setState(() {
          accounts = [
            for (final account in accounts ?? const <Map<String, Object?>>[])
              if (account['userId'] == userId)
                {...account, 'features': answer}
              else
                account,
          ];
        });
      }
    } catch (_) {
      await loadAccounts();
      if (mounted && accountsMessage == null) {
        setState(
          () => accountsMessage =
              'That change didn’t stick. Refresh and try again.',
        );
      }
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final current = policy;
    final signups = ((current?['signups'] as Map?) ?? const {})['open'] == true;
    final textTheme = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Site administration'),
        actions: [
          identified(
            AdminIds.refresh,
            IconButton(
              tooltip: 'Refresh the deployment policy',
              onPressed: busy ? null : load,
              icon: const Icon(Icons.refresh_rounded),
            ),
          ),
        ],
      ),
      body: SafeArea(
        top: false,
        child: current == null
            ? busy
                  ? const FrockLoading(label: 'Loading the deployment policy')
                  : FrockEmptyState(
                      icon: refused
                          ? Icons.lock_outline_rounded
                          : Icons.cloud_off_rounded,
                      title: refused ? 'Admin only' : 'Admin couldn’t load',
                      detail: message ?? 'Check your connection and try again.',
                      action: 'Try again',
                      onAction: load,
                    )
            : ListView(
                padding: const EdgeInsets.fromLTRB(20, 12, 20, 32),
                children: [
                  Center(
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 680),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          identified(
                            AdminIds.signups,
                            SwitchListTile(
                              contentPadding: EdgeInsets.zero,
                              title: const Text('Allow new signups'),
                              subtitle: Text(
                                signups
                                    ? 'Anyone with the link can create an account.'
                                    : 'Only people who already have an account can sign in.',
                              ),
                              value: signups,
                              onChanged: busy ? null : setSignups,
                            ),
                          ),
                          const SizedBox(height: 12),
                          Text(
                            current['updatedBy'] == 'deployment-default'
                                ? 'Default setting'
                                : 'Last changed by ${current['updatedBy'] ?? 'an administrator'}.',
                            style: textTheme.bodySmall,
                          ),
                          if (message != null)
                            Padding(
                              padding: const EdgeInsets.only(top: 16),
                              child: Semantics(
                                liveRegion: true,
                                child: Text(message!),
                              ),
                            ),
                          const SizedBox(height: 32),
                          Text('Accounts', style: textTheme.titleMedium),
                          const SizedBox(height: 4),
                          Text(
                            'Each account’s Applets switch — the small real-time apps a Bot '
                            'builds beside the conversation — and its credit. Complimentary '
                            'credit is spendable without a subscription and never expires.',
                            style: textTheme.bodySmall,
                          ),
                          const SizedBox(height: 8),
                          identified(AdminIds.accounts, _accounts(context)),
                          if (accountsMessage != null)
                            Padding(
                              padding: const EdgeInsets.only(top: 16),
                              child: Semantics(
                                liveRegion: true,
                                child: Text(accountsMessage!),
                              ),
                            ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
      ),
    );
  }

  Widget _accounts(BuildContext context) {
    final listed = accounts;
    if (listed == null) {
      return accountsMessage == null
          ? const Padding(
              padding: EdgeInsets.symmetric(vertical: 12),
              child: Text('Loading the accounts…'),
            )
          : const SizedBox.shrink();
    }
    if (listed.isEmpty) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: 12),
        child: Text('No accounts yet.'),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [for (final account in listed) _account(account)],
    );
  }

  Widget _account(Map<String, Object?> account) {
    final userId = account['userId'] as String? ?? '';
    final name = account['name'] as String?;
    final email = account['email'] as String?;
    final title =
        (name != null && name.isNotEmpty ? name : null) ?? email ?? userId;
    final detail = [
      if (email != null && email != title) email,
      if (userId != title) userId,
    ].join(' · ');
    final features = ((account['features'] as Map?) ?? const {});
    if (features['unavailable'] == true) {
      return _unreadableAccount(userId, title, detail);
    }
    final enabled = features['applets'] == true;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        identified(
          AdminIds.applets(userId),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: Text(title),
            subtitle: detail.isEmpty ? null : Text(detail),
            value: enabled,
            onChanged: busy ? null : (value) => setApplets(userId, value),
          ),
        ),
        _credit(account, userId, title),
      ],
    );
  }

  /// What the account can spend, and the one thing an admin can do about it.
  Widget _credit(Map<String, Object?> account, String userId, String title) {
    final billing = (account['billing'] as Map?) ?? const {};
    final String line;
    if (billing['unavailable'] == true) {
      line = 'Couldn’t read this account’s credit.';
    } else {
      String money(Object? micros) =>
          'US\$${((micros as num? ?? 0) / 1000000).toStringAsFixed(2)}';
      final parts = [
        if (billing['subscribed'] == true) 'Subscribed' else 'No subscription',
        '${money(billing['complimentaryMicros'])} complimentary',
        if ((billing['includedMicros'] as num? ?? 0) > 0)
          '${money(billing['includedMicros'])} monthly',
        if ((billing['purchasedMicros'] as num? ?? 0) > 0)
          '${money(billing['purchasedMicros'])} purchased',
        if (billing['suspended'] == true) 'suspended',
        if (billing['canSpend'] != true) 'can’t reply',
      ];
      line = parts.join(' · ');
    }
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        children: [
          Expanded(
            child: identified(
              AdminIds.credit(userId),
              Text(line, style: Theme.of(context).textTheme.bodySmall),
            ),
          ),
          identified(
            AdminIds.addCredit(userId),
            TextButton.icon(
              onPressed: busy
                  ? null
                  : () => unawaited(_askCredit(userId, title)),
              icon: const Icon(Icons.add_rounded, size: 18),
              label: const Text('Add credit'),
            ),
          ),
        ],
      ),
    );
  }

  /// An account whose Applets setting could not be read when the list was
  /// built. The switch is disabled rather than off: off is a value the account
  /// holds, and this account's value is not known. Trying again re-reads the
  /// list, so the other accounts refresh with it.
  Widget _unreadableAccount(String userId, String title, String detail) {
    return identified(
      AdminIds.applets(userId),
      SwitchListTile(
        contentPadding: EdgeInsets.zero,
        title: Text(title),
        subtitle: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (detail.isNotEmpty) Text(detail),
            const Text(
              'Couldn’t read whether Applets are on for this account.',
            ),
            Align(
              alignment: Alignment.centerLeft,
              child: identified(
                AdminIds.appletsRetry(userId),
                TextButton(
                  onPressed: busy ? null : () => unawaited(loadAccounts()),
                  child: const Text('Try again'),
                ),
              ),
            ),
          ],
        ),
        value: false,
        onChanged: null,
      ),
    );
  }
}
