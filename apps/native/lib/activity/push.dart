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
    timer = Timer.periodic(
      const Duration(seconds: 5),
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

  Future<void> syncRead() async {
    if (!platformReady || disposed) return;
    for (final view in activity.unread.values) {
      if (view.lastSeenCursor != null) {
        await channel.invokeMethod<void>('read', {
          'botId': view.botId.value,
          'cursor': view.lastSeenCursor!.value,
        });
      }
    }
  }

  Future<void> logout() async {
    readingBot = null;
    timer?.cancel();
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
