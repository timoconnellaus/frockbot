import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/activity/controller.dart';
import 'package:frockbot_native/activity/push.dart';
import 'package:frockbot_native/protocol/client_wire.generated.dart' as wire;

import 'settings_test.dart' show SettingsApi;
import 'widget_test.dart' show MemoryStore;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('Android bridge configures delivery, publishes focus, clears reads, and unregisters on logout', () async {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    final channel = const MethodChannel('frockbot/push');
    final bridge = <MethodCall>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          bridge.add(call);
          if (call.method == 'configure') return 'token-12345678901234567890';
          if (call.method == 'focus') return true;
          return null;
        });
    final store = MemoryStore();
    final registrations = <Map<String, dynamic>>[];
    final api = SettingsApi(store, (path, body) async {
      if (path == '/api/push/device') {
        registrations.add(Map<String, dynamic>.from(body as Map));
        return {'ok': true};
      }
      throw StateError(path);
    });
    final activity = ActivityController(api, store, 'tim');
    activity.unread['alpha'] = wire.UnreadView.fromJson({
      'schemaVersion': 1,
      'botId': 'alpha',
      'count': 0,
      'capped': false,
      'unread': false,
      'manuallyUnread': false,
      'lastSeenCursor': 'message-00000000000000000002',
    });
    final push = PushController(api, store, 'tim', activity, channel: channel);

    push.reading('alpha');
    await push.start();
    push.lifecycle(false);
    await push.register();
    expect(registrations.last.containsKey('activeBotId'), isFalse);
    await push.syncRead();
    await push.logout();

    expect(
      bridge.map((call) => call.method),
      containsAllInOrder([
        'configure',
        'focus',
        'permission',
        'read',
        'logout',
      ]),
    );
    expect(
      registrations,
      contains(
        predicate<Map<String, dynamic>>(
          (row) =>
              row['token'] == 'token-12345678901234567890' &&
              row['activeBotId'] == 'alpha',
        ),
      ),
    );
    expect(registrations.last['remove'], isTrue);

    activity.dispose();
    api.close();
    debugDefaultTargetPlatformOverride = null;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  test(
    'disposing during platform configuration starts no registration heartbeat',
    () async {
      debugDefaultTargetPlatformOverride = TargetPlatform.android;
      final channel = const MethodChannel('frockbot/push');
      final configured = Completer<String?>();
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (call) {
            if (call.method == 'configure') return configured.future;
            return Future<Object?>.value(false);
          });
      final store = MemoryStore();
      final registrations = <Object?>[];
      final api = SettingsApi(store, (path, body) async {
        if (path == '/api/push/device') registrations.add(body);
        return {'ok': true};
      });
      final activity = ActivityController(api, store, 'tim');
      final push = PushController(
        api,
        store,
        'tim',
        activity,
        channel: channel,
      );

      final starting = push.start();
      await Future<void>.delayed(Duration.zero);
      push.dispose();
      configured.complete('token-12345678901234567890');
      await starting;

      expect(push.timer, isNull);
      expect(registrations, isEmpty);

      activity.dispose();
      api.close();
      debugDefaultTargetPlatformOverride = null;
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, null);
    },
  );

  test(
    'the presence lease is renewed while focused and not while away',
    () async {
      final store = MemoryStore();
      final registrations = <Map<String, dynamic>>[];
      final api = SettingsApi(store, (path, body) async {
        if (path == '/api/push/device') {
          registrations.add(Map<String, dynamic>.from(body as Map));
          return {'ok': true};
        }
        throw StateError(path);
      });
      final activity = ActivityController(api, store, 'tim');
      final push = PushController(api, store, 'tim', activity);
      push.reading('alpha');
      await push.start();

      // Focused, the device claims a Bot and holds the lease open.
      expect(push.timer, isNotNull);
      expect(registrations.last['activeBotId'], 'alpha');

      // Away, it claims nothing — and there is nothing left to renew, so no
      // renewal runs for the life of the backgrounded process.
      push.lifecycle(false);
      await push.register();
      expect(push.timer, isNull);
      expect(registrations.last.containsKey('activeBotId'), isFalse);

      // Coming back registers immediately and reopens the renewal.
      push.lifecycle(true);
      await push.register();
      expect(push.timer, isNotNull);
      expect(registrations.last['activeBotId'], 'alpha');

      push.dispose();
      activity.dispose();
      api.close();
    },
  );

  test('a read cursor is published once, and again only when it moves', () async {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    final channel = const MethodChannel('frockbot/push');
    final reads = <Map<Object?, Object?>>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          if (call.method == 'configure') return 'token-12345678901234567890';
          if (call.method == 'focus') return true;
          if (call.method == 'read') {
            reads.add(call.arguments as Map<Object?, Object?>);
          }
          return null;
        });
    final store = MemoryStore();
    final api = SettingsApi(store, (path, body) async => {'ok': true});
    final activity = ActivityController(api, store, 'tim');
    void seen(String cursor) {
      activity.unread['alpha'] = wire.UnreadView.fromJson({
        'schemaVersion': 1,
        'botId': 'alpha',
        'count': 0,
        'capped': false,
        'unread': false,
        'manuallyUnread': false,
        'lastSeenCursor': cursor,
      });
    }

    seen('message-00000000000000000002');
    final push = PushController(api, store, 'tim', activity, channel: channel);
    await push.start();

    // The activity poll repaints every few seconds; the platform hears about
    // a cursor once.
    await push.syncRead();
    await push.syncRead();
    await push.syncRead();
    expect(reads, hasLength(1));
    expect(reads.single['cursor'], 'message-00000000000000000002');

    // And hears again the moment the person reads something newer.
    seen('message-00000000000000000005');
    await push.syncRead();
    expect(reads, hasLength(2));
    expect(reads.last['cursor'], 'message-00000000000000000005');

    // Signing out forgets it: the next account starts from nothing claimed.
    await push.logout();
    await push.syncRead();
    expect(reads, hasLength(3));

    push.dispose();
    activity.dispose();
    api.close();
    debugDefaultTargetPlatformOverride = null;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });
}
