/// The chrome's glyphs are one size per platform: big enough to read on a
/// phone, compact at a desk.
///
/// The painted icons started at a 19-point box with smaller geometry inside
/// it, beside Material peers at 20 and 24 — three sizes in one bar, all of
/// them small. [chatIconSizeV1] is the one box they share on a phone, and
/// every control drawn round one carries at least a 44-point target. Native
/// desktops draw the same glyphs at [chatIconSizeDesktop] in tighter controls,
/// because 24 points of line art beside 14-point text reads as massive.
library;

import 'package:flutter/foundation.dart'
    show debugDefaultTargetPlatformOverride, defaultTargetPlatform;
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/chat_controller.dart';
import 'package:frockbot_native/shell/chat_header.dart';
import 'package:frockbot_native/shell/chat_icons.dart';
import 'package:frockbot_native/shell/desktop_layout.dart';
import 'package:frockbot_native/shell/semantics.dart';
import 'package:frockbot_native/shell/sidebar.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'shell_layout_test.dart' show bot, byIdentifier;

Widget _sidebar({required bool phone}) => MaterialApp(
  theme: FrockTheme.theme(Brightness.dark),
  home: Scaffold(
    body: ShellSidebar(
      bots: [bot('scout', 'Scout')],
      profiles: const {},
      unread: const {},
      archived: const {},
      activeBotId: null,
      focusedBotId: null,
      workingBotId: null,
      loaded: true,
      showHidden: false,
      phone: phone,
      onSelect: (_) {},
      onCreateBot: () {},
      onSearch: () {},
      onProfile: () {},
      onWhatsNew: () {},
      onMarketplace: () {},
      onToggleHidden: () {},
      onRetry: () async {},
    ),
  ),
);

const _desktops = {
  TargetPlatform.macOS,
  TargetPlatform.windows,
  TargetPlatform.linux,
};

final _phones = TargetPlatformVariant({
  TargetPlatform.iOS,
  TargetPlatform.android,
});

Widget _header() => MaterialApp(
  theme: FrockTheme.theme(Brightness.dark),
  home: Scaffold(
    body: Stack(
      fit: StackFit.expand,
      children: [
        ChatHeader(
          name: 'Rosemary',
          connection: ConnectionState.connected,
          onTogglePanel: () {},
        ),
      ],
    ),
  ),
);

/// What is left in the bar: the panel's own switch. The Bot and the
/// Computer live in that column.
const _headerDoors = ['Show the panel'];

void main() {
  test('a phone\'s glyph is Material\'s own size, a desk\'s compact', () {
    expect(chatIconSizeV1, 24);
    expect(chatIconSizeDesktop, 19);
  });

  testWidgets('the chrome\'s sizes follow the platform', (tester) async {
    final desktop = _desktops.contains(defaultTargetPlatform);
    expect(chatDesktopChrome, desktop);
    expect(chatIconSize, desktop ? 19 : 24);
    expect(chatControlExtent, desktop ? 36 : 44);
  }, variant: TargetPlatformVariant.all());

  testWidgets('every painted glyph in the chrome takes the same box', (
    tester,
  ) async {
    final icons = [
      for (final kind in ChatIconKind.values)
        ChatIcon(kind, key: ValueKey(kind)),
    ];
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: Scaffold(
          body: Column(mainAxisSize: MainAxisSize.min, children: icons),
        ),
      ),
    );
    for (final kind in ChatIconKind.values) {
      expect(
        tester.getSize(find.byKey(ValueKey(kind))),
        const Size.square(chatIconSizeV1),
        reason: '$kind',
      );
    }
  });

  testWidgets('the phone Bot list draws its controls at that size', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(_sidebar(phone: true));
    await tester.pumpAndSettle();

    // The row Tim's screenshot circled: you, the Marketplace, search and a
    // new Bot. Every one of them a target a thumb can hit.
    for (final id in [
      ShellIds.sidebarProfile,
      ShellIds.sidebarMarketplace,
      ShellIds.sidebarSearch,
      ShellIds.sidebarCreateBot,
    ]) {
      final button = tester.widget<IconButton>(
        find.descendant(
          of: byIdentifier(id),
          matching: find.byType(IconButton),
        ),
      );
      final size = tester.getSize(byIdentifier(id));
      expect(size.width, greaterThanOrEqualTo(40), reason: id);
      expect(size.height, greaterThanOrEqualTo(40), reason: id);
      // The glyph inside it, where the button names one rather than drawing
      // its own — the account's face is a circle with a person in it.
      final glyph = button.style?.iconSize?.resolve({});
      if (glyph != null) expect(glyph, chatIconSizeV1, reason: id);
    }
  }, variant: _phones);

  testWidgets('the Mac sidebar clears lights without a left inset', (
    tester,
  ) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
    tester.view.physicalSize = const Size(1000, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(_sidebar(phone: false));
    await tester.pumpAndSettle();

    final profile = tester.getRect(byIdentifier(ShellIds.sidebarProfile));
    expect(profile.left, 12);
    expect(profile.top, desktopSidebarTrafficLightClearance);
    expect(
      tester.getRect(byIdentifier(ShellIds.sidebarCreateBot)).top,
      desktopSidebarTrafficLightClearance,
    );
    debugDefaultTargetPlatformOverride = null;
  });

  testWidgets('a desk names the Marketplace in the list\'s own weight', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1000, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(_sidebar(phone: false));
    await tester.pumpAndSettle();

    final label = tester.widget<Text>(
      find.descendant(
        of: byIdentifier(ShellIds.sidebarMarketplace),
        matching: find.text('Marketplace'),
      ),
    );
    // A door, not a heading.
    expect(label.style?.fontWeight, FontWeight.w400);
  });

  testWidgets('the header\'s doors are one size, with 44-point targets', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1200, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(_header());
    await tester.pumpAndSettle();

    for (final name in _headerDoors) {
      final size = tester.getSize(find.byTooltip(name));
      expect(size.width, greaterThanOrEqualTo(42), reason: name);
      expect(size.height, greaterThanOrEqualTo(44), reason: name);
      expect(
        tester.getSize(
          find.descendant(
            of: find.byTooltip(name),
            matching: find.byType(ChatIcon),
          ),
        ),
        const Size.square(chatIconSizeV1),
        reason: name,
      );
    }
  }, variant: _phones);

  testWidgets(
    'a desk\'s header draws 19-point glyphs in compact 36 by 36 doors',
    (tester) async {
      tester.view.physicalSize = const Size(1200, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(_header());
      await tester.pumpAndSettle();

      for (final name in _headerDoors) {
        expect(
          tester.getSize(find.byTooltip(name)),
          const Size(36, 36),
          reason: name,
        );
        expect(
          tester.getSize(
            find.descendant(
              of: find.byTooltip(name),
              matching: find.byType(ChatIcon),
            ),
          ),
          const Size.square(chatIconSizeDesktop),
          reason: name,
        );
      }
    },
    variant: TargetPlatformVariant.desktop(),
  );

  testWidgets('a desk\'s Bot list draws its controls compact', (tester) async {
    tester.view.physicalSize = const Size(1000, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(_sidebar(phone: false));
    await tester.pumpAndSettle();

    final createBot = tester.widget<IconButton>(
      find.descendant(
        of: byIdentifier(ShellIds.sidebarCreateBot),
        matching: find.byType(IconButton),
      ),
    );
    expect(
      tester.getSize(
        find.descendant(
          of: byIdentifier(ShellIds.sidebarCreateBot),
          matching: find.byType(IconButton),
        ),
      ),
      const Size.square(36),
    );
    expect(createBot.style?.iconSize?.resolve({}), chatIconSizeDesktop);
    final marketplaceGlyph = tester.widget<Icon>(
      find.descendant(
        of: byIdentifier(ShellIds.sidebarMarketplace),
        matching: find.byIcon(Icons.storefront_outlined),
      ),
    );
    expect(marketplaceGlyph.size, chatIconSizeDesktop);
  }, variant: TargetPlatformVariant.desktop());
}
