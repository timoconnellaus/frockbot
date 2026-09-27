/// One field of a Bot's settings, written from the list.
///
/// The Bot settings page holds a whole profile and saves whatever changed; a
/// quick action holds nothing and changes one thing. So this reads the
/// revision the command must fence on, sends the one field as a patch, and
/// re-fences once on a conflict — the same commands the page sends, with
/// nothing predicted here: the caller draws the change and takes it back if
/// the answer is a refusal.
library;

import '../client/transport.dart';

class BotQuickWrites {
  final NativeApi api;
  const BotQuickWrites(this.api);

  /// Writes [patch] — any of `label`, `pinnedAt`, `hiddenFromSidebar` — to
  /// the Bot's profile. Returns null when the authority accepted it, and
  /// otherwise what it said.
  Future<String?> setProfile(String botId, Map<String, Object?> patch) =>
      _command(botId, {'type': 'bot/set-profile', 'profile': patch});

  Future<String?> setNotifications(String botId, {required bool enabled}) =>
      _command(botId, {
        'type': 'bot/update-notifications',
        'notifications': {'enabled': enabled},
      });

  Future<String?> _command(String botId, Map<String, Object?> command) async {
    final full = {
      'schemaVersion': 1,
      'commandId': randomId(),
      'botId': botId,
      ...command,
    };
    try {
      try {
        return _settle(await _send(botId, full, await _revision(botId)));
      } on RequestFailure catch (failure) {
        if (failure.status != 409) rethrow;
        return _settle(await _send(botId, full, await _revision(botId)));
      }
    } on RequestFailure catch (failure) {
      return failure.message;
    } catch (_) {
      return 'Couldn’t change this Bot. Try again.';
    }
  }

  Future<int> _revision(String botId) async {
    final answer = (await api.request('/api/bots/$botId/settings'))! as Map;
    return answer['revision']! as int;
  }

  Future<Map<String, Object?>> _send(
    String botId,
    Map<String, Object?> command,
    int revision,
  ) async {
    final answer = await api.request(
      '/api/bots/$botId/settings',
      body: {...command, 'expectedRevision': revision},
    );
    return (answer! as Map).cast<String, Object?>();
  }

  String? _settle(Map<String, Object?> receipt) {
    if (receipt['status'] != 'rejected') return null;
    final failure = receipt['failure'];
    return failure is String ? failure : 'Couldn’t change this Bot. Try again.';
  }
}
