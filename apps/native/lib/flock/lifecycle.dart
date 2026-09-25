/// Archiving, restoring and deleting a Bot — the Flock's own authority.
///
/// Deleting a Bot removes the registration from the directory the Flock owns,
/// so the affordance is contributed into Bot settings from here rather than
/// rebuilt inside the settings surface.
///
/// One retained command, under one key, whatever surface issued it. The route
/// answers `pending` for a change whose saga has not settled, so a lost reply
/// is never a second command: the id is written before the request and the same
/// id is re-sent until the authority says what became of it.
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';

import '../client/transport.dart';
import '../protocol/client_wire.generated.dart' as wire;
import '../shell/semantics.dart';
import '../theme/dialogs.dart';
import '../theme/rows.dart';

/// The three lifecycle commands, and what each is called where a person reads
/// it. The wire type is the key so nothing else has to know the strings.
const botLifecycleWordsV1 =
    <String, ({String verb, String title, String body})>{
      'bot/archive': (
        verb: 'Archive Bot',
        title: 'Archive',
        body: 'Archiving stops new work and takes the Bot out of your flock. Its history is preserved, and you can restore it later.',
      ),
      'bot/restore': (
        verb: 'Restore Bot',
        title: 'Restore',
        body: 'Bring this Bot back to your active list. Its history will still be there.',
      ),
      'bot/delete': (
        verb: 'Delete',
        title: 'Delete',
        body: 'This removes its conversation and cannot be undone. To stop the Bot working while keeping its history, archive it instead.',
      ),
    };

/// One retained lifecycle command, shared by every surface that issues one.
class BotLifecycleCommands extends ChangeNotifier {
  final NativeApi api;
  final LocalStore store;
  final String userId;
  BotLifecycleCommands(this.api, this.store, this.userId);

  bool saving = false;
  String? error;
  String? message;
  Map<String, dynamic>? _command;
  bool _closed = false;

  bool get pending => _command != null;
  String? get pendingBot => _command?['botId'] as String?;
  String get _key => 'bot-lifecycle.$userId';

  void _changed() {
    if (!_closed) notifyListeners();
  }

  /// Adopts a command whose reply never arrived, so the next press checks that
  /// one rather than starting a second.
  Future<void> restore() async {
    final saved = await store.read(_key);
    if (saved == null || _closed || _command != null) return;
    final value = jsonDecode(saved) as Map<String, dynamic>;
    wire.BotLifecycleCommand.fromJson(value);
    _command = value;
    _changed();
  }

  /// Issues a change, unless one is still unaccounted for.
  Future<bool> change(String botId, String type) async {
    if (_closed || saving || pending) return false;
    _command = Map<String, dynamic>.from(
      wire.BotLifecycleCommand.fromJson({
            'schemaVersion': 1,
            'type': type,
            'commandId': randomId(),
            'botId': botId,
          }).toJson()!
          as Map,
    );
    return retry();
  }

  /// Asks, then issues the change.
  Future<bool> confirmChange(
    String botId,
    String type, {
    required Future<bool> Function() confirm,
  }) async {
    if (_closed || saving || pending) return false;
    if (!await confirm()) return false;
    return change(botId, type);
  }

  /// Dispatches the retained command, under its own id, however many times it
  /// takes to learn what happened to it.
  Future<bool> retry() async {
    if (_closed || saving || _command == null) return false;
    saving = true;
    message = null;
    _changed();
    final command = _command!;
    final botId = command['botId'] as String;
    var applied = false;
    try {
      await store.write(_key, jsonEncode(command));
      if (_closed) return false;
      final receipt = Map<String, dynamic>.from(
        wire.BotLifecycleReceipt.fromJson(
              await api.request(
                '/api/bots/${Uri.encodeComponent(botId)}/lifecycle',
                body: command,
              ),
            ).toJson()
            as Map,
      );
      if (receipt['commandId'] != command['commandId'] ||
          receipt['botId'] != botId ||
          (receipt['lifecycle'] as Map)['botId'] != botId) {
        throw const FormatException('Mismatched receipt');
      }
      if (receipt['status'] == 'pending') {
        message = switch (command['type']) {
          'bot/archive' => 'Still archiving — this will finish shortly.',
          'bot/restore' => 'Still restoring — this will finish shortly.',
          _ => 'Still deleting — this will finish shortly.',
        };
        return false;
      }
      await store.delete(_key);
      _command = null;
      if (receipt['status'] == 'rejected') {
        error = (receipt['failure'] as String?) ?? 'That change couldn’t be completed. Refresh your Bots and try again.';
        return false;
      }
      applied = true;
      error = null;
      message = switch (command['type']) {
        'bot/archive' =>
          'Bot archived. It’s under Archived, at the foot of your Bots.',
        'bot/restore' => 'Bot restored.',
        _ => 'Bot deleted.',
      };
    } on RequestFailure catch (_) {
      error = 'Couldn’t confirm that change. Check its status before trying another action.';
    } catch (_) {
      error = 'Couldn’t confirm that change. Check its status before trying another action.';
    } finally {
      saving = false;
      _changed();
    }
    return applied;
  }

  @override
  void dispose() {
    _closed = true;
    super.dispose();
  }
}

/// Asks about a lifecycle change in the authority's words and issues it.
///
/// One dialog for every surface that archives, restores or deletes a Bot —
/// the danger zone on its page and the quick actions on its row — so the
/// verb it offers never differs by where it was asked. Returns whether the
/// change was applied.
Future<bool> confirmBotLifecycleChange({
  required BuildContext context,
  required BotLifecycleCommands lifecycle,
  required String botId,
  required String botName,
  required String type,
}) {
  final words = botLifecycleWordsV1[type]!;
  return lifecycle.confirmChange(
    botId,
    type,
    confirm: () async {
      if (!context.mounted) return false;
      return await showDialog<bool>(
            context: context,
            builder: (dialog) => identified(
              FlockIds.lifecycleConfirm,
              AlertDialog(
                insetPadding: frockDialogInset,
                title: frockDialogTitle(Text('${words.title} $botName?')),
                content: frockDialogBody(
                  SingleChildScrollView(child: Text(words.body)),
                ),
                actions: [
                  TextButton(
                    onPressed: () => Navigator.pop(dialog, false),
                    child: const Text('Cancel'),
                  ),
                  FilledButton(
                    onPressed: () => Navigator.pop(dialog, true),
                    child: Text(words.verb),
                  ),
                ],
              ),
            ),
          ) ??
          false;
    },
  );
}

/// The danger zone, as the foot of Bot Settings shows it: two rows on one
/// card, under a Danger label the section draws.
///
/// An archived Bot offers Restore and Delete; an active one offers Archive and
/// Delete. Each asks its question first, in the one dialog every Bot
/// confirmation uses. No tinted panel and no second sentence: the label over
/// the card and the colour on Delete are the warning, and the rest of it is
/// what the confirmation is for.
class BotDangerZone extends StatefulWidget {
  final BotLifecycleCommands lifecycle;
  final String botId;
  final String botName;
  final bool archived;

  /// Called after a change the authority applied, so the surface that owns the
  /// Bot list reads it again.
  final Future<void> Function()? onChanged;

  /// Called after a delete the authority applied. The Bot this surface is about
  /// is gone, so the surface goes too.
  final VoidCallback? onDeleted;
  const BotDangerZone({
    super.key,
    required this.lifecycle,
    required this.botId,
    required this.botName,
    required this.archived,
    this.onChanged,
    this.onDeleted,
  });

  @override
  State<BotDangerZone> createState() => _BotDangerZoneState();
}

class _BotDangerZoneState extends State<BotDangerZone> {
  @override
  void initState() {
    super.initState();
    unawaited(widget.lifecycle.restore());
  }

  Future<void> _change(String type) async {
    // This State can be reused for another Bot while the command settles.
    // Everything after this point still belongs to the Bot whose danger-zone
    // control was pressed.
    final onChanged = widget.onChanged;
    final onDeleted = widget.onDeleted;
    final applied = await confirmBotLifecycleChange(
      context: context,
      lifecycle: widget.lifecycle,
      botId: widget.botId,
      botName: widget.botName,
      type: type,
    );
    if (!applied) return;
    // The surface closes before the directory is read again: the reload
    // forgets which Bot was open, and that is what decides what to close.
    if (type == 'bot/delete') onDeleted?.call();
    await onChanged?.call();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: widget.lifecycle,
    builder: (context, _) {
      final state = widget.lifecycle;
      // A change nobody has an answer for locks the zone: a second command
      // while the first is unaccounted for is how a Bot gets archived twice.
      final locked = state.saving || state.pending;
      final theme = Theme.of(context);
      final notice = state.error ?? state.message;
      return identified(
        FlockIds.dangerZone,
        Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            FrockRowGroup(
              rows: [
                if (widget.archived)
                  identified(
                    FlockIds.restoreBot,
                    FrockRow(
                      icon: Icons.unarchive_outlined,
                      title: 'Restore Bot',
                      onTap: locked ? null : () => _change('bot/restore'),
                    ),
                  )
                else
                  identified(
                    FlockIds.archiveBot,
                    FrockRow(
                      icon: Icons.archive_outlined,
                      title: 'Archive Bot',
                      onTap: locked ? null : () => _change('bot/archive'),
                    ),
                  ),
                identified(
                  FlockIds.deleteBot,
                  FrockRow(
                    icon: Icons.delete_outline_rounded,
                    title: 'Delete Bot',
                    color: theme.colorScheme.error,
                    onTap: locked ? null : () => _change('bot/delete'),
                  ),
                ),
              ],
            ),
            if (notice != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(4, 12, 4, 0),
                child: Semantics(
                  liveRegion: true,
                  child: Text(notice, style: theme.textTheme.bodySmall),
                ),
              ),
            if (state.pending)
              Align(
                alignment: Alignment.centerLeft,
                child: TextButton(
                  onPressed: state.saving
                      ? null
                      : () async {
                          if (await state.retry()) {
                            await widget.onChanged?.call();
                          }
                        },
                  child: const Text('Check change status'),
                ),
              ),
          ],
        ),
      );
    },
  );
}
