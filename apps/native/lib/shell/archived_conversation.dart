/// An archived Bot, open where its conversation would be, read-only.
///
/// Its history is read through the transcript's GET routes. It never starts a
/// Bot session, restores pending commands, or offers a composer: where the
/// composer would be, a bar says what archiving means and offers the two ways
/// out of it, which go through the shell's one lifecycle command.
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../client/transport.dart';
import '../flock/avatar.dart';
import '../flock/lifecycle.dart';
import '../theme/frock_theme.dart';
import '../theme/thread.dart';
import 'chat_header.dart';
import 'chat_pane.dart' show RunPage;
import 'semantics.dart';
import 'transcript.dart';

class ArchivedConversation extends StatefulWidget {
  final NativeApi api;
  final String botId;
  final String name;
  final String? characterId;
  final String? primary;

  /// A message to bring into view, when the conversation was opened from a
  /// search hit.
  final String? runId;

  /// Whether this is a phone's page over the list, with Back in its header.
  final bool phone;
  final VoidCallback? onBack;

  /// The shell's one retained lifecycle command. While a change is in flight
  /// or unaccounted for, the bar's buttons wait.
  final BotLifecycleCommands lifecycle;
  final VoidCallback onRestore;
  final VoidCallback onDelete;

  const ArchivedConversation({
    super.key,
    required this.api,
    required this.botId,
    required this.name,
    required this.lifecycle,
    required this.onRestore,
    required this.onDelete,
    this.characterId,
    this.primary,
    this.runId,
    this.phone = false,
    this.onBack,
  });

  @override
  State<ArchivedConversation> createState() => _ArchivedConversationState();
}

class _ArchivedConversationState extends State<ArchivedConversation> {
  late final transport = BackendChatTransport(widget.api);
  final Map<String, Map<String, dynamic>> runs = {};
  List<Object?> announcements = const [];
  String? before;
  String? error;
  bool loading = false;

  @override
  void initState() {
    super.initState();
    unawaited(load());
  }

  Future<void> load({bool older = false}) async {
    if (loading) return;
    setState(() {
      loading = true;
      error = null;
    });
    try {
      final page = await transport.page(
        widget.botId,
        before: older ? before : null,
      );
      final incoming = <String, Map<String, dynamic>>{
        for (final value in page['runs'] as List)
          (value as Map)['runId'] as String: Map<String, dynamic>.from(value),
      };
      final target = widget.runId;
      if (target != null &&
          !runs.containsKey(target) &&
          !incoming.containsKey(target)) {
        final hit = await transport.lookup(widget.botId, target);
        if (hit != null) {
          incoming[target] = hit;
        } else {
          error = 'This message is no longer available.';
        }
      }
      if (!mounted) return;
      setState(() {
        runs.addAll(incoming);
        if (older || before == null) {
          before = (page['page'] as Map)['nextCursor'] as String?;
        }
        if (!older) announcements = page['announcements'] as List? ?? const [];
      });
    } catch (_) {
      if (mounted) {
        setState(
          () => error = 'Couldn’t load this conversation. Check your connection and try again.',
        );
      }
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final phone = widget.phone;
    return identified(
      FlockIds.archivedConversation,
      Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ChatHeader(
            name: widget.name,
            subtitle: 'Archived',
            phone: phone,
            onBack: widget.onBack,
            textScale: MediaQuery.textScalerOf(context).scale(14) / 14,
            // Faded, and still: this Bot is not doing anything.
            companion: Opacity(
              opacity: 0.55,
              child: CharacterAvatar(
                size: chatCompanionSizeFor(phone: phone),
                botId: widget.botId,
                characterId: widget.characterId,
                primary: widget.primary,
                motion: CharacterMotion.quiet,
                cropToInk: true,
              ),
            ),
          ),
          Expanded(
            child: TranscriptView(
              lines: [
                ...projectRuns(runs.values.toList()),
                ...projectAnnouncements(announcements),
              ],
              loading: loading,
              hasEarlier: before != null,
              onRefresh: load,
              onOpenRun: (line) => Navigator.of(context).push(
                MaterialPageRoute<void>(builder: (_) => RunPage(line: line)),
              ),
              storageKey: 'archived-history-${widget.botId}',
              focusRunId: widget.runId,
              background: widget.characterId,
              empty: error != null
                  ? const SizedBox.shrink()
                  : const SingleChildScrollView(
                      child: EmptyThread(
                        title: 'No messages',
                        detail: 'Nothing was said in this conversation.',
                      ),
                    ),
            ),
          ),
          if (runs.isEmpty && announcements.isEmpty && before != null)
            identified(
              ShellIds.transcriptEarlier,
              EarlierMessages(
                onPressed: () => load(older: true),
                loading: loading,
              ),
            ),
          if (error != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 8, 20, 0),
              child: Row(
                children: [
                  Expanded(child: Text(error!)),
                  TextButton(
                    onPressed: loading ? null : load,
                    child: const Text('Retry'),
                  ),
                ],
              ),
            ),
          SafeArea(
            top: false,
            child: Padding(
              padding: EdgeInsets.fromLTRB(
                phone ? 12 : 24,
                12,
                phone ? 12 : 24,
                phone ? 12 : 24,
              ),
              child: Center(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 760),
                  child: ArchivedBar(
                    name: widget.name,
                    lifecycle: widget.lifecycle,
                    onRestore: widget.onRestore,
                    onDelete: widget.onDelete,
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// What stands where the composer would: what archiving means, and Delete
/// and Restore. On a narrow screen the buttons sit under the sentence.
class ArchivedBar extends StatelessWidget {
  final String name;
  final BotLifecycleCommands lifecycle;
  final VoidCallback onRestore;
  final VoidCallback onDelete;
  const ArchivedBar({
    super.key,
    required this.name,
    required this.lifecycle,
    required this.onRestore,
    required this.onDelete,
  });

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: lifecycle,
    builder: (context, _) {
      final theme = Theme.of(context);
      final scheme = theme.colorScheme;
      // A change nobody has an answer for holds both buttons: a second command
      // while the first is unaccounted for is how a Bot is deleted twice.
      final locked = lifecycle.saving || lifecycle.pending;
      final sentence = Text(
        '$name is archived. Its conversation is kept, but it won’t reply '
        'or run its Routines.',
        style: theme.textTheme.bodyMedium?.copyWith(
          fontSize: 13.5,
          height: 1.45,
          color: scheme.onSurface.withValues(alpha: 0.82),
        ),
      );
      final buttons = Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          identified(
            FlockIds.archivedDelete,
            OutlinedButton(
              onPressed: locked ? null : onDelete,
              style: OutlinedButton.styleFrom(
                foregroundColor: scheme.error,
                minimumSize: const Size(0, 38),
                side: BorderSide(color: FrockTheme.hairline(scheme)),
              ),
              child: const Text('Delete…'),
            ),
          ),
          const SizedBox(width: 8),
          identified(
            FlockIds.archivedRestore,
            FilledButton(
              onPressed: locked ? null : onRestore,
              style: FilledButton.styleFrom(minimumSize: const Size(0, 38)),
              child: const Text('Restore'),
            ),
          ),
        ],
      );
      final glyph = Icon(
        Icons.archive_outlined,
        size: 20,
        color: scheme.onSurfaceVariant,
      );
      return identified(
        FlockIds.archivedBar,
        DecoratedBox(
          decoration: BoxDecoration(
            color: scheme.surfaceContainer,
            borderRadius: BorderRadius.circular(FrockTheme.radiusCard),
            border: Border.all(color: FrockTheme.hairline(scheme)),
          ),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 12, 12),
            child: LayoutBuilder(
              builder: (context, constraints) {
                if (constraints.maxWidth >= 520) {
                  return Row(
                    children: [
                      glyph,
                      const SizedBox(width: 14),
                      Expanded(child: sentence),
                      const SizedBox(width: 14),
                      buttons,
                    ],
                  );
                }
                return Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        glyph,
                        const SizedBox(width: 12),
                        Expanded(child: sentence),
                      ],
                    ),
                    const SizedBox(height: 12),
                    Align(alignment: Alignment.centerRight, child: buttons),
                  ],
                );
              },
            ),
          ),
        ),
      );
    },
  );
}
