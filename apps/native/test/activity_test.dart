import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/activity/page.dart';
import 'package:frockbot_native/theme/frock_theme.dart';
import 'package:frockbot_native/activity/controller.dart';
import 'package:frockbot_native/protocol/client_wire.generated.dart' as wire;

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
      'schemaVersion': 1,
      'type': 'bot/mark-read',
      'commandId': 'command-old',
      'botId': 'alpha',
      'upToCursor': 'run-index:2026-09-05T00:00:00.000Z:run-1',
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
        expect(jsonDecode(store.values['activity-pending.tim']!), command);
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
  for (final brightness in Brightness.values) {
    testWidgets(
      'inbox empty, offline and failed notice at large text in $brightness',
      (tester) async {
        final store = MemoryStore();
        var mode = 'empty';
        final api = SettingsApi(store, (path, body) async {
          if (mode == 'offline') throw StateError('private detail');
          if (path.endsWith('unread')) {
            return {'schemaVersion': 1, 'unread': []};
          }
          return {
            'schemaVersion': 1,
            'notifications': mode == 'empty'
                ? []
                : [
                    {
                      'schemaVersion': 1,
                      'botId': 'alpha',
                      'notificationId': 'notice-1',
                      'runId': 'run-1',
                      'createdAt': '2026-09-05T10:00:00.000Z',
                      'title': 'Alpha couldn’t finish',
                      'body': 'Please try again when your connection is back.',
                    },
                  ],
          };
        });
        final controller = ActivityController(api, store, 'tim');
        await tester.pumpWidget(
          MaterialApp(
            theme: FrockTheme.theme(brightness),
            builder: (context, child) => MediaQuery(
              data: MediaQuery.of(context).copyWith(
                textScaler: const TextScaler.linear(2),
                disableAnimations: true,
              ),
              child: child!,
            ),
            home: ActivityPage(controller: controller, openBot: (_) async {}),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text('You’re all caught up'), findsOneWidget);
        mode = 'offline';
        await controller.load();
        await tester.pumpAndSettle();
        expect(find.textContaining('private detail'), findsNothing);
        expect(find.textContaining('Couldn’t reach FrockBot'), findsOneWidget);
        mode = 'failed';
        await controller.load();
        await tester.pumpAndSettle();
        expect(find.text('Alpha couldn’t finish'), findsOneWidget);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        controller.dispose();
        api.close();
      },
    );
  }

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
  test(
    'refresh deduplicates notices without acknowledging or marking read',
    () async {
      final store = MemoryStore();
      final notification = {
        'schemaVersion': 1,
        'botId': 'alpha',
        'notificationId': 'notice-1',
        'runId': 'run-1',
        'createdAt': '2026-09-05T10:00:00.000Z',
        'title': 'Alpha replied',
        'body': 'Ready',
      };
      var pending = true;
      var lost = true;
      final writes = <Object?>[];
      final api = SettingsApi(store, (path, body) async {
        if (body != null) {
          writes.add(body);
          pending = false;
          if (lost) {
            lost = false;
            throw StateError('private transport detail');
          }
          return {'schemaVersion': 1, 'status': 'acknowledged'};
        }
        if (path == '/api/bots/unread') {
          return {'schemaVersion': 1, 'unread': []};
        }
        return {
          'schemaVersion': 1,
          'notifications': pending ? [notification, notification] : [],
        };
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
      controller.dispose();
      api.close();
    },
  );
}
