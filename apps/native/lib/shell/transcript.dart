/// The thread, drawn.
///
/// Chat is the Bot's words. A tool receipt is not a word, so it is not here —
/// a message that ran tools carries one quiet control that opens the run view,
/// and the receipts live there.
library;

import 'package:flutter/material.dart';

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
  final void Function(TranscriptLine line)? onRetryTurn;
  final void Function(String url)? onOpenLink;
  final VoidCallback? onOpenSettings;
  final void Function(TranscriptLine)? onMessageActions;
  final String? unreadFromMessageId;
  final void Function(String?)? onReadLatest;
  final String storageKey;

  /// A Turn the reader asked to be taken to — a search hit. It is brought into
  /// view and marked, once. A Turn further back than the loaded page is simply
  /// not here, and the thread says nothing rather than pretending to scroll.
  final String? focusRunId;

  /// The Bot's sheep background. Every avatar in the thread is this Bot's.
  final String? background;
  const TranscriptView({
    super.key,
    required this.lines,
    required this.loading,
    required this.hasEarlier,
    required this.onRefresh,
    required this.onOpenRun,
    required this.storageKey,
    this.pendingText,
    this.approvals,
    this.onRetryTurn,
    this.onOpenLink,
    this.onOpenSettings,
    this.onMessageActions,
    this.unreadFromMessageId,
    this.onReadLatest,
    this.focusRunId,
    this.background,
  });

  @override
  State<TranscriptView> createState() => _TranscriptViewState();
}

class _TranscriptViewState extends State<TranscriptView> {
  final GlobalKey focusKey = GlobalKey();
  final ScrollController scroll = ScrollController();
  @override
  void initState() {
    super.initState();
    scroll.addListener(_reportRead);
  }

  /// The lines the cached newest-send id was derived from. `_reportRead` runs
  /// on every scroll frame, and ordering the whole thread again each time is a
  /// sort per frame of a fling; the transcript only changes when the projection
  /// hands down a new list.
  List<TranscriptLine>? _latestSendSource;
  String? _latestSendId;

  String? _newestSendId(List<TranscriptLine> ordered) {
    _latestSendSource = widget.lines;
    _latestSendId = null;
    for (final line in ordered) {
      if (line.role == LineRole.assistant && line.id.contains(':send:')) {
        _latestSendId = line.id;
      }
    }
    return _latestSendId;
  }

  void _reportRead() {
    if (!mounted) return;
    final atLatest = scroll.hasClients && scroll.position.pixels <= 8;
    final newest = identical(_latestSendSource, widget.lines)
        ? _latestSendId
        : _newestSendId(
            orderTranscript(
              widget.lines,
              DateTime.now().toUtc().toIso8601String(),
            ),
          );
    widget.onReadLatest?.call(
      atLatest && newest != null && ModalRoute.of(context)?.isCurrent == true
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
        child: content,
      );
      if (line.id == widget.unreadFromMessageId) {
        rows.add(
          Padding(
            key: ValueKey('unread:${line.id}'),
            padding: const EdgeInsets.symmetric(vertical: 8),
            child: const Center(child: Text('Unread from here')),
          ),
        );
      }
      if (target != null && !marked && line.runId == target) {
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
          : _EmptyThread(background: widget.background);
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
                  TextButton(
                    onPressed: loading ? null : () => onRefresh(older: true),
                    child: const Text('Earlier messages'),
                  ),
                ),
              ),
            ...rows,
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
    if (line.role == LineRole.system) {
      return _Announcement(text: line.text);
    }
    if (line.role == LineRole.user) {
      return _Bubble(
        id: line.id,
        mine: true,
        pending: line.pending,
        child: Text(line.text),
      );
    }
    if (line.status == LineStatus.streaming && line.empty) {
      // A plain running Turn is the animated row and no words. Two states earn
      // words: a Stop the person asked for and is now waiting on, and a Turn
      // still waiting behind the one it displaced.
      return Padding(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
        child: WorkingIndicator(
          line: line,
          background: widget.background,
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
          if (line.notice != null) _Notice(line: line, onRetry: onRetryTurn),
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
                  mine ? 56 : 20,
                  6,
                  mine ? 16 : 20,
                  6,
                ),
                padding: mine
                    ? const EdgeInsets.symmetric(horizontal: 14, vertical: 11)
                    : const EdgeInsets.symmetric(vertical: 10),
                decoration: BoxDecoration(
                  color: mine
                      ? theme.colorScheme.primary.withValues(alpha: 0.16)
                      : Colors.transparent,
                  border: failed
                      ? Border.all(color: theme.colorScheme.error)
                      : null,
                  borderRadius: BorderRadius.only(
                    topLeft: const Radius.circular(16),
                    topRight: const Radius.circular(16),
                    bottomLeft: Radius.circular(mine ? 16 : 6),
                    bottomRight: Radius.circular(mine ? 6 : 16),
                  ),
                ),
                child: DefaultTextStyle.merge(
                  style: theme.textTheme.bodyLarge?.copyWith(
                    fontWeight: FontWeight.w300,
                  ),
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
  const _Notice({required this.line, this.onRetry});

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
    padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 10),
    child: Center(
      child: Text(
        text,
        textAlign: TextAlign.center,
        style: Theme.of(context).textTheme.bodySmall
            ?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant),
      ),
    ),
  );
}

class _EmptyThread extends StatelessWidget {
  final String? background;
  const _EmptyThread({this.background});

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
            const SizedBox(height: 12),
            Text(
              'Ask a question, make a plan, or give your Bot something to do.',
              style: theme.textTheme.bodyLarge?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
