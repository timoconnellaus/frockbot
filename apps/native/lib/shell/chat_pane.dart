/// One Bot's conversation: the thread, the composer, and the states between.
///
/// [ChatPane] is the pane itself over a [ChatController] and nothing else, so
/// every state it can be in is reachable from a test with no network.
/// [ConversationView] is the pane plus the session that outlives it — the
/// observer channel, the approvals, the Skill catalog — which is what the
/// shell mounts.
///
/// Neither owns a rule. Ordering, readiness and the drain are
/// `transcript_model.dart`'s and `composer.dart`'s; this only draws them.
library;

import 'dart:async';

import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter/services.dart';

import '../acceptance_metrics.dart';
import '../client/bot_sessions.dart';
import '../client/chat_controller.dart';
import '../client/transport.dart';
import '../theme/states.dart';
import 'composer.dart';
import 'lifecycle.dart';
import 'run_view.dart';
import 'semantics.dart';
import 'send_payload.dart';
import 'skill_menu.dart';
import 'transcript.dart';

class ChatPane extends StatefulWidget {
  final ChatController controller;
  final Future<void> Function() onReconnect;
  final ApprovalsController? approvals;
  final SkillMenuController? skills;

  /// Opens the run view. The shell decides whether that is the right panel or
  /// a page, because that is a layout question and not this pane's.
  final void Function(TranscriptLine line)? onOpenRun;
  final VoidCallback? onOpenSettings;
  final void Function(TranscriptLine)? onMessageActions;
  final String? unreadFromMessageId;
  final void Function(String? runId)? onWorkingChanged;

  /// The Bot's sheep background, so its avatar is the same one everywhere.
  final String? background;
  const ChatPane({
    super.key,
    required this.controller,
    required this.onReconnect,
    this.approvals,
    this.skills,
    this.onOpenRun,
    this.onOpenSettings,
    this.onMessageActions,
    this.unreadFromMessageId,
    this.onWorkingChanged,
    this.background,
  });

  @override
  State<ChatPane> createState() => _ChatPaneState();
}

class _ChatPaneState extends State<ChatPane> {
  final editor = TextEditingController();
  final focus = FocusNode();
  late final SkillMenuController? skills = widget.skills;
  ChatController get controller => widget.controller;

  @override
  void initState() {
    super.initState();
    editor.text = controller.draft;
    controller.addListener(_update);
    widget.approvals?.addListener(_repaint);
  }

  void _repaint() {
    if (mounted) setState(() {});
  }

  void _update() {
    if (!mounted) return;
    if (editor.text != controller.draft && !editor.value.composing.isValid) {
      editor.text = controller.draft;
    }
    setState(() {});
    widget.onWorkingChanged?.call(controller.activeRunId);
    if (controller.ready) AcceptanceMetrics.instance.editableShown();
  }

  Future<void> _send() async {
    if (!controller.canSend || editor.text.trim().isEmpty) return;
    final text = editor.text;
    unawaited(HapticFeedback.lightImpact());
    // The person's explicit intent goes into the controller first, and the
    // composer is emptied in the same synchronous step. Android IMEs keep a
    // composing range over the word still being typed and re-establish one
    // over whatever text they can still see, so leaving the words on screen
    // until `_update` mirrors the cleared draft — a mirror its guard skips
    // for a live composing range — is what left them there for a second tap
    // to send again as a new Turn. Nothing an IME does afterwards can put a
    // Turn's words back into a send this had already emptied; a refused send
    // hands them back through the draft.
    final sending = controller.send(text);
    editor.clear();
    await sending;
    if (mounted) focus.requestFocus();
  }

  /// Sends this Turn's own message again, unchanged, as a new Turn. The words
  /// come off the person's own line in the thread, not out of the composer,
  /// which is why an empty composer does not disable it.
  Future<void> _retry(TranscriptLine line) async {
    final original = controller.runs
        .where((run) => run['runId'] == line.runId)
        .map((run) => run['input'] as String?)
        .firstOrNull;
    final text = resendableTurnText(
      original,
      maxCharacters: turnTextMaxCharacters,
    );
    if (text == null || !controller.canSend) return;
    await controller.send(text);
  }

  Future<void> _refresh({bool older = false}) async {
    try {
      await controller.refresh(older: older);
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text(
            'Couldn’t refresh your messages. Check your connection and try again.',
          ),
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = controller;
    return Column(
      children: [
        if (c.connection != ConnectionState.connected)
          MaterialBanner(
            content: Text(switch (c.connection) {
              ConnectionState.connecting => 'Connecting…',
              ConnectionState.paused => 'Conversation paused on this device.',
              _ => 'You’re offline. Your Bot can keep working.',
            }),
            actions: [
              identified(
                ShellIds.reconnect,
                TextButton(
                  key: const ValueKey('reconnect'),
                  onPressed: widget.onReconnect,
                  child: const Text('Reconnect'),
                ),
              ),
            ],
          ),
        Expanded(
          child: TranscriptView(
            background: widget.background,
            lines: [
              ...projectRuns(c.runs),
              ...projectAnnouncements(c.announcements),
            ],
            pendingText: c.visiblePendingText,
            loading: c.loading,
            hasEarlier: c.before != null,
            approvals: widget.approvals,
            storageKey: 'history-${c.botId}',
            focusRunId: c.focusRunId,
            onRefresh: _refresh,
            onOpenRun: widget.onOpenRun ?? (_) {},
            onRetryTurn: c.canSend ? _retry : null,
            onOpenSettings: widget.onOpenSettings,
            onMessageActions: widget.onMessageActions,
            unreadFromMessageId: widget.unreadFromMessageId,
          ),
        ),
        if (c.error != null)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
            child: Text(
              c.error!,
              style: TextStyle(color: Theme.of(context).colorScheme.error),
            ),
          ),
        if (c.pending.isNotEmpty && !c.sending)
          identified(
            ShellIds.checkDelivery,
            TextButton(
              key: const ValueKey('check-delivery'),
              onPressed: c.checking ? null : c.checkDelivery,
              child: const Text('Check message status'),
            ),
          ),
        Composer(
          editor: editor,
          focus: focus,
          // Readiness is about the transport, the Bot and the model; whether
          // there is something worth sending is the Composer's own question.
          ready: c.canSend,
          stoppable: c.stoppable,
          stopping: c.stopping,
          onSend: _send,
          onStop: c.stop,
          onChanged: (value) => unawaited(c.saveDraft(value)),
          skills: skills,
        ),
      ],
    );
  }

  @override
  void dispose() {
    controller.removeListener(_update);
    widget.approvals?.removeListener(_repaint);
    editor.dispose();
    focus.dispose();
    super.dispose();
  }
}

/// The pane plus the session behind it, which is what the shell mounts.
class ConversationView extends StatefulWidget {
  final BotSessions sessions;
  final NativeApi api;
  final LocalStore store;
  final String userId;
  final String botId;
  final void Function(TranscriptLine line) onOpenRun;
  final VoidCallback? onOpenSettings;
  final void Function(TranscriptLine)? onMessageActions;
  final String? unreadFromMessageId;
  final void Function(String? runId)? onWorkingChanged;
  final String? background;
  const ConversationView({
    super.key,
    required this.sessions,
    required this.api,
    required this.store,
    required this.userId,
    required this.botId,
    required this.onOpenRun,
    this.onOpenSettings,
    this.onMessageActions,
    this.unreadFromMessageId,
    this.onWorkingChanged,
    this.background,
  });

  @override
  State<ConversationView> createState() => _ConversationViewState();
}

class _ConversationViewState extends State<ConversationView>
    with WidgetsBindingObserver {
  late final BotSession session = widget.sessions.open(
    widget.userId,
    widget.botId,
  );
  late final ApprovalsController approvals = ApprovalsController(
    api: widget.api,
    store: widget.store,
    userId: widget.userId,
    botId: widget.botId,
  );
  late final SkillMenuController skills = SkillMenuController(
    api: widget.api,
    botId: widget.botId,
  );

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    session.controller.addListener(_repaint);
    unawaited(session.start());
    unawaited(approvals.load());
    unawaited(skills.load());
  }

  void _repaint() {
    if (mounted) setState(() {});
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (appIsAwayV1(state)) {
      widget.sessions.pause();
    } else {
      widget.sessions.resume();
    }
  }

  @override
  Widget build(BuildContext context) => ChatPane(
    background: widget.background,
    controller: session.controller,
    onReconnect: session.channel.connect,
    approvals: approvals,
    skills: skills,
    onOpenRun: widget.onOpenRun,
    onOpenSettings: widget.onOpenSettings,
    onMessageActions: widget.onMessageActions,
    unreadFromMessageId: widget.unreadFromMessageId,
    onWorkingChanged: widget.onWorkingChanged,
  );

  @override
  void dispose() {
    // The session outlives this view so that switching back to this Bot is a
    // lookup rather than a reconnection.
    WidgetsBinding.instance.removeObserver(this);
    session.controller.removeListener(_repaint);
    approvals.dispose();
    skills.dispose();
    super.dispose();
  }
}

/// The run view as a page, which is what a hand-held viewport has room for.
class RunPage extends StatelessWidget {
  final TranscriptLine line;
  const RunPage({super.key, required this.line});

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Work')),
    body: SafeArea(child: RunView(line: line, header: false)),
  );
}

/// What the middle column shows before a Bot is chosen.
///
/// A list that could not be read is not an empty one. Incident 1 is exactly
/// this column telling a User who owns Bots that they had none, so a failure
/// takes the slot ahead of the empty state and says what the sidebar says.
class NoConversation extends StatelessWidget {
  final bool empty;

  /// Why the directory is unreadable, when it is. An empty list this client
  /// never managed to read is never described as an empty flock.
  final String? failure;
  final String action;
  final VoidCallback onAction;
  const NoConversation({
    super.key,
    required this.empty,
    required this.action,
    required this.onAction,
    this.failure,
  });

  @override
  Widget build(BuildContext context) => FrockEmptyState(
    title: failure != null
        ? 'Couldn’t load your Bots'
        : empty
        ? 'No Bots yet'
        : 'Choose a Bot to begin',
    detail:
        failure ??
        (empty
            ? 'Your Bots will appear here once they’re created.'
            : 'Pick a Bot from your list to catch up or start something new.'),
    action: action,
    onAction: onAction,
  );
}
