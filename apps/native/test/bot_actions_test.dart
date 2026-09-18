import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_client/client/transport.dart' show RequestFailure;
import 'package:frockbot_client/protocol/client_wire.generated.dart' as wire;
import 'package:frockbot_client/settings/bot_quick_writes.dart';
import 'package:frockbot_client/shell/bot_actions.dart';
import 'package:frockbot_client/shell/semantics.dart';
import 'package:frockbot_client/shell/sidebar.dart';

import 'settings_test.dart' show SettingsApi;
import 'shell_layout_test.dart' show bot, byIdentifier, host, unread;
import 'widget_test.dart' show MemoryStore;

/// A drag slow enough that only its distance counts, not its speed.
Future<void> slowDrag(WidgetTester tester, Finder finder, Offset by) =>
    tester.timedDrag(finder, by, const Duration(milliseconds: 600));

List<BotAction> actionsOf(BotActionState state) => [
  for (final item in botActionsFor(state)) item.action,
];

void main() {
  group('what a row offers', () {
    test('follows the state, one direction per pair', () {
      expect(actionsOf(const BotActionState(unread: true)), [
        BotAction.markRead,
        BotAction.pin,
        BotAction.mute,
        BotAction.label,
        BotAction.hide,
        BotAction.archive,
      ]);
      expect(
        actionsOf(
          const BotActionState(pinned: true, muted: true, hidden: true),
        ),
        [
          BotAction.markUnread,
          BotAction.unpin,
          BotAction.unmute,
          BotAction.label,
          BotAction.show,
          BotAction.archive,
        ],
      );
    });

    test('a Bot nothing has been said about cannot be marked', () {
      expect(
        actionsOf(const BotActionState(hasActivity: false)),
        isNot(contains(BotAction.markUnread)),
      );
      expect(
        actionsOf(const BotActionState(hasActivity: false)),
        isNot(contains(BotAction.markRead)),
      );
    });

    test('an archived Bot offers only its way back', () {
      expect(actionsOf(const BotActionState(archived: true)), [
        BotAction.restore,
      ]);
    });

    test('archiving is the one action that asks first', () {
      final asks = [
        for (final item in botActionsFor(const BotActionState()))
          if (item.confirms) item.action,
      ];
      expect(asks, [BotAction.archive]);
    });
  });

  group('the quick writer', () {
    test('fences one field on the revision it reads', () async {
      final commands = <Map<String, Object?>>[];
      final api = SettingsApi(MemoryStore(), (path, body) async {
        if (body == null) return {'revision': 7};
        commands.add(Map<String, Object?>.from(body as Map));
        return {'status': 'applied', 'revision': 8};
      });
      final failure = await BotQuickWrites(api)
          .setProfile('alpha', {'pinnedAt': ''});
      expect(failure, isNull);
      expect(commands, hasLength(1));
      expect(commands.single['type'], 'bot/set-profile');
      expect(commands.single['expectedRevision'], 7);
      expect(commands.single['profile'], {'pinnedAt': ''});
    });

    test('re-fences once on a conflict and reports a refusal', () async {
      var reads = 0;
      final sent = <int>[];
      final api = SettingsApi(MemoryStore(), (path, body) async {
        if (body == null) return {'revision': ++reads};
        sent.add((body as Map)['expectedRevision'] as int);
        if (sent.length == 1) throw const RequestFailure('moved', 409);
        return {'status': 'rejected', 'failure': 'Hidden Bots stay muted.'};
      });
      final failure = await BotQuickWrites(api)
          .setNotifications('alpha', enabled: true);
      expect(sent, [1, 2]);
      expect(failure, 'Hidden Bots stay muted.');
    });
  });

  group('the row', () {
    Widget sidebar({
      required bool phone,
      void Function(String, {Offset? position})? onActions,
      void Function(String)? onSwipeRead,
      void Function(String)? onSwipeHide,
      Map<String, SidebarProfile> profiles = const {},
      bool hasActivity = true,
      bool showHidden = false,
    }) => host(
      ShellSidebar(
        bots: [bot('scout', 'Scout')],
        profiles: profiles,
        unread: {
          'scout': hasActivity
              ? wire.UnreadView.fromJson({
                  'schemaVersion': 1,
                  'botId': 'scout',
                  'count': 2,
                  'capped': false,
                  'unread': true,
                  'manuallyUnread': false,
                  'notificationsEnabled': true,
                  'working': false,
                  'lastActivityCursor': 'message-00000000000000000002',
                })
              : unread(botId: 'scout'),
        },
        archived: const {},
        activeBotId: null,
        focusedBotId: null,
        workingBotId: null,
        loaded: true,
        showHidden: showHidden,
        onSelect: (_) {},
        onCreateBot: () {},
        onSearch: () {},
        onProfile: () {},
        onMarketplace: () {},
        onToggleHidden: () {},
        onRetry: () async {},
        onActions: onActions,
        onSwipeRead: onSwipeRead,
        onSwipeHide: onSwipeHide,
        phone: phone,
      ),
    );

    testWidgets('a long press asks for the actions with no position', (
      tester,
    ) async {
      final asked = <(String, Offset?)>[];
      await tester.pumpWidget(
        sidebar(
          phone: true,
          onActions: (botId, {position}) => asked.add((botId, position)),
        ),
      );
      await tester.longPress(byIdentifier(ShellIds.sidebarBot('scout')));
      await tester.pumpAndSettle();
      expect(asked, [('scout', null)]);
    });

    testWidgets('a secondary click asks for them at the pointer', (
      tester,
    ) async {
      final asked = <(String, Offset?)>[];
      await tester.pumpWidget(
        sidebar(
          phone: false,
          onActions: (botId, {position}) => asked.add((botId, position)),
        ),
      );
      final where = tester.getCenter(
        byIdentifier(ShellIds.sidebarBot('scout')),
      );
      await tester.tapAt(where, buttons: kSecondaryButton);
      await tester.pumpAndSettle();
      expect(asked, hasLength(1));
      expect(asked.single.$1, 'scout');
      expect(asked.single.$2, where);
    });

    testWidgets('a desktop row grows its control under the pointer', (
      tester,
    ) async {
      final asked = <(String, Offset?)>[];
      await tester.pumpWidget(
        sidebar(
          phone: false,
          onActions: (botId, {position}) => asked.add((botId, position)),
        ),
      );
      expect(byIdentifier(BotActionIds.menu('scout')), findsNothing);
      final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
      await mouse.addPointer(location: Offset.zero);
      addTearDown(mouse.removePointer);
      await mouse.moveTo(
        tester.getCenter(byIdentifier(ShellIds.sidebarBot('scout'))),
      );
      await tester.pumpAndSettle();
      expect(byIdentifier(BotActionIds.menu('scout')), findsOneWidget);
      await tester.tap(byIdentifier(BotActionIds.menu('scout')));
      await tester.pumpAndSettle();
      // A position, so the list opens as a menu at the control, not a sheet.
      expect(asked, hasLength(1));
      expect(asked.single.$1, 'scout');
      expect(asked.single.$2, isNotNull);
    });

    testWidgets('a phone row has no control and no menu on hover', (
      tester,
    ) async {
      await tester.pumpWidget(
        sidebar(phone: true, onActions: (botId, {position}) {}),
      );
      final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
      await mouse.addPointer(location: Offset.zero);
      addTearDown(mouse.removePointer);
      await mouse.moveTo(
        tester.getCenter(byIdentifier(ShellIds.sidebarBot('scout'))),
      );
      await tester.pumpAndSettle();
      expect(byIdentifier(BotActionIds.menu('scout')), findsNothing);
    });

    testWidgets('a swipe towards the trailing edge marks read and comes back', (
      tester,
    ) async {
      final read = <String>[];
      await tester.pumpWidget(
        sidebar(
          phone: true,
          onSwipeRead: read.add,
          onSwipeHide: (_) => fail('a read swipe never hides'),
        ),
      );
      final row = byIdentifier(ShellIds.sidebarBot('scout'));
      final before = tester.getTopLeft(row);
      await slowDrag(tester, row, Offset(tester.getSize(row).width / 2, 0));
      await tester.pumpAndSettle();
      expect(read, ['scout']);
      expect(tester.getTopLeft(row), before);
    });

    testWidgets('a short swipe marks nothing', (tester) async {
      await tester.pumpWidget(
        sidebar(
          phone: true,
          onSwipeRead: (_) => fail('too short to mean it'),
          onSwipeHide: (_) => fail('wrong way'),
        ),
      );
      await slowDrag(
        tester,
        byIdentifier(ShellIds.sidebarBot('scout')),
        const Offset(60, 0),
      );
      await tester.pumpAndSettle();
    });

    testWidgets(
      'a swipe towards the leading edge reveals Hide, and Hide is a tap',
      (tester) async {
        final hidden = <String>[];
        await tester.pumpWidget(
          sidebar(
            phone: true,
            onSwipeRead: (_) => fail('wrong way'),
            onSwipeHide: hidden.add,
          ),
        );
        final row = byIdentifier(ShellIds.sidebarBot('scout'));
        final before = tester.getTopLeft(row);
        await slowDrag(tester, row, const Offset(-120, 0));
        await tester.pumpAndSettle();
        // The swipe alone hides nothing: the row stays slid over the button.
        expect(hidden, isEmpty);
        expect(tester.getTopLeft(row).dx, lessThan(before.dx));
        await tester.tap(byIdentifier(BotActionIds.swipeHide('scout')));
        await tester.pumpAndSettle();
        expect(hidden, ['scout']);
        expect(tester.getTopLeft(row), before);
      },
    );

    testWidgets('a long swipe hides on release, no tap needed', (tester) async {
      final hidden = <String>[];
      await tester.pumpWidget(
        sidebar(
          phone: true,
          onSwipeRead: (_) => fail('wrong way'),
          onSwipeHide: hidden.add,
        ),
      );
      final row = byIdentifier(ShellIds.sidebarBot('scout'));
      await slowDrag(tester, row, Offset(-tester.getSize(row).width * 0.7, 0));
      await tester.pumpAndSettle();
      expect(hidden, ['scout']);
    });

    testWidgets('opening a second row closes the first', (tester) async {
      await tester.pumpWidget(
        host(
          ShellSidebar(
            bots: [bot('scout', 'Scout'), bot('rosemary', 'Rosemary')],
            profiles: const {},
            unread: const {},
            archived: const {},
            activeBotId: null,
            focusedBotId: null,
            workingBotId: null,
            loaded: true,
            showHidden: false,
            onSelect: (_) {},
            onCreateBot: () {},
            onSearch: () {},
            onProfile: () {},
            onMarketplace: () {},
            onToggleHidden: () {},
            onRetry: () async {},
            onSwipeHide: (_) {},
            phone: true,
          ),
        ),
      );
      final scout = byIdentifier(ShellIds.sidebarBot('scout'));
      final rosemary = byIdentifier(ShellIds.sidebarBot('rosemary'));
      final scoutAt = tester.getTopLeft(scout);
      await slowDrag(tester, scout, const Offset(-120, 0));
      await tester.pumpAndSettle();
      expect(tester.getTopLeft(scout).dx, lessThan(scoutAt.dx));
      await slowDrag(tester, rosemary, const Offset(-120, 0));
      await tester.pumpAndSettle();
      expect(tester.getTopLeft(scout), scoutAt);
      expect(byIdentifier(BotActionIds.swipeHide('rosemary')), findsOneWidget);
    });

    testWidgets('a hidden row reveals no Hide', (tester) async {
      await tester.pumpWidget(
        sidebar(
          phone: true,
          showHidden: true,
          profiles: const {'scout': SidebarProfile(hiddenFromSidebar: true)},
          onSwipeRead: (_) => fail('wrong way'),
          onSwipeHide: (_) => fail('already hidden'),
        ),
      );
      final row = byIdentifier(ShellIds.sidebarBot('scout'));
      final before = tester.getTopLeft(row);
      await slowDrag(tester, row, const Offset(-120, 0));
      await tester.pumpAndSettle();
      expect(tester.getTopLeft(row), before);
      expect(byIdentifier(BotActionIds.swipeHide('scout')), findsNothing);
    });

    testWidgets('a Bot nothing has been said about does not swipe to mark', (
      tester,
    ) async {
      await tester.pumpWidget(
        sidebar(
          phone: true,
          hasActivity: false,
          onSwipeRead: (_) => fail('nothing to mark'),
          onSwipeHide: (_) => fail('wrong way'),
        ),
      );
      final row = byIdentifier(ShellIds.sidebarBot('scout'));
      await slowDrag(tester, row, Offset(tester.getSize(row).width / 2, 0));
      await tester.pumpAndSettle();
    });

    testWidgets('a desktop row does not swipe', (tester) async {
      await tester.pumpWidget(
        sidebar(
          phone: false,
          onSwipeRead: (_) => fail('a desktop has no swipe'),
          onSwipeHide: (_) => fail('a desktop has no swipe'),
        ),
      );
      final row = byIdentifier(ShellIds.sidebarBot('scout'));
      final before = tester.getTopLeft(row);
      await slowDrag(tester, row, Offset(tester.getSize(row).width / 2, 0));
      await tester.pumpAndSettle();
      expect(tester.getTopLeft(row), before);
    });
  });

  group('the sheet', () {
    testWidgets('lists the actions and answers with the one chosen', (
      tester,
    ) async {
      BotAction? chosen;
      await tester.pumpWidget(
        host(
          Builder(
            builder: (context) => TextButton(
              onPressed: () async {
                chosen = await showBotActions(
                  context: context,
                  botName: 'Scout',
                  actions: botActionsFor(const BotActionState(unread: true)),
                );
              },
              child: const Text('open'),
            ),
          ),
        ),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      expect(find.text('Scout'), findsOneWidget);
      expect(find.text('Mark as read'), findsOneWidget);
      expect(find.text('Delete'), findsNothing);
      await tester.tap(byIdentifier(BotActionIds.item(BotAction.hide)));
      await tester.pumpAndSettle();
      expect(chosen, BotAction.hide);
    });

    testWidgets('the label picker offers what the list already groups by', (
      tester,
    ) async {
      String? chosen;
      await tester.pumpWidget(
        host(
          Builder(
            builder: (context) => TextButton(
              onPressed: () async {
                chosen = await showBotLabelPicker(
                  context: context,
                  botName: 'Scout',
                  current: 'Work',
                  existing: const ['Work', 'home', ' ', 'Work'],
                );
              },
              child: const Text('open'),
            ),
          ),
        ),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      expect(byIdentifier(BotActionIds.labelChoice('work')), findsOneWidget);
      expect(byIdentifier(BotActionIds.labelChoice('home')), findsOneWidget);
      await tester.tap(byIdentifier(BotActionIds.labelClear));
      await tester.pumpAndSettle();
      expect(chosen, '');
    });
  });
}
