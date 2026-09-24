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
import '../cards/approvals.dart';
import '../cards/connections.dart';
import '../cards/chat_card.dart';
import '../client/bot_sessions.dart';
import '../client/chat_controller.dart';
import '../client/transport.dart';
import '../flock/avatar.dart';
import '../theme/frock_theme.dart';
import '../theme/states.dart';
import '../voice/dictation.dart';
import 'approvals.dart';
import 'connect_cards.dart';
import 'chat_header.dart';
import 'composer.dart';
import 'desktop_layout.dart';
import 'run_view.dart';
import 'semantics.dart';
import 'skill_menu.dart';
import 'starters.dart';
import 'transcript.dart';

/// Silhouette height of the companion at the end of the thread: a little
/// taller than a line of the Bot's words, so it reads as the Bot, not a glyph.
const double threadCompanionSize = 52;

/// A Bot this Turn has asked something, standing beside the one asking.
const double askedCompanionSize = 34;

/// Pops a Bot that has just been asked something in beside the one asking.
class _Asked extends StatelessWidget {
  final Widget child;
  const _Asked({super.key, required this.child});

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(left: 4),
    child: TweenAnimationBuilder<double>(
      tween: Tween(begin: 0, end: 1),
      duration: FrockTheme.motion(context, FrockTheme.enter),
      curve: Curves.easeOutBack,
      builder: (context, value, child) => Opacity(
        opacity: value.clamp(0.0, 1.0),
        child: Transform.scale(
          scale: 0.6 + 0.4 * value,
          alignment: Alignment.bottomCenter,
          child: child,
        ),
      ),
      child: child,
    ),
  );
}

class ChatPane extends StatefulWidget {
  final ChatController controller;

  /// The Bot's current name, which the empty composer is addressed to.
  final String? botName;
  final Future<void> Function() onReconnect;
  final SkillMenuController? skills;

  /// Opens the run view. The shell decides whether that is the right panel or
  /// a page, because that is a layout question and not this pane's.
  final void Function(TranscriptLine line)? onOpenRun;

  /// Opens the view-only chat behind an exchange marker. Layout is the
  /// shell's call, as it is for the run view.
  final void Function(TranscriptLine line)? onOpenExchange;

  /// Another Bot's character and current name, for the marker that names it.
  final String? Function(String botId)? backgroundOf;
  final String? Function(String botId)? primaryOf;
  final String? Function(String botId)? nameOf;
  final void Function(TranscriptLine, {Offset? position})? onMessageActions;
  final String? unreadFromMessageId;
  final void Function(String? newest, bool onScreen)? onReadLatest;

  /// True when the account cannot pay for a reply: the banner says so before
  /// the person types one, and a failed reply's notice can open Billing.
  final bool outOfCredit;
  final VoidCallback? onOpenBilling;

  /// Dictation, which the shell owns because a capture outlives this pane:
  /// switching Bots must flush into the Bot the capture started on.
  final VoidCallback? onDictate;
  final VoidCallback? onStopDictation;

  /// Throws a capture away, its words with it.
  final VoidCallback? onDiscardDictation;

  /// Starts a voice call with this Bot, or moves the open one to it
  /// (ADR 0029). It never ends one: hang-up lives on the call card.
  final VoidCallback? onVoice;

  /// Whether a call is still closing, which holds [onVoice]'s control.
  final bool voiceClosing;

  /// Whether this Bot is the one on the call: the voice control wears primary.
  final bool voiceActive;
  final DictationState dictationState;

  /// Whether a tidied transcript is in the draft and can be put back. Asked
  /// on every build rather than passed as a value, so a draft edit withdraws
  /// the offer the moment it happens.
  final bool Function()? canRevertDictation;

  /// Puts the raw transcript back into the draft.
  final VoidCallback? onRevertDictation;
  final ValueListenable<double>? dictationLevel;
  final ValueListenable<Duration>? dictationElapsed;

  /// The Bot's character and chosen colour, shared by every avatar surface.
  final String? background;
  final String? primary;

  /// Conversation chrome laid over the thread: the fade, the companion, the
  /// name and the doors. The pane builds the companion so gaze stays with the
  /// pane; the shell wraps it in [ChatHeader]. The companion there is at
  /// rest: a Turn is worn at the end of the thread instead. The pane's
  /// notices (offline, out of credit) go under the header's row, since the
  /// top of the thread is behind the header.
  final Widget Function(Widget companion, List<Widget> notices)? overlay;

  /// What the empty thread offers to write into the composer.
  final List<StarterSuggestionV1> starters;
  const ChatPane({
    super.key,
    required this.controller,
    this.botName,
    required this.onReconnect,
    this.skills,
    this.onOpenRun,
    this.onOpenExchange,
    this.backgroundOf,
    this.primaryOf,
    this.nameOf,
    this.onMessageActions,
    this.unreadFromMessageId,
    this.onReadLatest,
    this.outOfCredit = false,
    this.onOpenBilling,
    this.onDictate,
    this.onStopDictation,
    this.onDiscardDictation,
    this.onVoice,
    this.voiceClosing = false,
    this.voiceActive = false,
    this.dictationState = DictationState.idle,
    this.canRevertDictation,
    this.onRevertDictation,
    this.dictationLevel,
    this.dictationElapsed,
    this.background,
    this.primary,
    this.overlay,
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

  /// Raised for a moment after any pointer down on the pane. The engine
  /// attaches the composer's editing element in the frames after a tap, and
  /// the companion drawing a turn of its eyes in those same frames cost the
  /// first keystroke (skill-menu.e2e): the artboard holds still until the
  /// field has the keys.
  final hold = ValueNotifier<bool>(false);
  Timer? _holdTimer;
  final _companionKey = GlobalKey();

  void _pointerDown() {
    hold.value = true;
    _holdTimer?.cancel();
    _holdTimer = Timer(const Duration(milliseconds: 900), () {
      if (mounted) hold.value = false;
    });
  }

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
    if (controller.ready) AcceptanceMetrics.instance.editableShown();
  }

  Future<void> _send() async {
    if (!controller.canSend || editor.text.trim().isEmpty) return;
    final text = editor.text;
    if (text.trim() == '/$stopCommandName') {
      _clearCommand();
      await _stop();
      return;
    }
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

  /// A command is the composer's own business: its words never reach the Bot.
  void _clearCommand() {
    editor.clear();
    unawaited(controller.saveDraft(''));
    skills?.close();
  }

  /// A word from the composer about a command it ran, said once above the
  /// field and gone again: nothing to act on, so nothing to dismiss.
  String? _commandNote;
  Timer? _commandNoteTimer;

  Future<void> _stop() async {
    if (!controller.stoppable) {
      _commandNoteTimer?.cancel();
      // A message still being delivered has no Turn to stop yet, though the
      // Bot already looks busy: that is not "nothing".
      setState(
        () => _commandNote = controller.activeRunId != null
            ? 'Your message is still on its way. Try /stop again in a moment.'
            : 'Nothing to stop.',
      );
      _commandNoteTimer = Timer(const Duration(seconds: 3), () {
        if (mounted) setState(() => _commandNote = null);
      });
      return;
    }
    unawaited(HapticFeedback.mediumImpact().catchError((Object _) {}));
    await controller.stop();
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
    setState(() {});
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
      builder: (context, constraints) => Listener(
        behavior: HitTestBehavior.translucent,
        onPointerDown: (_) => _pointerDown(),
        child: MouseRegion(
          opaque: false,
          hitTestBehavior: HitTestBehavior.translucent,
          onHover: (event) =>
              _pointerMoved(event.position, constraints.biggest),
          onExit: (_) => gaze.value = null,
          child: _column(context, c),
        ),
      ),
    );
  }

  Widget _column(BuildContext context, ChatController c) {
    final runs = projectRuns(c.runs);
    final working = c.activeRunId != null;
    // The Bots working on something this Turn asked them. The controller
    // counts one only once its answering Turn is running, not while the
    // question waits in its queue.
    final asking = working ? c.helpers : const <String>[];
    final thread = TranscriptView(
      background: widget.background,
      starters: widget.starters.isEmpty
          ? null
          : StarterSuggestions(starters: widget.starters, onSelect: _prefill),
      lines: [...runs, ...projectAnnouncements(c.announcements)],
      pending: switch (c.visiblePending) {
        final send? => unconfirmedLine(
          send.id,
          send.text,
          localOrder: c.localOrderOf(send.id),
        ),
        null => null,
      },
      loading: c.loading,
      hasEarlier: c.before != null,
      storageKey: 'history-${c.botId}',
      tail: working ? _typing(c, asking) : null,
      focusRunId: c.focusRunId,
      onRefresh: _refresh,
      onOpenRun: widget.onOpenRun ?? (_) {},
      onOpenExchange: widget.onOpenExchange,
      backgroundOf: widget.backgroundOf,
      primaryOf: widget.primaryOf,
      nameOf: widget.nameOf,
      onRetryTurn: c.canSend ? _retry : null,
      onOpenBilling: widget.onOpenBilling,
      onMessageActions: widget.onMessageActions,
      unreadFromMessageId: widget.unreadFromMessageId,
      onReadLatest: widget.onReadLatest,
    );
    final notices = <Widget>[
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
    ];
    return Column(
      children: [
        Expanded(
          child: Stack(
            children: [
              Column(
                children: [
                  Expanded(
                    child: Center(
                      child: ConstrainedBox(
                        constraints: const BoxConstraints(
                          maxWidth: readingWidth,
                        ),
                        child: thread,
                      ),
                    ),
                  ),
                  if (c.error != null)
                    Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 16,
                        vertical: 8,
                      ),
                      child: Text(
                        c.error!,
                        style: TextStyle(
                          color: Theme.of(context).colorScheme.error,
                        ),
                      ),
                    ),
                  if (_commandNote != null)
                    Padding(
                      padding: const EdgeInsets.fromLTRB(20, 4, 20, 2),
                      child: Align(
                        alignment: AlignmentDirectional.centerStart,
                        child: Text(
                          _commandNote!,
                          key: const ValueKey('command-note'),
                          style: Theme.of(context).textTheme.bodySmall
                              ?.copyWith(
                                color: Theme.of(context)
                                    .colorScheme
                                    .onSurfaceVariant,
                              ),
                        ),
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
                ],
              ),
              Positioned.fill(child: _chrome(_companion(c, working), notices)),
            ],
          ),
        ),
        Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: readingWidth),
            child: _composer(c),
          ),
        ),
      ],
    );
  }

  /// The fade and the pills wrap [companion] when the shell passed chrome;
  /// pane-only tests still get the character at the same inset, with the
  /// notices under it.
  Widget _chrome(Widget companion, List<Widget> notices) {
    if (widget.overlay != null) return widget.overlay!(companion, notices);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.only(
            top: chatHeaderChromeTop,
            left: chatHeaderChromeSide,
          ),
          child: Align(
            alignment: Alignment.topLeft,
            child: IgnorePointer(child: companion),
          ),
        ),
        ...notices,
      ],
    );
  }

  /// The Bot at the end of its own thread while a Turn runs, where its next
  /// words will land, working as it is everywhere else it is drawn; a Bot it
  /// has asked something stands beside it, working too, until it answers.
  Widget _typing(ChatController c, List<String> asking) {
    final names = [
      for (final botId in asking) widget.nameOf?.call(botId) ?? 'another Bot',
    ];
    return identified(
      ShellIds.workingIndicator,
      Semantics(
        container: true,
        liveRegion: true,
        label: names.isEmpty
            ? 'Working'
            : 'Working with ${names.join(' and ')}',
        child: Row(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            CharacterAvatar(
              size: threadCompanionSize,
              botId: c.botId,
              characterId: widget.background,
              primary: widget.primary,
              cropToInk: true,
              working: true,
            ),
            for (final botId in asking)
              _Asked(
                key: ValueKey('asked:$botId'),
                child: CharacterAvatar(
                  size: askedCompanionSize,
                  botId: botId,
                  characterId: widget.backgroundOf?.call(botId),
                  primary: widget.primaryOf?.call(botId),
                  cropToInk: true,
                  working: true,
                ),
              ),
            if (MediaQuery.disableAnimationsOf(context)) ...[
              const SizedBox(width: 10),
              Text(
                'Working…',
                style: Theme.of(context).textTheme.labelMedium?.copyWith(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  /// The companion in the header: at rest between Turns, and working while
  /// one runs, exactly as the Bot does at the end of the thread and in the
  /// sidebar.
  Widget _companion(ChatController c, bool working) {
    final phone =
        shellTierForWidth(MediaQuery.sizeOf(context).width) == ShellTier.single;
    final avatar = CharacterAvatar(
      size: chatCompanionSizeFor(phone: phone),
      botId: c.botId,
      characterId: widget.background,
      primary: widget.primary,
      gaze: gaze,
      hold: hold,
      cropToInk: true,
      // A live artboard at rest, so the eyes can follow the pointer
      // and the character can twitch between Turns. Quiet, not
      // active: the ticker runs only for a moment after a change and
      // stops again, which is what keeps an open chat from redrawing
      // the window sixty times a second. The artboard takes no
      // pointer and no focus, so the field below it keeps its
      // keystrokes (errors.e2e, skill-menu.e2e).
      motion: CharacterMotion.quiet,
      working: working,
      semanticsLabel: working ? 'Bot is working' : 'Bot is ready',
    );
    return KeyedSubtree(key: _companionKey, child: avatar);
  }

  Widget _composer(ChatController c) => Composer(
    editor: editor,
    focus: focus,
    // Readiness is about the transport, the Bot and the model; whether there
    // is something worth sending is the Composer's own question.
    ready: c.canSend,
    botName: widget.botName,
    stoppable: c.stoppable,
    onSend: _send,
    onStop: _stop,
    onChanged: (value) {
      unawaited(c.saveDraft(value));
    },
    skills: skills,
    onDictate: widget.onDictate,
    onStopDictation: widget.onStopDictation,
    onDiscardDictation: widget.onDiscardDictation,
    onVoice: widget.onVoice,
    voiceClosing: widget.voiceClosing,
    voiceActive: widget.voiceActive,
    dictationState: widget.dictationState,
    canRevertDictation: widget.canRevertDictation,
    onRevertDictation: widget.onRevertDictation,
    dictationLevel: widget.dictationLevel,
    dictationElapsed: widget.dictationElapsed,
  );

  @override
  void dispose() {
    controller.removeListener(_update);
    editor.dispose();
    focus.dispose();
    gaze.dispose();
    _holdTimer?.cancel();
    _commandNoteTimer?.cancel();
    hold.dispose();
    super.dispose();
  }
}

/// The pane plus the session behind it, which is what the shell mounts.
class ConversationView extends StatefulWidget {
  final BotSession session;
  final LocalStore store;

  /// The Bot's current name. See [ChatPane.botName].
  final String? botName;
  final void Function(TranscriptLine line) onOpenRun;
  final void Function(TranscriptLine line)? onOpenExchange;
  final String? Function(String botId)? backgroundOf;
  final String? Function(String botId)? primaryOf;
  final String? Function(String botId)? nameOf;
  final void Function(TranscriptLine, {Offset? position})? onMessageActions;
  final String? unreadFromMessageId;
  final void Function(String? newest, bool onScreen)? onReadLatest;
  final bool outOfCredit;
  final VoidCallback? onOpenBilling;
  final VoidCallback? onDictate;
  final VoidCallback? onStopDictation;

  /// Throws a capture away, its words with it.
  final VoidCallback? onDiscardDictation;

  /// Starts a voice call with this Bot, or moves the open one to it
  /// (ADR 0029). It never ends one: hang-up lives on the call card.
  final VoidCallback? onVoice;

  /// Whether a call is still closing, which holds [onVoice]'s control.
  final bool voiceClosing;

  /// Whether this Bot is the one on the call: the voice control wears primary.
  final bool voiceActive;
  final DictationState dictationState;

  /// Whether a tidied transcript is in the draft and can be put back. Asked
  /// on every build rather than passed as a value, so a draft edit withdraws
  /// the offer the moment it happens.
  final bool Function()? canRevertDictation;

  /// Puts the raw transcript back into the draft.
  final VoidCallback? onRevertDictation;
  final ValueListenable<double>? dictationLevel;
  final ValueListenable<Duration>? dictationElapsed;
  final String? background;
  final String? primary;

  /// Conversation chrome laid over the thread. See [ChatPane.overlay].
  final Widget Function(Widget companion, List<Widget> notices)? overlay;

  /// Whether this is General, whose empty thread offers starter suggestions.
  final bool general;
  final int featuresRevision;
  const ConversationView({
    super.key,
    required this.session,
    required this.store,
    this.botName,
    required this.onOpenRun,
    this.onOpenExchange,
    this.backgroundOf,
    this.primaryOf,
    this.nameOf,
    this.onMessageActions,
    this.unreadFromMessageId,
    this.onReadLatest,
    this.outOfCredit = false,
    this.onOpenBilling,
    this.onDictate,
    this.onStopDictation,
    this.onDiscardDictation,
    this.onVoice,
    this.voiceClosing = false,
    this.voiceActive = false,
    this.dictationState = DictationState.idle,
    this.canRevertDictation,
    this.onRevertDictation,
    this.dictationLevel,
    this.dictationElapsed,
    this.background,
    this.primary,
    this.overlay,
    this.general = false,
    this.featuresRevision = 0,
  });

  @override
  State<ConversationView> createState() => _ConversationViewState();
}

class _ConversationViewState extends State<ConversationView> {
  BotSession get session => widget.session;
  late final ApprovalsController approvals = ApprovalsController(
    api: session.api,
    store: widget.store,
    userId: session.userId,
    botId: session.botId,
  );
  late final SkillMenuController skills = SkillMenuController(
    api: session.api,
    botId: session.botId,
  );
  late final ConnectCardsController connections = ConnectCardsController(
    api: session.api,
  );
  late List<StarterSuggestionV1> starters = widget.general
      ? startersForV1(null)
      : const [];

  @override
  void initState() {
    super.initState();
    if (widget.general) unawaited(_loadStarters());
    session.controller.addListener(_repaint);
    unawaited(session.start());
    unawaited(approvals.load());
    unawaited(skills.load());
  }

  void _repaint() {
    if (!mounted) return;
    setState(() {});
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
    final features = await readBotFeaturesV1(session.api, session.botId);
    if (mounted && widget.general && revision == widget.featuresRevision) {
      setState(() => starters = startersForV1(features));
    }
  }

  @override
  Widget build(BuildContext context) => CardChatScope(
    api: session.api,
    botId: session.botId,
    invalidations: session.controller.invalidations,
    // What `ApprovalActions` reads to say what was decided. The decision is
    // the kernel's record, not the Card's, so the component that draws it
    // reads the Bot's own approvals projection (ADR 0030 step 7).
    child: CardApprovalsScope(
      approvals: approvals,
      // What `ConnectApp` reads to say an app is connected, and the door its
      // button opens: the person's own, never an action the Bot receives.
      child: CardConnectionsScope(
        connections: connections,
        child: ChatPane(
          background: widget.background,
          primary: widget.primary,
          overlay: widget.overlay,
          starters: starters,
          controller: session.controller,
          botName: widget.botName,
          onReconnect: session.channel.connect,
          skills: skills,
          onOpenRun: widget.onOpenRun,
          onOpenExchange: widget.onOpenExchange,
          backgroundOf: widget.backgroundOf,
          primaryOf: widget.primaryOf,
          nameOf: widget.nameOf,
          onMessageActions: widget.onMessageActions,
          unreadFromMessageId: widget.unreadFromMessageId,
          onReadLatest: widget.onReadLatest,
          outOfCredit: widget.outOfCredit,
          onOpenBilling: widget.onOpenBilling,
          onDictate: widget.onDictate,
          onVoice: widget.onVoice,
          voiceClosing: widget.voiceClosing,
          voiceActive: widget.voiceActive,
          onStopDictation: widget.onStopDictation,
          onDiscardDictation: widget.onDiscardDictation,
          dictationState: widget.dictationState,
          canRevertDictation: widget.canRevertDictation,
          onRevertDictation: widget.onRevertDictation,
          dictationLevel: widget.dictationLevel,
          dictationElapsed: widget.dictationElapsed,
        ),
      ),
    ),
  );

  @override
  void dispose() {
    // The session outlives this view so that switching back to this Bot is a
    // lookup rather than a reconnection.
    session.controller.removeListener(_repaint);
    approvals.dispose();
    connections.dispose();
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
    appBar: DesktopHeader(child: AppBar(title: const Text('Work'))),
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
