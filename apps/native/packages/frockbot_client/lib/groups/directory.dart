import 'dart:async';

import 'package:flutter/foundation.dart';

import '../client/transport.dart';
import 'api.dart';
import 'model.dart';

/// The User's Group Chats: the list the sidebar draws, how many unread
/// messages each has, and the commands that change them. An arrangement —
/// a pin, an order, hiding — shows at once and is rolled back if the group
/// refuses it.
class GroupDirectoryController extends ChangeNotifier {
  final GroupChatApi api;
  final String Function() nextId;
  GroupDirectoryController(this.api, {String Function()? nextId})
    : nextId = nextId ?? randomId;

  List<GroupRecord> groups = const [];
  final Map<String, int> unread = {};

  /// Whether any member's group Turn is running, as of the last read.
  final Map<String, bool> working = {};
  Future<void>? _refreshing;
  bool loaded = false;
  String? error;
  bool _disposed = false;

  /// Groups the sidebar lists: every group not archived.
  List<GroupRecord> get active => [
    for (final group in groups)
      if (!group.archived) group,
  ];

  GroupRecord? byId(String groupId) {
    for (final group in groups) {
      if (group.groupId == groupId) return group;
    }
    return null;
  }

  Future<void> load() async {
    try {
      groups = await api.list();
      loaded = true;
      error = null;
      _notify();
      await refreshUnread();
    } catch (failure) {
      // The list is a read of the account's groups; one that fails leaves
      // the Bots as they are and is read again on the next poll.
      error = failure is RequestFailure
          ? failure.message
          : 'Couldn’t load your Group Chats.';
      _notify();
    }
  }

  /// Reads each listed group's unread count, a few at a time. A read that
  /// arrives while one is running shares it.
  Future<void> refreshUnread() =>
      _refreshing ??= _refreshUnread().whenComplete(() => _refreshing = null);

  Future<void> _refreshUnread() async {
    final pending = [for (final group in active) group.groupId];
    Future<void> next() async {
      while (pending.isNotEmpty) {
        final groupId = pending.removeLast();
        try {
          final view = await api.view(groupId);
          unread[groupId] = view.unread;
          working[groupId] = view.working.isNotEmpty;
        } catch (_) {
          // A count that cannot be read is not shown; the group still is.
        }
      }
    }

    await Future.wait([for (var lane = 0; lane < 4; lane++) next()]);
    _notify();
  }

  /// Marks everything in a group read, from its row.
  Future<void> markRead(String groupId) async {
    final view = await api.view(groupId);
    await api.read(groupId, view.head);
    setUnread(groupId, 0);
  }

  void setUnread(String groupId, int count) {
    if (unread[groupId] == count) return;
    unread[groupId] = count;
    _notify();
  }

  Future<GroupRecord> create(List<String> members, {String? name}) async {
    final created = await api.create(
      commandId: nextId(),
      members: members,
      name: name,
    );
    _put(created);
    return created;
  }

  Future<void> rename(String groupId, String? name) =>
      _command(groupId, {'type': 'group/rename', 'name': name});

  Future<void> addMember(String groupId, String botId) =>
      _command(groupId, {'type': 'group/add-member', 'botId': botId});

  Future<void> removeMember(String groupId, String botId) =>
      _command(groupId, {'type': 'group/remove-member', 'botId': botId});

  Future<void> archive(String groupId) =>
      _command(groupId, {'type': 'group/archive'});

  Future<void> restore(String groupId) =>
      _command(groupId, {'type': 'group/restore'});

  Future<void> delete(String groupId) async {
    await _command(groupId, {'type': 'group/delete'});
    groups = [
      for (final group in groups)
        if (group.groupId != groupId) group,
    ];
    unread.remove(groupId);
    _notify();
  }

  /// Pins, orders or hides a group. The change shows at once; a refusal puts
  /// the group back and says why.
  Future<void> arrange(
    String groupId, {
    bool? pinned,
    num? sidebarOrder,
    bool clearOrder = false,
    bool? hidden,
  }) async {
    final before = byId(groupId);
    if (before == null) return;
    _put(
      before.arranged(
        pinned: pinned,
        sidebarOrder: sidebarOrder,
        clearOrder: clearOrder,
        hidden: hidden,
      ),
    );
    try {
      await _command(groupId, {
        'type': 'group/arrange',
        'pinned': ?pinned,
        if (clearOrder) 'sidebarOrder': null else 'sidebarOrder': ?sidebarOrder,
        'hidden': ?hidden,
      });
    } catch (_) {
      _put(before);
      rethrow;
    }
  }

  Future<void> _command(String groupId, Map<String, Object?> command) async {
    final group = await api.command(groupId, {
      ...command,
      'commandId': nextId(),
    });
    if (group != null) _put(group);
  }

  void _put(GroupRecord group) {
    final index = groups.indexWhere((g) => g.groupId == group.groupId);
    groups = index < 0 ? [...groups, group] : ([...groups]..[index] = group);
    _notify();
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
