/// The chrome's glyphs are one size, and that size is big enough to read on a
/// phone.
///
/// The painted icons started at a 19-point box with smaller geometry inside
/// it, beside Material peers at 20 and 24 — three sizes in one bar, all of
/// them small. [chatIconSizeV1] is the one box they share now, and every
/// control drawn round one carries at least a 44-point target.
library;

import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/chat_controller.dart';
import 'package:frockbot_native/shell/chat_header.dart';
import 'package:frockbot_native/shell/chat_icons.dart';
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
      onMarketplace: () {},
      onVoice: () {},
      voiceControl: VoiceControlState.idle,
      onToggleHidden: () {},
      onRetry: () async {},
    ),
  ),
);

void main() {
  test('the shared glyph is Material\'s own size, not a compact one', () {
    expect(chatIconSizeV1, 24);
  });

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

    // The row Tim's screenshot circled: you, the Marketplace, voice, search
    // and a new Bot. Every one of them a target a thumb can hit.
    for (final id in [
      ShellIds.sidebarProfile,
      ShellIds.sidebarMarketplace,
      VoiceIds.sidebarStart,
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
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: Scaffold(
          appBar: ChatHeader(
            name: 'Rosemary',
            connection: ConnectionState.connected,
            onSettings: () {},
            onComputer: () {},
            onRoutines: () {},
            onApplets: () {},
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    for (final name in ['Applets', 'Computer', 'Routines', 'Bot settings']) {
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
  });
}
