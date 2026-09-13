import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';

import 'page_cache.dart';
import 'transport.dart';

enum ConnectionState {
  /// The first observer handshake for this Bot. Cached Bot state is already
  /// safe to show, so this is ordinary setup rather than a failure surface.
  initializing,
  connected,

  /// An explicit reconnect or foreground resume is in flight after the Bot
  /// has already needed recovery.
  reconnecting,
  disconnected,
  paused,
}

/// One message this client has accepted from the person and not yet found in
/// the durable transcript. It carries its own words so a submission that never
/// arrived can be handed back to the draft it came out of.
class PendingSend {
  final String id;
  final String text;
  final String? retryOf;
  final String? messageRunId;
  final String? messageAdmittedAt;
  const PendingSend(
    this.id,
    this.text, {
    this.retryOf,
    this.messageRunId,
    this.messageAdmittedAt,
  });

  Map<String, Object?> toJson() => {
    'id': id,
    'text': text,
    if (retryOf != null) 'retryOf': retryOf,
    if (messageRunId != null) 'messageRunId': messageRunId,
    if (messageAdmittedAt != null) 'messageAdmittedAt': messageAdmittedAt,
  };

  static PendingSend? decode(Object? value) {
    if (value is! Map) return null;
    final id = value['id'];
    final text = value['text'];
    if (id is! String || text is! String) return null;
    final retryOf = value['retryOf'];
    final messageRunId = value['messageRunId'];
    final messageAdmittedAt = value['messageAdmittedAt'];
    if ((retryOf != null && retryOf is! String) ||
        (messageRunId != null && messageRunId is! String) ||
        (messageAdmittedAt != null && messageAdmittedAt is! String) ||
        (retryOf != null &&
            (messageRunId == null || messageAdmittedAt == null))) {
      return null;
    }
    return PendingSend(
      id,
      text,
      retryOf: retryOf as String?,
      messageRunId: messageRunId as String?,
      messageAdmittedAt: messageAdmittedAt as String?,
    );
  }
}

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

  /// Submissions this client has admitted locally and not yet confirmed, in
  /// the order they were sent.
  ///
  /// A list rather than one slot because a person may send again while the Bot
  /// is still working — the composer never closes over a running Turn — and
  /// every submission has to be recoverable until it is either found in the
  /// durable transcript or handed back to the draft. One slot would have let
  /// the second send overwrite the first, which is exactly the case the
  /// delivery check exists for.
  List<PendingSend> pending = const [];
  String? stopId;
  String? stopTarget;
  String? before;
  String? error;
  bool ready = false;

  /// How many submissions are still being delivered. A count rather than a
  /// flag, because a second send starts while the first POST is still open.
  int _inFlight = 0;
  bool get sending => _inFlight > 0;
  bool stopping = false;
  bool checking = false;
  bool loading = false;
  bool _disposed = false;
  ConnectionState connection = ConnectionState.initializing;

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

  /// The Turn a Stop could reach: one the Bot is running now.
  ///
  /// A submission whose delivery is still unconfirmed is not one. There may be
  /// no Turn behind it at all — that is the whole reason the state exists — so
  /// what it earns is "Check message status", not a Stop over something that
  /// may never have been admitted.
  String? get runningRunId {
    for (final run in runs) {
      if (run['status'] == 'running' && run['queued'] != true) {
        return run['runId'] as String;
      }
    }
    return null;
  }

  /// The Turn this conversation is waiting on, admitted or not. The working
  /// row and the Bot's "busy" mark are about the wait, so they include a
  /// submission that has not been confirmed yet.
  String? get activeRunId =>
      runningRunId ?? (pending.isEmpty ? null : pending.last.id);

  /// Whether there is anything a Stop could reach.
  ///
  /// A submission still being delivered counts: the Turn may well have been
  /// admitted at the other end, and that is exactly when a person wants to
  /// stop it. One the client has given up confirming does not — the
  /// conversation is already saying it could not reach the Bot, and an offer
  /// to stop a Turn that may never have existed is not one the product can
  /// keep. What that state offers is "Check message status".
  bool get stoppable =>
      runningRunId != null || (pending.isNotEmpty && error == null);

  /// The words of a submission the transcript does not carry yet, so the
  /// person sees what they wrote while it is being delivered. The newest, when
  /// several are in flight: it is the one they are watching for.
  String? get visiblePendingText {
    for (final submission in pending.reversed) {
      if (submission.retryOf == null && !_runs.containsKey(submission.id)) {
        return submission.text;
      }
    }
    return null;
  }

  /// Whether this client could start a Turn.
  ///
  /// Not gated on a Turn already running, and not on a submission still being
  /// delivered. "Do this instead" is a thing a person means and the send route
  /// admits it: every send carries supersede intent, and the Bot replaces what
  /// it was doing. A composer that closed for the length of a Turn made the
  /// supersede path unreachable from the one surface that has it.
  bool get canSend => ready;
  void changed() {
    if (!_disposed) notifyListeners();
  }

  Future<void> _persist() => store.write(
    key,
    jsonEncode({
      'version': 1,
      'draft': draft,
      'pending': [for (final submission in pending) submission.toJson()],
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
    pending = [
      for (final entry in (value['pending'] as List? ?? const []))
        ?PendingSend.decode(entry),
    ];
    for (final submission in pending) {
      if (submission.retryOf != null) {
        _putOptimisticRun(submission, queued: false);
      }
    }
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
      if (pending.isNotEmpty) await checkDelivery();
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
    _optimisticRunIds.remove(run['runId']);
    _runs[run['runId'] as String] = run;
  }

  /// Runs this client drew for itself, so it can take them back if the
  /// submission behind one turns out never to have been admitted.
  final _optimisticRunIds = <String>{};

  void _putOptimisticRun(PendingSend submission, {bool queued = true}) {
    // Never over a run authority already told this client about.
    if (_runs.containsKey(submission.id)) return;
    _optimisticRunIds.add(submission.id);
    _runs[submission.id] = {
      'runId': submission.id,
      'input': submission.text,
      'admittedAt': DateTime.now().toUtc().toIso8601String(),
      'status': 'running',
      'queued': queued,
      if (submission.retryOf != null) ...{
        'retryOf': submission.retryOf,
        'messageRunId': submission.messageRunId,
        'messageAdmittedAt': submission.messageAdmittedAt,
      },
      'events': const <Object?>[],
    };
  }

  Future<void> invalidate() async {
    await refresh();
    // An unrelated state event cannot fence a POST still being delivered.
    if (pending.isNotEmpty && !sending) await checkDelivery();
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
        // Never the rows this client drew for itself: a cache that holds one
        // reopens the conversation with a Turn that may never have existed.
        unawaited(
          writePageCache(store, userId, botId, [
            for (final run in runs)
              if (!_optimisticRunIds.contains(run['runId'])) run,
          ], before),
        );
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
    await _submit(PendingSend(nextId(), text));
  }

  /// A fresh attempt over the same visible message, without touching the composer.
  Future<void> retryRun(String runId) async {
    if (!canSend || pending.any((send) => send.retryOf == runId)) return;
    final run = _runs[runId];
    if (run == null ||
        run['canRetry'] != true ||
        run['status'] != 'failed' ||
        run['retriedBy'] != null ||
        _runs.values.any((attempt) => attempt['retryOf'] == runId)) {
      return;
    }
    final text = run['input'] as String?;
    if (text == null || text.trim().isEmpty) return;
    await _submit(
      PendingSend(
        nextId(),
        text,
        retryOf: runId,
        messageRunId: run['messageRunId'] as String? ?? runId,
        messageAdmittedAt:
            run['messageAdmittedAt'] as String? ?? run['admittedAt'] as String,
      ),
    );
  }

  Future<void> _submit(PendingSend submission) async {
    final text = submission.text;
    _inFlight += 1;
    error = null;
    // The intent goes with every send, and the run this client had observed
    // rides along as provenance where there is one. Whether a Turn was showing
    // as running is a race — the transcript is a poll behind — so gating the
    // intent on what happened to be on screen would have the Bot refuse a
    // message the person had every right to send.
    final supersedes = runningRunId;
    // Whether this message is waiting behind anything at all — a Turn the Bot
    // is running, or an earlier send whose own admission is still in flight.
    // Read before the new submission joins the list.
    final waitsBehind = activeRunId != null;
    pending = [...pending, submission];
    // A message that displaces a running Turn joins the thread at once, greyed
    // and queued, rather than waiting for a durable read. The send route does
    // not answer until the Turn it replaced has settled, so the whole of the
    // drain — the only window in which the thread has anything to say about
    // it — is over by the time authority could have told this client. The
    // durable projection replaces this by run id the moment it arrives.
    if (waitsBehind || submission.retryOf != null) {
      _putOptimisticRun(submission, queued: waitsBehind);
    }
    changed();
    if (submission.retryOf == null) draft = '';
    try {
      await _persist(); // No transport call can precede this durable local write.
    } catch (_) {
      _forget(submission);
      _restoreSubmission(submission);
      _inFlight -= 1;
      error = 'Couldn’t save your message. Please try again.';
      changed();
      return;
    }
    changed();
    try {
      await transport.send(
        botId,
        submission.id,
        text,
        supersedes: supersedes,
        retryOf: submission.retryOf,
      );
      await checkDelivery();
    } on RequestFailure catch (failure) {
      if (failure.refused) {
        _forget(submission);
        _restoreSubmission(submission);
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
      _inFlight -= 1;
      changed();
    }
  }

  void _restoreSubmission(PendingSend submission) {
    if (submission.retryOf != null) return;
    final text = submission.text;
    draft = draft.isEmpty ? text : '$text\n\n$draft';
  }

  void _forget(PendingSend submission) {
    if (_optimisticRunIds.remove(submission.id)) _runs.remove(submission.id);
    pending = [
      for (final entry in pending)
        if (entry.id != submission.id) entry,
    ];
  }

  /// Finds out what became of every submission this client has not confirmed.
  ///
  /// Oldest first, over a snapshot of the list: a submission admitted while
  /// this is running is left for the next call rather than checked before the
  /// POST that carries it has had a chance to answer.
  Future<void> checkDelivery() async {
    if (checking || pending.isEmpty) return;
    checking = true;
    changed();
    try {
      for (final submission in [...pending]) {
        await _confirm(submission);
      }
    } finally {
      checking = false;
      changed();
    }
  }

  /// One submission's fate: found in the durable transcript, or handed back to
  /// the draft it came out of. A submission this cannot settle stays pending,
  /// which is what "Check message status" offers to try again.
  Future<void> _confirm(PendingSend submission) async {
    try {
      final observed = await transport.lookup(botId, submission.id);
      // A read alone cannot prove a delayed POST will never be admitted.
      final run =
          observed ?? await transport.lookup(botId, submission.id, fence: true);
      final previousDraft = draft;
      if (run != null) {
        _put(run);
        error = null;
      } else {
        _restoreSubmission(submission);
        error = submission.retryOf == null
            ? 'Your message didn’t go through. You can send it again.'
            : 'Your retry didn’t go through. Try again on the original message.';
      }
      final reconciledDraft = draft;
      final kept = pending;
      _forget(submission);
      try {
        await _persist();
      } catch (_) {
        pending = kept;
        if (submission.retryOf != null) {
          _putOptimisticRun(submission, queued: false);
        }
        if (draft == reconciledDraft) draft = previousDraft;
        rethrow;
      }
    } catch (_) {
      error = 'Couldn’t confirm your message. Reconnect or check again.';
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
