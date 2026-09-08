import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';

import 'page_cache.dart';
import 'transport.dart';

enum ConnectionState { connecting, connected, disconnected, paused }

class ChatController extends ChangeNotifier {
  final ChatTransport transport;
  final LocalStore store;
  final String userId;
  final String botId;
  final String Function() nextId;
  ChatController({
    required this.transport,
    required this.store,
    required this.userId,
    required this.botId,
    String Function()? nextId,
  }) : nextId = nextId ?? randomId;
  String get key => 'chat/$userId/$botId';
  String get pageKey => pageCacheKey(userId, botId);
  String draft = '';
  String? pendingId;
  String? pendingText;
  String? stopId;
  String? stopTarget;
  String? before;
  String? error;
  bool ready = false;
  bool sending = false;
  bool stopping = false;
  bool checking = false;
  bool loading = false;
  bool _disposed = false;
  ConnectionState connection = ConnectionState.connecting;

  /// The conversation's own announcements — a rename, a compaction — as the
  /// newest page carried them. They belong to the Session rather than to a
  /// Turn, so only the newest page has them and an older page never clears
  /// what it does not carry.
  List<Object?> announcements = const [];

  /// A Turn a search hit named. The thread brings it into view if it is on the
  /// loaded page; one further back is simply not here, and nothing pretends
  /// otherwise.
  String? focusRunId;
  final Map<String, Map<String, dynamic>> _runs = {};
  List<Map<String, dynamic>> get runs => _runs.values.toList()
    ..sort(
      (a, b) =>
          (a['admittedAt'] as String).compareTo(b['admittedAt'] as String),
    );
  String? get activeRunId {
    for (final run in runs) {
      if (run['status'] == 'running' && run['queued'] != true) {
        return run['runId'] as String;
      }
    }
    return pendingId;
  }

  String? get visiblePendingText =>
      pendingId == null || _runs.containsKey(pendingId) ? null : pendingText;

  bool get canSend => ready && !sending && pendingId == null;
  void changed() {
    if (!_disposed) notifyListeners();
  }

  Future<void> _persist() => store.write(
    key,
    jsonEncode({
      'version': 1,
      'draft': draft,
      'pendingId': pendingId,
      'pendingText': pendingText,
      'stopId': stopId,
      'stopTarget': stopTarget,
    }),
  );
  void _restoreSaved(String? saved) {
    if (saved == null) return;
    final value = jsonDecode(saved) as Map<String, dynamic>;
    if (value['version'] != 1 || value['draft'] is! String) {
      throw const FormatException('Invalid draft');
    }
    draft = value['draft'] as String;
    pendingId = value['pendingId'] as String?;
    pendingText = value['pendingText'] as String?;
    stopId = value['stopId'] as String?;
    stopTarget = value['stopTarget'] as String?;
  }

  /// The transcript last seen for this Bot, so its pane opens on the messages
  /// the User remembers instead of an empty pane. The network page that follows
  /// replaces it, including the cursor it restored.
  void _restoreCachedPage(SnapshotStore? snapshot) {
    if (snapshot == null) return;
    final cached = decodePageCache(snapshot.peek(pageKey));
    if (cached == null) return;
    for (final run in cached.runs) {
      _put(run);
      _cachedRunIds.add(run['runId'] as String);
    }
    before = cached.before;
    _cachedCursor = before != null;
  }

  bool _initialized = false;
  bool _cachedCursor = false;
  final Set<String> _cachedRunIds = {};
  Future<void> initialize() async {
    if (_initialized) return;
    _initialized = true;
    final snapshot = store is SnapshotStore ? store as SnapshotStore : null;
    try {
      _restoreCachedPage(snapshot);
    } catch (_) {
      // A cache that cannot be read only costs this switch its first frame.
    }
    try {
      if (snapshot != null && snapshot.resident) {
        // Draft and pending state decide whether this Bot can accept a message,
        // so they are known before the composer is offered — from memory when
        // the store already holds them, and only then without awaiting.
        _restoreSaved(snapshot.peek(key));
      } else {
        _restoreSaved(await store.read(key));
      }
      ready = true;
      changed();
      await refresh();
      if (pendingId != null) await checkDelivery();
      // A stored Stop is observed, never dispatched merely because the app opened.
    } catch (_) {
      error = 'Couldn’t restore this conversation. Please reconnect.';
      changed();
    }
  }

  Future<void> saveDraft(String text) async {
    draft = text;
    try {
      await _persist();
    } catch (_) {
      error = 'Couldn’t save your draft. Please try again.';
      changed();
    }
  }

  void _put(Map<String, dynamic> run) {
    _cachedRunIds.remove(run['runId']);
    _runs[run['runId'] as String] = run;
  }

  Future<void> invalidate() async {
    await refresh();
    // An unrelated state event cannot fence a POST still being delivered.
    if (pendingId != null && !sending) await checkDelivery();
  }

  Future<void> _refreshQueue = Future.value();
  Future<void> refresh({bool older = false}) {
    // A newer observer event must fetch after any in-flight stale request.
    // Its cursor is persisted only once this particular projection is applied.
    final next = _refreshQueue.then((_) => _refresh(older: older));
    _refreshQueue = next.catchError((Object _) {});
    return next;
  }

  Future<void> _refresh({required bool older}) async {
    if (_disposed) return;
    loading = true;
    changed();
    try {
      final page = await transport.page(botId, before: older ? before : null);
      // The first live page replaces restored cache rows. Preserve any live
      // admission or lookup that arrived while this page was in flight.
      if (!older) {
        for (final id in _cachedRunIds) {
          _runs.remove(id);
        }
        _cachedRunIds.clear();
      }
      for (final run in page['runs'] as List) {
        _put(Map<String, dynamic>.from(run as Map));
      }
      if (!older) announcements = (page['announcements'] as List?) ?? const [];
      if (older || before == null || _cachedCursor) {
        before = (page['page'] as Map)['nextCursor'] as String?;
        _cachedCursor = false;
      }
      error = null;
      {
        unawaited(writePageCache(store, userId, botId, runs, before));
      }
    } finally {
      loading = false;
      changed();
    }
  }

  /// Takes the reader to one Turn of this conversation.
  void focusRun(String runId) {
    focusRunId = runId;
    changed();
  }

  Future<void> send(String text) async {
    if (!canSend || text.trim().isEmpty) return;
    sending = true;
    error = null;
    final id = nextId();
    pendingId = id;
    pendingText = text;
    changed();
    draft = '';
    try {
      await _persist(); // No transport call can precede this durable local write.
    } catch (_) {
      _restoreSubmission(text);
      pendingId = null;
      pendingText = null;
      sending = false;
      error = 'Couldn’t save your message. Please try again.';
      changed();
      return;
    }
    changed();
    try {
      await transport.send(botId, id, text);
      await checkDelivery();
    } on RequestFailure catch (failure) {
      if (failure.refused) {
        _restoreSubmission(text);
        pendingId = null;
        pendingText = null;
        await _persist();
        error = failure.message;
      } else {
        error = 'Checking whether your message went through…';
        await checkDelivery();
      }
    } catch (_) {
      error = 'Checking whether your message went through…';
      await checkDelivery();
    } finally {
      sending = false;
      changed();
    }
  }

  void _restoreSubmission(String text) {
    draft = draft.isEmpty ? text : '$text\n\n$draft';
  }

  Future<void> checkDelivery() async {
    final id = pendingId;
    if (id == null || checking) return;
    checking = true;
    changed();
    try {
      final observed = await transport.lookup(botId, id);
      // A read alone cannot prove a delayed POST will never be admitted.
      final run = observed ?? await transport.lookup(botId, id, fence: true);
      final previousDraft = draft;
      if (run != null) {
        _put(run);
        error = null;
      } else {
        _restoreSubmission(pendingText!);
        error = 'Your message didn’t go through. You can send it again.';
      }
      final reconciledDraft = draft;
      final savedText = pendingText;
      pendingId = null;
      pendingText = null;
      try {
        await _persist();
      } catch (_) {
        pendingId = id;
        pendingText = savedText;
        if (draft == reconciledDraft) draft = previousDraft;
        rethrow;
      }
    } catch (_) {
      error = 'Couldn’t confirm your message. Reconnect or check again.';
    } finally {
      checking = false;
      changed();
    }
  }

  Future<void> stop() async {
    final target = activeRunId;
    if (target == null || stopping) return;
    stopping = true;
    error = null;
    changed();
    try {
      if (stopTarget != target) {
        stopTarget = target;
        stopId = nextId();
      }
      await _persist();
      _put(await transport.stop(botId, target, stopId!));
      // An accepted Stop can still be running. The projection decides completion.
    } catch (_) {
      error = 'Couldn’t confirm Stop. You can try Stop again.';
    } finally {
      stopping = false;
      changed();
    }
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
