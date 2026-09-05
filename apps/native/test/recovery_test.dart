import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/chat_controller.dart';

import 'widget_test.dart' show MemoryStore, FakeTransport, running;

class LatchedTransport extends FakeTransport {
  final pages = <Completer<Map<String, dynamic>>>[];
  LatchedTransport(super.store);
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
      controller.pendingId = 'send-1';
      controller.pendingText = 'Hello';
      store.fail = true;
      await controller.checkDelivery();
      expect(controller.pendingId, 'send-1');
      expect(controller.canSend, isFalse);
      store.fail = false;
      await controller.checkDelivery();
      expect(controller.pendingId, isNull);
      expect(transport.calls, ['lookup:send-1', 'lookup:send-1']);
      controller.dispose();
    },
  );
}
