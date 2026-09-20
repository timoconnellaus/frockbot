import 'dart:convert';

import '../protocol/client_wire.generated.dart' as wire;
import 'transport.dart';

/// The last `ViewDocument` seen for one surface, kept so a door paints before
/// the network answers. It is a cache, never a source of truth: the next
/// projection replaces it wholesale, and a shape this build cannot read is
/// discarded rather than shown.
String viewDocumentCacheKey(String userId, String surfaceId, String scope) =>
    'view/$userId/$surfaceId/$scope';

/// Beyond this the cache costs more to write than the blank frame it saves.
const viewDocumentCacheBytes = 256000;

/// The cached projection's envelope. Bumped when a document this build cannot
/// read wholesale could otherwise be painted.
const viewDocumentCacheVersion = 1;

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
  try {
    return decodeViewDocumentCache(
      await store.read(viewDocumentCacheKey(userId, surfaceId, scope)),
    );
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
