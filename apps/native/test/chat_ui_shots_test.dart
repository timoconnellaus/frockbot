/// Review stills for the chat UI — the thread, the composer, `/stop`, a
/// failed reply, a voice chat — kept outside the repository:
/// `--dart-define=CHAT_SHOTS=<dir> --dart-define=CHAT_SHOTS_TAG=<tag>`.
/// Without a directory every scene is skipped: they draw, they do not assert.
library;

import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart' show FontLoader, rootBundle;
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/chat_controller.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/shell/chat_header.dart';
import 'package:frockbot_native/shell/chat_pane.dart';
import 'package:frockbot_native/shell/skill_menu.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'skill_popover_reopen_test.dart' show SilentApi, VoidStore;
import 'widget_test.dart' show MemoryStore;

const _out = String.fromEnvironment('CHAT_SHOTS');
const _tag = String.fromEnvironment('CHAT_SHOTS_TAG', defaultValue: 'shot');

/// Device pixels per logical pixel; a What's New still is cut from a 4x frame.
const _scale = int.fromEnvironment('CHAT_SHOTS_SCALE', defaultValue: 2);

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

Future<void> _capture(WidgetTester tester, String name) async {
  if (_out.isEmpty) return;
  await tester.runAsync(() => Future<void>.delayed(const Duration(seconds: 1)));
  await tester.pump(const Duration(milliseconds: 600));
  await tester.runAsync(() async {
    final image =
        await (_boundary.currentContext!.findRenderObject()!
                as RenderRepaintBoundary)
            .toImage(pixelRatio: _scale.toDouble());
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    await File('$_out/$_tag-$name.png')
        .writeAsBytes(bytes!.buffer.asUint8List());
    image.dispose();
  });
}

Future<void> _frame(WidgetTester tester, String name) async {
  if (_out.isEmpty) return;
  await tester.runAsync(() async {
    final image =
        await (_boundary.currentContext!.findRenderObject()!
                as RenderRepaintBoundary)
            .toImage(pixelRatio: _scale.toDouble());
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    await File('$_out/$_tag-$name.png')
        .writeAsBytes(bytes!.buffer.asUint8List());
    image.dispose();
  });
}

Map<String, dynamic> _turn(
  String id,
  String at,
  String input, {
  String status = 'completed',
  List<String> replies = const [],
  String? failure,
  bool canRetry = false,
}) => {
  'runId': id,
  'admittedAt': at,
  'input': input,
  'status': status,
  'canRetry': canRetry,
  'events': [
    for (var i = 0; i < replies.length; i++)
      {
        'type': 'send/to-user',
        'payload': {'type': 'text', 'text': replies[i]},
        'ordinal': i,
      },
  ],
  if (status != 'running') 'outcome': {'type': status, 'message': ?failure},
};

final _history = [
  _turn(
    'run-1',
    '2026-09-23T01:00:00Z',
    'Can you pull the three biggest risks out of the Q3 board pack?',
    replies: [
      'Here are the three that stand out:\n\n'
          '1. **Cash runway** drops to 11 months if the Series B slips.\n'
          '2. **Key-person risk** on the platform team.\n'
          '3. **Churn** in the SMB tier is up 4 points.',
    ],
  ),
];

/// Every Bot a scene's Turn has asked is already working on the question.
class _SceneTransport implements ChatTransport, QuestionsTransport {
  final List<Map<String, dynamic>> runs;
  final List<Object?> announcements;
  _SceneTransport(this.runs, {this.announcements = const []});
  @override
  Future<Map<String, dynamic>> page(String botId, {String? before}) async => {
    'runs': runs,
    'announcements': announcements,
    'page': {'truncated': false},
  };
  @override
  Future<void> send(
    String botId,
    String id,
    String text, {
    String? retryOf,
  }) async {}
  @override
  Future<Map<String, dynamic>?> lookup(
    String botId,
    String id, {
    bool fence = false,
  }) async => botId == 'bot-1'
      ? null
      : {'runId': id, 'status': 'running', 'queued': false};
  @override
  Future<Map<String, dynamic>> stop(
    String botId,
    String id,
    String commandId,
  ) async => runs.last;
  @override
  Future<List<OpenQuestion>> questions(String botId, String runId) async => [
    for (final run in runs)
      if (run['runId'] == runId)
        for (final event in run['events'] as List)
          if (event is Map && event['type'] == 'message/to-bot')
            (
              callId: event['callId'] as String,
              botId: event['botId'] as String,
              runId: 'agent-${event['callId']}',
            ),
  ];
}

SkillCatalogEntry _skill(String slug, String name, String description) =>
    SkillCatalogEntry(
      ref: 'bot:$slug',
      skill: {'schemaVersion': 1, 'source': 'bot', 'slug': slug},
      name: name,
      description: description,
      path: '/skills/$slug',
    );

Future<void> _scene(
  WidgetTester tester,
  String name, {
  required List<Map<String, dynamic>> runs,
  List<Object?> announcements = const [],
  double width = 390,
  double height = 844,
  String? typed,
  Future<void> Function(WidgetTester tester)? act,
  int frames = 0,
  ConnectionState connection = ConnectionState.connected,
  bool outOfCredit = false,
  List<Map<String, dynamic>> draftFrames = const [],
}) async {
  tester.view.physicalSize = Size(width, height);
  tester.view.devicePixelRatio = 1;
  tester.view.padding = FakeViewPadding(bottom: width < 600 ? 34 : 0);
  addTearDown(tester.view.reset);
  final phone = width < 600;
  final store = MemoryStore();
  final c = ChatController(
    transport: _SceneTransport(runs, announcements: announcements),
    store: store,
    userId: 'user-1',
    botId: 'bot-1',
    nextId: () => 'send-new',
  );
  await c.initialize();
  c.connection = connection;
  for (final draft in draftFrames) {
    await c.applyFrame(draft);
  }
  final skills =
      SkillMenuController(api: SilentApi(VoidStore()), botId: 'bot-1')
        ..catalog = [
          _skill('summarise', 'Summarise', 'Boil a long thread down'),
          _skill('standup', 'Standup notes', 'Yesterday, today, blockers'),
          _skill('review', 'Review', 'Read a draft and mark it up'),
        ];
  await tester.pumpWidget(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: FrockTheme.theme(Brightness.dark),
      home: RepaintBoundary(
        key: _boundary,
        child: Scaffold(
          body: ChatPane(
            controller: c,
            botName: 'Fox',
            onReconnect: () async {},
            outOfCredit: outOfCredit,
            onOpenBilling: () {},
            background: 'fox',
            primary: '#ff6b57',
            backgroundOf: (botId) => botId == 'bot-dog' ? 'dog' : null,
            primaryOf: (_) => null,
            nameOf: (botId) => botId == 'bot-dog' ? 'Dog' : null,
            skills: skills,
            onDictate: () {},
            onVoice: () {},
            overlay: (companion, notices) => ChatHeader(
              below: notices,
              name: 'Fox',
              phone: phone,
              onBack: phone ? () {} : null,
              onTogglePanel: () {},
              companion: companion,
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pump();
  if (typed != null) {
    await tester.enterText(find.byKey(const ValueKey('composer')), typed);
    await tester.pump();
  }
  if (act != null) await act(tester);
  if (frames > 0) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 300)),
    );
    for (var i = 0; i < frames; i++) {
      await tester.pump(const Duration(milliseconds: 80));
      await _frame(tester, '$name-${i.toString().padLeft(2, '0')}');
    }
  } else {
    await _capture(tester, name);
  }
  await tester.pumpWidget(const SizedBox());
  skills.dispose();
  c.dispose();
}

void main() {
  setUpAll(_loadFonts);

  testWidgets('idle', (tester) async {
    await _scene(tester, 'idle', runs: _history);
  }, skip: _out.isEmpty);

  testWidgets('offline', (tester) async {
    await _scene(
      tester,
      'offline',
      runs: _history,
      connection: ConnectionState.disconnected,
    );
  }, skip: _out.isEmpty);

  testWidgets('offline desk', (tester) async {
    await _scene(
      tester,
      'offline-desk',
      runs: _history,
      width: 1100,
      height: 760,
      connection: ConnectionState.disconnected,
    );
  }, skip: _out.isEmpty);

  testWidgets('out of credit desk', (tester) async {
    await _scene(
      tester,
      'credit-desk',
      runs: _history,
      width: 1100,
      height: 760,
      outOfCredit: true,
    );
  }, skip: _out.isEmpty);

  testWidgets('idle desk', (tester) async {
    await _scene(tester, 'idle-desk', runs: _history, width: 1100, height: 760);
  }, skip: _out.isEmpty);

  testWidgets('working', (tester) async {
    await _scene(
      tester,
      'working',
      runs: [
        ..._history,
        _turn(
          'run-2',
          '2026-09-23T01:02:00Z',
          'Draft the investor update from those notes',
          status: 'running',
        ),
      ],
    );
  }, skip: _out.isEmpty);

  testWidgets('writing', (tester) async {
    await _scene(
      tester,
      'writing',
      width: 430,
      height: 932,
      runs: [
        ..._history,
        _turn(
          'run-2',
          '2026-09-23T01:02:00Z',
          'Draft the investor update from those notes',
          status: 'running',
        ),
      ],
      draftFrames: [
        {
          'schemaVersion': 1,
          'type': 'state/draft',
          'runId': 'run-2',
          'ordinal': 0,
          'parts': [
            'Revenue grew 18% on last quarter, led by the enterprise tier. '
                'Runway is 14 months once the bridge clo',
          ],
        },
      ],
    );
  }, skip: _out.isEmpty);

  testWidgets('working desk', (tester) async {
    await _scene(
      tester,
      'working-desk',
      width: 1100,
      height: 760,
      runs: [
        ..._history,
        _turn(
          'run-2',
          '2026-09-23T01:02:00Z',
          'Draft the investor update from those notes',
          status: 'running',
        ),
      ],
    );
  }, skip: _out.isEmpty);

  testWidgets('steering', (tester) async {
    await _scene(
      tester,
      'steering',
      runs: [
        ..._history,
        _turn(
          'run-2',
          '2026-09-23T01:02:00Z',
          'Draft the investor update from those notes',
          status: 'running',
          replies: const ['Starting with the runway numbers.'],
        ),
        {
          ..._turn(
            'run-3',
            '2026-09-23T01:02:30Z',
            'Lead with churn, the board will ask about it first',
            status: 'running',
          ),
          'queued': true,
        },
      ],
    );
  }, skip: _out.isEmpty);

  testWidgets('slash while working', (tester) async {
    await _scene(
      tester,
      'slash',
      typed: '/',
      runs: [
        ..._history,
        _turn(
          'run-2',
          '2026-09-23T01:02:00Z',
          'Draft the investor update from those notes',
          status: 'running',
        ),
      ],
    );
  }, skip: _out.isEmpty);

  final runningTurn = _turn(
    'run-2',
    '2026-09-23T01:02:00Z',
    'Draft the investor update from those notes',
    status: 'running',
  );

  testWidgets('stop typed', (tester) async {
    await _scene(
      tester,
      'stop-typed',
      typed: '/st',
      runs: [..._history, runningTurn],
    );
  }, skip: _out.isEmpty);

  testWidgets('nothing to stop', (tester) async {
    await _scene(
      tester,
      'nothing-to-stop',
      typed: '/stop',
      runs: _history,
      act: (tester) async {
        await tester.tap(find.byKey(const ValueKey('send')));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 400));
      },
    );
  }, skip: _out.isEmpty);

  testWidgets('working frames', (tester) async {
    await _scene(
      tester,
      'frames',
      frames: 30,
      runs: [..._history, runningTurn],
    );
  }, skip: _out.isEmpty);

  final askingTurn = {
    ...runningTurn,
    'events': <Object>[
      {
        'type': 'message/to-bot',
        'callId': 'tool-1',
        'botId': 'bot-dog',
        'text': 'When is the Series B expected to close?',
      },
    ],
  };

  testWidgets('asking another Bot', (tester) async {
    await _scene(tester, 'asking', runs: [..._history, askingTurn]);
  }, skip: _out.isEmpty);

  testWidgets('asking frames', (tester) async {
    await _scene(
      tester,
      'asking-frames',
      frames: 36,
      runs: [..._history, askingTurn],
    );
  }, skip: _out.isEmpty);

  testWidgets('empty', (tester) async {
    await _scene(tester, 'empty', runs: const []);
  }, skip: _out.isEmpty);

  testWidgets('failed', (tester) async {
    await _scene(
      tester,
      'failed',
      runs: [
        ..._history,
        _turn(
          'run-2',
          '2026-09-23T01:02:00Z',
          'Draft the investor update from those notes',
          status: 'failed',
          canRetry: true,
          failure: "This Bot couldn't finish its reply. Try again.",
        ),
      ],
    );
  }, skip: _out.isEmpty);

  testWidgets('stopped', (tester) async {
    await _scene(
      tester,
      'stopped',
      runs: [
        ..._history,
        _turn(
          'run-2',
          '2026-09-23T01:02:00Z',
          'Draft the investor update from those notes',
          status: 'cancelled',
        ),
      ],
    );
  }, skip: _out.isEmpty);

  final call = {
    'type': 'voice/call',
    'announcementId': 'voice-call-call-9',
    'at': '2026-09-23T01:09:00.000Z',
    'callId': 'call-9',
    'startedAt': '2026-09-23T01:05:00.000Z',
    'endedAt': '2026-09-23T01:09:00.000Z',
    'turns': [
      {
        'transcript': 'What’s on my plate this afternoon?',
        'answer': 'Two things: the board prep call at 2 and Sam’s contract.',
      },
      {
        'transcript': 'Move the contract to tomorrow morning.',
        'answer': 'Done — it’s on tomorrow at 9.',
      },
    ],
  };

  testWidgets('voice chat', (tester) async {
    await _scene(tester, 'voice', runs: _history, announcements: [call]);
  }, skip: _out.isEmpty);

  testWidgets('voice chat open', (tester) async {
    await _scene(
      tester,
      'voice-open',
      runs: _history,
      announcements: [call],
      act: (tester) async {
        await tester.tap(find.textContaining('Voice chat'));
        await tester.pump();
      },
    );
  }, skip: _out.isEmpty);
}
