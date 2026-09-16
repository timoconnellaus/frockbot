/// The thread, drawn.
///
/// Chat is the Bot's words. A tool receipt is not a word, so it is not here —
/// a message that ran tools carries one quiet control that opens the run view,
/// and the receipts live there.
library;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';

import '../flock/sheep.dart';
import '../theme/frock_theme.dart';
import '../theme/states.dart';
import 'markdown.dart';
import 'run_view.dart';
import 'semantics.dart';
import 'send_payload.dart';
import 'transcript_model.dart';

export 'transcript_model.dart';

class TranscriptView extends StatefulWidget {
  final List<TranscriptLine> lines;

  /// The message the person has sent but the backend has not confirmed. It is
  /// drawn at the end, from this device's clock, because there is nothing
  /// durable to order it by yet.
  final String? pendingText;
  final bool loading;

  /// Whether there is an older page to fetch.
  final bool hasEarlier;
  final ApprovalsController? approvals;
  final Future<void> Function({bool older}) onRefresh;
  final void Function(TranscriptLine line) onOpenRun;

  /// Opens the view-only chat between this Bot and the marker's counterpart.
  final void Function(TranscriptLine line)? onOpenExchange;

  /// Another Bot's sheep, for the marker that names it. Null draws the
  /// default sheep: a Bot no longer in the flock still gets a face.
  final String? Function(String botId)? backgroundOf;

  /// Another Bot's current name. The wire names a Bot only by id where this
  /// Bot did the asking; null falls back to what the projection knows.
  final String? Function(String botId)? nameOf;
  final void Function(TranscriptLine line)? onRetryTurn;

  /// Where a failure whose remedy is Billing sends the person.
  final VoidCallback? onOpenBilling;
  final void Function(String url)? onOpenLink;
  final VoidCallback? onOpenSettings;
  final void Function(TranscriptLine, {Offset? position})? onMessageActions;
  final String? unreadFromMessageId;
  final void Function(String?)? onReadLatest;
  final String storageKey;

  /// Scrollable space for a control outside the list that has disappeared.
  final Widget? bottomSpace;

  /// A Turn the reader asked to be taken to — a search hit. It is brought into
  /// view and marked, once. A Turn further back than the loaded page is simply
  /// not here, and the thread says nothing rather than pretending to scroll.
  final String? focusRunId;

  /// The Bot's character and chosen colour. Every live avatar in the thread
  /// uses the same appearance as the sidebar and composer companion.
  final String? background;
  final String? primary;

  /// Drawn under the empty thread's greeting, and gone with the first row.
  final Widget? starters;
  const TranscriptView({
    super.key,
    required this.lines,
    required this.loading,
    required this.hasEarlier,
    required this.onRefresh,
    required this.onOpenRun,
    required this.storageKey,
    this.bottomSpace,
    this.pendingText,
    this.approvals,
    this.onOpenExchange,
    this.backgroundOf,
    this.nameOf,
    this.onRetryTurn,
    this.onOpenBilling,
    this.onOpenLink,
    this.onOpenSettings,
    this.onMessageActions,
    this.unreadFromMessageId,
    this.onReadLatest,
    this.focusRunId,
    this.background,
    this.primary,
    this.starters,
  });

  @override
  State<TranscriptView> createState() => _TranscriptViewState();
}

class _TranscriptViewState extends State<TranscriptView> {
  static const workingPadding = EdgeInsets.fromLTRB(16, 6, 16, 6);

  final GlobalKey focusKey = GlobalKey();

  /// One key per line, so the newest message can be measured against the
  /// viewport. Keyed by line id and handed to every row rather than to the
  /// newest alone: a key that appeared and disappeared as the thread grew
  /// would rebuild the row it left, and a live Applet card with it.
  final Map<String, GlobalKey> probes = {};
  final ScrollController scroll = ScrollController();
  @override
  void initState() {
    super.initState();
    scroll.addListener(_scheduleReportRead);
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

  /// The message id a line delivers, or null where it delivers none.
  String? _sendIdOf(TranscriptLine line) =>
      line.failureMessageId ??
      (line.role == LineRole.assistant &&
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
    widget.onReadLatest?.call(
      newest != null &&
              _showingLatest &&
              ModalRoute.of(context)?.isCurrent == true
          ? newest
          : null,
    );
  }

  @override
  void dispose() {
    scroll.dispose();
    super.dispose();
  }

  String? focused;

  String? get pendingText => widget.pendingText;
  bool get loading => widget.loading;
  bool get hasEarlier => widget.hasEarlier;
  ApprovalsController? get approvals => widget.approvals;
  Future<void> Function({bool older}) get onRefresh => widget.onRefresh;
  void Function(TranscriptLine line) get onOpenRun => widget.onOpenRun;
  void Function(TranscriptLine line)? get onRetryTurn => widget.onRetryTurn;
  VoidCallback? get onOpenBilling => widget.onOpenBilling;
  void Function(String url)? get onOpenLink => widget.onOpenLink;
  VoidCallback? get onOpenSettings => widget.onOpenSettings;
  String get storageKey => widget.storageKey;

  @override
  Widget build(BuildContext context) {
    WidgetsBinding.instance.addPostFrameCallback((_) => _reportRead());
    final now = DateTime.now();
    final ordered = orderTranscript(
      widget.lines,
      now.toUtc().toIso8601String(),
    );
    _newestSendId(ordered);
    final drain = supersedeDrainState(ordered, now);
    final target = widget.focusRunId;
    var marked = false;
    final rows = <Widget>[];
    // The probes outlive one build only for the lines still drawn; a thread
    // that pages in and out must not accumulate keys for rows that are gone.
    final drawn = <String>{};
    for (final line in ordered) {
      final content = _row(context, line, drain);
      if (content == null) continue;
      // The key belongs on the list child itself. A row that carries one can
      // be found again after the thread grows, so a live Applet card kept
      // alive off-screen moves with its line instead of being rebuilt against
      // whichever line has taken over its index.
      final row = GestureDetector(
        key: ValueKey('row:${line.id}'),
        onLongPress:
            widget.onMessageActions == null || line.role == LineRole.system
            ? null
            : () => widget.onMessageActions!(line),
        onSecondaryTapUp:
            widget.onMessageActions == null || line.role == LineRole.system
            ? null
            : (details) => widget.onMessageActions!(
                line,
                position: details.globalPosition,
              ),
        child: KeyedSubtree(
          key: probes.putIfAbsent(line.id, GlobalKey.new),
          child: content,
        ),
      );
      drawn.add(line.id);
      if (line.id == widget.unreadFromMessageId ||
          (line.failureMessageId != null &&
              line.failureMessageId == widget.unreadFromMessageId)) {
        rows.add(
          Padding(
            key: ValueKey('unread:${line.id}'),
            padding: const EdgeInsets.fromLTRB(16, 10, 16, 6),
            child: Row(
              children: [
                Expanded(
                  child: Divider(
                    color: Theme.of(context).colorScheme.primary
                        .withValues(alpha: 0.45),
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 10),
                  child: Text(
                    'Unread from here',
                    style: Theme.of(context).textTheme.labelSmall?.copyWith(
                      color: Theme.of(context).colorScheme.primary,
                      letterSpacing: 0.3,
                    ),
                  ),
                ),
                Expanded(
                  child: Divider(
                    color: Theme.of(context).colorScheme.primary
                        .withValues(alpha: 0.45),
                  ),
                ),
              ],
            ),
          ),
        );
      }
      if (target != null &&
          !marked &&
          (line.runId == target || line.id == '$target:user')) {
        marked = true;
        rows.add(
          Container(
            key: focusKey,
            decoration: BoxDecoration(
              color: Theme.of(context).colorScheme.primary
                  .withValues(alpha: 0.08),
              borderRadius: BorderRadius.circular(12),
            ),
            child: row,
          ),
        );
        continue;
      }
      rows.add(row);
    }
    probes.removeWhere((id, _) => !drawn.contains(id));
    if (marked && focused != target) {
      focused = target;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        final box = focusKey.currentContext;
        if (box != null) Scrollable.ensureVisible(box, alignment: 0.4);
      });
    }
    if (pendingText != null) {
      rows.add(
        _Bubble(
          key: const ValueKey('row:pending'),
          id: 'pending',
          mine: true,
          pending: true,
          child: SelectableText(pendingText!),
        ),
      );
    }
    if (rows.isEmpty) {
      return loading
          ? const FrockLoading(label: 'Loading your conversation')
          : _EmptyThread(
              background: widget.background,
              starters: widget.starters,
            );
    }
    return identified(
      ShellIds.transcript,
      RefreshIndicator(
        onRefresh: onRefresh,
        child: ListView(
          controller: scroll,
          // The thread starts at the latest row. Earlier pages extend the
          // far end, so prepending history keeps the viewport where it was.
          reverse: true,
          padding: const EdgeInsets.symmetric(vertical: 12),
          physics: const AlwaysScrollableScrollPhysics(),
          keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
          key: PageStorageKey(storageKey),
          children: [
            if (hasEarlier)
              KeyedSubtree(
                key: const ValueKey('row:earlier'),
                child: identified(
                  ShellIds.transcriptEarlier,
                  Center(
                    child: TextButton(
                      onPressed: loading ? null : () => onRefresh(older: true),
                      style: TextButton.styleFrom(
                        foregroundColor: Theme.of(context)
                            .colorScheme
                            .onSurfaceVariant,
                        textStyle: Theme.of(context).textTheme.labelMedium,
                        minimumSize: const Size(0, 32),
                      ),
                      child: const Text('Earlier messages'),
                    ),
                  ),
                ),
              ),
            ...rows,
            // Keep the latest messages in place when the working row goes.
            if (!ordered.any(
              (line) =>
                  line.role == LineRole.assistant &&
                  line.status == LineStatus.streaming &&
                  line.empty,
            ))
              SizedBox(
                key: const ValueKey('row:working-space'),
                height: WorkingIndicator.avatarSize + workingPadding.vertical,
              ),
            if (widget.bottomSpace != null) widget.bottomSpace!,
          ].reversed.toList(),
        ),
      ),
    );
  }

  /// One line, or nothing where the line has nothing to say — a running Turn
  /// before its first token is the animated row, not an empty bubble.
  Widget? _row(
    BuildContext context,
    TranscriptLine line,
    SupersedeDrainState drain,
  ) {
    if (line.exchange != null) {
      final botId = line.exchange!.counterpart.botId;
      return _ExchangeMarker(
        line: line,
        background: botId == null ? null : widget.backgroundOf?.call(botId),
        name: botId == null ? null : widget.nameOf?.call(botId),
        onOpen: widget.onOpenExchange,
      );
    }
    if (line.role == LineRole.system) {
      return _Announcement(text: line.text);
    }
    if (line.role == LineRole.user) {
      return _Bubble(
        id: line.id,
        mine: true,
        pending: line.pending,
        failed: line.status == LineStatus.error,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(line.text),
            if (line.notice != null)
              _Notice(
                line: line,
                onRetry: onRetryTurn,
                onOpenBilling: onOpenBilling,
              ),
          ],
        ),
      );
    }
    if (line.status == LineStatus.streaming && line.empty) {
      // A plain running Turn is the animated row and no words. Two states earn
      // words: a Stop the person asked for and is now waiting on, and a Turn
      // still waiting behind the one it displaced.
      return Padding(
        padding: workingPadding,
        child: WorkingIndicator(
          line: line,
          background: widget.background,
          primary: widget.primary,
          label: line.stopRequested
              ? 'Stopping…'
              : line.pending
              ? supersedeDrainLabel(drain) ?? 'Waiting…'
              : null,
        ),
      );
    }
    final children = <Widget>[
      for (final send in line.sends)
        SendPayloadView(
          send: send,
          approvals: approvals,
          onOpenLink: onOpenLink,
          onOpenSettings: onOpenSettings,
        ),
      if (line.text.isNotEmpty)
        ShellMarkdown(text: line.text, onOpenLink: onOpenLink),
    ];
    if (children.isEmpty && line.notice == null) {
      return null;
    }
    return _Bubble(
      id: line.id,
      mine: false,
      background: widget.background,
      pending: line.pending,
      failed: line.status == LineStatus.error,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          for (final child in children) ...[
            child,
            if (child != children.last) const SizedBox(height: 8),
          ],
          if (line.notice != null)
            _Notice(
              line: line,
              onRetry: onRetryTurn,
              onOpenBilling: onOpenBilling,
            ),
        ],
      ),
    );
  }
}

class _Bubble extends StatelessWidget {
  final String id;
  final bool mine;
  final bool pending;
  final bool failed;
  final String? background;
  final Widget child;
  const _Bubble({
    super.key,
    required this.id,
    required this.mine,
    required this.child,
    this.pending = false,
    this.failed = false,
    this.background,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return identified(
      ShellIds.message(id),
      TweenAnimationBuilder<double>(
        key: ValueKey(id),
        tween: Tween(begin: 0, end: 1),
        duration: FrockTheme.motion(context),
        curve: Curves.easeOutCubic,
        builder: (context, value, child) => Opacity(
          opacity: (pending ? 0.55 : 0.7 + value * 0.3).clamp(0.0, 1.0),
          child: Transform.translate(
            offset: Offset(0, 6 * (1 - value)),
            child: child,
          ),
        ),
        child: Row(
          mainAxisAlignment: mine
              ? MainAxisAlignment.end
              : MainAxisAlignment.start,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Flexible(
              child: Container(
                constraints: const BoxConstraints(maxWidth: 720),
                margin: EdgeInsets.fromLTRB(
                  mine ? 64 : 16,
                  5,
                  mine ? 16 : 16,
                  5,
                ),
                padding: const EdgeInsets.symmetric(
                  horizontal: 13,
                  vertical: 9,
                ),
                decoration: BoxDecoration(
                  // Both sides sit on the raised surface. The person's words
                  // take a tint of it — pink enough to be theirs, never a
                  // poster — and the Bot's keep it neutral.
                  color: mine
                      ? Color.alphaBlend(
                          theme.colorScheme.primary.withValues(alpha: 0.2),
                          theme.colorScheme.surfaceContainerHighest,
                        )
                      : theme.colorScheme.surfaceContainerHighest,
                  border: failed
                      ? Border.all(color: theme.colorScheme.error)
                      : null,
                  borderRadius: BorderRadius.only(
                    topLeft: const Radius.circular(18),
                    topRight: const Radius.circular(18),
                    bottomLeft: Radius.circular(mine ? 18 : 4),
                    bottomRight: Radius.circular(mine ? 4 : 18),
                  ),
                ),
                child: DefaultTextStyle.merge(
                  style: FrockTheme.message(theme),
                  child: Semantics(label: mine ? 'You' : 'Bot', child: child),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Why a Turn ended where it did, and the way out of it. The invitation is the
/// action beside the sentence, not words in it with nothing to press.
class _Notice extends StatelessWidget {
  final TranscriptLine line;
  final void Function(TranscriptLine line)? onRetry;
  final VoidCallback? onOpenBilling;
  const _Notice({required this.line, this.onRetry, this.onOpenBilling});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      // Wrapped, not a row: at large text the sentence and its action do not
      // fit side by side on a phone, and clipping either is not an option.
      child: Wrap(
        spacing: 8,
        runSpacing: 4,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          Text(
            line.notice!,
            style: theme.textTheme.bodySmall?.copyWith(
              color: line.status == LineStatus.error
                  ? theme.colorScheme.error
                  : theme.colorScheme.onSurfaceVariant,
            ),
          ),
          if (line.retry == LineRetry.resendTurn && onRetry != null)
            identified(
              ShellIds.retryTurn(line.runId),
              TextButton(
                onPressed: () => onRetry!(line),
                child: const Text('Try again'),
              ),
            ),
          if (line.retry == LineRetry.openBilling && onOpenBilling != null)
            identified(
              ShellIds.openBilling(line.runId),
              TextButton(
                onPressed: onOpenBilling,
                child: const Text('Open Billing'),
              ),
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

class _EmptyThread extends StatelessWidget {
  final String? background;
  final Widget? starters;
  const _EmptyThread({this.background, this.starters});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return SingleChildScrollView(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'What would you like to work on?',
              style: theme.textTheme.headlineMedium,
            ),
            const SizedBox(height: 8),
            Text(
              'Ask a question, make a plan, or give your Bot something to do.',
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            if (starters != null) ...[const SizedBox(height: 16), starters!],
          ],
        ),
      ),
    );
  }
}

/// One line in the thread for a message that crossed to or from a
/// counterpart: who, which way, and where it stands. The words themselves
/// are read on the exchange view this opens, never here — the thread stays
/// this Bot's conversation with the person.
class _ExchangeMarker extends StatelessWidget {
  final TranscriptLine line;
  final String? background;
  final String? name;
  final void Function(TranscriptLine line)? onOpen;
  const _ExchangeMarker({
    required this.line,
    required this.background,
    required this.name,
    required this.onOpen,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final exchange = line.exchange!;
    final muted = theme.colorScheme.onSurfaceVariant.withValues(alpha: 0.8);
    final quiet = theme.textTheme.bodySmall?.copyWith(color: muted);
    final named = theme.textTheme.bodySmall?.copyWith(
      color: theme.colorScheme.onSurfaceVariant,
      fontWeight: FontWeight.w500,
    );
    final status = exchange.statusLabel;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 6),
      child: Center(
        child: identified(
          ShellIds.exchange(line.id),
          Material(
            color: Colors.transparent,
            borderRadius: BorderRadius.circular(999),
            child: InkWell(
              key: ValueKey('exchange:${line.id}'),
              borderRadius: BorderRadius.circular(999),
              onTap: onOpen == null ? null : () => onOpen!(line),
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: 10,
                  vertical: 4,
                ),
                child: Wrap(
                  crossAxisAlignment: WrapCrossAlignment.center,
                  spacing: 6,
                  runSpacing: 2,
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
                      size: 18,
                    ),
                    Text(name ?? exchange.counterpart.label, style: named),
                    if (status != null) Text('· $status', style: quiet),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// A counterpart's face: the Bot's own sheep, or the waveform for the voice
/// session, which has no face of its own.
class CounterpartAvatar extends StatelessWidget {
  final ExchangeCounterpart counterpart;
  final String? background;
  final double size;
  const CounterpartAvatar({
    super.key,
    required this.counterpart,
    required this.size,
    this.background,
  });

  @override
  Widget build(BuildContext context) {
    if (!counterpart.isVoice) {
      return SheepAvatar(size: size, background: background);
    }
    final scheme = Theme.of(context).colorScheme;
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: scheme.primary.withValues(alpha: 0.16),
        borderRadius: BorderRadius.circular(size * 0.27),
      ),
      child: Icon(
        Icons.graphic_eq_rounded,
        size: size * 0.7,
        color: scheme.primary,
      ),
    );
  }
}
