import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/groups/api.dart';
import 'package:frockbot_native/groups/faces.dart';
import 'package:frockbot_native/groups/lines.dart';
import 'package:frockbot_native/groups/model.dart';
import 'package:frockbot_native/groups/pane.dart';
import 'package:frockbot_native/groups/thread.dart';
import 'package:frockbot_native/shell/semantics.dart';
import 'package:frockbot_native/shell/sidebar.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'groups_test.dart'
    show GroupApi, at, event, groupId, page, record, text, view;
import 'shell_layout_test.dart' show bot, byIdentifier, host;
import 'widget_test.dart' show MemoryStore;

const faces = {
  'general': GroupFace(
    botId: 'general',
    name: 'General',
    characterId: 'pixel',
    primary: '#fc85ae',
  ),
  'xero': GroupFace(
    botId: 'xero',
    name: 'Xero Books',
    characterId: 'guardian',
    primary: '#3c3543',
  ),
  'codex': GroupFace(botId: 'codex', name: 'Codex', characterId: 'sunny'),
};

const members = [
  GroupMemberInfo('general', 'General'),
  GroupMemberInfo('xero', 'Xero Books'),
];

void main() {
  test('/stop reads every member, one member by name, or nobody', () {
    expect(parseGroupStop('/stop', members), isA<GroupStopAll>());
    expect(
      (parseGroupStop('/stop @xero books', members)! as GroupStopOne).botId,
      'xero',
    );
    expect(
      (parseGroupStop('/stop @Codex', members)! as GroupStopUnknown).name,
      'Codex',
    );
    expect(parseGroupStop('please /stop', members), isNull);
    expect(parseGroupStop('/stopping', members), isNull);
  });

  test('an @ starts a mention only at the start of a word', () {
    expect(activeMention('ask @Xe', 7), (start: 4, query: 'Xe'));
    expect(activeMention('@', 1), (start: 0, query: ''));
    expect(activeMention('me@host', 7), isNull);
    expect(activeMention('@Xero\nnext', 10), isNull);
    expect(
      mentionCandidates([
        ...members,
        const GroupMemberInfo('codex', 'Codex'),
      ], 'e').map((m) => m.name),
      // Those whose name starts with the query first.
      ['General', 'Xero Books', 'Codex'],
    );
    expect(mentionCandidates(members, 'x').map((m) => m.name), ['Xero Books']);
  });

  test('change lines say who did what', () {
    String name(String botId) => faces[botId]!.name;
    expect(
      groupEventText(
        const GroupEvent('created', members: ['general', 'xero', 'codex']),
        null,
        name,
      ),
      'You started the group with General, Xero Books & Codex.',
    );
    expect(
      groupEventText(
        const GroupEvent('renamed', name: 'Books'),
        'general',
        name,
      ),
      'General renamed the group “Books”.',
    );
    expect(
      groupEventText(
        const GroupEvent('member-removed', botId: 'xero'),
        'xero',
        name,
      ),
      'Xero Books left the group.',
    );
    expect(
      groupEventText(
        const GroupEvent('member-removed', botId: 'xero'),
        null,
        name,
      ),
      'You removed Xero Books.',
    );
    expect(
      groupEventText(
        const GroupEvent('turn-failed', botId: 'xero', runId: 'r1'),
        null,
        name,
      ),
      'Xero Books couldn’t finish its reply.',
    );
  });

  test('a badge writes in whichever of black and white reads', () {
    expect(badgeInkFor(const Color(0xffffc928)), Colors.black);
    expect(badgeInkFor(const Color(0xff3c3543)), Colors.white);
    expect(badgeNeedsOutline(const Color(0xfffcf6e3)), isTrue);
    expect(badgeNeedsOutline(const Color(0xfffc85ae)), isFalse);
  });

  testWidgets('three faces are drawn and the rest are counted', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Center(
          child: GroupAvatars(
            faces: [
              ...faces.values,
              const GroupFace(botId: 'a', name: 'A', characterId: 'cat'),
              const GroupFace(botId: 'b', name: 'B', characterId: 'dog'),
            ],
          ),
        ),
      ),
    );
    expect(find.byType(Image), findsNWidgets(3));
    expect(find.text('+2'), findsOneWidget);
  });

  group('the pane', () {
    late MemoryStore store;
    late GroupApi native;
    late Object? Function(String, Object?) answer;
    var ids = 0;

    setUp(() {
      ids = 0;
      store = MemoryStore();
      answer = (path, body) {
        if (path == '/api/groups/$groupId') return view(readThrough: 1);
        if (path.startsWith('/api/groups/$groupId/messages?limit')) {
          return page([
            text(
              1,
              '@Xero Books what is left?',
              mentions: [
                {'botId': 'xero', 'start': 0, 'end': 11},
              ],
            ),
            text(
              2,
              r'$420, @General.',
              botId: 'xero',
              mentions: [
                {'botId': 'general', 'start': 6, 'end': 14},
              ],
            ),
            event(3, {
              'type': 'turn-failed',
              'botId': 'general',
              'runId': 'r1',
            }),
          ]);
        }
        if (path == '/api/groups/$groupId/retry') return {'schemaVersion': 1};
        if (path == '/api/groups/$groupId/read') {
          return {'schemaVersion': 1, 'readThrough': 3};
        }
        throw StateError('unexpected $path');
      };
      native = GroupApi(store, (path, body) async => answer(path, body));
    });

    Future<GroupThreadController> pump(WidgetTester tester) async {
      final controller = GroupThreadController(
        api: GroupChatApi(native),
        store: store,
        userId: 'user-1',
        groupId: groupId,
        nextId: () => 'cmd-${++ids}',
      );
      await tester.runAsync(controller.initialize);
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: Scaffold(
            body: GroupChatPane(
              controller: controller,
              name: 'Books',
              faceOf: (botId) => faces[botId],
              focused: true,
              phone: false,
              onOpenMembers: () {},
              onReconnect: () {},
            ),
          ),
        ),
      );
      await tester.pump();
      addTearDown(controller.dispose);
      return controller;
    }

    testWidgets('draws badges, mention chips and the failed Turn', (
      tester,
    ) async {
      await pump(tester);
      // The Bot's message opens with its badge; the person's does not.
      expect(find.widgetWithText(BotBadge, 'Xero Books'), findsOneWidget);
      // Both mentions are chips, drawn in the named Bot's colour.
      expect(find.text('@Xero Books'), findsOneWidget);
      expect(find.text('@General'), findsOneWidget);
      expect(find.text('General couldn’t finish its reply.'), findsOneWidget);
      expect(find.text('Unread from here'), findsOneWidget);
      expect(find.text('Message Books'), findsOneWidget);

      await tester.tap(find.text('Retry'));
      await tester.runAsync(() => Future<void>.delayed(Duration.zero));
      expect(
        native.requests.map((r) => r.path),
        contains('/api/groups/$groupId/retry'),
      );
      expect(native.requests.lastWhere((r) => r.path.endsWith('/retry')).body, {
        'schemaVersion': 1,
        'commandId': 'cmd-1',
        'botId': 'general',
        'runId': 'r1',
      });
    });

    testWidgets('@ offers the members, and choosing one writes its name', (
      tester,
    ) async {
      await pump(tester);
      final field = find.byType(TextField);
      await tester.enterText(field, 'ask @xe');
      await tester.pump();
      expect(byIdentifier(GroupIds.mentionOption('xero')), findsOneWidget);
      expect(byIdentifier(GroupIds.mentionOption('general')), findsNothing);
      await tester.tap(find.text('Xero Books').last);
      await tester.pump();
      expect(
        tester.widget<TextField>(field).controller!.text,
        'ask @Xero Books ',
      );
    });

    testWidgets('/stop names who is not working, and sends nothing', (
      tester,
    ) async {
      await pump(tester);
      await tester.enterText(find.byType(TextField), '/stop @Xero Books');
      await tester.pump();
      await tester.tap(byIdentifier(GroupIds.send));
      await tester.pump();
      expect(
        find.text('Xero Books isn’t working on anything here.'),
        findsOneWidget,
      );
      expect(
        native.requests.where((r) => r.path.endsWith('/messages')),
        isEmpty,
      );
      await tester.pump(const Duration(seconds: 4));
    });

    testWidgets('members at work stand at the end of the thread', (
      tester,
    ) async {
      final controller = await pump(tester);
      controller.applyState(const GroupState(3, 3, ['xero', 'general']));
      await tester.pump();
      expect(byIdentifier(GroupIds.working), findsOneWidget);
      expect(find.byKey(const ValueKey('group-working-xero')), findsOneWidget);
      expect(
        find.byKey(const ValueKey('group-working-general')),
        findsOneWidget,
      );
      // With someone working and nothing typed, the button stops them all.
      expect(byIdentifier(GroupIds.stop), findsOneWidget);
    });
  });

  group('the list', () {
    Widget sidebar({
      required List<SidebarGroupChat> groups,
      void Function(String)? onSelect,
    }) => host(
      ShellSidebar(
        bots: [bot('general', 'General'), bot('xero', 'Xero Books')],
        groupChats: groups,
        profiles: const {
          'general': SidebarProfile(sidebarOrder: 2000),
          'xero': SidebarProfile(sidebarOrder: 3000),
        },
        unread: const {},
        archived: const {},
        activeBotId: null,
        focusedBotId: null,
        workingBotId: null,
        loaded: true,
        showHidden: false,
        onSelect: onSelect ?? (_) {},
        onCreateBot: () {},
        onCreateGroup: () {},
        onSearch: () {},
        onProfile: () {},
        onWhatsNew: () {},
        onMarketplace: () {},
        onToggleHidden: () {},
        onRetry: () async {},
      ),
    );

    SidebarGroupChat chat({
      SidebarProfile profile = const SidebarProfile(),
      int unread = 0,
    }) => SidebarGroupChat(
      groupId: groupId,
      name: 'Books',
      faces: [faces['general']!, faces['xero']!],
      profile: profile,
      unread: unread,
    );

    testWidgets('a group is a row among the Bots, in its order', (
      tester,
    ) async {
      String? opened;
      await tester.pumpWidget(
        sidebar(
          groups: [
            chat(
              profile: const SidebarProfile(name: 'Books', sidebarOrder: 2500),
              unread: 3,
            ),
          ],
          onSelect: (id) => opened = id,
        ),
      );
      final general = tester.getTopLeft(
        byIdentifier(ShellIds.sidebarBot('general')),
      );
      final group = tester.getTopLeft(byIdentifier(GroupIds.row(groupId)));
      final xero = tester.getTopLeft(byIdentifier(ShellIds.sidebarBot('xero')));
      expect(general.dy < group.dy && group.dy < xero.dy, isTrue);
      expect(find.text('General, Xero Books'), findsOneWidget);
      expect(find.text('3'), findsOneWidget);
      await tester.tap(byIdentifier(GroupIds.row(groupId)));
      expect(opened, sidebarGroupEntryId(groupId));
      expect(byIdentifier(GroupIds.create), findsOneWidget);
    });

    testWidgets('a pinned group is a tile, and a hidden one is not listed', (
      tester,
    ) async {
      await tester.pumpWidget(
        sidebar(
          groups: [chat(profile: const SidebarProfile(pinnedAt: at))],
        ),
      );
      expect(byIdentifier(GroupIds.pinned(groupId)), findsOneWidget);
      expect(byIdentifier(GroupIds.row(groupId)), findsNothing);

      await tester.pumpWidget(
        sidebar(
          groups: [
            chat(profile: const SidebarProfile(hiddenFromSidebar: true)),
          ],
        ),
      );
      expect(byIdentifier(GroupIds.row(groupId)), findsNothing);
      expect(find.text('Show 1 hidden'), findsOneWidget);
    });
  });

  test('a group entry id is never a Bot id', () {
    expect(sidebarGroupIdOf(sidebarGroupEntryId(groupId)), groupId);
    expect(sidebarGroupIdOf('general'), isNull);
    expect(GroupRecord.fromJson(record()).groupId, groupId);
  });
}
