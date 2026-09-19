import 'package:flutter/foundation.dart'
    show debugDefaultTargetPlatformOverride;
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/chat_controller.dart';
import 'package:frockbot_native/flock/avatar.dart';
import 'package:frockbot_native/shell/chat_header.dart';
import 'package:frockbot_native/shell/chat_icons.dart';
import 'package:frockbot_native/shell/desktop_layout.dart';
import 'package:frockbot_native/shell/semantics.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'shell_layout_test.dart' show byIdentifier;

Widget host(
  ChatHeader header, {
  bool voice = false,
  Size size = const Size(1200, 900),
  TextScaler scaler = TextScaler.noScaling,
  bool reducedMotion = false,
}) => MaterialApp(
  theme: FrockTheme.theme(Brightness.dark),
  home: MediaQuery(
    data: MediaQueryData(
      size: size,
      textScaler: scaler,
      disableAnimations: reducedMotion,
    ),
    child: Scaffold(
      appBar: voice ? header : null,
      body: voice
          ? const SizedBox.expand()
          : Stack(fit: StackFit.expand, children: [header]),
    ),
  ),
);

void main() {
  test('pixel ink at 88 is the silhouette, not the canvas', () {
    final box = characterCatalogV1['pixel']!.ink.boxForHeight(
      chatCompanionSize,
    );
    expect(box.height, chatCompanionSize);
    expect(box.width, closeTo(chatCompanionSize * 447 / 585, 0.01));
  });

  testWidgets('only slow recovery adds an accessible dot to the header name', (
    tester,
  ) async {
    Widget header(ConnectionState connection, {bool reducedMotion = false}) =>
        host(
          ChatHeader(
            name: 'Rosemary',
            connection: connection,
            onOpenBot: () {},
          ),
          reducedMotion: reducedMotion,
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
    expect(find.byType(AppBar), findsNothing);

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
  });

  testWidgets('computer turns blue when running and resets when stopped', (
    tester,
  ) async {
    for (final running in [false, true, false]) {
      await tester.pumpWidget(
        host(
          ChatHeader(
            name: 'Bot',
            computerRunning: running,
            onComputer: () {},
            onOpenBot: () {},
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
        expect(color, computerRunningColor);
      } else {
        expect(color, isNot(computerRunningColor));
      }
    }
  });

  testWidgets(
    'the panel switch is the last thing in the chrome and says which way',
    (tester) async {
      tester.view.physicalSize = const Size(1200, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      var toggles = 0;
      Widget header({required bool shown}) => host(
        ChatHeader(
          name: 'Bob',
          textScale: 1,
          onOpenBot: () {},
          onComputer: () {},
          onTogglePanel: () => toggles++,
          panelShown: shown,
        ),
      );
      await tester.pumpWidget(header(shown: true));
      await tester.pumpAndSettle();
      final toggle = byIdentifier(ShellIds.rightPanelToggle);
      expect(toggle, findsOneWidget);
      expect(find.byTooltip('Hide the panel'), findsOneWidget);
      // Rightmost: against the column it shows and hides.
      expect(
        tester.getTopRight(toggle).dx,
        greaterThan(tester.getTopRight(find.byTooltip('Computer')).dx),
      );
      await tester.tap(find.byTooltip('Hide the panel'));
      expect(toggles, 1);
      await tester.pumpWidget(header(shown: false));
      await tester.pumpAndSettle();
      expect(find.byTooltip('Show the panel'), findsOneWidget);
    },
  );

  testWidgets(
    'the overlay fades the thread and puts three pills on the right',
    (tester) async {
      tester.view.physicalSize = const Size(1200, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        host(
          ChatHeader(
            name: 'Pixel',
            onOpenBot: () {},
            onComputer: () {},
            onTogglePanel: () {},
            companion: CharacterAvatar(
              size: chatCompanionSize,
              cropToInk: true,
              characterId: 'pixel',
              motion: CharacterMotion.still,
              semanticsLabel: 'Bot is ready',
            ),
          ),
        ),
      );
      await tester.pump();
      expect(find.byKey(const ValueKey('chat-header-fade')), findsOneWidget);
      expect(
        tester.getSize(find.byKey(const ValueKey('chat-header-fade'))).height,
        chatHeaderFadeHeight,
      );
      final companion = find.bySemanticsLabel('Bot is ready');
      expect(tester.getTopLeft(companion).dy, chatHeaderChromeTop);
      expect(tester.getTopLeft(companion).dx, chatHeaderChromeSide);
      expect(tester.getSize(companion).height, chatCompanionSize);
      expect(
        tester.getTopLeft(find.byTooltip('Open Pixel')).dx,
        greaterThan(tester.getTopRight(companion).dx),
      );
      expect(
        tester.getTopRight(find.byTooltip('Show the panel')).dx,
        closeTo(1200 - chatHeaderChromeSide, 0.5),
      );
      expect(
        tester.getTopLeft(find.byTooltip('Open Pixel')).dy,
        chatHeaderChromeTop,
      );
      expect(find.byType(AppBar), findsNothing);
    },
  );

  for (final width in [320.0, 390.0]) {
    for (final scale in [0.85, 1.0, 2.0, 3.0]) {
      testWidgets(
        'three things in the chrome at $width px and ${scale}x text',
        (tester) async {
          tester.view.physicalSize = Size(width, 900);
          tester.view.devicePixelRatio = 1;
          addTearDown(tester.view.resetPhysicalSize);
          addTearDown(tester.view.resetDevicePixelRatio);
          final opened = <String>[];
          await tester.pumpWidget(
            host(
              ChatHeader(
                name: 'My very long research assistant',
                textScale: scale,
                connection: ConnectionState.reconnecting,
                onOpenBot: () => opened.add('Bot'),
                onComputer: () => opened.add('Computer'),
                onTogglePanel: () => opened.add('Panel'),
              ),
              size: Size(width, 900),
              scaler: TextScaler.linear(scale),
            ),
          );
          await tester.pumpAndSettle();
          expect(tester.takeException(), isNull);
          await tester.tap(byIdentifier(ShellIds.botPanelToggle));
          await tester.tap(byIdentifier(ShellIds.computerToggle));
          await tester.tap(byIdentifier(ShellIds.rightPanelToggle));
          expect(opened, ['Bot', 'Computer', 'Panel']);
          expect(find.byType(AppBar), findsNothing);
          expect(find.byTooltip('Routines'), findsNothing);
          expect(find.byTooltip('Plugins'), findsNothing);
          expect(find.byTooltip('Bot settings'), findsNothing);
          expect(find.byTooltip('Applets'), findsNothing);
          expect(find.byType(PopupMenuButton<String>), findsNothing);
        },
      );
    }
  }

  for (final scale in [1.0, 2.0]) {
    testWidgets(
      'on a phone the chrome is Back, the Bot, and the Computer at ${scale}x',
      (tester) async {
        tester.view.physicalSize = const Size(390, 900);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final opened = <String>[];
        await tester.pumpWidget(
          host(
            ChatHeader(
              name: 'My very long research assistant',
              textScale: scale,
              phone: true,
              onBack: () => opened.add('Bots'),
              onOpenBot: () => opened.add('Bot'),
              onComputer: () => opened.add('Computer'),
            ),
            size: const Size(390, 900),
            scaler: TextScaler.linear(scale),
          ),
        );
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
        expect(find.byTooltip('Routines'), findsNothing);
        expect(find.byTooltip('Applets'), findsNothing);
        expect(byIdentifier(ShellIds.botPanelToggle), findsOneWidget);
        await tester.tap(byIdentifier(ShellIds.sidebarToggle));
        await tester.tap(byIdentifier(ShellIds.botPanelToggle));
        await tester.tap(byIdentifier(ShellIds.computerToggle));
        expect(opened, ['Bots', 'Bot', 'Computer']);
        expect(
          tester.getTopLeft(byIdentifier(ShellIds.sidebarToggle)).dy,
          chatHeaderChromeTop,
        );
        expect(
          tester
              .getTopLeft(
                find.byTooltip('Open My very long research assistant'),
              )
              .dy,
          chatHeaderChromeTop,
        );
      },
    );
  }

  testWidgets('the name is the one door, and it is named for the Bot', (
    tester,
  ) async {
    var opened = 0;
    await tester.pumpWidget(
      host(ChatHeader(name: 'Rosemary', onOpenBot: () => opened += 1)),
    );
    await tester.pump();
    expect(find.byTooltip('Open Rosemary'), findsOneWidget);
    await tester.tap(byIdentifier(ShellIds.botPanelToggle));
    expect(opened, 1);
  });

  testWidgets(
    'on a Mac a full-window call header sits past the traffic lights',
    (tester) async {
      debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
      try {
        await tester.pumpWidget(
          host(const ChatHeader(name: 'Bob', voiceMode: true), voice: true),
        );
        await tester.pump();
        expect(
          tester.getTopLeft(find.text('Bob')).dx,
          greaterThanOrEqualTo(desktopTrafficLightLeading),
        );
        expect(
          tester.getTopLeft(byIdentifier(VoiceIds.headerPill)).dx,
          greaterThan(desktopTrafficLightLeading),
        );
        expect(
          tester.getTopLeft(find.text('Bob')).dy,
          lessThan(desktopTitleBarBand),
        );
      } finally {
        debugDefaultTargetPlatformOverride = null;
      }
    },
  );

  testWidgets('a call header on a phone stays at the left', (tester) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    try {
      await tester.pumpWidget(
        host(const ChatHeader(name: 'Bob', voiceMode: true), voice: true),
      );
      await tester.pump();
      expect(tester.getTopLeft(find.text('Bob')).dx, 14);
    } finally {
      debugDefaultTargetPlatformOverride = null;
    }
  });

  testWidgets(
    'a Mac conversation next to the list does not grow a traffic-light inset',
    (tester) async {
      debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
      try {
        await tester.pumpWidget(
          host(ChatHeader(name: 'Bob', onOpenBot: () {})),
        );
        await tester.pump();
        expect(
          tester.getTopLeft(find.byTooltip('Open Bob')).dy,
          chatHeaderChromeTop,
        );
        expect(
          tester.getTopLeft(find.byTooltip('Open Bob')).dy,
          lessThan(desktopTitleBarBand),
        );
      } finally {
        debugDefaultTargetPlatformOverride = null;
      }
    },
  );

  testWidgets(
    'on a Mac a phone conversation header sits below the traffic lights',
    (tester) async {
      debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
      try {
        await tester.pumpWidget(
          host(
            ChatHeader(
              name: 'Bob',
              phone: true,
              onBack: () {},
              onOpenBot: () {},
            ),
          ),
        );
        await tester.pump();
        expect(
          tester.getTopLeft(byIdentifier(ShellIds.sidebarToggle)).dy,
          chatHeaderChromeTop + desktopTitleBarBand,
        );
        expect(
          tester.getTopLeft(byIdentifier(ShellIds.sidebarToggle)).dx,
          chatHeaderChromeSide,
        );
        expect(
          tester.getTopLeft(byIdentifier(ShellIds.sidebarToggle)).dx,
          lessThan(desktopTrafficLightLeading),
        );
      } finally {
        debugDefaultTargetPlatformOverride = null;
      }
    },
  );

  testWidgets('the name is a frosted pill on a phone and at a desk', (
    tester,
  ) async {
    Widget header({required bool phone}) =>
        host(ChatHeader(name: 'Rosemary', phone: phone, onOpenBot: () {}));
    Color? fill() {
      final material = tester.widget<Material>(
        find
            .descendant(
              of: find.byTooltip('Open Rosemary'),
              matching: find.byType(Material),
            )
            .first,
      );
      return material.color;
    }

    await tester.pumpWidget(header(phone: true));
    await tester.pump();
    expect(fill(), isNot(Colors.transparent));
    expect(fill()!.a, lessThan(1));

    await tester.pumpWidget(header(phone: false));
    await tester.pump();
    expect(fill(), isNot(Colors.transparent));
    expect(fill()!.a, lessThan(1));
  });
}
