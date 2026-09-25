/// Review stills for the whole window — the Bot list beside a conversation —
/// kept outside the repository:
/// `--dart-define=CHAT_SHOTS=<dir> --dart-define=CHAT_SHOTS_TAG=<tag>`.
/// Without a directory every scene is skipped: they draw, they do not assert.
library;

import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart'
    show debugDefaultTargetPlatformOverride;
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart' show FontLoader, rootBundle;
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/chat_controller.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/flock/lifecycle.dart';
import 'package:frockbot_native/groups/faces.dart';
import 'package:frockbot_native/protocol/client_wire.generated.dart' as wire;
import 'package:frockbot_native/shell/archived_conversation.dart';
import 'package:frockbot_native/shell/chat_header.dart';
import 'package:frockbot_native/shell/chat_pane.dart';
import 'package:frockbot_native/shell/desktop_layout.dart';
import 'package:frockbot_native/shell/sidebar.dart';
import 'package:frockbot_native/shell/skill_menu.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'settings_test.dart' show SettingsApi;
import 'skill_popover_reopen_test.dart' show SilentApi, VoidStore;
import 'widget_test.dart' show MemoryStore;

const _out = String.fromEnvironment('CHAT_SHOTS');
const _tag = String.fromEnvironment('CHAT_SHOTS_TAG', defaultValue: 'shot');

final _boundary = GlobalKey();

Future<void> _loadFonts() async {
  final inter = FontLoader('Inter');
  for (final weight in [400, 500, 600, 700]) {
    inter.addFont(rootBundle.load('assets/fonts/inter-latin-$weight.ttf'));
  }
  await inter.load();
  await (FontLoader(
    'MaterialIcons',
  )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
}

/// Today at [hour]:[minute], local, as the wire writes an instant.
String _today(int hour, int minute) {
  final now = DateTime.now();
  return DateTime(
    now.year,
    now.month,
    now.day,
    hour,
    minute,
  ).toUtc().toIso8601String();
}

String _daysAgo(int days) {
  final then = DateTime.now().subtract(Duration(days: days));
  return DateTime(
    then.year,
    then.month,
    then.day,
    9,
    30,
  ).toUtc().toIso8601String();
}

Map<String, dynamic> _turn(
  String id,
  String at,
  String input, {
  List<String> replies = const [],
}) => {
  'runId': id,
  'admittedAt': at,
  'input': input,
  'status': 'completed',
  'canRetry': false,
  'events': [
    for (var i = 0; i < replies.length; i++)
      {
        'type': 'send/to-user',
        'payload': {'type': 'text', 'text': replies[i]},
        'ordinal': i,
      },
  ],
  'outcome': {'type': 'completed'},
};

final _history = [
  _turn(
    'run-1',
    _today(5, 53),
    'What did the hello plugin turn out to be?',
    replies: [
      'It’s one Plugin with two faces: three tools I can call — say_hello, '
          'list_greetings, clear_greetings — and a panel on the page beside '
          'the conversation showing a heading, how many hellos are kept, the '
          'hellos themselves, and two buttons wired straight to those tools.\n\n'
          'I ran say_hello once already, so the first greeting is sitting '
          'there: “Hello, World!”. Press “Say hello” in the panel and it adds '
          'another without me being involved.',
    ],
  ),
  _turn(
    'run-2',
    _today(5, 54),
    'hello',
    replies: [
      'Hello! The Hello page is sitting beside the chat if you want to poke '
          'at it — pressing “Say hello” adds a greeting straight from the '
          'panel without going through me.\n\n'
          'One thing I’d change: that button always greets World, since a '
          'panel control sends a fixed input. If you want a field there so '
          'you can type a name and greet that, say the word and I’ll add it.',
    ],
  ),
  _turn(
    'run-3',
    _today(5, 56),
    'open the hello world panel and send a hello world message in',
    replies: [
      'Hi. Panel’s still open with two hellos in it, both “Hello, World!”.\n'
          'If you press “Say hello” in the panel it’ll add a third without '
          'going through me — otherwise, what’s next?',
    ],
  ),
];

class _Transport implements ChatTransport, QuestionsTransport {
  @override
  Future<Map<String, dynamic>> page(String botId, {String? before}) async => {
    'runs': _history,
    'announcements': const [],
    'page': {'truncated': false},
  };
  @override
  Future<void> send(
    String botId,
    String id,
    String text, {
    String? retryOf,
    List<MessageAttachment> attachments = const [],
  }) async {}
  @override
  Future<Map<String, dynamic>?> lookup(
    String botId,
    String id, {
    bool fence = false,
  }) async => null;
  @override
  Future<Map<String, dynamic>> stop(
    String botId,
    String id,
    String commandId,
  ) async => _history.last;
  @override
  Future<List<OpenQuestion>> questions(String botId, String runId) async =>
      const [];
}

wire.BotRegistration _bot(String botId, String name, String character) =>
    wire.BotRegistration.fromJson({
      'schemaVersion': 1,
      'botId': botId,
      'registeredAt': '2026-09-05T00:00:00.000Z',
      'initialName': name,
      'avatar': {
        'schemaVersion': 1,
        'characterId': character,
        'primary': '#59c7ff',
      },
    });

wire.UnreadView _seen(String botId, String text, String at, {int count = 0}) =>
    wire.UnreadView.fromJson({
      'schemaVersion': 1,
      'botId': botId,
      'count': count,
      'capped': false,
      'unread': count > 0,
      'manuallyUnread': false,
      'notificationsEnabled': true,
      'lastMessage': {
        'schemaVersion': 1,
        'text': text,
        'at': at,
        'role': 'assistant',
      },
    });

const _groupFaces = [
  GroupFace(
    botId: 'bob',
    name: 'Bob',
    characterId: 'nudge',
    primary: '#58c98b',
  ),
  GroupFace(
    botId: 'test',
    name: 'Test',
    characterId: 'cat',
    primary: '#6578ee',
  ),
];

Widget _sidebar({required bool phone, bool archived = false}) => ShellSidebar(
  phone: phone,
  bots: [
    _bot('bob', 'Bob', 'nudge'),
    _bot('test', 'Test', 'cat'),
    _bot('qa', 'QA Throwaway', 'goat'),
    _bot('test-2', 'Test', 'rabbit'),
    if (archived) ...[
      _bot('ledger', 'Ledger', 'fox'),
      _bot('old', 'Test Bot', 'rabbit'),
    ],
  ],
  groupChats: [
    SidebarGroupChat(
      groupId: 'launch',
      name: 'Bob & Test',
      faces: _groupFaces,
      profile: const SidebarProfile(sidebarOrder: 9),
    ),
  ],
  profiles: const {
    'bob': SidebarProfile(
      name: 'Bob',
      title: 'Helpful, friendly, and gets things done.',
      sidebarOrder: 0,
    ),
    'test': SidebarProfile(name: 'Test', sidebarOrder: 1),
    'qa': SidebarProfile(name: 'QA Throwaway', sidebarOrder: 2),
    'test-2': SidebarProfile(name: 'Test', sidebarOrder: 3),
  },
  unread: {
    'bob': _seen(
      'bob',
      'Hi. Panel’s still open with two hellos in it, both “Hello, World!”.',
      _today(5, 56),
    ),
    'test': _seen('test', 'Hi! What can I do for you?', _daysAgo(3)),
    'qa': _seen(
      'qa',
      'Hi — QA Throwaway here. What should we break first?',
      _daysAgo(17),
      count: 2,
    ),
    'test-2': _seen(
      'test-2',
      'Four things, roughly — a plugin is the first of them.',
      _daysAgo(12),
    ),
  },
  archived: archived ? const {'ledger', 'old'} : const {},
  activeBotId: phone ? null : (archived ? 'ledger' : 'bob'),
  focusedBotId: phone || archived ? null : 'bob',
  workingBotId: null,
  loaded: true,
  showHidden: false,
  showArchived: archived,
  onToggleArchived: () {},
  profileName: 'Alex Morgan',
  onSelect: (_) {},
  onCreateBot: () {},
  onCreateGroup: () {},
  onSearch: () {},
  onProfile: () {},
  onWhatsNew: () {},
  onMarketplace: () {},
  onToggleHidden: () {},
  onRetry: () async {},
);

Future<void> _scene(
  WidgetTester tester,
  String name, {
  required Brightness brightness,
  required Size size,
  bool list = false,
  bool archived = false,
}) async {
  // A desk is drawn as the Mac app, a phone as Android: each platform's own
  // control sizes and window chrome.
  debugDefaultTargetPlatformOverride = size.width > shellSinglePaneWidth
      ? TargetPlatform.macOS
      : TargetPlatform.android;
  addTearDown(() => debugDefaultTargetPlatformOverride = null);
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  tester.view.padding = FakeViewPadding(bottom: size.width < 600 ? 34 : 0);
  addTearDown(tester.view.reset);
  final phone = size.width <= shellSinglePaneWidth;
  final c = ChatController(
    transport: _Transport(),
    store: MemoryStore(),
    userId: 'user-1',
    botId: 'bob',
    nextId: () => 'send-new',
  );
  await c.initialize();
  final skills = SkillMenuController(api: SilentApi(VoidStore()), botId: 'bob');
  final pane = ChatPane(
    controller: c,
    botName: 'Bob',
    onReconnect: () async {},
    background: 'nudge',
    primary: '#58c98b',
    backgroundOf: (_) => null,
    primaryOf: (_) => null,
    nameOf: (_) => null,
    skills: skills,
    onDictate: () {},
    onVoice: () {},
    overlay: (companion, notices) => ChatHeader(
      below: notices,
      name: 'Bob',
      subtitle: 'Helpful, friendly, and gets things done.',
      connection: ConnectionState.connected,
      onSearch: phone ? null : () {},
      onActions: () {},
      phone: phone,
      onBack: phone ? () {} : null,
      onTogglePanel: () {},
      companion: companion,
    ),
  );
  final store = MemoryStore();
  final api = SettingsApi(
    store,
    (_, _) async => {
      'schemaVersion': 1,
      'runs': [
        {
          'schemaVersion': 3,
          'runId': 'ledger-1',
          'admittedAt': '2026-09-12T09:00:00.000Z',
          'input': 'Can you total the receipts in my inbox for August?',
          'status': 'completed',
          'events': [
            {
              'type': 'send/to-user',
              'ordinal': 0,
              'payload': {
                'type': 'text',
                'text':
                    'August comes to A\$1,284.60 across 23 receipts. The '
                    'biggest is the Qantas fare, at A\$612.',
              },
            },
          ],
          'outcome': {'type': 'completed', 'text': ''},
        },
      ],
      'page': {'truncated': false},
    },
  );
  final lifecycle = BotLifecycleCommands(api, store, 'user-1');
  await tester.pumpWidget(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: FrockTheme.theme(brightness),
      home: RepaintBoundary(
        key: _boundary,
        child: Scaffold(
          body: ShellLayout(
            sidebar: _sidebar(phone: phone, archived: archived),
            conversation: archived
                ? ArchivedConversation(
                    api: api,
                    botId: 'ledger',
                    name: 'Ledger',
                    characterId: 'fox',
                    primary: '#9db4ff',
                    phone: phone,
                    onBack: phone ? () {} : null,
                    lifecycle: lifecycle,
                    onRestore: () {},
                    onDelete: () {},
                  )
                : pane,
            rightPanel: null,
            panelOpen: false,
            onDismiss: () {},
            conversationOpen: !list,
            onBack: () {},
          ),
        ),
      ),
    ),
  );
  await tester.pump();
  await tester.runAsync(() => Future<void>.delayed(const Duration(seconds: 1)));
  await tester.pump(const Duration(milliseconds: 600));
  await tester.runAsync(() async {
    final image =
        await (_boundary.currentContext!.findRenderObject()!
                as RenderRepaintBoundary)
            .toImage(pixelRatio: 2);
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    await File('$_out/$_tag-$name.png')
        .writeAsBytes(bytes!.buffer.asUint8List());
    image.dispose();
  });
  await tester.pumpWidget(const SizedBox());
  lifecycle.dispose();
  skills.dispose();
  c.dispose();
  debugDefaultTargetPlatformOverride = null;
}

void main() {
  setUpAll(_loadFonts);

  testWidgets('desk, dark', (tester) async {
    await _scene(
      tester,
      'desk-dark',
      brightness: Brightness.dark,
      size: const Size(1440, 860),
    );
  }, skip: _out.isEmpty);

  testWidgets('desk, light', (tester) async {
    await _scene(
      tester,
      'desk-light',
      brightness: Brightness.light,
      size: const Size(1440, 860),
    );
  }, skip: _out.isEmpty);

  testWidgets('phone chat, dark', (tester) async {
    await _scene(
      tester,
      'phone-chat',
      brightness: Brightness.dark,
      size: const Size(390, 844),
    );
  }, skip: _out.isEmpty);

  testWidgets('desk archived, dark', (tester) async {
    await _scene(
      tester,
      'desk-archived',
      brightness: Brightness.dark,
      size: const Size(1440, 860),
      archived: true,
    );
  }, skip: _out.isEmpty);

  testWidgets('phone archived, dark', (tester) async {
    await _scene(
      tester,
      'phone-archived',
      brightness: Brightness.dark,
      size: const Size(390, 844),
      archived: true,
    );
  }, skip: _out.isEmpty);

  testWidgets('phone list archived, dark', (tester) async {
    await _scene(
      tester,
      'phone-list-archived',
      brightness: Brightness.dark,
      size: const Size(390, 844),
      list: true,
      archived: true,
    );
  }, skip: _out.isEmpty);

  testWidgets('phone list, dark', (tester) async {
    await _scene(
      tester,
      'phone-list',
      brightness: Brightness.dark,
      size: const Size(390, 844),
      list: true,
    );
  }, skip: _out.isEmpty);
}
