/// Review stills for Group Chats — the list, the thread, the members at work —
/// kept outside the repository: `--dart-define=CHAT_SHOTS=<dir>`. Without a
/// directory the scene is skipped: it draws, it does not assert.
library;

import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart' show FontLoader, rootBundle;
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/groups/api.dart';
import 'package:frockbot_native/groups/faces.dart';
import 'package:frockbot_native/groups/model.dart';
import 'package:frockbot_native/groups/pane.dart';
import 'package:frockbot_native/groups/thread.dart';
import 'package:frockbot_native/protocol/client_wire.generated.dart' as wire;
import 'package:frockbot_native/shell/sidebar.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'groups_test.dart' show GroupApi, groupId, page, record, text;
import 'widget_test.dart' show MemoryStore;

const _out = String.fromEnvironment('CHAT_SHOTS');
final _boundary = GlobalKey();

const _faces = {
  'fox': GroupFace(
    botId: 'fox',
    name: 'Fox',
    characterId: 'fox',
    primary: '#ff9c35',
  ),
  'ledger': GroupFace(
    botId: 'ledger',
    name: 'Ledger',
    characterId: 'guardian',
    primary: '#6578ee',
  ),
  'pixel': GroupFace(
    botId: 'pixel',
    name: 'Pixel',
    characterId: 'pixel',
    primary: '#fc85ae',
  ),
};

wire.BotRegistration _bot(String botId, String name, String character) =>
    wire.BotRegistration.fromJson({
      'schemaVersion': 1,
      'botId': botId,
      'registeredAt': '2026-09-05T00:00:00.000Z',
      'initialName': name,
      'avatar': {
        'schemaVersion': 1,
        'characterId': character,
        'primary': _faces[botId]?.primary ?? '#59c7ff',
      },
    });

void main() {
  testWidgets('a Group Chat among the Bots, with its members at work', (
    tester,
  ) async {
    if (_out.isEmpty) return;
    await tester.runAsync(() async {
      final inter = FontLoader('Inter');
      for (final weight in [400, 500, 600, 700]) {
        inter.addFont(rootBundle.load('assets/fonts/inter-latin-$weight.ttf'));
      }
      await inter.load();
      await (FontLoader(
        'MaterialIcons',
      )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
    });
    tester.view.physicalSize = const Size(2560, 1440);
    tester.view.devicePixelRatio = 2;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final store = MemoryStore();
    final native = GroupApi(store, (path, body) async {
      if (path == '/api/groups/$groupId') {
        return {
          'schemaVersion': 1,
          'group': record(name: 'Launch', members: ['fox', 'ledger', 'pixel']),
          'members': [
            {'botId': 'fox', 'name': 'Fox'},
            {'botId': 'ledger', 'name': 'Ledger'},
            {'botId': 'pixel', 'name': 'Pixel'},
          ],
          'head': 4,
          'readThrough': 4,
          'unread': 0,
          'working': ['ledger', 'pixel'],
        };
      }
      return page([
        text(
          1,
          'We launch on the 14th. @Ledger, can we afford the paid campaign?',
          mentions: [
            {'botId': 'ledger', 'start': 23, 'end': 30},
          ],
        ),
        text(
          2,
          'Yes, if it stays under **\$12,000**. That keeps nine months of '
          'runway after the launch.',
          botId: 'ledger',
        ),
        text(
          3,
          'Then I’ll plan it at \$10,000 across two weeks. @Pixel, three '
          'hero images for the ads?',
          botId: 'fox',
          mentions: [
            {'botId': 'pixel', 'start': 47, 'end': 53},
          ],
        ),
        text(4, 'Go ahead. Keep them in our colours.'),
      ]);
    });
    final controller = GroupThreadController(
      api: GroupChatApi(native),
      store: store,
      userId: 'user-1',
      groupId: groupId,
    );
    await tester.runAsync(controller.initialize);
    controller.applyState(const GroupState(4, 4, ['ledger', 'pixel']));
    addTearDown(controller.dispose);

    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: FrockTheme.theme(Brightness.dark),
        home: RepaintBoundary(
          key: _boundary,
          child: Scaffold(
            body: Row(
              children: [
                SizedBox(
                  width: 300,
                  child: ShellSidebar(
                    bots: [
                      _bot('fox', 'Fox', 'fox'),
                      _bot('ledger', 'Ledger', 'guardian'),
                      _bot('pixel', 'Pixel', 'pixel'),
                      _bot('general', 'General', 'chill'),
                    ],
                    groupChats: [
                      SidebarGroupChat(
                        groupId: groupId,
                        name: 'Launch',
                        faces: _faces.values.toList(),
                        profile: const SidebarProfile(
                          name: 'Launch',
                          sidebarOrder: 0,
                        ),
                        working: true,
                      ),
                    ],
                    profiles: const {},
                    unread: const {},
                    archived: const {},
                    activeBotId: null,
                    activeGroupId: groupId,
                    focusedBotId: null,
                    workingBotId: null,
                    loaded: true,
                    showHidden: false,
                    onSelect: (_) {},
                    onCreateBot: () {},
                    onCreateGroup: () {},
                    onSearch: () {},
                    onProfile: () {},
                    onWhatsNew: () {},
                    onMarketplace: () {},
                    onToggleHidden: () {},
                    onRetry: () async {},
                  ),
                ),
                const VerticalDivider(width: 1),
                Expanded(
                  child: GroupChatPane(
                    controller: controller,
                    name: 'Launch',
                    faceOf: (botId) => _faces[botId],
                    focused: false,
                    phone: false,
                    onOpenMembers: () {},
                    onReconnect: () {},
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(seconds: 1)),
    );
    await tester.pump(const Duration(milliseconds: 600));
    await tester.runAsync(() async {
      final image =
          await (_boundary.currentContext!.findRenderObject()!
                  as RenderRepaintBoundary)
              .toImage(pixelRatio: 2);
      final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
      await File('$_out/group-chats.png')
          .writeAsBytes(bytes!.buffer.asUint8List());
      image.dispose();
    });
  });
}
