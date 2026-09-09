import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/computer/card.dart';
import 'package:frockbot_native/computer/client.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'computer_test.dart' show projection;
import 'settings_test.dart' show SettingsApi;
import 'widget_test.dart' show MemoryStore;

void main() {
  for (final landscape in [false, true]) {
    testWidgets('control indication and tap takeover, landscape=$landscape', (
      tester,
    ) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = landscape
          ? const Size(800, 400)
          : const Size(400, 800);
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      const display = MethodChannel('com.frockbot.mobile/display');
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        display,
        (_) async => null,
      );
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          display,
          null,
        ),
      );
      final controller = _ControlController();
      addTearDown(controller.dispose);
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: ComputerViewerPage(controller: controller),
        ),
      );
      await tester.pumpAndSettle();
      expect(
        find.text('Take control'),
        landscape ? findsNothing : findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('computer-control-border')),
        findsNothing,
      );

      await tester.tap(find.byKey(const ValueKey('computer-view-only-tap')));
      await tester.pump();
      expect(controller.requests, 0);
      final button = find.byKey(const ValueKey('computer-tap-take-control'));
      expect(button, findsOneWidget);
      await tester.tap(button);
      await tester.pump();
      expect(controller.requests, 1);
      expect(
        find.byKey(const ValueKey('computer-control-border')),
        findsNothing,
      );
      expect(find.text('Pausing Bot…'), findsOneWidget);

      controller.setPhase('human-control');
      await tester.pumpAndSettle();
      expect(button, findsNothing);
      expect(
        find.byKey(const ValueKey('computer-view-only-tap')),
        findsNothing,
      );
      expect(find.text('Take control'), findsNothing);
      expect(
        find.text('Release control'),
        landscape ? findsNothing : findsOneWidget,
      );
      final border = tester.widget<DecoratedBox>(
        find.byKey(const ValueKey('computer-control-border')),
      );
      expect(
        (border.decoration as BoxDecoration).border,
        Border.all(color: FrockTheme.accent, width: 3),
      );
      expect(
        find.ancestor(
          of: find.byWidget(border),
          matching: find.byWidgetPredicate(
            (widget) => widget is IgnorePointer && widget.ignoring,
          ),
        ),
        findsOneWidget,
      );

      controller.setPhase('ready');
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('computer-control-border')),
        findsNothing,
      );
      expect(button, findsNothing);
      expect(
        find.byKey(const ValueKey('computer-view-only-tap')),
        findsOneWidget,
      );
      await tester.pumpWidget(const SizedBox.shrink());
    }, variant: TargetPlatformVariant.only(TargetPlatform.android));
  }

  for (final platform in [TargetPlatform.android, TargetPlatform.macOS]) {
    testWidgets('Computer rotation lifecycle on ${platform.name}', (
      tester,
    ) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(400, 800);
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      const channel = MethodChannel('com.frockbot.mobile/display');
      final fullscreen = <bool>[];
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (
        call,
      ) async {
        fullscreen.add(call.arguments as bool);
        return null;
      });
      addTearDown(() {
        tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          channel,
          null,
        );
      });
      final controller = ComputerController(
        SettingsApi(MemoryStore(), (_, _) async => <String, Object?>{}),
        'bot-1',
      );
      addTearDown(controller.dispose);
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) => Scaffold(
              body: TextButton(
                onPressed: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) => ComputerViewerPage(controller: controller),
                  ),
                ),
                child: const Text('Open Computer'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Open Computer'));
      await tester.pumpAndSettle();
      expect(find.byType(ComputerViewerPage), findsOneWidget);
      expect(find.byType(AppBar), findsOneWidget);

      tester.view.physicalSize = const Size(800, 400);
      await tester.pumpAndSettle();
      final mobile = platform == TargetPlatform.android;
      expect(find.byType(AppBar), mobile ? findsNothing : findsOneWidget);
      expect(fullscreen, mobile ? [true] : isEmpty);
      expect(find.byType(ComputerViewerPage), findsOneWidget);

      tester.view.physicalSize = const Size(400, 800);
      await tester.pumpAndSettle();
      expect(
        find.byType(ComputerViewerPage),
        mobile ? findsNothing : findsOneWidget,
      );
      if (mobile) expect(fullscreen.last, false);
      await tester.pumpWidget(const SizedBox.shrink());
    }, variant: TargetPlatformVariant({platform}));
  }
}

class _ControlController extends ComputerController {
  int requests = 0;
  _ControlController()
    : super(
        SettingsApi(MemoryStore(), (_, _) async => <String, Object?>{}),
        'bot-1',
      ) {
    state = ComputerProjection.fromJson(projection(snapshot: false));
  }

  @override
  Future<void> takeControl() async {
    requests += 1;
    busy = true;
    takingControl = true;
    notifyListeners();
  }

  void setPhase(String phase) {
    busy = false;
    state = ComputerProjection.fromJson(
      projection(phase: phase, snapshot: false),
    );
    notifyListeners();
  }
}
