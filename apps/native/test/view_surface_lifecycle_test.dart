import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/document_cache.dart';
import 'package:frockbot_native/protocol/client_wire.generated.dart' as wire;
import 'package:frockbot_native/theme/states.dart';
import 'package:frockbot_native/view/surface.dart';

import 'document_cache_test.dart' show listDocument;
import 'widget_test.dart' show MemoryStore;

class _TrackedSurfaceController extends ViewSurfaceController {
  final Set<VoidCallback> listeners = {};
  int loads = 0;
  int disposals = 0;
  Completer<void>? gate;
  wire.ViewDocument? _document;

  @override
  void adoptCachedDocument(wire.ViewDocument cached) {
    _document = cached;
    notifyListeners();
  }

  @override
  wire.ViewDocument? get document => _document;

  @override
  bool get busy => gate != null && !gate!.isCompleted;

  @override
  String? get message => null;

  @override
  String get surfaceId => 'tracked';

  @override
  void addListener(VoidCallback listener) {
    listeners.add(listener);
    super.addListener(listener);
  }

  @override
  void removeListener(VoidCallback listener) {
    listeners.remove(listener);
    super.removeListener(listener);
  }

  @override
  Future<void> load() async {
    loads += 1;
    notifyListeners();
    final held = gate;
    if (held != null) await held.future;
    _document = wire.ViewDocument.fromJson(
      listDocument(
        surfaceId: 'tracked',
        title: 'From the network',
        revision: (_document?.revision ?? 0) + 1,
      ),
    );
    notifyListeners();
  }

  @override
  Future<Map<String, Object?>> dispatch(Map<String, Object?> command) async => {
    'commandId': command['commandId'],
    'status': 'applied',
  };

  @override
  void dispose() {
    disposals += 1;
    super.dispose();
  }
}

Widget _surface(
  _TrackedSurfaceController controller, {
  MemoryStore? store,
  String? cacheScope,
  WidgetBuilder? banner,
}) => MaterialApp(
  home: ViewSurfacePage(
    title: 'Tracked',
    controller: controller,
    store: store ?? MemoryStore(),
    userId: 'tim',
    documentId: 'tracked-document',
    refreshId: 'tracked-refresh',
    cacheScope: cacheScope,
    banner: banner,
  ),
);

void main() {
  setUp(clearViewDocumentCacheMemory);

  testWidgets(
    'a surface transfers its listener without taking controller ownership',
    (tester) async {
      final first = _TrackedSurfaceController();
      final second = _TrackedSurfaceController();

      await tester.pumpWidget(_surface(first));
      expect(first.loads, 1);
      expect(first.listeners, hasLength(1));

      await tester.pumpWidget(_surface(second));
      expect(first.listeners, isEmpty);
      expect(first.disposals, 0);
      expect(second.loads, 1);
      expect(second.listeners, hasLength(1));

      await tester.pumpWidget(const SizedBox.shrink());
      expect(second.listeners, isEmpty);
      expect(second.disposals, 0);

      first.dispose();
      second.dispose();
      expect(first.disposals, 1);
      expect(second.disposals, 1);
    },
  );

  testWidgets('a cached list paints before the network answers', (
    tester,
  ) async {
    final store = MemoryStore();
    await writeViewDocumentCache(
      store,
      'tim',
      'tracked',
      'bot-1',
      wire.ViewDocument.fromJson(
        listDocument(surfaceId: 'tracked', title: 'Last known'),
      ),
    );
    final controller = _TrackedSurfaceController()..gate = Completer<void>();
    await tester.pumpWidget(
      _surface(controller, store: store, cacheScope: 'bot-1'),
    );
    expect(find.text('Last known'), findsWidgets);
    expect(find.byType(LinearProgressIndicator), findsOneWidget);
    expect(find.text('From the network'), findsNothing);
    controller.gate!.complete();
    await tester.pumpAndSettle();
    expect(find.text('From the network'), findsWidgets);
    controller.dispose();
  });

  testWidgets('chrome stays up while the first read is out', (tester) async {
    final controller = _TrackedSurfaceController()..gate = Completer<void>();
    await tester.pumpWidget(
      _surface(
        controller,
        banner: (_) =>
            const FilledButton(onPressed: null, child: Text('New Routine')),
      ),
    );
    await tester.pump();
    expect(find.text('New Routine'), findsOneWidget);
    expect(find.byType(FrockLoading), findsOneWidget);
    controller.gate!.complete();
    await tester.pumpAndSettle();
    expect(find.text('New Routine'), findsOneWidget);
    expect(find.text('From the network'), findsWidgets);
    controller.dispose();
  });

  testWidgets('a bad cache is discarded and the host waits on the live read', (
    tester,
  ) async {
    final store = MemoryStore();
    store.values[viewDocumentCacheKey('tim', 'tracked', 'bot-1')] =
        '{"version":0,"document":{}}';
    final controller = _TrackedSurfaceController()..gate = Completer<void>();
    await tester.pumpWidget(
      _surface(controller, store: store, cacheScope: 'bot-1'),
    );
    await tester.pump();
    await tester.pump();
    expect(find.text('Last known'), findsNothing);
    expect(find.byType(FrockLoading), findsOneWidget);
    controller.gate!.complete();
    await tester.pumpAndSettle();
    expect(find.text('From the network'), findsWidgets);
    controller.dispose();
  });
}
