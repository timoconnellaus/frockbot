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

  /// The phones, where push reaches the person while Dart is stopped.
  bool get mobile =>
      !kIsWeb &&
      (defaultTargetPlatform == TargetPlatform.android ||
          defaultTargetPlatform == TargetPlatform.iOS);

  /// Which app holds [token], so the cloud knows what it has to tell APNs.
  String get platform =>
      defaultTargetPlatform == TargetPlatform.iOS ? 'ios' : 'android';
  final windowFocus = WindowFocus();
  bool platformReady = false;
  String? deviceId;
  String? token;
  String? readingBot;
  bool focused = true;
  bool disposed = false;

  /// Told when [focused] may have changed. Losing focus reads nothing new, but
  /// the badges drawn through the focus rule still change.
  VoidCallback? onFocus;

  /// Refresh presentation only: calling syncRead here would reenter its
  /// in-flight loop before the remaining Bots have synced their cursors.
  VoidCallback? onNotificationsChanged;
  Timer? timer;
  Future<void> _registration = Future.value();
  Future<void> start() async {
    windowFocus.start((active) {
      focused = active && windowFocus.focused;
      _renewWhileFocused();
      unawaited(register());
      onFocus?.call();
      if (active) unawaited(activity.load());
    });
    deviceId = await store.read('push-device');
    deviceId ??= randomId();
    await store.write('push-device', deviceId!);
    if (disposed) return;
    if (mobile) {
      channel.setMethodCallHandler((call) async {
        if (disposed) return;
        if (call.method == 'token') {
          token = call.arguments as String?;
          await register();
        }
        if (call.method == 'activity') {
          onNotificationsChanged?.call();
          await activity.load();
        }
        if (call.method == 'focus') {
          focused = call.arguments == true;
          _renewWhileFocused();
          onFocus?.call();
          await register();
          if (focused) await activity.load();
        }
      });
      try {
        // The origin is what a tapped alert opens: an iPhone builds that link
        // itself, from the deployment this build talks to.
        token = await channel.invokeMethod<String>('configure', {
          'userId': userId,
          'origin': hostedOrigin,
        });
        platformReady = true;
        focused =
            await channel.invokeMethod<bool>('focus', {'botId': readingBot}) ??
            false;
        onFocus?.call();
        if (await store.read('push-permission-asked') == null) {
          await channel.invokeMethod<void>('permission');
          await store.write('push-permission-asked', 'true');
        }
      } on MissingPluginException {
        platformReady = false;
      } on PlatformException catch (error) {
        // A build carrying no Firebase registration — a development build —
        // has no push to enable, and reopening the app would not change that.
        if (error.code != 'unconfigured') {
          activity.error =
              'Couldn’t enable notifications. Try reopening the app.';
        }
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
      if (token != null) 'platform': platform,
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
    onFocus?.call();
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
      onNotificationsChanged?.call();
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
    if (mobile) channel.setMethodCallHandler(null);
  }
}
