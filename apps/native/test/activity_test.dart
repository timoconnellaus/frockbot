import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/activity/page.dart';
import 'package:frockbot_native/theme/frock_theme.dart';
import 'package:frockbot_native/activity/controller.dart';

import 'settings_test.dart' show SettingsApi;
import 'widget_test.dart' show MemoryStore;

void main() {
  test(
    'a lost read receipt retries the persisted command after client restart',
    () async {
      final store = MemoryStore();
      final writes = <Map>[];
      var lost = true;
      final api = SettingsApi(store, (path, body) async {
        if (body == null)
          return path.endsWith('unread')
              ? {'schemaVersion': 1, 'unread': []}
              : {'schemaVersion': 1, 'notifications': []};
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
          if (path.endsWith('unread'))
            return {'schemaVersion': 1, 'unread': []};
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
        if (path == '/api/bots/unread')
          return {'schemaVersion': 1, 'unread': []};
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
