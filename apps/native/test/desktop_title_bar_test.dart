/// The Mac window's existing header is the title bar: no extra row sits above
/// it, and dragging the header moves the window.
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

  /// A page the way the app pushes one: an `AppBar` that is also its title
  /// bar, with the way back and a control on its one top row.
  Widget page(VoidCallback onRefresh) => MaterialApp(
    home: Scaffold(
      appBar: DesktopHeader(
        child: AppBar(
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
    'on a Mac the existing header sits below the traffic lights and moves the window on drag',
    (tester) async {
      debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
      try {
        final calls = listen(tester);
        var refreshed = 0;
        await tester.pumpWidget(page(() => refreshed++));
        await tester.pumpAndSettle();

        expect(find.byType(DesktopWindowDragRegion), findsOneWidget);
        // Extra top space, same surface: the bar is not a second row and it
        // does not grow a border above itself.
        expect(find.byType(Divider), findsNothing);
        for (final control in [
          find.byType(BackButton),
          find.text('Personal details'),
          find.byTooltip('Refresh settings'),
        ]) {
          expect(
            tester.getTopLeft(control).dy,
            greaterThanOrEqualTo(desktopTitleBarBand),
          );
          expect(
            tester.getTopLeft(control).dy,
            lessThan(kToolbarHeight + desktopTitleBarBand),
          );
        }
        // The bar is not inset past the lights: the way back is still at the
        // leading edge. The title sits after it, so its own x is not the test.
        expect(
          tester.getTopLeft(find.byType(BackButton)).dx,
          lessThan(desktopTrafficLightLeading),
        );

        // A drag on the unused centre of the one visible header hands the window
        // to the pointer, without a separate title strip.
        const at = Offset(400, desktopTitleBarBand + kToolbarHeight / 2);
        await tester.dragFrom(
          at,
          const Offset(80, 0),
          kind: PointerDeviceKind.mouse,
        );
        await tester.pumpAndSettle();
        expect(calls, ['startDrag']);

        // A real control in the same row still receives a click.
        await tester.tap(find.byTooltip('Refresh settings'));
        await tester.pumpAndSettle();
        expect(refreshed, 1);
        expect(calls, ['startDrag']);
      } finally {
        debugDefaultTargetPlatformOverride = null;
      }
    },
  );

  testWidgets('a phone leaves its header untouched', (tester) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    final calls = listen(tester);
    var refreshed = 0;
    await tester.pumpWidget(page(() => refreshed++));
    await tester.pumpAndSettle();
    expect(
      tester.getTopLeft(find.byType(BackButton)).dy,
      lessThan(kToolbarHeight),
    );
    await tester.dragFrom(
      const Offset(400, kToolbarHeight / 2),
      const Offset(80, 0),
      kind: PointerDeviceKind.mouse,
    );
    await tester.pumpAndSettle();
    expect(calls, isEmpty);
    await tester.tap(find.byTooltip('Refresh settings'));
    await tester.pump();
    expect(refreshed, 1);
    debugDefaultTargetPlatformOverride = null;
  });

  testWidgets(
    'on a Mac a pushed page header sits below the traffic lights, not past them',
    (tester) async {
      debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
      try {
        await tester.pumpWidget(
          MaterialApp(
            home: Builder(
              builder: (context) => TextButton(
                onPressed: () => Navigator.of(context).push<void>(
                  MaterialPageRoute(
                    builder: (_) => Scaffold(
                      appBar: DesktopHeader(
                        child: AppBar(title: const Text('Settings')),
                      ),
                      body: const SizedBox.expand(),
                    ),
                  ),
                ),
                child: const Text('Open'),
              ),
            ),
          ),
        );
        await tester.tap(find.text('Open'));
        await tester.pumpAndSettle();
        expect(
          tester.getTopLeft(find.byType(BackButton)).dy,
          greaterThanOrEqualTo(desktopTitleBarBand),
        );
        expect(
          tester.getTopLeft(find.text('Settings')).dy,
          greaterThanOrEqualTo(desktopTitleBarBand),
        );
        expect(
          tester.getTopLeft(find.byType(BackButton)).dx,
          lessThan(desktopTrafficLightLeading),
        );
        expect(find.byType(Divider), findsNothing);
      } finally {
        debugDefaultTargetPlatformOverride = null;
      }
    },
  );
}
