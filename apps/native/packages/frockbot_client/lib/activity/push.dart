import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

import '../client/transport.dart';
import 'controller.dart';
import 'web_push.dart';
import 'window_focus.dart';

export 'web_push.dart' show WebPushState;

/// The push relay the released apps' FCM project is reached through by a
/// server that holds no FCM credentials of its own (`apps/push-relay`).
///
/// Compiled in rather than taken from the server: the relay is the one party
/// that may hold this phone's FCM token, so a server cannot name another.
const pushRelayOrigin = String.fromEnvironment(
  'FROCKBOT_PUSH_RELAY',
  defaultValue: 'https://push.frockbot.com',
);

/// The relay said the handle is gone; registering afresh gets a new one.
class PushRelayGone implements Exception {
  const PushRelayGone();
}

/// The relay's two doors an app uses.
class PushRelay {
  final Uri origin;
  final http.Client client;
  PushRelay({Uri? origin, http.Client? client})
    : origin = origin ?? Uri.parse(pushRelayOrigin),
      client = client ?? http.Client();

  /// A handle for [token], or the same [handle] pointed at a rotated token.
  Future<String> register({
    required String token,
    required String platform,
    required String server,
    String? handle,
  }) async {
    final response = await client
        .post(
          origin.replace(path: '/register'),
          headers: const {'content-type': 'application/json'},
          body: jsonEncode({
            'token': token,
            'platform': platform,
            'server': server,
            'handle': ?handle,
          }),
        )
        .timeout(const Duration(seconds: 15));
    if (response.statusCode == 404 && handle != null) {
      throw const PushRelayGone();
    }
    if (response.statusCode != 200) {
      throw http.ClientException('Push relay refused (${response.statusCode})');
    }
    final value = jsonDecode(response.body);
    final issued = value is Map ? value['handle'] : null;
    if (issued is! String ||
        !RegExp(r'^ph_[A-Za-z0-9_-]{43}$').hasMatch(issued)) {
      throw const FormatException('Invalid push relay handle');
    }
    return issued;
  }

  Future<void> unregister(String handle) async {
    await client
        .post(
          origin.replace(path: '/unregister'),
          headers: const {'content-type': 'application/json'},
          body: jsonEncode({'handle': handle}),
        )
        .timeout(const Duration(seconds: 10));
  }
}

/// The platform owns delivery while Dart is stopped; the cloud owns read state.
class PushController {
  final NativeApi api;
  final LocalStore store;
  final String userId;
  final ActivityController activity;
  final MethodChannel channel;
  final PushRelay relay;
  PushController(
    this.api,
    this.store,
    this.userId,
    this.activity, {
    this.channel = const MethodChannel('frockbot/push'),
    PushRelay? relay,
    WebPush? webPush,
  }) : relay = relay ?? PushRelay(),
       webPush = webPush ?? WebPush();

  /// The browser's own push, which a web client turns on by hand.
  final WebPush webPush;

  /// The deployment's VAPID public key; null where it offers no web push.
  String? webPushKey;

  /// The phones, where push reaches the person while Dart is stopped, for an
  /// account on the deployment this build's Firebase registration belongs to.
  /// An account on another server registers its presence alone until the
  /// push relay can deliver for it, and never takes the platform's one push
  /// account from the account that has it.
  bool get mobile =>
      !kIsWeb &&
      api.origin == hostedOrigin &&
      (defaultTargetPlatform == TargetPlatform.android ||
          defaultTargetPlatform == TargetPlatform.iOS);

  /// Which app holds [token], so the cloud knows what it has to tell APNs,
  /// and that a browser's is a Web Push subscription.
  String get platform => kIsWeb
      ? 'web'
      : defaultTargetPlatform == TargetPlatform.iOS
      ? 'ios'
      : 'android';
  final windowFocus = WindowFocus();
  bool platformReady = false;
  String? deviceId;
  String? token;
  String? readingBot;

  /// How this account's server reaches the phone, as its last registration
  /// answered: `direct` with the FCM token, or `relay` through a handle. The
  /// token goes only to a server that answered `direct`.
  String? delivery;

  /// This account's relay handle and the key its server seals alerts to.
  String? relayHandle;
  Map<String, String>? relayKey;

  /// The token [relayHandle] was last pointed at in this process.
  String? _relayToken;
  DateTime? _relayRetryAt;
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
          'origin': api.origin,
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
    // Read after the platform is set up, which the badge waits on; only the
    // first registration needs them.
    delivery = await store.read('push-delivery:$userId');
    relayHandle = await store.read('push-relay-handle:$userId');
    if (disposed) return;
    // Presence goes out first; a browser's own subscription follows it once
    // the key and the worker are read, rather than holding the claim back.
    await register();
    if (disposed) return;
    _renewWhileFocused();
    if (kIsWeb && await _startWebPush()) await register();
  }

  /// Reads the deployment's key and re-registers a subscription this browser
  /// already holds. Nothing here asks: a browser asks only from a tap on
  /// Turn on notifications.
  /// Answers whether it found a subscription to register.
  Future<bool> _startWebPush() async {
    try {
      final answer = await api.request('/api/push/web');
      final key = answer is Map ? answer['publicKey'] : null;
      webPushKey = key is String && key.isNotEmpty ? key : null;
    } catch (_) {
      webPushKey = null;
    }
    if (disposed || webPushKey == null) return false;
    await webPush.prepare();
    try {
      token = await webPush.existing();
    } catch (_) {
      token = null;
    }
    return !disposed && token != null;
  }

  /// Whether this browser can be offered notifications at all.
  bool get webPushOffered =>
      kIsWeb && webPushKey != null && webPush.state != WebPushState.unsupported;

  /// Whether this browser is subscribed.
  bool get webPushOn => kIsWeb && token != null;

  /// Asks and subscribes: run straight from the tap, before anything is
  /// awaited, because the browser allows the prompt only inside the gesture.
  /// Answers why it did not turn on, or null once it has.
  Future<String?> turnOnWebPush() async {
    final key = webPushKey;
    if (key == null) return 'Notifications aren’t available here.';
    String? subscription;
    try {
      subscription = await webPush.subscribe(key);
    } catch (_) {
      subscription = null;
    }
    if (subscription == null) {
      // The page already says so when the browser refused outright.
      return webPush.state == WebPushState.blocked
          ? null
          : 'Couldn’t turn on notifications. Try again.';
    }
    token = subscription;
    await register();
    return null;
  }

  /// Stops this browser's notifications. The registry keeps a token a
  /// presence update omits, so the installation is removed and registered
  /// again without one.
  Future<void> turnOffWebPush() async {
    await _dropWebSubscription();
    await register(remove: true);
    await register();
  }

  /// Removing the installation is what stops delivery; a subscription that
  /// could not be dropped here is answered 410 and forgotten.
  Future<void> _dropWebSubscription() async {
    try {
      await webPush.unsubscribe();
    } catch (_) {}
    token = null;
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
    _registration = _registration
        .catchError((Object _) {})
        .then((_) => _register(remove));
    return _registration;
  }

  /// This device's address for its server: the token for one that sends to
  /// FCM itself, the relay handle and sealing key for one that sends through
  /// the relay, or nothing until the server has said which. A browser's
  /// subscription is always sent: the server reaches it itself with its own
  /// VAPID keys, never through FCM or the relay.
  Map<String, Object> _body(bool remove) => {
    'deviceId': deviceId!,
    if ((kIsWeb || delivery == 'direct') && token != null) ...{
      'token': token!,
      'platform': platform,
    },
    if (delivery == 'relay' && relayHandle != null && relayKey != null)
      'relay': {'handle': relayHandle!, ...relayKey!},
    if (focused && readingBot != null && !remove) 'activeBotId': readingBot!,
    if (remove) 'remove': true,
  };

  Future<void> _register(bool remove) async {
    final body = _body(remove);
    Object? answer;
    try {
      answer = await api.request('/api/push/device', body: body);
    } catch (_) {
      /* Presence expires if the device cannot renew it. */
      return;
    }
    if (remove || disposed) return;
    final learned = answer is Map && answer['delivery'] == 'relay'
        ? 'relay'
        : 'direct';
    if (learned != delivery) {
      delivery = learned;
      await store.write('push-delivery:$userId', learned);
    }
    if (learned == 'relay') await _ensureRelay();
    // What the server was told was a presence update, or an address this
    // answer has just changed: tell it the address now.
    final next = _body(false);
    if (jsonEncode(next['token']) != jsonEncode(body['token']) ||
        jsonEncode(next['relay']) != jsonEncode(body['relay'])) {
      try {
        await api.request('/api/push/device', body: next);
      } catch (_) {
        /* The next registration carries it again. */
      }
    }
  }

  /// Points this account's relay handle at the current token: a new handle
  /// the first time, the same one after a rotation. A failure leaves the
  /// server without an address, and is tried again a few minutes later.
  Future<void> _ensureRelay() async {
    final current = token;
    if (!platformReady || current == null || _relayToken == current) return;
    final retryAt = _relayRetryAt;
    if (retryAt != null && DateTime.now().isBefore(retryAt)) return;
    try {
      relayKey ??= Map<String, String>.from(
        await channel.invokeMapMethod<String, String>('relayKey') ?? const {},
      );
      if (relayKey!['p256dh'] == null || relayKey!['auth'] == null) {
        relayKey = null;
        return;
      }
      String handle;
      try {
        handle = await relay.register(
          token: current,
          platform: platform,
          server: hostedOrigin,
          handle: relayHandle,
        );
      } on PushRelayGone {
        handle = await relay.register(
          token: current,
          platform: platform,
          server: hostedOrigin,
        );
      }
      if (handle != relayHandle) {
        relayHandle = handle;
        await store.write('push-relay-handle:$userId', handle);
      }
      _relayToken = current;
      _relayRetryAt = null;
    } catch (_) {
      _relayRetryAt = DateTime.now().add(const Duration(minutes: 5));
    }
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
    if (disposed || !(kIsWeb ? token != null : platformReady)) return;
    for (final view in activity.unread.values) {
      final cursor = view.lastSeenCursor?.value;
      if (cursor == null) continue;
      final botId = view.botId.value;
      if (_syncedRead[botId] == cursor) continue;
      if (kIsWeb) {
        // A browser is sent no read signal, so it clears its own
        // notifications from the cloud's read cursors.
        webPush.read(botId, cursor);
        _syncedRead[botId] = cursor;
        continue;
      }
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
    if (kIsWeb && token != null) await _dropWebSubscription();
    // Signing out deletes the handle, so nothing reaches this phone for the
    // account even if the server never hears the removal below.
    final handle = relayHandle;
    relayHandle = null;
    relayKey = null;
    _relayToken = null;
    await store.delete('push-relay-handle:$userId');
    if (handle != null) {
      try {
        await relay.unregister(handle);
      } catch (_) {
        /* The server's removal still stops it sending. */
      }
    }
    await register(remove: true);
  }

  void dispose() {
    disposed = true;
    relay.client.close();
    windowFocus.dispose();
    webPush.dispose();
    timer?.cancel();
    if (mobile) channel.setMethodCallHandler(null);
  }
}

/// Signs an account that is not on screen out of push: its registration on
/// the server, and — when [platform] says it may be the account the platform
/// delivers for — the platform's account and every alert it drew. The next
/// shell of an account on this build's deployment configures it afresh.
Future<void> signOutOfPushV1(
  NativeApi api,
  LocalStore store, {
  required bool platform,
  MethodChannel channel = const MethodChannel('frockbot/push'),
}) async {
  final deviceId = await store.read('push-device');
  if (deviceId != null) {
    try {
      await api.request(
        '/api/push/device',
        body: {'deviceId': deviceId, 'remove': true},
      );
    } catch (_) {
      // The registration expires on its own when nothing renews it.
    }
  }
  if (!platform ||
      kIsWeb ||
      api.origin != hostedOrigin ||
      (defaultTargetPlatform != TargetPlatform.android &&
          defaultTargetPlatform != TargetPlatform.iOS)) {
    return;
  }
  try {
    await channel.invokeMethod<void>('logout');
  } on MissingPluginException {
    // A build without the platform half has nothing to sign out of.
  } on PlatformException {
    // Nor does one whose Firebase registration is absent.
  }
}
