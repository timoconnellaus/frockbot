import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/shell/chat_header.dart';
import 'package:frockbot_native/shell/chat_icons.dart';
import 'package:frockbot_native/shell/semantics.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'shell_layout_test.dart' show byIdentifier;

void main() {
  testWidgets('computer turns blue when running and resets when stopped', (
    tester,
  ) async {
    for (final running in [false, true, false]) {
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: Scaffold(
            appBar: ChatHeader(
              name: 'Bot',
              computerRunning: running,
              onComputer: () {},
              onSettings: () {},
              onRoutines: () {},
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      final icon = find.descendant(
        of: find.byTooltip('Computer'),
        matching: find.byType(ChatIcon),
      );
      final color = IconTheme.of(tester.element(icon)).color;
      if (running) {
        expect(color, Colors.blue);
      } else {
        expect(color, isNot(Colors.blue));
      }
    }
  });

  testWidgets(
    'empty directory takes no row; directory failure stays repairable',
    (tester) async {
      Future<void> show({VoidCallback? retry}) => tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            appBar: ChatHeader(
              name: 'Frock',
              onSettings: () {},
              onRoutines: () {},
              onRetryApplets: retry,
            ),
          ),
        ),
      );
      await show();
      expect(tester.widget<AppBar>(find.byType(AppBar)).bottom, isNull);
      var retried = false;
      await show(retry: () => retried = true);
      await tester.tap(find.text('Couldn’t load Applets · Retry'));
      expect(retried, isTrue);
    },
  );

  for (final width in [320.0, 390.0]) {
    for (final scale in [0.85, 1.0, 2.0, 3.0]) {
      testWidgets(
        'direct header destinations at $width px and ${scale}x text',
        (tester) async {
          tester.view.physicalSize = Size(width, 900);
          tester.view.devicePixelRatio = 1;
          addTearDown(tester.view.resetPhysicalSize);
          addTearDown(tester.view.resetDevicePixelRatio);
          final opened = <String>[];
          await tester.pumpWidget(
            MaterialApp(
              theme: FrockTheme.theme(Brightness.dark),
              home: MediaQuery(
                data: MediaQueryData(textScaler: TextScaler.linear(scale)),
                child: Scaffold(
                  appBar: ChatHeader(
                    name: 'My very long research assistant',
                    textScale: scale,
                    onBots: () => opened.add('Bots'),
                    onSettings: () => opened.add('Settings'),
                    onComputer: () => opened.add('Computer'),
                    onRoutines: () => opened.add('Routines'),
                    applets: [
                      (
                        label: 'Project notes with a long name',
                        onOpen: () => opened.add('Applet'),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          );
          await tester.pumpAndSettle();
          expect(tester.takeException(), isNull);
          await tester.tap(find.byTooltip('Bot settings'));
          for (final name in ['Computer', 'Routines']) {
            await tester.tap(find.byTooltip(name));
          }
          // The Applet strip is the header's named entry to the canvas, which
          // is the gesture the Applet specs make at every width.
          expect(byIdentifier(AppletIds.chip), findsOneWidget);
          await tester.tap(find.text('Project notes with a long name'));
          expect(opened, ['Settings', 'Computer', 'Routines', 'Applet']);
          expect(find.text('Applets'), findsNothing);
          expect(
            tester.getCenter(find.byTooltip('Computer')).dy,
            tester.getCenter(find.byTooltip('Bot settings')).dy,
          );
          expect(find.byType(PopupMenuButton<String>), findsNothing);
        },
      );
    }
  }
}
