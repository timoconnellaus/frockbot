/// The thread, drawn.
///
/// Chat is the Bot's words. A tool receipt is not a word, so it is not here —
/// a message that ran tools carries one quiet control that opens the run view,
/// and the receipts live there.
library;

import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';

import '../client/attachments.dart';
import '../flock/avatar.dart';
import '../theme/frock_theme.dart';
import '../theme/states.dart';
import '../theme/thread.dart';
import '../theme/time.dart';
import 'attachment_views.dart';
import 'chat_header.dart';
import 'markdown.dart';
import 'run_view.dart';
import 'semantics.dart';
import 'send_payload.dart';
import 'transcript_model.dart';

export 'transcript_model.dart';

class TranscriptView extends StatefulWidget {
  final List<TranscriptLine> lines;

  /// The message the person has sent but the backend has not confirmed, as
  /// [unconfirmedLine] draws it. It is ordered with the other messages sent
  /// from here that the transcript does not carry yet (see [orderTranscript]),
  /// and offers no message actions: there is no Turn yet to open or to mark
  /// unread from.
  final TranscriptLine? pending;
  final bool loading;

  /// Whether there is an older page to fetch.
  final bool hasEarlier;
  final Future<void> Function({bool older}) onRefresh;
  final void Function(TranscriptLine line) onOpenRun;

  /// Opens the view-only chat between this Bot and the marker's counterpart.
  final void Function(TranscriptLine line)? onOpenExchange;

  /// Another Bot's character and colour, for the marker that names it. Null
  /// draws the default character: a Bot no longer in the flock still gets a
  /// face.
  final String? Function(String botId)? backgroundOf;
  final String? Function(String botId)? primaryOf;

  /// Another Bot's current name. The wire names a Bot only by id where this
  /// Bot did the asking; null falls back to what the projection knows.
  final String? Function(String botId)? nameOf;
  final void Function(TranscriptLine line)? onRetryTurn;

  /// Where a failure whose remedy is Billing sends the person.
  final VoidCallback? onOpenBilling;
  final void Function(String url)? onOpenLink;
  final void Function(TranscriptLine, {Offset? position})? onMessageActions;
  final String? unreadFromMessageId;

  /// The newest message this thread delivers while its route is current, and
  /// whether any of its row is on screen. The newest is named even when it is
  /// not: a person scrolled up in the chat is still in it.
  final void Function(String? newest, bool onScreen)? onReadLatest;
  final String storageKey;

  /// The Bot itself at the end of the thread, where its next words will land,
  /// while it works: the pane hands it over already moving, and null once the
  /// Turn settles. It grows in and out rather than appearing, so the thread
  /// eases up and down instead of jumping at each end of a Turn.
  final Widget? tail;

  /// A Turn the reader asked to be taken to — a search hit. It is brought into
  /// view and marked, once. A Turn further back than the loaded page is simply
  /// not here, and the thread says nothing rather than pretending to scroll.
  final String? focusRunId;

  /// The Bot's character. Every live avatar in the thread uses the same
  /// appearance as the sidebar and conversation companion.
  final String? background;

  /// Drawn under the empty thread's greeting, and gone with the first row.
  final Widget? starters;

  /// Reads a sent picture's bytes. Absent, pictures are drawn as cards.
  final Future<Uint8List> Function(MessageAttachment attachment)?
  attachmentBytes;
  const TranscriptView({
    super.key,
    required this.lines,
    required this.loading,
    required this.hasEarlier,
    required this.onRefresh,
    required this.onOpenRun,
    required this.storageKey,
    this.tail,
    this.pending,
    this.onOpenExchange,
    this.backgroundOf,
    this.primaryOf,
    this.nameOf,
    this.onRetryTurn,
    this.onOpenBilling,
    this.onOpenLink,
    this.onMessageActions,
    this.unreadFromMessageId,
    this.onReadLatest,
    this.focusRunId,
    this.background,
    this.starters,
    this.attachmentBytes,
  });

  @override
  State<TranscriptView> createState() => _TranscriptViewState();
}

class _TranscriptViewState extends State<TranscriptView> {
  static const workingPadding = EdgeInsets.fromLTRB(16, 6, 16, 6);

  /// Floor for a row that has not been measured yet. The newest bubbles are
  /// shorter than this; using them as the guess is what made the far end
  /// unreachable.
  static const _heightFloor = 200.0;

  final GlobalKey focusKey = GlobalKey();

  /// One key per line, so the newest message can be measured against the
  /// viewport. Keyed by line id and handed to every row rather than to the
  /// newest alone: a key that appeared and disappeared as the thread grew
  /// would rebuild the row it left, and a live Card with it.
  final Map<String, GlobalKey> probes = {};
  final ScrollController scroll = ScrollController();

  /// Measured main-axis height of each slot. Mutated from layout; never a
  /// reason to rebuild. An unknown row is estimated from the tallest entry,
  /// so the short newest bubbles cannot shrink the scrollbar.
  final Map<String, double> _rowHeights = {};

  /// One older-page fetch per fling. Cleared when that fetch finishes, not on
  /// every scroll frame.
  bool _loadingOlder = false;

  List<_ThreadSlot> _slots = const [];
  String? _focusLineId;

  @override
  void initState() {
    super.initState();
    scroll.addListener(_onScroll);
  }

  void _onScroll() {
    _scheduleReportRead();
    _loadOlderIfNearEnd();
  }

  /// Fetch the next page once the reader is close to the far end.
  ///
  /// The first frame of a reverse list sits on the newest reply. An
  /// underestimate there still reports a small `pixels`, and treating that as
  /// the far end would pull history while they are reading the latest line.
  /// A thread that already fits has nothing further to fetch.
  void _loadOlderIfNearEnd() {
    if (_loadingOlder || !hasEarlier || !scroll.hasClients) return;
    final position = scroll.position;
    if (!position.hasContentDimensions) return;
    if (position.maxScrollExtent <= 0 || position.pixels <= 8) return;
    if (position.maxScrollExtent - position.pixels > 480) return;
    _loadingOlder = true;
    onRefresh(older: true).whenComplete(() {
      _loadingOlder = false;
    });
  }

  /// The lines the cached newest-send id was derived from. `_reportRead` runs
  /// on every scroll frame, and ordering the whole thread again each time is a
  /// sort per frame of a fling; the transcript only changes when the projection
  /// hands down a new list.
  List<TranscriptLine>? _latestSendSource;
  String? _latestSendId;

  /// The line the newest send is drawn on, which is not always its own id: a
  /// failed attempt is displayed on the message it was a retry of.
  String? _latestSendLineId;

  /// The message id a line delivers, or null where it delivers none. A draft
  /// delivers nothing yet: reading it is not reading the message it becomes.
  String? _sendIdOf(TranscriptLine line) =>
      line.failureMessageId ??
      (line.role == LineRole.assistant &&
              !line.isDraft &&
              (line.id.contains(':send:') ||
                  (line.id.endsWith(':failed') && line.notice != null))
          ? line.id
          : null);

  String? _newestSendId(List<TranscriptLine> ordered) {
    _latestSendSource = widget.lines;
    _latestSendId = null;
    _latestSendLineId = null;
    String? newestAt;
    for (final line in ordered) {
      final messageId = _sendIdOf(line);
      if (messageId == null) continue;
      // A retry is displayed with its original message, but read order is the
      // order of the actual attempts, including a reply to an older message.
      final at = line.readAt ?? line.at ?? '';
      final followsFailure =
          at == newestAt && _latestSendId == '${line.runId}:failed';
      if (newestAt == null ||
          (at.compareTo(newestAt) >= 0 && !followsFailure)) {
        newestAt = at;
        _latestSendId = messageId;
        _latestSendLineId = line.id;
      }
    }
    return _latestSendId;
  }

  /// Whether any part of the newest message's row is inside the viewport.
  ///
  /// Reading a message is seeing it, not being pinned to the end of the list.
  /// A thread nudged up a line — to copy something, or because the composer
  /// grew — is still the thread the person is reading, and the count it raises
  /// is one they can see is stale. The end of the list is kept as a second
  /// answer: a short thread that does not scroll has no row geometry to ask.
  bool get _showingLatest {
    if (scroll.hasClients && scroll.position.pixels <= 8) return true;
    final lineId = _latestSendLineId;
    final box = lineId == null
        ? null
        : probes[lineId]?.currentContext?.findRenderObject();
    if (box is! RenderBox || !box.attached || !box.hasSize) return false;
    final RenderObject? viewport = RenderAbstractViewport.maybeOf(box);
    if (viewport is! RenderBox || !viewport.hasSize) return false;
    final top = box.localToGlobal(Offset.zero, ancestor: viewport).dy;
    return top < viewport.size.height && top + box.size.height > 0;
  }

  bool _readScheduled = false;

  /// A scroll notification arrives while the position is changing, before the
  /// frame that moves the rows has been laid out: asking a row where it is
  /// then answers for where it was. The report waits for the end of the frame,
  /// where the geometry is the one the person is looking at.
  void _scheduleReportRead() {
    if (_readScheduled || !mounted) return;
    _readScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _readScheduled = false;
      _reportRead();
    });
  }

  void _reportRead() {
    if (!mounted) return;
    final newest = identical(_latestSendSource, widget.lines)
        ? _latestSendId
        : _newestSendId(
            orderTranscript(
              widget.lines,
              DateTime.now().toUtc().toIso8601String(),
            ),
          );
    if (ModalRoute.of(context)?.isCurrent != true) {
      widget.onReadLatest?.call(null, false);
      return;
    }
    widget.onReadLatest?.call(newest, newest != null && _showingLatest);
  }

  @override
  void dispose() {
    scroll.dispose();
    super.dispose();
  }

  String? focused;

  bool get loading => widget.loading;
  bool get hasEarlier => widget.hasEarlier;
  Future<void> Function({bool older}) get onRefresh => widget.onRefresh;
  void Function(TranscriptLine line) get onOpenRun => widget.onOpenRun;
  void Function(TranscriptLine line)? get onRetryTurn => widget.onRetryTurn;
  VoidCallback? get onOpenBilling => widget.onOpenBilling;
  void Function(String url)? get onOpenLink => widget.onOpenLink;
  String get storageKey => widget.storageKey;

  /// Whether [_row] would draw [line]. Deciding that here keeps the slot list
  /// from building every bubble just to count the children.
  bool _draws(TranscriptLine line) {
    if (line.exchange != null || line.voiceCall != null) return true;
    if (line.role == LineRole.system || line.role == LineRole.user) {
      return true;
    }
    if (line.status == LineStatus.streaming && line.empty) {
      // Same branch as [_row]: only a Stop the person asked for has words.
      // Anything else is the companion, not a row.
      return line.stopRequested;
    }
    if (line.notice != null || line.text.isNotEmpty) return true;
    for (final send in line.sends) {
      if (!sendDrawnAsCardV1(send)) return true;
    }
    return false;
  }

  void _revealFocus(int index, int attempt) {
    if (!mounted) return;
    final current = focusKey.currentContext;
    if (current != null) {
      Scrollable.ensureVisible(current, alignment: 0.4);
      return;
    }
    // Outside the cache the element does not exist yet. Jump toward its
    // estimated offset so the next frame can build it and bring it into view.
    if (attempt >= 6 ||
        !scroll.hasClients ||
        index < 0 ||
        index >= _slots.length) {
      return;
    }
    final position = scroll.position;
    if (!position.hasContentDimensions) return;
    var guess = _heightFloor;
    for (final height in _rowHeights.values) {
      if (height > guess) guess = height;
    }
    var offset = 0.0;
    for (var i = 0; i < index; i++) {
      offset += _rowHeights[_slots[i].id] ?? guess;
    }
    final target = offset.clamp(0.0, position.maxScrollExtent);
    if ((position.pixels - target).abs() <= 1) return;
    position.jumpTo(target);
    WidgetsBinding.instance.addPostFrameCallback(
      (_) => _revealFocus(index, attempt + 1),
    );
  }

  @override
  Widget build(BuildContext context) {
    WidgetsBinding.instance.addPostFrameCallback((_) => _reportRead());
    final now = DateTime.now();
    final ordered = orderTranscript([
      ...widget.lines,
      ?widget.pending,
    ], now.toUtc().toIso8601String());
    _newestSendId(ordered);
    final target = widget.focusRunId;
    // Oldest match: a Turn is a user line and then its reply, and the mark
    // belongs on the first of those, which is where the Turn starts.
    String? focusLineId;
    if (target != null) {
      for (final line in ordered) {
        if (!_draws(line)) continue;
        if (line.runId == target || line.id == '$target:user') {
          focusLineId = line.id;
          break;
        }
      }
    }
    _focusLineId = focusLineId;
    // reverse: true lays index 0 at the visual bottom, so the slot list is
    // newest first.
    final slots = <_ThreadSlot>[];
    slots.add(const _ThreadSlot('tail', _SlotKind.tail));
    _stamped = _stamps(ordered.where(_draws));
    var anyLine = false;
    for (final line in ordered.reversed) {
      if (!_draws(line)) continue;
      anyLine = true;
      slots.add(_ThreadSlot('row:${line.id}', _SlotKind.line, line));
      if (line.id == widget.unreadFromMessageId ||
          (line.failureMessageId != null &&
              line.failureMessageId == widget.unreadFromMessageId)) {
        // After the line in this newest-first list, so it sits visually above.
        slots.add(_ThreadSlot('unread:${line.id}', _SlotKind.unread, line));
      }
    }
    // The probes outlive one build only for the lines still drawn; a thread
    // that pages in and out must not accumulate keys for rows that are gone.
    final drawn = <String>{
      for (final slot in slots)
        if (slot.kind == _SlotKind.line) slot.line!.id,
    };
    probes.removeWhere((id, _) => !drawn.contains(id));
    if (!anyLine) {
      _slots = const [];
      _rowHeights.clear();
      return loading
          ? const FrockLoading(label: 'Loading your conversation')
          : _EmptyThread(starters: widget.starters);
    }
    if (hasEarlier) {
      slots.add(const _ThreadSlot('row:earlier', _SlotKind.earlier));
    }
    final live = {for (final slot in slots) slot.id};
    _rowHeights.removeWhere((id, _) => !live.contains(id));
    _slots = slots;
    final indexById = <String, int>{
      for (var index = 0; index < slots.length; index++) slots[index].id: index,
    };
    final focusIndex = focusLineId == null
        ? null
        : indexById['row:$focusLineId'];
    if (focusLineId != null && focused != target) {
      focused = target;
      final index = focusIndex!;
      WidgetsBinding.instance.addPostFrameCallback(
        (_) => _revealFocus(index, 0),
      );
    }
    return identified(
      ShellIds.transcript,
      // Highlight-and-copy is the ordinary way to take words out of a
      // conversation. The row still has its own long-press and secondary
      // click for whole-message actions; those do not replace selection.
      SelectionArea(
        child: RefreshIndicator(
          onRefresh: onRefresh,
          child: ListView.custom(
            controller: scroll,
            // The thread starts at the latest row. Earlier pages extend the
            // far end, so prepending history keeps the viewport where it was.
            reverse: true,
            padding: const EdgeInsets.fromLTRB(
              0,
              chatHeaderThreadPadding,
              0,
              12,
            ),
            physics: const AlwaysScrollableScrollPhysics(),
            keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
            key: PageStorageKey(storageKey),
            // Enough to measure tall older rows before a fling arrives.
            // `double.infinity` gives the semantics a non-finite rect.
            scrollCacheExtent: const ScrollCacheExtent.pixels(8000),
            childrenDelegate: _TranscriptDelegate(
              slots: slots,
              heights: _rowHeights,
              findChildIndexCallback: (key) =>
                  key is ValueKey<String> ? indexById[key.value] : null,
              builder: (context, index) {
                if (index < 0 || index >= slots.length) return null;
                final slot = slots[index];
                return _MeasuredSlot(
                  key: ValueKey(slot.id),
                  id: slot.id,
                  heights: _rowHeights,
                  child: _slotChild(context, slot),
                );
              },
            ),
          ),
        ),
      ),
    );
  }

  Widget _slotChild(BuildContext context, _ThreadSlot slot) {
    switch (slot.kind) {
      case _SlotKind.tail:
        return AnimatedSize(
          duration: FrockTheme.motion(context),
          curve: Curves.easeOutCubic,
          alignment: Alignment.topLeft,
          child: widget.tail == null
              ? const SizedBox(width: double.infinity)
              : Padding(
                  padding: const EdgeInsets.fromLTRB(20, 10, 16, 4),
                  child: Align(
                    alignment: AlignmentDirectional.centerStart,
                    child: IgnorePointer(child: widget.tail),
                  ),
                ),
        );
      case _SlotKind.earlier:
        return identified(
          ShellIds.transcriptEarlier,
          EarlierMessages(
            onPressed: () => onRefresh(older: true),
            loading: loading,
          ),
        );
      case _SlotKind.unread:
        return const UnreadDivider();
      case _SlotKind.line:
        final line = slot.line!;
        // A draft is not a message yet: there is nothing to copy that will
        // not change, and nothing the server could mark read.
        final actions =
            line.role == LineRole.system ||
                identical(line, widget.pending) ||
                line.isDraft
            ? null
            : widget.onMessageActions;
        final row = GestureDetector(
          key: ValueKey('row:${line.id}'),
          onLongPress: actions == null ? null : () => actions(line),
          onSecondaryTapUp: actions == null
              ? null
              : (details) => actions(line, position: details.globalPosition),
          child: KeyedSubtree(
            key: probes.putIfAbsent(line.id, GlobalKey.new),
            child: _row(context, line)!,
          ),
        );
        if (line.id != _focusLineId) return row;
        return Container(
          key: focusKey,
          decoration: BoxDecoration(
            color: Theme.of(context).colorScheme.onSurface
                .withValues(alpha: 0.05),
            borderRadius: BorderRadius.circular(FrockTheme.radiusControl),
            border: Border.all(color: Theme.of(context).colorScheme.primary),
          ),
          child: row,
        );
    }
  }

  /// The time each message is written with. A message is stamped when it
  /// starts a new speaker's run, or five minutes after the last stamp in the
  /// same run, so a burst from one side carries one time, not one per line.
  Map<String, String> _stamped = const {};

  static Map<String, String> _stamps(Iterable<TranscriptLine> lines) {
    final now = DateTime.now();
    final stamped = <String, String>{};
    LineRole? role;
    DateTime? last;
    for (final line in lines) {
      if (line.exchange != null ||
          line.voiceCall != null ||
          line.role == LineRole.system) {
        role = null;
        continue;
      }
      // An unconfirmed message has no time of its own yet. It reads as now,
      // so receiving it changes nothing drawn.
      final at = localInstant(line.at) ?? now;
      if (line.role != role ||
          last == null ||
          at.difference(last).inMinutes >= 5) {
        stamped[line.id] = messageTimeLabel(at, now);
        last = at;
      }
      role = line.role;
    }
    return stamped;
  }

  Widget _bubble({
    required String id,
    required bool mine,
    required Widget child,
    String? time,
  }) => identified(
    ShellIds.message(id),
    MessageBubble(
      key: ValueKey(id),
      mine: mine,
      time: time,
      animate: true,
      semanticsLabel: mine ? 'You' : 'Bot',
      child: child,
    ),
  );

  /// One line, or nothing where the line has nothing to say — a running Turn
  /// before its first token is the animated row, not an empty bubble.
  Widget? _row(BuildContext context, TranscriptLine line) {
    if (line.exchange != null) {
      final botId = line.exchange!.counterpart.botId;
      return _ExchangeMarker(
        line: line,
        background: botId == null ? null : widget.backgroundOf?.call(botId),
        primary: botId == null ? null : widget.primaryOf?.call(botId),
        name: botId == null ? null : widget.nameOf?.call(botId),
        onOpen: widget.onOpenExchange,
      );
    }
    if (line.voiceCall != null) {
      return _VoiceCallAccordion(call: line.voiceCall!);
    }
    if (line.role == LineRole.system) {
      return _Announcement(text: line.text);
    }
    if (line.role == LineRole.user) {
      // Where the person wrote it, when that was not here.
      final caption = switch (line.via) {
        'email' => 'via email',
        _ => null,
      };
      final words = line.text.isEmpty
          ? null
          : _bubble(
              id: line.id,
              mine: true,
              time: _stamped[line.id],
              child: caption != null
                  ? Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(line.text),
                        const SizedBox(height: 4),
                        // In the bubble's own ink, quieter: whatever colour the
                        // person's bubble is, the caption stays readable on it.
                        Builder(
                          builder: (context) => Text(
                            caption,
                            style: Theme.of(context).textTheme.labelSmall
                                ?.copyWith(
                                  color: DefaultTextStyle.of(context)
                                      .style
                                      .color
                                      ?.withValues(alpha: 0.72),
                                ),
                          ),
                        ),
                      ],
                    )
                  : Text(line.text),
            );
      // The files go above the words, outside the bubble: a picture is its
      // own thing to look at, not a line of text.
      final bubble = line.attachments.isEmpty
          ? words ?? const SizedBox.shrink()
          : Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              mainAxisSize: MainAxisSize.min,
              children: [
                identified(
                  ShellIds.message('${line.id}:files'),
                  Padding(
                    padding: const EdgeInsets.fromLTRB(64, 5, 20, 2),
                    child: Align(
                      alignment: AlignmentDirectional.centerEnd,
                      child: MessageAttachmentsView(
                        attachments: line.attachments,
                        load: widget.attachmentBytes,
                      ),
                    ),
                  ),
                ),
                ?words,
              ],
            );
      if (line.notice == null) return bubble;
      // The person's message arrived; it is the reply that did not. So the
      // way out sits where the reply would have been, not on their words.
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          bubble,
          _Notice(
            line: line,
            onRetry: onRetryTurn,
            onOpenBilling: onOpenBilling,
          ),
        ],
      );
    }
    if (line.status == LineStatus.streaming && line.empty) {
      // A running Turn draws nothing in the thread, and neither does the Turn
      // of a message waiting behind it: the Bot at the end of the thread is the
      // one that works, and it reads the waiting message at its next step. Only a
      // Stop the person asked for and is now waiting on earns words.
      if (!line.stopRequested) return null;
      return Padding(
        padding: workingPadding,
        child: const WorkingIndicator(label: 'Stopping…'),
      );
    }
    final children = <Widget>[
      // A send a locked Plugin drew as a Card has no face here (ADR 0030 step
      // 7), and it is skipped rather than drawn as nothing: a bubble with
      // nothing in it is worse than either the card or the silence.
      for (final send in line.sends)
        if (!sendDrawnAsCardV1(send))
          SendPayloadView(send: send, onOpenLink: onOpenLink),
      if (line.text.isNotEmpty)
        ShellMarkdown(text: line.text, onOpenLink: onOpenLink),
    ];
    if (children.isEmpty && line.notice == null) {
      return null;
    }
    // An ending with nothing said is not a message from the Bot, so it gets
    // no bubble: a stop is a marker in the thread, a failure its one line.
    final notice = line.notice == null
        ? null
        : line.status == LineStatus.aborted && line.retry == null
        ? _Announcement(text: line.notice!)
        : _Notice(
            line: line,
            onRetry: onRetryTurn,
            onOpenBilling: onOpenBilling,
          );
    if (children.isEmpty) return notice;
    final bubble = _bubble(
      id: line.id,
      mine: false,
      time: _stamped[line.id],
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          for (final child in children) ...[
            child,
            if (child != children.last) const SizedBox(height: 8),
          ],
        ],
      ),
    );
    if (notice == null) return bubble;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [bubble, notice],
    );
  }
}

enum _SlotKind { tail, line, unread, earlier }

class _ThreadSlot {
  final String id;
  final _SlotKind kind;
  final TranscriptLine? line;
  const _ThreadSlot(this.id, this.kind, [this.line]);
}

/// Estimates the rows the sliver has not built from the height cache.
///
/// [itemExtentBuilder] is the wrong tool: it forces the child's extent
/// instead of measuring it. The guess for an unknown row is the tallest
/// height measured so far, never the average of the short newest bubbles.
class _TranscriptDelegate extends SliverChildBuilderDelegate {
  _TranscriptDelegate({
    required this._slots,
    required this._heights,
    required NullableIndexedWidgetBuilder builder,
    required ChildIndexGetter findChildIndexCallback,
  }) : super(
         builder,
         findChildIndexCallback: findChildIndexCallback,
         childCount: _slots.length,
       );

  final List<_ThreadSlot> _slots;
  final Map<String, double> _heights;

  @override
  double? estimateMaxScrollOffset(
    int firstIndex,
    int lastIndex,
    double leadingScrollOffset,
    double trailingScrollOffset,
  ) {
    assert(firstIndex <= lastIndex);
    assert(leadingScrollOffset.isFinite && trailingScrollOffset.isFinite);
    var guess = _TranscriptViewState._heightFloor;
    for (final height in _heights.values) {
      if (height > guess) guess = height;
    }
    var total = trailingScrollOffset;
    for (var index = lastIndex + 1; index < _slots.length; index++) {
      total += _heights[_slots[index].id] ?? guess;
    }
    return total;
  }
}

/// Records its child's main-axis height. Layout must not call setState; the
/// map is read by the next estimate.
class _MeasuredSlot extends SingleChildRenderObjectWidget {
  final String id;
  final Map<String, double> heights;
  const _MeasuredSlot({
    super.key,
    required this.id,
    required this.heights,
    required super.child,
  });

  @override
  RenderObject createRenderObject(BuildContext context) =>
      _RenderMeasuredSlot(id: id, heights: heights);

  @override
  void updateRenderObject(
    BuildContext context,
    _RenderMeasuredSlot renderObject,
  ) {
    renderObject
      ..id = id
      ..heights = heights;
  }
}

class _RenderMeasuredSlot extends RenderProxyBox {
  _RenderMeasuredSlot({required this._id, required this._heights});

  String _id;
  Map<String, double> _heights;

  String get id => _id;
  set id(String value) {
    if (_id == value) return;
    _id = value;
    markNeedsLayout();
  }

  set heights(Map<String, double> value) {
    if (identical(_heights, value)) return;
    _heights = value;
    markNeedsLayout();
  }

  @override
  void performLayout() {
    super.performLayout();
    final measured = size.height;
    if (!measured.isFinite) return;
    if (_heights[_id] != measured) _heights[_id] = measured;
  }
}

/// Why a Turn ended where it did, and the way out of it, on the Bot's side of
/// the thread: said once, quietly, with the action beside it. A reply that
/// did not come is not an alarm, and it is not the person's doing.
class _Notice extends StatelessWidget {
  final TranscriptLine line;
  final void Function(TranscriptLine line)? onRetry;
  final VoidCallback? onOpenBilling;
  const _Notice({required this.line, this.onRetry, this.onOpenBilling});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.colorScheme.onSurfaceVariant;
    Widget link(String id, String label, IconData icon, VoidCallback onTap) =>
        identified(id, ThreadLink(icon: icon, label: label, onTap: onTap));
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 2, 16, 4),
      // Wrapped, not a row: at large text the sentence and its action do not
      // fit side by side on a phone, and clipping either is not an option.
      child: Wrap(
        spacing: 6,
        runSpacing: 2,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          Text(
            line.notice!,
            style: theme.textTheme.bodySmall?.copyWith(color: muted),
          ),
          if (line.retry == LineRetry.resendTurn && onRetry != null)
            link(
              ShellIds.retryTurn(line.runId),
              'Retry',
              Icons.refresh_rounded,
              () => onRetry!(line),
            ),
          if (line.retry == LineRetry.openBilling && onOpenBilling != null)
            link(
              ShellIds.openBilling(line.runId),
              'Open Billing',
              Icons.open_in_new_rounded,
              onOpenBilling!,
            ),
        ],
      ),
    );
  }
}

class _Announcement extends StatelessWidget {
  final String text;
  const _Announcement({required this.text});

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 8),
    child: Center(
      child: Text(
        text,
        textAlign: TextAlign.center,
        style: Theme.of(context).textTheme.bodySmall?.copyWith(
          color: Theme.of(context).colorScheme.onSurfaceVariant
              .withValues(alpha: 0.8),
        ),
      ),
    ),
  );
}

class _VoiceCallAccordion extends StatefulWidget {
  final VoiceCallSection call;
  const _VoiceCallAccordion({required this.call});

  @override
  State<_VoiceCallAccordion> createState() => _VoiceCallAccordionState();
}

class _VoiceCallAccordionState extends State<_VoiceCallAccordion> {
  var expanded = false;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final call = widget.call;
    final muted = scheme.onSurfaceVariant;
    final spoken = call.turns.where((turn) => turn.transcript.isNotEmpty);
    final duration = voiceCallDurationLabel(call.startedAt, call.endedAt);
    final exchanges = call.turns.length;
    final detail = [
      if (duration.isNotEmpty) duration,
      if (exchanges > 0) exchanges == 1 ? '1 exchange' : '$exchanges exchanges',
    ].join(' · ');
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 560),
          child: Material(
            color: scheme.surfaceContainerHighest,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(FrockTheme.radiusCard),
              side: BorderSide(color: FrockTheme.hairline(scheme)),
            ),
            clipBehavior: Clip.antiAlias,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              mainAxisSize: MainAxisSize.min,
              children: [
                Semantics(
                  identifier: VoiceIds.callTranscript,
                  button: true,
                  label: voiceCallTitle(call),
                  child: InkWell(
                    onTap: () => setState(() => expanded = !expanded),
                    child: Padding(
                      padding: const EdgeInsets.fromLTRB(12, 12, 14, 12),
                      child: Row(
                        children: [
                          Container(
                            width: 40,
                            height: 40,
                            decoration: BoxDecoration(
                              color: scheme.primary,
                              shape: BoxShape.circle,
                            ),
                            child: Icon(
                              Icons.graphic_eq_rounded,
                              size: 22,
                              color: scheme.onPrimary,
                            ),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  'Voice chat',
                                  style: theme.textTheme.titleSmall?.copyWith(
                                    fontWeight: FontWeight.w600,
                                  ),
                                ),
                                if (detail.isNotEmpty)
                                  Text(
                                    detail,
                                    style: theme.textTheme.bodySmall?.copyWith(
                                      color: muted,
                                    ),
                                  ),
                              ],
                            ),
                          ),
                          Icon(
                            expanded
                                ? Icons.expand_less_rounded
                                : Icons.expand_more_rounded,
                            size: 22,
                            color: muted,
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
                if (!expanded && spoken.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(64, 0, 16, 14),
                    child: Text(
                      '“${spoken.first.transcript}”',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: muted,
                        fontStyle: FontStyle.italic,
                      ),
                    ),
                  ),
                if (expanded)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        for (final turn in call.turns) ...[
                          if (turn.transcript.isNotEmpty)
                            _SpokenLine(text: turn.transcript, mine: true),
                          if (turn.answer != null && turn.answer!.isNotEmpty)
                            _SpokenLine(text: turn.answer!, mine: false),
                        ],
                      ],
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// One thing said on a call, drawn as a small bubble on its speaker's side.
class _SpokenLine extends StatelessWidget {
  final String text;
  final bool mine;
  const _SpokenLine({required this.text, required this.mine});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Align(
      alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        margin: EdgeInsets.fromLTRB(mine ? 40 : 0, 4, mine ? 0 : 40, 4),
        padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 7),
        decoration: BoxDecoration(
          color: mine
              ? theme.extension<FrockLook>()?.bubbleFill(mine: true) ??
                    scheme.surface
              : scheme.surface.withValues(alpha: 0.6),
          borderRadius: BorderRadius.circular(14),
        ),
        child: Text(text, style: theme.textTheme.bodyMedium),
      ),
    );
  }
}

class _EmptyThread extends StatelessWidget {
  final Widget? starters;
  const _EmptyThread({this.starters});

  @override
  Widget build(BuildContext context) => SingleChildScrollView(
    child: EmptyThread(
      title: 'What would you like to work on?',
      detail: 'Ask a question, make a plan, or give your Bot something to do.',
      child: starters,
    ),
  );
}

/// One line in the thread for a message that crossed to or from a
/// counterpart: who, which way, and where it stands. The words themselves
/// are read on the exchange view this opens, never here — the thread stays
/// this Bot's conversation with the person.
class _ExchangeMarker extends StatelessWidget {
  final TranscriptLine line;
  final String? background;
  final String? primary;
  final String? name;
  final void Function(TranscriptLine line)? onOpen;
  const _ExchangeMarker({
    required this.line,
    required this.background,
    required this.primary,
    required this.name,
    required this.onOpen,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final exchange = line.exchange!;
    final quiet = ThreadMarker.quiet(theme);
    final status = exchange.statusLabel;
    return ThreadMarker(
      identifier: ShellIds.exchange(line.id),
      tapKey: ValueKey('exchange:${line.id}'),
      onTap: onOpen == null ? null : () => onOpen!(line),
      children: [
        Text(
          exchange.direction == ExchangeDirection.outbound
              ? 'Messaged'
              : 'Message from',
          style: quiet,
        ),
        CounterpartAvatar(
          counterpart: exchange.counterpart,
          background: background,
          primary: primary,
          size: 18,
        ),
        Text(
          name ?? exchange.counterpart.label,
          style: ThreadMarker.named(theme),
        ),
        if (status != null) Text('· $status', style: quiet),
      ],
    );
  }
}

/// A counterpart's face: the Bot's own character, or the waveform for the
/// voice session, which has no face of its own.
class CounterpartAvatar extends StatelessWidget {
  final ExchangeCounterpart counterpart;
  final String? background;
  final String? primary;
  final double size;
  const CounterpartAvatar({
    super.key,
    required this.counterpart,
    required this.size,
    this.background,
    this.primary,
  });

  @override
  Widget build(BuildContext context) {
    if (!counterpart.isVoice) {
      return CharacterAvatar(
        size: size,
        botId: counterpart.botId,
        characterId: background,
        primary: primary,
        motion: CharacterMotion.quiet,
      );
    }
    final scheme = Theme.of(context).colorScheme;
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: scheme.primary,
        borderRadius: BorderRadius.circular(size * 0.27),
      ),
      child: Icon(
        Icons.graphic_eq_rounded,
        size: size * 0.7,
        color: scheme.onPrimary,
      ),
    );
  }
}
