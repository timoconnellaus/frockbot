import 'dart:async';
import 'dart:collection';
import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../shell/transcript_model.dart' show ReplyDraft;
import 'attachments.dart';
import 'image_prep.dart';
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

  /// The files the message carries: uploads the Bot already holds.
  final List<MessageAttachment> attachments;
  const PendingSend(
    this.id,
    this.text, {
    this.retryOf,
    this.messageRunId,
    this.messageAdmittedAt,
    this.attachments = const [],
  });

  Map<String, Object?> toJson() => {
    'id': id,
    'text': text,
    if (retryOf != null) 'retryOf': retryOf,
    if (messageRunId != null) 'messageRunId': messageRunId,
    if (messageAdmittedAt != null) 'messageAdmittedAt': messageAdmittedAt,
    if (attachments.isNotEmpty)
      'attachments': [
        for (final attachment in attachments) attachment.toJson(),
      ],
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
      attachments: MessageAttachment.decodeList(value['attachments']),
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
    this.uploads,
    this.prepare = prepareUploadV1,
  }) : nextId = nextId ?? randomId;

  /// Where this Bot's files go. Absent, nothing can be attached here.
  final UploadTransport? uploads;

  /// What a picked file becomes before it is uploaded.
  final PrepareUpload prepare;

  /// The files attached to this Bot's draft, uploaded as they are attached.
  late final AttachmentTray attachments = AttachmentTray(
    upload: ({required name, required mediaType, required bytes}) {
      final destination = uploads;
      if (destination == null) {
        throw const RequestFailure('Files can’t be attached here.');
      }
      return destination.upload(
        botId,
        name: name,
        mediaType: mediaType,
        bytes: bytes,
      );
    },
    prepare: prepare,
  );

  /// Bytes this client already holds or has read for an upload, by its id:
  /// what a thumbnail is drawn from. Bounded, because a long thread can
  /// carry more pictures than are worth keeping in memory.
  final Map<String, Uint8List> _attachmentBytes = {};
  static const _attachmentBytesKept = 24;

  void _keepAttachmentBytes(String uploadId, Uint8List bytes) {
    _attachmentBytes.remove(uploadId);
    _attachmentBytes[uploadId] = bytes;
    while (_attachmentBytes.length > _attachmentBytesKept) {
      _attachmentBytes.remove(_attachmentBytes.keys.first);
    }
  }

  /// An uploaded file's bytes, from memory when this client has them.
  Future<Uint8List> attachmentBytes(MessageAttachment attachment) async {
    final held = _attachmentBytes[attachment.uploadId];
    if (held != null) return held;
    final destination = uploads;
    if (destination == null) {
      throw const RequestFailure('That file can’t be shown here.');
    }
    final bytes = await destination.download(botId, attachment.uploadId);
    _keepAttachmentBytes(attachment.uploadId, bytes);
    return bytes;
  }

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

  ConnectionState get connection => _connection;
  ConnectionState _connection = ConnectionState.initializing;

  /// A reply draft is only as current as the socket that drew it, so a
  /// socket that drops takes its drafts with it. After a reconnect the next
  /// frame draws whatever is still being written.
  set connection(ConnectionState value) {
    _connection = value;
    if (value != ConnectionState.connected) _replyDrafts.clear();
  }

  /// The reply each running Turn is writing, by run, as the state channel
  /// last drew it. Never persisted and never read back: the message each
  /// part becomes is the record, and a draft lives only as long as the
  /// socket that brought it.
  Map<String, ReplyDraft> get replyDrafts => UnmodifiableMapView(_replyDrafts);
  final Map<String, ReplyDraft> _replyDrafts = {};

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

  /// Publication envelope restored with the page cache. A reconnect presents
  /// both, never a later cursor against an older page.
  String? publicationEpoch;
  String? publicationCursor;
  int _syncGeneration = 0;
  final Map<String, int> _entityRevision = {};
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
  /// Stop follows a Turn the transcript is already showing. A submission whose
  /// admission is still unknown has no Turn to stop; what it offers is
  /// "Check message status" once the client has given up confirming it.
  bool get stoppable => runningRunId != null;

  /// A submission the transcript does not carry yet, so the person sees what
  /// they wrote while it is being delivered. The newest, when several are in
  /// flight: it is the one they are watching for.
  PendingSend? get visiblePending {
    for (final submission in pending.reversed) {
      if (submission.retryOf == null && !_runs.containsKey(submission.id)) {
        return submission;
      }
    }
    return null;
  }

  /// The order submissions were made on this device, which is the order the
  /// thread keeps them in until the durable transcript carries them. A count
  /// rather than this device's clock, which says nothing against the server's
  /// stamps. In memory only: a restored submission is numbered as it is
  /// restored.
  final _localOrder = <String, int>{};
  void _number(PendingSend submission) =>
      _localOrder.putIfAbsent(submission.id, () => _localOrder.length);

  /// Where a submission falls among the others made on this device.
  int localOrderOf(String id) => _localOrder[id] ?? _localOrder.length;

  /// Whether this client could start a Turn.
  ///
  /// Not gated on a Turn already running, and not on a submission still being
  /// delivered. A message sent while the Bot works waits, and the Bot reads it
  /// at its next step — so a person can steer it without waiting it out.
  bool get canSend => ready;
  void changed() {
    if (_disposed) return;
    _watchQuestions();
    notifyListeners();
  }

  /// The Bots working on something the running Turn asked them, while it
  /// waits on the answer.
  ///
  /// A Bot joins once its answering Turn is actually running. One that has the
  /// question queued behind its own work is not working on it yet, and a Bot
  /// busy with something else was never this conversation's business.
  List<String> helpers = const [];

  /// How often the answering Turns are looked at while a question is open.
  static const questionPoll = Duration(milliseconds: 1500);

  /// The running Turn's open questions and the Turns that answer them, as the
  /// asking Bot reported them. Keyed by the call that asked.
  final Map<String, OpenQuestion> _answerers = {};
  String? _answerersFor;

  /// The calls the answerers were last read for, so a call the asking Bot
  /// does not report is not asked about again on every change.
  final Set<String> _answerersAsked = {};

  /// Calls, as `runId:callId`, whose answering Turn has been seen running. A
  /// Turn that has started does not go back to its queue, and its answer
  /// arrives in this conversation's own log, so it is not looked at again.
  final Set<String> _started = {};

  /// The running Turn's open questions still waiting to be seen started.
  Iterable<String> _unstarted(Map<String, String> open) {
    final runId = runningRunId;
    return open.keys.where((callId) => !_started.contains('$runId:$callId'));
  }

  Timer? _questionTimer;
  bool _questioning = false;

  QuestionsTransport? get _questions =>
      transport is QuestionsTransport ? transport as QuestionsTransport : null;

  /// The running Turn's `message/to-bot` calls that have no result yet, by
  /// call id, with the Bot each one asked.
  Map<String, String> _openQuestions() {
    final run = _runs[runningRunId];
    if (run == null) return const {};
    final events = (run['events'] as List?) ?? const [];
    final answered = {
      for (final event in events)
        if (event is Map && event['type'] == 'tool/result') event['callId'],
    };
    return {
      for (final event in events)
        if (event is Map &&
            event['type'] == 'message/to-bot' &&
            event['callId'] is String &&
            event['botId'] is String &&
            !answered.contains(event['callId']))
          event['callId'] as String: event['botId'] as String,
    };
  }

  /// Keeps [helpers] to questions still open, and starts looking at the
  /// answering Turns when one opens. Runs inside [changed], so it never
  /// notifies itself.
  void _watchQuestions() {
    final open = _openQuestions();
    if (open.isEmpty || _questions == null) {
      _questionTimer?.cancel();
      _questionTimer = null;
      _started.clear();
      if (helpers.isNotEmpty) helpers = const [];
      return;
    }
    final asked = open.values.toSet();
    if (helpers.any((bot) => !asked.contains(bot))) {
      helpers = [
        for (final bot in helpers)
          if (asked.contains(bot)) bot,
      ];
    }
    if (_questionTimer == null &&
        !_questioning &&
        _unstarted(open).isNotEmpty) {
      unawaited(_lookAtHelpers());
    }
  }

  Future<void> _lookAtHelpers() async {
    final questions = _questions;
    final runId = runningRunId;
    if (_disposed || questions == null || runId == null) return;
    _questionTimer = null;
    _questioning = true;
    try {
      var open = _openQuestions();
      if (open.isEmpty) return;
      if (_answerersFor != runId ||
          open.keys.any((callId) => !_answerersAsked.contains(callId))) {
        final found = await questions.questions(botId, runId);
        if (_disposed) return;
        _answerersFor = runId;
        _answerersAsked
          ..clear()
          ..addAll(open.keys);
        _answerers
          ..clear()
          ..addEntries(found.map((q) => MapEntry(q.callId, q)));
      }
      final working = <String>{};
      for (final MapEntry(key: callId, value: asked) in open.entries) {
        final answerer = _answerers[callId];
        if (answerer == null || answerer.botId != asked) continue;
        if (_started.contains('$runId:$callId')) {
          working.add(asked);
          continue;
        }
        final run = await transport.lookup(answerer.botId, answerer.runId);
        if (run != null &&
            run['status'] == 'running' &&
            run['queued'] != true) {
          _started.add('$runId:$callId');
          working.add(asked);
        }
      }
      if (_disposed) return;
      // The thread may have moved on while the lookups were out. Only a
      // question the running Turn is still waiting on keeps its Bot.
      open = runningRunId == runId ? _openQuestions() : const {};
      final next = [
        for (final bot in working)
          if (open.containsValue(bot)) bot,
      ];
      if (!listEquals(next, helpers)) {
        helpers = next;
        notifyListeners();
      }
    } catch (_) {
      // A read that failed changes nothing on screen; the next look retries.
    } finally {
      _questioning = false;
      // Only a question still waiting in its Bot's queue is looked at again.
      if (!_disposed && _unstarted(_openQuestions()).isNotEmpty) {
        _questionTimer = Timer(questionPoll, () => unawaited(_lookAtHelpers()));
      }
    }
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
    // Words typed while the restore was still in flight are newer than
    // anything the store holds; the mirror in the composer would otherwise
    // replace them with the stored draft the moment this lands.
    if (draft.isEmpty) draft = value['draft'] as String;
    pending = [
      for (final entry in (value['pending'] as List? ?? const []))
        ?PendingSend.decode(entry),
    ];
    for (final submission in pending) {
      _number(submission);
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
    announcements = cached.announcements;
    publicationEpoch = cached.epoch;
    publicationCursor = cached.cursor;
  }

  bool _initialized = false;
  bool _cachedCursor = false;
  final Set<String> _cachedRunIds = {};
  Future<void> initialize({bool liveChannel = false}) async {
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
      if (!liveChannel) await refresh();
      if (pending.isNotEmpty) await checkDelivery();
      // A stored Stop is observed, never dispatched merely because the app opened.
    } catch (_) {
      _notice = 'Couldn’t restore this conversation. Please reconnect.';
      _publish();
    }
  }

  Future<void> saveDraft(String text) async {
    draft = text;
    try {
      await _persist();
    } catch (_) {
      _notice = 'Couldn’t save your draft. Please try again.';
      _publish();
    }
  }

  void _put(Map<String, dynamic> run) {
    final id = run['runId'] as String;
    final existing = _runs[id];
    // A page fetched while the Turn was still open can arrive after the live
    // channel has already settled it. Putting that page back would light the
    // working indicator again, and nothing in the live log would clear it.
    if (existing != null && _settledRun(existing) && !_settledRun(run)) return;
    if (_settledRun(run)) _replyDrafts.remove(id);
    _cachedRunIds.remove(id);
    _optimisticRunIds.remove(id);
    _runs[id] = existing == null || _settledRun(run)
        ? run
        : _keepingLaterSends(run, existing);
    // An authoritative row is proof of admission, including while its POST
    // is still open. Pending delivery state for that command is over.
    if (pending.any((submission) => submission.id == id)) {
      _confirmed.add(id);
      _commandErrors.remove(id);
      pending = [
        for (final submission in pending)
          if (submission.id != id) submission,
      ];
      unawaited(_persist());
      _publish();
    }
  }

  /// A running Turn's row read before a send was delivered, kept with the
  /// sends the live channel has drawn since. Sends only ever append, so the
  /// sends newer than the row's last are what it missed; putting it back as
  /// it was would take a message off the screen until the Turn settled.
  ///
  /// Only newer ones: a long Turn's row drops its oldest events, sends
  /// included, and one kept from before that cut would be drawn below the
  /// sends that followed it. A cut row with no send left in it could have
  /// lost any of them, so it keeps none.
  Map<String, dynamic> _keepingLaterSends(
    Map<String, dynamic> row,
    Map<String, dynamic> existing,
  ) {
    final events = [
      for (final item in (row['events'] as List?) ?? const [])
        Map<String, dynamic>.from(item as Map),
    ];
    final ordinals = [
      for (final event in events)
        if (event['type'] == 'send/to-user') event['ordinal'] as int,
    ];
    if (ordinals.isEmpty &&
        events.any((event) => event['type'] == 'run/events-truncated')) {
      return row;
    }
    final newest = ordinals.fold(-1, (a, b) => a > b ? a : b);
    final later = [
      for (final item in (existing['events'] as List?) ?? const [])
        if (item is Map &&
            item['type'] == 'send/to-user' &&
            (item['ordinal'] as int) > newest)
          Map<String, dynamic>.from(item),
    ];
    if (later.isEmpty) return row;
    later.sort(
      (left, right) => ((left['ordinal'] as int?) ?? 0).compareTo(
        (right['ordinal'] as int?) ?? 0,
      ),
    );
    return {
      ...row,
      'events': [...events, ...later],
    };
  }

  /// Runs this client drew for itself, so it can take them back if the
  /// submission behind one turns out never to have been admitted.
  final _optimisticRunIds = <String>{};

  bool _settledRun(Map<String, dynamic> run) {
    switch (run['status']) {
      case 'completed':
      case 'failed':
      case 'cancelled':
        return true;
      default:
        return false;
    }
  }

  /// Commands whose admission this client has already accepted. A later
  /// timeout on their POST must not put them back into uncertain delivery.
  final _confirmed = <String>{};

  /// POSTs that have not returned. A transcript refresh that does not contain
  /// one of them is not evidence it was never admitted.
  final _openPosts = <String>{};

  /// Unresolved delivery outcomes, keyed by command. One command settling
  /// does not clear another command's outcome.
  final _commandErrors = <String, String>{};

  /// A failure that is not about one command's admission: saving a draft,
  /// restoring the conversation, Stop, or a refusal the server answered.
  String? _notice;

  void _publish() {
    if (_notice != null) {
      error = _notice;
    } else {
      final messages = _commandErrors.values.toSet();
      error = messages.isEmpty ? null : messages.join('\n');
    }
    changed();
  }

  void _putOptimisticRun(PendingSend submission, {bool queued = true}) {
    // Never over a run authority already told this client about.
    if (_runs.containsKey(submission.id)) return;
    _optimisticRunIds.add(submission.id);
    _runs[submission.id] = {
      'runId': submission.id,
      'input': submission.text,
      if (submission.attachments.isNotEmpty)
        'attachments': [
          for (final attachment in submission.attachments) attachment.toJson(),
        ],
      'admittedAt': DateTime.now().toUtc().toIso8601String(),
      'status': 'running',
      'queued': queued,
      // A retry is drawn where its original message already is.
      if (submission.retryOf != null) ...{
        'retryOf': submission.retryOf,
        'messageRunId': submission.messageRunId,
        'messageAdmittedAt': submission.messageAdmittedAt,
      } else
        'localOrder': localOrderOf(submission.id),
      'events': const <Object?>[],
    };
  }

  /// Bumped once per state-channel notice, after the refresh it caused has
  /// landed. Durable state a line draws from outside the transcript — a Card's
  /// surface, read over REST against `shell:card:` — re-reads on this rather
  /// than on every notification this controller makes, most of which are about
  /// a Turn streaming and say nothing about a record it may have written.
  final ValueNotifier<int> invalidations = ValueNotifier(0);

  /// Bumped once per `computer` notice: this Bot's Computer changed, and its
  /// card should read the projection again.
  final ValueNotifier<int> computerNotices = ValueNotifier(0);

  Future<void> invalidate() async {
    await refresh();
    if (!_disposed) invalidations.value++;
    // A refresh that missed a POST still in flight must not fence that
    // command. Anything else still pending is reconciled on its own.
    if (pending.any((submission) => !_openPosts.contains(submission.id))) {
      await checkDelivery();
    }
  }

  /// Applies one committed state-channel frame. Ordinary replies land here
  /// without a transcript GET. A snapshot replaces the live page; an older
  /// GET never overwrites a newer live revision.
  Future<void> applyFrame(Map<String, dynamic> frame) async {
    if (_disposed) return;
    final type = frame['type'] as String?;
    final generation = _syncGeneration;
    if (type == 'state/draft') {
      // Nothing to persist: a draft moves no cursor and is never read back.
      _applyDraft(frame);
      changed();
      return;
    }
    if (type == 'state/snapshot') {
      _syncGeneration += 1;
      _applySnapshot(frame);
    } else if (type == 'state/update') {
      _applyUpdate(frame);
    } else {
      return;
    }
    if (_disposed || generation > _syncGeneration) return;
    await _persistEnvelope();
    changed();
    if (pending.isNotEmpty && !sending) await checkDelivery();
  }

  /// A frame carries the whole of what its run is writing, so it replaces the
  /// last one outright; an empty one is a step that moved on.
  void _applyDraft(Map<String, dynamic> frame) {
    final runId = frame['runId'];
    final ordinal = frame['ordinal'];
    final parts = frame['parts'];
    if (runId is! String || ordinal is! int || parts is! List) return;
    if (parts.isEmpty) {
      _replyDrafts.remove(runId);
      return;
    }
    _replyDrafts[runId] = (
      ordinal: ordinal,
      parts: List.unmodifiable([for (final part in parts) '$part']),
    );
  }

  void _applySnapshot(Map<String, dynamic> frame) {
    final conversation = Map<String, dynamic>.from(
      frame['conversation'] as Map,
    );
    _replyDrafts.clear();
    for (final id in _cachedRunIds) {
      _runs.remove(id);
    }
    _cachedRunIds.clear();
    _entityRevision.clear();
    for (final run in conversation['runs'] as List? ?? const []) {
      _put(Map<String, dynamic>.from(run as Map));
    }
    announcements = (conversation['announcements'] as List?) ?? const [];
    before = ((conversation['page'] as Map?)?['nextCursor']) as String?;
    _cachedCursor = false;
    publicationEpoch = frame['epoch'] as String?;
    publicationCursor = frame['cursor'] as String?;
    if (!_disposed) invalidations.value++;
  }

  void _applyUpdate(Map<String, dynamic> frame) {
    final entityId = frame['entityId'] as String?;
    final revision = frame['revision'];
    if (entityId != null && revision is int) {
      final seen = _entityRevision[entityId];
      if (seen != null && revision <= seen) return;
      _entityRevision[entityId] = revision;
    }
    publicationEpoch = frame['epoch'] as String? ?? publicationEpoch;
    publicationCursor = frame['cursor'] as String? ?? publicationCursor;
    final kind = frame['kind'] as String?;
    final payload = frame['payload'];
    if (kind == 'run-status' && payload is Map && payload['run'] is Map) {
      _put(Map<String, dynamic>.from(payload['run'] as Map));
      return;
    }
    if (kind == 'message' && payload is Map) {
      _applyMessage(Map<String, dynamic>.from(payload));
      return;
    }
    if (kind == 'announcement' &&
        payload is Map &&
        payload['announcement'] != null) {
      _upsertAnnouncement(payload['announcement']);
      return;
    }
    if (kind == 'card-revision' && payload is Map) {
      if (!_disposed) invalidations.value++;
      return;
    }
    if (kind == 'computer') {
      if (!_disposed) computerNotices.value++;
      return;
    }
  }

  void _applyMessage(Map<String, dynamic> payload) {
    final runId = payload['runId'] as String?;
    final event = payload['event'];
    if (runId == null || event is! Map) return;
    final send = Map<String, dynamic>.from(event);
    final existing = _runs[runId];
    if (existing == null) {
      _runs[runId] = {
        'runId': runId,
        'sessionId': payload['sessionId'],
        'admittedAt': DateTime.now().toUtc().toIso8601String(),
        'input': '',
        'status': 'running',
        'events': [send],
      };
      return;
    }
    final events = [
      for (final item in (existing['events'] as List?) ?? const [])
        Map<String, dynamic>.from(item as Map),
    ];
    final ordinal = send['ordinal'];
    final index = events.indexWhere(
      (item) => item['type'] == 'send/to-user' && item['ordinal'] == ordinal,
    );
    if (index >= 0) {
      events[index] = send;
    } else {
      events.add(send);
      events.sort(
        (left, right) => ((left['ordinal'] as int?) ?? 0).compareTo(
          (right['ordinal'] as int?) ?? 0,
        ),
      );
    }
    _runs[runId] = {...existing, 'events': events};
  }

  void _upsertAnnouncement(Object? announcement) {
    if (announcement is! Map) return;
    final id = announcement['announcementId'];
    final next = [...announcements];
    final index = next.indexWhere(
      (item) => item is Map && item['announcementId'] == id,
    );
    if (index >= 0) {
      next[index] = announcement;
    } else {
      next.add(announcement);
    }
    announcements = next;
  }

  Future<void> _persistEnvelope() async {
    await writePageCache(
      store,
      userId,
      botId,
      [
        for (final run in runs)
          if (!_optimisticRunIds.contains(run['runId'])) run,
      ],
      before,
      epoch: publicationEpoch,
      cursor: publicationCursor,
      announcements: announcements,
    );
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
        final row = Map<String, dynamic>.from(run as Map);
        if (older && _runs.containsKey(row['runId'])) continue;
        _put(row);
      }
      if (!older) announcements = (page['announcements'] as List?) ?? const [];
      if (older || before == null || _cachedCursor) {
        before = (page['page'] as Map)['nextCursor'] as String?;
        _cachedCursor = false;
      }
      _notice = null;
      _publish();
      {
        // Never the rows this client drew for itself: a cache that holds one
        // reopens the conversation with a Turn that may never have existed.
        unawaited(_persistEnvelope());
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

  /// Sends the draft with whatever is ready in the tray. Files alone are a
  /// message; while one is still uploading, nothing is sent.
  Future<void> send(String text) async {
    if (!canSend || attachments.busy) return;
    final ready = attachments.ready;
    if (text.trim().isEmpty && ready.isEmpty) return;
    // The tray's previews are the thumbnails the thread draws until the
    // server's copy is read.
    for (final item in attachments.items) {
      final uploaded = item.uploaded;
      final preview = item.preview;
      if (uploaded != null && preview != null) {
        _keepAttachmentBytes(uploaded.uploadId, preview);
      }
    }
    await _submit(PendingSend(nextId(), text, attachments: attachments.take()));
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
    final files = MessageAttachment.decodeList(run['attachments']);
    if (text == null || (text.trim().isEmpty && files.isEmpty)) return;
    await _submit(
      PendingSend(
        nextId(),
        text,
        retryOf: runId,
        messageRunId: run['messageRunId'] as String? ?? runId,
        messageAdmittedAt:
            run['messageAdmittedAt'] as String? ?? run['admittedAt'] as String,
        // A retry is the same message, and its files are part of it.
        attachments: files,
      ),
    );
  }

  /// Sends a message the person chose outside the composer — a recording
  /// they are teaching the Bot — and leaves what they are typing alone.
  /// Answers whether it was handed to the send path at all.
  Future<bool> sendFiles(String text, List<MessageAttachment> files) async {
    if (!canSend) return false;
    await _submit(
      PendingSend(nextId(), text, attachments: files),
      keepDraft: true,
    );
    return true;
  }

  Future<void> _submit(PendingSend submission, {bool keepDraft = false}) async {
    final text = submission.text;
    _number(submission);
    _inFlight += 1;
    // A new send clears outcomes for commands that are already resolved.
    // One that is still pending keeps its own.
    _commandErrors.removeWhere(
      (id, _) => !pending.any((entry) => entry.id == id),
    );
    _notice = null;
    _publish();
    // Whether this message is waiting behind anything at all — a Turn the Bot
    // is running, or an earlier send whose own admission is still in flight.
    // Read before the new submission joins the list.
    final waitsBehind = activeRunId != null;
    pending = [...pending, submission];
    // A message sent while the Bot works joins the thread at once, queued
    // until the Bot reads it. The receipt does not say whether it queued, so
    // this row stands until the transcript replaces it.
    if (waitsBehind || submission.retryOf != null) {
      _putOptimisticRun(submission, queued: waitsBehind);
    }
    changed();
    if (submission.retryOf == null && !keepDraft) draft = '';
    try {
      await _persist(); // No transport call can precede this durable local write.
    } catch (_) {
      _forget(submission);
      _restoreSubmission(submission);
      _inFlight -= 1;
      _notice = 'Couldn’t save your message. Please try again.';
      _publish();
      return;
    }
    changed();
    _openPosts.add(submission.id);
    try {
      await transport.send(
        botId,
        submission.id,
        text,
        retryOf: submission.retryOf,
        attachments: submission.attachments,
      );
      await _acceptAdmission(submission);
    } on RequestFailure catch (failure) {
      // The POST has answered, including by timing out. It is no longer
      // in flight, so reconciliation may look it up.
      _openPosts.remove(submission.id);
      if (_confirmed.contains(submission.id)) {
        // The transcript already admitted this command. The POST timing out
        // afterwards does not make delivery uncertain again.
      } else if (failure.refused) {
        _forget(submission);
        _restoreSubmission(submission);
        await _persist();
        _notice = failure.message;
        _publish();
      } else {
        await checkDelivery();
      }
    } catch (_) {
      _openPosts.remove(submission.id);
      if (!_confirmed.contains(submission.id)) await checkDelivery();
    } finally {
      _openPosts.remove(submission.id);
      _inFlight -= 1;
      changed();
    }
  }

  /// A receipt means the server has the command. The optimistic row stays
  /// until the transcript replaces it, so the message does not disappear.
  Future<void> _acceptAdmission(PendingSend submission) async {
    _confirmed.add(submission.id);
    _commandErrors.remove(submission.id);
    if (!_runs.containsKey(submission.id)) {
      _putOptimisticRun(submission, queued: false);
    }
    final kept = pending;
    pending = [
      for (final entry in pending)
        if (entry.id != submission.id) entry,
    ];
    try {
      await _persist();
    } catch (_) {
      pending = kept;
      _commandErrors[submission.id] =
          'Couldn’t confirm your message. Reconnect or check again.';
    }
    _publish();
    await refresh();
  }

  void _restoreSubmission(PendingSend submission) {
    if (submission.retryOf != null) return;
    final text = submission.text;
    if (text.isNotEmpty) draft = draft.isEmpty ? text : '$text\n\n$draft';
    attachments.restore(
      submission.attachments,
      preview: (uploadId) => _attachmentBytes[uploadId],
    );
  }

  void _forget(PendingSend submission) {
    if (_optimisticRunIds.remove(submission.id)) _runs.remove(submission.id);
    pending = [
      for (final entry in pending)
        if (entry.id != submission.id) entry,
    ];
  }

  /// The check already walking the list, so a submission whose POST answers
  /// while that walk is open waits for it and then looks itself up. Checking
  /// it inside the open walk would fence a POST that has not answered yet.
  Future<void>? _deliveryCheck;

  /// Finds out what became of every submission this client has not confirmed.
  ///
  /// Oldest first, over a snapshot of the list. A submission admitted while
  /// this is running waits until the walk finishes, then is looked up by the
  /// call that follows its own POST — never before that POST has answered.
  Future<void> checkDelivery() async {
    if (pending.isEmpty) return;
    final running = _deliveryCheck;
    if (running != null) {
      await running;
      if (pending.isEmpty || _deliveryCheck != null) return;
    }
    final done = Completer<void>();
    _deliveryCheck = done.future;
    checking = true;
    changed();
    try {
      for (final submission in [...pending]) {
        if (_openPosts.contains(submission.id)) continue;
        await _confirm(submission);
      }
    } finally {
      checking = false;
      _deliveryCheck = null;
      if (!done.isCompleted) done.complete();
      changed();
    }
  }

  /// One submission's fate: found in the durable transcript, or handed back to
  /// the draft it came out of. A submission this cannot settle stays pending,
  /// which is what "Check message status" offers to try again.
  Future<void> _confirm(PendingSend submission) async {
    if (_confirmed.contains(submission.id)) {
      final kept = pending;
      pending = [
        for (final entry in pending)
          if (entry.id != submission.id) entry,
      ];
      try {
        await _persist();
        _commandErrors.remove(submission.id);
      } catch (_) {
        pending = kept;
        _commandErrors[submission.id] =
            'Couldn’t confirm your message. Reconnect or check again.';
      }
      _publish();
      return;
    }
    try {
      final observed = await transport.lookup(botId, submission.id);
      // A read alone cannot prove a delayed POST will never be admitted.
      final run =
          observed ?? await transport.lookup(botId, submission.id, fence: true);
      final previousDraft = draft;
      if (run != null) {
        _confirmed.add(submission.id);
        _commandErrors.remove(submission.id);
        _cachedRunIds.remove(submission.id);
        _optimisticRunIds.remove(submission.id);
        _runs[submission.id] = run;
      } else {
        _restoreSubmission(submission);
        _commandErrors[submission.id] = submission.retryOf == null
            ? 'Your message didn’t go through. You can send it again.'
            : 'Your retry didn’t go through. Try again on the original message.';
      }
      final reconciledDraft = draft;
      final kept = pending;
      if (run != null) {
        pending = [
          for (final entry in pending)
            if (entry.id != submission.id) entry,
        ];
      } else {
        _forget(submission);
      }
      try {
        await _persist();
      } catch (_) {
        pending = kept;
        if (submission.retryOf != null) {
          _putOptimisticRun(submission, queued: false);
        }
        if (draft == reconciledDraft) draft = previousDraft;
        _commandErrors[submission.id] =
            'Couldn’t confirm your message. Reconnect or check again.';
        _publish();
        return;
      }
      _publish();
    } catch (_) {
      _commandErrors[submission.id] =
          'Couldn’t confirm your message. Reconnect or check again.';
      _publish();
    }
  }

  Future<void> stop() async {
    final target = activeRunId;
    if (target == null || stopping) return;
    stopping = true;
    _notice = null;
    _publish();
    try {
      if (stopTarget != target) {
        stopTarget = target;
        stopId = nextId();
      }
      await _persist();
      _put(await transport.stop(botId, target, stopId!));
      // An accepted Stop can still be running. The projection decides completion.
    } catch (_) {
      _notice = 'Couldn’t confirm Stop. You can try Stop again.';
      _publish();
    } finally {
      stopping = false;
      changed();
    }
  }

  @override
  void dispose() {
    _disposed = true;
    attachments.dispose();
    _questionTimer?.cancel();
    invalidations.dispose();
    computerNotices.dispose();
    super.dispose();
  }
}
