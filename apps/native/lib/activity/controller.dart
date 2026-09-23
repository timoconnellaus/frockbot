import 'dart:async';

import 'package:flutter/foundation.dart';

import '../client/transport.dart';
import '../protocol/client_wire.generated.dart' as wire;

/// Navigation only; authority comes from membership in the live directory.
/// A Group Chat's link answers with its sidebar entry id, `group:<id>`.
String? botLink(Uri uri) {
  if (uri.scheme != 'https' ||
      uri.origin != hostedOrigin ||
      uri.userInfo.isNotEmpty ||
      uri.hasFragment ||
      (uri.path != '/' && uri.path.isNotEmpty)) {
    return null;
  }
  final bots = uri.queryParametersAll['bot'];
  final groups = uri.queryParametersAll['group'];
  try {
    if (bots?.length == 1 && groups == null) {
      return wire.BotId.fromJson(bots!.single).value;
    }
    if (groups?.length == 1 && bots == null) {
      return 'group:${wire.GroupId.fromJson(groups!.single).value}';
    }
  } catch (_) {
    // Not an id this build accepts: not a link it follows.
  }
  return null;
}

class ActivityController extends ChangeNotifier {
  final NativeApi api;
  ActivityController(this.api);
  Map<String, wire.UnreadView> unread = {};
  String? error;
  bool loading = false;
  bool loaded = false;
  bool _disposed = false;
  bool _reloadRequested = false;

  /// The Bots whose command is in flight, and the Bots whose last command was
  /// refused since the directory was last read. Keyed by Bot because the
  /// controls are a Bot's: a single flag disabled every Bot's unread menu
  /// while any one of them was marked.
  ///
  /// A refused command is not kept to be sent again. Read state is disposable
  /// and a later glance names a newer cursor, so the one thing a refusal owes
  /// is a pause: the open chat asks to be marked on every frame, and without
  /// one a Bot the cloud keeps refusing would be asked again as fast as the
  /// refusals came back. The next directory read ends the pause whether or not
  /// it succeeds, so a directory that keeps failing cannot leave a Bot's
  /// controls disabled for the session.
  final Set<String> _sending = {};
  final Set<String> _refused = {};

  /// What the badge said before a prediction was drawn over it, so a refused
  /// command puts back what the cloud last reported. A Bot the directory did
  /// not mention is held as a null.
  final Map<String, wire.UnreadView?> _predicted = {};
  bool get saving => _sending.isNotEmpty;

  /// Whether this Bot's unread controls are waiting on a command of their own,
  /// or on the directory read that follows one the cloud refused.
  bool busy(String botId) =>
      _sending.contains(botId) || _refused.contains(botId);
  void _notify() {
    if (!_disposed) notifyListeners();
  }

  Future<void> load() async {
    if (_disposed) return;
    // The directory replaces every view wholesale, so it waits for any mark in
    // flight rather than landing over its prediction, and a read asked for
    // meanwhile runs as soon as the marks settle: the shell asks only once for
    // the view that catches up to the open chat.
    if (loading || saving) {
      _reloadRequested = true;
      return;
    }
    do {
      _reloadRequested = false;
      loading = true;
      _notify();
      try {
        final views = wire.UnreadDirectory.fromJson(
          await api.request('/api/bots/unread'),
        );
        if (_disposed) return;
        unread = {for (final view in views.unread) view.botId.value: view};
        loaded = true;
        error = null;
      } catch (_) {
        if (!_disposed) {
          error =
              'Couldn’t reach FrockBot. Check your connection and try again.';
        }
      } finally {
        _refused.clear();
        loading = false;
        _notify();
      }
    } while (_reloadRequested && !_disposed && !saving);
  }

  Future<void> mark(
    String botId, {
    required bool read,
    String? fromMessageId,
  }) async {
    if (_disposed || busy(botId) || loading) return;
    final cursor = unread[botId]?.lastActivityCursor?.value;
    if (read && cursor == null) return;
    final commandId = randomId();
    final command = wire.MarkReadCommand.fromJson({
      'schemaVersion': 1,
      'type': read ? 'bot/mark-read' : 'bot/mark-unread',
      'commandId': commandId,
      'botId': botId,
      if (read) 'upToCursor': cursor,
      if (!read && fromMessageId != null) 'fromMessageId': fromMessageId,
    });
    _sending.add(botId);
    _predict(botId, read: read, fromMessageId: fromMessageId);
    try {
      final receipt = wire.MarkReadReceipt.fromJson(
        await api.request(
          '/api/bots/${Uri.encodeComponent(botId)}/unread',
          body: command.toJson(),
        ),
      );
      if (receipt.commandId.value != commandId ||
          receipt.unread.botId.value != botId) {
        throw const FormatException('Mismatched unread receipt');
      }
      _predicted.remove(botId);
      unread[botId] = receipt.unread;
      error = null;
    } catch (_) {
      _rollback(botId);
      _refused.add(botId);
      error = _unconfirmed;
    } finally {
      _sending.remove(botId);
      _notify();
      if (_reloadRequested && !saving) unawaited(load());
    }
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
      // A Bot the directory has not described yet is drawn with the default
      // a Bot without settings has; its count is zero either way.
      'notificationsEnabled': true,
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

  /// Puts back what the cloud last said about this Bot: until the cloud has
  /// accepted a command, its own answer is the only honest thing to draw.
  void _rollback(String botId) {
    if (!_predicted.containsKey(botId)) return;
    final before = _predicted.remove(botId);
    if (before == null) {
      unread.remove(botId);
    } else {
      unread[botId] = before;
    }
  }

  static const _unconfirmed =
      'Couldn’t confirm the read status. Check it before making another change.';

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
