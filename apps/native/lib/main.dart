import 'dart:async';
import 'dart:convert';

import 'package:app_links/app_links.dart';
import 'package:flutter/material.dart' hide ConnectionState;

import 'client/auth.dart';
import 'auth/sign_in_page.dart';
import 'ui/chat_pane.dart';
import 'ui/chat_screen.dart';
import 'ui/frock_tokens.dart';
import 'ui/frock_widgets.dart';
import 'ui/gallery.dart';
import 'acceptance_metrics.dart';
import 'client/chat_controller.dart';
import 'client/state_channel.dart';
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
  const FrockBotApp({super.key});
  @override
  State<FrockBotApp> createState() => _FrockBotAppState();
}

class _FrockBotAppState extends State<FrockBotApp> {
  final navigatorKey = GlobalKey<NavigatorState>();
  final scaffoldKey = GlobalKey<ScaffoldState>();
  final LocalStore store = ProtectedStore();
  late final NativeApi api = NativeApi(store);
  late final NativeSignIn auth = NativeSignIn(api, store);
  StreamSubscription<Uri>? links;
  String? userId;
  String? error;
  bool busy = true;
  bool awaitingBrowser = false;
  List<wire.BotRegistration> bots = [];
  wire.BotRegistration? selected;
  @override
  void initState() {
    super.initState();
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
    try {
      if (await auth.accept(uri)) {
        navigatorKey.currentState?.popUntil((route) => route.isFirst);
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

  Future<void> restore() async {
    try {
      final savedSession = await store.read('session');
      if (savedSession == null) return;
      final cachedSession = wire.AuthSessionView.fromJson(
        jsonDecode(savedSession),
      );
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
      await store.write(
        'directory/${identity.userId.value}',
        jsonEncode(directory.toJson()),
      );
      final saved = await store.read('selection.${identity.userId.value}');
      if (mounted) {
        setState(() {
          userId = identity.userId.value;
          bots = directory.bots;
          selected = bots.where((b) => b.botId.value == saved).firstOrNull;
          error = null;
        });
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

  Future<void> select(wire.BotRegistration bot) async {
    await store.write('selection.$userId', bot.botId.value);
    if (mounted) {
      setState(() {
        selected = bot;
      });
    }
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
          onSelect: (bot) {
            unawaited(select(bot));
            scaffoldKey.currentState?.closeDrawer();
          },
          onRefresh: () {
            unawaited(restore());
            scaffoldKey.currentState?.closeDrawer();
          },
          onSignOut: () async {
            try {
              await auth.signOut();
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
          extraActions: [
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
                  api: api,
                  store: store,
                  userId: userId!,
                  botId: selected!.botId.value,
                  botName: selected!.initialName,
                  onActivity: selectedActivity,
                ),
        );
      },
    ),
  );
  @override
  void dispose() {
    unawaited(links?.cancel());
    api.close();
    super.dispose();
  }
}

class ConversationView extends StatefulWidget {
  final NativeApi api;
  final LocalStore store;
  final String userId;
  final String botId;
  final String botName;

  /// Reports what the ring around this Bot's sheep should say.
  final ValueChanged<BotState>? onActivity;
  const ConversationView({
    super.key,
    required this.api,
    required this.store,
    required this.userId,
    required this.botId,
    this.botName = 'your Bot',
    this.onActivity,
  });
  @override
  State<ConversationView> createState() => _ConversationViewState();
}

class _ConversationViewState extends State<ConversationView>
    with WidgetsBindingObserver {
  late final ChatController controller;
  late final BotStateChannel channel;
  List<wire.Conversation> conversations = [];
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    controller = ChatController(
      transport: BackendChatTransport(widget.api),
      store: widget.store,
      userId: widget.userId,
      botId: widget.botId,
    );
    channel = BotStateChannel(
      api: widget.api,
      store: widget.store,
      key: 'cursor/${widget.userId}/${widget.botId}',
      botId: widget.botId,
      invalidate: controller.invalidate,
      status: (state) {
        controller.connection = state;
        controller.changed();
      },
    );
    controller.addListener(report);
    unawaited(start());
  }

  void report() {
    final state = controller.activeRunId != null
        ? BotState.working
        : controller.connection == ConnectionState.connected
        ? BotState.ready
        : BotState.idle;
    widget.onActivity?.call(state);
  }

  Future<void> start() async {
    await controller.initialize();
    try {
      final list = wire.ConversationList.fromJson(
        await widget.api.request(
          '/api/bots/${Uri.encodeComponent(widget.botId)}/conversations',
        ),
      );
      if (mounted) {
        setState(() {
          conversations = list.conversations;
        });
      }
    } catch (_) {
      /* History itself has its own retry state. */
    }
    if (mounted) await channel.connect();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      channel.resume();
    } else {
      channel.pause();
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
              for (final c in conversations)
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
    final current = conversations
        .where((c) => c.conversationId == controller.conversationId)
        .firstOrNull;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (conversations.length > 1)
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
            onReconnect: channel.connect,
            botName: widget.botName,
          ),
        ),
      ],
    );
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    controller.removeListener(report);
    channel.dispose();
    controller.dispose();
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
