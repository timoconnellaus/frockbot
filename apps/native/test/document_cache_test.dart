import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/document_cache.dart';
import 'package:frockbot_native/protocol/client_wire.generated.dart' as wire;

import 'native_session.dart' show NativeSessionApi;
import 'widget_test.dart' show MemoryStore;

Map<String, Object?> listDocument({
  String surfaceId = 'routines',
  int revision = 1,
  String title = 'Morning brief',
}) => {
  'schemaVersion': 1,
  'surfaceId': surfaceId,
  'revision': revision,
  'root': {
    'type': 'group',
    'orientation': 'column',
    'children': [
      {
        'type': 'group',
        'orientation': 'column',
        'title': title,
        'children': [
          {'type': 'text', 'text': title},
        ],
      },
    ],
  },
  'actions': <Object>[],
};

void main() {
  setUp(clearViewDocumentCacheMemory);

  test('a list document round-trips and a wrong version is discarded', () {
    final document = wire.ViewDocument.fromJson(listDocument());
    final encoded = encodeViewDocumentCache(document);
    expect(decodeViewDocumentCache(encoded)?.revision, 1);
    expect(decodeViewDocumentCache(encoded)?.surfaceId.value, 'routines');
    expect(decodeViewDocumentCache(null), isNull);
    expect(decodeViewDocumentCache('{"version":0,"document":{}}'), isNull);
    expect(decodeViewDocumentCache('not-json'), isNull);
  });

  test('a write that fails is silence, and a good write can be read', () async {
    final store = MemoryStore();
    final document = wire.ViewDocument.fromJson(listDocument());
    store.fail = true;
    await writeViewDocumentCache(store, 'tim', 'routines', 'bot-1', document);
    expect(store.values, isEmpty);
    expect(peekViewDocumentCache('tim', 'routines', 'bot-1')?.revision, 1);

    store.fail = false;
    await writeViewDocumentCache(store, 'tim', 'routines', 'bot-1', document);
    final read = await readViewDocumentCache(store, 'tim', 'routines', 'bot-1');
    expect(read?.revision, 1);
    expect(read?.surfaceId.value, 'routines');
  });

  test('prefetch writes a matching surface and ignores a mismatch', () async {
    final store = MemoryStore();
    await prefetchViewDocumentCache(
      api: NativeSessionApi(store, (path, _) async {
        expect(path, '/api/bots/bot-1/routines?as=document');
        return listDocument(title: 'Prefetched');
      }),
      store: store,
      userId: 'tim',
      surfaceId: 'routines',
      scope: 'bot-1',
      path: '/api/bots/bot-1/routines?as=document',
    );
    expect(
      (await readViewDocumentCache(
        store,
        'tim',
        'routines',
        'bot-1',
      ))?.root.toJson().toString(),
      contains('Prefetched'),
    );

    await prefetchViewDocumentCache(
      api: NativeSessionApi(
        store,
        (_, _) async => listDocument(surfaceId: 'plugins'),
      ),
      store: store,
      userId: 'tim',
      surfaceId: 'routines',
      scope: 'bot-1',
      path: '/ignored',
    );
    expect(
      (await readViewDocumentCache(
        store,
        'tim',
        'routines',
        'bot-1',
      ))?.surfaceId.value,
      'routines',
    );
  });
}
