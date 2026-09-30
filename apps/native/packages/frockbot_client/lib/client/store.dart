import 'package:flutter_secure_storage/flutter_secure_storage.dart';

abstract interface class LocalStore {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> delete(String key);
}

/// A store that can put every accepted write behind a durable boundary before
/// the process goes away. Ordinary callers rely on each write's own future;
/// process-level transitions need one place to wait for all of them.
abstract interface class CheckpointStore implements LocalStore {
  Future<void> checkpoint();
}

Future<void> checkpointStore(LocalStore store) => switch (store) {
  CheckpointStore checkpoint => checkpoint.checkpoint(),
  _ => Future.value(),
};

/// A store whose values are resident in memory, so the first frame after a
/// switch is painted without awaiting the platform.
abstract interface class SnapshotStore implements LocalStore {
  /// Whether [peek] is authoritative. While this is false a null answer only
  /// means "not loaded yet" and the asynchronous read still has to be awaited.
  bool get resident;

  /// The value already held in memory, without a platform round trip.
  String? peek(String key);
}

/// A store that can list what it holds, which a migration to another store
/// needs and ordinary reads and writes do not.
abstract interface class EnumerableStore implements LocalStore {
  Future<Map<String, String>> readAll();
}

class ProtectedStore implements LocalStore, EnumerableStore, CheckpointStore {
  final FlutterSecureStorage _storage = const FlutterSecureStorage();
  Future<void> _writes = Future.value();
  Future<void> _enqueue(Future<void> Function() operation) {
    final next = _writes.then((_) => operation());
    _writes = next.catchError((Object _) {});
    return next;
  }

  @override
  Future<String?> read(String key) async {
    await _writes;
    return _storage.read(key: 'native.v1.$key');
  }

  @override
  Future<void> write(String key, String value) =>
      _enqueue(() => _storage.write(key: 'native.v1.$key', value: value));
  @override
  Future<void> delete(String key) =>
      _enqueue(() => _storage.delete(key: 'native.v1.$key'));
  @override
  Future<Map<String, String>> readAll() async {
    await _writes;
    const prefix = 'native.v1.';
    final all = await _storage.readAll();
    return {
      for (final entry in all.entries)
        if (entry.key.startsWith(prefix))
          entry.key.substring(prefix.length): entry.value,
    };
  }

  @override
  Future<void> checkpoint() => _writes;
}

/// Where one account's keys live in the app's store: `account/<id>/<key>`.
const accountKeyPrefixV1 = 'account/';

/// The key an account-scoped key was written under, without its account.
String unscopedKeyV1(String key) {
  if (!key.startsWith(accountKeyPrefixV1)) return key;
  final end = key.indexOf('/', accountKeyPrefixV1.length);
  return end < 0 ? key : key.substring(end + 1);
}

/// One account's view of the app's store. Every key it reads or writes is
/// under the account's own prefix, so two accounts — on two servers, or two
/// sign-ins to one — never read each other's session, caches or drafts, and
/// signing out of one deletes only what is under its prefix.
class ScopedStore implements SnapshotStore, CheckpointStore {
  final LocalStore root;
  final String prefix;
  ScopedStore(this.root, String accountId)
    : prefix = '$accountKeyPrefixV1$accountId/';

  @override
  Future<String?> read(String key) => root.read('$prefix$key');
  @override
  Future<void> write(String key, String value) =>
      root.write('$prefix$key', value);
  @override
  Future<void> delete(String key) => root.delete('$prefix$key');

  @override
  bool get resident => switch (root) {
    SnapshotStore snapshot => snapshot.resident,
    _ => false,
  };

  @override
  String? peek(String key) => switch (root) {
    SnapshotStore snapshot => snapshot.peek('$prefix$key'),
    _ => null,
  };

  @override
  Future<void> checkpoint() => checkpointStore(root);
}

/// The app's store as accounts need it: signing out of one deletes every key
/// under its prefix, and the one cleanup of the single-account shape deletes
/// every key under none.
abstract interface class AccountsStore implements LocalStore {
  Future<void> deletePrefix(String prefix);

  /// Deletes every key outside an account except those in [keep].
  Future<void> deleteUnscoped(Set<String> keep);
}
