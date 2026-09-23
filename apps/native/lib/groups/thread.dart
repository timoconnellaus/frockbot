import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';

import '../client/chat_controller.dart' show ConnectionState;
import '../client/transport.dart';
import 'api.dart';
import 'model.dart';

/// The longest message a group takes, in the UTF-16 units the server counts.
const groupMessageMaxCharacters = 8000;

/// A message the person sent that the group has not yet confirmed. It keeps
/// its command id, so sending it again can never post it twice.
class GroupPendingSend {
  final String commandId;
  final String text;

  /// The send could not be confirmed; the person can send it again.
  final bool failed;
  const GroupPendingSend(this.commandId, this.text, {this.failed = false});

  Map<String, Object?> toJson() => {'commandId': commandId, 'text': text};

  static GroupPendingSend? decode(Object? value) {
    if (value is! Map) return null;
    final commandId = value['commandId'];
    final text = value['text'];
    if (commandId is! String || text is! String) return null;
    // Restored from an earlier run of the app: whether it arrived is not
    // known, so it waits for the person to send it again.
    return GroupPendingSend(commandId, text, failed: true);
  }
}

/// One Group Chat's thread: the view of the group, the messages read so far,
/// and what the person has sent and not yet seen confirmed.
class GroupThreadController extends ChangeNotifier {
  final GroupChatApi api;
  final LocalStore store;
  final String userId;
  final String groupId;
  final String Function() nextId;

  GroupThreadController({
    required this.api,
    required this.store,
    required this.userId,
    required this.groupId,
    String Function()? nextId,
  }) : nextId = nextId ?? randomId;

  String get key => 'group/$userId/$groupId';

  GroupView? view;
  final Map<int, GroupMessage> _messages = {};
  List<GroupPendingSend> pending = const [];
  String draft = '';
  String? error;
  bool ready = false;
  bool hasEarlier = false;
  bool loadingEarlier = false;
  bool stopping = false;
  List<String> working = const [];
  int readThrough = 0;
  ConnectionState connection = ConnectionState.initializing;
  bool _disposed = false;
  Future<void> _catchingUp = Future.value();

  /// Messages read so far, oldest first.
  List<GroupMessage> get messages =>
      (_messages.values.toList()..sort((a, b) => a.seq.compareTo(b.seq)));

  int get lastSeq => _messages.keys.fold(0, math.max);

  Future<void> initialize() async {
    try {
      _restore(await store.read(key));
    } catch (_) {
      // A draft this build cannot read is not worth failing the group over.
    }
    _notify();
    try {
      await refreshView();
      final page = await api.page(groupId);
      _add(page.messages);
      hasEarlier = page.hasMore;
      ready = true;
      error = null;
    } catch (failure) {
      error = _message(failure);
    }
    _notify();
  }

  static String _message(Object failure) => failure is RequestFailure
      ? failure.message
      : 'Couldn’t load this Group Chat. Please try again.';

  Future<void> refreshView() async {
    final next = await api.view(groupId);
    view = next;
    working = next.working;
    readThrough = math.max(readThrough, next.readThrough);
    _notify();
  }

  Future<void> loadEarlier() async {
    if (!hasEarlier || loadingEarlier || _messages.isEmpty) return;
    loadingEarlier = true;
    _notify();
    try {
      final first = _messages.keys.fold(lastSeq, math.min);
      final page = await api.page(groupId, before: first);
      _add(page.messages);
      hasEarlier = page.hasMore;
    } catch (failure) {
      error = _message(failure);
    } finally {
      loadingEarlier = false;
      _notify();
    }
  }

  /// What the group's channel said: who is working, how far the person has
  /// read, and whether the thread has moved past what this client holds.
  void applyState(GroupState state) {
    working = state.working;
    readThrough = math.max(readThrough, state.readThrough);
    _notify();
    if (state.head > lastSeq) unawaited(catchUp());
  }

  void applyConnection(ConnectionState state) {
    connection = state;
    _notify();
  }

  /// Reads everything after the last message this client holds. Serialized,
  /// so two frames that arrive together read the same page once.
  Future<void> catchUp() {
    _catchingUp = _catchingUp.then((_) async {
      if (!ready || _disposed) return;
      try {
        var changed = false;
        for (;;) {
          final page = await api.page(groupId, after: lastSeq, limit: 100);
          _add(page.messages);
          changed = changed || page.messages.any(_changesGroup);
          if (!page.hasMore || page.messages.isEmpty) break;
        }
        // Who is in the group and what it is called travel as thread lines.
        if (changed) await refreshView();
      } catch (failure) {
        error = _message(failure);
      }
      _notify();
    });
    return _catchingUp;
  }

  static bool _changesGroup(GroupMessage message) =>
      message.body is GroupEvent && (message.body as GroupEvent).changesGroup;

  Future<void> send(String text) async {
    final trimmed = text.trim();
    if (trimmed.isEmpty) return;
    if (trimmed.length > groupMessageMaxCharacters) {
      error =
          'That message is too long. A group message can be up to $groupMessageMaxCharacters characters.';
      _notify();
      return;
    }
    final submission = GroupPendingSend(nextId(), trimmed);
    pending = [...pending, submission];
    draft = '';
    error = null;
    // Kept before it is sent, so a send the app does not live to see
    // confirmed is still here to send again.
    await _persist();
    _notify();
    await _deliver(submission);
  }

  /// Sends a message that could not be confirmed again, under its own
  /// command id: if the first attempt arrived, this is the same message.
  Future<void> resend(String commandId) async {
    final submission = _pending(commandId);
    if (submission == null) return;
    final retrying = GroupPendingSend(submission.commandId, submission.text);
    pending = [
      for (final entry in pending)
        entry.commandId == commandId ? retrying : entry,
    ];
    error = null;
    _notify();
    await _deliver(retrying);
  }

  /// Gives a message that could not be sent back to the draft.
  Future<void> discard(String commandId) async {
    final submission = _pending(commandId);
    if (submission == null) return;
    pending = [
      for (final entry in pending)
        if (entry.commandId != commandId) entry,
    ];
    if (draft.isEmpty) draft = submission.text;
    await _persist();
    _notify();
  }

  GroupPendingSend? _pending(String commandId) {
    for (final entry in pending) {
      if (entry.commandId == commandId) return entry;
    }
    return null;
  }

  Future<void> _deliver(GroupPendingSend submission) async {
    try {
      final message = await api.post(
        groupId,
        commandId: submission.commandId,
        text: submission.text,
      );
      _add([message]);
      pending = [
        for (final entry in pending)
          if (entry.commandId != submission.commandId) entry,
      ];
    } on RequestFailure catch (failure) {
      error = failure.message;
      if (failure.refused) {
        // The group refused the words themselves; they go back to the draft
        // so the person can change them.
        pending = [
          for (final entry in pending)
            if (entry.commandId != submission.commandId) entry,
        ];
        if (draft.isEmpty) draft = submission.text;
      } else {
        _unconfirmed(submission);
      }
    } catch (_) {
      // An answer this build cannot read says nothing about whether the
      // message arrived; it waits to be sent again under its own id.
      _unconfirmed(submission);
    }
    await _persist();
    _notify();
  }

  void _unconfirmed(GroupPendingSend submission) {
    pending = [
      for (final entry in pending)
        entry.commandId == submission.commandId
            ? GroupPendingSend(entry.commandId, entry.text, failed: true)
            : entry,
    ];
  }

  /// Marks the thread read as far as it has been read to.
  Future<void> markRead() async {
    final target = lastSeq;
    if (target <= readThrough) return;
    readThrough = target;
    _notify();
    try {
      readThrough = math.max(readThrough, await api.read(groupId, target));
    } catch (_) {
      // Read state is disposable: the next glance sends a newer position.
    }
  }

  /// Stops every member working in this group, or one of them.
  Future<void> stop({String? botId}) async {
    stopping = true;
    _notify();
    try {
      await api.stop(groupId, commandId: nextId(), botId: botId);
    } catch (failure) {
      error = _message(failure);
    } finally {
      stopping = false;
      _notify();
    }
  }

  /// Runs a member again whose Turn did not finish.
  Future<void> retry(String botId, String runId) async {
    try {
      await api.retry(groupId, commandId: nextId(), botId: botId, runId: runId);
      error = null;
    } catch (failure) {
      error = _message(failure);
    }
    _notify();
  }

  void saveDraft(String text) {
    if (draft == text) return;
    draft = text;
    unawaited(_persist());
  }

  void clearError() {
    error = null;
    _notify();
  }

  void _add(Iterable<GroupMessage> messages) {
    for (final message in messages) {
      _messages[message.seq] = message;
    }
  }

  Future<void> _persist() => store.write(
    key,
    jsonEncode({
      'version': 1,
      'draft': draft,
      'pending': [for (final entry in pending) entry.toJson()],
    }),
  );

  void _restore(String? saved) {
    if (saved == null) return;
    final value = jsonDecode(saved);
    if (value is! Map || value['version'] != 1) return;
    if (draft.isEmpty && value['draft'] is String) {
      draft = value['draft'] as String;
    }
    pending = [
      for (final entry in (value['pending'] as List? ?? const []))
        ?GroupPendingSend.decode(entry),
    ];
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
