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
  bool saving = false;
  bool _disposed = false;
  Map<String, dynamic>? _pending;
  bool get pending => _pending != null;
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
    if (_disposed || saving || pending || loading) return;
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
    _pending = Map<String, dynamic>.from(command.toJson() as Map);
    await retry();
  }

  /// A command this build cannot speak is dropped, never retried for ever.
  ///
  /// Read state is disposable: the cloud is authoritative and the next glance
  /// at the conversation marks it again. A command left behind by an older
  /// build — one naming a cursor this build no longer accepts — would fail to
  /// decode on every attempt, and `pending` gates marking, manual unread and
  /// acknowledgement alike, so keeping it would disable all three on that
  /// install until its data was cleared.
  Future<void> _discardPending() async {
    _pending = null;
    try {
      await store.delete(_key);
    } catch (_) {
      /* The next write replaces it; nothing here is authoritative. */
    }
  }

  Future<void> _restore(String saved) async {
    try {
      final command = wire.MarkReadCommand.fromJson(
        Map<String, dynamic>.from(jsonDecode(saved) as Map),
      );
      _pending = Map<String, dynamic>.from(command.toJson() as Map);
    } catch (_) {
      await _discardPending();
    }
  }

  Future<void> retry() async {
    if (_disposed || saving || _pending == null) return;
    final Map<String, dynamic> body;
    try {
      body = Map<String, dynamic>.from(
        wire.MarkReadCommand.fromJson(_pending).toJson() as Map,
      );
    } catch (_) {
      await _discardPending();
      error = 'Couldn’t confirm the read status. Check it before making another change.';
      _notify();
      return;
    }
    saving = true;
    _notify();
    try {
      await store.write(_key, jsonEncode(body));
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
      await store.delete(_key);
      _pending = null;
      unread[receipt.unread.botId.value] = receipt.unread;
      error = null;
    } catch (_) {
      error = 'Couldn’t confirm the read status. Check it before making another change.';
    } finally {
      saving = false;
      _notify();
    }
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
