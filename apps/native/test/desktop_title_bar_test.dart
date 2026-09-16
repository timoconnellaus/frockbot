/// The Mac window's title strip: an inset every page keeps out of, and the
/// place a drag moves the window and a double-click zooms it.
library;

import 'package:flutter/foundation.dart'
    show debugDefaultTargetPlatformOverride;
import 'package:flutter/gestures.dart' show PointerDeviceKind;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/shell/desktop_layout.dart';

void main() {
  const window = MethodChannel('com.frockbot/window');

  /// A page the way the app pushes one: an `AppBar` with the way back and a
  /// control, under the app's title-bar inset.
  Widget page(VoidCallback onRefresh) => MaterialApp(
    builder: (context, child) => DesktopTitleBarPadding(child: child!),
    home: Scaffold(
      appBar: AppBar(
        leading: const BackButton(),
        title: const Text('Personal details'),
        actions: [
          IconButton(
            tooltip: 'Refresh settings',
            onPressed: onRefresh,
            icon: const Icon(Icons.refresh_rounded),
          ),
        ],
      ),
      body: const SizedBox.expand(),
    ),
  );

  List<String> listen(WidgetTester tester) {
    final calls = <String>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(window, (
      call,
    ) async {
      calls.add(call.method);
      return null;
    });
    addTearDown(
      () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        window,
        null,
      ),
    );
    return calls;
  }

  testWidgets(
    'on a Mac the strip spans the window, moves it on a drag and zooms it on a double-click',
    (tester) async {
      debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
      addTearDown(() => debugDefaultTargetPlatformOverride = null);
      final calls = listen(tester);
      var refreshed = 0;
      await tester.pumpWidget(page(() => refreshed++));
      await tester.pumpAndSettle();

      // The whole top of the window, and only that: the header's controls
      // are below it, so it takes no click meant for them.
      expect(
        tester.getRect(find.byType(DesktopTitleStrip)),
        const Rect.fromLTWH(0, 0, 800, desktopTitleBarInset),
      );
      for (final control in [
        find.byType(BackButton),
        find.text('Personal details'),
        find.byTooltip('Refresh settings'),
      ]) {
        expect(
          tester.getTopLeft(control).dy,
          greaterThanOrEqualTo(desktopTitleBarInset),
        );
      }

      // A double-click anywhere along the strip — here, over what would be
      // the middle of a page's title bar — asks the window to zoom.
      const at = Offset(400, desktopTitleBarInset / 2);
      await tester.tapAt(at);
      await tester.pump(const Duration(milliseconds: 60));
      await tester.tapAt(at);
      await tester.pumpAndSettle();
      expect(calls, ['zoom']);

      // A drag that starts on it hands the window to the pointer.
      await tester.dragFrom(
        at,
        const Offset(80, 0),
        kind: PointerDeviceKind.mouse,
      );
      await tester.pumpAndSettle();
      expect(calls, ['zoom', 'startDrag']);

      // A real control under the strip is still one click, and no window
      // gesture.
      await tester.tap(find.byTooltip('Refresh settings'));
      await tester.pumpAndSettle();
      expect(refreshed, 1);
      expect(calls, ['zoom', 'startDrag']);
    },
  );

  testWidgets('a phone has no strip and no inset', (tester) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    addTearDown(() => debugDefaultTargetPlatformOverride = null);
    final calls = listen(tester);
    var refreshed = 0;
    await tester.pumpWidget(page(() => refreshed++));
    await tester.pumpAndSettle();
    expect(find.byType(DesktopTitleStrip), findsNothing);
    expect(
      tester.getTopLeft(find.byType(BackButton)).dy,
      lessThan(desktopTitleBarInset),
    );
    await tester.tapAt(const Offset(400, desktopTitleBarInset / 2));
    await tester.pump(const Duration(milliseconds: 60));
    await tester.tapAt(const Offset(400, desktopTitleBarInset / 2));
    await tester.pumpAndSettle();
    expect(calls, isEmpty);
    await tester.tap(find.byTooltip('Refresh settings'));
    await tester.pump();
    expect(refreshed, 1);
  });
}
