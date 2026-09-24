import 'package:flutter/foundation.dart'
    show debugDefaultTargetPlatformOverride;
import 'package:flutter/gestures.dart' show PointerDeviceKind;
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter/services.dart';
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
  test('pixel ink at the companion\'s size is the silhouette', () {
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
    'the band holds the companion, the name, and the panel switch at the right',
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
      expect(find.byKey(const ValueKey('chat-header-band')), findsOneWidget);
      final companion = find.bySemanticsLabel('Bot is ready');
      // A desk's band is one height whatever it holds, so a column beside
      // it can meet its line; the companion sits in the middle of it.
      expect(
        tester.getSize(find.byKey(const ValueKey('chat-header-band'))).height,
        chatHeaderBandHeight,
      );
      expect(
        tester.getCenter(companion).dy,
        closeTo(chatHeaderBandHeight / 2, 0.5),
      );
      expect(tester.getTopLeft(companion).dx, chatHeaderChromeSide);
      expect(tester.getSize(companion).height, chatCompanionSize);
      expect(find.byTooltip('Open Pixel'), findsNothing);
      expect(find.text('Pixel'), findsOneWidget);
      expect(
        tester.getTopLeft(find.text('Pixel')).dx,
        greaterThan(tester.getTopRight(companion).dx),
      );
      expect(find.byTooltip('Computer'), findsNothing);
      final panel = tester.getRect(find.byTooltip('Show the panel'));
      expect(panel.right, closeTo(1200 - chatHeaderChromeSide, 0.5));
      // One row: the companion and the switch share a centre line.
      expect(panel.center.dy, closeTo(tester.getCenter(companion).dy, 0.5));
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
      'on a phone the chrome is Back, the name, and the panel at ${scale}x',
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
              onTogglePanel: () => opened.add('Panel'),
            ),
            size: const Size(390, 900),
            scaler: TextScaler.linear(scale),
          ),
        );
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
        expect(find.byTooltip('Routines'), findsNothing);
        expect(find.byTooltip('Applets'), findsNothing);
        expect(find.byTooltip('Computer'), findsNothing);
        expect(byIdentifier(ShellIds.botPanelToggle), findsNothing);
        expect(find.text('My very long research assistant'), findsOneWidget);
        await tester.tap(byIdentifier(ShellIds.sidebarToggle));
        await tester.tap(byIdentifier(ShellIds.rightPanelToggle));
        expect(opened, ['Bots', 'Panel']);
        final back = tester.getRect(byIdentifier(ShellIds.sidebarToggle));
        final panel = tester.getRect(find.byTooltip('Show the panel'));
        expect(back.top, greaterThanOrEqualTo(chatHeaderPhoneChromeTop));
        expect(panel.center.dy, closeTo(back.center.dy, 0.5));
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
      closeTo(tester.getTopRight(companion).dx + 12, 0.5),
    );
    // The name is centred against the companion, not hung from its top.
    expect(
      tester.getCenter(name).dy,
      closeTo(tester.getCenter(companion).dy, 0.5),
    );
    expect(
      tester.getTopRight(name).dx,
      lessThan(tester.getTopLeft(find.byTooltip('Show the panel')).dx),
    );
  });

  testWidgets('on a phone the name sits next to the companion', (tester) async {
    tester.view.physicalSize = const Size(390, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      host(
        ChatHeader(
          name: 'Rosemary',
          phone: true,
          onBack: () {},
          onTogglePanel: () {},
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
    final name = find.text('Rosemary');
    expect(find.byTooltip('Open Rosemary'), findsNothing);
    expect(find.byTooltip('Computer'), findsNothing);
    expect(
      tester.getTopLeft(name).dx,
      closeTo(tester.getTopRight(companion).dx + 12, 0.5),
    );
    final back = tester.getRect(find.byTooltip('Your Bots'));
    final panel = tester.getRect(find.byTooltip('Show the panel'));
    final avatar = tester.getRect(companion);
    final title = tester.getRect(name);
    expect(avatar.center.dy, closeTo(back.center.dy, 0.5));
    expect(panel.center.dy, closeTo(back.center.dy, 0.5));
    expect(title.center.dy, closeTo(back.center.dy, 0.5));
  });

  testWidgets(
    'on a phone every character shares the chrome\'s vertical center',
    (tester) async {
      tester.view.physicalSize = const Size(390, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      for (final characterId in ['pixel', 'dog', 'cow']) {
        await tester.pumpWidget(
          host(
            ChatHeader(
              name: 'Rosemary',
              phone: true,
              onBack: () {},
              onTogglePanel: () {},
              companion: CharacterAvatar(
                size: chatCompanionSize,
                cropToInk: true,
                characterId: characterId,
                motion: CharacterMotion.still,
                semanticsLabel: 'Bot is ready',
              ),
            ),
            size: const Size(390, 900),
          ),
        );
        await tester.pump();
        final back = tester.getRect(find.byTooltip('Your Bots'));
        final panel = tester.getRect(find.byTooltip('Show the panel'));
        final avatar = tester.getRect(find.bySemanticsLabel('Bot is ready'));
        final title = tester.getRect(find.text('Rosemary'));
        expect(avatar.height, chatCompanionSize, reason: characterId);
        expect(
          avatar.center.dy,
          closeTo(back.center.dy, 0.5),
          reason: characterId,
        );
        expect(
          panel.center.dy,
          closeTo(back.center.dy, 0.5),
          reason: characterId,
        );
        expect(
          title.center.dy,
          closeTo(back.center.dy, 0.5),
          reason: characterId,
        );
      }
    },
  );

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
          tester.getCenter(find.byTooltip('Show the panel')).dy,
          closeTo(chatHeaderBandHeight / 2, 0.5),
        );
        expect(
          tester.getTopLeft(find.byTooltip('Show the panel')).dy,
          lessThan(chatHeaderChromeTop + desktopTitleBarBand),
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
              onTogglePanel: () {},
            ),
          ),
        );
        await tester.pump();
        expect(
          tester.getTopLeft(byIdentifier(ShellIds.sidebarToggle)).dy,
          chatHeaderPhoneChromeTop + desktopTitleBarBand,
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

  testWidgets(
    'on a Mac the whole top of the conversation moves the window, over the thread',
    (tester) async {
      debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
      final calls = <String>[];
      const window = MethodChannel('com.frockbot/window');
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(window, (
        call,
      ) async {
        calls.add(call.method);
        return null;
      });
      try {
        var toggled = 0;
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: Stack(
                fit: StackFit.expand,
                children: [
                  // A thread scrolled up under the header: selectable text is
                  // what a drag would otherwise start selecting.
                  SelectionArea(
                    child: ListView(
                      children: [
                        for (var i = 0; i < 40; i++) Text('Message $i'),
                      ],
                    ),
                  ),
                  ChatHeader(
                    name: 'Bob',
                    onTogglePanel: () => toggled++,
                    companion: const SizedBox.square(
                      dimension: chatCompanionSize,
                    ),
                  ),
                ],
              ),
            ),
          ),
        );
        await tester.pump();

        final bottom = chatHeaderChromeTop + chatCompanionSize;
        for (final at in [
          // Above the name, in the gutters beside the row, and over the
          // companion.
          const Offset(600, 4),
          Offset(4, bottom / 2),
          Offset(796, bottom / 2),
          Offset(chatHeaderChromeSide + 20, bottom - 4),
        ]) {
          calls.clear();
          await tester.dragFrom(
            at,
            const Offset(60, 20),
            kind: PointerDeviceKind.mouse,
          );
          await tester.pump();
          expect(calls, ['startDrag'], reason: '$at');
          calls.clear();
          await tester.tapAt(at, kind: PointerDeviceKind.mouse);
          await tester.pump();
          expect(calls, ['titleBarClick'], reason: '$at');
        }

        // The panel switch is still a control, and the thread below the
        // header is still the thread.
        calls.clear();
        await tester.tap(find.byTooltip('Show the panel'));
        await tester.pump();
        expect(toggled, 1);
        await tester.tapAt(Offset(400, bottom + 40));
        await tester.pump();
        expect(calls, isEmpty);
      } finally {
        tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          window,
          null,
        );
        debugDefaultTargetPlatformOverride = null;
      }
    },
  );

  testWidgets('a column\'s header is the band\'s height, so their lines meet', (
    tester,
  ) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
    try {
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: Scaffold(
            body: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: ChatHeader(
                    name: 'Bob',
                    subtitle: 'Helpful, friendly, and gets things done.',
                    connection: ConnectionState.connected,
                    onTogglePanel: () {},
                    companion: const SizedBox.square(
                      dimension: chatCompanionSize,
                    ),
                  ),
                ),
                SizedBox(
                  width: 380,
                  child: PanelHeader(
                    title: const Text('Settings'),
                    actions: [
                      headerAction(
                        tooltip: 'Close the panel',
                        onPressed: () {},
                        icon: const Icon(Icons.close_rounded),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      );
      await tester.pump();
      expect(
        tester.getSize(find.byType(PanelHeader)).height,
        tester.getSize(find.byKey(const ValueKey('chat-header-band'))).height,
      );
    } finally {
      debugDefaultTargetPlatformOverride = null;
    }
  });

  testWidgets('a phone header has no stadium around its buttons', (
    tester,
  ) async {
    await tester.pumpWidget(
      host(
        ChatHeader(
          name: 'Rosemary',
          phone: true,
          onBack: () {},
          onTogglePanel: () {},
        ),
      ),
    );
    await tester.pump();
    expect(find.byType(BackdropFilter), findsNothing);
    expect(find.byTooltip('Your Bots'), findsOneWidget);
    expect(find.byTooltip('Show the panel'), findsOneWidget);
    expect(find.byType(IconButton), findsNWidgets(2));
    expect(find.byTooltip('Open Rosemary'), findsNothing);
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
