import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/activity/badge.dart';
import 'package:frockbot_native/protocol/client_wire.generated.dart' as wire;

wire.UnreadView view(
  String botId, {
  int count = 0,
  bool capped = false,
  bool manual = false,
  bool notifications = true,
}) => wire.UnreadView.fromJson({
  'schemaVersion': 1,
  'botId': botId,
  'count': count,
  'capped': capped,
  'unread': count > 0 || manual,
  'manuallyUnread': manual,
  'notificationsEnabled': notifications,
});

Map<String, wire.UnreadView> directory(List<wire.UnreadView> views) => {
  for (final view in views) view.botId.value: view,
};

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('the application badge counts', () {
    test('unread messages across eligible Bots', () {
      final badge = appBadgeFor(
        unread: directory([view('alpha', count: 2), view('beta', count: 3)]),
        botIds: ['alpha', 'beta'],
        focusedBotId: null,
      );
      expect(badge.total, 5);
      expect(badge.label, '5');
    });

    test('nothing from a muted Bot, and says it is silenced', () {
      final badge = appBadgeFor(
        unread: directory([
          view('alpha', count: 2),
          view('muted', count: 7, notifications: false),
        ]),
        botIds: ['alpha', 'muted'],
        focusedBotId: null,
      );
      expect(badge.label, '2');
      expect(badge.bots.keys, ['alpha']);
      expect(badge.silenced, {'muted'});
    });

    test('nothing from an archived Bot, or one outside the directory', () {
      final badge = appBadgeFor(
        unread: directory([
          view('alpha', count: 1),
          view('old', count: 4),
          view('stranger', count: 9),
        ]),
        botIds: ['alpha'],
        archived: {'old'},
        focusedBotId: null,
      );
      expect(badge.label, '1');
      expect(badge.silenced, {'old'});
      expect(badge.bots.containsKey('stranger'), isFalse);
    });

    test('nothing for a manual mark with no messages', () {
      final badge = appBadgeFor(
        unread: directory([view('alpha', manual: true)]),
        botIds: ['alpha'],
        focusedBotId: null,
      );
      expect(badge.total, 0);
      expect(badge.label, isNull);
    });

    test(
      'nothing for the focused chat while its read receipt is in flight',
      () {
        final badge = appBadgeFor(
          unread: directory([
            view('alpha', count: 3, capped: true),
            view('beta', count: 1),
          ]),
          botIds: ['alpha', 'beta'],
          focusedBotId: 'alpha',
        );
        expect(badge.label, '1');
        expect(badge.bots['alpha']?.launcherCount, 0);
      },
    );

    test('saturates at 99+ over the sum and over any capped Bot', () {
      expect(
        appBadgeFor(
          unread: directory([
            view('alpha', count: 60),
            view('beta', count: 40),
          ]),
          botIds: ['alpha', 'beta'],
          focusedBotId: null,
        ).label,
        '99+',
      );
      expect(
        appBadgeFor(
          unread: directory([view('alpha', count: 99)]),
          botIds: ['alpha'],
          focusedBotId: null,
        ).label,
        '99',
      );
      final capped = appBadgeFor(
        unread: directory([view('alpha', count: 99, capped: true)]),
        botIds: ['alpha'],
        focusedBotId: null,
      );
      expect(capped.label, '99+');
      expect(capped.bots['alpha']?.launcherCount, 100);
    });
  });

  group('the platform adapters', () {
    tearDown(() {
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(
        const MethodChannel('com.frockbot/badge'),
        null,
      );
      messenger.setMockMethodCallHandler(
        const MethodChannel('frockbot/push'),
        null,
      );
    });

    List<MethodCall> record(String name) {
      final calls = <MethodCall>[];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(MethodChannel(name), (call) async {
            calls.add(call);
            return null;
          });
      return calls;
    }

    test('the dock draws the label, sends a change once, and clears', () async {
      final calls = record('com.frockbot/badge');
      final sync = AppBadgeSync(const DockBadgePresenter());
      final two = appBadgeFor(
        unread: directory([view('alpha', count: 2)]),
        botIds: ['alpha'],
        focusedBotId: null,
      );
      sync.update(two);
      sync.update(
        appBadgeFor(
          unread: directory([view('alpha', count: 2)]),
          botIds: ['alpha'],
          focusedBotId: null,
        ),
      );
      sync.update(AppBadge.empty);
      await sync.clear();
      sync.update(two);
      await sync.clear();
      expect(calls.map((call) => call.method), ['set', 'set', 'set']);
      expect(calls.map((call) => (call.arguments as Map)['label']), [
        '2',
        null,
        null,
      ]);
    });

    test(
      'a replaced shell does not clear the badge its successor drew',
      () async {
        final calls = record('com.frockbot/badge');
        final previous = AppBadgeSync(const DockBadgePresenter());
        final next = AppBadgeSync(const DockBadgePresenter());
        previous.update(
          appBadgeFor(
            unread: directory([view('alpha', count: 1)]),
            botIds: ['alpha'],
            focusedBotId: null,
          ),
        );
        next.update(
          appBadgeFor(
            unread: directory([view('beta', count: 4)]),
            botIds: ['beta'],
            focusedBotId: null,
          ),
        );
        await previous.clear();
        await next.clear();
        expect(calls.map((call) => (call.arguments as Map)['label']), [
          '1',
          '4',
          null,
        ]);
      },
    );

    test(
      'the launcher hears per-Bot counts and silenced Bots once push is ready',
      () async {
        final calls = record('frockbot/push');
        var ready = false;
        final sync = AppBadgeSync(LauncherBadgePresenter(ready: () => ready));
        final badge = appBadgeFor(
          unread: directory([
            view('alpha', count: 99, capped: true),
            view('beta'),
            view('muted', count: 3, notifications: false),
          ]),
          botIds: ['alpha', 'beta', 'muted'],
          focusedBotId: null,
        );
        sync.update(badge);
        await Future<void>.delayed(Duration.zero);
        expect(calls, isEmpty);

        ready = true;
        sync.invalidate();
        sync.update(badge);
        await sync.clear();
        expect(calls.map((call) => call.method), ['badge']);
        expect(calls.single.arguments, {
          'bots': {'alpha': 100, 'beta': 0},
          'silenced': ['muted'],
        });
      },
    );
  });
}
