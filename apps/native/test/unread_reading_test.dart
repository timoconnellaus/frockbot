/// What the shell does about a conversation the person is reading: the read
/// receipt it sends, the presence it claims so the cloud holds an alert back,
/// and the dock badge while the window is away.
///
/// The server here keeps one Bot's unread record and answers every poll from
/// it, so a command the shell sends shows up in the next poll exactly as it
/// would against the cloud.
library;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/bot_sessions.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/shell/app_shell.dart';
import 'package:frockbot_native/theme/frock_theme.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'widget_test.dart' show MemoryStore;

const _first = 'message-00000000000000000001';
const _second = 'message-00000000000000000002';

class _Server extends NativeApi {
  _Server(super.store);
  List<Map<String, Object?>> turns = [_run('run-1', 'First reply.', 0)];
  final commands = <Map<String, dynamic>>[];
  final registrations = <Map<String, dynamic>>[];
  bool manual = false;
  String activity = _first;
  String seen = _first;
  String lastMessageId = 'run-1:send:0';

  int get count => activity.compareTo(seen) > 0 ? 1 : 0;

  /// A second message committed. The chat shows it only once the transcript
  /// is read again; the unread view shows it on the next poll.
  void reply({required bool inChat}) {
    activity = _second;
    lastMessageId = 'run-2:send:0';
    if (inChat) turns = [...turns, _run('run-2', 'Second reply.', 1)];
  }

  Map<String, Object?> get view => {
    'schemaVersion': 1,
    'botId': 'alpha',
    'count': count,
    'capped': false,
    'unread': count > 0 || manual,
    'manuallyUnread': manual,
    'notificationsEnabled': true,
    'lastActivityCursor': activity,
    'lastSeenCursor': seen,
    'lastMessageId': lastMessageId,
    'lastActivityAt': '2026-09-05T12:20:00.000Z',
    'lastViewedAt': '2026-09-05T12:19:00.000Z',
  };

  @override
  Future<Object?> request(
    String path, {
    Object? body,
    int limit = 512000,
    bool authenticated = true,
  }) async {
    switch (path) {
      case '/api/bots':
        return {
          'schemaVersion': 1,
          'revision': 1,
          'bots': [
            {
              'schemaVersion': 1,
              'botId': 'alpha',
              'registeredAt': '2026-09-05T00:00:00.000Z',
              'initialName': 'Alpha',
              'avatar': {
                'schemaVersion': 1,
                'characterId': 'pixel',
                'primary': '#fc85ae',
              },
            },
          ],
        };
      case '/api/bots/lifecycles':
        return {'schemaVersion': 1, 'lifecycles': const []};
      case '/api/bots/unread':
        return {
          'schemaVersion': 1,
          'unread': [view],
        };
      case '/api/push/device':
        registrations.add(Map<String, dynamic>.from(body! as Map));
        return {'ok': true};
      case '/api/bots/alpha/unread':
        final command = Map<String, dynamic>.from(body! as Map);
        commands.add(command);
        if (command['type'] == 'bot/mark-read') {
          seen = command['upToCursor'] as String;
          manual = false;
        } else {
          manual = true;
        }
        return {
          'schemaVersion': 1,
          'commandId': command['commandId'],
          'status': 'applied',
          'unread': view,
        };
    }
    if (path.endsWith('/turns')) {
      return {
        'schemaVersion': 1,
        'runs': turns,
        'page': {'truncated': false},
      };
    }
    throw const FormatException('offline fixture');
  }

  @override
  Future<WebSocketChannel> socket(
    String botId, {
    String? cursor,
    String? epoch,
  }) async => throw const FormatException('offline fixture');
}

Map<String, Object?> _run(String runId, String text, int minute) => {
  'schemaVersion': 3,
  'runId': runId,
  'input': 'Hello',
  'status': 'completed',
  'admittedAt': '2026-09-05T12:1$minute:00.000Z',
  'events': [
    {
      'type': 'send/to-user',
      'payload': {'type': 'text', 'text': text},
      'ordinal': 0,
    },
  ],
  'outcome': {'type': 'completed', 'text': ''},
};

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late _Server server;
  late BotSessions sessions;
  late ValueNotifier<String?> links;
  late List<String?> dock;

  List<String?> types() => [
    for (final command in server.commands) command['type'] as String?,
  ];

  /// A Mac at the widest tier with Alpha open, and the unread fan-out and the
  /// transcript both read.
  Future<void> openAlpha(WidgetTester tester, {bool manual = false}) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
    tester.view.physicalSize = const Size(1440, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    dock = [];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(const MethodChannel('com.frockbot/badge'), (
          call,
        ) async {
          dock.add((call.arguments as Map)['label'] as String?);
          return null;
        });
    final store = MemoryStore();
    store.values['selection.test-user'] = 'alpha';
    server = _Server(store)..manual = manual;
    sessions = BotSessions(api: server, store: store);
    links = ValueNotifier<String?>(null);
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: AppShell(
          api: server,
          store: store,
          sessions: sessions,
          userId: 'test-user',
          botLinks: links,
          onSignOut: () async {},
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('First reply.'), findsOneWidget);
  }

  Future<void> close(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox());
    await tester.pumpAndSettle();
    sessions.clear();
    links.dispose();
    server.close();
    debugDefaultTargetPlatformOverride = null;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          const MethodChannel('com.frockbot/badge'),
          null,
        );
  }

  group('a manual unread mark', () {
    testWidgets('is cleared by opening the Bot', (tester) async {
      await openAlpha(tester, manual: true);
      expect(types(), ['bot/mark-read']);
      expect(server.manual, isFalse);
      await close(tester);
    });

    // Opening clears the mark once. With nothing to clear, that open was
    // still spent, so a mark the person makes on the chat they are reading is
    // a reminder they asked for — not something the next frame takes back.
    testWidgets('made on the open Bot stays', (tester) async {
      await openAlpha(tester);
      expect(server.commands, isEmpty);

      await tester.longPress(find.text('First reply.'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Mark unread from here'));
      await tester.pumpAndSettle();
      await tester.pump(const Duration(seconds: 11));
      await tester.pumpAndSettle();

      expect(types(), ['bot/mark-unread']);
      expect(server.manual, isTrue);
      await close(tester);
    });

    testWidgets('made on another device while the Bot is open stays', (
      tester,
    ) async {
      await openAlpha(tester);
      server.manual = true;
      await tester.pump(const Duration(seconds: 11));
      await tester.pumpAndSettle();

      expect(server.commands, isEmpty);
      expect(server.manual, isTrue);
      await close(tester);
    });
  });

  group('presence on the chat being read', () {
    // The chat shows a reply a poll before the unread view names it. Dropping
    // the claim in between let the cloud send the Turn's next message to every
    // device as an alert — including the one it was being read on.
    testWidgets('holds while a reply lands, and the reply is read at once', (
      tester,
    ) async {
      await openAlpha(tester);
      expect(server.registrations.last['activeBotId'], 'alpha');
      final claimed = server.registrations.length;

      server.reply(inChat: true);
      await sessions.open('test-user', 'alpha').controller.refresh();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 500));

      expect(find.text('Second reply.'), findsOneWidget);
      expect(
        server.registrations.skip(claimed).map((row) => row['activeBotId']),
        everyElement('alpha'),
      );
      // Well inside the ten-second poll: the shell asked for the view itself.
      expect(types(), ['bot/mark-read']);
      expect(server.commands.single['upToCursor'], _second);
      expect(server.count, 0);
      await close(tester);
    });

    // A cloud ahead of this device names a message the chat has not drawn.
    // Nobody here has seen it, so nothing may hold its alert back.
    testWidgets('is let go when the cloud names a message the chat lacks', (
      tester,
    ) async {
      await openAlpha(tester);
      expect(server.registrations.last['activeBotId'], 'alpha');

      server.reply(inChat: false);
      await tester.pump(const Duration(seconds: 11));
      await tester.pumpAndSettle();

      expect(find.text('Second reply.'), findsNothing);
      expect(server.registrations.last.containsKey('activeBotId'), isFalse);
      expect(server.commands, isEmpty);
      await close(tester);
    });
  });

  // The dock is the Mac's only alert, and a minimised window is exactly when
  // it is needed. A hidden window also draws no frames, so the badge cannot
  // wait for a build to be reconciled.
  testWidgets('a minimised Mac window keeps its dock badge current', (
    tester,
  ) async {
    await openAlpha(tester);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    await tester.pump(const Duration(seconds: 1));
    final hidden = dock.length;

    server.reply(inChat: true);
    await tester.pump(const Duration(seconds: 31));
    expect(dock.skip(hidden), ['1']);

    // Read on another device: the dock follows that too.
    server.seen = _second;
    await tester.pump(const Duration(seconds: 30));
    expect(dock.skip(hidden), ['1', null]);

    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await close(tester);
  });
}
