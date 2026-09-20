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
    'the Computer destination keeps one browser identifier in every header',
    (tester) async {
      final opened = <String>[];
      for (final (phone, voice) in [
        (false, false),
        (true, false),
        (false, true),
      ]) {
        await tester.pumpWidget(
          host(
            ChatHeader(
              name: 'Bot',
              phone: phone,
              voiceMode: voice,
              onComputer: () => opened.add('$phone:$voice'),
            ),
            voice: voice,
            size: phone ? const Size(390, 900) : const Size(1200, 900),
          ),
        );
        await tester.pump();

        final computer = byIdentifier(ShellIds.computerDestination);
        expect(computer, findsOneWidget);
        expect(
          tester.getSemantics(computer).identifier,
          ShellIds.computerDestination,
        );
        expect(find.byTooltip('Computer'), findsOneWidget);
        await tester.tap(computer);
      }

      expect(opened, ['false:false', 'true:false', 'false:true']);
    },
  );

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
          onTogglePanel: () => toggles++,
          panelShown: shown,
        ),
      );
      await tester.pumpWidget(header(shown: true));
      await tester.pumpAndSettle();
      final toggle = byIdentifier(ShellIds.rightPanelToggle);
      expect(toggle, findsOneWidget);
      expect(find.byTooltip('Hide the panel'), findsOneWidget);
      expect(find.byTooltip('Open Bob'), findsNothing);
      expect(find.byTooltip('Computer'), findsNothing);
      // Rightmost: against the column it shows and hides.
      expect(
        tester.getTopRight(toggle).dx,
        closeTo(1200 - chatHeaderChromeSide, 0.5),
      );
      await tester.tap(find.byTooltip('Hide the panel'));
      expect(toggles, 1);
      await tester.pumpWidget(header(shown: false));
      await tester.pumpAndSettle();
      expect(find.byTooltip('Show the panel'), findsOneWidget);
    },
  );

  testWidgets(
    'the overlay fades the thread and puts the panel switch on the right',
    (tester) async {
      tester.view.physicalSize = const Size(1200, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        host(
          ChatHeader(
            name: 'Pixel',
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
      expect(find.byTooltip('Open Pixel'), findsNothing);
      expect(find.text('Pixel'), findsOneWidget);
      expect(
        tester.getTopLeft(find.text('Pixel')).dx,
        greaterThan(tester.getTopRight(companion).dx),
      );
      expect(
        tester.getTopLeft(find.text('Pixel')).dy,
        closeTo(chatHeaderChromeTop + 12, 0.5),
      );
      expect(find.byTooltip('Computer'), findsNothing);
      expect(
        tester.getTopRight(find.byTooltip('Show the panel')).dx,
        closeTo(1200 - chatHeaderChromeSide, 0.5),
      );
      expect(
        tester.getTopLeft(find.byTooltip('Show the panel')).dy,
        chatHeaderChromeTop,
      );
      expect(find.byType(AppBar), findsNothing);
    },
  );

  for (final width in [320.0, 390.0]) {
    for (final scale in [0.85, 1.0, 2.0, 3.0]) {
      testWidgets(
        'the panel switch is the chrome at $width px and ${scale}x text',
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
                onTogglePanel: () => opened.add('Panel'),
              ),
              size: Size(width, 900),
              scaler: TextScaler.linear(scale),
            ),
          );
          await tester.pumpAndSettle();
          expect(tester.takeException(), isNull);
          expect(byIdentifier(ShellIds.botPanelToggle), findsNothing);
          expect(byIdentifier(ShellIds.computerDestination), findsNothing);
          await tester.tap(byIdentifier(ShellIds.rightPanelToggle));
          expect(opened, ['Panel']);
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
        await tester.tap(byIdentifier(ShellIds.computerDestination));
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

  testWidgets('the name sits to the right of the companion on a desk', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1200, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      host(
        ChatHeader(
          name: 'Rosemary',
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
    final companion = find.bySemanticsLabel('Bot is ready');
    final name = find.text('Rosemary');
    expect(name, findsOneWidget);
    expect(find.byTooltip('Open Rosemary'), findsNothing);
    expect(
      tester.getTopLeft(name).dx,
      closeTo(tester.getTopRight(companion).dx + 10, 0.5),
    );
    expect(
      tester.getTopLeft(name).dy,
      greaterThan(tester.getTopLeft(companion).dy),
    );
    expect(
      tester.getTopLeft(name).dy,
      lessThan(tester.getTopLeft(companion).dy + 24),
    );
    expect(
      tester.getTopRight(name).dx,
      lessThan(tester.getTopLeft(find.byTooltip('Show the panel')).dx),
    );
  });

  testWidgets('on a phone the name pill sits next to the companion', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(390, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      host(
        ChatHeader(
          name: 'Rosemary',
          phone: true,
          onBack: () {},
          onOpenBot: () {},
          onComputer: () {},
          companion: CharacterAvatar(
            size: chatCompanionSize,
            cropToInk: true,
            characterId: 'pixel',
            motion: CharacterMotion.still,
            semanticsLabel: 'Bot is ready',
          ),
        ),
        size: const Size(390, 900),
      ),
    );
    await tester.pump();
    final companion = find.bySemanticsLabel('Bot is ready');
    final name = find.byTooltip('Open Rosemary');
    expect(
      tester.getTopLeft(name).dx,
      closeTo(tester.getTopRight(companion).dx + 10, 0.5),
    );
    expect(tester.getTopLeft(name).dy, chatHeaderChromeTop);
    expect(
      tester.getTopLeft(find.byTooltip('Computer')).dx,
      greaterThan(tester.getTopRight(name).dx),
    );
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
          host(ChatHeader(name: 'Bob', onTogglePanel: () {})),
        );
        await tester.pump();
        expect(
          tester.getTopLeft(find.byTooltip('Show the panel')).dy,
          chatHeaderChromeTop,
        );
        expect(
          tester.getTopLeft(find.byTooltip('Show the panel')).dy,
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

  testWidgets('the name is a frosted pill on a phone', (tester) async {
    await tester.pumpWidget(
      host(ChatHeader(name: 'Rosemary', phone: true, onOpenBot: () {})),
    );
    await tester.pump();
    final material = tester.widget<Material>(
      find
          .descendant(
            of: find.byTooltip('Open Rosemary'),
            matching: find.byType(Material),
          )
          .first,
    );
    expect(material.color, isNot(Colors.transparent));
    expect(material.color!.a, lessThan(1));
  });

  testWidgets('the panel switch has no stadium around it', (tester) async {
    await tester.pumpWidget(
      host(ChatHeader(name: 'Bob', onTogglePanel: () {})),
    );
    await tester.pump();
    expect(
      find.descendant(
        of: find.byTooltip('Show the panel'),
        matching: find.byType(BackdropFilter),
      ),
      findsNothing,
    );
    expect(find.byType(IconButton), findsOneWidget);
  });
}
