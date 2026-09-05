import 'dart:async';

import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter/services.dart';

import '../acceptance_metrics.dart';
import '../client/chat_controller.dart';
import '../theme/frock_theme.dart' show FrockSkeleton;
import 'frock_tokens.dart';
import 'frock_widgets.dart';

/// The conversation with one Bot: the thread, the composer, and the few lines
/// of state that sit between them. Built on Frock UI; the shell around it
/// (bar, drawer) lives in chat_screen.dart.
class ChatPane extends StatefulWidget {
  final ChatController controller;
  final Future<void> Function() onReconnect;
  final String botName;
  final SheepLook botLook;

  /// Opens the Voice screen. Absent when this device cannot talk (a test
  /// harness, or an account with no session yet), and the mic button is then
  /// not drawn at all rather than drawn dead.
  final VoidCallback? onVoice;
  const ChatPane({
    super.key,
    required this.controller,
    required this.onReconnect,
    this.botName = 'your Bot',
    this.botLook = SheepLook.plain,
    this.onVoice,
  });
  @override
  State<ChatPane> createState() => _ChatPaneState();
}

class _ChatPaneState extends State<ChatPane> {
  final editor = TextEditingController();
  final focus = FocusNode();
  @override
  void initState() {
    super.initState();
    editor.text = widget.controller.draft;
    widget.controller.addListener(update);
  }

  @override
  void didUpdateWidget(ChatPane old) {
    super.didUpdateWidget(old);
    if (old.controller != widget.controller) {
      old.controller.removeListener(update);
      widget.controller.addListener(update);
      editor.text = widget.controller.draft;
    }
  }

  void update() {
    if (!mounted) return;
    final draft = widget.controller.draft;
    // A composing region (Android keyboards hold one on the last word) must
    // not stop the box from emptying once the message has gone through.
    if (editor.text != draft &&
        (draft.isEmpty || !editor.value.composing.isValid)) {
      editor.text = draft;
    }
    setState(() {});
    if (widget.controller.ready) AcceptanceMetrics.instance.editableShown();
  }

  Future<void> send() async {
    final text = editor.text;
    if (!widget.controller.canSend || text.trim().isEmpty) return;
    unawaited(HapticFeedback.lightImpact());
    // Composing text (Android keyboards hold the last word open) sends as
    // typed. The box empties now; a failed send puts the text back.
    editor.clear();
    await widget.controller.send(text);
    if (mounted) focus.requestFocus();
  }

  Future<void> refreshHistory({bool older = false}) async {
    try {
      await widget.controller.refresh(older: older);
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text(
            'Couldn’t refresh your messages. Check your connection and try again.',
          ),
        ),
      );
    }
  }

  /// One Turn: the person's message, then the Bot's work and replies.
  List<Widget> turn(
    Map<String, dynamic> run,
    FrockTokens t, {
    required bool stamp,
  }) {
    final id = run['runId'] as String;
    final widgets = <Widget>[
      if (stamp)
        Padding(
          padding: const EdgeInsets.only(top: 4, bottom: 12),
          child: Center(
            child: Text(
              stampFor(run['admittedAt'] as String),
              style: t.monoStyle.copyWith(fontSize: 11),
            ),
          ),
        ),
      _Enter(
        key: ValueKey('$id:input'),
        child: FrockUserMessage(run['input'] as String),
      ),
    ];
    final events = run['events'] as List;
    final replies = <String>[];
    for (final event in events) {
      if (event['type'] != 'send/to-user') continue;
      final payload = event['payload'];
      final text = payload is Map
          ? payload['text'] ?? payload['content']
          : null;
      replies.add(
        text is String
            ? text
            : 'This message contains content that is not available here yet.',
      );
    }
    final status = run['status'];
    // The Bot's voice is its sends. Only a Turn that sent nothing draws the
    // model's own text: the settled answer, or the words so far while it runs.
    // Drawing both is how one reply arrived twice (issue 153).
    var streaming = false;
    if (replies.isEmpty) {
      final outcome = run['outcome'];
      final settled = outcome is Map ? outcome['text'] : null;
      final partial = run['partialText'];
      if (settled is String && settled.isNotEmpty) {
        replies.add(settled);
      } else if (partial is String && partial.isNotEmpty) {
        replies.add(partial);
        streaming = status == 'running';
      }
    }
    // Tool calls never appear in the thread: chat is the Bot's words, the
    // way it is on the web. What a Bot did belongs to its Work view.
    final body = <Widget>[
      for (var i = 0; i < replies.length; i++)
        Padding(
          key: ValueKey('$id:send:$i'),
          padding: EdgeInsets.only(top: i == 0 ? 0 : 8),
          child: Semantics(
            label: 'Bot',
            child: streaming && i == replies.length - 1
                ? _Streaming(text: replies[i])
                : SelectableText(replies[i], style: t.message),
          ),
        ),
      if (status != 'completed')
        Padding(
          padding: const EdgeInsets.only(top: 6),
          child: _StatusLine(status: status, run: run),
        ),
    ];
    if (body.isNotEmpty) {
      widgets.add(
        _Enter(
          key: ValueKey('$id:reply'),
          child: Padding(
            padding: const EdgeInsets.only(top: 12),
            child: FrockBotMessage(children: body),
          ),
        ),
      );
    }
    return widgets;
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.controller;
    final t = FrockTokens.of(context);
    final runs = c.runs;
    final rows = <Widget>[];
    DateTime? previous;
    for (final run in runs) {
      final at = DateTime.tryParse(run['admittedAt'] as String);
      final stamp =
          previous == null ||
          at == null ||
          at.difference(previous).inMinutes.abs() >= 20;
      rows.add(
        Padding(
          padding: const EdgeInsets.only(bottom: 18),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: turn(run, t, stamp: stamp),
          ),
        ),
      );
      previous = at ?? previous;
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (c.connection != ConnectionState.connected)
          _ConnectionLine(state: c.connection, onReconnect: widget.onReconnect),
        Expanded(
          child: SelectionArea(
            child: RefreshIndicator(
              onRefresh: refreshHistory,
              color: t.accent,
              backgroundColor: t.sheet,
              child: ListView(
                // Chat starts at the latest row. Earlier pages extend the far
                // end, preserving the viewport as history is prepended.
                reverse: true,
                padding: const EdgeInsets.only(top: 8, bottom: 4),
                physics: const AlwaysScrollableScrollPhysics(),
                keyboardDismissBehavior:
                    ScrollViewKeyboardDismissBehavior.onDrag,
                key: PageStorageKey('history-${c.botId}-${c.conversationId}'),
                children: [
                  if (c.before != null)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 16),
                      child: Center(
                        child: FrockPill(
                          'Earlier messages',
                          kind: PillKind.ghost,
                          size: PillSize.sm,
                          onTap: c.loading
                              ? null
                              : () => refreshHistory(older: true),
                        ),
                      ),
                    ),
                  ...rows,
                  // Once the run is observed it is drawn as a Turn above;
                  // the pending bubble would otherwise repeat it below.
                  if (c.pendingId != null &&
                      !runs.any((run) => run['runId'] == c.pendingId))
                    _Enter(
                      key: ValueKey('pending-${c.pendingId}'),
                      child: Padding(
                        padding: const EdgeInsets.only(bottom: 18),
                        child: FrockUserMessage(c.pendingText ?? ''),
                      ),
                    ),
                  if (runs.isEmpty && c.pendingId == null)
                    c.loading
                        ? const _Loading()
                        : _Empty(name: widget.botName, look: widget.botLook),
                ].reversed.toList(),
              ),
            ),
          ),
        ),
        if (c.error != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 6, 4, 0),
            child: Text(c.error!, style: t.caption.copyWith(color: t.danger)),
          ),
        if (c.pendingId != null && !c.sending)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            // Scales down rather than clips at very large text sizes.
            child: FittedBox(
              fit: BoxFit.scaleDown,
              alignment: Alignment.centerLeft,
              child: FrockPill(
                'Check message status',
                key: const ValueKey('check-delivery'),
                size: PillSize.sm,
                icon: Icons.refresh_rounded,
                onTap: c.checking ? null : c.checkDelivery,
              ),
            ),
          ),
        const SizedBox(height: 10),
        FrockComposer(
          hint: 'Message ${widget.botName}',
          onVoice: widget.onVoice,
          sendKey: const ValueKey('send'),
          stopKey: const ValueKey('stop'),
          onSend: c.canSend ? send : null,
          onStop: c.activeRunId == null
              ? null
              : () {
                  unawaited(HapticFeedback.mediumImpact());
                  unawaited(c.stop());
                },
          stopping: c.stopping,
          field: CallbackShortcuts(
            bindings: {
              const SingleActivator(LogicalKeyboardKey.enter, meta: true): send,
              const SingleActivator(LogicalKeyboardKey.enter, control: true):
                  send,
            },
            child: TextField(
              key: const ValueKey('composer'),
              controller: editor,
              focusNode: focus,
              minLines: 1,
              maxLines: 6,
              style: t.message,
              cursorColor: t.accent,
              keyboardType: TextInputType.multiline,
              textInputAction: TextInputAction.newline,
              decoration: InputDecoration.collapsed(
                hintText: 'Message ${widget.botName}',
                hintStyle: t.message.copyWith(color: t.ink3),
              ),
              onChanged: (value) {
                AcceptanceMetrics.instance.inputChanged();
                unawaited(c.saveDraft(value));
              },
            ),
          ),
        ),
      ],
    );
  }

  @override
  void dispose() {
    widget.controller.removeListener(update);
    editor.dispose();
    focus.dispose();
    super.dispose();
  }
}

/// A message arrives: a short lift and fade, once.
class _Enter extends StatelessWidget {
  const _Enter({super.key, required this.child});
  final Widget child;
  @override
  Widget build(BuildContext context) {
    final duration = MediaQuery.disableAnimationsOf(context)
        ? Duration.zero
        : FrockTokens.enter;
    return TweenAnimationBuilder<double>(
      tween: Tween(begin: 0, end: 1),
      duration: duration,
      curve: FrockTokens.curve,
      builder: (context, value, child) => Opacity(
        opacity: 0.7 + value * 0.3,
        child: Transform.translate(
          offset: Offset(0, 6 * (1 - value)),
          child: child,
        ),
      ),
      child: child,
    );
  }
}

/// Words still arriving: the text so far with the accent caret after it.
class _Streaming extends StatelessWidget {
  const _Streaming({required this.text});
  final String text;
  @override
  Widget build(BuildContext context) {
    final t = FrockTokens.of(context);
    return Text.rich(
      TextSpan(
        children: [
          TextSpan(text: text),
          WidgetSpan(
            alignment: PlaceholderAlignment.middle,
            child: Padding(
              padding: const EdgeInsets.only(left: 2),
              child: Container(
                width: 7,
                height: 15,
                decoration: BoxDecoration(
                  color: t.accent.withValues(alpha: 0.85),
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),
          ),
        ],
      ),
      style: t.message,
    );
  }
}

class _StatusLine extends StatelessWidget {
  const _StatusLine({required this.status, required this.run});
  final Object? status;
  final Map<String, dynamic> run;
  @override
  Widget build(BuildContext context) {
    final t = FrockTokens.of(context);
    final live = status == 'running';
    final text = switch (status) {
      'running' =>
        run['stopRequestedAt'] != null
            ? 'Stopping…'
            : run['queued'] == true
            ? 'Waiting…'
            : 'Working…',
      'cancelled' => 'Stopped',
      'failed' => 'The reply couldn’t be completed.',
      _ => 'This reply needs attention.',
    };
    final color = switch (status) {
      'running' => t.ink2,
      'cancelled' => t.ink3,
      _ => t.danger,
    };
    return Row(
      children: [
        if (live) ...[
          FrockPulse(color: run['queued'] == true ? t.ink3 : t.accent),
          const SizedBox(width: 8),
        ],
        Flexible(
          child: Text(text, style: t.caption.copyWith(color: color)),
        ),
      ],
    );
  }
}

class _ConnectionLine extends StatelessWidget {
  const _ConnectionLine({required this.state, required this.onReconnect});
  final ConnectionState state;
  final Future<void> Function() onReconnect;
  @override
  Widget build(BuildContext context) {
    final t = FrockTokens.of(context);
    final text = switch (state) {
      ConnectionState.connecting => 'Connecting…',
      ConnectionState.paused => 'Paused on this device',
      _ => 'Offline. Your Bot can keep working.',
    };
    return Padding(
      padding: const EdgeInsets.only(top: 4, bottom: 2),
      child: Row(
        children: [
          FrockPulse(
            color: state == ConnectionState.connecting ? t.ink3 : t.warn,
          ),
          const SizedBox(width: 8),
          Expanded(child: Text(text, style: t.caption)),
          FrockPill(
            'Reconnect',
            key: const ValueKey('reconnect'),
            kind: PillKind.ghost,
            size: PillSize.sm,
            color: t.accent,
            onTap: () => unawaited(onReconnect()),
          ),
        ],
      ),
    );
  }
}

class _Loading extends StatelessWidget {
  const _Loading();
  @override
  Widget build(BuildContext context) => const Padding(
    padding: EdgeInsets.fromLTRB(0, 24, 0, 8),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        FrockSkeleton(width: 160, height: 16),
        SizedBox(height: 18),
        FrockSkeleton(height: 56),
        SizedBox(height: 12),
        FrockSkeleton(width: 220, height: 56),
      ],
    ),
  );
}

class _Empty extends StatelessWidget {
  const _Empty({required this.name, required this.look});
  final String name;
  final SheepLook look;
  @override
  Widget build(BuildContext context) {
    final t = FrockTokens.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(0, 32, 0, 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          FrockSheep(
            look: look,
            size: FrockTokens.avatarLg,
            state: BotState.ready,
          ),
          const SizedBox(height: 16),
          Text('What would you like to work on?', style: t.nameStyle),
          const SizedBox(height: 6),
          Text(
            'Ask $name a question, make a plan, or hand over something to do.',
            style: t.body,
          ),
        ],
      ),
    );
  }
}

const _days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const _months = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/// "Today 13:36", "Yesterday 09:12", "Mon 1 Sep 14:02", "3 Mar 2025 10:00".
String stampFor(String iso, {DateTime? now}) {
  final at = DateTime.tryParse(iso)?.toLocal();
  if (at == null) return '';
  final today = (now ?? DateTime.now()).toLocal();
  final day = DateTime(at.year, at.month, at.day);
  final days = DateTime(
    today.year,
    today.month,
    today.day,
  ).difference(day).inDays;
  final hm =
      '${at.hour.toString().padLeft(2, '0')}:${at.minute.toString().padLeft(2, '0')}';
  if (days == 0) return 'Today $hm';
  if (days == 1) return 'Yesterday $hm';
  final date = '${at.day} ${_months[at.month - 1]}';
  if (days < 7 && days > 0) return '${_days[at.weekday - 1]} $date $hm';
  if (at.year == today.year) return '$date $hm';
  return '$date ${at.year} $hm';
}
