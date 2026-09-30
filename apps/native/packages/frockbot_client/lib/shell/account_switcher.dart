/// The account switcher: which account the Bot list is, and every other the
/// app is signed in to, like a Slack workspace list.
///
/// The row at the top of the Bot list names the account on screen and where
/// it is — frockbot.com, or a self-hosted server's host — and carries a dot
/// when another account has something unread. It opens a sheet listing every
/// account with its unread count, where a person switches, signs out of one,
/// or adds another. The app builds it and the shell only places it, so the
/// shell never learns that other accounts exist.
library;

import 'package:flutter/material.dart';

import '../client/accounts.dart';
import 'semantics.dart';

class AccountSwitcher extends StatelessWidget {
  final List<AccountRecord> accounts;
  final String activeId;

  /// Each other account's unread count, by account id.
  final int Function(String accountId) unreadOf;
  final void Function(AccountRecord account) onSwitch;
  final void Function(AccountRecord account) onSignOut;
  final VoidCallback onAdd;
  const AccountSwitcher({
    super.key,
    required this.accounts,
    required this.activeId,
    required this.unreadOf,
    required this.onSwitch,
    required this.onSignOut,
    required this.onAdd,
  });

  AccountRecord? get _active {
    for (final account in accounts) {
      if (account.id == activeId) return account;
    }
    return null;
  }

  int get _elsewhere => accounts.fold(
    0,
    (sum, account) => account.id == activeId ? sum : sum + unreadOf(account.id),
  );

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final active = _active;
    final elsewhere = _elsewhere;
    return Padding(
      padding: const EdgeInsets.fromLTRB(8, 0, 8, 6),
      child: identified(
        AccountIds.switcher,
        Semantics(
          button: true,
          label: active == null
              ? 'Accounts'
              : 'Account: ${active.serverLabel}'
                    '${elsewhere > 0 ? ', $elsewhere unread in other accounts' : ''}',
          excludeSemantics: true,
          child: InkWell(
            borderRadius: BorderRadius.circular(10),
            onTap: () => _open(context),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
              child: Row(
                children: [
                  _ServerMark(account: active),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      active?.serverLabel ?? 'Accounts',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.labelLarge,
                    ),
                  ),
                  if (elsewhere > 0)
                    Padding(
                      padding: const EdgeInsets.only(right: 6),
                      child: _Count(elsewhere),
                    ),
                  Icon(
                    Icons.unfold_more_rounded,
                    size: 18,
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _open(BuildContext context) => showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    constraints: const BoxConstraints(maxWidth: 480),
    builder: (sheet) => SafeArea(
      child: ListView(
        shrinkWrap: true,
        padding: const EdgeInsets.only(bottom: 12),
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 8),
            child: Text(
              'Accounts',
              style: Theme.of(sheet).textTheme.titleMedium,
            ),
          ),
          for (final account in accounts)
            identified(
              AccountIds.row(account.id),
              ListTile(
                leading: _ServerMark(account: account),
                title: Text(
                  account.serverLabel,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                subtitle: Text(
                  account.id == activeId ? 'Open now' : account.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                selected: account.id == activeId,
                // The server's mark keeps its colour on the open account.
                selectedTileColor: Theme.of(sheet)
                    .colorScheme
                    .surfaceContainerHighest,
                selectedColor: Theme.of(sheet).colorScheme.onSurface,
                onTap: () {
                  Navigator.of(sheet).pop();
                  if (account.id != activeId) onSwitch(account);
                },
                trailing: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (account.id != activeId && unreadOf(account.id) > 0)
                      _Count(unreadOf(account.id)),
                    identified(
                      AccountIds.signOut(account.id),
                      PopupMenuButton<void>(
                        tooltip: 'More for ${account.serverLabel}',
                        icon: const Icon(Icons.more_horiz_rounded),
                        itemBuilder: (_) => [
                          PopupMenuItem<void>(
                            onTap: () {
                              Navigator.of(sheet).pop();
                              onSignOut(account);
                            },
                            child: Text('Sign out of ${account.serverLabel}'),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
          const Divider(height: 16),
          identified(
            AccountIds.add,
            ListTile(
              leading: const Icon(Icons.add_rounded),
              title: const Text('Add an account'),
              subtitle: const Text('Another sign-in, or another server'),
              onTap: () {
                Navigator.of(sheet).pop();
                onAdd();
              },
            ),
          ),
        ],
      ),
    ),
  );
}

/// A server's initial on a tile, so accounts on different servers are told
/// apart at a glance.
class _ServerMark extends StatelessWidget {
  final AccountRecord? account;
  const _ServerMark({required this.account});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final label = account?.serverLabel ?? '';
    final hosted = account?.hosted ?? false;
    return Container(
      width: 26,
      height: 26,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: hosted ? scheme.primary : scheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(7),
      ),
      child: Text(
        label.isEmpty ? '?' : label.characters.first.toUpperCase(),
        style: TextStyle(
          fontSize: 13,
          fontWeight: FontWeight.w700,
          color: hosted ? scheme.onPrimary : scheme.onSurface,
        ),
      ),
    );
  }
}

class _Count extends StatelessWidget {
  final int count;
  const _Count(this.count);

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
      decoration: BoxDecoration(
        color: scheme.primary,
        borderRadius: BorderRadius.circular(9),
      ),
      child: Text(
        count > 99 ? '99+' : '$count',
        style: TextStyle(
          fontSize: 11,
          fontWeight: FontWeight.w700,
          color: scheme.onPrimary,
        ),
      ),
    );
  }
}
