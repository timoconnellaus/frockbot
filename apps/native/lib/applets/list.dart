/// The selected Bot's Applets: the ones it owns and the ones shared with it.
///
/// One list for every width. A wide window draws it as the sidebar's Applets
/// mode, in place of the Bots; a phone pushes it as a page. It reads the
/// canvas's directory, which is already this Bot's, so opening a row and the
/// canvas it opens never disagree about what exists.
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../client/transport.dart';
import '../protocol/client_wire.generated.dart' as wire;
import '../shell/chat_icons.dart';
import '../shell/semantics.dart';
import '../theme/states.dart';
import 'canvas.dart';

class AppletList extends StatefulWidget {
  final AppletCanvasController controller;
  final String botName;

  /// A Bot's name, for saying who shares an Applet and who else uses one.
  final String? Function(String botId) nameOf;
  final void Function(String appletId) onOpen;

  /// The way back to the Bots, where the list stands in for them. A pushed
  /// page has its own back and passes none.
  final VoidCallback? onBack;
  const AppletList({
    super.key,
    required this.controller,
    required this.botName,
    required this.nameOf,
    required this.onOpen,
    this.onBack,
  });

  @override
  State<AppletList> createState() => _AppletListState();
}

class _AppletListState extends State<AppletList> {
  /// Applets a confirmed delete has already taken off this list, ahead of the
  /// round trip and the re-read behind it. The confirmation is the decision,
  /// and a delete the backend no longer has anything to do is already treated
  /// as the outcome the row asked for, so the row going now says the same
  /// thing sooner. A delete that genuinely failed puts its row back.
  final Set<String> removed = {};
  String? error;

  @override
  void initState() {
    super.initState();
    unawaited(widget.controller.load());
  }

  @override
  void didUpdateWidget(AppletList old) {
    super.didUpdateWidget(old);
    if (old.controller != widget.controller) {
      removed.clear();
      error = null;
      unawaited(widget.controller.load());
    }
  }

  /// Who else a delete takes the Applet from, named where the shell knows
  /// them and counted where it does not.
  String _alsoUsedBy(List<wire.BotId> shared) {
    final names = [for (final id in shared) widget.nameOf(id.value)];
    if (names.every((name) => name != null)) {
      return 'It is also used by ${names.join(', ')}. ';
    }
    return 'It is also used by ${shared.length} other '
        '${shared.length == 1 ? 'Bot' : 'Bots'}. ';
  }

  Future<void> remove(wire.AppletSummary applet) async {
    final id = applet.appletId;
    final shared = applet.sharedWithBotIds;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('Delete ${applet.displayName}?'),
        content: Text(
          'This permanently deletes its data and versions. '
          '${shared.isEmpty ? '' : _alsoUsedBy(shared)}'
          'This cannot be undone.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    final controller = widget.controller;
    setState(() {
      removed.add(id);
      error = null;
    });
    try {
      try {
        await controller.applets.delete(controller.botId, id);
      } on RequestFailure catch (failure) {
        // An Applet the backend no longer has is the outcome this row asked
        // for. Only a delete that might still succeed is worth retrying.
        if (failure.status != 404) rethrow;
      }
      await controller.load();
      // The re-read is the authority on what is left, so the prediction it
      // confirms stops standing in for one.
      if (mounted) setState(() => removed.remove(id));
    } catch (failure) {
      if (!mounted) return;
      final refused =
          failure is RequestFailure && failure.code == 'applet-not-owner';
      setState(() {
        removed.remove(id);
        error = refused
            ? 'Only the Bot that owns ${applet.displayName} can delete it.'
            : 'Couldn’t delete this Applet. Try again.';
      });
      // A refusal means the directory this row was drawn from is stale: the
      // Applet was transferred away. Reading it again redraws the row as it is.
      if (refused) unawaited(controller.load());
    }
  }

  @override
  Widget build(BuildContext context) => identified(
    AppletIds.list,
    AnimatedBuilder(
      animation: widget.controller,
      builder: (context, _) {
        final controller = widget.controller;
        final theme = Theme.of(context);
        final listed = [
          for (final applet in controller.directory)
            if (!removed.contains(applet.appletId)) applet,
        ];
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _header(context),
            if (error case final String message)
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 4, 16, 8),
                child: Semantics(
                  liveRegion: true,
                  child: Text(
                    message,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.error,
                    ),
                  ),
                ),
              ),
            Expanded(
              child: controller.directoryFailure != null && listed.isEmpty
                  ? _failure(context)
                  : controller.loading && listed.isEmpty
                  ? const FrockLoading(label: 'Loading Applets')
                  : listed.isEmpty
                  ? Padding(
                      padding: const EdgeInsets.fromLTRB(20, 16, 20, 24),
                      child: Text(
                        'No Applets yet. Ask ${widget.botName} to build one.',
                        style: theme.textTheme.bodyMedium?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                      ),
                    )
                  // A delete in flight is a row that is already gone, so no
                  // other row waits on it: opening or deleting a different
                  // Applet never depended on this one's round trip.
                  : ListView(
                      padding: const EdgeInsets.only(bottom: 12),
                      children: [
                        for (final applet in listed) _row(context, applet),
                      ],
                    ),
            ),
          ],
        );
      },
    ),
  );

  Widget _header(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: EdgeInsets.fromLTRB(widget.onBack == null ? 20 : 8, 10, 16, 8),
      child: Row(
        children: [
          if (widget.onBack case final VoidCallback back) ...[
            identified(
              AppletIds.listBack,
              IconButton(
                tooltip: 'Back to Bots',
                onPressed: back,
                style: IconButton.styleFrom(
                  foregroundColor: theme.colorScheme.onSurfaceVariant,
                ),
                icon: Icon(Icons.arrow_back_rounded, size: chatIconSize),
              ),
            ),
            const SizedBox(width: 4),
          ],
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Semantics(
                  header: true,
                  child: Text(
                    'Applets',
                    style: theme.textTheme.titleSmall?.copyWith(
                      fontSize: 15,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                Text(
                  widget.botName,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _failure(BuildContext context) => Padding(
    padding: const EdgeInsets.all(16),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'Couldn’t load this Bot’s Applets.',
          style: Theme.of(context).textTheme.bodyMedium?.copyWith(
            color: Theme.of(context).colorScheme.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: 10),
        identified(
          AppletIds.listRetry,
          OutlinedButton(
            onPressed: () => unawaited(widget.controller.retry()),
            child: const Text('Retry'),
          ),
        ),
      ],
    ),
  );

  Widget _row(BuildContext context, wire.AppletSummary applet) {
    final theme = Theme.of(context);
    final owner = applet.access == 'owner';
    final label = owner
        ? 'Owner'
        : switch (widget.nameOf(applet.ownerBotId.value)) {
            final String name => 'Shared by $name',
            null => 'Shared',
          };
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8),
      child: Row(
        children: [
          Expanded(
            child: identified(
              AppletIds.row(applet.appletId),
              Material(
                color: Colors.transparent,
                borderRadius: BorderRadius.circular(10),
                child: InkWell(
                  onTap: () => widget.onOpen(applet.appletId),
                  borderRadius: BorderRadius.circular(10),
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(12, 9, 12, 9),
                    child: Row(
                      children: [
                        Icon(
                          Icons.widgets_outlined,
                          size: chatIconSize,
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                        const SizedBox(width: 11),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Text(
                                applet.displayName,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: theme.textTheme.bodyMedium?.copyWith(
                                  fontSize: 14,
                                  fontWeight: FontWeight.w500,
                                ),
                              ),
                              const SizedBox(height: 2),
                              identified(
                                AppletIds.access(applet.appletId),
                                Text(
                                  label,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: theme.textTheme.bodySmall?.copyWith(
                                    color: theme.colorScheme.onSurfaceVariant,
                                  ),
                                ),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
          // Deleting takes the Applet from every Bot it is shared with, so it
          // is the owner's alone; a shared row offers nothing it would refuse.
          if (owner)
            identified(
              AppletIds.delete(applet.appletId),
              IconButton(
                tooltip: 'Delete ${applet.displayName}',
                onPressed: () => unawaited(remove(applet)),
                color: theme.colorScheme.onSurfaceVariant,
                icon: const Icon(Icons.delete_outline),
              ),
            ),
        ],
      ),
    );
  }
}
