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
import 'dart:math' as math;

import 'package:flutter/foundation.dart' show ValueListenable;
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter/services.dart';

import '../acceptance_metrics.dart';
import '../applets/chat_card.dart';
import '../client/bot_sessions.dart';
import '../client/chat_controller.dart';
import '../client/transport.dart';
import '../flock/avatar.dart';
import '../theme/states.dart';
import '../voice/dictation.dart';
import 'composer.dart';
import 'lifecycle.dart';
import 'run_view.dart';
import 'semantics.dart';
import 'send_payload.dart';
import 'skill_menu.dart';
import 'starters.dart';
import 'transcript.dart';

class ChatPane extends StatefulWidget {
  final ChatController controller;
  final Future<void> Function() onReconnect;
  final ApprovalsController? approvals;
  final SkillMenuController? skills;

  /// Opens the run view. The shell decides whether that is the right panel or
  /// a page, because that is a layout question and not this pane's.
  final void Function(TranscriptLine line)? onOpenRun;

  /// Opens the view-only chat behind an exchange marker. Layout is the
  /// shell's call, as it is for the run view.
  final void Function(TranscriptLine line)? onOpenExchange;

  /// Another Bot's sheep and current name, for the marker that names it.
  final String? Function(String botId)? backgroundOf;
  final String? Function(String botId)? primaryOf;
  final String? Function(String botId)? nameOf;
  final VoidCallback? onOpenSettings;
  final void Function(TranscriptLine, {Offset? position})? onMessageActions;
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
  final DictationState dictationState;
  final ValueListenable<double>? dictationLevel;

  /// The Bot's character and chosen colour, shared by every avatar surface.
  final String? background;
  final String? primary;

  /// What the empty thread offers to write into the composer.
  final List<StarterSuggestionV1> starters;
  const ChatPane({
    super.key,
    required this.controller,
    required this.onReconnect,
    this.approvals,
    this.skills,
    this.onOpenRun,
    this.onOpenExchange,
    this.backgroundOf,
    this.primaryOf,
    this.nameOf,
    this.onOpenSettings,
    this.onMessageActions,
    this.unreadFromMessageId,
    this.onReadLatest,
    this.onWorkingChanged,
    this.outOfCredit = false,
    this.onOpenBilling,
    this.onDictate,
    this.onStopDictation,
    this.dictationState = DictationState.idle,
    this.dictationLevel,
    this.background,
    this.primary,
    this.starters = const [],
  });

  @override
  State<ChatPane> createState() => _ChatPaneState();
}

class _ChatPaneState extends State<ChatPane> {
  final editor = TextEditingController();
  final focus = FocusNode();

  /// Where the pointer is over the conversation, in the companion's frame:
  /// `-1` to `1` across the pane on each axis from the character's centre,
  /// or nothing while the pointer is elsewhere. The companion reads it
  /// straight into its eyes; the pane never rebuilds for a mouse move.
  final gaze = ValueNotifier<Offset?>(null);
  final _companionKey = GlobalKey();

  void _pointerMoved(Offset global, Size pane) {
    final box = _companionKey.currentContext?.findRenderObject();
    if (box is! RenderBox || !box.hasSize || !box.attached) return;
    final centre = box.localToGlobal(box.size.center(Offset.zero));
    // Half the pane on each axis is a full turn of the eyes, so the far
    // corner of a wide window and the near edge of a phone both read as
    // "over there" rather than the eyes pinning to one side.
    final reach = Size(
      math.max(pane.width / 2, 1),
      math.max(pane.height / 2, 1),
    );
    gaze.value = Offset(
      ((global.dx - centre.dx) / reach.width).clamp(-1.0, 1.0),
      ((global.dy - centre.dy) / reach.height).clamp(-1.0, 1.0),
    );
  }

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

  /// Writes a suggestion into the composer and stops there. The draft is the
  /// person's to edit and send; nothing here admits a Turn.
  void _prefill(StarterSuggestionV1 starter) {
    editor.value = TextEditingValue(
      text: starter.draft,
      selection: starterSelectionV1(starter.draft),
    );
    unawaited(controller.saveDraft(starter.draft));
    focus.requestFocus();
  }

  Future<void> _retry(TranscriptLine line) => controller.retryRun(line.runId);

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

  /// How wide the thread and its composer may grow. A conversation is read
  /// like a page, and a line that runs the width of a desk is not a line
  /// anyone reads twice; a phone is narrower than this and never notices.
  static const double readingWidth = 860;

  @override
  Widget build(BuildContext context) {
    final c = controller;
    // The eyes follow the pointer over the whole conversation, not only over
    // the character's own square. Translucent: the region takes no pointer
    // from anything under it, the composer included.
    return LayoutBuilder(
      builder: (context, constraints) => MouseRegion(
        opaque: false,
        hitTestBehavior: HitTestBehavior.translucent,
        onHover: (event) => _pointerMoved(event.position, constraints.biggest),
        onExit: (_) => gaze.value = null,
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: readingWidth),
            child: _column(context, c),
          ),
        ),
      ),
    );
  }

  Widget _column(BuildContext context, ChatController c) {
    final avatarSize = MediaQuery.sizeOf(context).width <= 640 ? 50.0 : 64.0;
    final runs = projectRuns(c.runs);
    final working = c.activeRunId != null;
    // The Turn the companion's badge is paced by: the assistant line still
    // streaming, or none while the submission is being delivered.
    final runningLine = working
        ? runs
              .where(
                (line) =>
                    line.role == LineRole.assistant &&
                    line.status == LineStatus.streaming,
              )
              .lastOrNull
        : null;
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
            primary: widget.primary,
            starters: widget.starters.isEmpty
                ? null
                : StarterSuggestions(
                    starters: widget.starters,
                    onSelect: _prefill,
                  ),
            lines: [...runs, ...projectAnnouncements(c.announcements)],
            pendingText: c.visiblePendingText,
            loading: c.loading,
            hasEarlier: c.before != null,
            approvals: widget.approvals,
            storageKey: 'history-${c.botId}',
            bottomSpace: c.stoppable
                ? null
                : const Visibility(
                    key: ValueKey('row:stop-space'),
                    visible: false,
                    maintainSize: true,
                    maintainAnimation: true,
                    maintainState: true,
                    child: ComposerStopButton(),
                  ),
            focusRunId: c.focusRunId,
            onRefresh: _refresh,
            onOpenRun: widget.onOpenRun ?? (_) {},
            onOpenExchange: widget.onOpenExchange,
            backgroundOf: widget.backgroundOf,
            primaryOf: widget.primaryOf,
            nameOf: widget.nameOf,
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
        // The companion is laid over the row rather than in it. In a Row its
        // column was 74 points tall — the artboard plus its bottom inset —
        // which is more than the composer at rest and less than the composer
        // with Stop showing, so the row's height switched masters at the end
        // of every Turn and the thread above jumped ten points. The composer
        // alone sets the height now; the transcript's reserved Stop space
        // keeps the thread still, as it did before the companion arrived.
        Stack(
          clipBehavior: Clip.none,
          children: [
            Padding(
              padding: EdgeInsets.only(left: avatarSize + 12),
              child: _composer(c),
            ),
            // The field sits above the system's bottom inset (the composer
            // keeps it in a SafeArea); the companion sits above the same
            // inset, or on a phone it hung a gesture bar's height below the
            // field's baseline.
            Positioned(
              key: _companionKey,
              left: 10,
              bottom: 10 + MediaQuery.paddingOf(context).bottom,
              // The companion is the working indicator: while a Turn runs it
              // takes the working pose and wears the typing badge, paced by
              // the Turn's own stream. Nothing in the thread says "thinking"
              // any more; the character does.
              child: working
                  ? identified(
                      ShellIds.workingIndicator,
                      Semantics(
                        container: true,
                        liveRegion: true,
                        label: 'Working',
                        child: WorkingPace(
                          line: runningLine,
                          builder: (context, tempo) => CharacterAvatar(
                            size: avatarSize,
                            characterId: widget.background,
                            primary: widget.primary,
                            enableGaze: true,
                            gaze: gaze,
                            motion: CharacterMotion.active,
                            activity: CharacterActivity.working,
                            working: true,
                            tempo: tempo,
                          ),
                        ),
                      ),
                    )
                  : CharacterAvatar(
                      size: avatarSize,
                      characterId: widget.background,
                      primary: widget.primary,
                      enableGaze: true,
                      gaze: gaze,
                      // A live artboard at rest, so the eyes can follow the
                      // pointer and the character can twitch between Turns.
                      // Quiet, not active: the ticker runs only for a moment
                      // after a change and stops again, which is what keeps
                      // an open chat from redrawing the window sixty times
                      // a second. The artboard takes no pointer and no
                      // focus, so the field beside it keeps its keystrokes
                      // (errors.e2e, skill-menu.e2e).
                      motion: CharacterMotion.quiet,
                      activity: CharacterActivity.idle,
                      semanticsLabel: 'Bot is ready',
                    ),
            ),
          ],
        ),
      ],
    );
  }

  Widget _composer(ChatController c) => Composer(
    editor: editor,
    focus: focus,
    // Readiness is about the transport, the Bot and the model; whether there
    // is something worth sending is the Composer's own question.
    ready: c.canSend,
    stoppable: c.stoppable,
    stopping: c.stopping,
    onSend: _send,
    onStop: c.stop,
    onChanged: (value) => unawaited(c.saveDraft(value)),
    skills: skills,
    onDictate: widget.onDictate,
    onStopDictation: widget.onStopDictation,
    dictationState: widget.dictationState,
    dictationLevel: widget.dictationLevel,
  );

  @override
  void dispose() {
    controller.removeListener(_update);
    widget.approvals?.removeListener(_repaint);
    editor.dispose();
    focus.dispose();
    gaze.dispose();
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
  final void Function(TranscriptLine line)? onOpenExchange;
  final String? Function(String botId)? backgroundOf;
  final String? Function(String botId)? primaryOf;
  final String? Function(String botId)? nameOf;
  final VoidCallback? onOpenSettings;
  final void Function(TranscriptLine, {Offset? position})? onMessageActions;
  final String? unreadFromMessageId;
  final void Function(String?)? onReadLatest;
  final void Function(String? runId)? onWorkingChanged;
  final void Function(String botId, ConnectionState state)? onConnectionChanged;
  final bool outOfCredit;
  final VoidCallback? onOpenBilling;
  final VoidCallback? onDictate;
  final VoidCallback? onStopDictation;
  final DictationState dictationState;
  final ValueListenable<double>? dictationLevel;
  final String? background;
  final String? primary;

  /// Whether this is General, whose empty thread offers starter suggestions.
  final bool general;
  final int featuresRevision;
  const ConversationView({
    super.key,
    required this.sessions,
    required this.api,
    required this.store,
    required this.userId,
    required this.botId,
    required this.onOpenRun,
    this.onOpenExchange,
    this.backgroundOf,
    this.primaryOf,
    this.nameOf,
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
    this.dictationState = DictationState.idle,
    this.dictationLevel,
    this.background,
    this.primary,
    this.general = false,
    this.featuresRevision = 0,
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
  late List<StarterSuggestionV1> starters = widget.general
      ? startersForV1(null)
      : const [];

  @override
  void initState() {
    super.initState();
    if (widget.general) unawaited(_loadStarters());
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

  @override
  void didUpdateWidget(ConversationView old) {
    super.didUpdateWidget(old);
    if (old.general == widget.general &&
        old.featuresRevision == widget.featuresRevision) {
      return;
    }
    if (widget.general) {
      starters = startersForV1(null);
      unawaited(_loadStarters());
    } else {
      starters = const [];
    }
  }

  Future<void> _loadStarters() async {
    final revision = widget.featuresRevision;
    final features = await readBotFeaturesV1(widget.api, widget.botId);
    if (mounted && widget.general && revision == widget.featuresRevision) {
      setState(() => starters = startersForV1(features));
    }
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
    botId: widget.botId,
    child: ChatPane(
      background: widget.background,
      primary: widget.primary,
      starters: starters,
      controller: session.controller,
      onReconnect: session.channel.connect,
      approvals: approvals,
      skills: skills,
      onOpenRun: widget.onOpenRun,
      onOpenExchange: widget.onOpenExchange,
      backgroundOf: widget.backgroundOf,
      primaryOf: widget.primaryOf,
      nameOf: widget.nameOf,
      onOpenSettings: widget.onOpenSettings,
      onMessageActions: widget.onMessageActions,
      unreadFromMessageId: widget.unreadFromMessageId,
      onReadLatest: widget.onReadLatest,
      onWorkingChanged: widget.onWorkingChanged,
      outOfCredit: widget.outOfCredit,
      onOpenBilling: widget.onOpenBilling,
      onDictate: widget.onDictate,
      onStopDictation: widget.onStopDictation,
      dictationState: widget.dictationState,
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
