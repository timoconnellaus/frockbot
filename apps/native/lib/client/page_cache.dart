import 'dart:convert';

import 'transport.dart';

/// The last transcript page seen for a Bot, kept so that switching to it paints
/// its messages before the network answers. It is a cache, never a source of
/// truth: the next projection replaces it wholesale.
String pageCacheKey(String userId, String botId) => 'page/$userId/$botId';

/// Beyond this the cache costs more to write than the blank frame it saves.
const cachedRunLimit = 40;
const cachedPageBytes = 256000;

class CachedPage {
  final List<Map<String, dynamic>> runs;
  final String? before;
  const CachedPage(this.runs, this.before);
}

/// Decodes a cache written by this or an earlier released shape; anything else
/// is discarded rather than shown.
CachedPage? decodePageCache(String? saved) {
  if (saved == null) return null;
  try {
    final value = jsonDecode(saved);
    if (value is! Map || value['version'] != 1) return null;
    final runs = <Map<String, dynamic>>[];
    for (final run in value['runs'] as List) {
      final row = Map<String, dynamic>.from(run as Map);
      if (row['runId'] is! String || row['admittedAt'] is! String) return null;
      runs.add(row);
    }
    final before = value['before'];
    if (before != null && before is! String) return null;
    return CachedPage(runs, before as String?);
  } catch (_) {
    return null;
  }
}

String encodePageCache(List<Map<String, dynamic>> runs, String? before) {
  final kept = runs.length > cachedRunLimit
      ? runs.sublist(runs.length - cachedRunLimit)
      : runs;
  return jsonEncode({'version': 1, 'runs': kept, 'before': before});
}

/// Never fails a caller: a transcript that could not be cached only costs the
/// next switch a blank frame.
Future<void> writePageCache(
  LocalStore store,
  String userId,
  String botId,
  List<Map<String, dynamic>> runs,
  String? before,
) async {
  try {
    final encoded = encodePageCache(runs, before);
    if (encoded.length > cachedPageBytes) return;
    await store.write(pageCacheKey(userId, botId), encoded);
  } catch (_) {
    /* A cache that cannot be written is not an error the User can act on. */
  }
}
