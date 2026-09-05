import 'dart:async';
import 'dart:convert';

import 'package:app_links/app_links.dart';
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter/scheduler.dart';

import 'client/auth.dart';
import 'connections/page.dart';
import 'settings/page.dart';
import 'activity/controller.dart';
import 'activity/page.dart';
import 'recovery/page.dart';
import 'auth/sign_in_page.dart';
import 'ui/chat_pane.dart';
import 'ui/bot_page.dart';
import 'ui/chat_screen.dart';
import 'ui/flock_drawer.dart' show lookOf;
import 'ui/frock_tokens.dart';
import 'ui/frock_widgets.dart';
import 'ui/gallery.dart';
import 'voice/audio.dart';
import 'voice/controller.dart';
import 'voice/dictation.dart';
import 'voice/dictation_controller.dart';
import 'voice/page.dart';
import 'voice/session.dart';
import 'acceptance_metrics.dart';
import 'client/bot_sessions.dart';
import 'client/chat_controller.dart';
import 'client/plain_store.dart';
import 'client/transport.dart';
import 'extensions/catalog.dart';
import 'extensions/fallback.dart';
import 'protocol/client_wire.generated.dart' as wire;

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  // Frock UI gallery: `flutter run --dart-define=FROCK_GALLERY=true`.
  if (const bool.fromEnvironment('FROCK_GALLERY')) {
    runApp(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: FrockTokens.themeData(FrockTokens.dark),
        home: const FrockGallery(),
      ),
    );
    return;
  }
  AcceptanceMetrics.instance.start();
  runApp(const FrockBotApp());
}

class FrockBotApp extends StatefulWidget {
  final LocalStore? store;
  const FrockBotApp({super.key, this.store});
  @override
  State<FrockBotApp> createState() => _FrockBotAppState();
}

class _FrockBotAppState extends State<FrockBotApp> with WidgetsBindingObserver {
  final navigatorKey = GlobalKey<NavigatorState>();
  final scaffoldKey = GlobalKey<ScaffoldState>();
  late final LocalStore store = widget.store ?? nativeStore();
  late final NativeApi api = NativeApi(store);
  late final NativeSignIn auth = NativeSignIn(api, store);
  late final BotSessions sessions = BotSessions(api: api, store: store);
  StreamSubscription<Uri>? links;
  ActivityController? activity;
  Timer? activityTimer;
  String? pendingBot;
  String? userId;
  String? error;
  bool busy = true;
  bool awaitingBrowser = false;
  List<wire.BotRegistration> bots = [];
  wire.BotRegistration? selected;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    final appLinks = AppLinks();
    links = appLinks.uriLinkStream.listen(
      (uri) {
        unawaited(accept(uri));
      },
      onError: (Object _) {
        if (mounted) {
          setState(() {
            error = 'Couldn’t open that sign-in link. Please try again.';
          });
        }
      },
    );
    unawaited(restore());
  }

  Future<void> accept(Uri uri) async {
    final target = botLink(uri);
    if (target != null) {
      pendingBot = target;
      if (userId != null) await followBotLink();
      return;
    }
    // Coming back from a service's own sign-in. Nothing to exchange: the
    // server has already recorded the outcome, so the app only has to show
    // Connect again and say how it went.
    final outcome = connectionReturn(uri);
    if (outcome != null) {
      openConnections(outcome);
      return;
    }
    try {
      if (await auth.accept(uri)) {
        navigatorKey.currentState?.popUntil((route) => route.isFirst);
        sessions.clear();
        clearActivity();
        if (mounted) {
          setState(() {
            userId = null;
            selected = null;
            bots = [];
          });
        }
        await restore();
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          error = 'Couldn’t finish signing in. Please try again.';
          busy = false;
        });
      }
    }
  }

  /// Connect, reopened on the outcome the browser handed back.
  void openConnections(String outcome) {
    final navigator = navigatorKey.currentState;
    final user = userId;
    if (navigator == null || user == null) return;
    navigator.popUntil((route) => route.isFirst);
    unawaited(
      navigator.push(
        MaterialPageRoute<void>(
          builder: (_) => ConnectionsPage(
            api: api,
            userId: user,
            store: store,
            outcome: outcome,
          ),
        ),
      ),
    );
  }

  Future<void> restore() async {
    try {
      final savedSession = await store.read('session');
      if (savedSession == null) return;
      final cachedSession = wire.AuthSessionView.fromJson(
        jsonDecode(savedSession),
      );
      api.adoptSession(savedSession);
      final cachedDirectory = await store.read(
        'directory/${cachedSession.userId.value}',
      );
      if (cachedDirectory != null && userId == null) {
        final cached = wire.BotDirectory.fromJson(jsonDecode(cachedDirectory));
        final saved = await store.read(
          'selection.${cachedSession.userId.value}',
        );
        if (mounted) {
          setState(() {
            userId = cachedSession.userId.value;
            bots = cached.bots;
            selected = bots
                .where((bot) => bot.botId.value == saved)
                .firstOrNull;
            busy = false;
          });
        }
      }

      final identity = wire.AuthIdentity.fromJson(
        await api.request('/api/identity'),
      );
      final directory = wire.BotDirectory.fromJson(
        await api.request('/api/bots'),
      );
      final lifecycle = wire.BotLifecycleDirectory.fromJson(
        await api.request('/api/bots/lifecycles'),
      );
      final unavailable = lifecycle.lifecycles
          .where((state) => state.status != 'active')
          .map((state) => state.botId.value)
          .toSet();
      final activeBots = directory.bots
          .where((bot) => !unavailable.contains(bot.botId.value))
          .toList();
      for (final prior in bots) {
        if (!activeBots.any((bot) => bot.botId.value == prior.botId.value)) {
          sessions.forget(identity.userId.value, prior.botId.value);
        }
      }
      await store.write(
        'directory/${identity.userId.value}',
        jsonEncode({
          ...directory.toJson() as Map,
          'bots': [for (final bot in activeBots) bot.toJson()],
        }),
      );
      final saved = await store.read('selection.${identity.userId.value}');
      if (mounted) {
        setState(() {
          userId = identity.userId.value;
          bots = activeBots;
          selected = bots.where((b) => b.botId.value == saved).firstOrNull;
          error = null;
        });
        bindActivity(identity.userId.value);
        if (pendingBot != null) unawaited(followBotLink());
        unawaited(
          sessions.prefetch(identity.userId.value, [
            for (final bot in activeBots) bot.botId.value,
          ], after: selected?.botId.value),
        );
      }
    } catch (failure) {
      if (mounted) {
        setState(() {
          error = failure is RequestFailure
              ? failure.message
              : 'Couldn’t load your Bots. Please try again.';
        });
      }
    } finally {
      if (mounted) {
        setState(() {
          busy = false;
        });
      }
    }
  }

  void activityChanged() {
    if (mounted) setState(() {});
  }

  void clearActivity() {
    activityTimer?.cancel();
    activityTimer = null;
    activity?.removeListener(activityChanged);
    activity?.dispose();
    activity = null;
  }

  void bindActivity(String owner) {
    if (activity?.userId == owner) {
      activity!.botNames = {
        for (final bot in bots) bot.botId.value: bot.initialName,
      };
      return;
    }
    clearActivity();
    activity = ActivityController(api, store, owner)
      ..addListener(activityChanged);
    activity!.botNames = {
      for (final bot in bots) bot.botId.value: bot.initialName,
    };
    unawaited(activity!.load());
    activityTimer = Timer.periodic(
      const Duration(seconds: 10),
      (_) => unawaited(activity?.load()),
    );
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    activityTimer?.cancel();
    activityTimer = null;
    if (state == AppLifecycleState.resumed) {
      unawaited(activity?.load());
      activityTimer = Timer.periodic(
        const Duration(seconds: 10),
        (_) => unawaited(activity?.load()),
      );
    }
  }

  Future<void> openBot(String botId) async {
    final owner = userId;
    if (owner == null) return;
    final directory = wire.BotDirectory.fromJson(
      await api.request('/api/bots'),
    );
    if (!mounted || userId != owner) return;
    final lifecycle = wire.BotLifecycleDirectory.fromJson(
      await api.request('/api/bots/lifecycles'),
    );
    if (!mounted || userId != owner) return;
    final unavailable = lifecycle.lifecycles
        .where((state) => state.status != 'active')
        .map((state) => state.botId.value)
        .toSet();
    final active = directory.bots
        .where((bot) => !unavailable.contains(bot.botId.value))
        .toList();
    final bot = active.where((b) => b.botId.value == botId).firstOrNull;
    if (bot == null) throw const FormatException('Unavailable Bot');
    navigatorKey.currentState?.popUntil((route) => route.isFirst);
    setState(() => bots = active);
    select(bot);
  }

  Future<void> followBotLink() async {
    final botId = pendingBot;
    pendingBot = null;
    if (botId == null) return;
    try {
      await openBot(botId);
    } catch (_) {
      final context = scaffoldKey.currentContext;
      if (context != null && context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text(
              'That Bot isn’t available. Refresh your Bots and try again.',
            ),
          ),
        );
      }
    }
  }

  Future<void> signIn() async {
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await auth.start();
      if (mounted) setState(() => awaitingBrowser = true);
    } catch (failure) {
      if (mounted) {
        setState(() {
          error = failure is RequestFailure
              ? failure.message
              : 'Couldn’t open sign-in. Please try again.';
        });
      }
    } finally {
      if (mounted) {
        setState(() {
          busy = false;
        });
      }
    }
  }

  void select(wire.BotRegistration bot) {
    // The switch is the User's; remembering it is bookkeeping and never delays
    // the pane behind a store write.
    setState(() {
      selected = bot;
    });
    unawaited(
      store.write('selection.$userId', bot.botId.value).catchError((Object _) {
        /* A selection that could not be remembered still switched. */
      }),
    );
  }

  /// Dictation for the composer's mic, made once and kept: it owns the
  /// microphone, and a new one per rebuild would fight the old one for it.
  DictationController? _dictation;
  DictationController get dictation => _dictation ??= DictationController(
    backend: BackendDictation(api),
    audio: DeviceVoiceAudio(),
  );

  /// Voice is the whole screen: a route, not a sheet over the conversation.
  Future<void> openVoice(BuildContext context) async {
    final look = selected == null ? null : lookOf(selected!.sheep);
    final navigator = Navigator.of(context);
    final controller = VoiceController(
      backend: BackendVoice(api),
      audio: DeviceVoiceAudio(),
      deviceId: await voiceDeviceId(store),
    );
    await navigator.push(
      MaterialPageRoute<void>(
        builder: (_) => VoicePage(
          controller: controller,
          botLook: look,
          lookOfBot: (id) {
            for (final bot in bots) {
              if (bot.botId.value == id) return lookOf(bot.sheep);
            }
            return null;
          },
        ),
      ),
    );
    controller.dispose();
  }

  BotState selectedState = BotState.none;

  void selectedActivity(BotState state) {
    if (state == selectedState || !mounted) return;
    setState(() => selectedState = state);
  }

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'FrockBot',
    navigatorKey: navigatorKey,
    debugShowCheckedModeBanner: false,
    theme: FrockTokens.themeData(FrockTokens.light),
    darkTheme: FrockTokens.themeData(FrockTokens.dark),
    themeMode: ThemeMode.dark,
    home: Builder(
      builder: (context) {
        if (userId == null) {
          return SignInPage(
            busy: busy,
            awaitingBrowser: awaitingBrowser,
            error: error,
            onSignIn: signIn,
          );
        }
        final wide =
            MediaQuery.sizeOf(context).width >= ChatScreen.wideBreakpoint;
        return ChatScreen(
          scaffoldKey: scaffoldKey,
          bots: bots,
          selected: selected,
          selectedState: selectedState,
          onBotTap: selected == null
              ? null
              : () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) => BotPage(
                      bot: selected!,
                      state: selectedState,
                      controller: sessions
                          .open(userId!, selected!.botId.value)
                          .controller,
                    ),
                  ),
                ),
          onSelect: (bot) {
            select(bot);
            scaffoldKey.currentState?.closeDrawer();
          },
          onRefresh: () {
            unawaited(restore());
            scaffoldKey.currentState?.closeDrawer();
          },
          onSignOut: () async {
            try {
              await auth.signOut();
              sessions.clear();
              if (mounted) {
                setState(() {
                  userId = null;
                  selected = null;
                  bots = [];
                });
              }
            } catch (_) {
              if (mounted) {
                setState(() {
                  error = 'Couldn’t sign out. Please reconnect and try again.';
                });
              }
            }
          },
          onApplets: () => Navigator.of(context).push(
            MaterialPageRoute<void>(
              builder: (_) => AppletDirectoryPage(api: api, userId: userId!),
            ),
          ),
          onManageBots: () {
            scaffoldKey.currentState?.closeDrawer();
            Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => BotRecoveryPage(
                  api: api,
                  store: store,
                  userId: userId!,
                  changed: restore,
                ),
              ),
            );
          },
          onSettings: () {
            scaffoldKey.currentState?.closeDrawer();
            Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) =>
                    SettingsPage(api: api, store: store, userId: userId!),
              ),
            );
          },
          onInbox: activity == null
              ? null
              : () {
                  scaffoldKey.currentState?.closeDrawer();
                  Navigator.of(context).push(
                    MaterialPageRoute<void>(
                      builder: (_) =>
                          ActivityPage(controller: activity!, openBot: openBot),
                    ),
                  );
                },
          inboxCount: activity?.notices.length ?? 0,
          unreadOf: (id) => activity?.unread[id],
          // Gemini Live is app-wide, so it lives in the bar and stays there
          // with no Bot chosen. The composer's mic dictates.
          onVoice: () => unawaited(openVoice(context)),
          extraActions: [
            if (selected != null && activity != null)
              FrockIconButton(
                activity!.unread[selected!.botId.value]?.unread == true
                    ? Icons.mark_chat_read_outlined
                    : Icons.mark_chat_unread_outlined,
                key: const ValueKey('mark-read'),
                semanticLabel:
                    activity!.unread[selected!.botId.value]?.unread == true
                    ? 'Mark as read'
                    : 'Mark as unread',
                onTap: activity!.saving || activity!.pending
                    ? null
                    : () => activity!.mark(
                        selected!.botId.value,
                        read:
                            activity!.unread[selected!.botId.value]?.unread ==
                            true,
                      ),
              ),
            if (const bool.fromEnvironment('NATIVE_ACCEPTANCE'))
              FrockIconButton(
                Icons.dynamic_form_outlined,
                semanticLabel: 'Form preview',
                onTap: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) => FormPreview(api: api, store: store),
                  ),
                ),
              ),
          ],
          body: selected == null
              ? ChatEmpty(
                  title: bots.isEmpty ? 'No Bots yet' : 'Choose a Bot to begin',
                  detail: bots.isEmpty
                      ? 'Your Bots will appear here once they’re created.'
                      : 'Pick a Bot from your list to catch up or start something new.',
                  action: bots.isEmpty || wide ? 'Refresh Bots' : 'Your Bots',
                  onAction: bots.isEmpty || wide
                      ? () => unawaited(restore())
                      : () => scaffoldKey.currentState?.openDrawer(),
                )
              : ConversationView(
                  key: ValueKey('$userId:${selected!.botId.value}'),
                  sessions: sessions,
                  userId: userId!,
                  botId: selected!.botId.value,
                  botName: selected!.initialName,
                  botLook: lookOf(selected!.sheep),
                  onActivity: selectedActivity,
                  dictation: dictation,
                ),
        );
      },
    ),
  );
  @override
  void dispose() {
    unawaited(links?.cancel());
    _dictation?.dispose();
    WidgetsBinding.instance.removeObserver(this);
    clearActivity();
    sessions.clear();
    api.close();
    super.dispose();
  }
}

class ConversationView extends StatefulWidget {
  final BotSessions sessions;
  final String userId;
  final String botId;
  final String botName;
  final SheepLook botLook;

  /// Reports what the ring around this Bot's sheep should say.
  final ValueChanged<BotState>? onActivity;

  /// Dictation for the composer's mic; Voice itself is in the top bar.
  final DictationController? dictation;
  const ConversationView({
    super.key,
    required this.sessions,
    required this.userId,
    required this.botId,
    this.botName = 'your Bot',
    this.botLook = SheepLook.plain,
    this.onActivity,
    this.dictation,
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
  ChatController get controller => session.controller;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    controller.addListener(update);
    unawaited(session.start());
    // The ring is right from the first frame, not from the first change.
    WidgetsBinding.instance.addPostFrameCallback((_) => report());
  }

  void update() {
    if (!mounted) return;
    setState(() {});
    report();
  }

  void report() {
    final state = controller.activeRunId != null
        ? BotState.working
        : controller.connection == ConnectionState.connected
        ? BotState.ready
        : BotState.idle;
    // A notification can land mid-build (the resident store makes the
    // controller ready synchronously), and the ring lives in a parent.
    if (SchedulerBinding.instance.schedulerPhase == SchedulerPhase.idle) {
      widget.onActivity?.call(state);
    } else {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) widget.onActivity?.call(state);
      });
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      widget.sessions.resume();
    } else {
      widget.sessions.pause();
    }
  }

  Future<void> pickConversation() async {
    final t = FrockTokens.of(context);
    final id = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: t.sheet,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(
          top: Radius.circular(FrockTokens.radiusSheet),
        ),
      ),
      builder: (context) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(
            FrockTokens.edge,
            16,
            FrockTokens.edge,
            8,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const FrockEyebrow('Conversations'),
              const SizedBox(height: FrockTokens.eyebrowToGroup),
              for (final c in session.conversations)
                FrockRow(
                  title: 'Conversation ${c.ordinal}',
                  trailing: c.conversationId == controller.conversationId
                      ? Icon(
                          Icons.check_rounded,
                          size: FrockTokens.icon,
                          color: t.accent,
                        )
                      : null,
                  onTap: () => Navigator.pop(context, c.conversationId),
                ),
            ],
          ),
        ),
      ),
    );
    if (id == null || !mounted) return;
    await controller.selectConversation(id);
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final current = session.conversations
        .where((c) => c.conversationId == controller.conversationId)
        .firstOrNull;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (session.conversations.length > 1)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Row(
              children: [
                FrockPill(
                  current == null
                      ? 'Current conversation'
                      : 'Conversation ${current.ordinal}',
                  kind: PillKind.ghost,
                  size: PillSize.sm,
                  icon: Icons.expand_more_rounded,
                  onTap: pickConversation,
                ),
              ],
            ),
          ),
        Expanded(
          child: ChatPane(
            controller: controller,
            onReconnect: session.channel.connect,
            botName: widget.botName,
            botLook: widget.botLook,
            dictation: widget.dictation,
          ),
        ),
      ],
    );
  }

  @override
  void dispose() {
    // The session outlives this view so that switching back to this Bot is a
    // lookup rather than a reconnection.
    WidgetsBinding.instance.removeObserver(this);
    controller.removeListener(update);
    super.dispose();
  }
}

class FormPreview extends StatefulWidget {
  final NativeApi api;
  final LocalStore store;
  const FormPreview({super.key, required this.api, required this.store});
  @override
  State<FormPreview> createState() => _FormPreviewState();
}

class _FormPreviewState extends State<FormPreview> {
  bool hostile = false;
  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Form preview')),
    body: SingleChildScrollView(
      padding: const EdgeInsets.all(20),
      child: Column(
        children: [
          CatalogRegion(
            document: hostile
                ? [
                    {
                      'id': 'root',
                      'component': 'Column',
                      'children': ['root'],
                    },
                  ]
                : deterministicForm,
            submit: (input) async {
              final sessionJson = await widget.store.read('session');
              if (sessionJson == null) {
                throw const RequestFailure('Sign in to save.');
              }
              final user = wire.AuthSessionView.fromJson(
                jsonDecode(sessionJson),
              ).userId.value;
              final key = 'form-command/$user';
              final saved = await widget.store.read(key);
              Map<String, dynamic>? prior = saved == null
                  ? null
                  : jsonDecode(saved) as Map<String, dynamic>;
              Future<void> submit(Map<String, dynamic> command) async {
                final value = await widget.api.request(
                  '/api/native/qualification-form',
                  body: command,
                );
                if (value is! Map ||
                    value['schemaVersion'] != 1 ||
                    value['commandId'] != command['commandId'] ||
                    value['status'] != 'saved') {
                  throw const FormatException('Invalid save receipt');
                }
              }

              if (prior != null) {
                // First reconcile any uncertain earlier save, under its old id.
                await submit(prior);
                if (jsonEncode(prior['input']) == jsonEncode(input)) return;
              }
              final command = <String, dynamic>{
                'schemaVersion': 1,
                'commandId': randomId(),
                'surfaceId': 'qualification',
                'revision': 1,
                'input': input,
              };
              await widget.store.write(key, jsonEncode(command));
              await submit(command);
            },
          ),
          TextButton(
            onPressed: () => setState(() {
              hostile = !hostile;
            }),
            child: Text(
              hostile ? 'Show sample form' : 'Check unavailable form',
            ),
          ),
        ],
      ),
    ),
  );
}
