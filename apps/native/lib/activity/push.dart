import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import '../client/transport.dart';
import 'controller.dart';
import 'window_focus.dart';

/// The platform owns delivery while Dart is stopped; the cloud owns read state.
class PushController {
  final NativeApi api;
  final LocalStore store;
  final String userId;
  final ActivityController activity;
  final MethodChannel channel;
  PushController(
    this.api,
    this.store,
    this.userId,
    this.activity, {
    this.channel = const MethodChannel('frockbot/push'),
  });
  bool get android =>
      !kIsWeb && defaultTargetPlatform == TargetPlatform.android;
  final windowFocus = WindowFocus();
  bool platformReady = false;
  String? deviceId;
  String? token;
  String? readingBot;
  bool focused = true;
  bool disposed = false;
  Timer? timer;
  Future<void> _registration = Future.value();
  Future<void> start() async {
    windowFocus.start((active) {
      focused = active && windowFocus.focused;
      _renewWhileFocused();
      unawaited(register());
      if (active) unawaited(activity.load());
    });
    deviceId = await store.read('push-device');
    deviceId ??= randomId();
    await store.write('push-device', deviceId!);
    if (disposed) return;
    if (android) {
      channel.setMethodCallHandler((call) async {
        if (disposed) return;
        if (call.method == 'token') {
          token = call.arguments as String?;
          await register();
        }
        if (call.method == 'activity') await activity.load();
        if (call.method == 'focus') {
          focused = call.arguments == true;
          _renewWhileFocused();
          await register();
          if (focused) await activity.load();
        }
      });
      try {
        token = await channel.invokeMethod<String>('configure', {
          'userId': userId,
        });
        platformReady = true;
        focused =
            await channel.invokeMethod<bool>('focus', {'botId': readingBot}) ??
            false;
        if (await store.read('push-permission-asked') == null) {
          await channel.invokeMethod<void>('permission');
          await store.write('push-permission-asked', 'true');
        }
      } on MissingPluginException {
        platformReady = false;
      } on PlatformException {
        activity.error =
            'Couldn’t enable notifications. Try reopening the app.';
      }
    }
    if (disposed) return;
    await register();
    if (disposed) return;
    _renewWhileFocused();
  }

  /// The presence lease is a claim a focused device makes, and every focus and
  /// lifecycle transition registers directly. Renewing it while the app is away
  /// renews nothing — `register` claims no Bot when it is not focused — and
  /// cost an HTTPS round trip and a Durable Object write every six seconds for
  /// the life of the process. The renewal runs only while there is a lease to
  /// hold open.
  void _renewWhileFocused() {
    if (disposed || focused == (timer != null)) return;
    if (!focused) {
      timer?.cancel();
      timer = null;
      return;
    }
    // Renew twice within the 15-second lease without hitting the dev proxy's
    // five-second keep-alive race: cloudflare/workers-sdk#15452.
    timer = Timer.periodic(
      const Duration(seconds: 6),
      (_) => unawaited(register()),
    );
  }

  Future<void> register({bool remove = false}) {
    if (deviceId == null || (disposed && !remove)) return Future.value();
    final body = <String, Object>{
      'deviceId': deviceId!,
      'token': ?token,
      if (focused && readingBot != null && !remove) 'activeBotId': readingBot!,
      if (remove) 'remove': true,
    };
    _registration = _registration.catchError((Object _) {}).then((_) async {
      try {
        await api.request('/api/push/device', body: body);
      } catch (_) {
        /* Presence expires if the device cannot renew it. */
      }
    });
    return _registration;
  }

  void lifecycle(bool active) {
    focused = active && windowFocus.focused;
    _renewWhileFocused();
    unawaited(register());
  }

  void reading(String? botId) {
    if (readingBot == botId) return;
    readingBot = botId;
    if (platformReady) {
      unawaited(channel.invokeMethod<void>('focus', {'botId': botId}));
    }
    unawaited(register());
  }

  /// The read cursor each Bot has already been told about, so a repaint that
  /// changed nothing costs no platform round trip. Scoped to this controller,
  /// which is scoped to the signed-in account, and recorded only once the
  /// channel has answered: a call that threw was never delivered.
  final Map<String, String> _syncedRead = {};

  Future<void> syncRead() async {
    if (!platformReady || disposed) return;
    for (final view in activity.unread.values) {
      final cursor = view.lastSeenCursor?.value;
      if (cursor == null) continue;
      final botId = view.botId.value;
      if (_syncedRead[botId] == cursor) continue;
      await channel.invokeMethod<void>('read', {
        'botId': botId,
        'cursor': cursor,
      });
      _syncedRead[botId] = cursor;
    }
  }

  Future<void> logout() async {
    readingBot = null;
    _syncedRead.clear();
    timer?.cancel();
    timer = null;
    if (platformReady) await channel.invokeMethod<void>('logout');
    await register(remove: true);
  }

  void dispose() {
    disposed = true;
    windowFocus.dispose();
    timer?.cancel();
    if (android) channel.setMethodCallHandler(null);
  }
}
