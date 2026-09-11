import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/chat_controller.dart';
import 'package:frockbot_native/shell/chat_header.dart';
import 'package:frockbot_native/shell/chat_icons.dart';
import 'package:frockbot_native/shell/semantics.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'shell_layout_test.dart' show byIdentifier;

void main() {
  testWidgets(
    'only slow recovery adds an accessible dot to the fixed header avatar',
    (tester) async {
      Widget header(ConnectionState connection, {bool reducedMotion = false}) =>
          MaterialApp(
            theme: FrockTheme.theme(Brightness.dark),
            home: MediaQuery(
              data: MediaQueryData(disableAnimations: reducedMotion),
              child: Scaffold(
                appBar: ChatHeader(
                  name: 'Rosemary',
                  connection: connection,
                  onSettings: () {},
                  onRoutines: () {},
                ),
              ),
            ),
          );

      await tester.pumpWidget(header(ConnectionState.initializing));
      await tester.pump(const Duration(seconds: 2));
      expect(find.byTooltip('Updating conversation'), findsNothing);

      await tester.pumpWidget(header(ConnectionState.reconnecting));
      expect(find.byTooltip('Updating conversation'), findsNothing);
      await tester.pump(const Duration(milliseconds: 1499));
      expect(find.byTooltip('Updating conversation'), findsNothing);
      await tester.pump(const Duration(milliseconds: 1));
      expect(find.byTooltip('Updating conversation'), findsOneWidget);
      expect(find.bySemanticsLabel('Updating conversation'), findsOneWidget);
      expect(find.byKey(const ValueKey('conversation-update')), findsOneWidget);
      expect(find.text('Updating'), findsNothing);
      expect(find.byType(MaterialBanner), findsNothing);
      expect(
        tester.widget<AppBar>(find.byType(AppBar)).preferredSize.height,
        56,
      );

      await tester.pumpWidget(header(ConnectionState.connected));
      expect(find.byTooltip('Updating conversation'), findsNothing);
      expect(find.byKey(const ValueKey('conversation-update')), findsNothing);

      await tester.pumpWidget(
        header(ConnectionState.reconnecting, reducedMotion: true),
      );
      await tester.pump(const Duration(milliseconds: 1500));
      final fade = tester.widget<FadeTransition>(
        find.byKey(const ValueKey('conversation-update')),
      );
      expect(fade.opacity.value, 1);
      await tester.pump(const Duration(milliseconds: 550));
      expect(fade.opacity.value, 1);

      await tester.pumpWidget(const SizedBox());
    },
  );

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
                    connection: ConnectionState.reconnecting,
                    onSettings: () => opened.add('Settings'),
                    onComputer: () => opened.add('Computer'),
                    onRoutines: () => opened.add('Routines'),
                    onApplets: () => opened.add('Applet'),
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
          expect(byIdentifier(AppletIds.chip), findsOneWidget);
          await tester.tap(find.byTooltip('Applets'));
          expect(opened, ['Settings', 'Computer', 'Routines', 'Applet']);
          expect(tester.widget<AppBar>(find.byType(AppBar)).bottom, isNull);
          expect(
            tester.getCenter(find.byTooltip('Applets')).dx,
            lessThan(tester.getCenter(find.byTooltip('Computer')).dx),
          );
          expect(
            tester.getCenter(find.byTooltip('Computer')).dy,
            tester.getCenter(find.byTooltip('Bot settings')).dy,
          );
          expect(find.byType(PopupMenuButton<String>), findsNothing);
        },
      );
    }
  }

  for (final scale in [1.0, 2.0]) {
    testWidgets('on a phone the bar is Back, the Bot, and the Computer at ${scale}x', (
      tester,
    ) async {
      // GrokBot's bar: three things. Routines, Applets and the Package pages
      // are rows on the Bot's page, reached from its name.
      tester.view.physicalSize = const Size(390, 900);
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
                onBack: () => opened.add('Bots'),
                onOpenBot: () => opened.add('Bot'),
                onComputer: () => opened.add('Computer'),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      expect(find.byTooltip('Routines'), findsNothing);
      expect(find.byTooltip('Applets'), findsNothing);
      expect(byIdentifier(ShellIds.botPanelToggle), findsOneWidget);
      await tester.tap(byIdentifier(ShellIds.sidebarToggle));
      await tester.tap(byIdentifier(ShellIds.botPanelToggle));
      await tester.tap(find.byTooltip('Computer'));
      expect(opened, ['Bots', 'Bot', 'Computer']);
      // The pill is what carries the name: one tap target, not two.
      expect(find.byTooltip('Bot settings'), findsOneWidget);
    });
  }
}
