import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/recovery/page.dart';
import 'package:frockbot_native/theme/frock_theme.dart';
import 'package:frockbot_native/protocol/client_wire.generated.dart' as wire;

import 'bot_switch_test.dart' show registration;

import 'package:frockbot_native/recovery/controller.dart';

import 'settings_test.dart' show SettingsApi;
import 'widget_test.dart' show MemoryStore;

Map<String, dynamic> setup() => {
  'schemaVersion': 1,
  'botId': 'alpha',
  'currentGenerationId': 'generation-1',
  'generations': [
    {
      'schemaVersion': 1,
      'botId': 'alpha',
      'generationId': 'generation-1',
      'createdAt': '2026-09-05T10:00:00.000Z',
      'status': 'active',
      'origin': {'kind': 'bootstrap'},
      'isCurrent': true,
      'members': [],
      'failures': [],
    },
  ],
};
void main() {
  test('an unavailable audit region does not hide setup history or repeat a command', () async {
    final api = SettingsApi(MemoryStore(), (path, body) async {
      if (path.startsWith('/api/audit')) throw StateError('private details');
      return setup();
    });
    final controller = BotRecoveryController(api, api.store, 'tim');
    await controller.loadDetails('alpha');
    expect(controller.history!['currentGenerationId'], 'generation-1');
    expect(controller.detailError, isNot(contains('private')));
    controller.dispose();
    api.close();
  });
  for (final brightness in Brightness.values) {
    testWidgets(
      'delete requires explicit confirmation and recovery stays usable at large text in $brightness',
      (tester) async {
        final store = MemoryStore();
        final writes = <Map>[];
        final api = SettingsApi(store, (path, body) async {
          if (body != null) {
            writes.add(body as Map);
            return {
              'schemaVersion': 1,
              'commandId': body['commandId'],
              'botId': 'alpha',
              'status': 'pending',
              'lifecycle': {
                'schemaVersion': 1,
                'botId': 'alpha',
                'status': 'active',
                'revision': 1,
              },
            };
          }
          if (path.startsWith('/api/audit')) {
            return {
              'schemaVersion': 1,
              'entries': [],
              'page': {'truncated': false},
              'total': 0,
              'indexState': 'ready',
            };
          }
          return setup();
        });
        final controller = BotRecoveryController(api, store, 'tim');
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
            home: BotRecoveryDetail(
              controller: controller,
              bot: wire.BotRegistration.fromJson(registration('alpha', 'Mira')),
            ),
          ),
        );
        await tester.pumpAndSettle();
        final button = find.widgetWithText(OutlinedButton, 'Delete Bot');
        await tester.scrollUntilVisible(
          button,
          300,
          scrollable: find
              .descendant(
                of: find.byType(ListView).first,
                matching: find.byType(Scrollable),
              )
              .first,
        );
        await tester.pumpAndSettle();
        await tester.tap(button);
        await tester.pumpAndSettle();
        expect(find.byType(AlertDialog), findsOneWidget);
        expect(writes, isEmpty);
        await tester.tap(find.text('Cancel'));
        await tester.pumpAndSettle();
        expect(writes, isEmpty);
        await tester.tap(button);
        await tester.pumpAndSettle();
        await tester.tap(find.widgetWithText(FilledButton, 'Delete Bot'));
        await tester.pumpAndSettle();
        expect(writes, hasLength(1));
        expect(controller.pending, isTrue);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        controller.dispose();
        api.close();
      },
    );
  }

  test('archive intent survives a lost reply and restore uses a new explicit command', () async {
    final store = MemoryStore();
    final calls = <Map>[];
    var lost = true;
    final api = SettingsApi(store, (path, body) async {
      if (body == null) {
        return path.endsWith('lifecycles')
            ? {'schemaVersion': 1, 'lifecycles': []}
            : {'schemaVersion': 1, 'revision': 0, 'bots': []};
      }
      final command = body as Map;
      expect(jsonDecode(store.values['bot-recovery.tim']!), command);
      calls.add(command);
      if (lost) {
        lost = false;
        throw StateError('transport detail');
      }
      return {
        'schemaVersion': 1,
        'commandId': command['commandId'],
        'botId': 'alpha',
        'status': 'applied',
        'lifecycle': {
          'schemaVersion': 1,
          'botId': 'alpha',
          'status': command['type'] == 'bot/archive' ? 'archived' : 'active',
          'revision': 1,
        },
      };
    });
    final first = BotRecoveryController(api, store, 'tim');
    await first.change('alpha', 'bot/archive');
    expect(first.pending, isTrue);
    first.dispose();
    final next = BotRecoveryController(api, store, 'tim');
    await next.load();
    await next.retry();
    expect(calls[0], calls[1]);
    expect(next.pending, isFalse);
    await next.change('alpha', 'bot/restore');
    expect(calls.last['commandId'], isNot(calls[0]['commandId']));
    next.dispose();
    api.close();
  });
}
