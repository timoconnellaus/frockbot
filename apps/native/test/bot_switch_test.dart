import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/bot_sessions.dart';
import 'package:frockbot_native/client/chat_controller.dart';
import 'package:frockbot_native/client/page_cache.dart';
import 'package:frockbot_native/client/plain_store.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/main.dart';
import 'package:frockbot_native/ui/frock_widgets.dart';

/// A store whose values are resident, and whose writes only complete when the
/// test says so — the platform keystore is slow and the UI cannot wait for it.
class LatchedStore implements SnapshotStore {
  final values = <String, String>{};
  final Completer<void>? latch;
  int reads = 0;
  LatchedStore({this.latch});
  @override
  bool get resident => true;
  @override
  String? peek(String key) => values[key];
  @override
  Future<String?> read(String key) async {
    reads++;
    return values[key];
  }

  @override
  Future<void> write(String key, String value) async {
    await latch?.future;
    values[key] = value;
  }

  @override
  Future<void> delete(String key) async {
    await latch?.future;
    values.remove(key);
  }
}

class FakeSecrets implements EnumerableStore {
  final values = <String, String>{};
  int enumerations = 0;
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> write(String key, String value) async => values[key] = value;
  @override
  Future<void> delete(String key) async {
    values.remove(key);
  }

  @override
  Future<Map<String, String>> readAll() async {
    enumerations++;
    return Map<String, String>.from(values);
  }
}

class LatchedPages implements ChatTransport {
  final pages = <Completer<Map<String, dynamic>>>[];
  @override
  Future<Map<String, dynamic>> page(
    String botId, {
    String? before,
    String? conversationId,
  }) {
    final page = Completer<Map<String, dynamic>>();
    pages.add(page);
    return page.future;
  }

  @override
  Future<void> send(String botId, String id, String text) async {}
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
  ) async => throw UnimplementedError();
}

Map<String, dynamic> run(String id, String input) => {
  'schemaVersion': 1,
  'runId': id,
  'admittedAt': '2026-09-05T00:00:00.000Z',
  'input': input,
  'status': 'completed',
  'events': <Object>[],
};

String session(String userId) => jsonEncode({
  'schemaVersion': 1,
  'sessionId': 'session-1',
  'userId': userId,
  'expiresAt': '2036-09-05T00:00:00.000Z',
  'sessionToken': 'token-1',
});

Map<String, dynamic> registration(String botId, String name) => {
  'schemaVersion': 1,
  'botId': botId,
  'registeredAt': '2026-09-05T00:00:00.000Z',
  'initialName': name,
  'sheep': {
    'schemaVersion': 1,
    'background': 'a',
    'upper': 'b',
    'middle': 'c',
    'lower': 'd',
  },
};

void main() {
  testWidgets('choosing another Bot switches before the selection is stored', (
    tester,
  ) async {
    final latch = Completer<void>();
    final store = LatchedStore(latch: latch);
    store.values['session'] = session('user-1');
    store.values['directory/user-1'] = jsonEncode({
      'schemaVersion': 1,
      'revision': 1,
      'bots': [
        registration('bot-one', 'Rosemary'),
        registration('bot-two', 'Clementine'),
      ],
    });
    store.values['selection.user-1'] = 'bot-one';
    await tester.pumpWidget(FrockBotApp(store: store));
    await tester.pump();
    await tester.pump();
    expect(
      find.descendant(
        of: find.byType(FrockBar),
        matching: find.text('Rosemary'),
      ),
      findsOneWidget,
    );
    await tester.tap(find.byKey(const ValueKey('bot-bot-two')));
    await tester.pump();
    // The keystore write has not completed and must not be holding the pane.
    expect(latch.isCompleted, isFalse);
    expect(store.values['selection.user-1'], 'bot-one');
    expect(
      find.descendant(
        of: find.byType(FrockBar),
        matching: find.text('Clementine'),
      ),
      findsOneWidget,
    );
    latch.complete();
    await tester.pump();
    expect(store.values['selection.user-1'], 'bot-two');
    await tester.pumpWidget(const SizedBox());
    await tester.pump();
  });

  test('a cached transcript is on screen before the first page resolves', () {
    final store = LatchedStore();
    store.values[pageCacheKey('user-1', 'bot-1')] = encodePageCache([
      run('run-1', 'Earlier message'),
    ], 'older');
    final transport = LatchedPages();
    final controller = ChatController(
      transport: transport,
      store: store,
      userId: 'user-1',
      botId: 'bot-1',
    );
    final initialized = controller.initialize();
    // Nothing has been awaited yet: this is the first frame of the switch.
    expect(controller.ready, isTrue);
    expect(controller.runs.length, 1);
    expect(controller.runs.first['input'], 'Earlier message');
    expect(controller.before, 'older');
    expect(store.reads, 0);
    return Future(() async {
      transport.pages.single.complete({
        'runs': [run('run-2', 'Latest message')],
        'page': {'truncated': false},
      });
      await initialized;
      expect(controller.runs.map((row) => row['input']), [
        'Earlier message',
        'Latest message',
      ]);
      // The live projection replaces the cursor the cache restored.
      expect(controller.before, isNull);
      await Future<void>.delayed(Duration.zero);
      expect(
        decodePageCache(store.values[pageCacheKey('user-1', 'bot-1')])!
            .runs
            .length,
        2,
      );
      controller.dispose();
    });
  });

  test(
    'the session is read from the keystore once, not on every request',
    () async {
      final store = LatchedStore();
      store.values['session'] = session('user-1');
      final api = NativeApi(store);
      final headers = await Future.wait([
        for (var index = 0; index < 5; index++) api.headers(),
      ]);
      for (final value in headers) {
        expect(value['authorization'], 'Bearer token-1');
      }
      expect((await api.headers())['authorization'], 'Bearer token-1');
      expect(store.reads, 1);
      api.adoptSession(null);
      expect((await api.headers()).containsKey('authorization'), isFalse);
      expect(store.reads, 1);
      api.close();
    },
  );

  test('a Bot keeps its live session; evicted Bots are disposed', () {
    final store = LatchedStore();
    final sessions = BotSessions(api: NativeApi(store), store: store, limit: 3);
    final first = sessions.open('user-1', 'bot-1');
    expect(identical(sessions.open('user-1', 'bot-1'), first), isTrue);
    expect(
      identical(first.controller, sessions.open('user-1', 'bot-1').controller),
      isTrue,
    );
    sessions.open('user-1', 'bot-2');
    sessions.open('user-1', 'bot-3');
    expect(first.disposed, isFalse);
    expect(sessions.live, 3);
    // The least recently opened Bot is the one that gives up its session.
    sessions.open('user-1', 'bot-4');
    expect(sessions.live, 3);
    expect(first.disposed, isTrue);
    final second = sessions.open('user-1', 'bot-2');
    expect(second.disposed, isFalse);
    sessions.clear();
    expect(second.disposed, isTrue);
    expect(sessions.live, 0);
  });

  test('non-secret values move out of the keystore exactly once', () async {
    final directory = await Directory.systemTemp.createTemp('frockbot-store');
    addTearDown(() => directory.delete(recursive: true));
    final secrets = FakeSecrets();
    secrets.values['session'] = session('user-1');
    secrets.values['sign-in'] = '{"verifier":"secret"}';
    secrets.values['selection.user-1'] = 'bot-two';
    secrets.values['chat/user-1/bot-two'] = '{"version":1,"draft":"Hello"}';
    final store = SplitStore(
      secrets: secrets,
      plain: PlainStore(location: () async => directory),
      enumerate: secrets.readAll,
    );
    expect(await store.read('selection.user-1'), 'bot-two');
    expect(
      await store.read('chat/user-1/bot-two'),
      '{"version":1,"draft":"Hello"}',
    );
    expect(secrets.values.containsKey('selection.user-1'), isFalse);
    expect(secrets.values.containsKey('chat/user-1/bot-two'), isFalse);
    // The session and the sign-in verifier are the only secrets, and they stay.
    expect(secrets.values['session'], session('user-1'));
    expect(await store.read('session'), session('user-1'));
    expect(store.peek('session'), isNull);
    expect(secrets.values['sign-in'], '{"verifier":"secret"}');
    expect(store.resident, isTrue);
    expect(store.peek('selection.user-1'), 'bot-two');

    // A later launch finds the migration done and never enumerates again.
    final relaunched = SplitStore(
      secrets: secrets,
      plain: PlainStore(location: () async => directory),
      enumerate: secrets.readAll,
    );
    expect(await relaunched.read('selection.user-1'), 'bot-two');
    await relaunched.write('selection.user-1', 'bot-three');
    expect(secrets.enumerations, 1);
    expect(secrets.values.containsKey('selection.user-1'), isFalse);

    // The plain document is durable: a third launch reads what was written.
    final reopened = SplitStore(
      secrets: secrets,
      plain: PlainStore(location: () async => directory),
      enumerate: secrets.readAll,
    );
    expect(await reopened.read('selection.user-1'), 'bot-three');
  });
}
