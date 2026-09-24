/// Deleting what is yours outright: the Computer, or the whole account.
///
/// Both are immediate. The Computer goes and the next Bot that needs one gets
/// a new, empty one; the account goes with everything in it, and this device
/// signs out the moment the deletion is under way. The only confirmation an
/// account deletion takes is typing the address it signs in with.
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../client/transport.dart';
import '../shell/desktop_layout.dart';
import '../shell/semantics.dart';
import '../theme/dialogs.dart';

/// `GET` says what to type; `POST` with it deletes the account.
const accountDeletionPath = '/api/account/delete';

/// `POST` deletes the Computer.
const computerDeletionPath = '/api/computer/delete';

abstract final class DeletionIds {
  static const page = 'deletion-page';
  static const computerDelete = 'deletion-computer';
  static const computerConfirm = 'deletion-computer-confirm';
  static const computerStatus = 'deletion-computer-status';
  static const accountField = 'deletion-account-field';
  static const accountDelete = 'deletion-account';
  static const accountStatus = 'deletion-account-status';
}

/// Whether what was typed is the phrase: compared as an email is, trimmed
/// and without regard to case. The server checks the same thing again.
bool deletionConfirmed(String expected, String typed) =>
    typed.trim().toLowerCase() == expected.trim().toLowerCase();

class DeletionPage extends StatefulWidget {
  final NativeApi api;

  /// Signs this device out once the account is being deleted. Nothing about
  /// the account is left to show.
  final Future<void> Function() onAccountDeleted;

  const DeletionPage({
    super.key,
    required this.api,
    required this.onAccountDeleted,
  });

  @override
  State<DeletionPage> createState() => _DeletionPageState();
}

class _DeletionPageState extends State<DeletionPage> {
  final typed = TextEditingController();
  String? confirmation;
  String? loadError;
  bool computerBusy = false;
  String? computerStatus;
  bool accountBusy = false;
  String? accountError;

  /// One id per press, kept across retries of that press, so a retry after a
  /// lost answer is the same command and never deletes a newer Computer.
  String? computerCommand;
  String? accountCommand;

  @override
  void initState() {
    super.initState();
    typed.addListener(() => setState(() {}));
    unawaited(_load());
  }

  @override
  void dispose() {
    typed.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final answer = await widget.api.request(accountDeletionPath);
      final phrase = answer is Map ? answer['confirmation'] : null;
      if (phrase is! String || phrase.isEmpty) {
        throw const FormatException('No confirmation');
      }
      if (mounted) setState(() => confirmation = phrase);
    } catch (error) {
      if (mounted) {
        setState(
          () => loadError = error is RequestFailure
              ? error.message
              : 'Couldn’t load this page. Please try again.',
        );
      }
    }
  }

  Future<void> _deleteComputer() async {
    final confirmed =
        await showDialog<bool>(
          context: context,
          builder: (dialog) => identified(
            DeletionIds.computerConfirm,
            AlertDialog(
              insetPadding: frockDialogInset,
              title: frockDialogTitle(const Text('Delete your Computer?')),
              content: frockDialogBody(
                const Text(
                  'Its files and browser sign-ins are deleted now. Your Bots '
                  'keep their Memory and Skills, and get a new, empty '
                  'Computer the next time they need one.',
                ),
              ),
              actions: [
                TextButton(
                  onPressed: () => Navigator.pop(dialog, false),
                  child: const Text('Cancel'),
                ),
                FilledButton(
                  style: FilledButton.styleFrom(
                    backgroundColor: Theme.of(dialog).colorScheme.error,
                    foregroundColor: Theme.of(dialog).colorScheme.onError,
                  ),
                  onPressed: () => Navigator.pop(dialog, true),
                  child: const Text('Delete'),
                ),
              ],
            ),
          ),
        ) ??
        false;
    if (!confirmed || !mounted) return;
    final commandId = computerCommand ??= randomId();
    setState(() {
      computerBusy = true;
      computerStatus = null;
    });
    try {
      final answer = await widget.api.request(
        computerDeletionPath,
        body: {'schemaVersion': 1, 'commandId': commandId},
      );
      final status = answer is Map ? answer['status'] : null;
      computerCommand = null;
      computerStatus = status == 'unavailable'
          ? 'There is no Computer to delete here.'
          : 'Your Computer was deleted.';
    } on RequestFailure catch (error) {
      computerStatus = error.message;
    } finally {
      if (mounted) setState(() => computerBusy = false);
    }
  }

  Future<void> _deleteAccount() async {
    final phrase = confirmation;
    if (phrase == null || !deletionConfirmed(phrase, typed.text)) return;
    final commandId = accountCommand ??= randomId();
    setState(() {
      accountBusy = true;
      accountError = null;
    });
    try {
      await widget.api.request(
        accountDeletionPath,
        body: {
          'schemaVersion': 1,
          'commandId': commandId,
          'confirmation': typed.text,
        },
      );
      await widget.onAccountDeleted();
    } on RequestFailure catch (error) {
      if (!mounted) return;
      setState(() {
        accountBusy = false;
        accountError = error.code == 'confirmation-mismatch'
            ? 'Type $phrase to confirm.'
            : error.message;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final danger = theme.colorScheme.error;
    final phrase = confirmation;
    final ready =
        phrase != null && !accountBusy && deletionConfirmed(phrase, typed.text);
    Widget card(List<Widget> children) => Card(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: children,
        ),
      ),
    );
    return Scaffold(
      appBar: DesktopHeader(child: AppBar(title: const Text('Delete'))),
      body: identified(
        DeletionIds.page,
        SafeArea(
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 680),
              child: ListView(
                padding: const EdgeInsets.all(20),
                children: [
                  card([
                    Text(
                      'Delete my Computer',
                      style: theme.textTheme.titleMedium,
                    ),
                    const SizedBox(height: 8),
                    const Text(
                      'Deletes your Computer’s files and browser sign-ins. '
                      'Your Bots, their Memory and your Skills stay, and a new '
                      'Computer is made the next time a Bot needs one.',
                    ),
                    const SizedBox(height: 12),
                    identified(
                      DeletionIds.computerDelete,
                      OutlinedButton.icon(
                        style: OutlinedButton.styleFrom(
                          foregroundColor: danger,
                        ),
                        onPressed: computerBusy ? null : _deleteComputer,
                        icon: const Icon(Icons.computer_outlined),
                        label: Text(
                          computerBusy ? 'Deleting…' : 'Delete my Computer',
                        ),
                      ),
                    ),
                    if (computerStatus case final String status) ...[
                      const SizedBox(height: 8),
                      identified(DeletionIds.computerStatus, Text(status)),
                    ],
                  ]),
                  const SizedBox(height: 24),
                  card([
                    Text('Delete account', style: theme.textTheme.titleMedium),
                    const SizedBox(height: 8),
                    const Text(
                      'Deletes your account and everything in it, straight '
                      'away: every Bot and conversation, your Memory, files '
                      'and Computer, and your connected apps. Your '
                      'subscription ends now, with no refund for what is '
                      'left of it. This can’t be undone.',
                    ),
                    const SizedBox(height: 16),
                    if (loadError case final String error)
                      Text(error, style: TextStyle(color: danger))
                    else if (phrase == null)
                      const LinearProgressIndicator()
                    else ...[
                      Text('Type $phrase to confirm.'),
                      const SizedBox(height: 8),
                      identified(
                        DeletionIds.accountField,
                        TextField(
                          controller: typed,
                          enabled: !accountBusy,
                          autocorrect: false,
                          enableSuggestions: false,
                          keyboardType: TextInputType.emailAddress,
                          decoration: InputDecoration(
                            border: const OutlineInputBorder(),
                            hintText: phrase,
                          ),
                          onSubmitted: (_) => ready ? _deleteAccount() : null,
                        ),
                      ),
                      const SizedBox(height: 12),
                      identified(
                        DeletionIds.accountDelete,
                        FilledButton.icon(
                          style: FilledButton.styleFrom(
                            backgroundColor: danger,
                            foregroundColor: theme.colorScheme.onError,
                          ),
                          onPressed: ready ? _deleteAccount : null,
                          icon: const Icon(Icons.delete_forever_outlined),
                          label: Text(
                            accountBusy ? 'Deleting…' : 'Delete account',
                          ),
                        ),
                      ),
                    ],
                    if (accountError case final String error) ...[
                      const SizedBox(height: 8),
                      identified(
                        DeletionIds.accountStatus,
                        Text(error, style: TextStyle(color: danger)),
                      ),
                    ],
                  ]),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
