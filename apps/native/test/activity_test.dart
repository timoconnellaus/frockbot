import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/activity/controller.dart';
import 'settings_test.dart' show SettingsApi;
import 'widget_test.dart' show MemoryStore;

void main() {
  test('only exact hosted Bot links become navigation intent', () {
    expect(botLink(Uri.parse('https://bot.frockbot.com/?bot=alpha')), 'alpha');
    for (final url in [
      'https://evil.test/?bot=alpha',
      'https://bot.frockbot.com/?bot=alpha&bot=beta',
      'https://name@bot.frockbot.com/?bot=alpha',
      'https://bot.frockbot.com/native/settings?bot=alpha',
      'https://bot.frockbot.com/?bot=../alpha',
      'https://bot.frockbot.com/?bot=alpha#other',
    ]) {
      expect(botLink(Uri.parse(url)), isNull, reason: url);
    }
  });
  test('refresh deduplicates notices without acknowledging or marking read', () async {
    final store = MemoryStore();
    final notification = {
      'schemaVersion': 1, 'botId': 'alpha', 'notificationId': 'notice-1',
      'runId': 'run-1', 'createdAt': '2026-09-05T10:00:00.000Z',
      'title': 'Alpha replied', 'body': 'Ready',
    };
    var pending = true;
    var lost = true;
    final writes = <Object?>[];
    final api = SettingsApi(store, (path, body) async {
      if (body != null) {
        writes.add(body);
        pending = false;
        if (lost) { lost = false; throw StateError('private transport detail'); }
        return {'schemaVersion': 1, 'status': 'acknowledged'};
      }
      if (path == '/api/bots/unread') return {'schemaVersion': 1, 'unread': []};
      return {'schemaVersion': 1, 'notifications': pending ? [notification, notification] : []};
    });
    final controller = ActivityController(api, store, 'tim');
    await controller.load();
    expect(controller.notices, hasLength(1));
    await controller.load();
    expect(writes, isEmpty);
    await controller.acknowledge(controller.notices.single);
    expect(controller.error, isNot(contains('private')));
    await controller.load();
    expect(controller.notices, isEmpty);
    expect(writes, hasLength(1));
    controller.dispose(); api.close();
  });
}
