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

void main() {
  test(
    'first synchronization is quiet; recovery and pause stay distinct',
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
      await channel.connect();
      expect(states, [
        ConnectionState.reconnecting,
        ConnectionState.disconnected,
      ]);

      states.clear();
      channel.pause();
      expect(states, [ConnectionState.paused]);

      states.clear();
      channel.resume();
      await Future<void>.delayed(Duration.zero);
      expect(states, [
        ConnectionState.reconnecting,
        ConnectionState.disconnected,
      ]);

      channel.dispose();
      api.close();
    },
  );
}
