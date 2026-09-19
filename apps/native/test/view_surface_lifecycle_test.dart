import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/protocol/client_wire.generated.dart' as wire;
import 'package:frockbot_native/view/surface.dart';

import 'widget_test.dart' show MemoryStore;

class _TrackedSurfaceController extends ViewSurfaceController {
  final Set<VoidCallback> listeners = {};
  int loads = 0;
  int disposals = 0;

  @override
  wire.ViewDocument? get document => null;

  @override
  bool get busy => false;

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

Widget _surface(_TrackedSurfaceController controller) => MaterialApp(
  home: ViewSurfacePage(
    title: 'Tracked',
    controller: controller,
    store: MemoryStore(),
    userId: 'tim',
    documentId: 'tracked-document',
    refreshId: 'tracked-refresh',
  ),
);

void main() {
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
}
