import 'dart:async';
import 'dart:convert';
import 'dart:js_interop';
import 'dart:js_interop_unsafe';
import 'dart:typed_data';

import 'package:web/web.dart' as web;

import 'web_push_state.dart';

export 'web_push_state.dart';

/// The browser's push subscription and the service worker that draws what it
/// receives (`apps/native/web/push-worker.js`, served at the origin's root).
class WebPush {
  web.ServiceWorkerRegistration? _registration;
  JSFunction? _listener;

  bool get _supported =>
      globalContext.has('Notification') &&
      globalContext.has('PushManager') &&
      web.window.navigator.has('serviceWorker');

  bool get _appleTouch {
    final agent = web.window.navigator.userAgent;
    // iPadOS asks for the desktop site, so it says Macintosh with touch.
    return RegExp('iPhone|iPad|iPod').hasMatch(agent) ||
        (agent.contains('Macintosh') &&
            web.window.navigator.maxTouchPoints > 1);
  }

  WebPushState get state {
    if (!_supported) {
      return _appleTouch
          ? WebPushState.needsHomeScreen
          : WebPushState.unsupported;
    }
    return switch (web.Notification.permission) {
      'granted' => WebPushState.allowed,
      'denied' => WebPushState.blocked,
      _ => WebPushState.ask,
    };
  }

  /// Registers the worker ahead of any tap, so turning notifications on can
  /// subscribe inside the gesture the browser requires.
  Future<void> prepare() async {
    if (!_supported || _registration != null) return;
    try {
      _registration = await web.window.navigator.serviceWorker
          .register('/push-worker.js'.toJS, web.RegistrationOptions(scope: '/'))
          .toDart;
    } catch (_) {
      // No worker, no push: the page offers nothing it cannot deliver.
    }
  }

  /// The subscription this browser already holds, for a permission already
  /// given. Never asks.
  Future<String?> existing() async {
    final registration = _registration;
    if (registration == null || state != WebPushState.allowed) return null;
    final subscription = await registration.pushManager
        .getSubscription()
        .toDart;
    return subscription == null ? null : _encode(subscription);
  }

  /// Asks, and subscribes. Called from the tap itself: the permission prompt
  /// needs the gesture, and on an iPhone so does the subscription.
  Future<String?> subscribe(String publicKey) async {
    final registration = _registration;
    if (registration == null) return null;
    final subscription = await registration.pushManager
        .subscribe(
          web.PushSubscriptionOptionsInit(
            userVisibleOnly: true,
            applicationServerKey: _decode(publicKey).toJS,
          ),
        )
        .toDart;
    return _encode(subscription);
  }

  Future<void> unsubscribe() async {
    final registration = _registration;
    if (registration == null) return;
    final subscription = await registration.pushManager
        .getSubscription()
        .toDart;
    await subscription?.unsubscribe().toDart;
    for (final notification
        in (await registration.getNotifications().toDart).toDart) {
      notification.close();
    }
  }

  /// A notification clicked while the app is open: the worker hands the tab
  /// the link rather than opening another.
  void onOpen(void Function(Uri link) handler) {
    if (!_supported) return;
    final listener = ((web.MessageEvent event) {
      final data = event.data.dartify();
      if (data is Map && data['type'] == 'frockbot-open') {
        final link = Uri.tryParse('${data['link']}');
        if (link != null) handler(link);
      }
    }).toJS;
    _listener = listener;
    web.window.navigator.serviceWorker.addEventListener('message', listener);
  }

  /// A conversation read up to [cursor], here or elsewhere: its notification
  /// goes once it shows nothing newer.
  void read(String key, String cursor) {
    _registration?.active?.postMessage(
      {'type': 'frockbot-read', 'key': key, 'cursor': cursor}.jsify(),
    );
  }

  void dispose() {
    final listener = _listener;
    if (listener == null) return;
    web.window.navigator.serviceWorker.removeEventListener('message', listener);
    _listener = null;
  }

  String _encode(web.PushSubscription subscription) =>
      jsonEncode((subscription.toJSON() as JSObject).dartify());

  Uint8List _decode(String key) =>
      base64Url.decode(key.padRight((key.length + 3) ~/ 4 * 4, '='));
}
