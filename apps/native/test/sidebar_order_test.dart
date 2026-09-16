/// The writes a drop on the Bot list plans, without a widget in sight.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/shell/sidebar.dart';
import 'package:frockbot_native/shell/sidebar_order.dart';

void main() {
  group('planSidebarDropV1', () {
    test('numbers a group that was never ordered, the drop included', () {
      // Nobody has dragged anything: every row is where the directory put
      // it. Dropping d above c must number a and b too, because a Bot with no
      // number sits after every Bot that has one.
      final writes = planSidebarDropV1(
        const SidebarDrop(
          botId: 'd',
          label: '',
          beforeBotId: 'c',
          group: ['a', 'b', 'c', 'd'],
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
        const SidebarDrop(
          botId: 'c',
          label: '',
          beforeBotId: 'b',
          group: ['a', 'b', 'c'],
        ),
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
        const SidebarDrop(
          botId: 'a',
          label: '',
          beforeBotId: null,
          group: ['a', 'b'],
        ),
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
        const SidebarDrop(
          botId: 'c',
          label: '',
          beforeBotId: 'b',
          group: ['a', 'b', 'c'],
        ),
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

    test('a drop into another label carries the label on the same patch', () {
      final writes = planSidebarDropV1(
        const SidebarDrop(
          botId: 'x',
          label: 'Work',
          beforeBotId: 'b',
          group: ['a', 'b'],
        ),
        const {
          'x': SidebarProfile(label: 'Home', sidebarOrder: 0),
          'a': SidebarProfile(label: 'Work', sidebarOrder: 0),
          'b': SidebarProfile(label: 'Work', sidebarOrder: 1000),
        },
      );
      expect(writes, [
        const SidebarProfileWrite('x', {'label': 'Work', 'sidebarOrder': 500}),
      ]);
    });

    test('a drop into Unassigned clears the label', () {
      final writes = planSidebarDropV1(
        const SidebarDrop(
          botId: 'x',
          label: '',
          beforeBotId: null,
          group: ['a'],
        ),
        const {
          'x': SidebarProfile(label: 'Work', sidebarOrder: 0),
          'a': SidebarProfile(sidebarOrder: 0),
        },
      );
      expect(writes, [
        const SidebarProfileWrite('x', {'label': '', 'sidebarOrder': 1000}),
      ]);
    });

    test('the same label in another case is not a move between labels', () {
      final writes = planSidebarDropV1(
        const SidebarDrop(
          botId: 'x',
          label: 'Work',
          beforeBotId: null,
          group: ['a', 'x'],
        ),
        const {
          'x': SidebarProfile(label: ' work ', sidebarOrder: 0),
          'a': SidebarProfile(label: 'Work', sidebarOrder: 1000),
        },
      );
      expect(writes, [
        const SidebarProfileWrite('x', {'sidebarOrder': 2000}),
      ]);
    });

    test('a row let go where it was, or on itself, writes nothing', () {
      const profiles = {
        'a': SidebarProfile(sidebarOrder: 0),
        'b': SidebarProfile(sidebarOrder: 1000),
      };
      expect(
        planSidebarDropV1(
          const SidebarDrop(
            botId: 'a',
            label: '',
            beforeBotId: 'b',
            group: ['a', 'b'],
          ),
          profiles,
        ),
        isEmpty,
      );
      expect(
        planSidebarDropV1(
          const SidebarDrop(
            botId: 'a',
            label: '',
            beforeBotId: 'a',
            group: ['a', 'b'],
          ),
          profiles,
        ),
        isEmpty,
      );
      // A target the group does not hold is not a place.
      expect(
        planSidebarDropV1(
          const SidebarDrop(
            botId: 'a',
            label: '',
            beforeBotId: 'zed',
            group: ['a', 'b'],
          ),
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
      const before = SidebarProfile(
        name: 'Scout',
        label: 'Work',
        sidebarOrder: 3,
      );
      expect(before.patched({'label': '', 'sidebarOrder': 9}).label, '');
      expect(before.patched({'label': '', 'sidebarOrder': 9}).sidebarOrder, 9);
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
