import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../protocol/client_wire.generated.dart' as wire;
import 'transport.dart';

/// The last `ViewDocument` seen for one surface, kept so a door paints before
/// the network answers. It is a cache, never a source of truth: the next
/// projection replaces it wholesale, and a shape this build cannot read is
/// discarded rather than shown.
///
/// Memory is what a remount paints from in the tap frame. Disk is what a
/// later process finds.
String viewDocumentCacheKey(String userId, String surfaceId, String scope) =>
    'view/$userId/$surfaceId/$scope';

/// Beyond this the cache costs more to write than the blank frame it saves.
const viewDocumentCacheBytes = 256000;

/// The cached projection's envelope. Bumped when a document this build cannot
/// read wholesale could otherwise be painted.
const viewDocumentCacheVersion = 1;

final Map<String, wire.ViewDocument> _memory = {};

/// Last known document still in this process. Null if this process has not
/// seen one — [readViewDocumentCache] then asks the disk.
wire.ViewDocument? peekViewDocumentCache(
  String userId,
  String surfaceId,
  String scope,
) => _memory[viewDocumentCacheKey(userId, surfaceId, scope)];

@visibleForTesting
void clearViewDocumentCacheMemory() => _memory.clear();

wire.ViewDocument? decodeViewDocumentCache(String? saved) {
  if (saved == null) return null;
  try {
    final value = jsonDecode(saved);
    if (value is! Map || value['version'] != viewDocumentCacheVersion) {
      return null;
    }
    final document = value['document'];
    if (document is! Map) return null;
    return wire.ViewDocument.fromJson(document);
  } catch (_) {
    return null;
  }
}

String encodeViewDocumentCache(wire.ViewDocument document) => jsonEncode({
  'version': viewDocumentCacheVersion,
  'document': document.toJson(),
});

/// Never fails a caller: a document that could not be cached only costs the
/// next open a blank frame.
Future<void> writeViewDocumentCache(
  LocalStore store,
  String userId,
  String surfaceId,
  String scope,
  wire.ViewDocument document,
) async {
  try {
    final encoded = encodeViewDocumentCache(document);
    if (encoded.length > viewDocumentCacheBytes) return;
    _memory[viewDocumentCacheKey(userId, surfaceId, scope)] = document;
    await store.write(viewDocumentCacheKey(userId, surfaceId, scope), encoded);
  } catch (_) {
    /* A cache that cannot be written is not an error the User can act on. */
  }
}

Future<wire.ViewDocument?> readViewDocumentCache(
  LocalStore store,
  String userId,
  String surfaceId,
  String scope,
) async {
  final key = viewDocumentCacheKey(userId, surfaceId, scope);
  final remembered = _memory[key];
  if (remembered != null) return remembered;
  try {
    final cached = decodeViewDocumentCache(await store.read(key));
    if (cached != null) _memory[key] = cached;
    return cached;
  } catch (_) {
    return null;
  }
}

/// Fills the cache so a later open can paint. A failure is silence: prefetch
/// is never why a surface cannot open.
Future<void> prefetchViewDocumentCache({
  required NativeApi api,
  required LocalStore store,
  required String userId,
  required String surfaceId,
  required String scope,
  required String path,
}) async {
  try {
    final next = wire.ViewDocument.fromJson(await api.request(path));
    if (next.surfaceId.value != surfaceId) return;
    await writeViewDocumentCache(store, userId, surfaceId, scope, next);
  } catch (_) {
    /* A warm that missed is not a broken door. */
  }
}
