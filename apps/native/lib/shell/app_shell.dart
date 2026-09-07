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
import 'package:flutter/material.dart';

import '../activity/controller.dart';
import '../activity/page.dart';
import '../admin/page.dart';
import '../client/auth.dart' show developmentAuth;
import '../client/bot_sessions.dart';
import '../client/transport.dart';
import '../connections/page.dart';
import '../extensions/fallback.dart';
import '../plugins/page.dart';
import '../recovery/page.dart';
import '../settings/bot_settings.dart';
import '../settings/page.dart';
import '../theme/states.dart';
import '../view/sample_page.dart';
import '../protocol/client_wire.generated.dart' as wire;
import 'chat_pane.dart';
import 'desktop_layout.dart';
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
  late final ActivityController activity = ActivityController(
    widget.api,
    widget.store,
    widget.userId,
  );
  Timer? _activityTimer;
  List<wire.BotRegistration> bots = [];
  Map<String, SidebarProfile> profiles = {};
  Set<String> archived = {};
  wire.BotRegistration? selected;
  String? workingRunId;
  BotSettingsController? botSettings;
  String? error;
  bool loaded = false;
  bool navOpen = false;
  bool panelOpen = false;
  bool showHidden = false;
  bool isAdmin = false;
  TranscriptLine? openRun;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    activity.addListener(_repaint);
    widget.botLinks.addListener(_followBotLink);
    unawaited(load());
    _startPolling();
  }

  void _repaint() {
    if (mounted) setState(() {});
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
    _activityTimer?.cancel();
    _activityTimer = null;
    if (state == AppLifecycleState.resumed) {
      unawaited(activity.load());
      _startPolling();
    }
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
    setState(() => selected = bot);
    _adoptBotSettings(bot.botId.value);
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
    final bot = bots.where((bot) => bot.botId.value == botId).firstOrNull;
    if (bot == null) return;
    // The switch is the person's; remembering it is bookkeeping and never
    // delays the pane behind a store write.
    setState(() {
      selected = bot;
      navOpen = false;
      openRun = null;
      panelOpen = false;
    });
    _adoptBotSettings(botId);
    unawaited(
      widget.store
          .write('selection.${widget.userId}', botId)
          .catchError((Object _) {}),
    );
  }

  /// The Bot's own settings are a feature in the `right-panel` region, which is
  /// how the Vue shell mounts them too: the shell draws the region and never
  /// imports the panel's contents.
  void _adoptBotSettings(String botId) {
    botSettings?.dispose();
    final controller = BotSettingsController(widget.api, botId);
    botSettings = controller;
    slots.register(
      ShellSlot.rightPanel,
      'bot-settings',
      (context) => BotSettingsView(
        controller: controller,
        onClose: () => setState(() => panelOpen = false),
        onSaved: load,
      ),
    );
    unawaited(controller.load());
  }

  void _push(Widget page) {
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
    return slots.filled(ShellSlot.rightPanel)
        ? const SingleChildScrollView(
            padding: EdgeInsets.all(16),
            child: SlotRegion(ShellSlot.rightPanel),
          )
        : null;
  }

  @override
  Widget build(BuildContext context) {
    final tier = shellTierForWidth(MediaQuery.sizeOf(context).width);
    final bot = selected;
    return ShellSlotScope(
      slots: slots,
      child: Scaffold(
        appBar: AppBar(
          leading: tier == ShellTier.single
              ? identified(
                  ShellIds.sidebarToggle,
                  IconButton(
                    tooltip: 'Your Bots',
                    onPressed: () => setState(() => navOpen = !navOpen),
                    icon: const Icon(Icons.menu),
                  ),
                )
              : null,
          title: Text(bot == null ? 'FrockBot' : _name(bot)),
          actions: [
            const SlotRegion(
              ShellSlot.headerActions,
              direction: Axis.horizontal,
            ),
            if (bot != null)
              PopupMenuButton<String>(
                tooltip: 'Conversation actions',
                enabled: !activity.saving && !activity.pending,
                onSelected: (value) =>
                    activity.mark(bot.botId.value, read: value == 'read'),
                itemBuilder: (_) => [
                  if (activity.unread[bot.botId.value]?.lastActivityCursor !=
                      null)
                    const PopupMenuItem(
                      value: 'read',
                      child: Text('Mark as read'),
                    ),
                  const PopupMenuItem(
                    value: 'unread',
                    child: Text('Mark as unread'),
                  ),
                ],
              ),
            // The Applet fallback is a WebView, which the browser has no
            // implementation of; the web client reaches an Applet directly.
            if (!kIsWeb)
              IconButton(
                tooltip: 'Your Applets',
                icon: const Icon(Icons.widgets_outlined),
                onPressed: () => _push(
                  AppletDirectoryPage(api: widget.api, userId: widget.userId),
                ),
              ),
            if (bot != null && tier != ShellTier.triple)
              identified(
                ShellIds.botPanelToggle,
                IconButton(
                  tooltip: openRun == null ? 'Bot settings' : 'Work',
                  onPressed: _rightPanel() == null
                      ? null
                      : tier == ShellTier.single && openRun == null
                      ? _pushBotSettings
                      : () => setState(() => panelOpen = !panelOpen),
                  icon: Icon(
                    openRun == null
                        ? Icons.settings_outlined
                        : Icons.view_sidebar_outlined,
                  ),
                ),
              ),
          ],
        ),
        body: SafeArea(
          child: ShellLayout(
            navOpen: navOpen,
            panelOpen: panelOpen,
            onDismiss: () => setState(() {
              navOpen = false;
              panelOpen = false;
            }),
            rightPanel: _rightPanel(),
            sidebar: ShellSidebar(
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
              onCreateBot: () => _push(
                BotRecoveryPage(
                  api: widget.api,
                  store: widget.store,
                  userId: widget.userId,
                  changed: load,
                ),
              ),
              onSearch: () => showSearch<void>(
                context: context,
                delegate: _BotSearch(
                  bots: bots,
                  name: _name,
                  onSelect: _select,
                ),
              ),
              onProfile: _openProfile,
              onInbox: () => _push(
                ActivityPage(controller: activity, openBot: _openBotFromInbox),
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
            conversation: bot == null
                ? NoConversation(
                    empty: bots.isEmpty,
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
                    onWorkingChanged: (runId) {
                      if (runId != workingRunId && mounted) {
                        setState(() => workingRunId = runId);
                      }
                    },
                  ),
          ),
        ),
      ),
    );
  }

  Future<void> _openBotFromInbox(String botId) async {
    await load();
    if (mounted) _select(botId);
  }

  /// On the phone the panel is a page: a drawer over a full-width conversation
  /// is the same thing with less room and a scrim in the way.
  void _pushBotSettings() {
    final controller = botSettings;
    if (controller == null) return;
    _push(
      Scaffold(
        appBar: AppBar(title: const Text('Bot settings')),
        body: SafeArea(
          top: false,
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
            child: BotSettingsView(controller: controller, onSaved: load),
          ),
        ),
      ),
    );
  }

  void _openSettings() => _push(
    SettingsPage(api: widget.api, store: widget.store, userId: widget.userId),
  );

  /// The profile sheet: who is signed in, and the account surfaces reachable
  /// from where the User already is. The Vue trigger's menu, on the phone's
  /// terms — the account's own settings are one entry, not five.
  void _openProfile() {
    setState(() => navOpen = false);
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (sheet) => identified(
        SettingsIds.profileMenu,
        SafeArea(
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
              identified(
                SettingsIds.profileSettings,
                ListTile(
                  leading: const Icon(Icons.settings_outlined),
                  title: const Text('Settings'),
                  onTap: () {
                    Navigator.of(sheet).pop();
                    _openSettings();
                  },
                ),
              ),
              identified(
                SettingsIds.profileModels,
                ListTile(
                  leading: const Icon(Icons.auto_awesome_rounded),
                  title: const Text('Models'),
                  onTap: () {
                    Navigator.of(sheet).pop();
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
                  title: const Text('Connectors'),
                  onTap: () {
                    Navigator.of(sheet).pop();
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
                PluginIds.profileEntry,
                ListTile(
                  leading: const Icon(Icons.extension_outlined),
                  title: const Text('Plugins'),
                  onTap: () {
                    Navigator.of(sheet).pop();
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
              // Admin belongs to the deployment, not to the account, so the
              // entry is here only for someone the gateway already answers it
              // for. A non-admin is not offered a door that refuses them.
              if (isAdmin)
                identified(
                  AdminIds.profileEntry,
                  ListTile(
                    leading: const Icon(Icons.shield_outlined),
                    title: const Text('Admin'),
                    onTap: () {
                      Navigator.of(sheet).pop();
                      _push(AdminPage(api: widget.api));
                    },
                  ),
                ),
              // A development build can look at the ViewNode renderer before a
              // plugin produces a document; the shipped app has no such door.
              if (developmentAuth)
                ListTile(
                  leading: const Icon(Icons.dashboard_customize_outlined),
                  title: const Text('View sample'),
                  onTap: () {
                    Navigator.of(sheet).pop();
                    _push(
                      ViewSamplePage(
                        store: widget.store,
                        userId: widget.userId,
                      ),
                    );
                  },
                ),
              ListTile(
                leading: const Icon(Icons.refresh),
                title: const Text('Refresh'),
                onTap: () {
                  Navigator.of(sheet).pop();
                  unawaited(load());
                },
              ),
              identified(
                SettingsIds.profileSignOut,
                ListTile(
                  leading: const Icon(Icons.logout),
                  title: const Text('Sign out'),
                  onTap: () {
                    Navigator.of(sheet).pop();
                    unawaited(widget.onSignOut());
                  },
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// The saved profile name, falling back to the account this session holds.
  /// A name is a courtesy: a read that fails leaves the sheet usable.
  Future<String> _displayName() async {
    try {
      final settings =
          (await widget.api.request('/api/settings?view=2'))! as Map;
      final name = (settings['profile'] as Map?)?['name'];
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
    botSettings?.dispose();
    slots.dispose();
    super.dispose();
  }
}

/// Search over the Bot list. It is a read of what the sidebar already holds,
/// which is what makes it available before any network answer.
class _BotSearch extends SearchDelegate<void> {
  final List<wire.BotRegistration> bots;
  final String Function(wire.BotRegistration) name;
  final void Function(String botId) onSelect;
  _BotSearch({required this.bots, required this.name, required this.onSelect});

  List<wire.BotRegistration> get _matches => [
    for (final bot in bots)
      if (name(bot).toLowerCase().contains(query.trim().toLowerCase())) bot,
  ];

  @override
  List<Widget> buildActions(BuildContext context) => [
    IconButton(onPressed: () => query = '', icon: const Icon(Icons.clear)),
  ];

  @override
  Widget buildLeading(BuildContext context) => IconButton(
    onPressed: () => close(context, null),
    icon: const Icon(Icons.arrow_back),
  );

  @override
  Widget buildResults(BuildContext context) => buildSuggestions(context);

  @override
  Widget buildSuggestions(BuildContext context) {
    final matches = _matches;
    if (matches.isEmpty) {
      return FrockEmptyState(
        title: 'Nothing matched',
        detail: 'No Bot’s name contains “$query”.',
        action: 'Clear',
        onAction: () => query = '',
        icon: Icons.search_off,
      );
    }
    return ListView(
      children: [
        for (final bot in matches)
          ListTile(
            title: Text(name(bot)),
            onTap: () {
              onSelect(bot.botId.value);
              close(context, null);
            },
          ),
      ],
    );
  }
}
