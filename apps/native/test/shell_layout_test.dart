/// The shell's own surfaces: the three tiers, the slot registry, the sidebar's
/// grouping and pin order, the send payload cards, and the identifiers the
/// browser specs select on.
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/protocol/client_wire.generated.dart' as wire;
import 'package:frockbot_native/flock/sheep.dart';
import 'package:frockbot_native/shell/desktop_layout.dart';
import 'package:frockbot_native/shell/focus.dart';
import 'package:frockbot_native/shell/markdown.dart';
import 'package:frockbot_native/shell/run_view.dart';
import 'package:frockbot_native/shell/semantics.dart';
import 'package:frockbot_native/shell/send_payload.dart';
import 'package:frockbot_native/shell/sidebar.dart';
import 'package:frockbot_native/shell/slots.dart';
import 'package:frockbot_native/shell/transcript.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

wire.BotRegistration bot(String botId, String name) =>
    wire.BotRegistration.fromJson({
      'schemaVersion': 1,
      'botId': botId,
      'registeredAt': '2026-09-05T00:00:00.000Z',
      'initialName': name,
      'sheep': {
        'schemaVersion': 1,
        'background': 'a',
        'upper': 'b',
        'middle': 'c',
        'lower': 'd',
      },
    });

wire.UnreadView unread({
  required String botId,
  int count = 0,
  bool capped = false,
  bool isUnread = false,
  bool working = false,
  bool manual = false,
}) => wire.UnreadView.fromJson({
  'schemaVersion': 1,
  'botId': botId,
  'count': count,
  'capped': capped,
  'unread': isUnread,
  'manuallyUnread': manual,
  'working': working,
});

Widget host(Widget child) => MaterialApp(
  theme: FrockTheme.theme(Brightness.dark),
  home: Scaffold(body: child),
);

/// Finds a widget by the identifier the browser specs would select on.
Finder byIdentifier(String identifier) => find.byWidgetPredicate(
  (widget) => widget is Semantics && widget.properties.identifier == identifier,
);

void main() {
  group('the three responsive tiers', () {
    test('are the two widths the shell is designed against', () {
      expect(shellTierForWidth(390), ShellTier.single);
      expect(shellTierForWidth(640), ShellTier.single);
      expect(shellTierForWidth(641), ShellTier.dual);
      expect(shellTierForWidth(980), ShellTier.dual);
      expect(shellTierForWidth(981), ShellTier.triple);
      expect(shellTierForWidth(1440), ShellTier.triple);
    });

    testWidgets('draws three panes at a desk and one on a phone', (
      tester,
    ) async {
      Widget layout({bool conversationOpen = false}) => host(
        ShellLayout(
          panelOpen: true,
          onDismiss: () {},
          conversationOpen: conversationOpen,
          onBack: () {},
          sidebar: const Text('bots'),
          conversation: const Text('thread'),
          rightPanel: const Text('work'),
        ),
      );

      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(tester.view.resetPhysicalSize);

      tester.view.physicalSize = const Size(1440, 900);
      await tester.pumpWidget(layout());
      await tester.pumpAndSettle();
      expect(byIdentifier(ShellIds.sidebar), findsOneWidget);
      expect(byIdentifier(ShellIds.rightPanel), findsOneWidget);
      expect(byIdentifier(ShellIds.scrim).evaluate().isNotEmpty, isTrue);

      // At 900 the right panel is a drawer, so the columns are two: the Bot
      // list and the conversation, which is what the person reads.
      tester.view.physicalSize = const Size(900, 800);
      await tester.pumpWidget(layout());
      await tester.pumpAndSettle();
      expect(tester.getSize(byIdentifier(ShellIds.sidebar)).width, 288);
      expect(
        tester.getSize(byIdentifier(ShellIds.conversation)).width,
        900 - shellSidebarWidth,
      );

      // On a phone the Bot list is the first screen and has the window; the
      // conversation is a page over it, with the window too, and nothing of
      // the right panel is drawn at all.
      tester.view.physicalSize = const Size(390, 780);
      await tester.pumpWidget(layout());
      await tester.pumpAndSettle();
      expect(tester.getSize(byIdentifier(ShellIds.sidebar)).width, 390);
      expect(byIdentifier(ShellIds.conversation), findsNothing);
      expect(byIdentifier(ShellIds.rightPanel), findsNothing);
      await tester.pumpWidget(layout(conversationOpen: true));
      await tester.pumpAndSettle();
      expect(tester.getSize(byIdentifier(ShellIds.conversation)).width, 390);
      expect(byIdentifier(ShellIds.sidebar), findsNothing);
    });

    testWidgets('a collapsed column is gone until it is asked for again', (
      tester,
    ) async {
      // At the widest tier the panel is a column, and the drawer's open flag
      // is not what hides it: the person collapses the column itself, from
      // the panel's close control or the header's switch, and the flag that
      // the drawer tier uses stays what it was.
      tester.view.physicalSize = const Size(1440, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      // The drawer's flag is left raised on purpose: opening an entry raises
      // it at every tier, and a raised flag at this one must draw no scrim.
      Widget layout({required bool collapsed}) => host(
        ShellLayout(
          panelOpen: true,
          panelCollapsed: collapsed,
          onDismiss: () {},
          conversationOpen: true,
          onBack: () {},
          sidebar: const Text('bots'),
          conversation: const Text('thread'),
          rightPanel: const Text('work'),
        ),
      );
      await tester.pumpWidget(layout(collapsed: false));
      await tester.pumpAndSettle();
      expect(byIdentifier(ShellIds.rightPanel), findsOneWidget);
      expect(
        tester.getSize(byIdentifier(ShellIds.conversation)).width,
        1440 - shellSidebarWidth - shellRightPanelWidth,
      );
      await tester.pumpWidget(layout(collapsed: true));
      await tester.pumpAndSettle();
      expect(byIdentifier(ShellIds.rightPanel), findsNothing);
      expect(
        tester.getSize(byIdentifier(ShellIds.conversation)).width,
        1440 - shellSidebarWidth,
      );
      expect(
        tester
            .widget<AnimatedOpacity>(
              find.ancestor(
                of: byIdentifier(ShellIds.scrim),
                matching: find.byType(AnimatedOpacity),
              ),
            )
            .opacity,
        0,
      );
      expect(find.text('thread').hitTestable(), findsOneWidget);
    });

    testWidgets(
      'on a phone Back from the conversation is the list, not the way out',
      (tester) async {
        tester.view.physicalSize = const Size(390, 780);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        var backs = 0;
        await tester.pumpWidget(
          host(
            ShellLayout(
              panelOpen: false,
              onDismiss: () {},
              conversationOpen: true,
              onBack: () => backs++,
              sidebar: const Text('bots'),
              conversation: const Text('thread'),
              rightPanel: null,
            ),
          ),
        );
        await tester.pumpAndSettle();
        await tester.binding.handlePopRoute();
        await tester.pumpAndSettle();
        expect(backs, 1);
        // The app is still here: nothing popped past the shell.
        expect(find.text('thread'), findsOneWidget);
      },
    );

    testWidgets('an open drawer is dismissed by tapping what it covers', (
      tester,
    ) async {
      // The scrim has to be the size of the shell, and being in the tree does
      // not say that: a `ColoredBox` with no child takes the smallest size its
      // constraints allow, and a `Stack`'s non-positioned children are loosely
      // constrained — so an unpositioned scrim was 0x0. It dimmed nothing, took
      // no tap, and was dropped from the accessibility tree for having no area,
      // which left the only way out of the panel the control that opened it.
      tester.view.physicalSize = const Size(900, 780);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      var dismissed = 0;
      await tester.pumpWidget(
        host(
          ShellLayout(
            panelOpen: true,
            onDismiss: () => dismissed++,
            conversationOpen: true,
            onBack: () {},
            sidebar: const Text('bots'),
            conversation: const Text('thread'),
            rightPanel: const Text('work'),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(
        tester.getSize(byIdentifier(ShellIds.scrim)),
        const Size(900, 780),
      );
      // Beside the drawer, over the conversation the person can see.
      await tester.tapAt(const Offset(340, 400));
      expect(dismissed, 1);
    });

    testWidgets('a parked drawer is not read out or hit-tested', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(900, 780);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      var dismissed = 0;
      await tester.pumpWidget(
        host(
          ShellLayout(
            panelOpen: false,
            onDismiss: () => dismissed++,
            conversationOpen: true,
            onBack: () {},
            sidebar: const Text('bots'),
            conversation: const Text('thread'),
            rightPanel: const Text('work'),
          ),
        ),
      );
      await tester.pumpAndSettle();
      // The scrim is inert while nothing is open.
      await tester.tapAt(const Offset(500, 400));
      expect(dismissed, 0);
    });
  });

  group('the slot registry', () {
    testWidgets('draws what a feature registered, and nothing before', (
      tester,
    ) async {
      final slots = ShellSlots();
      addTearDown(slots.dispose);
      await tester.pumpWidget(
        host(
          ShellSlotScope(
            slots: slots,
            child: const SlotRegion(ShellSlot.rightPanel),
          ),
        ),
      );
      expect(byIdentifier(ShellIds.slot('right-panel')), findsNothing);
      expect(slots.filled(ShellSlot.rightPanel), isFalse);

      slots.register(
        ShellSlot.rightPanel,
        'bot-panel',
        (_) => const Text('Bot panel'),
      );
      await tester.pump();
      expect(find.text('Bot panel'), findsOneWidget);
      expect(byIdentifier(ShellIds.slot('right-panel')), findsOneWidget);

      slots.remove(ShellSlot.rightPanel, 'bot-panel');
      await tester.pump();
      expect(find.text('Bot panel'), findsNothing);
    });

    test('names its two regions', () {
      expect(
        [for (final slot in ShellSlot.values) slot.id],
        ['right-panel', 'overlays'],
      );
    });
  });

  group('the sidebar splits pinned Bots out of the list', () {
    String id(wire.BotRegistration value) => value.botId.value;

    test('orders the tiles by pin time, earliest first', () {
      final bots = [bot('a', 'A'), bot('b', 'B'), bot('c', 'C')];
      final split = partitionPinnedSidebarBots(bots, id, {
        'a': const SidebarProfile(pinnedAt: '2026-09-05T00:00:00.000Z'),
        'c': const SidebarProfile(pinnedAt: '2026-01-01T00:00:00.000Z'),
      });

      expect([for (final value in split.pinned) id(value)], ['c', 'a']);
      expect([for (final value in split.rest) id(value)], ['b']);
    });

    test('keeps list order for ties and for an unparseable instant', () {
      final bots = [bot('a', 'A'), bot('b', 'B')];
      final split = partitionPinnedSidebarBots(bots, id, {
        'a': const SidebarProfile(pinnedAt: 'not an instant'),
        'b': const SidebarProfile(pinnedAt: 'also not one'),
      });

      expect([for (final value in split.pinned) id(value)], ['a', 'b']);
    });

    test('a blank pin is not a pin', () {
      final split = partitionPinnedSidebarBots(
        [bot('a', 'A')],
        id,
        {'a': const SidebarProfile(pinnedAt: '   ')},
      );

      expect(split.pinned, isEmpty);
      expect(split.rest.length, 1);
    });
  });

  group('the sidebar groups by label', () {
    String id(wire.BotRegistration value) => value.botId.value;

    test('stays one plain list until a visible Bot has a label', () {
      final grouped = groupSidebarBots([bot('a', 'A'), bot('b', 'B')], id, {});

      expect(grouped.showHeadings, isFalse);
      expect(grouped.groups.single.key, 'all');
      expect(grouped.groups.single.bots.length, 2);
    });

    test('folds case and keeps the first spelling, unassigned last', () {
      final grouped = groupSidebarBots(
        [bot('a', 'A'), bot('b', 'B'), bot('c', 'C')],
        id,
        {
          'a': const SidebarProfile(label: 'Work'),
          'b': const SidebarProfile(label: ' work '),
        },
      );

      expect(grouped.showHeadings, isTrue);
      expect(
        [for (final group in grouped.groups) group.label],
        ['Work', 'Unassigned'],
      );
      expect(grouped.groups.first.bots.length, 2);
      expect(grouped.groups.last.bots.single.botId.value, 'c');
    });

    test('offers no Unassigned group when every Bot has a label', () {
      final grouped = groupSidebarBots(
        [bot('a', 'A')],
        id,
        {'a': const SidebarProfile(label: 'Work')},
      );

      expect(grouped.groups.length, 1);
    });
  });

  group('the sidebar row', () {
    test('says how many unread, and nothing at zero', () {
      String? label(wire.UnreadView? view) =>
          sidebarUnreadFor(view, focused: false).label;
      expect(label(null), isNull);
      expect(label(unread(botId: 'a')), isNull);
      expect(label(unread(botId: 'a', count: 0, isUnread: true)), isNull);
      expect(label(unread(botId: 'a', count: 3, isUnread: true)), '3');
      expect(
        label(unread(botId: 'a', count: 99, capped: true, isUnread: true)),
        '99+',
      );
      expect(
        label(unread(botId: 'a', count: 0, isUnread: true, manual: true)),
        '•',
      );
    });

    test('draws no count for the Bot the User is reading', () {
      final view = unread(botId: 'a', count: 3, isUnread: true);
      final shown = sidebarUnreadFor(view, focused: true);
      // The fan-out is right and the row is still quiet: the receipt that
      // clears the count is a round trip behind the message that raised it,
      // and the row never renders a count it is about to lose.
      expect(shown.label, isNull);
      expect(shown.count, 0);
      expect(shown.unread, isFalse);
      expect(sidebarUnreadFor(view, focused: false).label, '3');
    });

    test('a Bot marked unread by hand stays bold while it is open', () {
      // Intent, not arithmetic: only opening the Bot again clears it.
      final shown = sidebarUnreadFor(
        unread(botId: 'a', count: 0, isUnread: true, manual: true),
        focused: true,
      );
      expect(shown.unread, isTrue);
      expect(shown.label, '•');
    });

    test(
      'a hand-marked Bot still draws no count for a reply it is open on',
      () {
        // The flag survives the reply settling, the arithmetic does not: the
        // row the User is reading never paints a number or feeds a group total.
        final shown = sidebarUnreadFor(
          unread(botId: 'a', count: 1, isUnread: true, manual: true),
          focused: true,
        );
        expect(shown.label, '•');
        expect(shown.count, 0);
        expect(shown.unread, isTrue);
      },
    );

    test('says a time today, a weekday this week, a date beyond it', () {
      final now = DateTime(2026, 9, 8, 15, 0);
      expect(
        formatSidebarMessageTime(
          DateTime(2026, 9, 8, 9, 5).toUtc().toIso8601String(),
          now,
        ),
        '9:05 am',
      );
      expect(
        formatSidebarMessageTime(
          DateTime(2026, 9, 5, 9, 5).toUtc().toIso8601String(),
          now,
        ),
        'Saturday',
      );
      expect(
        formatSidebarMessageTime(
          DateTime(2026, 1, 5, 9, 5).toUtc().toIso8601String(),
          now,
        ),
        '1/5',
      );
      expect(formatSidebarMessageTime('not an instant', now), '');
    });

    testWidgets('carries a stable identifier per Bot and per group', (
      tester,
    ) async {
      await tester.pumpWidget(
        host(
          ShellSidebar(
            bots: [bot('scout', 'Scout'), bot('rosemary', 'Rosemary')],
            profiles: const {
              'scout': SidebarProfile(label: 'Work'),
              'rosemary': SidebarProfile(pinnedAt: '2026-01-01T00:00:00.000Z'),
            },
            unread: {'scout': unread(botId: 'scout', count: 2, isUnread: true)},
            archived: const {},
            activeBotId: 'scout',
            focusedBotId: null,
            workingBotId: null,
            loaded: true,
            showHidden: false,
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
      await tester.pumpAndSettle();

      expect(byIdentifier(ShellIds.sidebarBot('scout')), findsOneWidget);
      expect(byIdentifier(ShellIds.sidebarPinned('rosemary')), findsOneWidget);
      expect(byIdentifier(ShellIds.sidebarGroup('label:work')), findsOneWidget);
      expect(byIdentifier(ShellIds.sidebarCreateBot), findsOneWidget);
      expect(byIdentifier(ShellIds.sidebarSearch), findsOneWidget);
      expect(byIdentifier(ShellIds.sidebarProfile), findsOneWidget);
      // Four controls and no more: you, a call, search, a new Bot. The
      // account is behind the first and each Bot's own affairs are on its
      // page. The Marketplace is the column's foot, a named row below the
      // list rather than a fifth icon in its bar.
      expect(find.byType(IconButton), findsNWidgets(3));
      final foot = byIdentifier(ShellIds.sidebarMarketplace);
      expect(foot, findsOneWidget);
      expect(
        find.descendant(of: foot, matching: find.text('Marketplace')),
        findsOneWidget,
      );
      expect(
        tester.getTopLeft(foot).dy,
        greaterThan(
          tester.getBottomLeft(byIdentifier(ShellIds.sidebarBot('scout'))).dy,
        ),
      );
      expect(find.text('2'), findsOneWidget);
      // A pinned Bot is a tile instead of a row, never both.
      expect(byIdentifier(ShellIds.sidebarBot('rosemary')), findsNothing);
    });

    testWidgets('the open Bot the User is reading wears no badge', (
      tester,
    ) async {
      await tester.pumpWidget(
        host(
          ShellSidebar(
            bots: [bot('scout', 'Scout')],
            profiles: const {},
            unread: {'scout': unread(botId: 'scout', count: 2, isUnread: true)},
            archived: const {},
            activeBotId: 'scout',
            focusedBotId: 'scout',
            workingBotId: null,
            loaded: true,
            showHidden: false,
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
      await tester.pumpAndSettle();

      // Not a count that arrives and goes: the reply to the message being
      // typed never paints one on the row it is being typed into.
      expect(find.byType(Badge), findsNothing);
      expect(find.text('2'), findsNothing);
    });

    testWidgets('a phone puts the Marketplace beside the account', (
      tester,
    ) async {
      var opened = 0;
      await tester.pumpWidget(
        host(
          ShellSidebar(
            bots: [bot('scout', 'Scout')],
            profiles: const {},
            unread: const {},
            archived: const {},
            activeBotId: null,
            focusedBotId: null,
            workingBotId: null,
            loaded: true,
            showHidden: false,
            phone: true,
            onSelect: (_) {},
            onCreateBot: () {},
            onSearch: () {},
            onProfile: () {},
            onMarketplace: () => opened++,
            onVoice: () {},
            voiceControl: VoiceControlState.idle,
            onToggleHidden: () {},
            onRetry: () async {},
          ),
        ),
      );
      await tester.pumpAndSettle();

      // An icon in the bar, not a row at the foot: the foot of a phone's
      // full-height list is where a thumb reaches last.
      final marketplace = byIdentifier(ShellIds.sidebarMarketplace);
      expect(marketplace, findsOneWidget);
      expect(find.text('Marketplace'), findsNothing);
      expect(find.byTooltip('Marketplace'), findsOneWidget);
      expect(find.byType(IconButton), findsNWidgets(5));
      final profile = tester.getRect(byIdentifier(ShellIds.sidebarProfile));
      final door = tester.getRect(marketplace);
      expect(door.left, greaterThanOrEqualTo(profile.right - 1));
      expect(
        door.left,
        lessThan(tester.getRect(byIdentifier(ShellIds.sidebarSearch)).left),
      );
      expect((door.center.dy - profile.center.dy).abs(), lessThan(1));
      await tester.tap(marketplace);
      expect(opened, 1);
    });

    testWidgets('an unreadable list offers the read again', (tester) async {
      var retries = 0;
      await tester.pumpWidget(
        host(
          ShellSidebar(
            bots: const [],
            profiles: const {},
            unread: const {},
            archived: const {},
            activeBotId: null,
            focusedBotId: null,
            workingBotId: null,
            loaded: true,
            error: 'Couldn’t reach FrockBot.',
            showHidden: false,
            onSelect: (_) {},
            onCreateBot: () {},
            onSearch: () {},
            onProfile: () {},
            onMarketplace: () {},
            onVoice: () {},
            voiceControl: VoiceControlState.idle,
            onToggleHidden: () {},
            onRetry: () async {
              retries++;
            },
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('No Bots yet. Add your first sheep.'), findsNothing);
      await tester.tap(byIdentifier(ShellIds.sidebarRetry));
      expect(retries, 1);
    });
  });

  group('one user-facing send, drawn', () {
    Widget send(Map<String, Object?> payload) =>
        host(SendPayloadView(send: SendPayloadLine(payload)));

    testWidgets('a widget shows the question and answers none of it', (
      tester,
    ) async {
      await tester.pumpWidget(
        send({
          'type': 'widget',
          'widget': {
            'prompt': 'Which one?',
            'options': ['A', 'B'],
            'allowCustom': true,
          },
        }),
      );
      await tester.pumpAndSettle();

      expect(find.text('Which one?'), findsOneWidget);
      expect(find.text('A'), findsOneWidget);
      expect(find.text('Any other answer is accepted too.'), findsOneWidget);
      expect(find.byType(FilledButton), findsNothing);
    });

    testWidgets('an approval offers both answers and names its risk', (
      tester,
    ) async {
      await tester.pumpWidget(
        host(
          SendPayloadView(
            send: const SendPayloadLine({
              'type': 'approval',
              'approvalId': 'ap-1',
              'action': 'Delete the production bucket',
              'risk': 'high',
            }),
            approvals: null,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('HIGH'), findsOneWidget);
      expect(find.text('Delete the production bucket'), findsOneWidget);
    });

    testWidgets('a secret request sends the person to Settings', (
      tester,
    ) async {
      var opened = 0;
      await tester.pumpWidget(
        host(
          SendPayloadView(
            send: const SendPayloadLine({
              'type': 'secret-request',
              'prompt': 'I need the Stripe key.',
              'secretName': 'STRIPE_KEY',
            }),
            onOpenSettings: () => opened++,
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('Open Settings'));
      expect(opened, 1);
    });

    // An Applet send that lost its id must degrade like any other payload the
    // client cannot draw, not blow up the whole transcript entry.
    testWidgets('an applet send without a usable id says so', (tester) async {
      for (final payload in <Map<String, Object?>>[
        {'type': 'applet'},
        {'type': 'applet', 'appletId': null},
        {'type': 'applet', 'appletId': 7},
        {'type': 'applet', 'appletId': ''},
      ]) {
        await tester.pumpWidget(send(payload));
        await tester.pumpAndSettle();

        expect(tester.takeException(), isNull);
        expect(
          find.text('This client cannot display that message.'),
          findsOneWidget,
          reason: 'payload $payload',
        );
      }
    });

    // A Turn's history has to render on a client older than the Bot that
    // produced it.
    testWidgets('a payload this build cannot draw says so', (tester) async {
      await tester.pumpWidget(send({'type': 'something-newer'}));
      await tester.pumpAndSettle();

      expect(
        find.text('This client cannot display that message.'),
        findsOneWidget,
      );
    });
  });

  group('assistant text is Markdown', () {
    test('splits blocks the way the web client does', () {
      final blocks = parseMarkdownBlocks(
        '# Title\n\nA line\nand its continuation\n\n- one\n- two\n\n'
        '```\ncode\n```\n\n> quoted\n\n---',
      );

      expect(
        [for (final block in blocks) block.kind],
        [
          MarkdownBlockKind.heading,
          MarkdownBlockKind.paragraph,
          MarkdownBlockKind.listItem,
          MarkdownBlockKind.listItem,
          MarkdownBlockKind.code,
          MarkdownBlockKind.quote,
          MarkdownBlockKind.rule,
        ],
      );
      expect(blocks[1].text, 'A line\nand its continuation');
      expect(blocks[4].text, 'code');
    });

    test('code wins over emphasis, so a path survives verbatim', () {
      final runs = parseMarkdownInline('use `a_b_c` and **bold**');

      expect(runs[1].text, 'a_b_c');
      expect(runs[1].code, isTrue);
      expect(runs.last.bold, isTrue);
    });

    test('a link keeps its label and its href', () {
      final runs = parseMarkdownInline('see [the docs](https://example.com)');

      expect(runs[1].text, 'the docs');
      expect(runs[1].href, 'https://example.com');
    });

    testWidgets('renders without a sanitizer because nothing is markup', (
      tester,
    ) async {
      await tester.pumpWidget(
        host(const ShellMarkdown(text: '<script>alert(1)</script>')),
      );
      await tester.pumpAndSettle();

      expect(find.textContaining('<script>'), findsOneWidget);
    });
  });

  group('the trail says how hard a Turn is working', () {
    ActivityTrailSample sample({
      int characters = 0,
      int toolStarts = 0,
      int toolSettles = 0,
      int sends = 0,
      String status = 'streaming',
    }) => ActivityTrailSample(
      characters: characters,
      toolStarts: toolStarts,
      toolSettles: toolSettles,
      sends: sends,
      status: status,
    );

    test('a settled Turn emits nothing at all', () {
      final stepped = activityTrailStep(
        activityTrailBegin(sample(), Duration.zero),
        sample(status: 'completed'),
        const Duration(seconds: 1),
      );

      expect(stepped.plan.active, isFalse);
      expect(stepped.plan.state, ActivityTrailState.ended);
      expect(stepped.plan.rate, 0);
    });

    test('an open Turn with nothing arriving still trickles', () {
      final stepped = activityTrailStep(
        activityTrailBegin(sample(), Duration.zero),
        sample(),
        const Duration(seconds: 3),
      );

      expect(stepped.plan.state, ActivityTrailState.waiting);
      expect(stepped.plan.rate, activityTrailTrickleRate);
    });

    test('the rate is capped however fast the text arrives', () {
      final stepped = activityTrailStep(
        activityTrailBegin(sample(), Duration.zero),
        sample(characters: 100000),
        const Duration(milliseconds: 100),
      );

      expect(stepped.plan.rate, activityTrailMaxRate);
      expect(stepped.plan.state, ActivityTrailState.running);
    });

    // A reconnect replaying a whole Turn must not fire two hundred bursts.
    test('bursts are bounded per step', () {
      final stepped = activityTrailStep(
        activityTrailBegin(sample(), Duration.zero),
        sample(toolStarts: 50, toolSettles: 50, sends: 50),
        const Duration(milliseconds: 100),
      );

      expect(stepped.plan.bursts.length, activityTrailMaxBurstsPerStep);
    });

    // A send superseding the model's own draft is not negative work.
    test('a shorter projection is no work rather than negative work', () {
      final stepped = activityTrailStep(
        activityTrailBegin(sample(characters: 500), Duration.zero),
        sample(characters: 10),
        const Duration(milliseconds: 100),
      );

      expect(stepped.plan.rate, activityTrailTrickleRate);
    });
  });

  group('a Turn\'s receipts live on the run view, not in the thread', () {
    testWidgets('message long hold opens actions without tool counts', (
      tester,
    ) async {
      TranscriptLine? opened;
      await tester.pumpWidget(
        host(
          TranscriptView(
            lines: projectRuns([
              {
                'runId': 'run-a',
                'input': 'do it',
                'status': 'completed',
                'admittedAt': '2026-09-05T00:00:00.000Z',
                'responseText': 'Done.',
                'events': [
                  {
                    'type': 'tool/call',
                    'call': {'id': 't1', 'name': 'workspace_write'},
                  },
                  {
                    'type': 'tool/result',
                    'callId': 't1',
                    'content': 'wrote 1 file',
                    'isError': false,
                  },
                ],
              },
            ]),
            loading: false,
            hasEarlier: false,
            storageKey: 'test',
            onRefresh: ({bool older = false}) async {},
            onOpenRun: (_) {},
            onMessageActions: (line) => opened = line,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('workspace_write'), findsNothing);
      expect(find.text('Used 1 tool'), findsNothing);
      expect(find.byType(SheepAvatar), findsNothing);
      await tester.longPress(find.text('do it'));
      expect(opened?.runId, 'run-a');
    });

    testWidgets('the run view names them', (tester) async {
      final line = projectRuns([
        {
          'runId': 'run-a',
          'input': 'do it',
          'status': 'completed',
          'admittedAt': '2026-09-05T00:00:00.000Z',
          'events': [
            {
              'type': 'tool/call',
              'call': {'id': 't1', 'name': 'workspace_write'},
            },
            {
              'type': 'tool/result',
              'callId': 't1',
              'content': 'wrote 1 file',
              'isError': false,
            },
          ],
        },
      ]).last;

      await tester.pumpWidget(host(RunView(line: line)));
      await tester.pumpAndSettle();

      expect(byIdentifier(ShellIds.runView), findsOneWidget);
      expect(find.text('workspace_write'), findsOneWidget);
    });

    testWidgets('the run view itemises what each Plugin spent', (tester) async {
      final line = projectRuns([
        {
          'runId': 'run-a',
          'input': 'forecast?',
          'status': 'completed',
          'admittedAt': '2026-09-05T00:00:00.000Z',
          'events': [
            {
              'type': 'plugin/model-usage',
              'pluginId': 'weather',
              'requestId': 'req-1',
              'model': 'glm-5.3-flash:cloud',
              'inputTokens': 120,
              'outputTokens': 40,
              'costMicros': 1200,
            },
          ],
        },
      ]).last;

      await tester.pumpWidget(host(RunView(line: line)));
      await tester.pumpAndSettle();

      expect(find.text('Plugins'), findsOneWidget);
      expect(find.text('weather'), findsOneWidget);
      expect(
        find.text('glm-5.3-flash:cloud · 120 in, 40 out · US\$0.0012'),
        findsOneWidget,
      );
    });

    testWidgets('a reply that used no tools says so rather than nothing', (
      tester,
    ) async {
      await tester.pumpWidget(
        host(
          RunView(
            line: projectRuns([
              {
                'runId': 'run-a',
                'input': 'hi',
                'status': 'completed',
                'admittedAt': '2026-09-05T00:00:00.000Z',
                'events': const <Object>[],
              },
            ]).last,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('This reply used no tools.'), findsOneWidget);
    });
  });
}
