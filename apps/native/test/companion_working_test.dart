import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/gestures.dart' show PointerDeviceKind;
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart' show FontLoader, rootBundle;
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/chat_controller.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/flock/avatar.dart';
import 'package:frockbot_native/shell/chat_header.dart';
import 'package:frockbot_native/shell/chat_pane.dart';
import 'package:frockbot_native/shell/desktop_layout.dart';
import 'package:frockbot_native/shell/run_view.dart';
import 'package:frockbot_native/shell/semantics.dart';
import 'package:frockbot_native/shell/transcript.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'shell_layout_test.dart' show byIdentifier;
import 'widget_test.dart' show FakeTransport, MemoryStore, running;

final boundary = GlobalKey();

Future<void> loadFonts() async {
  final inter = FontLoader('Inter');
  for (final weight in [400, 500, 600, 700]) {
    inter.addFont(rootBundle.load('assets/fonts/inter-latin-$weight.ttf'));
  }
  await inter.load();
  await (FontLoader(
    'MaterialIcons',
  )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
}

/// Optional review artifact, kept outside the repository:
/// `--dart-define=COMPANION_VISUAL_OUTPUT=<dir>`.
Future<void> capture(WidgetTester tester, String name) async {
  const output = String.fromEnvironment('COMPANION_VISUAL_OUTPUT');
  if (output.isEmpty) return;
  await tester.runAsync(() => Future<void>.delayed(const Duration(seconds: 1)));
  await tester.pump();
  await tester.runAsync(() async {
    final image =
        await (boundary.currentContext!.findRenderObject()!
                as RenderRepaintBoundary)
            .toImage(pixelRatio: 2);
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    await File('$output/$name.png').writeAsBytes(bytes!.buffer.asUint8List());
    image.dispose();
  });
}

/// A Turn streaming beside a second Turn queued behind it.
class SupersededTransport extends FakeTransport {
  SupersededTransport(super.store);
  @override
  Future<Map<String, dynamic>> page(String botId, {String? before}) async => {
    'runs': [
      {
        ...running(),
        'events': [
          {
            'type': 'tool/call',
            'call': {'id': 'call-1', 'name': 'search'},
          },
        ],
      },
      {
        'runId': 'send-2',
        'admittedAt': '2026-09-05T01:00:30Z',
        'input': 'And one more thing',
        'status': 'running',
        'queued': true,
        'events': <Object>[],
      },
    ],
    'page': {'truncated': false},
  };
}

void main() {
  setUpAll(loadFonts);

  testWidgets('the badge is paced by the Turn running, not the one queued', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1280, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final store = MemoryStore();
    final c = ChatController(
      transport: SupersededTransport(store),
      store: store,
      userId: 'user-1',
      botId: 'bot-1',
      nextId: () => 'send-3',
    );
    await c.initialize();
    c.connection = ConnectionState.connected;
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: Scaffold(
          body: ChatPane(
            controller: c,
            onReconnect: () async {},
            background: 'fox',
            primary: '#ff6b57',
          ),
        ),
      ),
    );
    await tester.pump();

    expect(c.activeRunId, 'send-1');
    final pace = tester.widget<WorkingPace>(find.byType(WorkingPace));
    // The queued Turn has nothing to read a tempo from; the one doing the
    // work carries the tool the badge should quicken for.
    expect(pace.line?.runId, 'send-1');
    expect(pace.line?.tools, hasLength(1));

    await tester.pumpWidget(const SizedBox());
    c.dispose();
  });

  for (final width in [390.0, 1280.0]) {
    testWidgets('a running Turn is the Bot at the end of the thread, at '
        '$width', (tester) async {
      tester.view.physicalSize = Size(width, 800);
      tester.view.devicePixelRatio = 1;
      tester.view.padding = FakeViewPadding(bottom: width == 390 ? 34 : 0);
      addTearDown(tester.view.reset);
      final store = MemoryStore();
      final t = FakeTransport(store)..observed = running();
      final c = ChatController(
        transport: t,
        store: store,
        userId: 'user-1',
        botId: 'bot-1',
        nextId: () => 'send-1',
      );
      await c.initialize();
      c.connection = ConnectionState.connected;
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: RepaintBoundary(
            key: boundary,
            child: Scaffold(
              body: ChatPane(
                controller: c,
                onReconnect: () async {},
                background: 'fox',
                primary: '#ff6b57',
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      expect(c.activeRunId, 'send-1');
      // The Bot is the working indicator, at the end of its own thread where
      // the reply will land, and it is the character that moves: nothing is
      // hung over it.
      final indicator = byIdentifier(ShellIds.workingIndicator);
      final transcript = find.byType(TranscriptView);
      expect(indicator, findsOneWidget);
      expect(find.descendant(of: transcript, matching: indicator), findsOne);
      expect(
        find.descendant(of: indicator, matching: find.byType(WorkingSheen)),
        findsOneWidget,
      );
      expect(find.byType(ThinkingBadge), findsNothing);
      expect(byIdentifier(ShellIds.workingNotice), findsNothing);
      // Below the person's message and above the field.
      final avatar = tester.getRect(
        find.descendant(of: indicator, matching: find.byType(CharacterAvatar)),
      );
      final message = tester.getRect(find.text('Hello'));
      final field = tester.getRect(find.byKey(const ValueKey('composer')));
      expect(avatar.top, greaterThan(message.bottom));
      expect(avatar.bottom, lessThan(field.top));
      // Laid out at its size; the motion only draws it hopping.
      expect(
        tester
            .getSize(
              find.descendant(
                of: indicator,
                matching: find.byType(CharacterAvatar),
              ),
            )
            .height,
        threadCompanionSize,
      );
      // The header keeps its companion, at rest.
      expect(find.bySemanticsLabel('Bot is ready'), findsOneWidget);

      await capture(tester, 'companion-working-${width.toInt()}');
      await tester.pumpWidget(const SizedBox());
      c.dispose();
    });
  }

  testWidgets(
    'the working Bot sits under the running reply and eases away after it',
    (tester) async {
      tester.view.physicalSize = const Size(1351, 831);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final store = MemoryStore();
      final active = {
        ...running(),
        'events': <Object>[
          {
            'type': 'send/to-user',
            'payload': {'type': 'text', 'text': 'Half a thought'},
            'ordinal': 0,
          },
        ],
      };
      final transport = FakeTransport(store)..observed = active;
      final controller = ChatController(
        transport: transport,
        store: store,
        userId: 'user-1',
        botId: 'bot-1',
        nextId: () => 'send-2',
      );
      await controller.initialize();
      controller.connection = ConnectionState.connected;

      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: ShellLayout(
            panelOpen: true,
            onDismiss: () {},
            conversationOpen: true,
            onBack: () {},
            sidebar: const SizedBox(),
            rightPanel: const SizedBox(),
            conversation: ChatPane(
              controller: controller,
              onReconnect: () async {},
              background: 'fox',
              primary: '#ff6b57',
              overlay: (companion, notices) => ChatHeader(
                below: notices,
                name: 'Bot',
                companion: companion,
                onOpenBot: () {},
                onComputer: () {},
                onTogglePanel: () {},
                panelShown: true,
              ),
            ),
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 300));

      expect(byIdentifier(ShellIds.rightPanel), findsOneWidget);
      final indicator = byIdentifier(ShellIds.workingIndicator);
      final bubble = byIdentifier(ShellIds.message('send-1:send:0'));
      final transcript = byIdentifier(ShellIds.transcript);
      expect(indicator, findsOneWidget);
      expect(bubble, findsOneWidget);
      expect(
        find.descendant(of: find.byType(ChatHeader), matching: indicator),
        findsNothing,
      );
      expect(find.descendant(of: transcript, matching: indicator), findsOne);
      final runningBubble = tester.getRect(bubble);
      expect(
        tester.getTopLeft(indicator).dy,
        greaterThan(runningBubble.bottom),
      );

      transport.observed = {
        ...active,
        'status': 'completed',
        'outcome': {'type': 'completed', 'text': ''},
      };
      await controller.refresh();
      await tester.pump();

      expect(indicator, findsNothing);
      expect(
        find.descendant(
          of: find.byType(ChatHeader),
          matching: find.bySemanticsLabel('Bot is ready'),
        ),
        findsOneWidget,
      );
      // The space it held closes over the motion, not in one frame: part
      // way through, the reply has only part way to go.
      await tester.pump(FrockTheme.enter ~/ 2);
      final settling = tester.getRect(bubble).top;
      await tester.pump(FrockTheme.enter);
      final settled = tester.getRect(bubble).top;
      expect(settling, greaterThan(runningBubble.top));
      expect(settled, greaterThan(settling));
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
    },
  );

  testWidgets('a Bot asked something joins the one asking once it starts on '
      'the question, until it answers', (tester) async {
    tester.view.physicalSize = const Size(390, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final store = MemoryStore();
    Map<String, dynamic> asking({bool answered = false}) => {
      ...running(),
      'events': <Object>[
        {
          'type': 'message/to-bot',
          'callId': 'tool-1',
          'botId': 'bot-dog',
          'text': 'When is the Series B expected to close?',
        },
        if (answered)
          {
            'type': 'tool/result',
            'callId': 'tool-1',
            'content': 'Early December.',
            'isError': false,
          },
      ],
    };
    final transport = _AskingTransport(store)
      ..observed = asking()
      ..answering = {...running(), 'runId': 'agent-dog-1', 'queued': true};
    final c = ChatController(
      transport: transport,
      store: store,
      userId: 'user-1',
      botId: 'bot-1',
      nextId: () => 'send-2',
    );
    await c.initialize();
    c.connection = ConnectionState.connected;
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: Scaffold(
          body: ChatPane(
            controller: c,
            onReconnect: () async {},
            background: 'fox',
            primary: '#ff6b57',
            backgroundOf: (botId) => botId == 'bot-dog' ? 'dog' : null,
            primaryOf: (_) => null,
            nameOf: (botId) => botId == 'bot-dog' ? 'Dog' : null,
          ),
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 300));

    final indicator = byIdentifier(ShellIds.workingIndicator);
    CharacterAvatar? dog() => tester
        .widgetList<CharacterAvatar>(
          find.descendant(
            of: indicator,
            matching: find.byType(CharacterAvatar),
          ),
        )
        .where((avatar) => avatar.characterId == 'dog')
        .firstOrNull;
    // Fox has asked, but Dog is still finishing something of its own: the
    // question waits in Dog's queue, so Fox works alone.
    expect(transport.asked, ['bot-1:send-1']);
    expect(transport.calls, contains('lookup:bot-dog:agent-dog-1'));
    expect(dog(), isNull);
    expect(find.bySemanticsLabel('Working'), findsOneWidget);

    // Dog starts on Fox's question, so Dog stands beside Fox, smaller, under
    // the same sheen, and the working mark says who is helping.
    transport.answering = {...transport.answering!, 'queued': false};
    await tester.pump(ChatController.questionPoll);
    await tester.pump(const Duration(milliseconds: 300));
    expect(dog(), isNotNull);
    expect(dog()!.size, askedCompanionSize);
    expect(
      find.descendant(of: indicator, matching: find.byType(WorkingSheen)),
      findsNWidgets(2),
    );
    expect(find.bySemanticsLabel('Working with Dog'), findsOneWidget);
    final fox = tester.getRect(
      find
          .descendant(of: indicator, matching: find.byType(CharacterAvatar))
          .first,
    );
    final helper = tester.getRect(
      find
          .descendant(of: indicator, matching: find.byType(CharacterAvatar))
          .last,
    );
    expect(helper.left, greaterThan(fox.left));
    // Which Turn answers is asked once, and a Turn seen started is not looked
    // at again: its answer arrives in Fox's own log.
    expect(transport.asked, ['bot-1:send-1']);
    final looks = transport.calls.where((call) => call.contains('bot-dog'));
    final seen = looks.length;
    await tester.pump(ChatController.questionPoll * 3);
    expect(looks.length, seen);
    expect(dog(), isNotNull);

    // Dog has answered: Fox carries on alone, and nothing is read any more.
    transport.observed = asking(answered: true);
    await c.refresh();
    await tester.pump(const Duration(milliseconds: 300));
    expect(indicator, findsOneWidget);
    expect(dog(), isNull);
    expect(find.bySemanticsLabel('Working'), findsOneWidget);
    final reads = transport.calls.length;
    await tester.pump(ChatController.questionPoll * 3);
    expect(transport.calls.length, reads);

    await tester.pumpWidget(const SizedBox());
    c.dispose();
  });

  testWidgets('the companion looks where the pointer is over the pane', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1280, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final store = MemoryStore();
    final t = FakeTransport(store);
    final c = ChatController(
      transport: t,
      store: store,
      userId: 'user-1',
      botId: 'bot-1',
      nextId: () => 'send-1',
    );
    await c.initialize();
    c.connection = ConnectionState.connected;
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: Scaffold(
          body: ChatPane(
            controller: c,
            onReconnect: () async {},
            background: 'fox',
            primary: '#ff6b57',
          ),
        ),
      ),
    );
    await tester.pump();
    final state = tester.state(find.byType(ChatPane)) as dynamic;
    final ValueNotifier<Offset?> gaze = state.gaze;
    expect(gaze.value, isNull);

    final companion = tester.getCenter(find.bySemanticsLabel('Bot is ready'));
    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    await mouse.addPointer(location: Offset.zero);
    addTearDown(mouse.removePointer);
    // Up and to the right of the character: the eyes turn that way, and a
    // point well short of the pane's far corner is not yet a full turn.
    await mouse.moveTo(companion + const Offset(200, -40));
    await tester.pump();
    expect(gaze.value, isNotNull);
    expect(gaze.value!.dx, greaterThan(0));
    expect(gaze.value!.dx, lessThan(1));
    expect(gaze.value!.dy, lessThan(0));
    // The far corner is a full turn, clamped rather than beyond it.
    await mouse.moveTo(const Offset(1279, 1));
    await tester.pump();
    expect(gaze.value, isNotNull);
    expect(gaze.value!.dx, 1);
    expect(gaze.value!.dy, lessThan(0));
    // Off the pane, nowhere to look.
    await mouse.moveTo(const Offset(-10, -10));
    await tester.pump();
    expect(gaze.value, isNull);

    await tester.pumpWidget(const SizedBox());
    c.dispose();
  });
}

/// A Fox whose Turn has asked Dog something. [answering] is the Turn Dog
/// answers in, as Dog's own lookup reports it.
class _AskingTransport extends FakeTransport implements QuestionsTransport {
  _AskingTransport(super.store);
  Map<String, dynamic>? answering;
  final asked = <String>[];

  @override
  Future<List<OpenQuestion>> questions(String botId, String runId) async {
    asked.add('$botId:$runId');
    return [(callId: 'tool-1', botId: 'bot-dog', runId: 'agent-dog-1')];
  }

  @override
  Future<Map<String, dynamic>?> lookup(
    String botId,
    String id, {
    bool fence = false,
  }) async {
    if (botId != 'bot-dog') return super.lookup(botId, id, fence: fence);
    calls.add('lookup:$botId:$id');
    return answering;
  }
}
