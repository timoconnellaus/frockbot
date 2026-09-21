/// The signed-in shell: the Bot list, the conversation, and the right panel.
///
/// Everything above a single Bot lives here — the directory, the identities
/// the sidebar groups by, the unread fan-out, the drawers' state and the slot
/// registry a feature renders into. `main.dart` is the app entry and the sign
/// -in door, and hands this a signed-in session and nothing else.
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter/services.dart';

import '../activity/badge.dart';
import '../activity/controller.dart';
import '../activity/push.dart';
import '../applets/canvas.dart';
import '../applets/list.dart';
import '../audit/page.dart';
import '../client/auth.dart' show developmentAuth;
import '../client/document_cache.dart';
import '../client/bot_sessions.dart';
import '../client/chat_controller.dart' show ChatController, ConnectionState;
import '../client/exchange_controller.dart';
import '../client/transport.dart';
import '../computer/card.dart';
import '../computer/client.dart';
import '../connections/page.dart';
import '../flock/avatar.dart';
import '../flock/create.dart';
import '../flock/lifecycle.dart';
import '../machines/page.dart';
import '../machines/mac_messages.dart';
import '../packages/catalog.dart';
import '../packages/frame.dart';
import '../plugins/page.dart';
import '../recovery/page.dart';
import '../routines/page.dart';
import '../routines/runs.dart';
import '../search/controller.dart';
import '../search/archived_conversation.dart';
import '../search/overlay.dart';
import '../settings/billing.dart';
import '../settings/credit.dart';
import '../settings/bot_quick_writes.dart';
import '../settings/bot_settings.dart';
import '../settings/look_settings.dart';
import '../settings/page.dart';
import '../settings/voice_settings.dart';
import '../templates/page.dart';
import '../theme/document.dart';
import '../theme/frock_theme.dart';
import '../theme/rows.dart';
import '../update/app_version.dart';
import '../view/sample_page.dart';
import '../whats_new/feed.dart';
import '../whats_new/mark.dart';
import '../whats_new/page.dart';
import '../voice/assistant.dart';
import '../voice/capabilities.dart';
import '../voice/capture.dart';
import '../voice/diagnostics.dart';
import '../voice/dictation.dart';
import '../voice/footer.dart';
import '../voice/call_chrome.dart';
import '../voice/motion.dart';
import '../voice/mic_ownership.dart';
import '../voice/player.dart';
import '../voice/route.dart';
import '../voice/protocol.dart' show voiceUnavailableMessage;
import '../voice/socket.dart';
import '../protocol/client_wire.generated.dart' as wire;
import 'bot_actions.dart';
import 'bot_page.dart';
import 'chat_pane.dart';
import 'chat_header.dart';
import 'desktop_layout.dart';
import 'hot_panel.dart';
import 'lifecycle.dart';
import 'message_actions.dart';
import 'exchange_view.dart';
import 'run_view.dart';
import 'semantics.dart';
import 'focus.dart' show sidebarUnreadFor;
import 'sidebar.dart';
import 'sidebar_order.dart';
import 'slots.dart';
import 'starters.dart';
import 'transcript.dart';

class AppShell extends StatefulWidget {
  final NativeApi api;
  final LocalStore store;
  final BotSessions sessions;
  final String userId;

  /// A `?bot=` deep link the app entry received. Pushing into it opens that
  /// Bot, which is the only thing the entry asks of the shell.
  final ValueNotifier<String?> botLinks;
  final Future<void> Function() onSignOut;

  /// What the Profile page says this program is. The entry hands over the
  /// update controller's answer, which also knows the booted Shorebird patch;
  /// without one the compiled version alone is shown.
  final Future<AppVersion> Function() version;
  const AppShell({
    super.key,
    required this.api,
    required this.store,
    required this.sessions,
    required this.userId,
    required this.botLinks,
    required this.onSignOut,
    this.version = compiledVersion,
  });

  static Future<AppVersion> compiledVersion() async => const AppVersion();

  @override
  State<AppShell> createState() => _AppShellState();
}

class _AppShellState extends State<AppShell> with WidgetsBindingObserver {
  final ShellSlots slots = ShellSlots();

  /// One retained lifecycle command for the account, whichever surface issued
  /// it: the danger zone in Bot settings, or Manage Bots.
  late final BotLifecycleCommands lifecycle = BotLifecycleCommands(
    widget.api,
    widget.store,
    widget.userId,
  );
  late final ActivityController activity = ActivityController(
    widget.api,
    widget.store,
    widget.userId,
  );

  /// One field of a Bot's settings at a time, from its row in the list.
  late final BotQuickWrites quickWrites = BotQuickWrites(widget.api);
  late final PushController push = PushController(
    widget.api,
    widget.store,
    widget.userId,
    activity,
  );

  /// The application icon's badge, drawn from what the sidebar draws.
  late final AppBadgeSync appBadge = AppBadgeSync(
    appBadgePresenterFor(pushReady: () => push.platformReady),
  );

  /// Whether the push channel has already been seen ready, so the one focus
  /// report that needs the badge redrawn is told apart from the rest.
  bool _pushReadySeen = false;
  String? clearManualForBot;
  bool resumed = true;
  Timer? _activityTimer;
  List<wire.BotRegistration> bots = [];
  List<wire.BotRegistration> searchableBots = [];
  Map<String, SidebarProfile> profiles = {};
  Set<String> archived = {};
  wire.BotRegistration? selected;

  /// Account look: Ink, Paper, or System. Paints the shell in the same
  /// frame as a Bot switch. A Bot with its own look (Studio or a stored
  /// document) overlays the thread and right panel; Inherit does not.
  AccountLook accountLook = AccountLook.ink;
  String accountTimezone = 'UTC';

  /// The Bot the account was given as General, from the authority.
  String? generalBotId;
  int featuresRevision = 0;
  BotSettingsController? botSettings;
  RoutineInboxController? routineInbox;
  RoutinesPanelHandle? routinesPanel;

  /// The selected Bot's Applet canvas, its Computer, and the Package pages its
  /// Composition declares. All three belong to one Bot and are replaced whole
  /// when the selection moves.
  AppletCanvasController? appletCanvas;

  /// The live Applet frame's one key. On a phone the frame is built off stage
  /// the moment the Bot is adopted and moved into the canvas page when that
  /// is pushed, so opening the Applet presents a document that is already
  /// loaded and connected — the way the desk tiers have always kept it in
  /// the panel column. The key is what makes the push a move.
  final GlobalKey _appletFrameKey = GlobalKey(debugLabel: 'applet-frame');

  /// Whether the canvas page holds the frame now. While it does the off-stage
  /// holder builds nothing, so the one key is in one place.
  bool _appletPagePresented = false;
  ComputerController? computer;
  BotSession? _selectedSession;

  /// The last shell-visible projection observed for the selected Session.
  /// The values drawn stay on [ChatController]; these markers only suppress
  /// whole-shell rebuilds for controller changes the shell does not draw, and
  /// identify the one working-to-idle transition that refreshes Applets.
  String? _observedWorkingRunId;
  ConnectionState? _observedConnection;
  bool _observedBotComputerRunning = false;
  PackageCatalog? catalog;

  /// Bumped whenever [catalog] changes. A Bot page pushed as its own route
  /// is a subtree the shell's `setState` does not reach, so the page listens
  /// to this to redraw the rows its Packages contribute.
  final ValueNotifier<int> catalogRevision = ValueNotifier(0);

  /// Bumped when a Bot's character changes, so a pushed Bot page — which the
  /// shell's own rebuilds do not reach — redraws its preview with the choice.
  final ValueNotifier<int> avatarRevision = ValueNotifier(0);
  String? error;
  bool loaded = false;

  /// Whether the network directory and lifecycle state have been adopted.
  /// Unlike [loaded], a failed read does not set this: the badge must treat
  /// an unread directory as unknown rather than an account with nothing unread.
  bool directoryLoaded = false;

  /// The read [load] is waiting on, and the single follow-up read the callers
  /// that arrived during it share, so the retry the poll makes while the
  /// directory is still unknown cannot stack reads on top of each other.
  Future<void>? _directoryLoad;
  Future<void>? _queuedDirectoryLoad;
  bool _searchOpen = false;

  /// On a phone the Bot list is the first screen and a conversation is a
  /// page over it; this is whether that page is up. At the wider tiers the
  /// conversation is a column and this is not consulted.
  bool conversationOpen = false;

  /// Whether the sidebar shows the selected Bot's Applets in place of the
  /// Bots. Only where the sidebar is a column: a phone's list is the first
  /// screen, so its Applets are a page over it instead.
  bool appletsMode = false;
  bool panelOpen = false;

  /// Whether the person has hidden the right panel where it is a column. The
  /// drawer's flag above is not this: closing the drawer at one width must not
  /// take the column away at another.
  bool panelCollapsed = false;

  /// Whether the run on screen borrowed a collapsed panel column. Opening a
  /// run un-collapses the column so the run is visible; closing the run gives
  /// the column back the way the person left it instead of leaving a panel
  /// they had put away on screen. Any newer choice of theirs clears this.
  bool runBorrowedPanel = false;

  /// What the panel is showing over the Bot page.
  ///
  /// The Bot page is the panel's floor and is never in here: an empty stack is
  /// that page. A sub-page — Settings, All Routines, Plugins, a Package's own
  /// page — is pushed onto it, and the panel header grows a back
  /// chevron for as long as there is something to go back to. A Bot switch
  /// empties it, because a sub-page of one Bot is not a sub-page of another.
  final List<String> panelStack = [];

  /// Hot doors visited on this Bot, kept mounted so a return is the same
  /// page. Cleared on a Bot switch. Voice, Look, Audit and framed pages
  /// are never in here.
  final Set<String> keptPanels = {};

  /// The Package page the `package` entry is showing, which is chosen when the
  /// door is pressed rather than registered per page.
  PackageEntryPage? panelPackage;

  /// Voice. The footer and both captures live here rather than in the pane
  /// because they outlive it: a call survives a Bot switch, a page and a
  /// drawer, and a dictation that was interrupted by a switch must still
  /// flush into the Bot it started on.
  ///
  /// The controllers are built on first use. Constructing them touches the
  /// microphone plugin, and a shell that has never been asked for voice must
  /// not ask a device for anything.
  late final VoiceCapabilityProbe voiceProbe = VoiceCapabilityProbe(widget.api);
  final MicOwnership microphone = MicOwnership();

  /// One capture for both features. The microphone has one owner at a time,
  /// which [microphone] enforces, so there is one device object.
  VoiceCapture? voiceCapture;
  AssistantSessionController? voiceSession;

  /// The call's audio session on this platform, held from before the
  /// microphone opens until after the speaker closes.
  VoiceAudioRoute audioRoute = VoiceAudioRoute.forPlatform();
  DictationController? dictation;
  bool footerOpen = false;
  bool footerExiting = false;

  /// The Bot the open call is with (ADR 0029): that Bot's page is the one
  /// voice mode is drawn on, and every other Bot's keeps its thread.
  String? voiceBotId;
  bool showHidden = false;
  TranscriptLine? openRun;

  /// The exchange chat the right panel holds, while it holds one.
  ExchangeController? exchangeController;

  /// The panel's repaint source: the exchange's own pages, and the chat whose
  /// in-flight runs the view merges with them. Set and cleared with
  /// [exchangeController].
  Listenable? exchangeListenable;

  /// What the account can spend, from `/api/billing`. Null until read, and
  /// null on a deployment that does not meter: then credit means nothing and
  /// no surface mentions it.
  AccountCredit? credit;

  WhatsNewFeed whatsNew = const WhatsNewFeed();
  String? whatsNewSeenId;

  @override
  void initState() {
    super.initState();
    unawaited(macMessages.configure(widget.userId));
    WidgetsBinding.instance.addObserver(this);
    microphone.assistantLive = () => voiceSession?.active == true;
    microphone.holdAssistant = (held) async =>
        voiceSession?.holdMicrophone(held);
    microphone.dictationActive = () => dictation?.active == true;
    microphone.stopDictation = _stopDictation;
    activity.addListener(_repaint);
    // Read once, now, so the first press on a voice control answers at once.
    unawaited(voiceProbe.load());
    push.onNotificationsChanged = () {
      appBadge.invalidate();
      if (mounted) setState(() {});
    };
    // Focus can be reported while this state is still starting, so the
    // repaint the focus rule needs waits for a microtask.
    push.onFocus = () => scheduleMicrotask(() {
      if (!mounted) return;
      // Every other focus report changes the badge's own value — the focused
      // Bot's count is suppressed — so the repaint below carries it. Only the
      // platform becoming ready leaves an already-correct badge undrawn,
      // because the launcher adapter dropped it while the channel was not up.
      if (push.platformReady && !_pushReadySeen) {
        _pushReadySeen = true;
        appBadge.invalidate();
      }
      setState(() {});
    });
    widget.botLinks.addListener(_followBotLink);
    // A lifecycle command nobody has an answer for is adopted here rather than
    // when the danger zone happens to be opened: it is the account's, and it
    // is what locks the zone until it is accounted for.
    unawaited(lifecycle.restore());
    unawaited(load());
    unawaited(_loadAppearance());
    unawaited(_readWhatsNew());
    _startPolling();
    unawaited(push.start());
  }

  void _repaint() {
    if (mounted) setState(() {});
    unawaited(push.syncRead());
  }

  /// Settings writes that should paint now — a Look chosen beside the
  /// thread — without treating the conversation as unread-sync work.
  void _paintFromSettings() {
    if (mounted) setState(() {});
  }

  ChatController? get _selectedChat => _selectedSession?.controller;
  String? get _workingRunId => _selectedChat?.activeRunId;
  ConnectionState get _selectedConnection =>
      _selectedChat?.connection ?? ConnectionState.initializing;
  bool get _botComputerRunning => botComputerRunningV1(
    _selectedChat?.runs ?? const <Map<String, dynamic>>[],
  );

  void _selectedChatChanged() {
    final session = _selectedSession;
    if (session == null) return;
    final workingRunId = session.controller.activeRunId;
    final connection = session.controller.connection;
    final computerRunning = botComputerRunningV1(session.controller.runs);
    final settled = _observedWorkingRunId != null && workingRunId == null;
    final repaint =
        workingRunId != _observedWorkingRunId ||
        connection != _observedConnection ||
        computerRunning != _observedBotComputerRunning;
    _observedWorkingRunId = workingRunId;
    _observedConnection = connection;
    _observedBotComputerRunning = computerRunning;
    if (!repaint) return;
    // Restoring a cached conversation can notify while its pane is building.
    scheduleMicrotask(() {
      if (!mounted || !identical(_selectedSession, session)) return;
      setState(() {});
      // A Turn is how an Applet comes into existence. Refresh the directory
      // when that Turn ends, without mirroring the Turn itself into the shell.
      final canvas = appletCanvas;
      if (settled && canvas != null) unawaited(canvas.load());
    });
  }

  /// The Bot the User is reading right now, or null when none is: the open
  /// chat, on a window that holds focus, with nothing covering it. One
  /// definition, because the read receipt and the sidebar's badge are two
  /// halves of the same answer and must not disagree.
  String? get _focusedBotId {
    final open = selected?.botId.value;
    if (open == null ||
        !resumed ||
        !push.focused ||
        !_conversationVisible ||
        _conversationCovered ||
        ModalRoute.of(context)?.isCurrent != true) {
      return null;
    }
    return open;
  }

  /// Whether the panel is over the conversation rather than beside it, which
  /// is the "nothing is covering it" clause of the focus rule in `focus.dart`.
  ///
  /// Mirrors the one condition `ShellLayout` draws the drawer on, rather than
  /// approximating it: the dual tier, with `panelOpen` set. `openRun` is
  /// deliberately not a second disqualifier — a run reaches the screen as the
  /// widest tier's third column, through that same drawer, or as a pushed page
  /// the route check answers, never on its own. Asked on its own it latched,
  /// surviving the drawer being switched off, and took the read receipt with
  /// it for the rest of the session.
  bool get _conversationCovered =>
      shellTierForWidth(MediaQuery.sizeOf(context).width) == ShellTier.dual &&
      panelOpen;

  void _readLatest(String botId, String? messageId) {
    if (!mounted) return;
    final viewing = _focusedBotId == botId;
    final view = activity.unread[botId];
    // Presence is only claimed for the message the cloud says is the latest and
    // this device is actually showing. Claiming it for anything else asks the
    // server to hold an alert back for a message nobody is looking at.
    final showingLatest =
        viewing && messageId != null && view?.lastMessageId == messageId;
    push.reading(showingLatest ? botId : null);
    if (!showingLatest ||
        ((view?.count ?? 0) == 0 && view?.manuallyUnread != true) ||
        (view?.manuallyUnread == true && clearManualForBot != botId)) {
      return;
    }
    if (activity.loading || activity.busy(botId)) return;
    clearManualForBot = null;
    unawaited(activity.mark(botId, read: true));
  }

  /// Whether the conversation is on screen at all: always at the wider tiers,
  /// and on a phone only while its page is up over the list.
  bool get _conversationVisible =>
      shellTierForWidth(MediaQuery.sizeOf(context).width) != ShellTier.single ||
      conversationOpen;

  void _startPolling() {
    _activityTimer?.cancel();
    _activityTimer = Timer.periodic(
      const Duration(seconds: 10),
      (_) => _refresh(),
    );
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    resumed = state == AppLifecycleState.resumed;
    push.lifecycle(resumed);
    if (resumed) unawaited(_readCredit());
    _activityTimer?.cancel();
    _activityTimer = null;
    if (appIsAwayV1(state)) {
      widget.sessions.pause();
      unawaited(_stopDictation());
      // A live call sleeps rather than hanging up: Gemini closes, the
      // microphone is released, the socket stays. Coming back resumes.
      // `detached` still ends it — the view is gone. A call that is still
      // connecting hangs up too, so a permission prompt left behind does
      // not open a capture the person is no longer looking at.
      final session = voiceSession;
      if (session != null &&
          footerOpen &&
          voiceLifecycleActionV1(state) == VoiceLifecycleActionV1.sleep &&
          session.phase == VoiceSessionPhase.live) {
        unawaited(session.leaveForeground());
      } else {
        unawaited(_endVoice(reason: 'lifecycle:${state.name}'));
      }
      return;
    }
    widget.sessions.resume();
    unawaited(voiceSession?.enterForeground());
    _refresh();
    _startPolling();
  }

  /// The unread counts, and the directory again while its read has never
  /// succeeded. The badge counts over the directory, so a failed first read
  /// would otherwise leave the icon unreconciled for the rest of the session
  /// while the sidebar's own counts kept moving.
  void _refresh() {
    unawaited(activity.load());
    if (!directoryLoaded) unawaited(load());
  }

  /// The composer's voice control: it starts a call with this Bot, or moves
  /// a live one to it. Since the sidebar's list-root control went it is the
  /// only way in, so a call always names a Bot (ADR 0029).
  ///
  /// It never ends a call: hang-up is the header chrome. A call that is
  /// already over is not moved, it is replaced: the person pressed the
  /// control to talk to this Bot.
  Future<void> _startOrSwitchVoice({required String botId}) {
    final session = voiceSession;
    if (!footerOpen || session == null || !session.active) {
      return _startVoice(botId: botId);
    }
    return _switchVoice(botId);
  }

  /// Whether a call is still closing. Its composer control is held for as
  /// long as that lasts: a press there is refused by [_startVoice], and a
  /// control that invites a press it will not take should say so instead.
  bool get voiceClosing => !footerOpen && voiceSession?.active == true;

  /// Moves an open call to another Bot without dropping the audio.
  ///
  /// Who the call is with is the server's to say: it may refuse the move — a
  /// Bot deleted from another device, a call that is no longer the live one —
  /// and adopting the id here would leave the screen naming a Bot the audio
  /// never reached. The `voice/target` frame is what moves it.
  Future<void> _switchVoice(String botId) async {
    final session = voiceSession;
    if (session == null) return;
    session.retarget(botId);
  }

  /// Opens the call's surface and starts the call in the one gesture.
  ///
  /// The call's chrome is on screen in the same frame as the press — the
  /// header pair on this Bot's page, the footer below the shell for a call
  /// that is with another. The capability probe was read at sign-in, so a
  /// deployment without voice is refused here without a round trip; a probe
  /// that never answered does not hold the press, and the socket speaks for
  /// itself.
  Future<void> _startVoice({required String botId}) async {
    if (voiceProbe.known && !voiceProbe.assistantAvailable) {
      _say(voiceUnavailableMessage);
      return;
    }
    if (voiceSession?.active == true) return;
    final borrowed = microphone.acquireForAssistant();
    final previous = voiceSession;
    previous?.dispose();
    // One id for this call, or null in every build that did not opt in: the
    // socket's `trace` and the controller's lines are the same call seen from
    // two ends.
    final diagnostics = voiceDiagnosticsV1();
    final session = AssistantSessionController(
      openSocket: assistantSocketOpenerV1(widget.api, diagnostics: diagnostics),
      botId: botId,
      diagnostics: diagnostics,
      capture: voiceCapture ??= RecordVoiceCapture(
        minimumBuffer: audioRoute.minimumCaptureBuffer,
      ),
      player: PcmVoicePlayer(),
      route: audioRoute,
    );
    // The Bot can hand the conversation over itself (ADR 0029, `switch_bot`),
    // and the person can press voice on another Bot's page. Either way the
    // server is the authority on who is on the line, so the shell follows
    // what it says rather than only what this client asked for.
    session.addListener(() {
      if (!mounted || !identical(voiceSession, session)) return;
      final now = session.currentBotId;
      if (now == null || now == voiceBotId) return;
      final wasOnScreen = selected?.botId.value == voiceBotId;
      setState(() => voiceBotId = now);
      // The conversation moved, so the page does too: the person is talking
      // to this Bot now, and the thread they can read should be the one they
      // are talking about. Only when the call is the thing on screen — a
      // hand-over must not drag someone out of a page they went to
      // themselves while the call carried on in the background.
      if (wasOnScreen &&
          selected?.botId.value != now &&
          bots.any((bot) => bot.botId.value == now)) {
        _select(now);
      }
    });
    setState(() {
      voiceSession = session;
      voiceBotId = botId;
      footerOpen = true;
      footerExiting = false;
    });
    // A dictation in progress is stopped and its draft flushed before the
    // call takes the device, and the call before this one is closed before
    // this one opens it: the capture and the audio session are the shell's,
    // lent to one call at a time.
    await borrowed;
    if (!mounted || !identical(voiceSession, session)) return;
    await previous?.released;
    await session.start();
  }

  /// Ends capture, playback and the call, and takes the footer away. It
  /// navigates nowhere. Leaving the app does not go through here: a live
  /// call sleeps instead, and only `detached` (or a call still connecting)
  /// hangs up.
  Future<void> _endVoice({required String reason}) async {
    final session = voiceSession;
    if (session == null || !footerOpen) return;
    setState(() {
      footerOpen = false;
      footerExiting = true;
    });
    try {
      await session.end(reason: reason);
    } finally {
      microphone.releaseAssistant();
      if (mounted) {
        session.dispose();
        if (identical(voiceSession, session)) {
          setState(() => voiceSession = null);
        }
      }
    }
  }

  Future<void> _dictate() async {
    final bot = selected;
    if (bot == null) return;
    if (!mounted) return;
    if (voiceProbe.known && !voiceProbe.dictationAvailable) {
      _say(voiceUnavailableMessage);
      return;
    }
    if (dictation?.active == true) return;
    await microphone.acquireForDictation();
    if (!mounted) return;
    final controller = dictation ??= DictationController(
      openSocket: dictationSocketOpenerV1(widget.api),
      capture: voiceCapture ??= RecordVoiceCapture(
        minimumBuffer: audioRoute.minimumCaptureBuffer,
      ),
      onDraft: _writeDictatedDraft,
      readDraft: _readDictatedDraft,
      onFinished: microphone.releaseDictation,
    )..addListener(_repaint);
    await controller.start(bot.botId.value);
    if (!mounted) return;
    final failure = controller.error;
    if (failure != null) _say(failure);
  }

  Future<void> _stopDictation() async {
    final controller = dictation;
    if (controller == null || !controller.active) return;
    await controller.stop();
    if (mounted) setState(() {});
  }

  Future<void> _discardDictation() async {
    final controller = dictation;
    if (controller == null || !controller.active) return;
    await controller.discard();
    if (mounted) setState(() {});
  }

  /// The draft of the Bot a capture is bound to, so the words land beside
  /// anything the person typed rather than over it.
  String _readDictatedDraft(Object context) =>
      widget.sessions.open(widget.userId, context as String).controller.draft;

  /// Writes the dictated draft into the Bot the capture started on, whichever
  /// Bot happens to be open by now.
  void _writeDictatedDraft(Object context, String text) {
    final session = widget.sessions.open(widget.userId, context as String);
    unawaited(session.controller.saveDraft(text));
    session.controller.changed();
  }

  void _say(String message) =>
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(message)));

  Future<void> _readWhatsNew() async {
    final feed = await readWhatsNewFeedV1(widget.api);
    final seen = await widget.store.read(whatsNewSeenKeyV1);
    final previous = await widget.store.read(whatsNewLaunchedVersionKeyV1);
    final current = (await widget.version()).label;
    if (!mounted) return;
    setState(() {
      whatsNew = feed;
      whatsNewSeenId = seen;
    });
    final unseen = feed.unseenCount(seen);
    final open = shouldOpenWhatsNewAfterLaunchV1(
      web: kIsWeb,
      previousVersion: previous,
      currentVersion: current,
      unseen: unseen,
    );
    if (current.isNotEmpty) {
      await widget.store.write(whatsNewLaunchedVersionKeyV1, current);
    }
    if (open && mounted) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _openWhatsNew();
      });
    }
  }

  void _openWhatsNew() {
    _push(
      WhatsNewPage(
        api: widget.api,
        origin: hostedOrigin,
        feed: whatsNew,
        seenId: whatsNewSeenId,
        onSeen: (id) async {
          await widget.store.write(whatsNewSeenKeyV1, id);
          if (mounted) setState(() => whatsNewSeenId = id);
        },
      ),
    );
  }

  /// The balance, read beside the identity and again whenever Billing may
  /// have changed it: a resume, a return from the Billing page. A read that
  /// fails keeps the last answer rather than flashing "no credit".
  Future<void> _readCredit() async {
    try {
      final answer = await widget.api.request('/api/billing');
      final next = AccountCredit.decode(answer);
      if (mounted && next != credit) setState(() => credit = next);
    } catch (_) {
      // The chat and Profile keep saying what they last knew.
    }
  }

  /// The Billing page, and a fresh balance when it is left.
  Future<void> _openBilling() async {
    push.reading(null);
    await Navigator.of(context).push(
      MaterialPageRoute<void>(builder: (_) => BillingPage(api: widget.api)),
    );
    await _readCredit();
  }

  /// Reads the directory, and completes when a read the caller asked for has
  /// finished: one that arrives mid-read waits for a fresh read behind it
  /// rather than returning on the read already in flight.
  Future<void> load() {
    final inFlight = _directoryLoad;
    if (inFlight == null) return _directoryLoad = _loadDirectory();
    return _queuedDirectoryLoad ??= inFlight.then((_) {
      _queuedDirectoryLoad = null;
      return _directoryLoad = _loadDirectory();
    });
  }

  Future<void> _loadDirectory() async {
    unawaited(_readCredit());
    try {
      final cacheKey = 'directory/${widget.userId}';
      final cached = await widget.store.read(cacheKey);
      if (cached != null && bots.isEmpty) {
        try {
          _adopt(
            wire.BotDirectory.fromJson(jsonDecode(cached)).bots,
            const {},
            fromCache: true,
          );
        } catch (_) {
          // The directory is a disposable projection. Drop an older wire
          // shape and continue to the authority instead of stranding the app
          // before its network read.
          await widget.store.delete(cacheKey);
        }
      }
      final directory = wire.BotDirectory.fromJson(
        await widget.api.request('/api/bots'),
      );
      final lifecycle = wire.BotLifecycleDirectory.fromJson(
        await widget.api.request('/api/bots/lifecycles'),
      );
      final general = await readGeneralBotIdV1(widget.api);
      final unavailable = {
        for (final state in lifecycle.lifecycles)
          if (state.status != 'active') state.botId.value: state.status,
      };
      final active = [
        for (final bot in directory.bots)
          if (unavailable[bot.botId.value] == null) bot,
      ];
      for (final prior in bots) {
        if (!active.any((bot) => bot.botId.value == prior.botId.value)) {
          widget.sessions.forget(widget.userId, prior.botId.value);
        }
      }
      try {
        await widget.store.write(
          cacheKey,
          jsonEncode({
            ...directory.toJson()! as Map,
            'bots': [for (final bot in active) bot.toJson()],
          }),
        );
      } catch (_) {
        // This cache only makes the next cold start faster. The directory the
        // authority just returned remains usable when browser storage is full
        // or unavailable.
      }
      if (!mounted) return;
      generalBotId = general;
      _adopt(
        active,
        {
          for (final entry in unavailable.entries)
            if (entry.value == 'archived') entry.key,
        },
        readable: [
          for (final bot in directory.bots)
            if (unavailable[bot.botId.value] == null ||
                unavailable[bot.botId.value] == 'archived')
              bot,
        ],
        authoritative: true,
      );
      unawaited(_loadIdentities());
      unawaited(activity.load());
      unawaited(
        widget.sessions.prefetch(widget.userId, [
          for (final bot in active) bot.botId.value,
        ], after: selected?.botId.value),
      );
    } catch (failure) {
      if (mounted) {
        setState(() {
          error = failure is RequestFailure
              ? failure.message
              : 'Couldn’t load your Bots. Please try again.';
        });
      }
    } finally {
      _directoryLoad = null;
      if (mounted) setState(() => loaded = true);
    }
  }

  /// [authoritative] is whether [archivedIds] came from the lifecycle read
  /// beside the directory. The cache holds `/api/bots` alone, so a Bot
  /// archived on another device is still in it with nothing saying so; the
  /// badge counts over archived state, and must wait for the read that has it.
  void _adopt(
    List<wire.BotRegistration> active,
    Set<String> archivedIds, {
    List<wire.BotRegistration>? readable,
    bool authoritative = false,
    bool fromCache = false,
  }) {
    setState(() {
      bots = active;
      searchableBots = readable ?? active;
      // The directory is authority on what a Bot wears; whatever it says now
      // replaces anything drawn ahead of it.
      _predictedAvatar.clear();
      archived = archivedIds;
      // The cached directory is an answer, so the skeleton goes now rather
      // than waiting on a read that only replaces it.
      loaded = true;
      directoryLoaded = directoryLoaded || authoritative;
      selected = selected == null
          ? null
          : active
                .where((bot) => bot.botId.value == selected!.botId.value)
                .firstOrNull;
      error = null;
    });
    final pendingBotId = widget.botLinks.value;
    if (pendingBotId != null) {
      if (!fromCache || bots.any((bot) => bot.botId.value == pendingBotId)) {
        _resolveBotLink();
      }
      return;
    }
    unawaited(_restoreSelection());
  }

  Future<void> _restoreSelection() async {
    if (selected != null || widget.botLinks.value != null) return;
    final saved = await widget.store.read('selection.${widget.userId}');
    if (!mounted || selected != null || widget.botLinks.value != null) return;
    if (saved == null) {
      _openGeneral();
      return;
    }
    final bot = bots.where((bot) => bot.botId.value == saved).firstOrNull;
    if (bot == null) return;
    clearManualForBot = bot.botId.value;
    setState(() => selected = bot);
    _adoptBotPanels(bot.botId.value);
  }

  /// A first sign-in lands in General rather than on a list of one. Only a
  /// device that has never chosen a Bot for this account gets this: a saved
  /// selection, a Bot link on its way in, or a page already over the shell is
  /// the person's place, and opening General over it would take that away.
  void _openGeneral() {
    final general = generalBotId;
    if (general == null ||
        selected != null ||
        widget.botLinks.value != null ||
        ModalRoute.of(context)?.isCurrent != true ||
        !bots.any((bot) => bot.botId.value == general)) {
      return;
    }
    _select(general);
  }

  /// A deployment with no identity directory leaves the sidebar one plain
  /// list, which is exactly what it looks like before anything is labelled.
  Future<void> _loadIdentities() async {
    try {
      final answer = await widget.api.request('/api/bots/identities');
      if (answer is! Map || !mounted) return;
      setState(() {
        profiles = {
          for (final entry in (answer['identities'] as List? ?? const []))
            if (entry is Map && entry['botId'] is String)
              entry['botId'] as String: SidebarProfile.decode(entry)!,
        };
      });
    } catch (_) {
      // The registration seed is still a name; nothing is lost but the label.
    }
  }

  /// What a Bot settings save can change outside the settings themselves. A
  /// save changes no Bot's lifecycle and no Bot's place in the directory; the
  /// profile moves the identities, and the notification setting decides
  /// whether the Bot counts on the application badge, which the unread
  /// fan-out reports.
  Future<void> _readBackBotSettings() async {
    await _loadIdentities();
    await activity.load();
    await load();
  }

  /// Draws a Bot profile change before the round trip that confirms it: the
  /// tile moves, the group changes, the name updates with the control instead
  /// of six requests later. [_loadIdentities] replaces this map wholesale, so
  /// the authority's answer reconciles the prediction by overwriting it, and
  /// a refused save hands back the profile it started from.
  void predictProfile(String botId, SidebarProfile profile) =>
      setState(() => profiles = {...profiles, botId: profile});

  String _name(wire.BotRegistration bot) =>
      profiles[bot.botId.value]?.name ?? bot.initialName;

  void _followBotLink() {
    final botId = widget.botLinks.value;
    if (botId == null) return;
    if (bots.every((bot) => bot.botId.value != botId)) {
      unawaited(load());
      return;
    }
    _resolveBotLink();
  }

  void _resolveBotLink() {
    final botId = widget.botLinks.value;
    if (botId == null) return;
    widget.botLinks.value = null;
    final bot = bots.where((bot) => bot.botId.value == botId).firstOrNull;
    if (bot == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text(
            'That Bot isn’t available. Refresh your Bots and try again.',
          ),
        ),
      );
      return;
    }
    Navigator.of(context).popUntil((route) => route.isFirst);
    _select(botId);
  }

  void _select(String botId) {
    clearManualForBot = botId;
    push.reading(null);
    final bot = bots.where((bot) => bot.botId.value == botId).firstOrNull;
    if (bot == null) return;
    final switching = selected?.botId.value != botId;
    // A capture belongs to the Bot it started on. Switching away commits it
    // there rather than carrying the words into the new Bot's composer.
    if (dictation?.active == true && dictation?.context != botId) {
      unawaited(_stopDictation());
    }
    // The switch is the person's; remembering it is bookkeeping and never
    // delays the pane behind a store write.
    setState(() {
      selected = bot;
      // A switch arrives from search, a link or a new Bot, never from the
      // Applet list, which offers no Bots. It is a way to a conversation, so
      // the sidebar goes back to the Bots rather than showing Applets of a Bot
      // nobody asked the Applets of.
      if (switching) appletsMode = false;
      conversationOpen = true;
      _leaveRun();
      exchangeController?.dispose();
      exchangeController = null;
      exchangeListenable = null;
      panelOpen = false;
      panelStack.clear();
      keptPanels.clear();
      panelPackage = null;
    });
    _adoptBotPanels(botId);
    unawaited(
      widget.store
          .write('selection.${widget.userId}', botId)
          .catchError((Object _) {}),
    );
  }

  void _featuresChanged([String? botId]) {
    unawaited(_loadAppearance());
    if (mounted && (botId == null || selected?.botId.value == botId)) {
      setState(() => featuresRevision += 1);
      unawaited(botSettings?.refreshPlugins() ?? Future<void>.value());
    }
  }

  /// The Bot's own settings and its Routines are features in the `right-panel`
  /// region, which is what that region is for: the shell draws the region and
  /// never imports what goes in it.
  void _adoptBotPanels(String botId) {
    final name =
        bots.where((bot) => bot.botId.value == botId).map(_name).firstOrNull ??
        botId;
    botSettings?.removeListener(_paintFromSettings);
    botSettings?.dispose();
    routineInbox?.dispose();
    routinesPanel?.removeListener(_repaint);
    routinesPanel?.dispose();
    _selectedChat?.removeListener(_selectedChatChanged);
    _selectedSession = widget.sessions.open(widget.userId, botId);
    _observedWorkingRunId = _selectedChat?.activeRunId;
    _observedConnection = _selectedChat?.connection;
    _observedBotComputerRunning = _botComputerRunning;
    _selectedChat?.addListener(_selectedChatChanged);
    final controller = BotSettingsController(widget.api, botId);
    final inbox = RoutineInboxController(widget.api, botId);
    final routines = RoutinesPanelHandle();
    botSettings = controller;
    controller.addListener(_paintFromSettings);
    routineInbox = inbox;
    inbox.addListener(_repaint);
    routinesPanel = routines;
    routines.addListener(_repaint);
    slots.register(
      ShellSlot.rightPanel,
      'bot-settings',
      (context) => _botSettings(botId, controller),
      label: 'Settings',
    );
    slots.register(
      ShellSlot.rightPanel,
      'routines',
      (context) => RoutinesView(
        api: widget.api,
        store: widget.store,
        userId: widget.userId,
        botId: botId,
        botName: name,
        chrome: false,
        panel: routines,
        onOpenRun: _openRun,
        onInbox: inbox.adopt,
      ),
      label: 'All Routines',
    );
    // What this Bot could run, and whether it does: Bot settings, so it sits
    // beside Routines and Settings rather than under the Profile.
    slots.register(
      ShellSlot.rightPanel,
      'plugins',
      // Keyed by Bot: the surface binds to the controller it was created
      // with, so a Bot switch must be a new page rather than a rebuilt one.
      (context) => PluginsPage(
        key: ValueKey('plugins-$botId'),
        onFeaturesChanged: () => _featuresChanged(botId),
        api: widget.api,
        store: widget.store,
        userId: widget.userId,
        botId: botId,
        botName: name,
        chrome: false,
      ),
      label: 'Plugins',
    );
    slots.register(
      ShellSlot.rightPanel,
      'voice',
      (context) => ListenableBuilder(
        listenable: avatarRevision,
        builder: (context, _) => BotVoicePage(
          controller: controller,
          characterId: _background(botId),
          primary: _primary(botId),
          chrome: false,
        ),
      ),
      label: 'Voice',
    );
    slots.register(
      ShellSlot.rightPanel,
      'look',
      (context) => ListenableBuilder(
        listenable: avatarRevision,
        builder: (context, _) => BotLookPage(
          controller: controller,
          characterId: _background(botId),
          primary: _primary(botId),
          chrome: false,
          onSaved: _readBackBotSettings,
        ),
      ),
      label: 'Look',
    );
    appletCanvas?.dispose();
    computer?.dispose();
    appletCanvas = null;
    computer = null;
    _setCatalog(null);
    slots.remove(ShellSlot.rightPanel, 'applet');
    unawaited(controller.load());
    unawaited(inbox.load());
    unawaited(
      prefetchViewDocumentCache(
        api: widget.api,
        store: widget.store,
        userId: widget.userId,
        surfaceId: 'routines',
        scope: botId,
        path: '/api/bots/${Uri.encodeComponent(botId)}/routines?as=document',
      ),
    );
    unawaited(
      prefetchViewDocumentCache(
        api: widget.api,
        store: widget.store,
        userId: widget.userId,
        surfaceId: 'bot-plugins',
        scope: botId,
        path: '/api/bots/${Uri.encodeComponent(botId)}/plugins?as=document',
      ),
    );
    unawaited(_adoptComposition(botId));
  }

  /// What this Bot's Composition declares it may show: the Applet canvas, the
  /// Computer, and the Package pages and entries. An absent capability is
  /// silence — no catalog means none of these are registered, and the shell
  /// asks for no route that does not exist here.
  Future<void> _adoptComposition(String botId) async {
    final read = await readPackageCatalogV1(widget.api, botId);
    if (!mounted || selected?.botId.value != botId) return;
    setState(() => _setCatalog(read));
    if (read != null && read.appletsAvailable) {
      final canvas = AppletCanvasController(widget.api, botId);
      appletCanvas = canvas;
      canvas.addListener(_repaint);
      // The Applet is a window of its own at every width, so it is not a
      // right-panel entry: a page with its own back and its own name, and the
      // Applet filling everything under that one row.
      unawaited(canvas.load());
    }
    final machine = ComputerController(widget.api, botId);
    computer = machine;
    // The Computer is not a panel entry: it is one destination, the desktop
    // full window, opened from the card and from the bar's own icon.
    machine.addListener(_repaint);
    unawaited(machine.read());
    if (mounted) setState(() {});
  }

  /// The Package doors worth drawing beside the native ones.
  ///
  /// The Applets Package declares an entry of its own called Applets. Where
  /// this client has the built-in Applets entry — the outlined window in the
  /// bar, the row on the Bot's page — that is the same door, so the Package's
  /// copy of it is left out and every other destination is kept.
  List<PackageEntryPage> _packageEntries() => [
    for (final entry in packageIframeEntriesV1(catalog))
      if (appletCanvas == null || entry.entry.label.toLowerCase() != 'applets')
        entry,
  ];

  /// The Composition this Bot is showing, and the one signal a pushed page
  /// watches for it.
  void _setCatalog(PackageCatalog? read) {
    catalog = read;
    catalogRevision.value++;
  }

  /// The icon set a Package may name. A Package naming one this client does
  /// not have falls back to the generic one rather than drawing nothing.
  IconData _packageIcon(String name) => switch (name) {
    'applets' => Icons.widgets_outlined,
    'plugins' => Icons.extension_outlined,
    'settings' => Icons.settings_outlined,
    'search' => Icons.search,
    _ => Icons.extension_outlined,
  };

  /// A Package page as a surface. Its chrome — the title and the way out —
  /// belongs to the shell; the page fills the body and is attributed to the
  /// Package that ships it, so a reader always knows whose screen this is.
  void _openPackagePage(PackageEntryPage entry) {
    final held = catalog;
    final bot = selected;
    if (held == null || bot == null) return;
    if (shellTierForWidth(MediaQuery.sizeOf(context).width) ==
        ShellTier.single) {
      _push(
        Scaffold(
          appBar: DesktopHeader(child: AppBar(title: Text(entry.entry.label))),
          body: SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
              child: _packagePage(entry, held, bot.botId.value),
            ),
          ),
        ),
      );
      return;
    }
    // A Package door is one of the Bot page's rows, so it opens where the
    // other rows do: inside the panel, over the page it was pressed on.
    setState(() => panelPackage = entry);
    _openPanel('package', push: true);
  }

  /// One Package page, framed and attributed, wherever it is drawn.
  Widget _packagePage(
    PackageEntryPage entry,
    PackageCatalog held,
    String botId,
  ) => identified(
    PackageIds.page(entry.contribution.packageId, entry.page.id),
    PackagePageFrame(
      api: widget.api,
      catalog: held,
      contribution: entry.contribution,
      page: entry.page,
      botId: botId,
      slot: entry.slot,
      layout: PackageFrameLayout.fill,
      surfaceTitle: entry.entry.label,
      states: {packageIframeAppletsStateV2: appletsBridgeStateV2(appletCanvas)},
      onFocus: (appletId) async {
        await appletCanvas?.setFocus(appletId);
        if (mounted) _openPanel('applet');
      },
    ),
  );

  /// The page takes over the frame pre-mounted behind the conversation.
  Widget _appletCanvas(
    String botId,
    AppletCanvasController canvas, {
    VoidCallback? onClose,
    bool holdsFrame = false,
  }) {
    final session = widget.sessions.open(widget.userId, botId);
    return AnimatedBuilder(
      animation: session.controller,
      builder: (context, _) => AppletCanvas(
        controller: canvas,
        lines: projectRuns(session.controller.runs),
        running: session.controller.activeRunId != null,
        onClose: onClose ?? () => setState(() => panelOpen = false),
        frameKey: holdsFrame ? _appletFrameKey : null,
      ),
    );
  }

  /// The Applet, full window, at every width.
  ///
  /// One row of chrome — back, the Applet's name, the switch to its code —
  /// and the Applet under it for the rest of the page. The page takes the
  /// pre-mounted frame over: the holder lets go in the same frame the page is
  /// built, so the key moves rather than doubles. It takes the frame back
  /// only once the page has finished leaving — a route on its way out is
  /// still in the tree and is not rebuilt, so a holder that reclaimed the key
  /// on the pop itself would double it.
  void _pushApplet() {
    final bot = selected;
    final canvas = appletCanvas;
    if (bot == null || canvas == null || _appletPagePresented) return;
    final route = MaterialPageRoute<void>(
      builder: (_) => Scaffold(
        body: SafeArea(
          child: _appletCanvas(
            bot.botId.value,
            canvas,
            onClose: () => Navigator.of(context).maybePop(),
            holdsFrame: true,
          ),
        ),
      ),
    );
    setState(() => _appletPagePresented = true);
    push.reading(null);
    unawaited(Navigator.of(context).push(route));
    unawaited(
      route.completed.then((_) {
        if (mounted) setState(() => _appletPagePresented = false);
      }),
    );
  }

  /// The live frame, pre-mounted off stage behind the conversation.
  ///
  /// Built as soon as the adopted Bot's canvas has a viewer and until the
  /// canvas page takes the frame over. Off stage it is laid out and never
  /// painted; the WebView behind it loads its page and opens its socket all
  /// the same, so the tap that opens the Applet finds it ready. Closing the
  /// page is the one direction that is not a move: a route sliding out keeps
  /// its subtree without rebuilding it, so the frame stays with the page
  /// until it is gone and a fresh one is held here afterwards, loading
  /// behind the conversation for the next open.
  Widget? _appletFrameHolder(BuildContext context) {
    final canvas = appletCanvas;
    final viewer = canvas?.viewer;
    if (canvas == null || viewer == null || _appletPagePresented) return null;
    final size = MediaQuery.sizeOf(context);
    return Positioned(
      left: 0,
      top: 0,
      width: size.width,
      height: size.height,
      child: Offstage(
        child: ExcludeSemantics(
          child: AppletViewerFrame(key: _appletFrameKey, viewer: viewer),
        ),
      ),
    );
  }

  ThemeData _accountThemeOf(BuildContext context) => FrockTheme.fromDocument(
    namedLookDocument(
      resolveAccountNamedLook(
        accountLook,
        MediaQuery.platformBrightnessOf(context),
      ),
    ),
    timezone: accountTimezone,
  );

  /// The look the thread should paint: the settings controller's, once it
  /// has loaded, so a choice on the Look page lands in the same frame.
  ({BotLook look, Object? document}) _resolvedLook(wire.BotRegistration bot) {
    final settings = botSettings;
    if (settings != null &&
        settings.botId == bot.botId.value &&
        settings.loaded) {
      final stored = settings.lookDocument;
      return (
        look: settings.look,
        document: stored == null ? null : encodeThemeDocument(stored),
      );
    }
    return (look: parseBotLook(bot.look), document: bot.document?.toJson());
  }

  ThemeData _botThemeOf(BuildContext context, wire.BotRegistration bot) {
    final resolved = _resolvedLook(bot);
    return FrockTheme.fromDocument(
      paintDocumentFor(
        look: resolved.look,
        document: resolved.document,
        account: accountLook,
        platform: MediaQuery.platformBrightnessOf(context),
      ),
      timezone: accountTimezone,
    );
  }

  bool _botHasOwnLook(wire.BotRegistration? bot) {
    if (bot == null) return false;
    final resolved = _resolvedLook(bot);
    return botHasOwnLook(look: resolved.look, document: resolved.document);
  }

  Widget _botLookScope({
    required String key,
    required ThemeData theme,
    required Widget child,
  }) => Theme(
    key: ValueKey(key),
    data: theme,
    child: ColoredBox(color: theme.scaffoldBackgroundColor, child: child),
  );

  Widget _maybeBotLookScope({
    required bool wrap,
    required String key,
    required ThemeData theme,
    required Widget child,
  }) => wrap ? _botLookScope(key: key, theme: theme, child: child) : child;

  /// Phone pages that stand in for the right panel pick up this Bot's look
  /// when it has one; otherwise they stay on the account Theme `_push` wraps.
  Widget _panelPage(Widget page) {
    final bot = selected;
    if (!_botHasOwnLook(bot)) return page;
    return _botLookScope(
      key: 'panel-theme-${bot!.botId.value}',
      theme: _botThemeOf(context, bot),
      child: page,
    );
  }

  Widget _withAccountTheme(BuildContext context, Widget child) =>
      Theme(data: _accountThemeOf(context), child: child);

  Future<void> _loadAppearance() async {
    final cacheKey = 'appearance/${widget.userId}';
    final cached = await widget.store.read(cacheKey);
    if (cached != null && mounted) {
      try {
        final value = jsonDecode(cached);
        if (value is Map) {
          setState(() {
            accountLook = parseAccountLook(value['look'] as String?);
            final timezone = value['timezone'];
            if (timezone is String && timezone.isNotEmpty) {
              accountTimezone = timezone;
            }
          });
        }
      } catch (_) {
        await widget.store.delete(cacheKey);
      }
    }
    try {
      final settings =
          (await widget.api.request('/api/settings?view=2'))! as Map;
      final look = parseAccountLook(
        (settings['appearance'] as Map?)?['look'] as String?,
      );
      final timezone =
          (settings['profile'] as Map?)?['timezone'] as String? ?? 'UTC';
      try {
        await widget.store.write(
          cacheKey,
          jsonEncode({'look': look.name, 'timezone': timezone}),
        );
      } catch (_) {
        // Appearance cache only speeds the next cold start.
      }
      if (!mounted) return;
      setState(() {
        accountLook = look;
        accountTimezone = timezone;
      });
    } catch (_) {
      // Ink is the product default; a cached look still paints.
    }
  }

  void _push(Widget page) {
    push.reading(null);
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (routeContext) => _withAccountTheme(routeContext, page),
      ),
    );
  }

  /// Back from a conversation on a phone: the list again, with nothing of the
  /// conversation's left open over it.
  void _openBack() {
    push.reading(null);
    setState(() {
      conversationOpen = false;
      _leaveRun();
      exchangeController?.dispose();
      exchangeController = null;
      exchangeListenable = null;
      panelOpen = false;
    });
  }

  /// The Work a subagent left behind, from voice mode's activity slot.
  void _openRun(TranscriptLine line) {
    if (shellTierForWidth(MediaQuery.sizeOf(context).width) ==
        ShellTier.single) {
      _push(RunPage(line: line));
      return;
    }
    setState(() {
      if (panelCollapsed) runBorrowedPanel = true;
      openRun = line;
      exchangeController?.dispose();
      exchangeController = null;
      exchangeListenable = null;
      panelOpen = true;
      // Opening a run is a request to see it: a collapsed panel column would
      // otherwise swallow the run view and leave the tap with no answer.
      panelCollapsed = false;
    });
  }

  /// Leaving the run on screen, by whichever way out: the column goes back
  /// the way the person left it if the run had borrowed it from them.
  void _leaveRun() {
    openRun = null;
    if (runBorrowedPanel) panelCollapsed = true;
    runBorrowedPanel = false;
  }

  /// The view-only chat behind an exchange marker: this Bot and the marker's
  /// counterpart, every exchange between them — the cloud's filtered pages
  /// for the history, the loaded thread for whatever is in flight.
  void _openExchange(TranscriptLine line) {
    final exchange = line.exchange;
    final bot = selected;
    if (exchange == null || bot == null) return;
    final counterpart = exchange.counterpart.isVoice
        ? const ExchangeCounterpart.voice()
        : ExchangeCounterpart.bot(
            botId: exchange.counterpart.botId,
            name:
                _botNameOf(exchange.counterpart.botId!) ??
                exchange.counterpart.name,
          );
    final controller = ExchangeController(
      transport: BackendExchangeTransport(widget.api),
      botId: bot.botId.value,
      counterpart: counterpart,
    );
    final chat = widget.sessions
        .open(widget.userId, bot.botId.value)
        .controller;
    unawaited(controller.load());
    if (shellTierForWidth(MediaQuery.sizeOf(context).width) ==
        ShellTier.single) {
      _push(
        _ExchangeScreen(
          controller: controller,
          self: _selfParty()!,
          counterpartBackground: _counterpartBackground(counterpart),
          counterpartPrimary: _counterpartPrimary(counterpart),
          chat: chat,
        ),
      );
      return;
    }
    exchangeController?.dispose();
    setState(() {
      if (panelCollapsed) runBorrowedPanel = true;
      openRun = null;
      exchangeController = controller;
      exchangeListenable = Listenable.merge([controller, chat]);
      panelOpen = true;
      // Same as a run: the tap asked to see the exchange, so a collapsed
      // column gives way to it and is handed back on the way out.
      panelCollapsed = false;
    });
  }

  ExchangeParty? _selfParty() {
    final bot = selected;
    if (bot == null) return null;
    return ExchangeParty(
      name: _name(bot),
      background: _background(bot.botId.value),
      primary: _primary(bot.botId.value),
    );
  }

  String? _counterpartBackground(ExchangeCounterpart counterpart) =>
      counterpart.botId == null ? null : _background(counterpart.botId!);

  String? _counterpartPrimary(ExchangeCounterpart counterpart) =>
      counterpart.botId == null ? null : _primary(counterpart.botId!);

  void _closeExchange() {
    exchangeController?.dispose();
    setState(() {
      exchangeController = null;
      exchangeListenable = null;
      if (runBorrowedPanel) panelCollapsed = true;
      runBorrowedPanel = false;
      panelOpen = false;
    });
  }

  Widget? _rightPanel() {
    final line = openRun;
    if (line != null) {
      return RunView(
        line: line,
        onClose: () => setState(() {
          _leaveRun();
          exchangeController?.dispose();
          exchangeController = null;
          exchangeListenable = null;
          panelOpen = false;
        }),
      );
    }
    final exchange = exchangeController;
    final self = _selfParty();
    final bot = selected;
    if (exchange != null && self != null && bot != null) {
      return ListenableBuilder(
        listenable: exchangeListenable ?? exchange,
        builder: (context, _) => ExchangeView(
          self: self,
          counterpart: exchange.counterpart,
          counterpartBackground: _counterpartBackground(exchange.counterpart),
          counterpartPrimary: _counterpartPrimary(exchange.counterpart),
          exchanges: exchange.exchanges(
            widget.sessions
                .open(widget.userId, bot.botId.value)
                .controller
                .runs,
          ),
          hasEarlier: exchange.before != null,
          loading: exchange.loading,
          error: exchange.error,
          onOlder: () => unawaited(exchange.load(older: true)),
          onClose: _closeExchange,
        ),
      );
    }
    if (bot == null) return null;
    final key = panelStack.isEmpty ? null : panelStack.last;
    final shown = key ?? 'bot-page';
    final body = HotPanelStack(
      shown: shown,
      kept: keptPanels.toList(),
      builder: (door) =>
          _panelChild(bot, door == 'bot-page' ? null : door) ??
          const SizedBox.shrink(),
    );
    return identified(
      ShellIds.slot(ShellSlot.rightPanel.id),
      Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _panelHeader(bot, key),
          const Divider(height: 1),
          Expanded(child: body),
        ],
      ),
    );
  }

  Widget? _panelChild(wire.BotRegistration bot, String? key) {
    if (key == null) return _botPageView(bot);
    if (key == 'package') return _packagePanel(bot);
    return slots.buildOne(context, ShellSlot.rightPanel, key);
  }

  void _keepPanel(String key) {
    if (hotPanelDoors.contains(key)) keptPanels.add(key);
  }

  /// The panel's own bar: the Bot's face and the gear at the root, a back
  /// chevron and the sub-page's name over it. The close is always the last
  /// thing in it, and closing empties the stack — reopening the panel is
  /// opening the Bot page, never whatever was last read three Bots ago.
  Widget _panelHeader(wire.BotRegistration bot, String? key) {
    return Builder(
      builder: (context) {
        final theme = Theme.of(context);
        final botId = bot.botId.value;
        final backId = panelBackIdentifierV1(
          panelKey: key,
          routinesEditorOpen:
              key == 'routines' && routinesPanel?.tryLeaveEditor != null,
        );
        return SizedBox(
          height: 52,
          child: Padding(
            padding: EdgeInsets.fromLTRB(key == null ? 16 : 8, 0, 8, 0),
            child: Row(
              children: [
                if (key == null) ...[
                  CharacterAvatar(
                    size: 28,
                    characterId: _background(botId),
                    primary: _primary(botId),
                    motion: CharacterMotion.quiet,
                  ),
                  const SizedBox(width: 10),
                ] else
                  KeyedSubtree(
                    // Flutter Web keeps the first identifier a Semantics
                    // node published. Remount when the press changes meaning
                    // so the editor's id is what a spec actually sees.
                    key: ValueKey(backId),
                    child: identified(
                      backId,
                      IconButton(
                        tooltip: 'Back',
                        onPressed: () => unawaited(_popPanel()),
                        style: _panelControl(theme),
                        icon: const Icon(Icons.chevron_left_rounded),
                      ),
                    ),
                  ),
                Expanded(
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      // A heading of its own, rather than a leaf the engine merges
                      // into the row beside it: what the panel is showing is the
                      // one thing a reader needs read out first.
                      Semantics(
                        header: true,
                        child: Text(
                          key == null
                              ? _name(bot)
                              : _panelTitle(key) ?? _name(bot),
                          style: theme.textTheme.titleSmall?.copyWith(
                            fontSize: 14,
                            fontWeight: FontWeight.w600,
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                    ],
                  ),
                ),
                if (key == null)
                  identified(
                    SettingsIds.botPageSettings,
                    IconButton(
                      tooltip: 'Bot settings',
                      onPressed: () => _openPanel('bot-settings', push: true),
                      style: _panelControl(theme),
                      icon: const Icon(Icons.settings_outlined),
                    ),
                  ),
                identified(
                  ShellIds.rightPanelClose,
                  IconButton(
                    tooltip: 'Close the panel',
                    onPressed: () => setState(() {
                      panelOpen = false;
                      panelCollapsed = true;
                      panelStack.clear();
                      panelPackage = null;
                    }),
                    style: _panelControl(theme),
                    icon: const Icon(Icons.close_rounded),
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  ButtonStyle _panelControl(ThemeData theme) => IconButton.styleFrom(
    foregroundColor: theme.colorScheme.onSurfaceVariant,
    iconSize: 18,
    minimumSize: const Size(32, 32),
    fixedSize: const Size(32, 32),
    padding: EdgeInsets.zero,
    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
  );

  /// What the panel calls the sub-page it is showing.
  String? _panelTitle(String key) {
    if (key == 'routines' && routinesPanel?.editorTitle != null) {
      return routinesPanel!.editorTitle;
    }
    return key == 'package'
        ? panelPackage?.entry.label
        : slots.labelOf(ShellSlot.rightPanel, key);
  }

  Future<void> _popPanel() async {
    if (panelStack.isNotEmpty &&
        panelStack.last == 'routines' &&
        routinesPanel?.tryLeaveEditor != null) {
      if (!await routinesPanel!.tryLeaveEditor!()) return;
      return;
    }
    if (!mounted) return;
    setState(() {
      panelStack.removeLast();
      _keepPanel(panelStack.isEmpty ? 'bot-page' : panelStack.last);
    });
  }

  Widget? _packagePanel(wire.BotRegistration bot) {
    final entry = panelPackage;
    final held = catalog;
    if (entry == null || held == null) return null;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
      child: _packagePage(entry, held, bot.botId.value),
    );
  }

  /// The Bot page itself, wherever it is drawn: the panel's root, and the
  /// page a phone pushes from the name in its bar.
  ///
  /// Everything it reads lives on the shell, and a pushed page is outside the
  /// shell's own `setState` — so the listenables it watches are what make the
  /// Computer arriving, an Applet being built or a Composition mounting show
  /// up on a page that is already open.
  Widget _botPageView(wire.BotRegistration bot) {
    final botId = bot.botId.value;
    return ListenableBuilder(
      listenable: Listenable.merge([slots, catalogRevision, avatarRevision]),
      builder: (context, _) => BotPageView(
        botName: _name(bot),
        computer: computer,
        turnRunning: _workingRunId != null,
        onOpenComputer: computer?.available == true
            ? () => unawaited(_openComputerViewer())
            : null,
        inbox: routineInbox,
        onOpenRun: (run) => _openRoutineRun(botId, run),
        onOpenRoutines: () => _openPanel('routines', push: true),
        applets: appletCanvas,
        onOpenApplet: (appletId) => unawaited(_openApplet(appletId)),
        onOpenApplets: _openApplets,
        doors: [
          for (final entry in _packageEntries())
            BotPageDoor(
              identifier: PackageIds.entry(
                entry.contribution.packageId,
                entry.entry.id,
              ),
              icon: _packageIcon(entry.entry.icon),
              label: entry.entry.label,
              onTap: () => _openPackagePage(entry),
            ),
        ],
      ),
    );
  }

  /// One firing's run log, from the row on the Bot page. It is the same page
  /// the Routines surface's "Run log" opens, because it is the same log.
  void _openRoutineRun(String botId, RoutineRunSummary run) => _push(
    RoutineRunsPage(
      api: widget.api,
      botId: botId,
      routineId: run.routineId,
      onOpenRun: _openRun,
    ),
  );

  /// Settings, wherever it is drawn: the panel's sub-page, and the page the
  /// gear pushes on a phone.
  Widget _botSettings(String botId, BotSettingsController controller) =>
      ListenableBuilder(
        listenable: Listenable.merge([catalogRevision, avatarRevision]),
        builder: (context, _) {
          final name = _botNameOf(botId) ?? botId;
          return SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 32),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                BotSettingsView(
                  controller: controller,
                  onSaved: _readBackBotSettings,
                  onPredict: (profile) => predictProfile(botId, profile),
                  background: _background(botId),
                  primary: _primary(botId),
                  onEditAvatar: () => unawaited(_editAvatar(botId, name)),
                  onOpenPlugins: () => _openPanel('plugins', push: true),
                  onOpenVoice: () => _openPanel('voice', push: true),
                  onOpenLook: () => _openPanel('look', push: true),
                  dangerZone: _dangerZone(botId, name),
                  sections: _packageSettings(botId),
                ),
              ],
            ),
          );
        },
      );

  /// The desktop, full window: the one Computer destination this shell has.
  ///
  /// The bar's icon, the Bot page's card and the search hit all arrive here,
  /// at the same window on the same session, with Take control inside it.
  Future<void> _openComputerViewer() async {
    final machine = computer;
    if (machine == null || !machine.available) return;
    final name = selected == null ? null : _name(selected!);
    await openComputerViewerV1(context, machine, botName: name);
  }

  /// Opens one right-panel entry. On the phone the panel is a page: a drawer
  /// over a full-width conversation is the same thing with less room and a
  /// scrim in the way.
  void _openPanel(String key, {bool push = false}) {
    // The Applet is never a panel: it is a full window at every width.
    if (key == 'applet') {
      _pushApplet();
      return;
    }
    if (shellTierForWidth(MediaQuery.sizeOf(context).width) ==
        ShellTier.single) {
      _pushPanel(key);
      return;
    }
    setState(() {
      openRun = null;
      runBorrowedPanel = false;
      exchangeController?.dispose();
      exchangeController = null;
      exchangeListenable = null;
      // A door pressed inside the panel pushes; one pressed from outside it —
      // the header, the search palette — is a fresh place to be, so the stack
      // under it is thrown away first.
      if (!push) panelStack.clear();
      if (key == 'bot-page') {
        panelStack.clear();
      } else if (panelStack.isEmpty || panelStack.last != key) {
        panelStack.add(key);
      }
      _keepPanel('bot-page');
      _keepPanel(key);
      panelOpen = true;
      panelCollapsed = false;
    });
  }

  /// The header's one switch for the panel beside the conversation: the
  /// column at the widest tier, the drawer below it.
  void _togglePanel() {
    final triple =
        shellTierForWidth(MediaQuery.sizeOf(context).width) == ShellTier.triple;
    setState(() {
      runBorrowedPanel = false;
      if (triple) {
        panelCollapsed = !panelCollapsed;
      } else {
        panelOpen = !panelOpen;
      }
      if ((triple && !panelCollapsed) || (!triple && panelOpen)) {
        _keepPanel(panelStack.isEmpty ? 'bot-page' : panelStack.last);
      }
    });
  }

  Future<void> _messageActions(TranscriptLine line, {Offset? position}) async {
    final bot = selected;
    if (bot == null) return;
    final copyText = [
      if (line.text.isNotEmpty) line.text,
      for (final send in line.sends)
        if (send.type == 'text' && send.payload?['text'] is String)
          send.payload!['text'] as String,
    ].join('\n\n');
    final action = await showMessageActions(
      context: context,
      position: position,
      canCopy: copyText.isNotEmpty,
      canMarkUnread:
          line.id.endsWith(':user') ||
          line.id.endsWith(':failed') ||
          line.id.contains(':send:'),
      hasUnread: activity.unread[bot.botId.value]?.unread == true,
      readActionsEnabled: !activity.busy(bot.botId.value) && !activity.loading,
    );
    if (!mounted || selected?.botId.value != bot.botId.value) return;
    if (action == 'work') {
      final lines = projectRuns(
        widget.sessions.open(widget.userId, bot.botId.value).controller.runs,
      );
      _openRun(
        lines.where((item) => item.runId == line.runId).lastOrNull ?? line,
      );
    }
    if (action == 'copy') {
      await Clipboard.setData(ClipboardData(text: copyText));
    }
    if (action == 'unread' || action == 'read') {
      await activity.mark(
        bot.botId.value,
        read: action == 'read',
        fromMessageId: action == 'unread' ? line.id : null,
      );
      if (mounted && activity.error != null) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(activity.error!)));
      }
    }
  }

  /// What the row knows about its Bot, read through the same focus rule as
  /// its badge so the sheet never offers to mark read a Bot the row shows
  /// as read.
  BotActionState _botActionState(String botId) {
    final view = activity.unread[botId];
    final profile = profiles[botId];
    return BotActionState(
      unread: sidebarUnreadFor(view, focused: botId == _focusedBotId).unread,
      pinned: (profile?.pinnedAt ?? '').trim().isNotEmpty,
      muted: view?.notificationsEnabled == false,
      hidden: profile?.hiddenFromSidebar == true,
      archived: archived.contains(botId),
      hasActivity: view?.lastActivityCursor != null,
    );
  }

  Future<void> _botActions(String botId, {Offset? position}) async {
    final action = await showBotActions(
      context: context,
      botName: _botNameOf(botId) ?? botId,
      actions: botActionsFor(_botActionState(botId)),
      position: position,
    );
    if (action == null || !mounted) return;
    await _runBotAction(botId, action);
  }

  /// One action on one Bot, from its row. Profile changes are drawn first
  /// and taken back if refused; the rest report through the surface that
  /// owns them.
  Future<void> _runBotAction(String botId, BotAction action) async {
    final name = _botNameOf(botId) ?? botId;
    switch (action) {
      case BotAction.markRead:
      case BotAction.markUnread:
        await activity.mark(botId, read: action == BotAction.markRead);
        if (mounted && activity.error != null) _say(activity.error!);
      case BotAction.pin:
        await _patchProfile(botId, {
          'pinnedAt': DateTime.now().toUtc().toIso8601String(),
        });
      case BotAction.unpin:
        await _patchProfile(botId, {'pinnedAt': ''});
      case BotAction.hide:
        // Hiding mutes, by the authority's own coupling; undoing the hide
        // puts the notifications back too, or "Undo" would leave the Bot
        // silent in a way the person never asked for.
        final notifying = activity.unread[botId]?.notificationsEnabled != false;
        if (!await _patchProfile(botId, {'hiddenFromSidebar': true})) return;
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('$name hidden'),
            action: SnackBarAction(
              label: 'Undo',
              onPressed: () => unawaited(() async {
                if (!await _patchProfile(botId, {'hiddenFromSidebar': false})) {
                  return;
                }
                if (notifying) await _setNotifications(botId, enabled: true);
              }()),
            ),
          ),
        );
      case BotAction.show:
        await _patchProfile(botId, {'hiddenFromSidebar': false});
      case BotAction.label:
        final label = await showBotLabelPicker(
          context: context,
          botName: name,
          current: profiles[botId]?.label?.trim() ?? '',
          existing: [for (final profile in profiles.values) ?profile.label],
        );
        if (label == null || !mounted) return;
        await _patchProfile(botId, {'label': label});
      case BotAction.mute:
        await _setNotifications(botId, enabled: false);
      case BotAction.unmute:
        await _setNotifications(botId, enabled: true);
      case BotAction.archive:
      case BotAction.restore:
        final applied = await confirmBotLifecycleChange(
          context: context,
          lifecycle: lifecycle,
          botId: botId,
          botName: name,
          type: action == BotAction.archive ? 'bot/archive' : 'bot/restore',
          nameOf: _botNameOf,
        );
        if (!mounted) return;
        if (lifecycle.error ?? lifecycle.message case final String notice) {
          _say(notice);
        }
        if (applied) await load();
    }
  }

  /// Writes one profile field, drawn before the round trip and put back on a
  /// refusal. The open Bot's settings page holds its own copy of the profile
  /// and saves the whole of it, so that copy is read again rather than left
  /// to overwrite this change with what it remembers.
  Future<bool> _patchProfile(String botId, Map<String, Object?> patch) async {
    final before = profiles[botId] ?? const SidebarProfile();
    predictProfile(botId, before.patched(patch));
    final failure = await quickWrites.setProfile(botId, patch);
    if (!mounted) return false;
    if (failure != null) {
      predictProfile(botId, before);
      _say(failure);
      return false;
    }
    await _readBackBotSettings();
    if (selected?.botId.value == botId) await botSettings?.load();
    return true;
  }

  /// A row let go somewhere else in the list. The rows are drawn where they
  /// landed at once and each write goes to the Bot it belongs to; the first
  /// refusal puts the whole list back to what the authority last said, since
  /// a half-applied reorder is not a state anyone asked for.
  Future<void> _moveBot(SidebarDrop drop) async {
    final writes = planSidebarDropV1(drop, profiles);
    if (writes.isEmpty) return;
    final before = profiles;
    setState(() {
      profiles = {
        ...profiles,
        for (final write in writes)
          write.botId: (profiles[write.botId] ?? const SidebarProfile())
              .patched(write.patch),
      };
    });
    for (final write in writes) {
      final failure = await quickWrites.setProfile(write.botId, write.patch);
      if (!mounted) return;
      if (failure != null) {
        setState(() => profiles = before);
        _say(failure);
        await _loadIdentities();
        return;
      }
    }
    await _readBackBotSettings();
    if (selected case final bot?
        when writes.any((write) => write.botId == bot.botId.value)) {
      await botSettings?.load();
    }
  }

  Future<void> _setNotifications(String botId, {required bool enabled}) async {
    final failure = await quickWrites.setNotifications(botId, enabled: enabled);
    if (!mounted) return;
    if (failure != null) {
      _say(failure);
      return;
    }
    await activity.load();
    if (selected?.botId.value == botId) await botSettings?.load();
  }

  String? _botNameOf(String botId) =>
      bots.where((bot) => bot.botId.value == botId).map(_name).firstOrNull;

  /// The selected Bot's Applets, from the All Applets row on the Bot page:
  /// the sidebar's Applets mode beside the conversation, and a page on a
  /// phone. A row opens its Applet over whichever it is.
  void _openApplets() {
    final bot = selected;
    final canvas = appletCanvas;
    if (bot == null || canvas == null) return;
    if (shellTierForWidth(MediaQuery.sizeOf(context).width) ==
        ShellTier.single) {
      _push(
        Scaffold(
          appBar: DesktopHeader(child: AppBar()),
          body: SafeArea(
            top: false,
            child: AppletList(
              controller: canvas,
              botName: _name(bot),
              nameOf: _botNameOf,
              onOpen: (appletId) => unawaited(_openApplet(appletId)),
            ),
          ),
        ),
      );
      return;
    }
    // The Bot page may be over the shell when the window is wide enough for a
    // sidebar; the mode is drawn in the shell, so that is where this returns.
    Navigator.of(context).popUntil((route) => route.isFirst);
    setState(() => appletsMode = true);
  }

  Future<void> _openApplet(String appletId) async {
    final canvas = appletCanvas;
    if (canvas == null) return;
    // The panel opens onto the chosen Applet now, rather than after the write
    // that records the focus and the read that follows it.
    canvas.predictFocus(appletId);
    _openPanel('applet');
    await canvas.setFocus(appletId);
    // A focus read may finish after the person switches Bots.
    if (!mounted || canvas != appletCanvas) return;
    if (canvas.focusedId != appletId) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Couldn’t open this Applet. Try again.')),
      );
    }
  }

  /// The same doors, as a phone's pages.
  ///
  /// The panel's stack and a phone's route stack are the same idea drawn twice:
  /// the Bot page is the floor, and every key below pushes over it.
  void _pushPanel(String key) {
    final bot = selected;
    final controller = botSettings;
    if (bot == null) return;
    if (key == 'plugins') {
      _push(
        _panelPage(
          PluginsPage(
            onFeaturesChanged: () => _featuresChanged(bot.botId.value),
            api: widget.api,
            store: widget.store,
            userId: widget.userId,
            botId: bot.botId.value,
            botName: _name(bot),
          ),
        ),
      );
      return;
    }
    if (key == 'routines') {
      _push(
        _panelPage(
          RoutinesView(
            api: widget.api,
            store: widget.store,
            userId: widget.userId,
            botId: bot.botId.value,
            botName: _name(bot),
            onOpenRun: _openRun,
            onInbox: routineInbox?.adopt,
          ),
        ),
      );
      return;
    }
    if (key == 'applet') {
      _pushApplet();
      return;
    }
    if (controller == null) return;
    if (key == 'voice') {
      _push(
        _panelPage(
          BotVoicePage(
            controller: controller,
            characterId: _background(bot.botId.value),
            primary: _primary(bot.botId.value),
          ),
        ),
      );
      return;
    }
    if (key == 'look') {
      _push(
        _panelPage(
          BotLookPage(
            controller: controller,
            characterId: _background(bot.botId.value),
            primary: _primary(bot.botId.value),
            onSaved: _readBackBotSettings,
          ),
        ),
      );
      return;
    }
    if (key == 'bot-settings') {
      _push(
        _panelPage(
          Scaffold(
            appBar: DesktopHeader(child: AppBar(title: const Text('Settings'))),
            body: SafeArea(
              top: false,
              child: _botSettings(bot.botId.value, controller),
            ),
          ),
        ),
      );
      return;
    }
    _push(_panelPage(_botPage(bot)));
  }

  /// The Bot's page on a phone: its name and its face in the bar, the gear in
  /// the corner, and the same scroll the panel's root draws.
  Widget _botPage(wire.BotRegistration bot) {
    final botId = bot.botId.value;
    return Scaffold(
      appBar: DesktopHeader(
        child: AppBar(
          titleSpacing: 0,
          title: ListenableBuilder(
            listenable: avatarRevision,
            builder: (context, _) => Row(
              children: [
                CharacterAvatar(
                  size: 28,
                  characterId: _background(botId),
                  primary: _primary(botId),
                  motion: CharacterMotion.quiet,
                ),
                const SizedBox(width: 10),
                Flexible(
                  child: Text(
                    _name(bot),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ],
            ),
          ),
          actions: [
            identified(
              SettingsIds.botPageSettings,
              IconButton(
                tooltip: 'Bot settings',
                onPressed: () => _pushPanel('bot-settings'),
                icon: const Icon(Icons.settings_outlined),
              ),
            ),
            const SizedBox(width: 4),
          ],
        ),
      ),
      body: SafeArea(top: false, child: _botPageView(bot)),
    );
  }

  /// The Package pages mounted in Bot settings, drawn under the Bot's own
  /// sections.
  List<Widget> _packageSettings(String botId) {
    final held = catalog;
    if (held == null) return const [];
    return [
      for (final mounted in packageIframePagesForSlotV1(
        held,
        packageBotSettingsSlotV1,
      ))
        Padding(
          padding: const EdgeInsets.only(top: 16),
          child: identified(
            PackageIds.page(mounted.contribution.packageId, mounted.page.id),
            PackagePageFrame(
              api: widget.api,
              catalog: held,
              contribution: mounted.contribution,
              page: mounted.page,
              botId: botId,
              slot: packageBotSettingsSlotV1,
            ),
          ),
        ),
    ];
  }

  /// Colours chosen here that the directory has not reported back yet. The
  /// Flock owns what a Bot looks like, and the client picked the recipe it
  /// sent, so drawing it now is showing what was chosen rather than guessing.
  final Map<String, AvatarSelection> _predictedAvatar = {};

  /// The avatar a Bot wears, from the registration the directory carries — or
  /// the colour just chosen for it, until the read that confirms it lands.
  String? _background(String botId) =>
      _predictedAvatar[botId]?.characterId ??
      bots
          .where((bot) => bot.botId.value == botId)
          .map((bot) => bot.avatar.characterId)
          .firstOrNull;

  String? _primary(String botId) =>
      _predictedAvatar[botId]?.primary ??
      bots
          .where((bot) => bot.botId.value == botId)
          .map((bot) => bot.avatar.primary)
          .firstOrNull;

  Future<void> _editAvatar(String botId, String botName) async {
    final chosen = await AvatarPickerSheet.show(
      context,
      api: widget.api,
      botId: botId,
      botName: botName,
      background: _background(botId),
      primary: _primary(botId),
    );
    if (chosen == null || !mounted) return;
    setState(() => _predictedAvatar[botId] = chosen);
    avatarRevision.value++;
    await load();
    if (mounted) avatarRevision.value++;
  }

  Widget _dangerZone(String botId, String botName) => BotDangerZone(
    lifecycle: lifecycle,
    botId: botId,
    botName: botName,
    archived: archived.contains(botId),
    nameOf: _botNameOf,
    onChanged: load,
    onDeleted: () => unawaited(_closeDeletedBot(botId)),
  );

  /// A delete the authority applied. Everything open about that Bot closes at
  /// every tier — the column, the drawer, the pushed page, the conversation —
  /// but only while it is still the Bot open: a person who moved to another
  /// Bot while the delete was out keeps the one they chose.
  Future<void> _closeDeletedBot(String botId) async {
    if (!mounted) return;
    final open = selected?.botId.value;
    if (open != null && open != botId) return;
    if (open == botId) _closeOpenBot();
    // A switch made after this point writes its own selection, so only a
    // saved selection still naming the deleted Bot is cleared.
    final key = 'selection.${widget.userId}';
    try {
      if (await widget.store.read(key) == botId && selected == null) {
        await widget.store.delete(key);
      }
    } catch (_) {
      // A stale selection only fails to restore: the Bot is not listed.
    }
  }

  /// Closes the open Bot's pages, panels and controllers, leaving no Bot open.
  void _closeOpenBot() {
    Navigator.of(context).popUntil((route) => route.isFirst);
    panelStack.clear();
    keptPanels.clear();
    panelPackage = null;
    slots.remove(ShellSlot.rightPanel, 'bot-settings');
    slots.remove(ShellSlot.rightPanel, 'routines');
    slots.remove(ShellSlot.rightPanel, 'plugins');
    slots.remove(ShellSlot.rightPanel, 'voice');
    slots.remove(ShellSlot.rightPanel, 'look');
    slots.remove(ShellSlot.rightPanel, 'applet');
    botSettings?.removeListener(_paintFromSettings);
    botSettings?.dispose();
    routineInbox?.dispose();
    routinesPanel?.removeListener(_repaint);
    routinesPanel?.dispose();
    appletCanvas?.dispose();
    computer?.dispose();
    _selectedChat?.removeListener(_selectedChatChanged);
    botSettings = null;
    routineInbox = null;
    routinesPanel = null;
    appletCanvas = null;
    computer = null;
    _selectedSession = null;
    _observedWorkingRunId = null;
    _observedConnection = null;
    _observedBotComputerRunning = false;
    setState(() {
      selected = null;
      openRun = null;
      runBorrowedPanel = false;
      exchangeController?.dispose();
      exchangeController = null;
      exchangeListenable = null;
      conversationOpen = false;
      panelOpen = false;
      panelCollapsed = true;
      _setCatalog(null);
    });
  }

  /// Adding a Bot: the sheet, then the Bot, then the first thing said to it.
  ///
  /// The message is sent through the same session the conversation uses, so a
  /// new Bot's first Turn is admitted exactly as every other one is.
  Future<void> _createBot() async {
    final controller = CreateBotController(
      widget.api,
      widget.store,
      widget.userId,
    );
    final made = await CreateBotSheet.show(context, controller);
    controller.dispose();
    if (made == null || !mounted) return;
    await load();
    if (!mounted) return;
    _select(made.botId);
    if (made.firstMessage.isEmpty) return;
    final session = widget.sessions.open(widget.userId, made.botId);
    await session.start();
    await session.controller.send(made.firstMessage);
  }

  @override
  Widget build(BuildContext context) {
    final tier = shellTierForWidth(MediaQuery.sizeOf(context).width);
    final single = tier == ShellTier.single;
    final bot = selected;
    final accountTheme = _accountThemeOf(context);
    final ownLook = _botHasOwnLook(bot);
    final botTheme = ownLook ? _botThemeOf(context, bot!) : accountTheme;
    final session = voiceSession;
    // This Bot is the one on the call: the header wears the pair, the
    // composer control goes primary, and the dock stays off. A call with
    // another Bot keeps the small dock, so looking at one Bot while talking
    // to another still works.
    final liveSession =
        footerOpen && bot != null && voiceBotId == bot.botId.value
        ? session
        : null;
    final voiceHere = liveSession != null;
    final rightPanel = _rightPanel();
    ChatHeader conversationHeader({Widget? companion}) => ChatHeader(
      name: _name(bot!),
      companion: voiceHere ? null : companion,
      voiceChrome: liveSession == null
          ? null
          : VoiceCallChrome(
              session: liveSession,
              userInitials: widget.userId,
              botName: _name(bot),
              characterId: bot.avatar.characterId,
              primary: bot.avatar.primary,
              onEnd: () => unawaited(_endVoice(reason: 'end-button')),
            ),
      connection: _selectedConnection,
      textScale: MediaQuery.textScalerOf(context).scale(14) / 14,
      // A phone's bar is Back and the panel switch. A desk opens the Bot
      // page and the Computer from the column beside the thread, so the
      // overlay keeps only the switch that shows or hides that column.
      // Back still leaves the page: the call stays up in the header, or
      // the dock on another Bot.
      onBack: single ? _openBack : null,
      phone: single,
      onOpenBot: null,
      computerRunning:
          computer?.available == true &&
          (computer!.state.running || _botComputerRunning),
      onComputer: null,
      onTogglePanel: single
          ? () => _openPanel('bot-page')
          : rightPanel == null
          ? null
          : _togglePanel,
      panelShown: tier == ShellTier.triple ? !panelCollapsed : panelOpen,
    );

    // Every input the badge reads — the fan-out, the directory, and focus —
    // repaints the shell, so the icon is reconciled on the same build that
    // redraws the sidebar.
    appBadge.reconcile(
      appBadgeFor(
        unread: activity.unread,
        botIds: [for (final registration in bots) registration.botId.value],
        archived: archived,
        focusedBotId: _focusedBotId,
      ),
      authoritative: activity.loaded && directoryLoaded,
    );
    final shell = ShellSlotScope(
      slots: slots,
      // The footer is drawn below the whole three-tier layout, so it survives
      // a Bot switch, a page and a drawer, and the app above it stays usable.
      // It is trust chrome, not a slot: a plugin can neither remove it nor
      // put anything beside it.
      child: Column(
        children: [
          Expanded(
            // While the footer is up it covers the bottom inset itself, so the
            // layout above it is told there is none: otherwise the composer
            // would keep a gesture bar's worth of space above the footer.
            child: MediaQuery.removePadding(
              context: context,
              removeBottom: !voiceHere && (footerOpen || footerExiting),
              child: Stack(
                fit: StackFit.expand,
                children: [
                  ShellLayout(
                    header: null,
                    conversationOpen: bot != null && conversationOpen,
                    onBack: _openBack,
                    panelOpen: panelOpen,
                    panelCollapsed: panelCollapsed,
                    onDismiss: () => setState(() => panelOpen = false),
                    rightPanel: rightPanel,
                    panelTheme: ownLook ? botTheme : null,
                    sidebar:
                        appletsMode &&
                            !single &&
                            bot != null &&
                            appletCanvas != null
                        ? AppletList(
                            controller: appletCanvas!,
                            botName: _name(bot),
                            nameOf: _botNameOf,
                            onOpen: (appletId) =>
                                unawaited(_openApplet(appletId)),
                            onBack: () => setState(() => appletsMode = false),
                          )
                        : ShellSidebar(
                            bots: bots,
                            profiles: profiles,
                            unread: activity.unread,
                            archived: archived,
                            // The count for the Bot being read is suppressed
                            // here rather than waited out: the receipt that
                            // clears it is a round trip behind the message.
                            focusedBotId: _focusedBotId,
                            // A phone's list is a list of doors, not a selection: no row
                            // is the current one once the conversation is a page.
                            activeBotId: single ? null : bot?.botId.value,
                            workingBotId: _workingRunId == null
                                ? null
                                : bot?.botId.value,
                            loaded: loaded,
                            error: error,
                            showHidden: showHidden,
                            onSelect: _select,
                            onCreateBot: () => unawaited(_createBot()),
                            onSearch: _openSearch,
                            onProfile: _openProfile,
                            onMarketplace: _openMarketplace,
                            phone: single,
                            onToggleHidden: () =>
                                setState(() => showHidden = !showHidden),
                            onRetry: load,
                            onMove: (drop) => unawaited(_moveBot(drop)),
                            onActions: (botId, {position}) => unawaited(
                              _botActions(botId, position: position),
                            ),
                            onSwipeRead: (botId) => unawaited(
                              _runBotAction(
                                botId,
                                _botActionState(botId).unread
                                    ? BotAction.markRead
                                    : BotAction.markUnread,
                              ),
                            ),
                            onSwipeHide: (botId) =>
                                unawaited(_runBotAction(botId, BotAction.hide)),
                          ),
                    conversation: _maybeBotLookScope(
                      wrap: ownLook,
                      key: 'thread-theme-${bot?.botId.value ?? 'none'}',
                      theme: botTheme,
                      child: bot == null
                          ? NoConversation(
                              empty: bots.isEmpty,
                              failure: bots.isEmpty ? error : null,
                              action: 'Refresh Bots',
                              onAction: () => unawaited(load()),
                            )
                          : ConversationView(
                              key: ValueKey(
                                '${widget.userId}:${bot.botId.value}',
                              ),
                              session: _selectedSession!,
                              store: widget.store,
                              general: bot.botId.value == generalBotId,
                              featuresRevision: featuresRevision,
                              onOpenRun: _openRun,
                              onOpenExchange: _openExchange,
                              backgroundOf: _background,
                              primaryOf: _primary,
                              nameOf: _botNameOf,
                              outOfCredit: credit?.canSpend == false,
                              onOpenBilling: () => unawaited(_openBilling()),
                              onMessageActions: (line, {position}) => unawaited(
                                _messageActions(line, position: position),
                              ),
                              onReadLatest: (messageId) =>
                                  _readLatest(bot.botId.value, messageId),
                              unreadFromMessageId: activity
                                  .unread[bot.botId.value]
                                  ?.unreadFromMessageId,
                              background: _background(bot.botId.value),
                              primary: _primary(bot.botId.value),
                              overlay: (companion) =>
                                  conversationHeader(companion: companion),
                              onDictate: () => unawaited(_dictate()),
                              onStopDictation: () =>
                                  unawaited(_stopDictation()),
                              onDiscardDictation: () =>
                                  unawaited(_discardDictation()),
                              // Voice, on the Bot whose page this is (ADR 0029).
                              onVoice: () => unawaited(
                                _startOrSwitchVoice(botId: bot.botId.value),
                              ),
                              voiceClosing: voiceClosing,
                              voiceActive: voiceHere,
                              dictationState:
                                  dictation?.context == bot.botId.value
                                  ? dictation!.state
                                  : DictationState.idle,
                              // The offer belongs to the composer the capture
                              // was dictated into, exactly as the words do.
                              canRevertDictation: () =>
                                  dictation?.context == bot.botId.value &&
                                  dictation!.cleaned,
                              onRevertDictation:
                                  dictation?.context == bot.botId.value
                                  ? dictation!.revertCleanup
                                  : null,
                              dictationLevel: dictation?.level,
                              dictationElapsed: dictation?.elapsed,
                            ),
                    ),
                  ),
                  ?_appletFrameHolder(context),
                ],
              ),
            ),
          ),
          VoiceReveal(
            visible: footerOpen && session != null && !voiceHere,
            bottomInset: footerOpen || footerExiting
                ? MediaQuery.paddingOf(context).bottom
                : 0,
            onHidden: () {
              if (footerExiting) setState(() => footerExiting = false);
            },
            child: session == null
                ? const SizedBox.shrink()
                : VoiceFooter(
                    session: session,
                    botAppearance: (botId) => bots
                        .where((bot) => bot.botId.value == botId)
                        .map(
                          (bot) => (
                            characterId: bot.avatar.characterId,
                            primary: bot.avatar.primary,
                          ),
                        )
                        .firstOrNull,
                    onEnd: () => unawaited(_endVoice(reason: 'end-button')),
                  ),
          ),
        ],
      ),
    );
    return SearchShortcutListener(
      onOpen: () => unawaited(_openSearch()),
      child: Theme(
        key: const ValueKey('shell-theme'),
        data: accountTheme,
        child: Builder(
          builder: (context) => ColoredBox(
            color: Theme.of(context).colorScheme.surface,
            child: shell,
          ),
        ),
      ),
    );
  }

  Future<void> _openSearch() async {
    if (_searchOpen) return;
    _searchOpen = true;
    SearchSelection? hit;
    try {
      hit = await showSearchOverlayV1(
        context,
        widget.api,
        bots: [
          for (final bot in searchableBots)
            SearchBot(
              id: bot.botId.value,
              name: _name(bot),
              description:
                  profiles[bot.botId.value]?.title ??
                  bot.initialDescription ??
                  '',
              background: bot.avatar.characterId,
              primary: bot.avatar.primary,
              unread: activity.unread[bot.botId.value]?.unread == true,
              archived: archived.contains(bot.botId.value),
              hidden: profiles[bot.botId.value]?.hiddenFromSidebar == true,
            ),
        ],
        actions: [
          if (selected != null)
            const SearchAction(
              'chat-settings',
              'Chat Settings',
              'Current chat',
            ),
          const SearchAction(
            'settings',
            'Settings: General',
            'Personal details',
          ),
          if (computer?.available == true)
            const SearchAction('computer', 'Computer', 'Current chat'),
          const SearchAction('billing', 'Settings: Usage & Billing', 'Account'),
          const SearchAction('plugins', 'Plugins', 'Account'),
          const SearchAction(
            'marketplace',
            'Marketplace',
            'Connections and services',
          ),
          const SearchAction('machines', 'Your computers', 'Account'),
          if (selected != null)
            const SearchAction('routines', 'Routines', 'Current chat'),
        ],
      );
    } finally {
      _searchOpen = false;
    }
    if (hit == null || !mounted) return;
    if (hit.actionId case final String action) {
      Navigator.of(context).popUntil((route) => route.isFirst);
      switch (action) {
        case 'chat-settings':
          _openPanel('bot-page');
          _openPanel('bot-settings', push: true);
        case 'settings':
          _openSettings();
        case 'computer':
          unawaited(_openComputerViewer());
        case 'billing':
          unawaited(_openBilling());
        case 'plugins':
          _push(
            PluginsPage(
              onFeaturesChanged: _featuresChanged,
              api: widget.api,
              store: widget.store,
              userId: widget.userId,
            ),
          );
        case 'marketplace':
          _openMarketplace();
        case 'machines':
          _push(
            MachinesPage(
              api: widget.api,
              store: widget.store,
              userId: widget.userId,
            ),
          );
        case 'routines':
          _openPanel('routines');
      }
      return;
    }
    final botId = hit.botId;
    if (botId == null) return;
    if (searchableBots.every((bot) => bot.botId.value != botId)) await load();
    if (!mounted) return;
    // A desktop destination may be covered by the page from which Cmd+K was
    // used. Return to the shell before selecting the conversation behind it.
    Navigator.of(context).popUntil((route) => route.isFirst);
    final matchedBot = searchableBots
        .where((bot) => bot.botId.value == botId)
        .firstOrNull;
    if (matchedBot == null) {
      _say('That Bot is no longer available.');
      return;
    }
    if (archived.contains(botId)) {
      if (hit.routineId case final String routineId) {
        _push(
          RoutineRunsPage(api: widget.api, botId: botId, routineId: routineId),
        );
      } else {
        _push(
          ArchivedConversationPage(
            api: widget.api,
            bot: SearchBot(
              id: botId,
              name: _name(matchedBot),
              background: matchedBot.avatar.characterId,
              primary: matchedBot.avatar.primary,
              archived: true,
            ),
            runId: hit.runId,
          ),
        );
      }
      return;
    }
    _select(botId);
    if (hit.routineId case final String routineId) {
      _push(
        RoutinesView(
          api: widget.api,
          store: widget.store,
          userId: widget.userId,
          botId: botId,
          botName:
              bots
                  .where((bot) => bot.botId.value == botId)
                  .map(_name)
                  .firstOrNull ??
              botId,
          initialRoutineId: routineId,
          onInbox: routineInbox?.adopt,
        ),
      );
    } else if (hit.runId case final String runId) {
      widget.sessions.open(widget.userId, botId).controller.focusRun(runId);
    }
  }

  /// The Marketplace: a page and a list on a phone, where the list of Bots is
  /// the screen and every destination is a page over it; a dialog and a grid
  /// on a wider layout, where the Bots and the conversation stay put behind
  /// it. One document either way.
  void _openMarketplace() {
    if (shellTierForWidth(MediaQuery.sizeOf(context).width) ==
        ShellTier.single) {
      _push(
        MarketplacePage(
          onFeaturesChanged: _featuresChanged,
          api: widget.api,
          store: widget.store,
          userId: widget.userId,
        ),
      );
      return;
    }
    unawaited(
      showDialog<void>(
        context: context,
        builder: (dialogContext) => _withAccountTheme(
          dialogContext,
          MarketplaceDialog(
            onFeaturesChanged: _featuresChanged,
            api: widget.api,
            store: widget.store,
            userId: widget.userId,
          ),
        ),
      ),
    );
  }

  void _openSettings() => _push(
    SettingsPage(
      api: widget.api,
      store: widget.store,
      userId: widget.userId,
      onFeaturesChanged: _featuresChanged,
    ),
  );

  /// Account destinations push above Profile, so Back returns here.
  ///
  /// One sheet, GrokBot's shape: who is signed in, what is the account's, what
  /// is every Bot's, and the door out. Each row is a name and a chevron; what
  /// a destination is for is said on the destination.
  void _openProfile() {
    _push(
      Scaffold(
        appBar: DesktopHeader(child: AppBar(title: const Text('You'))),
        body: identified(
          SettingsIds.profileMenu,
          SafeArea(
            top: false,
            child: SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(16, 4, 16, 32),
              child: Center(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 680),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      identified(
                        SettingsIds.profileName,
                        Padding(
                          padding: const EdgeInsets.fromLTRB(4, 8, 4, 8),
                          child: Row(
                            children: [
                              Container(
                                width: 44,
                                height: 44,
                                decoration: BoxDecoration(
                                  color: Theme.of(context).colorScheme.onSurface
                                      .withValues(alpha: 0.08),
                                  shape: BoxShape.circle,
                                ),
                                child: Icon(
                                  Icons.person_rounded,
                                  size: 22,
                                  color: Theme.of(context)
                                      .colorScheme
                                      .onSurfaceVariant,
                                ),
                              ),
                              const SizedBox(width: 14),
                              Expanded(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    FutureBuilder<String>(
                                      future: _displayName(),
                                      builder: (context, answer) => Text(
                                        answer.data ?? widget.userId,
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                        style: Theme.of(context)
                                            .textTheme
                                            .titleMedium,
                                      ),
                                    ),
                                    const SizedBox(height: 2),
                                    Text(
                                      'Signed in',
                                      style: Theme.of(context)
                                          .textTheme
                                          .bodySmall
                                          ?.copyWith(
                                            color: Theme.of(context)
                                                .colorScheme
                                                .onSurfaceVariant,
                                          ),
                                    ),
                                  ],
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                      // What the account can spend, first, because it is the
                      // one thing on this page that decides whether a Bot
                      // replies at all.
                      if (credit case final credit?)
                        identified(
                          SettingsIds.profileCredit,
                          CreditTile(
                            credit: credit,
                            onTap: () => unawaited(_openBilling()),
                          ),
                        ),
                      _profileGroup(null, [
                        identified(
                          SettingsIds.profileWhatsNew,
                          FrockRow(
                            icon: Icons.campaign_outlined,
                            title: 'What’s New',
                            trailing: whatsNew.unseenCount(whatsNewSeenId) > 0
                                ? const WhatsNewUnreadMark()
                                : null,
                            onTap: _openWhatsNew,
                          ),
                        ),
                      ]),
                      _profileGroup('Account', [
                        _profileRow(
                          SettingsIds.profileSettings,
                          Icons.settings_outlined,
                          'Personal details',
                          _openSettings,
                        ),
                      ]),
                      _profileGroup('Bots', [
                        _profileRow(
                          SettingsIds.profileModels,
                          Icons.auto_awesome_rounded,
                          'Models',
                          () => _push(
                            SettingsPage(
                              onFeaturesChanged: _featuresChanged,
                              api: widget.api,
                              store: widget.store,
                              userId: widget.userId,
                              home: 'models',
                            ),
                          ),
                        ),
                        _profileRow(
                          'profile-billing',
                          Icons.account_balance_wallet_outlined,
                          'Billing & usage',
                          () => unawaited(_openBilling()),
                        ),
                        _profileRow(
                          MachineIds.profileEntry,
                          Icons.computer_outlined,
                          'Your computers',
                          () => _push(
                            MachinesPage(
                              api: widget.api,
                              store: widget.store,
                              userId: widget.userId,
                            ),
                          ),
                        ),
                        // The account's list: what is installed. A Bot's own
                        // switches are Bot settings, in the panel beside it.
                        _profileRow(
                          PluginIds.profileEntry,
                          Icons.extension_outlined,
                          'Plugins',
                          () => _push(
                            PluginsPage(
                              onFeaturesChanged: _featuresChanged,
                              api: widget.api,
                              store: widget.store,
                              userId: widget.userId,
                            ),
                          ),
                        ),
                        _profileRow(
                          'profile-capabilities',
                          Icons.tune_outlined,
                          'Account features',
                          () => _push(
                            PluginsPage(
                              onFeaturesChanged: _featuresChanged,
                              api: widget.api,
                              store: widget.store,
                              userId: widget.userId,
                              capabilities: true,
                            ),
                          ),
                        ),
                        _profileRow(
                          TemplateIds.profileEntry,
                          Icons.inventory_2_outlined,
                          'Bot templates',
                          () => _push(
                            TemplatesPage(
                              api: widget.api,
                              store: widget.store,
                              userId: widget.userId,
                              botId: selected?.botId.value,
                              botName: selected == null
                                  ? null
                                  : _name(selected!),
                            ),
                          ),
                        ),
                        _profileRow(
                          SettingsIds.profileManageBots,
                          Icons.manage_accounts_outlined,
                          'Manage Bots',
                          () => _push(
                            BotRecoveryPage(
                              api: widget.api,
                              store: widget.store,
                              userId: widget.userId,
                              changed: load,
                            ),
                          ),
                        ),
                        _profileRow(
                          AuditIds.recoveryEntry,
                          Icons.history_rounded,
                          'Activity & history',
                          () => _push(
                            AuditPage(
                              api: widget.api,
                              store: widget.store,
                              userId: widget.userId,
                            ),
                          ),
                        ),
                      ]),
                      // A development build can look at the ViewNode renderer
                      // before a plugin produces a document; the shipped app
                      // has no such door.
                      if (developmentAuth)
                        _profileGroup('This site', [
                          _profileRow(
                            'profile-view-sample',
                            Icons.dashboard_customize_outlined,
                            'View sample',
                            () => _push(
                              ViewSamplePage(
                                store: widget.store,
                                userId: widget.userId,
                              ),
                            ),
                          ),
                        ]),
                      if (!localDevelopment)
                        _profileGroup(null, [
                          identified(
                            SettingsIds.profileSignOut,
                            Builder(
                              builder: (context) => FrockRow(
                                icon: Icons.logout_rounded,
                                title: 'Sign out',
                                color: Theme.of(context).colorScheme.error,
                                chevron: false,
                                onTap: () {
                                  Navigator.of(context).pop();
                                  unawaited(appBadge.clear());
                                  unawaited(
                                    push.logout().then(
                                      (_) => widget.onSignOut(),
                                    ),
                                  );
                                },
                              ),
                            ),
                          ),
                        ]),
                      // The last line on the page: which program this is, so
                      // a report of what went wrong can say what was running.
                      Padding(
                        padding: const EdgeInsets.only(top: 24),
                        child: FutureBuilder<AppVersion>(
                          future: widget.version(),
                          builder: (context, answer) => identified(
                            SettingsIds.profileVersion,
                            Text(
                              (answer.data ?? const AppVersion()).label,
                              textAlign: TextAlign.center,
                              style: Theme.of(context).textTheme.bodySmall
                                  ?.copyWith(
                                    color: Theme.of(context)
                                        .colorScheme
                                        .onSurfaceVariant,
                                  ),
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  /// One card of rows, with the name of what they have in common above it.
  Widget _profileGroup(String? title, List<Widget> rows) => Builder(
    builder: (context) => Padding(
      padding: const EdgeInsets.only(top: 18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (title != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 0, 4, 6),
              child: Text(
                title.toUpperCase(),
                style: Theme.of(context).textTheme.labelSmall?.copyWith(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
              ),
            ),
          FrockRowGroup(rows: rows),
        ],
      ),
    ),
  );

  Widget _profileRow(
    String id,
    IconData icon,
    String title,
    VoidCallback onTap,
  ) => identified(id, FrockRow(icon: icon, title: title, onTap: onTap));

  /// The saved profile name, falling back to the account this session holds.
  /// A name is a courtesy: a read that fails leaves the page usable.
  Future<String> _displayName() async {
    try {
      final settings =
          (await widget.api.request('/api/settings/application'))! as Map;
      final sections = settings['sections'] as List;
      final profile = sections
          .cast<Map>()
          .where((section) => section['id'] == 'profile')
          .firstOrNull;
      final name = (profile?['fields'] as List?)
          ?.cast<Map>()
          .where((field) => field['id'] == 'name')
          .firstOrNull?['value'];
      if (name is String && name.trim().isNotEmpty) return name.trim();
    } catch (_) {
      // Nothing is lost but the name.
    }
    return widget.userId;
  }

  @override
  void dispose() {
    unawaited(macMessages.stop(widget.userId));
    unawaited(appBadge.clear());
    push.onFocus = null;
    push.onNotificationsChanged = null;
    WidgetsBinding.instance.removeObserver(this);
    widget.botLinks.removeListener(_followBotLink);
    _activityTimer?.cancel();
    activity.removeListener(_repaint);
    activity.dispose();
    lifecycle.dispose();
    push.dispose();
    botSettings?.removeListener(_paintFromSettings);
    botSettings?.dispose();
    routineInbox?.dispose();
    routinesPanel?.removeListener(_repaint);
    routinesPanel?.dispose();
    appletCanvas?.dispose();
    computer?.dispose();
    _selectedChat?.removeListener(_selectedChatChanged);
    slots.dispose();
    catalogRevision.dispose();
    avatarRevision.dispose();
    voiceSession?.dispose();
    dictation?.removeListener(_repaint);
    dictation?.dispose();
    unawaited(voiceCapture?.dispose() ?? Future<void>.value());
    microphone.dispose();
    voiceProbe.dispose();
    super.dispose();
  }
}

/// The exchange chat as a page: the controller lives as long as the page.
class _ExchangeScreen extends StatefulWidget {
  final ExchangeController controller;
  final ExchangeParty self;
  final String? counterpartBackground;
  final String? counterpartPrimary;

  /// The Bot's own chat: its in-flight runs are what the view merges with the
  /// loaded pages, so the page repaints when it notifies.
  final ChatController chat;
  const _ExchangeScreen({
    required this.controller,
    required this.self,
    required this.counterpartBackground,
    required this.counterpartPrimary,
    required this.chat,
  });

  @override
  State<_ExchangeScreen> createState() => _ExchangeScreenState();
}

class _ExchangeScreenState extends State<_ExchangeScreen> {
  late final Listenable _listenable = Listenable.merge([
    widget.controller,
    widget.chat,
  ]);

  @override
  void dispose() {
    widget.controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: DesktopHeader(
      child: AppBar(
        titleSpacing: 0,
        title: ExchangeTitle(
          self: widget.self,
          counterpart: widget.controller.counterpart,
          counterpartBackground: widget.counterpartBackground,
          counterpartPrimary: widget.counterpartPrimary,
        ),
      ),
    ),
    body: SafeArea(
      child: ListenableBuilder(
        listenable: _listenable,
        builder: (context, _) => ExchangeView(
          self: widget.self,
          counterpart: widget.controller.counterpart,
          counterpartBackground: widget.counterpartBackground,
          counterpartPrimary: widget.counterpartPrimary,
          exchanges: widget.controller.exchanges(widget.chat.runs),
          hasEarlier: widget.controller.before != null,
          loading: widget.controller.loading,
          error: widget.controller.error,
          onOlder: () => unawaited(widget.controller.load(older: true)),
          header: false,
        ),
      ),
    ),
  );
}
