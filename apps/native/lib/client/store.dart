import 'package:flutter_secure_storage/flutter_secure_storage.dart';

abstract interface class LocalStore {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> delete(String key);
}

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

class ProtectedStore implements LocalStore, EnumerableStore {
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
}
