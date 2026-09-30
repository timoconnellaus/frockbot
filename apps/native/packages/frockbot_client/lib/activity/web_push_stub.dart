import 'web_push_state.dart';

export 'web_push_state.dart';

/// Only a browser has Web Push; the apps are told through Firebase.
class WebPush {
  WebPushState get state => WebPushState.unsupported;
  Future<void> prepare() async {}
  Future<String?> existing() async => null;
  Future<String?> subscribe(String publicKey) async => null;
  Future<void> unsubscribe() async {}
  void onOpen(void Function(Uri link) handler) {}
  void read(String key, String cursor) {}
  void dispose() {}
}
