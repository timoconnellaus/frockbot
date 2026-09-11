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

import 'package:flutter/foundation.dart' show ValueListenable;
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter/services.dart';

import '../acceptance_metrics.dart';
import '../applets/chat_card.dart';
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
  final void Function(String?)? onReadLatest;
  final void Function(String? runId)? onWorkingChanged;

  /// True when the account cannot pay for a reply: the banner says so before
  /// the person types one, and a failed reply's notice can open Billing.
  final bool outOfCredit;
  final VoidCallback? onOpenBilling;

  /// Dictation, which the shell owns because a capture outlives this pane:
  /// switching Bots must flush into the Bot the capture started on.
  final VoidCallback? onDictate;
  final VoidCallback? onStopDictation;
  final bool dictating;
  final ValueListenable<double>? dictationLevel;

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
    this.onReadLatest,
    this.onWorkingChanged,
    this.outOfCredit = false,
    this.onOpenBilling,
    this.onDictate,
    this.onStopDictation,
    this.dictating = false,
    this.dictationLevel,
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

  /// Mirrors the controller's draft into the composer. A live composing range
  /// holds the mirror off, because overwriting the word an IME is still
  /// composing would take it out of the person's hands. An empty composer has
  /// no such word to protect even when an IME has laid a range over it, so
  /// words handed back to the draft — a refused send, a durable write that
  /// failed — reach the screen there rather than sitting where only the next
  /// keystroke's `saveDraft` can reach them.
  void _update() {
    if (!mounted) return;
    if (editor.text != controller.draft &&
        (editor.text.isEmpty || !editor.value.composing.isValid)) {
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
    //
    // The two steps are in this order and not the other one. `send` announces
    // the submission while the draft still holds these words and only empties
    // it afterwards, so clearing first would have `_update` read a composer
    // that disagrees with the draft and write the words straight back in.
    // Starting the send and clearing before the first await leaves no rebuild
    // in between.
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
        if (c.connection == ConnectionState.disconnected ||
            c.connection == ConnectionState.paused)
          MaterialBanner(
            content: Text(switch (c.connection) {
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
        if (widget.outOfCredit)
          identified(
            ShellIds.outOfCredit,
            MaterialBanner(
              content: const Text(
                'Your Bots can’t reply until you subscribe or add credit.',
              ),
              actions: [
                TextButton(
                  onPressed: widget.onOpenBilling,
                  child: const Text('Open Billing'),
                ),
              ],
            ),
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
            onOpenBilling: widget.onOpenBilling,
            onOpenSettings: widget.onOpenSettings,
            onMessageActions: widget.onMessageActions,
            unreadFromMessageId: widget.unreadFromMessageId,
            onReadLatest: widget.onReadLatest,
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
          onDictate: widget.onDictate,
          onStopDictation: widget.onStopDictation,
          dictating: widget.dictating,
          dictationLevel: widget.dictationLevel,
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
  final void Function(String?)? onReadLatest;
  final void Function(String? runId)? onWorkingChanged;
  final void Function(String botId, ConnectionState state)? onConnectionChanged;
  final bool outOfCredit;
  final VoidCallback? onOpenBilling;
  final VoidCallback? onDictate;
  final VoidCallback? onStopDictation;
  final bool dictating;
  final ValueListenable<double>? dictationLevel;
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
    this.onReadLatest,
    this.onWorkingChanged,
    this.onConnectionChanged,
    this.outOfCredit = false,
    this.onOpenBilling,
    this.onDictate,
    this.onStopDictation,
    this.dictating = false,
    this.dictationLevel,
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
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _reportConnection();
    });
    unawaited(session.start());
    unawaited(approvals.load());
    unawaited(skills.load());
  }

  void _repaint() {
    if (!mounted) return;
    setState(() {});
    _reportConnection();
  }

  void _reportConnection() => widget.onConnectionChanged?.call(
    widget.botId,
    session.controller.connection,
  );

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (appIsAwayV1(state)) {
      widget.sessions.pause();
    } else {
      widget.sessions.resume();
    }
  }

  @override
  Widget build(BuildContext context) => AppletChatScope(
    api: widget.api,
    child: ChatPane(
      background: widget.background,
      controller: session.controller,
      onReconnect: session.channel.connect,
      approvals: approvals,
      skills: skills,
      onOpenRun: widget.onOpenRun,
      onOpenSettings: widget.onOpenSettings,
      onMessageActions: widget.onMessageActions,
      unreadFromMessageId: widget.unreadFromMessageId,
      onReadLatest: widget.onReadLatest,
      onWorkingChanged: widget.onWorkingChanged,
      outOfCredit: widget.outOfCredit,
      onOpenBilling: widget.onOpenBilling,
      onDictate: widget.onDictate,
      onStopDictation: widget.onStopDictation,
      dictating: widget.dictating,
      dictationLevel: widget.dictationLevel,
    ),
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
