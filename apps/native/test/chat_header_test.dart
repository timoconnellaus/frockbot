import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/shell/chat_header.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

void main() {
  for (final width in [320.0, 390.0]) {
    for (final scale in [1.0, 2.0]) {
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
                    onApplets: () => opened.add('Applets'),
                  ),
                ),
              ),
            ),
          );
          await tester.pumpAndSettle();
          expect(tester.takeException(), isNull);
          await tester.tap(find.byTooltip('Bot settings'));
          for (final name in ['Computer', 'Routines', 'Applets']) {
            await tester.tap(find.text(name));
          }
          expect(opened, ['Settings', 'Computer', 'Routines', 'Applets']);
          expect(find.byType(PopupMenuButton<String>), findsNothing);
        },
      );
    }
  }
}
