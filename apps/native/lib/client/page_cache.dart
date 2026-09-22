import 'dart:convert';

import 'transport.dart';

/// The last transcript page seen for a Bot, kept so that switching to it paints
/// its messages before the network answers. Cache, epoch and cursor live in
/// one envelope so a reconnect never pairs a later cursor with an older page.
String pageCacheKey(String userId, String botId) => 'page/$userId/$botId';

/// Beyond this the cache costs more to write than the blank frame it saves.
const cachedRunLimit = 40;
const cachedPageBytes = 256000;

class CachedPage {
  final List<Map<String, dynamic>> runs;
  final String? before;
  final String? epoch;
  final String? cursor;
  final List<Object?> announcements;
  const CachedPage(
    this.runs,
    this.before, {
    this.epoch,
    this.cursor,
    this.announcements = const [],
  });
}

/// The cached projection's shape. Version 3 is the first that stores the
/// publication epoch and cursor with the rows they name.
const pageCacheVersion = 3;

/// Decodes a cache written by this shape; anything else — an older version, a
/// row missing its run identity, a send with no durable ordinal — is discarded
/// wholesale rather than shown, and the next snapshot refills it.
CachedPage? decodePageCache(String? saved) {
  if (saved == null) return null;
  try {
    final value = jsonDecode(saved);
    if (value is! Map || value['version'] != pageCacheVersion) return null;
    final runs = <Map<String, dynamic>>[];
    for (final run in value['runs'] as List) {
      final row = Map<String, dynamic>.from(run as Map);
      if (row['runId'] is! String || row['admittedAt'] is! String) return null;
      for (final event in (row['events'] as List?) ?? const []) {
        if (event is! Map || event['type'] != 'send/to-user') continue;
        final ordinal = event['ordinal'];
        if (ordinal is! int || ordinal < 0) return null;
      }
      runs.add(row);
    }
    final before = value['before'];
    if (before != null && before is! String) return null;
    final epoch = value['epoch'];
    final cursor = value['cursor'];
    if (epoch != null && epoch is! String) return null;
    if (cursor != null && cursor is! String) return null;
    // A cursor without its matching rows is unrecoverable: reconnect would
    // skip events the cache no longer holds.
    if (cursor != null && runs.isEmpty) return null;
    final announcements = value['announcements'];
    return CachedPage(
      runs,
      before as String?,
      epoch: epoch as String?,
      cursor: cursor as String?,
      announcements: announcements is List ? List<Object?>.from(announcements) : const [],
    );
  } catch (_) {
    return null;
  }
}

String encodePageCache(
  List<Map<String, dynamic>> runs,
  String? before, {
  String? epoch,
  String? cursor,
  List<Object?> announcements = const [],
}) {
  final kept = runs.length > cachedRunLimit
      ? runs.sublist(runs.length - cachedRunLimit)
      : runs;
  return jsonEncode({
    'version': pageCacheVersion,
    'runs': kept,
    'before': before,
    if (epoch != null) 'epoch': epoch,
    if (cursor != null && kept.isNotEmpty) 'cursor': cursor,
    if (announcements.isNotEmpty) 'announcements': announcements,
  });
}

/// Never fails a caller: a transcript that could not be cached only costs the
/// next switch a blank frame. Persistence failure leaves the last durable
/// envelope in place so a reconnect replays from a matching cache.
Future<void> writePageCache(
  LocalStore store,
  String userId,
  String botId,
  List<Map<String, dynamic>> runs,
  String? before, {
  String? epoch,
  String? cursor,
  List<Object?> announcements = const [],
}) async {
  try {
    final encoded = encodePageCache(
      runs,
      before,
      epoch: epoch,
      cursor: cursor,
      announcements: announcements,
    );
    if (encoded.length > cachedPageBytes) return;
    await store.write(pageCacheKey(userId, botId), encoded);
  } catch (_) {
    /* A cache that cannot be written is not an error the User can act on. */
  }
}
