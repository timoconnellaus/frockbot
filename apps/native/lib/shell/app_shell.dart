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
import '../activity/page.dart';
import '../admin/page.dart';
import '../applets/canvas.dart';
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
import '../packages/catalog.dart';
import '../packages/frame.dart';
import '../plugins/page.dart';
import '../recovery/page.dart';
import '../routines/page.dart';
import '../search/overlay.dart';
import '../settings/bot_settings.dart';
import '../settings/page.dart';
import '../templates/page.dart';
import '../view/sample_page.dart';
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
  const AppShell({
    super.key,
    required this.api,
    required this.store,
    required this.sessions,
    required this.userId,
    required this.botLinks,
    required this.onSignOut,
  });

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
  ComputerController? computer;
  PackageCatalog? catalog;
  String? error;
  bool loaded = false;
  bool navOpen = false;
  bool panelOpen = false;

  /// Which right-panel entry is on. The region holds two — the Bot's settings
  /// and its Routines — and shows one, because a column is a place to read one
  /// thing rather than a stack of everything a feature registered.
  String panelKey = 'bot-settings';
  bool showHidden = false;
  bool isAdmin = false;
  TranscriptLine? openRun;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
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
        !navOpen &&
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
    _activityTimer?.cancel();
    _activityTimer = null;
    if (appIsAwayV1(state)) return;
    unawaited(activity.load());
    _startPolling();
  }

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

  Future<void> load() async {
    unawaited(_readIdentity());
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
    activity.botNames = {for (final bot in bots) bot.botId.value: _name(bot)};
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
      activity.botNames = {for (final bot in bots) bot.botId.value: _name(bot)};
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
    // The switch is the person's; remembering it is bookkeeping and never
    // delays the pane behind a store write.
    setState(() {
      selected = bot;
      if (switching) selectedConnection = ConnectionState.initializing;
      navOpen = false;
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
    // A firing that finished while the app was open is only ever visible as a
    // count, so the badge is read on this Bot's own signal rather than on a
    // click that may never come.
    slots.register(
      ShellSlot.headerActions,
      'routine-inbox',
      (context) => RoutineInboxBadge(
        controller: inbox,
        onOpen: () => _openPanel('routines'),
      ),
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
  Widget _appletCanvas(
    String botId,
    AppletCanvasController canvas, {
    VoidCallback? onClose,
  }) {
    final session = widget.sessions.open(widget.userId, botId);
    return AnimatedBuilder(
      animation: session.controller,
      builder: (context, _) => AppletCanvas(
        controller: canvas,
        lines: projectRuns(session.controller.runs),
        running: session.controller.activeRunId != null,
        onClose: onClose ?? () => setState(() => panelOpen = false),
      ),
    );
  }

  void _push(Widget page) {
    push.reading(null);
    setState(() => navOpen = false);
    Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => page));
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
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 8, 4, 4),
            child: Row(
              children: [
                Expanded(
                  child: SingleChildScrollView(
                    scrollDirection: Axis.horizontal,
                    child: SegmentedButton<String>(
                      showSelectedIcon: false,
                      segments: [
                        for (final entry in keys)
                          ButtonSegment(
                            value: entry,
                            label: Text(
                              slots.labelOf(ShellSlot.rightPanel, entry) ??
                                  entry,
                            ),
                          ),
                      ],
                      selected: {key},
                      onSelectionChanged: (next) =>
                          setState(() => panelKey = next.first),
                    ),
                  ),
                ),
                identified(
                  ShellIds.rightPanelClose,
                  IconButton(
                    tooltip: 'Close the panel',
                    onPressed: () => setState(() => panelOpen = false),
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

            if (line.id.endsWith(':user') || line.id.contains(':send:'))
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
      _push(
        Scaffold(
          appBar: AppBar(title: const Text('Applet')),
          body: SafeArea(
            top: false,
            child: _appletCanvas(
              bot.botId.value,
              appletCanvas!,
              onClose: () => Navigator.of(context).maybePop(),
            ),
          ),
        ),
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
    _push(
      Scaffold(
        appBar: AppBar(title: const Text('Bot settings')),
        body: SafeArea(
          top: false,
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                BotSettingsView(
                  controller: controller,
                  onSaved: load,
                  background: _background(bot.botId.value),
                  onEditAvatar: () =>
                      unawaited(_editAvatar(bot.botId.value, _name(bot))),
                  dangerZone: _dangerZone(bot.botId.value, _name(bot)),
                ),
                ..._packageSettings(bot.botId.value),
              ],
            ),
          ),
        ),
      ),
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
      selected = null;
    }),
  );

  /// Adding a Bot: the sheet, then the Bot, then the first thing said to it.
  ///
  /// The message is sent through the same session the conversation uses, so a
  /// new Bot's first Turn is admitted exactly as every other one is.
  Future<void> _createBot() async {
    setState(() => navOpen = false);
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
    final bot = selected;
    return ShellSlotScope(
      slots: slots,
      child: ShellLayout(
        header: bot == null
            ? AppBar(
                title: const Text('FrockBot'),
                leading: tier == ShellTier.single
                    ? IconButton(
                        tooltip: 'Your Bots',
                        onPressed: () => setState(() => navOpen = true),
                        icon: const Icon(Icons.menu),
                      )
                    : null,
              )
            : ChatHeader(
                name: _name(bot),
                connection: selectedConnection,
                textScale: MediaQuery.textScalerOf(context).scale(14) / 14,
                background: _background(bot.botId.value),
                onBots: tier == ShellTier.single
                    ? () => setState(() => navOpen = !navOpen)
                    : null,
                onSettings: () => _openPanel('bot-settings'),
                computerRunning:
                    computer?.available == true && computer!.state.running,
                onComputer: computer?.available == true
                    ? () => _openPanel('computer')
                    : null,
                onRoutines: () => _openPanel('routines'),
                applets: [
                  for (final applet in appletCanvas?.directory ?? const [])
                    (
                      label: applet.displayName,
                      onOpen: () => unawaited(_openApplet(applet.appletId)),
                    ),
                ],
                onRetryApplets: appletCanvas?.failure == null
                    ? null
                    : () => unawaited(appletCanvas!.retry()),
              ),
        navOpen: navOpen,
        panelOpen: panelOpen,
        onDismiss: () => setState(() {
          navOpen = false;
          panelOpen = false;
        }),
        rightPanel: _rightPanel(),
        sidebar: Column(
          children: [
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
                activeBotId: bot?.botId.value,
                workingBotId: workingRunId == null ? null : bot?.botId.value,
                loaded: loaded,
                error: error,
                showHidden: showHidden,
                inboxCount: activity.notices.length,
                onSelect: _select,
                onCreateBot: () => unawaited(_createBot()),
                onSearch: _openSearch,
                onProfile: _openProfile,
                onInbox: () => _push(
                  ActivityPage(
                    controller: activity,
                    openBot: _openBotFromInbox,
                  ),
                ),
                onManage: () => _push(
                  BotRecoveryPage(
                    api: widget.api,
                    store: widget.store,
                    userId: widget.userId,
                    changed: load,
                  ),
                ),
                onToggleHidden: () => setState(() => showHidden = !showHidden),
                onRetry: load,
              ),
            ),
          ],
        ),
        conversation: bot == null
            ? NoConversation(
                empty: bots.isEmpty,
                failure: bots.isEmpty ? error : null,
                action: bots.isEmpty || tier != ShellTier.single
                    ? 'Refresh Bots'
                    : 'Your Bots',
                onAction: bots.isEmpty || tier != ShellTier.single
                    ? () => unawaited(load())
                    : () => setState(() => navOpen = true),
              )
            : ConversationView(
                key: ValueKey('${widget.userId}:${bot.botId.value}'),
                sessions: widget.sessions,
                api: widget.api,
                store: widget.store,
                userId: widget.userId,
                botId: bot.botId.value,
                onOpenRun: _openRun,
                onOpenSettings: _openSettings,
                onMessageActions: (line) => unawaited(_messageActions(line)),
                onReadLatest: (messageId) =>
                    _readLatest(bot.botId.value, messageId),
                unreadFromMessageId:
                    activity.unread[bot.botId.value]?.unreadFromMessageId,
                background: _background(bot.botId.value),
                onWorkingChanged: (runId) {
                  if (runId == workingRunId || !mounted) return;
                  final settled = workingRunId != null && runId == null;
                  setState(() => workingRunId = runId);
                  // A Turn is how an Applet comes into existence, and the
                  // header names the Applets the Bot holds — so the directory
                  // is re-read when the Turn that may have changed it ends.
                  // Read on adoption alone, a Bot that had just made its first
                  // Applet had no way to it until the page was reloaded.
                  final canvas = appletCanvas;
                  if (settled && canvas != null) unawaited(canvas.load());
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
    );
  }

  Future<void> _openBotFromInbox(String botId) async {
    await load();
    if (mounted) _select(botId);
  }

  /// Search over every conversation this account has, which is the backend's
  /// index rather than the names the sidebar happens to hold. A chosen hit is
  /// its Bot and its Turn: the shell opens the Bot and the transcript scrolls
  /// to the Turn.
  Future<void> _openSearch() async {
    setState(() => navOpen = false);
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

  void _openSettings() => _push(
    SettingsPage(api: widget.api, store: widget.store, userId: widget.userId),
  );

  /// Account destinations push above Profile, so Back returns here.
  void _openProfile() {
    _push(
      Scaffold(
        appBar: AppBar(title: const Text('Profile')),
        body: identified(
          SettingsIds.profileMenu,
          SafeArea(
            child: SingleChildScrollView(
              child: Center(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 680),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      identified(
                        SettingsIds.profileName,
                        ListTile(
                          leading: const CircleAvatar(
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
                      const Divider(height: 1),
                      Padding(
                        padding: const EdgeInsets.fromLTRB(16, 20, 16, 4),
                        child: Align(
                          alignment: Alignment.centerLeft,
                          child: Text(
                            'Account',
                            style: Theme.of(context).textTheme.titleSmall,
                          ),
                        ),
                      ),
                      identified(
                        SettingsIds.profileSettings,
                        ListTile(
                          leading: const Icon(Icons.settings_outlined),
                          title: const Text('Personal details'),
                          subtitle: const Text(
                            'Your name and optional contact email',
                          ),
                          onTap: () {
                            _openSettings();
                          },
                        ),
                      ),
                      Padding(
                        padding: const EdgeInsets.fromLTRB(16, 20, 16, 4),
                        child: Align(
                          alignment: Alignment.centerLeft,
                          child: Text(
                            'Your Bots’ abilities',
                            style: Theme.of(context).textTheme.titleSmall,
                          ),
                        ),
                      ),
                      identified(
                        SettingsIds.profileModels,
                        ListTile(
                          leading: const Icon(Icons.auto_awesome_rounded),
                          title: const Text('Models'),
                          subtitle: const Text(
                            'Choose a model or connect a provider',
                          ),
                          onTap: () {
                            _push(
                              SettingsPage(
                                api: widget.api,
                                store: widget.store,
                                userId: widget.userId,
                                home: 'models',
                              ),
                            );
                          },
                        ),
                      ),
                      identified(
                        SettingsIds.profileConnections,
                        ListTile(
                          leading: const Icon(Icons.link_outlined),
                          title: const Text('Connected apps'),
                          subtitle: const Text('Services your Bots can use'),
                          onTap: () {
                            _push(
                              ConnectionsPage(
                                api: widget.api,
                                store: widget.store,
                                userId: widget.userId,
                              ),
                            );
                          },
                        ),
                      ),
                      identified(
                        MachineIds.profileEntry,
                        ListTile(
                          leading: const Icon(Icons.computer_outlined),
                          title: const Text('Your computers'),
                          subtitle: const Text(
                            'Computers a Bot may reach, with your approval',
                          ),
                          onTap: () {
                            _push(
                              MachinesPage(
                                api: widget.api,
                                store: widget.store,
                                userId: widget.userId,
                              ),
                            );
                          },
                        ),
                      ),
                      identified(
                        PluginIds.profileEntry,
                        ListTile(
                          leading: const Icon(Icons.extension_outlined),
                          title: const Text('Plugins'),
                          subtitle: const Text(
                            'Extensions that add new abilities',
                          ),
                          onTap: () {
                            _push(
                              PluginsPage(
                                api: widget.api,
                                store: widget.store,
                                userId: widget.userId,
                              ),
                            );
                          },
                        ),
                      ),
                      identified(
                        'profile-capabilities',
                        ListTile(
                          leading: const Icon(Icons.tune_outlined),
                          title: const Text('Bot capabilities'),
                          subtitle: const Text(
                            'Manage optional built-in features for all your Bots',
                          ),
                          onTap: () => _push(
                            PluginsPage(
                              api: widget.api,
                              store: widget.store,
                              userId: widget.userId,
                              capabilities: true,
                            ),
                          ),
                        ),
                      ),
                      const Divider(),
                      Padding(
                        padding: const EdgeInsets.fromLTRB(16, 20, 16, 4),
                        child: Align(
                          alignment: Alignment.centerLeft,
                          child: Text(
                            'Activity & sharing',
                            style: Theme.of(context).textTheme.titleSmall,
                          ),
                        ),
                      ),
                      identified(
                        AuditIds.recoveryEntry,
                        ListTile(
                          leading: const Icon(Icons.history_rounded),
                          title: const Text('Activity & history'),
                          subtitle: const Text('Actions across all your Bots'),
                          onTap: () {
                            _push(
                              AuditPage(
                                api: widget.api,
                                store: widget.store,
                                userId: widget.userId,
                              ),
                            );
                          },
                        ),
                      ),
                      identified(
                        TemplateIds.profileEntry,
                        ListTile(
                          leading: const Icon(Icons.inventory_2_outlined),
                          title: const Text('Bot templates'),
                          subtitle: const Text(
                            'Create a Bot from a template, or share one of yours',
                          ),
                          onTap: () {
                            _push(
                              TemplatesPage(
                                api: widget.api,
                                store: widget.store,
                                userId: widget.userId,
                                botId: selected?.botId.value,
                                botName: selected == null
                                    ? null
                                    : _name(selected!),
                              ),
                            );
                          },
                        ),
                      ),
                      const Divider(),
                      // Admin belongs to the deployment, not to the account, so the
                      // entry is here only for someone the gateway already answers it
                      // for. A non-admin is not offered a door that refuses them.
                      if (isAdmin)
                        identified(
                          AdminIds.profileEntry,
                          ListTile(
                            leading: const Icon(Icons.shield_outlined),
                            title: const Text('Site administration'),
                            subtitle: const Text(
                              'Manage who can join this site',
                            ),
                            onTap: () {
                              _push(AdminPage(api: widget.api));
                            },
                          ),
                        ),
                      // A development build can look at the ViewNode renderer before a
                      // plugin produces a document; the shipped app has no such door.
                      if (developmentAuth)
                        ListTile(
                          leading: const Icon(
                            Icons.dashboard_customize_outlined,
                          ),
                          title: const Text('View sample'),
                          onTap: () {
                            _push(
                              ViewSamplePage(
                                store: widget.store,
                                userId: widget.userId,
                              ),
                            );
                          },
                        ),
                      const Divider(),
                      if (!localDevelopment)
                        identified(
                          SettingsIds.profileSignOut,
                          ListTile(
                            leading: const Icon(Icons.logout),
                            title: const Text('Sign out'),
                            onTap: () {
                              Navigator.of(context).pop();
                              unawaited(
                                push.logout().then((_) => widget.onSignOut()),
                              );
                            },
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
    super.dispose();
  }
}
