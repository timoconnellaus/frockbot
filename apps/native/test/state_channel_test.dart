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
  Future<WebSocketChannel> socket(String botId, String? cursor) async {
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

  void sendReady(String cursor) => frames.add(
    jsonEncode({'schemaVersion': 1, 'type': 'state/ready', 'cursor': cursor}),
  );

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class LiveSocketApi extends NativeApi {
  LiveSocketApi(super.store);
  final opened = <FakeSocket>[];

  @override
  Future<WebSocketChannel> socket(String botId, String? cursor) async {
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
        invalidate: () async {},
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
      invalidate: () async {},
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
    store.values['cursor/user-1/bot-1'] = '7';
    final states = <ConnectionState>[];
    final api = LiveSocketApi(store);
    final channel = BotStateChannel(
      api: api,
      store: store,
      key: 'cursor/user-1/bot-1',
      botId: 'bot-1',
      invalidate: () async {},
      status: states.add,
    );

    await channel.connect();
    api.opened.single.sendReady('7');
    await settle();
    expect(states, [ConnectionState.initializing, ConnectionState.connected]);

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
}
