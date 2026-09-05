import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:path_provider/path_provider.dart';

import 'transport.dart';

/// A durable store for everything that is not a secret: the selected Bot, the
/// Bot directory, observer cursors, drafts and cached transcripts. It holds one
/// JSON document read once at startup, so a switch between Bots reads from
/// memory instead of the platform keystore.
class PlainStore implements SnapshotStore {
  final Future<Directory> Function() location;
  final String name;
  final Map<String, String> _values = {};
  Future<void>? _loading;
  Future<void> _writes = Future.value();
  File? _file;
  bool _loaded = false;
  PlainStore({
    Future<Directory> Function()? location,
    this.name = 'native-store-v1.json',
  }) : location = location ?? getApplicationSupportDirectory;

  @override
  bool get resident => _loaded;

  @override
  String? peek(String key) => _values[key];

  Future<void> load() => _loading ??= _load();

  Future<void> _load() async {
    try {
      final directory = await location();
      final file = File('${directory.path}/$name');
      _file = file;
      if (await file.exists()) {
        final decoded = decodeBoundedJson(
          await file.readAsString(),
          maxBytes: 4194304,
        );
        if (decoded is Map) {
          decoded.forEach((key, value) {
            // A value written before the document finished loading is newer
            // than the document and keeps its place.
            if (key is String && value is String) {
              _values.putIfAbsent(key, () => value);
            }
          });
        }
      }
    } catch (_) {
      // An unreadable document is a cold cache, not a failure: this run keeps
      // its values in memory and rewrites the document on the next write.
    }
    _loaded = true;
  }

  @override
  Future<String?> read(String key) async {
    await load();
    return _values[key];
  }

  @override
  Future<void> write(String key, String value) {
    _values[key] = value;
    return _flush();
  }

  @override
  Future<void> delete(String key) {
    _values.remove(key);
    return _flush();
  }

  /// Resolves once the document containing the change is on disk, so callers
  /// that require a durable local write before dispatching keep that guarantee.
  Future<void> _flush() {
    final next = _writes.then((_) async {
      await load();
      final file = _file;
      if (file == null) throw const FileSystemException('No store location');
      final pending = File('${file.path}.writing');
      await pending.writeAsString(jsonEncode(_values), flush: true);
      await pending.rename(file.path);
    });
    _writes = next.catchError((Object _) {});
    return next;
  }
}

/// Routes each key to the store that suits it and migrates values written by
/// the released shape that kept everything in the keystore.
class SplitStore implements SnapshotStore {
  static const migrationKey = 'store.migrated.v1';
  final LocalStore secrets;
  final PlainStore plain;
  final Future<Map<String, String>> Function() enumerate;
  Future<void>? _migration;
  bool _migrated = false;
  SplitStore({
    required this.secrets,
    required this.plain,
    required this.enumerate,
  });

  /// The session token and the sign-in verifier are the only secrets this app
  /// holds; a revoke command carries the session it revokes.
  static bool secret(String key) =>
      key == 'session' || key == 'sign-in' || key.startsWith('revoke/');

  @override
  bool get resident => _migrated && plain.resident;

  @override
  String? peek(String key) => secret(key) ? null : plain.peek(key);

  Future<void> migrate() => _migration ??= _migrate();

  Future<void> _migrate() async {
    try {
      await plain.load();
      if (plain.peek(migrationKey) == null) {
        for (final entry in (await enumerate()).entries) {
          if (secret(entry.key)) continue;
          await plain.write(entry.key, entry.value);
          await secrets.delete(entry.key);
        }
        await plain.write(migrationKey, '1');
      }
      _migrated = true;
    } catch (_) {
      // A keystore that cannot be enumerated keeps its values, and the reads
      // below still find them. The migration is retried on the next launch.
    }
  }

  @override
  Future<String?> read(String key) async {
    if (secret(key)) return secrets.read(key);
    await migrate();
    final value = await plain.read(key);
    // A migration that could not run leaves the value where it was written.
    if (value != null || _migrated) return value;
    return secrets.read(key);
  }

  @override
  Future<void> write(String key, String value) async {
    if (secret(key)) return secrets.write(key, value);
    await migrate();
    return plain.write(key, value);
  }

  @override
  Future<void> delete(String key) async {
    if (secret(key)) return secrets.delete(key);
    await migrate();
    await plain.delete(key);
    if (!_migrated) await secrets.delete(key);
  }
}

/// The store the app runs on: secrets in the platform keystore, everything else
/// in a plain document beside it.
LocalStore nativeStore() {
  final secrets = ProtectedStore();
  return SplitStore(
    secrets: secrets,
    plain: PlainStore(),
    enumerate: secrets.readAll,
  );
}
