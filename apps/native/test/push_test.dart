import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:frockbot_client/activity/controller.dart';
import 'package:frockbot_client/activity/push.dart';
import 'package:frockbot_client/client/transport.dart' show hostedOrigin;
import 'package:frockbot_client/protocol/client_wire.generated.dart' as wire;

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
    final activity = ActivityController(api);
    activity.unread['alpha'] = wire.UnreadView.fromJson({
      'schemaVersion': 1,
      'botId': 'alpha',
      'count': 0,
      'capped': false,
      'unread': false,
      'manuallyUnread': false,
      'notificationsEnabled': true,
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
              row['platform'] == 'android' &&
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
    'an iPhone registers its token as one APNs must be told what to draw',
    () async {
      debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
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
        registrations.add(Map<String, dynamic>.from(body as Map));
        return {'ok': true};
      });
      final activity = ActivityController(api);
      final push = PushController(
        api,
        store,
        'tim',
        activity,
        channel: channel,
      );

      await push.start();

      // A tapped alert opens this deployment's own link, which the iPhone
      // builds natively from the origin it was given.
      expect(bridge.first.method, 'configure');
      expect(bridge.first.arguments, {'userId': 'tim', 'origin': hostedOrigin});
      expect(push.platformReady, isTrue);
      expect(registrations.last['token'], 'token-12345678901234567890');
      expect(registrations.last['platform'], 'ios');

      push.dispose();
      activity.dispose();
      api.close();
      debugDefaultTargetPlatformOverride = null;
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, null);
    },
  );

  test(
    'a build with no Firebase registration has no push, and says nothing',
    () async {
      debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
      final channel = const MethodChannel('frockbot/push');
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (call) async {
            if (call.method == 'configure') {
              throw PlatformException(code: 'unconfigured');
            }
            return null;
          });
      final store = MemoryStore();
      final registrations = <Map<String, dynamic>>[];
      final api = SettingsApi(store, (path, body) async {
        registrations.add(Map<String, dynamic>.from(body as Map));
        return {'ok': true};
      });
      final activity = ActivityController(api);
      final push = PushController(
        api,
        store,
        'tim',
        activity,
        channel: channel,
      );

      await push.start();

      expect(push.platformReady, isFalse);
      expect(activity.error, isNull);
      // Presence still registers: another device's alert waits while this one
      // is reading.
      expect(registrations.single.containsKey('token'), isFalse);
      expect(registrations.single.containsKey('platform'), isFalse);

      push.dispose();
      activity.dispose();
      api.close();
      debugDefaultTargetPlatformOverride = null;
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, null);
    },
  );

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
      final activity = ActivityController(api);
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

  testWidgets(
    'the presence lease is renewed while focused and not while away',
    (tester) async {
      debugDefaultTargetPlatformOverride = TargetPlatform.linux;
      addTearDown(() {
        debugDefaultTargetPlatformOverride = null;
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
      final activity = ActivityController(api);
      final push = PushController(api, store, 'tim', activity);
      var cleanedUp = false;
      addTearDown(() {
        if (cleanedUp) return;
        push.dispose();
        activity.dispose();
        api.close();
      });
      push.reading('alpha');
      await push.start();

      // Focused, the device claims a Bot and holds the lease open.
      expect(push.timer, isNotNull);
      expect(registrations.last['activeBotId'], 'alpha');
      final initialRegistrations = registrations.length;
      await tester.pump(const Duration(seconds: 5));
      expect(registrations, hasLength(initialRegistrations));
      await tester.pump(const Duration(seconds: 1));
      expect(registrations, hasLength(initialRegistrations + 1));
      expect(registrations.last['activeBotId'], 'alpha');

      // Away, it claims nothing — and there is nothing left to renew, so no
      // renewal runs for the life of the backgrounded process.
      push.lifecycle(false);
      await push.register();
      expect(push.timer, isNull);
      expect(registrations.last.containsKey('activeBotId'), isFalse);
      final awayRegistrations = registrations.length;
      await tester.pump(const Duration(seconds: 18));
      expect(registrations, hasLength(awayRegistrations));

      // Coming back registers immediately and reopens the renewal.
      push.lifecycle(true);
      await push.register();
      expect(push.timer, isNotNull);
      expect(registrations.last['activeBotId'], 'alpha');

      cleanedUp = true;
      push.dispose();
      activity.dispose();
      api.close();
      debugDefaultTargetPlatformOverride = null;
    },
  );

  test(
    'a read cursor is published once, and again only when it moves',
    () async {
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
      final activity = ActivityController(api);
      void seen(String cursor) {
        activity.unread['alpha'] = wire.UnreadView.fromJson({
          'schemaVersion': 1,
          'botId': 'alpha',
          'count': 0,
          'capped': false,
          'unread': false,
          'manuallyUnread': false,
          'notificationsEnabled': true,
          'lastSeenCursor': cursor,
        });
      }

      seen('message-00000000000000000002');
      final push = PushController(
        api,
        store,
        'tim',
        activity,
        channel: channel,
      );
      await push.start();
      var notificationChanges = 0;
      push.onNotificationsChanged = () {
        notificationChanges++;
        unawaited(push.syncRead());
      };

      // The activity poll repaints every few seconds; the platform hears about
      // a cursor once.
      await push.syncRead();
      await push.syncRead();
      await push.syncRead();
      expect(reads, hasLength(1));
      expect(notificationChanges, 1);
      expect(reads.single['cursor'], 'message-00000000000000000002');

      // And hears again the moment the person reads something newer.
      seen('message-00000000000000000005');
      await push.syncRead();
      expect(reads, hasLength(2));
      expect(notificationChanges, 2);
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
    },
  );

  group('a server with no FCM credentials of its own', () {
    const handle = 'ph_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const key = {
      'p256dh': 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
      'auth': 'BTBZMqHH6r4Tts7J_aSIgg',
    };

    ({
      MethodChannel channel,
      List<MethodCall> bridge,
      List<Map<String, dynamic>> registrations,
      List<(String, Map<String, dynamic>)> relayed,
      MemoryStore store,
      ActivityController activity,
      SettingsApi api,
      PushController push,
    })
    harness({int Function(String path, Map<String, dynamic> body)? status}) {
      debugDefaultTargetPlatformOverride = TargetPlatform.android;
      const channel = MethodChannel('frockbot/push');
      final bridge = <MethodCall>[];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (call) async {
            bridge.add(call);
            if (call.method == 'configure') return 'token-12345678901234567890';
            if (call.method == 'focus') return false;
            if (call.method == 'relayKey') return key;
            return null;
          });
      final store = MemoryStore()..values['push-permission-asked'] = 'true';
      final registrations = <Map<String, dynamic>>[];
      final api = SettingsApi(store, (path, body) async {
        registrations.add(Map<String, dynamic>.from(body as Map));
        return {'ok': true, 'delivery': 'relay'};
      });
      final relayed = <(String, Map<String, dynamic>)>[];
      final relay = PushRelay(
        origin: Uri.parse('https://relay.test'),
        client: MockClient((request) async {
          final body = Map<String, dynamic>.from(
            jsonDecode(request.body) as Map,
          );
          relayed.add((request.url.path, body));
          final code = status?.call(request.url.path, body) ?? 200;
          if (request.url.path == '/register' && code == 200) {
            return http.Response(jsonEncode({'handle': handle}), 200);
          }
          return http.Response('{}', code);
        }),
      );
      final activity = ActivityController(api);
      final push = PushController(
        api,
        store,
        'tim',
        activity,
        channel: channel,
        relay: relay,
      );
      return (
        channel: channel,
        bridge: bridge,
        registrations: registrations,
        relayed: relayed,
        store: store,
        activity: activity,
        api: api,
        push: push,
      );
    }

    void tearDownHarness(ActivityController activity, SettingsApi api) {
      activity.dispose();
      api.close();
      debugDefaultTargetPlatformOverride = null;
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(const MethodChannel('frockbot/push'), null);
    }

    test('gets a relay handle, and the server never sees the token', () async {
      final h = harness();
      await h.push.start();

      expect(h.registrations.where((row) => row.containsKey('token')), isEmpty);
      expect(h.relayed.single.$1, '/register');
      expect(h.relayed.single.$2, {
        'token': 'token-12345678901234567890',
        'platform': 'android',
        'server': hostedOrigin,
      });
      expect(h.registrations.last['relay'], {'handle': handle, ...key});
      expect(h.store.values['push-relay-handle:tim'], handle);
      expect(h.store.values['push-delivery:tim'], 'relay');

      // A presence renewal carries the same address and asks the relay nothing.
      await h.push.register();
      expect(h.relayed, hasLength(1));
      expect(h.registrations.last['relay'], {'handle': handle, ...key});

      h.push.dispose();
      tearDownHarness(h.activity, h.api);
    });

    test(
      'a rotated token keeps the handle, and a lost one is replaced',
      () async {
        final h = harness(
          status: (path, body) => body['handle'] != null ? 404 : 200,
        );
        h.store.values['push-delivery:tim'] = 'relay';
        h.store.values['push-relay-handle:tim'] = 'ph_${'Z' * 43}';
        await h.push.start();
        // The stored handle was gone at the relay, so a fresh one was issued.
        expect(h.relayed.map((call) => call.$1), ['/register', '/register']);
        expect(h.relayed.first.$2['handle'], 'ph_${'Z' * 43}');
        expect(h.relayed.last.$2.containsKey('handle'), isFalse);
        expect(h.push.relayHandle, handle);

        h.push.dispose();
        tearDownHarness(h.activity, h.api);

        final rotated = harness();
        await rotated.push.start();
        await TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
            .handlePlatformMessage(
              'frockbot/push',
              const StandardMethodCodec().encodeMethodCall(
                const MethodCall('token', 'token-rotated-123456789012345'),
              ),
              (_) {},
            );
        await rotated.push.register();
        expect(rotated.relayed.last.$1, '/register');
        expect(rotated.relayed.last.$2, {
          'token': 'token-rotated-123456789012345',
          'platform': 'android',
          'server': hostedOrigin,
          'handle': handle,
        });
        expect(
          rotated.registrations.where((row) => row.containsKey('token')),
          isEmpty,
        );
        rotated.push.dispose();
        tearDownHarness(rotated.activity, rotated.api);
      },
    );

    test('signing out deletes the handle at the relay', () async {
      final h = harness();
      await h.push.start();
      await h.push.logout();

      expect(h.relayed.last.$1, '/unregister');
      expect(h.relayed.last.$2, {'handle': handle});
      expect(h.store.values.containsKey('push-relay-handle:tim'), isFalse);
      expect(h.push.relayHandle, isNull);
      expect(h.registrations.last['remove'], isTrue);
      expect(h.bridge.map((call) => call.method), contains('logout'));

      h.push.dispose();
      tearDownHarness(h.activity, h.api);
    });
  });
}
