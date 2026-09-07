import 'package:web/web.dart' as web;

import 'store.dart';

/// The browser's durable store for everything that is not a secret: the
/// selected Bot, the Bot directory, observer cursors, drafts and cached
/// transcripts. The session is not among them — it is a cookie the browser
/// never hands to script.
///
/// `localStorage` is synchronous, so every value is resident the moment it is
/// written and a write is durable when it returns, which is what the callers
/// that must persist before dispatching require. Its budget is a few megabytes
/// per origin, the same order as the phone document's 4 MiB read bound.
class WebStore implements SnapshotStore {
  static const prefix = 'frockbot.native.v1.';
  final web.Storage storage;
  WebStore({web.Storage? storage})
    : storage = storage ?? web.window.localStorage;

  @override
  bool get resident => true;

  @override
  String? peek(String key) => storage.getItem('$prefix$key');

  @override
  Future<String?> read(String key) async => peek(key);

  @override
  Future<void> write(String key, String value) async =>
      storage.setItem('$prefix$key', value);

  @override
  Future<void> delete(String key) async => storage.removeItem('$prefix$key');
}

LocalStore nativeStore() => WebStore();
