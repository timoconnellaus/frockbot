/// The writes a drop on the Bot list plans, without a widget in sight.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/shell/sidebar.dart';
import 'package:frockbot_native/shell/sidebar_order.dart';

void main() {
  group('planSidebarDropV1', () {
    test('numbers a list that was never ordered, the drop included', () {
      // Nobody has dragged anything: every row is where the directory put
      // it. Dropping d above c must number a and b too, because a Bot with no
      // number sits after every Bot that has one.
      final writes = planSidebarDropV1(
        const SidebarDrop(
          botId: 'd',
          beforeBotId: 'c',
          rows: ['a', 'b', 'c', 'd'],
        ),
        const {},
      );
      expect(writes, [
        const SidebarProfileWrite('d', {'sidebarOrder': 2000}),
        const SidebarProfileWrite('a', {'sidebarOrder': 0}),
        const SidebarProfileWrite('b', {'sidebarOrder': 1000}),
        const SidebarProfileWrite('c', {'sidebarOrder': 3000}),
      ]);
    });

    test('takes the midpoint between ordered neighbours, one write', () {
      final writes = planSidebarDropV1(
        const SidebarDrop(botId: 'c', beforeBotId: 'b', rows: ['a', 'b', 'c']),
        const {
          'a': SidebarProfile(sidebarOrder: 0),
          'b': SidebarProfile(sidebarOrder: 1000),
          'c': SidebarProfile(sidebarOrder: 2000),
        },
      );
      expect(writes, [
        const SidebarProfileWrite('c', {'sidebarOrder': 500}),
      ]);
    });

    test('goes to the end with room to spare after it', () {
      final writes = planSidebarDropV1(
        const SidebarDrop(botId: 'a', beforeBotId: null, rows: ['a', 'b']),
        const {
          'a': SidebarProfile(sidebarOrder: 0),
          'b': SidebarProfile(sidebarOrder: 1000),
        },
      );
      expect(writes, [
        const SidebarProfileWrite('a', {'sidebarOrder': 2000}),
      ]);
    });

    test('moves the row after it along only when there is no room left', () {
      final writes = planSidebarDropV1(
        const SidebarDrop(botId: 'c', beforeBotId: 'b', rows: ['a', 'b', 'c']),
        const {
          'a': SidebarProfile(sidebarOrder: 5),
          'b': SidebarProfile(sidebarOrder: 6),
          'c': SidebarProfile(sidebarOrder: 7),
        },
      );
      expect(writes, [
        const SidebarProfileWrite('c', {'sidebarOrder': 6}),
        const SidebarProfileWrite('b', {'sidebarOrder': 1006}),
      ]);
    });

    test('a row let go where it was, or on itself, writes nothing', () {
      const profiles = {
        'a': SidebarProfile(sidebarOrder: 0),
        'b': SidebarProfile(sidebarOrder: 1000),
      };
      expect(
        planSidebarDropV1(
          const SidebarDrop(botId: 'a', beforeBotId: 'b', rows: ['a', 'b']),
          profiles,
        ),
        isEmpty,
      );
      expect(
        planSidebarDropV1(
          const SidebarDrop(botId: 'a', beforeBotId: 'a', rows: ['a', 'b']),
          profiles,
        ),
        isEmpty,
      );
      // A target the list does not hold is not a place.
      expect(
        planSidebarDropV1(
          const SidebarDrop(botId: 'a', beforeBotId: 'zed', rows: ['a', 'b']),
          profiles,
        ),
        isEmpty,
      );
    });
  });

  group('orderSidebarBots', () {
    test(
      'draws numbered Bots first, lowest first, then the rest as they came',
      () {
        final ordered = orderSidebarBots(
          ['a', 'b', 'c', 'd'],
          (id) => id,
          const {
            'b': SidebarProfile(sidebarOrder: 10),
            'd': SidebarProfile(sidebarOrder: -5),
          },
        );
        expect(ordered, ['d', 'b', 'a', 'c']);
      },
    );

    test('is stable across equal numbers', () {
      final ordered = orderSidebarBots(
        ['a', 'b', 'c'],
        (id) => id,
        const {
          'a': SidebarProfile(sidebarOrder: 1),
          'b': SidebarProfile(sidebarOrder: 1),
          'c': SidebarProfile(sidebarOrder: 0),
        },
      );
      expect(ordered, ['c', 'a', 'b']);
    });
  });

  test(
    'a profile patch is drawn over the profile the way the authority reads it',
    () {
      const before = SidebarProfile(name: 'Scout', sidebarOrder: 3);
      expect(before.patched({'sidebarOrder': 9}).sidebarOrder, 9);
      expect(before.patched({'pinnedAt': 'x'}).sidebarOrder, 3);
      expect(before.patched({'pinnedAt': 'x'}).name, 'Scout');
      expect(
        SidebarProfile.decode({'name': 'Scout', 'sidebarOrder': 4})
            ?.sidebarOrder,
        4,
      );
    },
  );
}
