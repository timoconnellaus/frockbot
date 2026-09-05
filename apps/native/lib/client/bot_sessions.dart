import 'dart:async';

import '../protocol/client_wire.generated.dart' as wire;
import 'chat_controller.dart';
import 'page_cache.dart';
import 'state_channel.dart';
import 'transport.dart';

/// One Bot's live conversation: its controller, its observer channel and the
/// conversation list beside them. It outlives the widget that shows it, so
/// returning to a Bot neither refetches its transcript nor reconnects it.
class BotSession {
  final NativeApi api;
  final String userId;
  final String botId;
  final ChatController controller;
  final BotStateChannel channel;
  List<wire.Conversation> conversations = const [];
  Future<void>? _started;
  bool disposed = false;
  BotSession({
    required this.api,
    required this.userId,
    required this.botId,
    required this.controller,
    required this.channel,
  });

  /// Starting is done once per session, however often its view is rebuilt.
  Future<void> start() => _started ??= _start();

  Future<void> _start() async {
    await controller.initialize();
    try {
      final list = wire.ConversationList.fromJson(
        await api.request(
          '/api/bots/${Uri.encodeComponent(botId)}/conversations',
        ),
      );
      if (disposed) return;
      conversations = list.conversations;
      controller.changed();
    } catch (_) {
      /* History itself has its own retry state. */
    }
    if (!disposed) await channel.connect();
  }

  void dispose() {
    if (disposed) return;
    disposed = true;
    channel.dispose();
    controller.dispose();
  }
}

/// The live Bot conversations this process holds. A switch between recently
/// used Bots is a lookup here rather than a rebuild of their state.
class BotSessions {
  final NativeApi api;
  final LocalStore store;
  final int limit;
  final _live = <String, BotSession>{};
  bool _paused = false;
  BotSessions({required this.api, required this.store, this.limit = 4});

  int get live => _live.length;
  String _key(String userId, String botId) => '$userId/$botId';

  BotSession open(String userId, String botId) {
    final key = _key(userId, botId);
    final existing = _live.remove(key);
    if (existing != null) {
      // Reinserting keeps the most recently opened Bot furthest from eviction.
      _live[key] = existing;
      return existing;
    }
    final controller = ChatController(
      transport: BackendChatTransport(api),
      store: store,
      userId: userId,
      botId: botId,
    );
    final channel = BotStateChannel(
      api: api,
      store: store,
      key: 'cursor/$userId/$botId',
      botId: botId,
      invalidate: controller.invalidate,
      status: (state) {
        controller.connection = state;
        controller.changed();
      },
    );
    final session = BotSession(
      api: api,
      userId: userId,
      botId: botId,
      controller: controller,
      channel: channel,
    );
    _live[key] = session;
    if (_paused) channel.pause();
    while (_live.length > limit) {
      _live.remove(_live.keys.first)!.dispose();
    }
    return session;
  }

  /// The app is in the background: no Bot holds a connection there.
  void pause() {
    _paused = true;
    for (final session in _live.values) {
      session.channel.pause();
    }
  }

  void resume() {
    _paused = false;
    for (final session in _live.values) {
      session.channel.resume();
    }
  }

  void clear() {
    for (final session in _live.values.toList()) {
      session.dispose();
    }
    _live.clear();
  }

  /// Warms the transcript of the Bots the User has not opened, so their first
  /// frame is their messages. Low priority: it waits for the selected Bot,
  /// fetches one Bot at a time, and the first refusal ends the pass.
  Future<void> prefetch(
    String userId,
    List<String> botIds, {
    String? after,
  }) async {
    if (after != null) await _live[_key(userId, after)]?.start();
    final snapshot = store is SnapshotStore ? store as SnapshotStore : null;
    final transport = BackendChatTransport(api);
    for (final botId in botIds) {
      if (botId == after || _live.containsKey(_key(userId, botId))) continue;
      if (snapshot != null &&
          snapshot.resident &&
          snapshot.peek(pageCacheKey(userId, botId)) != null) {
        continue;
      }
      try {
        final page = await transport.page(botId);
        await writePageCache(store, userId, botId, [
          for (final run in page['runs'] as List)
            Map<String, dynamic>.from(run as Map),
        ], (page['page'] as Map)['nextCursor'] as String?);
      } catch (_) {
        // One refusal is enough to say this is not a good moment to prefetch.
        return;
      }
    }
  }
}
