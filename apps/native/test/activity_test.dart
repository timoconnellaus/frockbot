import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/activity/controller.dart';
import 'package:frockbot_native/client/transport.dart' show hostedOrigin;
import 'package:frockbot_native/protocol/client_wire.generated.dart' as wire;
import 'package:frockbot_native/shell/focus.dart' show sidebarUnreadFor;

import 'native_session.dart' show NativeSessionApi;
import 'widget_test.dart' show MemoryStore;

void main() {
  test(
    'a refresh requested during a load runs again with the newer view',
    () async {
      final store = MemoryStore();
      final firstStarted = Completer<void>();
      final releaseFirst = Completer<void>();
      var calls = 0;
      final api = NativeSessionApi(store, (path, body) async {
        calls += 1;
        if (calls == 1) {
          firstStarted.complete();
          await releaseFirst.future;
        }
        return {
          'schemaVersion': 1,
          'unread': [
            {
              'schemaVersion': 1,
              'botId': 'alpha',
              'count': 2,
              'capped': false,
              'unread': true,
              'manuallyUnread': false,
              'notificationsEnabled': calls == 1,
            },
          ],
        };
      });
      final controller = ActivityController(api);

      final first = controller.load();
      await firstStarted.future;
      await controller.load();
      releaseFirst.complete();
      await first;

      expect(calls, 2);
      expect(controller.unread['alpha']!.notificationsEnabled, isFalse);
      controller.dispose();
      api.close();
    },
  );

  test('read and manual unread commands carry the authoritative message boundaries', () async {
    final store = MemoryStore();
    final commands = <Map<String, dynamic>>[];
    final api = NativeSessionApi(store, (path, body) async {
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
          'notificationsEnabled': true,
          'lastActivityCursor': 'message-00000000000000000002',
          'lastActivityAt': '2026-09-05T10:00:00.000Z',
        },
      };
    });
    final controller = ActivityController(api);
    controller.unread['alpha'] = wire.UnreadView.fromJson({
      'schemaVersion': 1,
      'botId': 'alpha',
      'count': 2,
      'capped': false,
      'unread': true,
      'manuallyUnread': false,
      'notificationsEnabled': true,
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

  test('a refused read holds that Bot until the next directory read, then marks again', () async {
    final store = MemoryStore();
    final commands = <Map<String, dynamic>>[];
    var reads = 0;
    final api = NativeSessionApi(store, (path, body) async {
      if (body == null) {
        reads += 1;
        return {
          'schemaVersion': 1,
          'unread': [
            {
              'schemaVersion': 1,
              'botId': 'alpha',
              'count': reads,
              'capped': false,
              'unread': true,
              'manuallyUnread': false,
              'notificationsEnabled': true,
              'lastActivityCursor': 'message-0000000000000000000$reads',
              'lastActivityAt': '2026-09-05T10:00:00.000Z',
            },
          ],
        };
      }
      final command = Map<String, dynamic>.from(body as Map);
      commands.add(command);
      if (commands.length == 1) throw StateError('lost receipt');
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
          'notificationsEnabled': true,
        },
      };
    });
    final controller = ActivityController(api);
    await controller.load();

    await controller.mark('alpha', read: true);
    expect(controller.unread['alpha']!.count, 1);
    expect(controller.error, isNotNull);
    expect(controller.busy('alpha'), isTrue);

    // The open chat asks again on the next frame; the refusal is not asked
    // again until the cloud has been heard from.
    await controller.mark('alpha', read: true);
    expect(commands, hasLength(1));

    // The Bot kept talking meanwhile. The poll ends the pause, and the next
    // glance names the newer cursor rather than the refused one.
    await controller.load();
    expect(controller.busy('alpha'), isFalse);
    await controller.mark('alpha', read: true);
    expect(commands, hasLength(2));
    expect(commands[1]['upToCursor'], 'message-00000000000000000002');
    expect(controller.unread['alpha']!.unread, isFalse);
    controller.dispose();
    api.close();
  });
  group('the badge answers the tap, not the round trip', () {
    Map<String, Object?> view(String botId, {required int count}) => {
      'schemaVersion': 1,
      'botId': botId,
      'count': count,
      'capped': false,
      'unread': count > 0,
      'manuallyUnread': false,
      'notificationsEnabled': true,
      'lastActivityCursor': 'message-00000000000000000002',
      'lastActivityAt': '2026-09-05T10:00:00.000Z',
    };

    test('the badge is empty before the receipt lands', () async {
      final store = MemoryStore();
      final receipts = Completer<void>();
      final api = NativeSessionApi(store, (path, body) async {
        final command = Map<String, dynamic>.from(body as Map);
        await receipts.future;
        return {
          'schemaVersion': 1,
          'commandId': command['commandId'],
          'status': 'applied',
          'unread': view('alpha', count: 0),
        };
      });
      final controller = ActivityController(api);
      controller.unread['alpha'] = wire.UnreadView.fromJson(
        view('alpha', count: 2),
      );

      final marking = controller.mark('alpha', read: true);
      expect(controller.unread['alpha']!.count, 0);
      expect(controller.unread['alpha']!.unread, isFalse);
      expect(
        sidebarUnreadFor(controller.unread['alpha'], focused: false).label,
        isNull,
      );

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
      final api = NativeSessionApi(store, (path, body) async {
        await receipts.future;
        throw StateError('never answered');
      });
      final controller = ActivityController(api);
      controller.unread['alpha'] = wire.UnreadView.fromJson(
        view('alpha', count: 0),
      );

      final marking = controller.mark(
        'alpha',
        read: false,
        fromMessageId: 'run-1:send:0',
      );
      expect(controller.unread['alpha']!.manuallyUnread, isTrue);
      expect(
        sidebarUnreadFor(controller.unread['alpha'], focused: false).label,
        '•',
      );

      receipts.complete();
      await marking;
      controller.dispose();
      api.close();
    });

    test('a refusal puts the badge back and says so', () async {
      final store = MemoryStore();
      final api = NativeSessionApi(store, (path, body) async {
        throw const FormatException('synthetic backend detail');
      });
      final controller = ActivityController(api);
      controller.unread['alpha'] = wire.UnreadView.fromJson(
        view('alpha', count: 2),
      );

      await controller.mark('alpha', read: true);
      expect(controller.unread['alpha']!.count, 2);
      expect(controller.unread['alpha']!.unread, isTrue);
      expect(
        sidebarUnreadFor(controller.unread['alpha'], focused: false).label,
        '2',
      );
      // What the shell puts in its SnackBar when the mark comes back refused.
      expect(controller.error, isNotNull);
      controller.dispose();
      api.close();
    });

    test('one Bot in flight leaves every other Bot alone', () async {
      final store = MemoryStore();
      final held = Completer<void>();
      final api = NativeSessionApi(store, (path, body) async {
        final command = Map<String, dynamic>.from(body as Map);
        if (command['botId'] == 'alpha') await held.future;
        return {
          'schemaVersion': 1,
          'commandId': command['commandId'],
          'status': 'applied',
          'unread': view(command['botId'] as String, count: 0),
        };
      });
      final controller = ActivityController(api);
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
      expect(controller.busy('alpha'), isFalse);
      controller.dispose();
      api.close();
    });
  });

  test('only exact links to this deployment become navigation intent', () {
    final hosted = Uri.parse(hostedOrigin);
    expect(botLink(hosted.replace(path: '/', query: 'bot=alpha')), 'alpha');
    for (final url in [
      Uri.parse('https://evil.test/?bot=alpha'),
      hosted.replace(path: '/', query: 'bot=alpha&bot=beta'),
      hosted.replace(path: '/', userInfo: 'name', query: 'bot=alpha'),
      hosted.replace(path: '/native/settings', query: 'bot=alpha'),
      hosted.replace(path: '/', query: 'bot=../alpha'),
      hosted.replace(path: '/', query: 'bot=alpha', fragment: 'other'),
    ]) {
      expect(botLink(url), isNull, reason: url.toString());
    }
  });
}
