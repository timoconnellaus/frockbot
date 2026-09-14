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

import '../applets/client.dart';
import '../client/transport.dart';
import '../protocol/client_wire.generated.dart' as wire;
import '../shell/semantics.dart';

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
        body: 'This removes its conversation and Applets, and cannot be undone. To stop the Bot working while keeping its history, archive it instead.',
      ),
    };

/// What archiving or deleting a Bot does to the Applets it owns, named one by
/// one, or null when it owns none. [nameOf] resolves a Bot the surface knows;
/// a share naming one it does not is counted rather than guessed at.
String? botLifecycleAppletsV1(
  String type,
  wire.BotAppletImpact impact, {
  String? Function(String botId)? nameOf,
}) {
  if (impact.applets.isEmpty) return null;
  String line(Map<String, Object?> applet) {
    final shared = [
      for (final id in (applet['sharedWithBotIds'] as List? ?? const []))
        id as String,
    ];
    final name = applet['displayName'] as String;
    if (shared.isEmpty) return '• $name';
    final names = [for (final id in shared) nameOf?.call(id)];
    if (names.every((known) => known != null)) {
      return '• $name — also used by ${names.join(', ')}';
    }
    return '• $name — shared with ${shared.length} other '
        '${shared.length == 1 ? 'Bot' : 'Bots'}';
  }

  final lead = type == 'bot/delete'
      ? 'These Applets and their data are permanently deleted, including for '
            'the Bots they are shared with:'
      : 'These Applets become unavailable to every Bot until this Bot is '
            'restored. Nothing is deleted:';
  return [lead, for (final applet in impact.applets) line(applet)].join('\n');
}

/// One retained lifecycle command, shared by every surface that issues one.
class BotLifecycleCommands extends ChangeNotifier {
  final NativeApi api;
  final LocalStore store;
  final String userId;
  BotLifecycleCommands(this.api, this.store, this.userId);

  bool saving = false;
  String? error;
  String? message;

  /// Whether the last delete was refused because the Bot's Applets changed
  /// since the confirmation named them. The command was never admitted, so
  /// the answer is to read the impact again and ask again, not to re-send.
  bool appletImpactChanged = false;
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
  ///
  /// A delete carries the [appletImpact] fingerprint its confirmation read.
  /// It is retained with the command, so a retry fences on the same list the
  /// person agreed to.
  Future<bool> change(String botId, String type, {String? appletImpact}) async {
    if (_closed || saving || pending) return false;
    _command = Map<String, dynamic>.from(
      wire.BotLifecycleCommand.fromJson({
            'schemaVersion': 1,
            'type': type,
            'commandId': randomId(),
            'botId': botId,
            if (type == 'bot/delete' && appletImpact != null)
              'appletImpact': appletImpact,
          }).toJson()!
          as Map,
    );
    return retry();
  }

  /// Reads what the change does to the Bot's Applets, asks, and issues it.
  ///
  /// [confirm] is handed the Applets paragraph to show, or null when there is
  /// nothing to name. A delete whose impact cannot be read is not asked at
  /// all: agreeing to a list nobody saw is not agreeing. An archive destroys
  /// nothing, so it asks with the generic words instead.
  Future<bool> confirmChange(
    String botId,
    String type, {
    required Future<bool> Function(String? applets) confirm,
    String? Function(String botId)? nameOf,
  }) async {
    if (_closed || saving || pending) return false;
    var changed = false;
    while (true) {
      wire.BotAppletImpact? impact;
      if (type != 'bot/restore') {
        try {
          impact = await AppletsApi(api).impact(botId);
        } catch (_) {
          if (type == 'bot/delete') {
            error =
                'Couldn’t check which Applets this Bot owns, so nothing was deleted. Try again.';
            _changed();
            return false;
          }
        }
      }
      if (_closed) return false;
      final applets = impact == null
          ? null
          : botLifecycleAppletsV1(type, impact, nameOf: nameOf);
      final shown = changed
          ? [?error, ?applets].join('\n\n')
          : applets;
      if (!await confirm(shown)) return false;
      final applied = await change(
        botId,
        type,
        appletImpact: impact?.fingerprint.value,
      );
      if (applied || !appletImpactChanged || _closed) return applied;
      changed = true;
    }
  }

  /// Dispatches the retained command, under its own id, however many times it
  /// takes to learn what happened to it.
  Future<bool> retry() async {
    if (_closed || saving || _command == null) return false;
    saving = true;
    message = null;
    appletImpactChanged = false;
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
        'bot/archive' => 'Bot archived. You can restore it from Archived Bots.',
        'bot/restore' => 'Bot restored.',
        _ => 'Bot deleted.',
      };
    } on RequestFailure catch (failure) when (failure.status == 409 &&
        failure.code == 'applet-impact-changed') {
      await store.delete(_key);
      _command = null;
      appletImpactChanged = true;
      error = 'This Bot’s Applets changed. Review them and try again.';
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

/// The danger zone, as Bot settings' Advanced shows it: what this Bot's status
/// is, and the one or two changes that status allows.
///
/// An archived Bot offers Restore and Delete; an active one offers Archive and
/// Delete. Each asks its question first.
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

  /// A Bot's name, for naming who else uses the Applets this one owns.
  final String? Function(String botId)? nameOf;
  const BotDangerZone({
    super.key,
    required this.lifecycle,
    required this.botId,
    required this.botName,
    required this.archived,
    this.onChanged,
    this.onDeleted,
    this.nameOf,
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
    final words = botLifecycleWordsV1[type]!;
    // This State can be reused for another Bot while impact is read and the
    // command settles. Everything after this point still belongs to the Bot
    // whose danger-zone control was pressed.
    final lifecycle = widget.lifecycle;
    final botId = widget.botId;
    final botName = widget.botName;
    final nameOf = widget.nameOf;
    final onChanged = widget.onChanged;
    final onDeleted = widget.onDeleted;
    final applied = await lifecycle.confirmChange(
      botId,
      type,
      nameOf: nameOf,
      confirm: (applets) async {
        if (!mounted) return false;
        return await showDialog<bool>(
              context: context,
              builder: (dialog) => identified(
                FlockIds.lifecycleConfirm,
                AlertDialog(
                  title: Text('${words.title} $botName?'),
                  content: SingleChildScrollView(
                    child: Text(
                      [words.body, ?applets].join('\n\n'),
                    ),
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
        Card(
          margin: const EdgeInsets.symmetric(vertical: 8),
          color: theme.colorScheme.errorContainer.withValues(alpha: 0.24),
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Semantics(
                  header: true,
                  child: Text('Danger zone', style: theme.textTheme.titleSmall),
                ),
                const SizedBox(height: 4),
                Text(
                  widget.archived
                      ? 'This Bot is archived. Its history is here whenever you want it back.'
                      : 'Archiving stops new work and keeps the history. Deleting keeps nothing.',
                  style: theme.textTheme.bodySmall,
                ),
                const SizedBox(height: 12),
                Wrap(
                  spacing: 12,
                  runSpacing: 8,
                  children: [
                    if (widget.archived)
                      identified(
                        FlockIds.restoreBot,
                        FilledButton.tonal(
                          onPressed: locked
                              ? null
                              : () => _change('bot/restore'),
                          child: const Text('Restore Bot'),
                        ),
                      )
                    else
                      identified(
                        FlockIds.archiveBot,
                        FilledButton.tonal(
                          onPressed: locked
                              ? null
                              : () => _change('bot/archive'),
                          child: const Text('Archive Bot'),
                        ),
                      ),
                    identified(
                      FlockIds.deleteBot,
                      OutlinedButton(
                        onPressed: locked ? null : () => _change('bot/delete'),
                        style: OutlinedButton.styleFrom(
                          foregroundColor: theme.colorScheme.error,
                        ),
                        child: const Text('Delete Bot'),
                      ),
                    ),
                  ],
                ),
                if (notice != null) ...[
                  const SizedBox(height: 12),
                  Semantics(liveRegion: true, child: Text(notice)),
                ],
                if (state.pending)
                  TextButton(
                    onPressed: state.saving
                        ? null
                        : () async {
                            if (await state.retry()) {
                              await widget.onChanged?.call();
                            }
                          },
                    child: const Text('Check change status'),
                  ),
              ],
            ),
          ),
        ),
      );
    },
  );
}
