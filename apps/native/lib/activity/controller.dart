import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../client/transport.dart';
import '../protocol/client_wire.generated.dart' as wire;

/// Navigation only; authority comes from membership in the live directory.
String? botLink(Uri uri) {
  if (uri.scheme != 'https' ||
      uri.origin != hostedOrigin ||
      uri.userInfo.isNotEmpty ||
      uri.hasFragment ||
      (uri.path != '/' && uri.path.isNotEmpty) ||
      uri.queryParametersAll['bot']?.length != 1) {
    return null;
  }
  try {
    return wire.BotId.fromJson(uri.queryParameters['bot']).value;
  } catch (_) {
    return null;
  }
}

class ActivityController extends ChangeNotifier {
  final NativeApi api;
  final LocalStore store;
  final String userId;
  ActivityController(this.api, this.store, this.userId);
  Map<String, wire.UnreadView> unread = {};
  String? error;
  bool loading = false;
  bool loaded = false;
  bool _disposed = false;

  /// One retained command per Bot, and the Bots whose command is in flight.
  /// Both are keyed by Bot because the controls are a Bot's: a single flag
  /// disabled every Bot's unread menu while any one of them was marked.
  final Map<String, Map<String, dynamic>> _pending = {};
  final Set<String> _sending = {};

  /// What the badge said before a prediction was drawn over it, so a refused
  /// command puts back what the cloud last reported. A Bot the directory did
  /// not mention is held as a null.
  final Map<String, wire.UnreadView?> _predicted = {};
  bool get pending => _pending.isNotEmpty;
  bool get saving => _sending.isNotEmpty;

  /// Whether this Bot's unread controls are waiting on a command of their own.
  bool busy(String botId) =>
      _pending.containsKey(botId) || _sending.contains(botId);
  String get _key => 'activity-pending.$userId';
  void _notify() {
    if (!_disposed) notifyListeners();
  }

  Future<void> load() async {
    if (_disposed || loading || saving) return;
    loading = true;
    _notify();
    try {
      final saved = await store.read(_key);
      if (saved != null) await _restore(saved);
      final views = wire.UnreadDirectory.fromJson(
        await api.request('/api/bots/unread'),
      );
      if (_disposed) return;
      unread = {for (final view in views.unread) view.botId.value: view};
      loaded = true;
      error = null;
    } catch (_) {
      if (!_disposed) {
        error = 'Couldn’t reach FrockBot. Check your connection and try again.';
      }
    } finally {
      loading = false;
      _notify();
    }
  }

  Future<void> mark(
    String botId, {
    required bool read,
    String? fromMessageId,
  }) async {
    if (_disposed || busy(botId) || loading) return;
    final cursor = unread[botId]?.lastActivityCursor?.value;
    if (read && cursor == null) return;
    final command = wire.MarkReadCommand.fromJson({
      'schemaVersion': 1,
      'type': read ? 'bot/mark-read' : 'bot/mark-unread',
      'commandId': randomId(),
      'botId': botId,
      if (read) 'upToCursor': cursor,
      if (!read && fromMessageId != null) 'fromMessageId': fromMessageId,
    });
    _pending[botId] = Map<String, dynamic>.from(command.toJson() as Map);
    _predict(botId, read: read, fromMessageId: fromMessageId);
    await _send(botId);
  }

  /// Draws the badge the tap asked for, ahead of the receipt that confirms it.
  ///
  /// Read and manual unread are the whole of what the command says, and the
  /// client decided both before sending: marking read empties the badge,
  /// marking unread lights it. What a Bot accrues afterwards is the cloud's to
  /// report, so nothing here invents a count — the receipt replaces this view
  /// wholesale, and a refusal restores the one it was drawn over.
  void _predict(String botId, {required bool read, String? fromMessageId}) {
    _predicted.putIfAbsent(botId, () => unread[botId]);
    final before = (unread[botId]?.toJson() as Map?)?.cast<String, Object?>();
    unread[botId] = wire.UnreadView.fromJson({
      'schemaVersion': 1,
      'botId': botId,
      'count': 0,
      'capped': false,
      'manuallyUnread': false,
      ...?before,
      if (read) ...{
        'count': 0,
        'capped': false,
        'unread': false,
        'manuallyUnread': false,
      } else ...{
        'unread': true,
        'manuallyUnread': true,
        'unreadFromMessageId': ?fromMessageId,
      },
    });
    _notify();
  }

  /// Puts back what the cloud last said about this Bot. A command retained for
  /// a later attempt rolls back too: until the cloud has accepted it, its own
  /// answer is the only honest thing to draw.
  void _rollback(String botId) {
    if (!_predicted.containsKey(botId)) return;
    final before = _predicted.remove(botId);
    if (before == null) {
      unread.remove(botId);
    } else {
      unread[botId] = before;
    }
  }

  /// A command this build cannot speak is dropped, never retried for ever.
  ///
  /// Read state is disposable: the cloud is authoritative and the next glance
  /// at the conversation marks it again. A command left behind by an older
  /// build — one naming a cursor this build no longer accepts — would fail to
  /// decode on every attempt, and a retained command gates that Bot's marking,
  /// manual unread and acknowledgement alike, so keeping it would disable all
  /// three for that Bot until its data was cleared.
  Future<void> _discard(String? botId) async {
    if (botId == null) {
      _pending.clear();
    } else {
      _pending.remove(botId);
    }
    try {
      await _persist();
    } catch (_) {
      /* The next write replaces it; nothing here is authoritative. */
    }
  }

  Future<void> _persist() async {
    if (_pending.isEmpty) {
      await store.delete(_key);
      return;
    }
    await store.write(_key, jsonEncode(_pending));
  }

  Future<void> _restore(String saved) async {
    final Map<String, dynamic> held;
    try {
      held = Map<String, dynamic>.from(jsonDecode(saved) as Map);
    } catch (_) {
      await _discard(null);
      return;
    }
    for (final entry in held.entries) {
      try {
        final command = wire.MarkReadCommand.fromJson(
          Map<String, dynamic>.from(entry.value as Map),
        );
        _pending[entry.key] = Map<String, dynamic>.from(
          command.toJson() as Map,
        );
      } catch (_) {
        await _discard(entry.key);
      }
    }
  }

  /// Every command still waiting for an answer, sent again.
  Future<void> retry() async {
    for (final botId in _pending.keys.toList()) {
      await _send(botId);
    }
  }

  Future<void> _send(String botId) async {
    if (_disposed || _sending.contains(botId)) return;
    final held = _pending[botId];
    if (held == null) return;
    final Map<String, dynamic> body;
    try {
      body = Map<String, dynamic>.from(
        wire.MarkReadCommand.fromJson(held).toJson() as Map,
      );
    } catch (_) {
      await _discard(botId);
      _rollback(botId);
      error = _refused;
      _notify();
      return;
    }
    _sending.add(botId);
    _notify();
    try {
      await _persist();
      if (_disposed) return;
      final receipt = wire.MarkReadReceipt.fromJson(
        await api.request(
          '/api/bots/${Uri.encodeComponent(body['botId'] as String)}/unread',
          body: body,
        ),
      );
      if (receipt.commandId.value != body['commandId'] ||
          receipt.unread.botId.value != body['botId']) {
        throw const FormatException('Mismatched unread receipt');
      }
      _pending.remove(botId);
      await _persist();
      _predicted.remove(botId);
      unread[receipt.unread.botId.value] = receipt.unread;
      error = null;
    } catch (_) {
      _rollback(botId);
      error = _refused;
    } finally {
      _sending.remove(botId);
      _notify();
    }
  }

  static const _refused =
      'Couldn’t confirm the read status. Check it before making another change.';

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
