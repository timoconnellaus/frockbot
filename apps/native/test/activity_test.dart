import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/activity/controller.dart';
import 'package:frockbot_native/protocol/client_wire.generated.dart' as wire;
import 'package:frockbot_native/shell/focus.dart' show sidebarUnreadFor;

import 'settings_test.dart' show SettingsApi;
import 'widget_test.dart' show MemoryStore;

void main() {
  test('read and manual unread commands carry the authoritative message boundaries', () async {
    final store = MemoryStore();
    final commands = <Map<String, dynamic>>[];
    final api = SettingsApi(store, (path, body) async {
      final command = Map<String, dynamic>.from(body as Map);
      commands.add(command);
      return {
        'schemaVersion': 1,
        'commandId': command['commandId'],
        'status': 'applied',
        'unread': {
          'schemaVersion': 1,
          'botId': 'alpha',
          'count': command['type'] == 'bot/mark-read' ? 0 : 1,
          'capped': false,
          'unread': command['type'] != 'bot/mark-read',
          'manuallyUnread': command['type'] == 'bot/mark-unread',
          'lastActivityCursor': 'message-00000000000000000002',
          'lastActivityAt': '2026-09-05T10:00:00.000Z',
        },
      };
    });
    final controller = ActivityController(api, store, 'tim');
    controller.unread['alpha'] = wire.UnreadView.fromJson({
      'schemaVersion': 1,
      'botId': 'alpha',
      'count': 2,
      'capped': false,
      'unread': true,
      'manuallyUnread': false,
      'lastActivityCursor': 'message-00000000000000000002',
      'lastActivityAt': '2026-09-05T10:00:00.000Z',
    });

    await controller.mark('alpha', read: true);
    await controller.mark('alpha', read: false, fromMessageId: 'run-1:send:0');

    expect(commands[0]['upToCursor'], 'message-00000000000000000002');
    expect(commands[0].containsKey('fromMessageId'), isFalse);
    expect(commands[1]['fromMessageId'], 'run-1:send:0');
    expect(commands[1].containsKey('upToCursor'), isFalse);
    controller.dispose();
    api.close();
  });

  test('a pending command this build cannot speak is dropped, not retried for ever', () async {
    // What an install upgraded across the message-cursor change holds: a
    // read command written offline by the old build, naming a run cursor.
    final store = MemoryStore();
    store.values['activity-pending.tim'] = jsonEncode({
      'alpha': {
        'schemaVersion': 1,
        'type': 'bot/mark-read',
        'commandId': 'command-old',
        'botId': 'alpha',
        'upToCursor': 'run-index:2026-09-05T00:00:00.000Z:run-1',
      },
    });
    final commands = <Map<String, dynamic>>[];
    final api = SettingsApi(store, (path, body) async {
      if (body == null) {
        return path.endsWith('unread')
            ? {
                'schemaVersion': 1,
                'unread': [
                  {
                    'schemaVersion': 1,
                    'botId': 'alpha',
                    'count': 1,
                    'capped': false,
                    'unread': true,
                    'manuallyUnread': false,
                    'lastActivityCursor': 'message-00000000000000000002',
                    'lastActivityAt': '2026-09-05T10:00:00.000Z',
                  },
                ],
              }
            : {'schemaVersion': 1, 'notifications': []};
      }
      final command = Map<String, dynamic>.from(body as Map);
      commands.add(command);
      return {
        'schemaVersion': 1,
        'commandId': command['commandId'],
        'status': 'applied',
        'unread': {
          'schemaVersion': 1,
          'botId': 'alpha',
          'count': 0,
          'capped': false,
          'unread': false,
          'manuallyUnread': false,
        },
      };
    });
    final controller = ActivityController(api, store, 'tim');

    await controller.load();

    expect(controller.pending, isFalse);
    expect(store.values.containsKey('activity-pending.tim'), isFalse);

    // Reading still works on this install: the stale command gated marking,
    // manual unread and acknowledgement alike while it was held.
    await controller.mark('alpha', read: true);
    expect(commands.single['upToCursor'], 'message-00000000000000000002');
    expect(controller.unread['alpha']!.unread, isFalse);
    controller.dispose();
    api.close();
  });

  test(
    'a lost read receipt retries the persisted command after client restart',
    () async {
      final store = MemoryStore();
      final writes = <Map>[];
      var lost = true;
      final api = SettingsApi(store, (path, body) async {
        if (body == null) {
          return path.endsWith('unread')
              ? {'schemaVersion': 1, 'unread': []}
              : {'schemaVersion': 1, 'notifications': []};
        }
        final command = body as Map;
        expect(
          jsonDecode(store.values['activity-pending.tim']!)['alpha'],
          command,
        );
        writes.add(command);
        if (lost) {
          lost = false;
          throw StateError('lost receipt');
        }
        return {
          'schemaVersion': 1,
          'commandId': command['commandId'],
          'status': 'applied',
          'unread': {
            'schemaVersion': 1,
            'botId': 'alpha',
            'count': 0,
            'capped': false,
            'unread': true,
            'manuallyUnread': true,
          },
        };
      });
      final first = ActivityController(api, store, 'tim');
      await first.mark('alpha', read: false);
      expect(first.pending, isTrue);
      first.dispose();
      final second = ActivityController(api, store, 'tim');
      await second.load();
      expect(second.pending, isTrue);
      await second.retry();
      expect(writes[0], writes[1]);
      expect(second.pending, isFalse);
      expect(second.unread['alpha']!.manuallyUnread, isTrue);
      second.dispose();
      api.close();
    },
  );
  group('the badge answers the tap, not the round trip', () {
    Map<String, Object?> view(String botId, {required int count}) => {
      'schemaVersion': 1,
      'botId': botId,
      'count': count,
      'capped': false,
      'unread': count > 0,
      'manuallyUnread': false,
      'lastActivityCursor': 'message-00000000000000000002',
      'lastActivityAt': '2026-09-05T10:00:00.000Z',
    };

    test('the badge is empty before the receipt lands', () async {
      final store = MemoryStore();
      final receipts = Completer<void>();
      final api = SettingsApi(store, (path, body) async {
        final command = Map<String, dynamic>.from(body as Map);
        await receipts.future;
        return {
          'schemaVersion': 1,
          'commandId': command['commandId'],
          'status': 'applied',
          'unread': view('alpha', count: 0),
        };
      });
      final controller = ActivityController(api, store, 'tim');
      controller.unread['alpha'] = wire.UnreadView.fromJson(
        view('alpha', count: 2),
      );

      final marking = controller.mark('alpha', read: true);
      expect(controller.unread['alpha']!.count, 0);
      expect(controller.unread['alpha']!.unread, isFalse);
      expect(sidebarUnreadFor(controller.unread['alpha'], focused: false).label, isNull);

      receipts.complete();
      await marking;
      expect(controller.unread['alpha']!.count, 0);
      expect(controller.error, isNull);
      controller.dispose();
      api.close();
    });

    test('marking unread lights the badge on the tap', () async {
      final store = MemoryStore();
      final receipts = Completer<void>();
      final api = SettingsApi(store, (path, body) async {
        await receipts.future;
        throw StateError('never answered');
      });
      final controller = ActivityController(api, store, 'tim');
      controller.unread['alpha'] = wire.UnreadView.fromJson(
        view('alpha', count: 0),
      );

      final marking = controller.mark(
        'alpha',
        read: false,
        fromMessageId: 'run-1:send:0',
      );
      expect(controller.unread['alpha']!.manuallyUnread, isTrue);
      expect(sidebarUnreadFor(controller.unread['alpha'], focused: false).label, '•');

      receipts.complete();
      await marking;
      controller.dispose();
      api.close();
    });

    test('a refusal puts the badge back and says so', () async {
      final store = MemoryStore();
      final api = SettingsApi(store, (path, body) async {
        throw const FormatException('synthetic backend detail');
      });
      final controller = ActivityController(api, store, 'tim');
      controller.unread['alpha'] = wire.UnreadView.fromJson(
        view('alpha', count: 2),
      );

      await controller.mark('alpha', read: true);
      expect(controller.unread['alpha']!.count, 2);
      expect(controller.unread['alpha']!.unread, isTrue);
      expect(sidebarUnreadFor(controller.unread['alpha'], focused: false).label, '2');
      // What the shell puts in its SnackBar when the mark comes back refused.
      expect(controller.error, isNotNull);
      controller.dispose();
      api.close();
    });

    test('one Bot in flight leaves every other Bot alone', () async {
      final store = MemoryStore();
      final held = Completer<void>();
      final api = SettingsApi(store, (path, body) async {
        final command = Map<String, dynamic>.from(body as Map);
        if (command['botId'] == 'alpha') await held.future;
        return {
          'schemaVersion': 1,
          'commandId': command['commandId'],
          'status': 'applied',
          'unread': view(command['botId'] as String, count: 0),
        };
      });
      final controller = ActivityController(api, store, 'tim');
      controller.unread['alpha'] = wire.UnreadView.fromJson(
        view('alpha', count: 2),
      );
      controller.unread['beta'] = wire.UnreadView.fromJson(
        view('beta', count: 3),
      );

      final marking = controller.mark('alpha', read: true);
      expect(controller.busy('alpha'), isTrue);
      // The other Bot's unread controls are enabled on this, and a single
      // flag used to disable every one of them for the whole round trip.
      expect(controller.busy('beta'), isFalse);

      await controller.mark('beta', read: true);
      expect(controller.unread['beta']!.unread, isFalse);
      expect(controller.busy('beta'), isFalse);
      expect(controller.busy('alpha'), isTrue);

      held.complete();
      await marking;
      expect(controller.pending, isFalse);
      controller.dispose();
      api.close();
    });
  });

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
}
