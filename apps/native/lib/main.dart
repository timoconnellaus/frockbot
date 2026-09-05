import 'dart:async';
import 'dart:convert';

import 'package:app_links/app_links.dart';
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter/services.dart';

import 'client/auth.dart';
import 'acceptance_metrics.dart';
import 'client/chat_controller.dart';
import 'client/state_channel.dart';
import 'client/transport.dart';
import 'extensions/catalog.dart';
import 'extensions/fallback.dart';
import 'protocol/client_wire.generated.dart' as wire;

void main() {
  WidgetsFlutterBinding.ensureInitialized();
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
  final LocalStore store = ProtectedStore();
  late final NativeApi api = NativeApi(store);
  late final NativeSignIn auth = NativeSignIn(api, store);
  StreamSubscription<Uri>? links;
  String? userId;
  String? error;
  bool busy = true;
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

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'FrockBot',
    navigatorKey: navigatorKey,
    debugShowCheckedModeBanner: false,
    theme: ThemeData(
      useMaterial3: true,
      brightness: Brightness.dark,
      scaffoldBackgroundColor: const Color(0xff1f1e24),
      colorScheme:
          ColorScheme.fromSeed(
            seedColor: const Color(0xffec386b),
            brightness: Brightness.dark,
          ).copyWith(
            primary: const Color(0xffec386b),
            surface: const Color(0xff211f26),
          ),
      inputDecorationTheme: const InputDecorationTheme(
        border: OutlineInputBorder(),
      ),
    ),
    home: Builder(
      builder: (context) {
        if (userId == null) {
          return Scaffold(
            appBar: AppBar(title: const Text('FrockBot')),
            body: Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 440),
                child: Padding(
                  padding: const EdgeInsets.all(28),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      const Icon(Icons.auto_awesome_rounded, size: 56),
                      const SizedBox(height: 24),
                      const Text(
                        'Your Bots, with you.',
                        style: TextStyle(
                          fontSize: 28,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      const SizedBox(height: 12),
                      const Text('Sign in to pick up your conversations.'),
                      const SizedBox(height: 28),
                      FilledButton.icon(
                        key: const ValueKey('sign-in'),
                        onPressed: busy ? null : signIn,
                        icon: const Icon(Icons.open_in_new),
                        label: const Text('Continue with Google'),
                      ),
                      if (error != null)
                        Padding(
                          padding: const EdgeInsets.only(top: 16),
                          child: Text(error!),
                        ),
                      const SizedBox(height: 16),
                      TextButton(
                        onPressed: () => Navigator.of(context).push(
                          MaterialPageRoute<void>(
                            builder: (_) => FormPreview(api: api, store: store),
                          ),
                        ),
                        child: const Text('Open form preview'),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          );
        }
        final directory = ListView(
          children: [
            const Padding(
              padding: EdgeInsets.all(16),
              child: Text(
                'Your Bots',
                style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold),
              ),
            ),
            for (final bot in bots)
              ListTile(
                key: ValueKey('bot-${bot.botId.value}'),
                leading: const CircleAvatar(
                  child: Icon(Icons.smart_toy_outlined),
                ),
                title: Text(bot.initialName),
                selected: bot.botId.value == selected?.botId.value,
                onTap: () {
                  unawaited(select(bot));
                  if (MediaQuery.sizeOf(context).width < 800) {
                    Navigator.pop(context);
                  }
                },
              ),
            ListTile(
              leading: const Icon(Icons.refresh),
              title: const Text('Refresh'),
              onTap: restore,
            ),
            ListTile(
              leading: const Icon(Icons.logout),
              title: const Text('Sign out'),
              onTap: () async {
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
                      error =
                          'Couldn’t sign out. Please reconnect and try again.';
                    });
                  }
                }
              },
            ),
          ],
        );
        final wide = MediaQuery.sizeOf(context).width >= 800;
        return Scaffold(
          appBar: AppBar(
            title: Text(selected?.initialName ?? 'FrockBot'),
            actions: [
              IconButton(
                tooltip: 'Your Applets',
                icon: const Icon(Icons.widgets_outlined),
                onPressed: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) =>
                        AppletDirectoryPage(api: api, userId: userId!),
                  ),
                ),
              ),
              IconButton(
                tooltip: 'Form preview',
                onPressed: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) => FormPreview(api: api, store: store),
                  ),
                ),
                icon: const Icon(Icons.dynamic_form_outlined),
              ),
            ],
          ),
          drawer: wide ? null : Drawer(child: SafeArea(child: directory)),
          body: SafeArea(
            child: Row(
              children: [
                if (wide) SizedBox(width: 260, child: directory),
                Expanded(
                  child: selected == null
                      ? const Center(child: Text('Choose a Bot to begin.'))
                      : ConversationView(
                          key: ValueKey('$userId:${selected!.botId.value}'),
                          api: api,
                          store: store,
                          userId: userId!,
                          botId: selected!.botId.value,
                        ),
                ),
              ],
            ),
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
  const ConversationView({
    super.key,
    required this.api,
    required this.store,
    required this.userId,
    required this.botId,
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
    unawaited(start());
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

  @override
  Widget build(BuildContext context) => Column(
    children: [
      if (conversations.length > 1)
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: DropdownButton<String>(
            isExpanded: true,
            value: controller.conversationId,
            hint: const Text('Current conversation'),
            items: conversations
                .map(
                  (c) => DropdownMenuItem(
                    value: c.conversationId,
                    child: Text('Conversation ${c.ordinal}'),
                  ),
                )
                .toList(),
            onChanged: (id) async {
              await controller.selectConversation(id);
              if (mounted) setState(() {});
            },
          ),
        ),
      Expanded(
        child: ChatPane(controller: controller, onReconnect: channel.connect),
      ),
    ],
  );
  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    channel.dispose();
    controller.dispose();
    super.dispose();
  }
}

class ChatPane extends StatefulWidget {
  final ChatController controller;
  final Future<void> Function() onReconnect;
  const ChatPane({
    super.key,
    required this.controller,
    required this.onReconnect,
  });
  @override
  State<ChatPane> createState() => _ChatPaneState();
}

class _ChatPaneState extends State<ChatPane> {
  final editor = TextEditingController();
  final focus = FocusNode();
  @override
  void initState() {
    super.initState();
    editor.text = widget.controller.draft;
    widget.controller.addListener(update);
  }

  void update() {
    if (!mounted) return;
    if (editor.text != widget.controller.draft &&
        !editor.value.composing.isValid) {
      editor.text = widget.controller.draft;
    }
    setState(() {});
    if (widget.controller.ready) AcceptanceMetrics.instance.editableShown();
  }

  Future<void> send() async {
    if (editor.value.composing.isValid && !editor.value.composing.isCollapsed) {
      return;
    }
    await widget.controller.send(editor.text);
    if (mounted) focus.requestFocus();
  }

  List<Widget> messages(Map<String, dynamic> run) {
    final widgets = <Widget>[
      bubble(run['input'] as String, true, '${run['runId']}:input'),
    ];
    var index = 0;
    for (final event in run['events'] as List) {
      if (event['type'] != 'send/to-user') continue;
      final payload = event['payload'];
      final text = payload is Map
          ? payload['text'] ?? payload['content']
          : null;
      widgets.add(
        bubble(
          text is String
              ? text
              : 'A message with content this preview can’t display.',
          false,
          '${run['runId']}:send:${index++}',
        ),
      );
    }
    final status = run['status'];
    if (status != 'completed') {
      widgets.add(
        Padding(
          padding: const EdgeInsets.all(8),
          child: Text(switch (status) {
            'running' =>
              run['stopRequestedAt'] != null
                  ? 'Stopping…'
                  : run['queued'] == true
                  ? 'Waiting…'
                  : 'Working…',
            'cancelled' => 'Stopped',
            'failed' => 'The reply couldn’t be completed.',
            _ => 'This reply needs attention.',
          }, style: Theme.of(context).textTheme.bodySmall),
        ),
      );
    }
    return widgets;
  }

  Widget bubble(String text, bool user, String id) => Align(
    key: ValueKey(id),
    alignment: user ? Alignment.centerRight : Alignment.centerLeft,
    child: Container(
      constraints: const BoxConstraints(maxWidth: 720),
      margin: EdgeInsets.fromLTRB(user ? 56 : 16, 6, user ? 16 : 56, 6),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: user ? const Color(0xff432330) : const Color(0xff2c2a33),
        borderRadius: BorderRadius.circular(18),
      ),
      child: SelectableText(text),
    ),
  );
  @override
  Widget build(BuildContext context) {
    final c = widget.controller;
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
              TextButton(
                key: const ValueKey('reconnect'),
                onPressed: widget.onReconnect,
                child: const Text('Reconnect'),
              ),
            ],
          ),
        Expanded(
          child: SelectionArea(
            child: ListView(
              key: PageStorageKey('history-${c.botId}-${c.conversationId}'),
              children: [
                if (c.before != null)
                  TextButton(
                    onPressed: c.loading ? null : () => c.refresh(older: true),
                    child: const Text('Earlier messages'),
                  ),
                for (final run in c.runs) ...messages(run),
                if (c.pendingId != null)
                  bubble(c.pendingText ?? '', true, 'pending-${c.pendingId}'),
                if (c.runs.isEmpty && c.pendingId == null)
                  const Padding(
                    padding: EdgeInsets.all(32),
                    child: Text('What would you like to work on?'),
                  ),
              ],
            ),
          ),
        ),
        if (c.error != null)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
            child: Text(c.error!),
          ),
        if (c.pendingId != null && !c.sending)
          TextButton(
            key: const ValueKey('check-delivery'),
            onPressed: c.checking ? null : c.checkDelivery,
            child: const Text('Check message status'),
          ),
        Padding(
          padding: const EdgeInsets.all(12),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Expanded(
                child: CallbackShortcuts(
                  bindings: {
                    const SingleActivator(LogicalKeyboardKey.enter, meta: true):
                        send,
                    const SingleActivator(
                      LogicalKeyboardKey.enter,
                      control: true,
                    ): send,
                  },
                  child: TextField(
                    key: const ValueKey('composer'),
                    controller: editor,
                    focusNode: focus,
                    minLines: 1,
                    maxLines: 6,
                    keyboardType: TextInputType.multiline,
                    textInputAction: TextInputAction.newline,
                    decoration: const InputDecoration(
                      hintText: 'Message your Bot',
                      labelText: 'Message',
                    ),
                    onChanged: (value) {
                      AcceptanceMetrics.instance.inputChanged();
                      unawaited(c.saveDraft(value));
                    },
                  ),
                ),
              ),
              const SizedBox(width: 8),
              if (c.activeRunId != null)
                IconButton.filledTonal(
                  key: const ValueKey('stop'),
                  tooltip: 'Stop',
                  onPressed: c.stopping ? null : c.stop,
                  icon: const Icon(Icons.stop_rounded),
                ),
              IconButton.filled(
                key: const ValueKey('send'),
                tooltip: 'Send',
                onPressed: c.canSend ? send : null,
                icon: const Icon(Icons.arrow_upward_rounded),
              ),
            ],
          ),
        ),
      ],
    );
  }

  @override
  void dispose() {
    widget.controller.removeListener(update);
    editor.dispose();
    focus.dispose();
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
