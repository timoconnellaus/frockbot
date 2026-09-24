import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/chat_controller.dart';
import 'package:frockbot_native/client/state_channel.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'widget_test.dart' show MemoryStore;

class OfflineSocketApi extends NativeApi {
  OfflineSocketApi(super.store);

  @override
  Future<WebSocketChannel> socket(
    String botId, {
    String? cursor,
    String? epoch,
  }) async {
    throw StateError('offline');
  }
}

class FakeSink implements WebSocketSink {
  final FakeSocket socket;
  FakeSink(this.socket);

  @override
  Future<void> close([int? closeCode, String? closeReason]) async {
    socket.closed = true;
    await socket.frames.close();
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class FakeSocket implements WebSocketChannel {
  final frames = StreamController<dynamic>();
  bool closed = false;

  @override
  Stream<dynamic> get stream => frames.stream;

  @override
  late final WebSocketSink sink = FakeSink(this);

  void sendReady({required String cursor, required String epoch}) => frames.add(
    jsonEncode({
      'schemaVersion': 1,
      'type': 'state/ready',
      'epoch': epoch,
      'cursor': cursor,
    }),
  );

  void sendUpdate(Map<String, Object?> update) => frames.add(jsonEncode(update));

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class LiveSocketApi extends NativeApi {
  LiveSocketApi(super.store);
  final opened = <FakeSocket>[];
  String? lastCursor;
  String? lastEpoch;

  @override
  Future<WebSocketChannel> socket(
    String botId, {
    String? cursor,
    String? epoch,
  }) async {
    lastCursor = cursor;
    lastEpoch = epoch;
    final socket = FakeSocket();
    opened.add(socket);
    return socket;
  }
}

Future<void> settle() async {
  for (var i = 0; i < 5; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

void main() {
  test(
    'first synchronization is quiet; pause and resume stay distinct',
    () async {
      final store = MemoryStore();
      final states = <ConnectionState>[];
      final api = OfflineSocketApi(store);
      final channel = BotStateChannel(
        api: api,
        store: store,
        key: 'cursor/user-1/bot-1',
        botId: 'bot-1',
        apply: (_) async {},
        resumeFrom: () => (epoch: null, cursor: null),
        status: states.add,
      );

      await channel.connect();
      expect(states, [
        ConnectionState.initializing,
        ConnectionState.disconnected,
      ]);

      states.clear();
      channel.pause();
      expect(states, [ConnectionState.paused]);

      states.clear();
      channel.resume();
      await settle();
      expect(states.first, ConnectionState.disconnected);

      channel.dispose();
      api.close();
    },
  );

  test('a retry from offline leaves the offline state in place', () async {
    final store = MemoryStore();
    final states = <ConnectionState>[];
    final api = OfflineSocketApi(store);
    final channel = BotStateChannel(
      api: api,
      store: store,
      key: 'cursor/user-1/bot-1',
      botId: 'bot-1',
      apply: (_) async {},
      resumeFrom: () => (epoch: null, cursor: null),
      status: states.add,
    );

    await channel.connect();
    expect(states.last, ConnectionState.disconnected);

    states.clear();
    await channel.connect();
    expect(states, isEmpty);

    channel.dispose();
    api.close();
  });

  test('resume on a live channel neither reconnects nor reports', () async {
    final store = MemoryStore();
    final states = <ConnectionState>[];
    final api = LiveSocketApi(store);
    final channel = BotStateChannel(
      api: api,
      store: store,
      key: 'cursor/user-1/bot-1',
      botId: 'bot-1',
      apply: (_) async {},
      resumeFrom: () => (epoch: '1', cursor: '7'),
      status: states.add,
    );

    await channel.connect();
    api.opened.single.sendReady(cursor: '7', epoch: '1');
    await settle();
    expect(states, [ConnectionState.initializing, ConnectionState.connected]);
    expect(api.lastCursor, '7');
    expect(api.lastEpoch, '1');

    states.clear();
    channel.resume();
    await settle();
    expect(api.opened, hasLength(1));
    expect(api.opened.single.closed, isFalse);
    expect(states, isEmpty);

    channel.pause();
    channel.resume();
    await settle();
    expect(api.opened, hasLength(2));
    expect(states, [ConnectionState.paused, ConnectionState.reconnecting]);

    channel.dispose();
    api.close();
  });

  test('a gapped update tears the socket down', () async {
    final store = MemoryStore();
    final api = LiveSocketApi(store);
    final channel = BotStateChannel(
      api: api,
      store: store,
      key: 'cursor/user-1/bot-1',
      botId: 'bot-1',
      apply: (_) async {},
      resumeFrom: () => (epoch: '1', cursor: '1'),
      status: (_) {},
    );
    await channel.connect();
    api.opened.single.sendUpdate({
      'schemaVersion': 1,
      'type': 'state/update',
      'epoch': '1',
      'cursor': '3',
      'kind': 'computer',
      'entityId': 'computer',
      'revision': 3,
      'payload': <String, Object?>{},
    });
    await settle();
    expect(api.opened.single.closed, isTrue);
    channel.dispose();
    api.close();
  });

  test('multipart parts assemble before the cursor advances', () async {
    final store = MemoryStore();
    final api = LiveSocketApi(store);
    final applied = <Map<String, dynamic>>[];
    final channel = BotStateChannel(
      api: api,
      store: store,
      key: 'cursor/user-1/bot-1',
      botId: 'bot-1',
      apply: (frame) async => applied.add(frame),
      resumeFrom: () => (epoch: '1', cursor: '1'),
      status: (_) {},
    );
    await channel.connect();
    final assembled = jsonEncode({
      'schemaVersion': 1,
      'type': 'state/update',
      'epoch': '1',
      'cursor': '2',
      'kind': 'computer',
      'entityId': 'computer',
      'revision': 2,
      'payload': <String, Object?>{},
    });
    final mid = assembled.length ~/ 2;
    api.opened.single.sendUpdate({
      'schemaVersion': 1,
      'type': 'state/part',
      'epoch': '1',
      'cursor': '2',
      'eventId': '1:2',
      'part': 0,
      'parts': 2,
      'data': assembled.substring(0, mid),
    });
    await settle();
    expect(applied, isEmpty);
    api.opened.single.sendUpdate({
      'schemaVersion': 1,
      'type': 'state/part',
      'epoch': '1',
      'cursor': '2',
      'eventId': '1:2',
      'part': 1,
      'parts': 2,
      'data': assembled.substring(mid),
    });
    await settle();
    expect(applied, hasLength(1));
    expect(applied.single['type'], 'state/update');
    expect(applied.single['cursor'], '2');
    channel.dispose();
    api.close();
  });

  test('a draft is applied in order and moves no cursor', () async {
    final store = MemoryStore();
    final api = LiveSocketApi(store);
    final applied = <Map<String, dynamic>>[];
    final channel = BotStateChannel(
      api: api,
      store: store,
      key: 'cursor/user-1/bot-1',
      botId: 'bot-1',
      apply: (frame) async => applied.add(frame),
      resumeFrom: () => (epoch: '1', cursor: '1'),
      status: (_) {},
    );
    await channel.connect();
    final socket = api.opened.single;
    socket.sendReady(cursor: '1', epoch: '1');
    socket.sendUpdate({
      'schemaVersion': 1,
      'type': 'state/draft',
      'runId': 'run-1',
      'ordinal': 0,
      'parts': ['Hel'],
    });
    // The committed frame after it still has to follow cursor 1 directly.
    socket.sendUpdate({
      'schemaVersion': 1,
      'type': 'state/update',
      'epoch': '1',
      'cursor': '2',
      'kind': 'computer',
      'entityId': 'computer',
      'revision': 2,
      'payload': <String, Object?>{},
    });
    await settle();
    expect(socket.closed, isFalse);
    expect(
      [for (final frame in applied) frame['type']],
      ['state/draft', 'state/update'],
    );
    expect(applied.first['parts'], ['Hel']);
    channel.dispose();
    api.close();
  });
}
