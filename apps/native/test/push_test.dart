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

  test('disposing during platform configuration starts no registration heartbeat', () async {
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
    final push = PushController(api, store, 'tim', activity, channel: channel);

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
  });
}
