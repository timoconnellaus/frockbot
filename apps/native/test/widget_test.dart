import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/chat_controller.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/main.dart';

class MemoryStore implements LocalStore {
  final values = <String, String>{};
  bool fail = false;
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> write(String key, String value) async {
    if (fail) throw StateError('storage unavailable');
    values[key] = value;
  }

  @override
  Future<void> delete(String key) async {
    values.remove(key);
  }
}

Map<String, dynamic> running() => {
  'runId': 'send-1',
  'admittedAt': '2026-09-05T01:00:00Z',
  'input': 'Hello',
  'status': 'running',
  'events': <Object>[],
};

class FakeTransport implements ChatTransport {
  final MemoryStore store;
  final calls = <String>[];
  final completion = Completer<void>();
  Map<String, dynamic>? observed;
  bool loseReply = false;
  FakeTransport(this.store);
  @override
  Future<Map<String, dynamic>> page(
    String botId, {
    String? before,
    String? conversationId,
  }) async => {
    'runs': observed == null ? <Object>[] : [observed],
    'page': {'truncated': false},
  };
  @override
  Future<void> send(String botId, String id, String text) async {
    expect(jsonDecode(store.values['chat/user-1/bot-1']!)['pendingId'], id);
    calls.add('send:$id');
    await completion.future;
    if (loseReply) throw const RequestFailure('lost');
  }

  @override
  Future<Map<String, dynamic>?> lookup(
    String botId,
    String id, {
    bool fence = false,
  }) async {
    calls.add(fence ? 'fence:$id' : 'lookup:$id');
    return observed;
  }

  @override
  Future<Map<String, dynamic>> stop(
    String botId,
    String id,
    String commandId,
  ) async {
    expect(jsonDecode(store.values['chat/user-1/bot-1']!)['stopId'], commandId);
    calls.add('stop:$commandId');
    return {...running(), 'stopRequestedAt': '2026-09-05T01:01:00Z'};
  }
}

void main() {
  testWidgets(
    'send persists identity; Stop is explicit and remains until terminal',
    (tester) async {
      final store = MemoryStore();
      final t = FakeTransport(store);
      var ids = 0;
      final c = ChatController(
        transport: t,
        store: store,
        userId: 'user-1',
        botId: 'bot-1',
        nextId: () => ++ids == 1 ? 'send-1' : 'stop-1',
      );
      await c.initialize();
      c.connection = ConnectionState.connected;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ChatPane(controller: c, onReconnect: () async {}),
          ),
        ),
      );
      await tester.enterText(find.byKey(const ValueKey('composer')), 'Hello');
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('send')));
      await tester.pump();
      expect(t.calls, ['send:send-1']);
      await tester.tap(find.byKey(const ValueKey('stop')));
      await tester.pump();
      expect(find.text('Stopping…'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('stop')));
      await tester.pump();
      expect(t.calls.where((x) => x.startsWith('stop:')), [
        'stop:stop-1',
        'stop:stop-1',
      ]);
      t.observed = {...running(), 'status': 'cancelled'};
      t.completion.complete();
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('stop')), findsNothing);
      await tester.pumpWidget(const SizedBox());
      c.dispose();
    },
  );
  testWidgets('reconnect and widget disposal never send or stop work', (
    tester,
  ) async {
    final store = MemoryStore();
    final t = FakeTransport(store);
    final c = ChatController(
      transport: t,
      store: store,
      userId: 'user-1',
      botId: 'bot-1',
    );
    var reconnects = 0;
    c.connection = ConnectionState.disconnected;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ChatPane(
            controller: c,
            onReconnect: () async {
              reconnects++;
              await c.refresh();
            },
          ),
        ),
      ),
    );
    await tester.tap(find.byKey(const ValueKey('reconnect')));
    await tester.pumpAndSettle();
    expect(reconnects, 1);
    await tester.pumpWidget(const SizedBox());
    c.dispose();
    expect(t.calls, isEmpty);
  });
  test(
    'failed persistence prevents dispatch; a lost reply looks up then fences',
    () async {
      final store = MemoryStore()..fail = true;
      final t = FakeTransport(store);
      final c = ChatController(
        transport: t,
        store: store,
        userId: 'user-1',
        botId: 'bot-1',
        nextId: () => 'send-1',
      );
      await c.initialize();
      await c.send('Hello');
      expect(t.calls, isEmpty);
      expect(c.draft, 'Hello');
      store.fail = false;
      t.loseReply = true;
      t.completion.complete();
      await c.send('Hello');
      expect(t.calls, ['send:send-1', 'lookup:send-1', 'fence:send-1']);
      expect(c.pendingId, isNull);
      expect(c.draft, 'Hello');
      c.dispose();
    },
  );
  test(
    'process reconstruction checks a saved command without retransmitting',
    () async {
      final store = MemoryStore();
      final first = FakeTransport(store);
      final c = ChatController(
        transport: first,
        store: store,
        userId: 'user-1',
        botId: 'bot-1',
        nextId: () => 'send-1',
      );
      await c.initialize();
      final send = c.send('Hello');
      await Future<void>.delayed(Duration.zero);
      c.dispose();
      final second = FakeTransport(store)..observed = running();
      final restored = ChatController(
        transport: second,
        store: store,
        userId: 'user-1',
        botId: 'bot-1',
      );
      await restored.initialize();
      expect(second.calls, ['lookup:send-1']);
      expect(restored.activeRunId, 'send-1');
      expect(restored.draft, '');
      first.observed = running();
      first.completion.complete();
      await send;
      restored.dispose();
    },
  );
}
