import 'dart:async';

import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/chat_controller.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/shell/chat_pane.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'widget_test.dart' show MemoryStore, FakeTransport, running;

/// A send that never answers, and lookups that stay open until the test says.
class GatedLookup implements ChatTransport {
  final gates = <Completer<Map<String, dynamic>?>>[];

  @override
  Future<Map<String, dynamic>> page(String botId, {String? before}) async => {
    'runs': <Object?>[],
    'page': {'truncated': false},
  };

  @override
  Future<void> send(
    String botId,
    String id,
    String text, {
    String? supersedes,
    String? retryOf,
  }) async {
    throw const RequestFailure('lost');
  }

  @override
  Future<Map<String, dynamic>?> lookup(
    String botId,
    String id, {
    bool fence = false,
  }) {
    final gate = Completer<Map<String, dynamic>?>();
    gates.add(gate);
    return gate.future;
  }

  @override
  Future<Map<String, dynamic>> stop(
    String botId,
    String id,
    String commandId,
  ) async => {'runId': id};
}

class LatchedTransport extends FakeTransport {
  final pages = <Completer<Map<String, dynamic>>>[];
  LatchedTransport(super.store);
  @override
  Future<Map<String, dynamic>> page(String botId, {String? before}) {
    final page = Completer<Map<String, dynamic>>();
    pages.add(page);
    return page.future;
  }
}

void main() {
  test(
    'an observer event cannot fence a POST that is still in flight',
    () async {
      final store = MemoryStore();
      final transport = FakeTransport(store);
      final controller = ChatController(
        transport: transport,
        store: store,
        userId: 'user-1',
        botId: 'bot-1',
        nextId: () => 'send-1',
      );
      await controller.initialize();
      final send = controller.send('Hello');
      await Future<void>.delayed(Duration.zero);
      await controller.invalidate();
      expect(transport.calls, ['send:send-1']);
      transport.observed = running();
      transport.completion.complete();
      await send;
      expect(transport.calls, ['send:send-1', 'lookup:send-1']);
      controller.dispose();
    },
  );
  test(
    'observer refresh waits for stale request then applies its own fresh page',
    () async {
      final store = MemoryStore();
      final transport = LatchedTransport(store);
      final controller = ChatController(
        transport: transport,
        store: store,
        userId: 'user-1',
        botId: 'bot-1',
      );
      final stale = controller.refresh();
      await Future<void>.delayed(Duration.zero);
      var newerApplied = false;
      final fresh = controller.refresh().then((_) {
        newerApplied = true;
      });
      transport.pages[0].complete({
        'runs': [],
        'page': {'truncated': false},
      });
      await stale;
      await Future<void>.delayed(Duration.zero);
      expect(newerApplied, isFalse);
      expect(transport.pages, hasLength(2));
      transport.pages[1].complete({
        'runs': [running()],
        'page': {'truncated': false},
      });
      await fresh;
      expect(controller.runs.single['runId'], 'send-1');
      controller.dispose();
    },
  );
  test(
    'failed receipt persistence retains pending identity for another lookup',
    () async {
      final store = MemoryStore();
      final transport = FakeTransport(store)..observed = running();
      final controller = ChatController(
        transport: transport,
        store: store,
        userId: 'user-1',
        botId: 'bot-1',
      );
      controller.pending = const [PendingSend('send-1', 'Hello')];
      store.fail = true;
      await controller.checkDelivery();
      // The submission is kept, so the next lookup asks about it again rather
      // than losing what the person sent.
      expect(controller.pending.single.id, 'send-1');
      expect(
        controller.error,
        'Couldn’t confirm your message. Reconnect or check again.',
      );
      store.fail = false;
      await controller.checkDelivery();
      expect(controller.pending, isEmpty);
      expect(transport.calls, ['lookup:send-1', 'lookup:send-1']);
      controller.dispose();
    },
  );

  test('a lost reply stays quiet while it is looked up', () async {
    final transport = GatedLookup();
    final controller = ChatController(
      transport: transport,
      store: MemoryStore(),
      userId: 'user-1',
      botId: 'bot-1',
      nextId: () => 'send-1',
    );
    await controller.initialize();
    final sending = controller.send('Hello');
    await Future<void>.delayed(Duration.zero);
    expect(transport.gates, hasLength(1));
    expect(controller.error, isNull);
    expect(controller.stoppable, isTrue);
    transport.gates.single.complete({
      ...running(),
      'runId': 'send-1',
      'input': 'Hello',
    });
    await sending;
    expect(controller.error, isNull);
    expect(controller.pending, isEmpty);
    expect(controller.runs.single['runId'], 'send-1');
    controller.dispose();
  });

  test(
    'a second lost reply is looked up after the check already walking the list',
    () async {
      final transport = GatedLookup();
      var next = 0;
      final controller = ChatController(
        transport: transport,
        store: MemoryStore(),
        userId: 'user-1',
        botId: 'bot-1',
        nextId: () => 'send-${next += 1}',
      );
      await controller.initialize();
      final first = controller.send('one');
      await Future<void>.delayed(Duration.zero);
      expect(controller.error, isNull);

      final second = controller.send('two');
      await Future<void>.delayed(Duration.zero);
      expect(transport.gates, hasLength(1));
      expect(
        [for (final entry in controller.pending) entry.text],
        ['one', 'two'],
      );
      expect(controller.error, isNull);

      transport.gates[0].complete(null);
      await Future<void>.delayed(Duration.zero);
      transport.gates[1].complete(null);
      await Future<void>.delayed(Duration.zero);
      expect(transport.gates, hasLength(3));
      expect(controller.pending.single.text, 'two');

      transport.gates[2].complete(null);
      await Future<void>.delayed(Duration.zero);
      transport.gates[3].complete(null);
      await first;
      await second;
      expect(controller.pending, isEmpty);
      expect(
        controller.error,
        'Your message didn’t go through. You can send it again.',
      );
      controller.dispose();
    },
  );

  testWidgets('checking a lost reply is not a pink error, and giving up is', (
    tester,
  ) async {
    final transport = GatedLookup();
    final controller = ChatController(
      transport: transport,
      store: MemoryStore(),
      userId: 'user-1',
      botId: 'bot-1',
      nextId: () => 'send-1',
    );
    await controller.initialize();
    controller.connection = ConnectionState.connected;
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: Scaffold(
          body: ChatPane(controller: controller, onReconnect: () async {}),
        ),
      ),
    );
    await tester.enterText(find.byKey(const ValueKey('composer')), 'Hello');
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('send')));
    await tester.pump();

    expect(transport.gates, hasLength(1));
    expect(
      find.text('Checking whether your message went through…'),
      findsNothing,
    );
    expect(find.byKey(const ValueKey('stop')), findsOneWidget);

    transport.gates.single.complete(null);
    await tester.pump();
    transport.gates[1].complete(null);
    await tester.pump();

    final failure = find.text(
      'Your message didn’t go through. You can send it again.',
    );
    expect(failure, findsOneWidget);
    expect(
      tester.widget<Text>(failure).style?.color,
      FrockTheme.theme(Brightness.dark).colorScheme.error,
    );
    expect(find.byKey(const ValueKey('stop')), findsNothing);
    await tester.pumpWidget(const SizedBox());
    controller.dispose();
  });
}
