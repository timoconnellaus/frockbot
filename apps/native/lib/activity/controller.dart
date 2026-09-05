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
  Map<String, String> botNames = {};
  String botName(String id) => botNames[id] ?? 'Your Bot';
  List<Map<String, dynamic>> notices = [];
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
      if (saved != null)
        _pending = Map<String, dynamic>.from(jsonDecode(saved) as Map);
      final views = wire.UnreadDirectory.fromJson(
        await api.request('/api/bots/unread'),
      );
      final directory =
          wire.NotificationDirectory.fromJson(
                await api.request('/api/bots/notifications'),
              ).toJson()
              as Map;
      final unique = <String, Map<String, dynamic>>{};
      for (final item in directory['notifications'] as List) {
        final notice = Map<String, dynamic>.from(item as Map);
        unique['${notice['botId']}:${notice['notificationId']}'] = notice;
      }
      if (_disposed) return;
      unread = {for (final view in views.unread) view.botId.value: view};
      notices = unique.values.toList()
        ..sort(
          (a, b) =>
              (b['createdAt'] as String).compareTo(a['createdAt'] as String),
        );
      loaded = true;
      error = null;
    } catch (_) {
      if (!_disposed)
        error = 'Couldn’t reach FrockBot. Check your connection and try again.';
    } finally {
      loading = false;
      _notify();
    }
  }

  Future<void> acknowledge(Map<String, dynamic> notice) async {
    if (_disposed || saving || pending) return;
    saving = true;
    _notify();
    try {
      final command = wire.NotificationAck.fromJson({
        'schemaVersion': 1,
        'action': 'acknowledge',
        'notificationId': notice['notificationId'],
      });
      wire.BotId.fromJson(notice['botId']);
      wire.Acknowledgement.fromJson(
        await api.request(
          '/api/bots/${Uri.encodeComponent(notice['botId'] as String)}/notifications',
          body: command.toJson(),
        ),
      );
      notices.removeWhere(
        (n) =>
            n['botId'] == notice['botId'] &&
            n['notificationId'] == notice['notificationId'],
      );
      error = null;
    } catch (_) {
      error = 'Couldn’t confirm that update. Refresh to check its status.';
    } finally {
      saving = false;
      _notify();
    }
  }

  Future<void> mark(String botId, {required bool read}) async {
    if (_disposed || saving || pending || loading) return;
    final cursor = unread[botId]?.lastActivityCursor?.value;
    if (read && cursor == null) return;
    final command = wire.MarkReadCommand.fromJson({
      'schemaVersion': 1,
      'type': read ? 'bot/mark-read' : 'bot/mark-unread',
      'commandId': randomId(),
      'botId': botId,
      if (read) 'upToCursor': cursor,
    });
    _pending = Map<String, dynamic>.from(command.toJson() as Map);
    await retry();
  }

  Future<void> retry() async {
    if (_disposed || saving || _pending == null) return;
    saving = true;
    _notify();
    try {
      final command = wire.MarkReadCommand.fromJson(_pending);
      final body = Map<String, dynamic>.from(command.toJson() as Map);
      await store.write(_key, jsonEncode(body));
      if (_disposed) return;
      final receipt = wire.MarkReadReceipt.fromJson(
        await api.request(
          '/api/bots/${Uri.encodeComponent(body['botId'] as String)}/unread',
          body: body,
        ),
      );
      if (receipt.commandId.value != body['commandId'] ||
          receipt.unread.botId.value != body['botId'])
        throw const FormatException('Mismatched unread receipt');
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
