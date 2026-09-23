import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/chat_controller.dart'
    show ConnectionState;
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/groups/api.dart';
import 'package:frockbot_native/groups/channel.dart';
import 'package:frockbot_native/groups/directory.dart';
import 'package:frockbot_native/groups/model.dart';
import 'package:frockbot_native/groups/thread.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'native_session.dart';
import 'state_channel_test.dart' show FakeSocket;
import 'widget_test.dart' show MemoryStore;

const groupId = 'g-0123456789abcdef0123';
const at = '2026-09-23T10:00:00.000Z';

Map<String, Object?> record({
  String? name,
  List<String> members = const ['general', 'xero'],
  String? pinnedAt,
  String? label,
}) => {
  'schemaVersion': 1,
  'groupId': groupId,
  'name': ?name,
  'members': members,
  'createdAt': at,
  'updatedAt': at,
  'pinnedAt': ?pinnedAt,
  'label': ?label,
};

Map<String, Object?> view({
  int head = 2,
  int readThrough = 0,
  int unread = 1,
  List<String> working = const [],
  Map<String, Object?>? group,
}) => {
  'schemaVersion': 1,
  'group': group ?? record(),
  'members': [
    {'botId': 'general', 'name': 'General'},
    {'botId': 'xero', 'name': 'Xero Books'},
  ],
  'head': head,
  'readThrough': readThrough,
  'unread': unread,
  'working': working,
};

Map<String, Object?> text(
  int seq,
  String words, {
  String? botId,
  List<Map<String, Object?>> mentions = const [],
}) => {
  'schemaVersion': 1,
  'seq': seq,
  'messageId': 'm-$seq',
  'at': at,
  'author': botId == null ? {'kind': 'user'} : {'kind': 'bot', 'botId': botId},
  'body': {'kind': 'text', 'text': words, 'mentions': mentions},
};

Map<String, Object?> event(int seq, Map<String, Object?> event) => {
  'schemaVersion': 1,
  'seq': seq,
  'messageId': 'e-$seq',
  'at': at,
  'author': {'kind': 'user'},
  'body': {'kind': 'event', 'event': event},
};

Map<String, Object?> page(
  List<Map<String, Object?>> messages, {
  bool more = false,
}) => {'schemaVersion': 1, 'messages': messages, 'hasMore': more};

class Recorded {
  final String path;
  final Object? body;
  Recorded(this.path, this.body);
}

/// A NativeApi whose requests a test answers, and whose group socket is a
/// fake the test drives.
class GroupApi extends NativeSessionApi {
  final requests = <Recorded>[];
  final sockets = <FakeSocket>[];
  GroupApi(super.store, super.handler);

  @override
  Future<Object?> request(
    String path, {
    Object? body,
    int limit = 512000,
    bool authenticated = true,
  }) {
    requests.add(Recorded(path, body));
    return super.request(path, body: body);
  }

  @override
  Future<WebSocketChannel> groupSocket(String groupId) async {
    final socket = FakeSocket();
    sockets.add(socket);
    return socket;
  }
}

void main() {
  test('an unnamed group is called by its members, as the server calls it', () {
    final group = GroupRecord.fromJson(
      record(members: ['general', 'xero', 'codex']),
    );
    final names = {'general': 'General', 'xero': 'Xero Books'};
    expect(
      groupDisplayName(group, (id) => names[id] ?? id),
      'General, Xero Books & codex',
    );
    expect(
      groupDisplayName(GroupRecord.fromJson(record(name: 'Books')), (id) => id),
      'Books',
    );
  });

  test('a malformed answer is refused before anything reads it', () async {
    final store = MemoryStore();
    final api = GroupChatApi(
      NativeSessionApi(store, (_, _) async => {'schemaVersion': 1}),
    );
    await expectLater(api.list(), throwsA(anything));
    // A command the server would refuse is refused here first.
    await expectLater(
      api.create(commandId: 'c1', members: ['general']),
      throwsA(anything),
    );
  });

  group('a thread', () {
    late MemoryStore store;
    late GroupApi native;
    late Object? Function(String, Object?) answer;
    var ids = 0;

    GroupThreadController thread() => GroupThreadController(
      api: GroupChatApi(native),
      store: store,
      userId: 'user-1',
      groupId: groupId,
      nextId: () => 'cmd-${++ids}',
    );

    setUp(() {
      ids = 0;
      store = MemoryStore();
      answer = (path, body) {
        if (path == '/api/groups/$groupId') return view();
        if (path.startsWith('/api/groups/$groupId/messages?limit')) {
          return page([
            text(1, '@Xero Books what is left?'),
            text(2, r'$420.', botId: 'xero'),
          ]);
        }
        throw StateError('unexpected $path');
      };
      native = GroupApi(store, (path, body) async => answer(path, body));
    });

    test('opens on its newest page, and reads on as the head moves', () async {
      final controller = thread();
      await controller.initialize();
      expect(controller.ready, isTrue);
      expect(controller.messages.map((m) => m.seq), [1, 2]);
      expect(controller.view!.nameOf('xero'), 'Xero Books');

      answer = (path, body) {
        if (path == '/api/groups/$groupId/messages?after=2&limit=100') {
          return page([
            event(3, {'type': 'member-added', 'botId': 'codex'}),
            text(4, 'Hello, I am Codex.', botId: 'codex'),
          ]);
        }
        if (path == '/api/groups/$groupId/messages?after=4&limit=100') {
          return page([]);
        }
        if (path == '/api/groups/$groupId') {
          return view(
            head: 4,
            working: ['codex'],
            group: record(members: ['general', 'xero', 'codex']),
          );
        }
        throw StateError('unexpected $path');
      };
      controller.applyState(const GroupState(4, 2, ['codex']));
      // The frame started the read; this waits behind it.
      await controller.catchUp();
      expect(controller.messages.map((m) => m.seq), [1, 2, 3, 4]);
      expect(controller.working, ['codex']);
      // A member joined, so the group was read again.
      expect(controller.view!.group.members, ['general', 'xero', 'codex']);
    });

    test(
      'keeps a send before it posts, and confirms it by its command id',
      () async {
        final controller = thread();
        await controller.initialize();
        final posted = Completer<Object?>();
        answer = (path, body) {
          if (path == '/api/groups/$groupId/messages') return posted.future;
          throw StateError('unexpected $path');
        };
        final sending = controller.send('  @Xero Books pay it.  ');
        await Future<void>.delayed(Duration.zero);
        expect(controller.pending.single.text, '@Xero Books pay it.');
        final saved = jsonDecode(store.values[controller.key]!) as Map;
        expect(saved['pending'], [
          {'commandId': 'cmd-1', 'text': '@Xero Books pay it.'},
        ]);
        expect(native.requests.last.body, {
          'schemaVersion': 1,
          'commandId': 'cmd-1',
          'text': '@Xero Books pay it.',
        });
        posted.complete({
          'schemaVersion': 1,
          'message': text(3, '@Xero Books pay it.'),
        });
        await sending;
        expect(controller.pending, isEmpty);
        expect(controller.messages.last.seq, 3);
      },
    );

    test(
      'a refused send goes back to the draft; a lost one waits to go again',
      () async {
        final controller = thread();
        await controller.initialize();
        answer = (path, body) =>
            throw const RequestFailure('only a member may post', 409);
        await controller.send('first');
        expect(controller.pending, isEmpty);
        expect(controller.draft, 'first');
        expect(controller.error, 'only a member may post');

        controller.draft = '';
        answer = (path, body) =>
            throw const RequestFailure('Couldn’t reach FrockBot.');
        await controller.send('second');
        expect(controller.pending.single.failed, isTrue);

        answer = (path, body) => {
          'schemaVersion': 1,
          'message': text(3, 'second'),
        };
        await controller.resend(controller.pending.single.commandId);
        expect(controller.pending, isEmpty);
        // The same command id: if the first attempt arrived, this is it.
        expect((native.requests.last.body as Map)['commandId'], 'cmd-2');
      },
    );

    test('a send restored from an earlier run waits for the person', () async {
      store.values['group/user-1/$groupId'] = jsonEncode({
        'version': 1,
        'draft': 'half a thought',
        'pending': [
          {'commandId': 'old-1', 'text': 'sent before the app closed'},
        ],
      });
      final controller = thread();
      await controller.initialize();
      expect(controller.draft, 'half a thought');
      expect(controller.pending.single.commandId, 'old-1');
      expect(controller.pending.single.failed, isTrue);
    });

    test('reads, stops and retries through the group', () async {
      final controller = thread();
      await controller.initialize();
      answer = (path, body) => switch (path) {
        '/api/groups/$groupId/read' => {'schemaVersion': 1, 'readThrough': 2},
        '/api/groups/$groupId/stop' => {
          'schemaVersion': 1,
          'stopped': ['xero'],
        },
        '/api/groups/$groupId/retry' => {'schemaVersion': 1},
        _ => throw StateError('unexpected $path'),
      };
      await controller.markRead();
      expect(controller.readThrough, 2);
      // Nothing new since: no second read.
      final before = native.requests.length;
      await controller.markRead();
      expect(native.requests.length, before);

      await controller.stop(botId: 'xero');
      await controller.retry('xero', 'grp-0123');
      expect(native.requests.map((r) => r.body).skip(before), [
        {'schemaVersion': 1, 'commandId': 'cmd-1', 'botId': 'xero'},
        {
          'schemaVersion': 1,
          'commandId': 'cmd-2',
          'botId': 'xero',
          'runId': 'grp-0123',
        },
      ]);
    });
  });

  group('the list of groups', () {
    test('lists groups with their unread counts', () async {
      final store = MemoryStore();
      final native = GroupApi(store, (path, body) async {
        if (path == '/api/groups') {
          return {
            'schemaVersion': 1,
            'revision': 1,
            'groups': [record(name: 'Books')],
          };
        }
        if (path == '/api/groups/$groupId') return view(unread: 3);
        throw StateError('unexpected $path');
      });
      final directory = GroupDirectoryController(GroupChatApi(native));
      await directory.load();
      expect(directory.active.single.name, 'Books');
      expect(directory.unread[groupId], 3);
    });

    test('an arrangement shows at once and is put back when refused', () async {
      final store = MemoryStore();
      var refuse = false;
      final native = GroupApi(store, (path, body) async {
        if (path == '/api/groups') {
          return {
            'schemaVersion': 1,
            'revision': 1,
            'groups': [record()],
          };
        }
        if (path == '/api/groups/$groupId') return view();
        if (path == '/api/groups/$groupId/commands') {
          if (refuse) throw const RequestFailure('no', 409);
          return {
            'schemaVersion': 1,
            'commandId': (body as Map)['commandId'],
            'groupId': groupId,
            'status': 'applied',
            'group': record(pinnedAt: at, label: 'Work'),
            'revision': 2,
          };
        }
        throw StateError('unexpected $path');
      });
      final directory = GroupDirectoryController(
        GroupChatApi(native),
        nextId: () => 'arrange-1',
      );
      await directory.load();
      await directory.arrange(groupId, pinned: true, label: 'Work');
      expect(native.requests.last.body, {
        'type': 'group/arrange',
        'label': 'Work',
        'pinned': true,
        'commandId': 'arrange-1',
        'groupId': groupId,
      });
      expect(directory.byId(groupId)!.pinnedAt, at);

      refuse = true;
      final pinned = directory.byId(groupId)!;
      final undo = directory.arrange(groupId, pinned: false);
      // Shown at once…
      expect(directory.byId(groupId)!.pinnedAt, isNull);
      await expectLater(undo, throwsA(isA<RequestFailure>()));
      // …and put back.
      expect(directory.byId(groupId)!.pinnedAt, pinned.pinnedAt);
    });
  });

  test(
    'the channel applies each frame and reconnects when it closes',
    () async {
      final store = MemoryStore();
      final native = GroupApi(store, (_, _) async => null);
      final states = <GroupState>[];
      final statuses = <ConnectionState>[];
      final channel = GroupStateChannel(
        api: native,
        groupId: groupId,
        apply: states.add,
        status: statuses.add,
      );
      await channel.connect();
      native.sockets.single.frames.add(
        jsonEncode({
          'schemaVersion': 1,
          'type': 'group/state',
          'head': 4,
          'readThrough': 2,
          'working': ['xero'],
        }),
      );
      await Future<void>.delayed(Duration.zero);
      expect(states.single.head, 4);
      expect(statuses, [
        ConnectionState.initializing,
        ConnectionState.connected,
      ]);

      // Anything that is not a group frame closes the socket and backs off.
      native.sockets.single.frames.add('{"type":"state/update"}');
      await Future<void>.delayed(Duration.zero);
      expect(statuses.last, ConnectionState.disconnected);
      channel.dispose();
    },
  );
}
