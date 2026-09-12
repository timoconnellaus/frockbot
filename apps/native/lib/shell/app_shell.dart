/// The signed-in shell: the Bot list, the conversation, and the right panel.
///
/// Everything above a single Bot lives here — the directory, the identities
/// the sidebar groups by, the unread fan-out, the drawers' state and the slot
/// registry a feature renders into. `main.dart` is the app entry and the sign
/// -in door, and hands this a signed-in session and nothing else.
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter/services.dart';

import '../activity/controller.dart';
import '../activity/push.dart';
import '../admin/page.dart';
import '../applets/canvas.dart';
import '../applets/picker.dart';
import '../audit/page.dart';
import '../client/auth.dart' show developmentAuth;
import '../client/bot_sessions.dart';
import '../client/chat_controller.dart' show ConnectionState;
import '../client/transport.dart';
import '../computer/card.dart';
import '../computer/client.dart';
import '../connections/page.dart';
import '../flock/create.dart';
import '../flock/lifecycle.dart';
import '../machines/page.dart';
import '../machines/mac_messages.dart';
import '../packages/catalog.dart';
import '../packages/frame.dart';
import '../plugins/page.dart';
import '../recovery/page.dart';
import '../routines/page.dart';
import '../search/overlay.dart';
import '../settings/billing.dart';
import '../settings/credit.dart';
import '../settings/bot_settings.dart';
import '../settings/page.dart';
import '../templates/page.dart';
import '../update/app_version.dart';
import '../view/sample_page.dart';
import '../voice/assistant.dart';
import '../voice/capabilities.dart';
import '../voice/capture.dart';
import '../voice/dictation.dart';
import '../voice/footer.dart';
import '../voice/mic_ownership.dart';
import '../voice/player.dart';
import '../voice/protocol.dart' show voiceUnavailableMessage;
import '../voice/socket.dart';
import '../protocol/client_wire.generated.dart' as wire;
import 'chat_pane.dart';
import 'chat_header.dart';
import 'desktop_layout.dart';
import 'lifecycle.dart';
import 'run_view.dart';
import 'semantics.dart';
import 'sidebar.dart';
import 'slots.dart';
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
  late final PushController push = PushController(
    widget.api,
    widget.store,
    widget.userId,
    activity,
  );
  String? clearManualForBot;
  bool resumed = true;
  Timer? _activityTimer;
  List<wire.BotRegistration> bots = [];
  Map<String, SidebarProfile> profiles = {};
  Set<String> archived = {};
  wire.BotRegistration? selected;
  String? workingRunId;
  ConnectionState selectedConnection = ConnectionState.initializing;
  BotSettingsController? botSettings;
  RoutineInboxController? routineInbox;

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
  PackageCatalog? catalog;
  String? error;
  bool loaded = false;

  /// On a phone the Bot list is the first screen and a conversation is a
  /// page over it; this is whether that page is up. At the wider tiers the
  /// conversation is a column and this is not consulted.
  bool conversationOpen = false;
  bool panelOpen = false;

  /// Whether the person has hidden the right panel where it is a column. The
  /// drawer's flag above is not this: closing the drawer at one width must not
  /// take the column away at another.
  bool panelCollapsed = false;

  /// Which right-panel entry is on. The region holds two — the Bot's settings
  /// and its Routines — and shows one, because a column is a place to read one
  /// thing rather than a stack of everything a feature registered.
  String panelKey = 'bot-settings';

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
  RecordVoiceCapture? voiceCapture;
  AssistantSessionController? voiceSession;
  DictationController? dictation;
  bool footerOpen = false;
  bool showHidden = false;
  bool isAdmin = false;
  TranscriptLine? openRun;

  /// What the account can spend, from `/api/billing`. Null until read, and
  /// null on a deployment that does not meter: then credit means nothing and
  /// no surface mentions it.
  AccountCredit? credit;

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
    widget.botLinks.addListener(_followBotLink);
    // A lifecycle command nobody has an answer for is adopted here rather than
    // when the danger zone happens to be opened: it is the account's, and it
    // is what locks the zone until it is accounted for.
    unawaited(lifecycle.restore());
    unawaited(load());
    _startPolling();
    unawaited(push.start());
  }

  void _repaint() {
    if (mounted) setState(() {});
    unawaited(push.syncRead());
  }

  void _readLatest(String botId, String? messageId) {
    if (!mounted) return;
    final viewing =
        resumed &&
        push.focused &&
        _conversationVisible &&
        !panelOpen &&
        openRun == null &&
        ModalRoute.of(context)?.isCurrent == true;
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
    if (activity.loading || activity.saving || activity.pending) return;
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
      (_) => unawaited(activity.load()),
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
      // Voice is foreground-only by decision. Leaving the app ends capture,
      // playback and the call; in-app navigation does not.
      unawaited(_endVoice(reason: 'lifecycle:${state.name}'));
      unawaited(_stopDictation());
      return;
    }
    unawaited(activity.load());
    _startPolling();
  }

  /// Opens the footer and starts the call in the one gesture.
  Future<void> _startVoice() async {
    await voiceProbe.load();
    if (!mounted) return;
    if (!voiceProbe.assistantAvailable) {
      _say(voiceUnavailableMessage);
      return;
    }
    if (voiceSession?.active == true) return;
    await microphone.acquireForAssistant();
    if (!mounted) return;
    voiceSession?.dispose();
    final session = AssistantSessionController(
      openSocket: assistantSocketOpenerV1(widget.api),
      capture: voiceCapture ??= RecordVoiceCapture(),
      player: PcmVoicePlayer(),
    );
    setState(() {
      voiceSession = session;
      footerOpen = true;
    });
    await session.start();
  }

  /// Ends capture, playback and the call, and takes the footer away. It
  /// navigates nowhere.
  Future<void> _endVoice({String reason = 'ended'}) async {
    final session = voiceSession;
    if (session == null) return;
    await session.end(reason: reason);
    session.dispose();
    microphone.releaseAssistant();
    if (!mounted) {
      voiceSession = null;
      return;
    }
    setState(() {
      voiceSession = null;
      footerOpen = false;
    });
  }

  Future<void> _dictate() async {
    final bot = selected;
    if (bot == null) return;
    await voiceProbe.load();
    if (!mounted) return;
    if (!voiceProbe.dictationAvailable) {
      _say(voiceUnavailableMessage);
      return;
    }
    if (dictation?.active == true) return;
    await microphone.acquireForDictation();
    if (!mounted) return;
    final controller = dictation ??= DictationController(
      openSocket: dictationSocketOpenerV1(widget.api),
      capture: voiceCapture ??= RecordVoiceCapture(),
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

  /// Whether this account administers the deployment. The gateway is the
  /// authority; this only decides whether the door is offered at all.
  Future<void> _readIdentity() async {
    try {
      final identity = wire.AuthIdentity.fromJson(
        await widget.api.request('/api/identity'),
      );
      if (mounted && identity.isAdmin != isAdmin) {
        setState(() => isAdmin = identity.isAdmin);
      }
    } catch (_) {
      // Nothing is lost but the Admin entry.
    }
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

  Future<void> load() async {
    unawaited(_readIdentity());
    unawaited(_readCredit());
    try {
      final cached = await widget.store.read('directory/${widget.userId}');
      if (cached != null && bots.isEmpty) {
        _adopt(wire.BotDirectory.fromJson(jsonDecode(cached)).bots, const {});
      }
      final directory = wire.BotDirectory.fromJson(
        await widget.api.request('/api/bots'),
      );
      final lifecycle = wire.BotLifecycleDirectory.fromJson(
        await widget.api.request('/api/bots/lifecycles'),
      );
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
      await widget.store.write(
        'directory/${widget.userId}',
        jsonEncode({
          ...directory.toJson()! as Map,
          'bots': [for (final bot in active) bot.toJson()],
        }),
      );
      if (!mounted) return;
      _adopt(active, {
        for (final entry in unavailable.entries)
          if (entry.value == 'archived') entry.key,
      });
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
      if (mounted) setState(() => loaded = true);
    }
  }

  void _adopt(List<wire.BotRegistration> active, Set<String> archivedIds) {
    setState(() {
      bots = active;
      archived = archivedIds;
      // The cached directory is an answer, so the skeleton goes now rather
      // than waiting on a read that only replaces it.
      loaded = true;
      selected = selected == null
          ? null
          : active
                .where((bot) => bot.botId.value == selected!.botId.value)
                .firstOrNull;
      error = null;
    });
    unawaited(_restoreSelection());
  }

  Future<void> _restoreSelection() async {
    if (selected != null) return;
    final saved = await widget.store.read('selection.${widget.userId}');
    if (!mounted || saved == null) return;
    final bot = bots.where((bot) => bot.botId.value == saved).firstOrNull;
    if (bot == null) return;
    clearManualForBot = bot.botId.value;
    setState(() => selected = bot);
    _adoptBotPanels(bot.botId.value);
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

  String _name(wire.BotRegistration bot) =>
      profiles[bot.botId.value]?.name ?? bot.initialName;

  void _followBotLink() {
    final botId = widget.botLinks.value;
    if (botId == null) return;
    widget.botLinks.value = null;
    final bot = bots.where((bot) => bot.botId.value == botId).firstOrNull;
    if (bot == null) {
      unawaited(load());
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
      if (switching) selectedConnection = ConnectionState.initializing;
      conversationOpen = true;
      openRun = null;
      panelOpen = false;
    });
    _adoptBotPanels(botId);
    unawaited(
      widget.store
          .write('selection.${widget.userId}', botId)
          .catchError((Object _) {}),
    );
  }

  /// The Bot's own settings and its Routines are features in the `right-panel`
  /// region, which is what that region is for: the shell draws the region and
  /// never imports what goes in it.
  void _adoptBotPanels(String botId) {
    final name =
        bots.where((bot) => bot.botId.value == botId).map(_name).firstOrNull ??
        botId;
    botSettings?.dispose();
    routineInbox?.dispose();
    final controller = BotSettingsController(widget.api, botId);
    final inbox = RoutineInboxController(widget.api, botId);
    botSettings = controller;
    routineInbox = inbox;
    inbox.addListener(_repaint);
    slots.register(
      ShellSlot.rightPanel,
      'bot-settings',
      (context) => SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            BotSettingsView(
              controller: controller,
              onSaved: load,
              background: _background(botId),
              onEditAvatar: () => unawaited(_editAvatar(botId, name)),
              dangerZone: _dangerZone(botId, name),
            ),
            ..._packageSettings(botId),
          ],
        ),
      ),
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
        onOpenRun: _openRun,
        onInbox: inbox.adopt,
      ),
      label: 'Routines',
    );
    appletCanvas?.dispose();
    computer?.dispose();
    appletCanvas = null;
    computer = null;
    catalog = null;
    slots.remove(ShellSlot.rightPanel, 'applet');
    slots.remove(ShellSlot.rightPanel, 'computer');
    slots.remove(ShellSlot.headerActions, 'package-entries');
    unawaited(controller.load());
    unawaited(inbox.load());
    unawaited(_adoptComposition(botId));
  }

  /// What this Bot's Composition declares it may show: the Applet canvas, the
  /// Computer, and the Package pages and entries. An absent capability is
  /// silence — no catalog means none of these are registered, and the shell
  /// asks for no route that does not exist here.
  Future<void> _adoptComposition(String botId) async {
    final read = await readPackageCatalogV1(widget.api, botId);
    if (!mounted || selected?.botId.value != botId) return;
    setState(() => catalog = read);
    if (read != null && read.appletsAvailable) {
      final canvas = AppletCanvasController(widget.api, botId);
      appletCanvas = canvas;
      canvas.addListener(_repaint);
      slots.register(
        ShellSlot.rightPanel,
        'applet',
        (context) => _appletCanvas(botId, canvas),
        label: 'Applet',
      );
      unawaited(canvas.load());
    }
    final machine = ComputerController(widget.api, botId);
    computer = machine;
    machine.addListener(() {
      if (!mounted) return;
      // The Computer is registered only once the deployment has said it has
      // one, so a card never appears and then disappears.
      if (machine.available &&
          !slots.keys(ShellSlot.rightPanel).contains('computer')) {
        slots.register(
          ShellSlot.rightPanel,
          'computer',
          (context) => SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 32),
            child: ComputerCard(
              controller: machine,
              turnRunning: workingRunId != null,
            ),
          ),
          label: 'Computer',
        );
      }
      _repaint();
    });
    unawaited(machine.read());
    final entries = packageIframeEntriesV1(read);
    if (entries.isNotEmpty) {
      slots.register(
        ShellSlot.headerActions,
        'package-entries',
        (context) => Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (final entry in entries)
              identified(
                PackageIds.entry(entry.contribution.packageId, entry.entry.id),
                IconButton(
                  tooltip: entry.entry.label,
                  icon: Icon(_packageIcon(entry.entry.icon)),
                  onPressed: () => _openPackagePage(entry),
                ),
              ),
          ],
        ),
      );
    }
    if (mounted) setState(() {});
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
    _push(
      Scaffold(
        appBar: AppBar(title: Text(entry.entry.label)),
        body: SafeArea(
          top: false,
          child: identified(
            PackageIds.page(entry.contribution.packageId, entry.page.id),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
              child: PackagePageFrame(
                api: widget.api,
                catalog: held,
                contribution: entry.contribution,
                page: entry.page,
                botId: bot.botId.value,
                slot: entry.slot,
                layout: PackageFrameLayout.fill,
                surfaceTitle: entry.entry.label,
                states: {
                  packageIframeAppletsStateV2: appletsBridgeStateV2(
                    appletCanvas,
                  ),
                },
                onFocus: (appletId) async {
                  await appletCanvas?.setFocus(appletId);
                  if (mounted) _openPanel('applet');
                },
              ),
            ),
          ),
        ),
      ),
    );
  }

  /// The canvas, over the thread the progress line is read from.
  ///
  /// `holdsFrame` puts the shell's one frame key on the live frame: the
  /// pushed canvas page on a phone. The panel column at the desk tiers keeps
  /// its own frame alive by staying built, and never shares the key with a
  /// page that could be up at the same time across a resize.
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

  /// The live frame, pre-mounted off stage on a phone.
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
    if (shellTierForWidth(MediaQuery.sizeOf(context).width) !=
        ShellTier.single) {
      return null;
    }
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

  void _push(Widget page) {
    push.reading(null);
    Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => page));
  }

  /// Back from a conversation on a phone: the list again, with nothing of the
  /// conversation's left open over it.
  void _openBack() {
    push.reading(null);
    setState(() {
      conversationOpen = false;
      openRun = null;
      panelOpen = false;
    });
  }

  void _openRun(TranscriptLine line) {
    if (shellTierForWidth(MediaQuery.sizeOf(context).width) ==
        ShellTier.single) {
      _push(RunPage(line: line));
      return;
    }
    setState(() {
      openRun = line;
      panelOpen = true;
    });
  }

  Widget? _rightPanel() {
    final line = openRun;
    if (line != null) {
      return RunView(
        line: line,
        onClose: () => setState(() {
          openRun = null;
          panelOpen = false;
        }),
      );
    }
    final keys = slots.keys(ShellSlot.rightPanel);
    if (keys.isEmpty) return null;
    final key = keys.contains(panelKey) ? panelKey : keys.first;
    return identified(
      ShellIds.slot(ShellSlot.rightPanel.id),
      Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // The panel names what it holds and offers the way out. Choosing
          // what it holds is the chat header's job: its icons are the one set
          // of doors, and a second row of them here was the same doors twice.
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 4, 4),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    slots.labelOf(ShellSlot.rightPanel, key) ?? key,
                    style: Theme.of(context).textTheme.titleMedium
                        ?.copyWith(fontWeight: FontWeight.w500),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                identified(
                  ShellIds.rightPanelClose,
                  IconButton(
                    tooltip: 'Close the panel',
                    onPressed: () => setState(() {
                      panelOpen = false;
                      panelCollapsed = true;
                    }),
                    icon: const Icon(Icons.close),
                  ),
                ),
              ],
            ),
          ),
          const Divider(height: 1),
          Expanded(child: slots.buildOne(context, ShellSlot.rightPanel, key)!),
        ],
      ),
    );
  }

  /// Opens one right-panel entry. On the phone the panel is a page: a drawer
  /// over a full-width conversation is the same thing with less room and a
  /// scrim in the way.
  void _openPanel(String key) {
    if (shellTierForWidth(MediaQuery.sizeOf(context).width) ==
        ShellTier.single) {
      _pushPanel(key);
      return;
    }
    setState(() {
      openRun = null;
      panelKey = key;
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
      if (triple) {
        panelCollapsed = !panelCollapsed;
      } else {
        panelOpen = !panelOpen;
      }
    });
  }

  Future<void> _messageActions(TranscriptLine line) async {
    final bot = selected;
    if (bot == null) return;
    final copyText = [
      if (line.text.isNotEmpty) line.text,
      for (final send in line.sends)
        if (send.type == 'text' && send.payload?['text'] is String)
          send.payload!['text'] as String,
    ].join('\n\n');
    final action = await showModalBottomSheet<String>(
      context: context,
      showDragHandle: true,
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (activity.unread[bot.botId.value]?.unread == true)
              ListTile(
                leading: const Icon(Icons.mark_chat_read_outlined),
                title: const Text('Mark as read'),
                enabled:
                    !activity.saving && !activity.pending && !activity.loading,
                onTap: () => Navigator.pop(context, 'read'),
              ),

            if (copyText.isNotEmpty)
              ListTile(
                leading: const Icon(Icons.copy),
                title: const Text('Copy'),
                onTap: () => Navigator.pop(context, 'copy'),
              ),

            if (line.id.endsWith(':user') ||
                line.id.endsWith(':failed') ||
                line.id.contains(':send:'))
              ListTile(
                leading: const Icon(Icons.mark_chat_unread_outlined),
                title: const Text('Mark unread from here'),
                enabled:
                    !activity.saving && !activity.pending && !activity.loading,
                onTap: () => Navigator.pop(context, 'unread'),
              ),
            ListTile(
              leading: const Icon(Icons.receipt_long_outlined),
              title: const Text('Work details'),
              onTap: () => Navigator.pop(context, 'work'),
            ),
          ],
        ),
      ),
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

  Future<void> _openApplet(String appletId) async {
    final canvas = appletCanvas;
    if (canvas == null) return;
    await canvas.setFocus(appletId);
    // A focus read may finish after the person switches Bots.
    if (!mounted || canvas != appletCanvas) return;
    if (canvas.focusedId == appletId) {
      _openPanel('applet');
    } else {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Couldn’t open this Applet. Try again.')),
      );
    }
  }

  void _pushPanel(String key) {
    final bot = selected;
    final controller = botSettings;
    if (bot == null) return;
    if (key == 'routines') {
      _push(
        RoutinesView(
          api: widget.api,
          store: widget.store,
          userId: widget.userId,
          botId: bot.botId.value,
          botName: _name(bot),
          onInbox: routineInbox?.adopt,
        ),
      );
      return;
    }
    // On the phone the right panel's entries are pages, which is the same
    // rule Routines and Bot settings already follow: a drawer over a
    // full-width conversation is the same thing with less room.
    if (key == 'applet' && appletCanvas != null) {
      // The page takes the pre-mounted frame over: the holder lets go in the
      // same frame the page is built, so the key moves rather than doubles.
      // It takes the frame back only once the page has finished leaving — a
      // route on its way out is still in the tree and is not rebuilt, so a
      // holder that reclaimed the key on the pop itself would double it.
      final route = MaterialPageRoute<void>(
        builder: (_) => Scaffold(
          appBar: AppBar(title: const Text('Applet')),
          body: SafeArea(
            top: false,
            child: _appletCanvas(
              bot.botId.value,
              appletCanvas!,
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
      return;
    }
    if (key == 'computer' && computer != null) {
      _push(
        Scaffold(
          appBar: AppBar(title: const Text('Computer')),
          body: SafeArea(
            top: false,
            child: SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 32),
              child: ComputerCard(
                controller: computer!,
                turnRunning: workingRunId != null,
              ),
            ),
          ),
        ),
      );
      return;
    }
    if (controller == null) return;
    _push(_botPage(bot, controller));
  }

  /// The Bot's page, GrokBot's: one scroll from its face to its danger zone.
  ///
  /// Its settings, then the rows for what else it holds — Routines, Applets,
  /// the pages its Packages mount — then Advanced. The rows are read off the
  /// slot registry live, so a Computer or a Package entry that registers
  /// after the page opened appears on it rather than on the next visit.
  Widget _botPage(wire.BotRegistration bot, BotSettingsController controller) {
    final botId = bot.botId.value;
    return Scaffold(
      appBar: AppBar(),
      body: SafeArea(
        top: false,
        child: identified(
          SettingsIds.botPage,
          ListenableBuilder(
            listenable: slots,
            builder: (context, _) => SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 32),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  BotSettingsView(
                    controller: controller,
                    onSaved: load,
                    background: _background(botId),
                    onEditAvatar: () =>
                        unawaited(_editAvatar(botId, _name(bot))),
                    dangerZone: _dangerZone(botId, _name(bot)),
                    sections: _botRows(),
                  ),
                  ..._packageSettings(botId),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  /// What the Bot holds besides its settings, one row each.
  List<Widget> _botRows() {
    final inbox = routineInbox;
    final canvas = appletCanvas;
    // The Applets Package declares an entry of its own called Applets. The
    // row above is the same door, so one of them is enough on a page.
    final entries = [
      for (final entry in packageIframeEntriesV1(catalog))
        if (canvas == null || entry.entry.label.toLowerCase() != 'applets')
          entry,
    ];
    const chevron = Icon(Icons.chevron_right_rounded);
    return [
      const SizedBox(height: 12),
      Card(
        margin: EdgeInsets.zero,
        child: Column(
          children: [
            identified(
              RoutineIds.panelToggle,
              ListTile(
                leading: const Icon(Icons.history_rounded),
                title: const Text('Routines'),
                trailing: inbox == null
                    ? chevron
                    : AnimatedBuilder(
                        animation: inbox,
                        builder: (context, _) => Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            if (inbox.unacknowledged > 0)
                              Badge(label: Text(inbox.badge)),
                            chevron,
                          ],
                        ),
                      ),
                onTap: () => _openPanel('routines'),
              ),
            ),
            if (canvas != null) ...[
              const Divider(height: 1),
              identified(
                AppletIds.chip,
                ListTile(
                  leading: const Icon(Icons.widgets_outlined),
                  title: const Text('Applets'),
                  trailing: chevron,
                  onTap: () async {
                    final id = await showDialog<String>(
                      context: context,
                      builder: (_) => AppletPicker(controller: canvas),
                    );
                    if (id != null && mounted) await _openApplet(id);
                  },
                ),
              ),
            ],
            for (final entry in entries) ...[
              const Divider(height: 1),
              identified(
                PackageIds.entry(entry.contribution.packageId, entry.entry.id),
                ListTile(
                  leading: Icon(_packageIcon(entry.entry.icon)),
                  title: Text(entry.entry.label),
                  trailing: chevron,
                  onTap: () => _openPackagePage(entry),
                ),
              ),
            ],
          ],
        ),
      ),
    ];
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

  /// The sheep a Bot wears, from the registration the directory carries.
  String? _background(String botId) => bots
      .where((bot) => bot.botId.value == botId)
      .map((bot) => bot.sheep.background)
      .firstOrNull;

  /// The Bot's colour, which the Flock owns and the directory carries — so a
  /// change is read back with everything else rather than patched in here.
  Future<void> _editAvatar(String botId, String botName) async {
    final chosen = await SheepColourSheet.show(
      context,
      api: widget.api,
      botId: botId,
      botName: botName,
    );
    if (chosen != null) await load();
  }

  Widget _dangerZone(String botId, String botName) => BotDangerZone(
    lifecycle: lifecycle,
    botId: botId,
    botName: botName,
    archived: archived.contains(botId),
    onChanged: load,
    // The Bot this panel is about no longer exists, so the panel closes and
    // the shell falls back to whatever the reload leaves selected.
    onDeleted: () => setState(() {
      panelOpen = false;
      conversationOpen = false;
      selected = null;
    }),
  );

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
    final session = voiceSession;
    final rightPanel = _rightPanel();
    return ShellSlotScope(
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
              removeBottom: footerOpen && session != null,
              child: Stack(
                fit: StackFit.expand,
                children: [
                  ShellLayout(
                    header: bot == null
                        ? (single
                              ? null
                              : AppBar(title: const Text('FrockBot')))
                        : ChatHeader(
                            name: _name(bot),
                            connection: selectedConnection,
                            textScale:
                                MediaQuery.textScalerOf(context).scale(14) / 14,
                            background: _background(bot.botId.value),
                            // A phone's bar is GrokBot's three things; the wider tiers
                            // name each entry of the right panel beside the title.
                            onBack: single ? _openBack : null,
                            onOpenBot: single
                                ? () => _pushPanel('bot-settings')
                                : null,
                            onSettings: single
                                ? null
                                : () => _openPanel('bot-settings'),
                            computerRunning:
                                computer?.available == true &&
                                computer!.state.running,
                            onComputer: computer?.available == true
                                ? () => _openPanel('computer')
                                : null,
                            onRoutines: single
                                ? null
                                : () => _openPanel('routines'),
                            onTogglePanel: single || rightPanel == null
                                ? null
                                : _togglePanel,
                            panelShown: tier == ShellTier.triple
                                ? !panelCollapsed
                                : panelOpen,
                            onApplets: single || appletCanvas == null
                                ? null
                                : () async {
                                    final id = await showDialog<String>(
                                      context: context,
                                      builder: (_) => AppletPicker(
                                        controller: appletCanvas!,
                                      ),
                                    );
                                    if (id != null && mounted) {
                                      await _openApplet(id);
                                    }
                                  },
                          ),
                    conversationOpen: bot != null && conversationOpen,
                    onBack: _openBack,
                    panelOpen: panelOpen,
                    panelCollapsed: panelCollapsed,
                    onDismiss: () => setState(() => panelOpen = false),
                    rightPanel: rightPanel,
                    sidebar: Column(
                      children: [
                        // The Package entries beside the list belong to the
                        // column layout; on a phone they are rows on the Bot's page.
                        if (!single)
                          const SlotRegion(
                            ShellSlot.headerActions,
                            direction: Axis.horizontal,
                          ),
                        Expanded(
                          child: ShellSidebar(
                            bots: bots,
                            profiles: profiles,
                            unread: activity.unread,
                            archived: archived,
                            // A phone's list is a list of doors, not a selection: no row
                            // is the current one once the conversation is a page.
                            activeBotId: single ? null : bot?.botId.value,
                            workingBotId: workingRunId == null
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
                            onVoice: () => unawaited(_startVoice()),
                            voiceActive: footerOpen,
                            onToggleHidden: () =>
                                setState(() => showHidden = !showHidden),
                            onRetry: load,
                          ),
                        ),
                      ],
                    ),
                    conversation: bot == null
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
                            sessions: widget.sessions,
                            api: widget.api,
                            store: widget.store,
                            userId: widget.userId,
                            botId: bot.botId.value,
                            onOpenRun: _openRun,
                            onOpenSettings: _openSettings,
                            outOfCredit: credit?.canSpend == false,
                            onOpenBilling: () => unawaited(_openBilling()),
                            onMessageActions: (line) =>
                                unawaited(_messageActions(line)),
                            onReadLatest: (messageId) =>
                                _readLatest(bot.botId.value, messageId),
                            unreadFromMessageId: activity
                                .unread[bot.botId.value]
                                ?.unreadFromMessageId,
                            background: _background(bot.botId.value),
                            onDictate: () => unawaited(_dictate()),
                            onStopDictation: () => unawaited(_stopDictation()),
                            dictating:
                                dictation?.active == true &&
                                dictation?.context == bot.botId.value,
                            dictationLevel: dictation?.level,
                            onWorkingChanged: (runId) {
                              if (runId == workingRunId || !mounted) return;
                              final settled =
                                  workingRunId != null && runId == null;
                              setState(() => workingRunId = runId);
                              // A Turn is how an Applet comes into existence, and the
                              // Bot's page names the Applets the Bot holds — so the
                              // directory is re-read when the Turn that may have changed
                              // it ends. Read on adoption alone, a Bot that had just made
                              // its first Applet had no way to it until the page was
                              // reloaded.
                              final canvas = appletCanvas;
                              if (settled && canvas != null) {
                                unawaited(canvas.load());
                              }
                            },
                            onConnectionChanged: (botId, state) {
                              if (!mounted ||
                                  selected?.botId.value != botId ||
                                  selectedConnection == state) {
                                return;
                              }
                              setState(() => selectedConnection = state);
                            },
                          ),
                  ),
                  ?_appletFrameHolder(context),
                ],
              ),
            ),
          ),
          if (footerOpen && session != null)
            VoiceFooter(
              session: session,
              onEnd: () => unawaited(_endVoice(reason: 'end-button')),
            ),
        ],
      ),
    );
  }

  /// Search over every conversation this account has, which is the backend's
  /// index rather than the names the sidebar happens to hold. A chosen hit is
  /// its Bot and its Turn: the shell opens the Bot and the transcript scrolls
  /// to the Turn.
  Future<void> _openSearch() async {
    final hit = await showSearchOverlayV1(context, widget.api);
    if (hit == null || !mounted) return;
    if (bots.every((bot) => bot.botId.value != hit.botId)) await load();
    if (!mounted) return;
    _select(hit.botId);
    // The Turn may sit further back than the newest page, so the transcript is
    // asked to reach it and says so itself when it cannot.
    widget.sessions
        .open(widget.userId, hit.botId)
        .controller
        .focusRun(hit.runId);
  }

  /// The Marketplace: a page and a list on a phone, where the list of Bots is
  /// the screen and every destination is a page over it; a dialog and a grid
  /// on a wider layout, where the Bots and the conversation stay put behind
  /// it. One document either way.
  void _openMarketplace() {
    if (shellTierForWidth(MediaQuery.sizeOf(context).width) ==
        ShellTier.single) {
      _push(
        ConnectionsPage(
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
        builder: (_) => MarketplaceDialog(
          api: widget.api,
          store: widget.store,
          userId: widget.userId,
        ),
      ),
    );
  }

  void _openSettings() => _push(
    SettingsPage(api: widget.api, store: widget.store, userId: widget.userId),
  );

  /// Account destinations push above Profile, so Back returns here.
  ///
  /// One sheet, GrokBot's shape: who is signed in, what is the account's, what
  /// is every Bot's, and the door out. Each row is a name and a chevron; what
  /// a destination is for is said on the destination.
  void _openProfile() {
    _push(
      Scaffold(
        appBar: AppBar(title: const Text('You')),
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
                        ListTile(
                          contentPadding: EdgeInsets.zero,
                          leading: const CircleAvatar(
                            radius: 24,
                            child: Icon(Icons.person_outline),
                          ),
                          title: FutureBuilder<String>(
                            future: _displayName(),
                            builder: (context, answer) =>
                                Text(answer.data ?? widget.userId),
                          ),
                          subtitle: const Text('Signed in'),
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
                        _profileRow(
                          PluginIds.profileEntry,
                          Icons.extension_outlined,
                          'Plugins',
                          () => _push(
                            PluginsPage(
                              api: widget.api,
                              store: widget.store,
                              userId: widget.userId,
                            ),
                          ),
                        ),
                        _profileRow(
                          'profile-capabilities',
                          Icons.tune_outlined,
                          'Bot capabilities',
                          () => _push(
                            PluginsPage(
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
                      // Admin belongs to the deployment, not to the account,
                      // so the entry is here only for someone the gateway
                      // already answers it for. A development build can look
                      // at the ViewNode renderer before a plugin produces a
                      // document; the shipped app has no such door.
                      if (isAdmin || developmentAuth)
                        _profileGroup('This site', [
                          if (isAdmin)
                            _profileRow(
                              AdminIds.profileEntry,
                              Icons.shield_outlined,
                              'Site administration',
                              () => _push(AdminPage(api: widget.api)),
                            ),
                          if (developmentAuth)
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
                              builder: (context) => ListTile(
                                leading: Icon(
                                  Icons.logout,
                                  color: Theme.of(context).colorScheme.error,
                                ),
                                title: Text(
                                  'Sign out',
                                  style: TextStyle(
                                    color: Theme.of(context).colorScheme.error,
                                  ),
                                ),
                                onTap: () {
                                  Navigator.of(context).pop();
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
      padding: const EdgeInsets.only(top: 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (title != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(4, 0, 4, 6),
              child: Text(
                title,
                style: Theme.of(context).textTheme.labelLarge?.copyWith(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
              ),
            ),
          Card(
            margin: EdgeInsets.zero,
            child: Column(
              children: [
                for (var index = 0; index < rows.length; index++) ...[
                  if (index > 0) const Divider(height: 1),
                  rows[index],
                ],
              ],
            ),
          ),
        ],
      ),
    ),
  );

  Widget _profileRow(
    String id,
    IconData icon,
    String title,
    VoidCallback onTap,
  ) => identified(
    id,
    ListTile(
      leading: Icon(icon),
      title: Text(title),
      trailing: const Icon(Icons.chevron_right_rounded),
      onTap: onTap,
    ),
  );

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
    WidgetsBinding.instance.removeObserver(this);
    widget.botLinks.removeListener(_followBotLink);
    _activityTimer?.cancel();
    activity.removeListener(_repaint);
    activity.dispose();
    lifecycle.dispose();
    push.dispose();
    botSettings?.dispose();
    routineInbox?.dispose();
    appletCanvas?.dispose();
    computer?.dispose();
    slots.dispose();
    voiceSession?.dispose();
    dictation?.removeListener(_repaint);
    dictation?.dispose();
    unawaited(voiceCapture?.dispose() ?? Future<void>.value());
    microphone.dispose();
    voiceProbe.dispose();
    super.dispose();
  }
}
