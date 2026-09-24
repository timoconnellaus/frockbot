/// One Group Chat on screen: its header, its thread and its composer.
///
/// The thread is the group's own, drawn from [GroupThreadController]: every
/// Bot message opens with the Bot's badge, a mention is a chip in the named
/// Bot's colour, and the members working now stand at the end of it under
/// the sheen, side by side, the way a Bot stands at the end of its own chat.
library;

import 'dart:async';

import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter/services.dart';

import '../client/chat_controller.dart' show ConnectionState;
import '../flock/avatar.dart';
import '../shell/chat_header.dart';
import '../shell/composer.dart'
    show
        ComposerFieldFrame,
        composerControlExtent,
        composerControlIconSize,
        composerFieldPadding,
        composerSendButton,
        enterSends;
import '../shell/markdown.dart';
import '../shell/semantics.dart';
import '../theme/caret.dart';
import '../theme/controls.dart';
import '../theme/frock_theme.dart';
import '../theme/states.dart';
import '../theme/thread.dart';
import '../theme/time.dart';
import 'faces.dart';
import 'lines.dart';
import 'model.dart';
import 'thread.dart';

/// How large a member stands at the end of the thread while it works.
const double groupWorkingSize = 44;

class GroupChatPane extends StatefulWidget {
  final GroupThreadController controller;

  /// What the group is called, as the list calls it.
  final String name;

  /// Any Bot's face: a member's, or one a member messaged from outside.
  final GroupFace? Function(String botId) faceOf;

  /// Whether the person is reading this group now, by the shell's focus
  /// rule. Only then does reaching the end of the thread mark it read.
  final bool focused;
  final bool phone;
  final VoidCallback? onBack;
  final VoidCallback onOpenMembers;

  /// Searches the conversations, from the header, as a Bot's header does.
  final VoidCallback? onSearch;

  /// The group's actions — the same menu its row in the list opens.
  final VoidCallback? onActions;

  /// Opens the view-only chat behind a message a member sent a Bot outside.
  final void Function(String botId, String toBotId)? onOpenExchange;

  /// Puts back what a change line changed: adds a removed member again,
  /// removes an added one, or restores the name a rename replaced.
  final void Function(GroupEvent event, String? previousName)? onUndo;
  final VoidCallback onReconnect;

  /// An archived group is read, not written: its Bots have stopped replying
  /// in it until the person restores it.
  final bool archived;
  final VoidCallback? onRestore;
  const GroupChatPane({
    super.key,
    required this.controller,
    required this.name,
    required this.faceOf,
    required this.focused,
    required this.phone,
    required this.onOpenMembers,
    required this.onReconnect,
    this.onSearch,
    this.onActions,
    this.onBack,
    this.onOpenExchange,
    this.onUndo,
    this.archived = false,
    this.onRestore,
  });

  @override
  State<GroupChatPane> createState() => _GroupChatPaneState();
}

class _GroupChatPaneState extends State<GroupChatPane> {
  final editor = TextEditingController();
  final focus = FocusNode();
  final scroll = ScrollController();

  /// Where the unread divider goes: after the last message the person had
  /// read when the group was opened. Kept for the visit, so the line stays
  /// where it was while the person reads down to it.
  int? _unreadAfter;
  String? _note;
  Timer? _noteTimer;
  int _highlight = 0;

  GroupThreadController get controller => widget.controller;

  @override
  void initState() {
    super.initState();
    editor.text = controller.draft;
    if (controller.ready) _unreadAfter = controller.readThrough;
    controller.addListener(_changed);
    scroll.addListener(_scrolled);
  }

  @override
  void didUpdateWidget(GroupChatPane old) {
    super.didUpdateWidget(old);
    if (!identical(old.controller, widget.controller)) {
      old.controller.removeListener(_changed);
      widget.controller.addListener(_changed);
      editor.text = widget.controller.draft;
      _unreadAfter = widget.controller.ready
          ? widget.controller.readThrough
          : null;
    }
    if (widget.focused && !old.focused) _readIfAtEnd();
  }

  void _changed() {
    if (!mounted) return;
    if (editor.text != controller.draft &&
        (editor.text.isEmpty || !editor.value.composing.isValid)) {
      editor.text = controller.draft;
    }
    if (_unreadAfter == null && controller.ready) {
      _unreadAfter = controller.readThrough;
    }
    setState(() {});
    WidgetsBinding.instance.addPostFrameCallback((_) => _readIfAtEnd());
  }

  void _scrolled() => _readIfAtEnd();

  /// The list is reversed, so its start is the newest message.
  void _readIfAtEnd() {
    if (!mounted || !widget.focused || !controller.ready) return;
    final atEnd = !scroll.hasClients || scroll.offset < 48;
    if (atEnd) unawaited(controller.markRead());
  }

  void _say(String note) {
    _noteTimer?.cancel();
    setState(() => _note = note);
    _noteTimer = Timer(const Duration(seconds: 3), () {
      if (mounted) setState(() => _note = null);
    });
  }

  List<GroupMemberInfo> get _members =>
      controller.view?.members ?? const <GroupMemberInfo>[];

  String _nameOf(String botId) {
    for (final member in _members) {
      if (member.botId == botId) return member.name;
    }
    return widget.faceOf(botId)?.name ?? 'A Bot';
  }

  GroupFace _faceOf(String botId) =>
      widget.faceOf(botId) ??
      GroupFace(
        botId: botId,
        name: _nameOf(botId),
        characterId: defaultCharacterIdV1,
      );

  Future<void> _send() async {
    final text = editor.text;
    if (text.trim().isEmpty) return;
    final stop = parseGroupStop(text, _members);
    if (stop != null) {
      editor.clear();
      controller.saveDraft('');
      await _stop(stop);
      return;
    }
    unawaited(HapticFeedback.lightImpact().catchError((Object _) {}));
    final sending = controller.send(text);
    editor.clear();
    await sending;
    if (mounted) focus.requestFocus();
  }

  Future<void> _stop(GroupStopCommand command) async {
    switch (command) {
      case GroupStopUnknown(:final name):
        _say('Nobody in this group is called $name.');
      case GroupStopOne(:final botId):
        if (!controller.working.contains(botId)) {
          _say('${_nameOf(botId)} isn’t working on anything here.');
          return;
        }
        await controller.stop(botId: botId);
      case GroupStopAll():
        if (controller.working.isEmpty) {
          _say('Nothing to stop.');
          return;
        }
        await controller.stop();
    }
  }

  ({int start, String query})? get _mention {
    final selection = editor.selection;
    if (!selection.isValid || !selection.isCollapsed) return null;
    return activeMention(editor.text, selection.baseOffset);
  }

  List<GroupMemberInfo> get _candidates {
    final mention = _mention;
    if (mention == null) return const [];
    return mentionCandidates(_members, mention.query);
  }

  void _choose(GroupMemberInfo member) {
    final mention = _mention;
    if (mention == null) return;
    final caret = editor.selection.baseOffset;
    final inserted = '@${member.name} ';
    final text = editor.text.replaceRange(mention.start, caret, inserted);
    editor.value = TextEditingValue(
      text: text,
      selection: TextSelection.collapsed(
        offset: mention.start + inserted.length,
      ),
    );
    controller.saveDraft(text);
    _highlight = 0;
    setState(() {});
    focus.requestFocus();
  }

  void _enter() {
    final candidates = _candidates;
    if (candidates.isNotEmpty) {
      _choose(candidates[_highlight.clamp(0, candidates.length - 1)]);
      return;
    }
    unawaited(_send());
  }

  @override
  Widget build(BuildContext context) {
    final c = controller;
    final notices = <Widget>[
      if (c.connection == ConnectionState.disconnected ||
          c.connection == ConnectionState.paused)
        MaterialBanner(
          content: Text(switch (c.connection) {
            ConnectionState.paused => 'Group Chat paused on this device.',
            _ => 'You’re offline. The group can keep working.',
          }),
          actions: [
            identified(
              ShellIds.reconnect,
              TextButton(
                onPressed: widget.onReconnect,
                child: const Text('Reconnect'),
              ),
            ),
          ],
        ),
    ];
    if (widget.archived) {
      notices.add(
        MaterialBanner(
          content: const Text(
            'This group is archived. Its Bots don’t reply here until you '
            'restore it.',
          ),
          actions: [
            identified(
              GroupIds.restore,
              TextButton(
                onPressed: widget.onRestore,
                child: const Text('Restore'),
              ),
            ),
          ],
        ),
      );
    }
    final faces = [for (final member in _members) _faceOf(member.botId)];
    final header = ChatHeader(
      name: widget.name,
      subtitle: _members.isEmpty
          ? null
          : [for (final member in _members) member.name].join(', '),
      working: c.working.isNotEmpty,
      phone: widget.phone,
      onBack: widget.onBack,
      onSearch: widget.onSearch,
      onActions: widget.onActions,
      onMembers: widget.onOpenMembers,
      connection: c.connection,
      textScale: MediaQuery.textScalerOf(context).scale(14) / 14,
      companion: faces.isEmpty
          ? null
          : GroupAvatars(
              faces: faces,
              size: widget.phone ? 32 : 40,
              ring: Theme.of(context).colorScheme.surface,
              working: c.working.isNotEmpty,
            ),
      below: notices,
    );
    return identified(
      GroupIds.pane,
      Column(
        children: [
          header,
          Expanded(
            child: Column(
              children: [
                Expanded(
                  child: Center(
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 860),
                      child: _thread(context),
                    ),
                  ),
                ),
                if (c.error != null)
                  Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 16,
                      vertical: 8,
                    ),
                    child: Text(
                      c.error!,
                      style: TextStyle(
                        color: Theme.of(context).colorScheme.error,
                      ),
                    ),
                  ),
                if (_note != null)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(20, 4, 20, 2),
                    child: Align(
                      alignment: AlignmentDirectional.centerStart,
                      child: identified(
                        GroupIds.note,
                        Text(
                          _note!,
                          style: Theme.of(context).textTheme.bodySmall
                              ?.copyWith(
                                color: Theme.of(context)
                                    .colorScheme
                                    .onSurfaceVariant,
                              ),
                        ),
                      ),
                    ),
                  ),
              ],
            ),
          ),
          if (!widget.archived)
            Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 860),
                child: _composer(context),
              ),
            ),
        ],
      ),
    );
  }

  // ------------------------------------------------------------ the thread

  Widget _thread(BuildContext context) {
    final c = controller;
    if (!c.ready && c.messages.isEmpty) {
      return c.error != null
          ? const SizedBox.shrink()
          : const FrockLoading(label: 'Loading the group');
    }
    final messages = c.messages;
    final rows = <Widget>[];
    // Reversed: index 0 is the bottom of the thread.
    if (c.working.isNotEmpty) rows.add(_working(context, c.working));
    for (final pending in c.pending.reversed) {
      rows.add(_pending(context, pending));
    }
    String? previousName;
    final names = <int, String?>{};
    for (final message in messages) {
      names[message.seq] = previousName;
      final body = message.body;
      if (body is GroupEvent &&
          (body.type == 'created' || body.type == 'renamed')) {
        previousName = body.name;
      }
    }
    _stamps(messages);
    final unreadAfter = _unreadAfter;
    for (var index = messages.length - 1; index >= 0; index--) {
      final message = messages[index];
      rows.add(
        KeyedSubtree(
          key: ValueKey('group-message-${message.messageId}'),
          child: _message(context, message, names[message.seq]),
        ),
      );
      final previous = index > 0 ? messages[index - 1] : null;
      if (unreadAfter != null &&
          message.seq > unreadAfter &&
          !message.fromUser &&
          (previous == null || previous.seq <= unreadAfter)) {
        rows.add(const UnreadDivider(key: ValueKey('group-unread')));
      }
    }
    if (c.hasEarlier) {
      rows.add(
        Padding(
          key: const ValueKey('group-earlier'),
          padding: const EdgeInsets.symmetric(vertical: 8),
          child: identified(
            GroupIds.earlier,
            EarlierMessages(
              onPressed: () => unawaited(c.loadEarlier()),
              loading: c.loadingEarlier,
            ),
          ),
        ),
      );
    }
    if (messages.isEmpty && c.pending.isEmpty) {
      rows.add(_empty(context));
    }
    return identified(
      GroupIds.thread,
      SelectionArea(
        child: NotificationListener<ScrollNotification>(
          onNotification: (notification) {
            // The far end of a reversed list is the oldest message.
            if (notification.metrics.extentAfter < 400 && c.hasEarlier) {
              unawaited(c.loadEarlier());
            }
            return false;
          },
          child: ListView(
            controller: scroll,
            reverse: true,
            padding: const EdgeInsets.fromLTRB(
              0,
              chatHeaderThreadPadding,
              0,
              12,
            ),
            keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
            children: rows,
          ),
        ),
      ),
    );
  }

  /// The time each text is written with, and whether its sender is named
  /// over it: both once per speaker's run, the time again after five
  /// minutes, as in a Bot's own thread.
  Map<String, String> _stamped = const {};
  Set<String> _named = const {};

  void _stamps(List<GroupMessage> messages) {
    final now = DateTime.now();
    final stamped = <String, String>{};
    final named = <String>{};
    String? speaker;
    DateTime? last;
    for (final message in messages) {
      if (message.body is! GroupText) {
        speaker = null;
        continue;
      }
      final who = message.botId ?? '';
      if (who != speaker) named.add(message.messageId);
      final at = localInstant(message.at);
      if (at != null &&
          (who != speaker ||
              last == null ||
              at.difference(last).inMinutes >= 5)) {
        stamped[message.messageId] = messageTimeLabel(at, now);
        last = at;
      }
      speaker = who;
    }
    _stamped = stamped;
    _named = named;
  }

  Widget _empty(BuildContext context) {
    final names = [for (final member in _members) member.name];
    return EmptyThread(
      title: 'Say hello to the group',
      detail: names.isEmpty
          ? 'Everyone here reads every message. Use @ to ask someone in particular.'
          : '${names.join(', ')} read every message here. Use @ to ask someone in particular.',
    );
  }

  Widget _message(
    BuildContext context,
    GroupMessage message,
    String? previousName,
  ) {
    final body = message.body;
    switch (body) {
      case GroupText():
        return message.fromUser
            ? _userText(context, message, body)
            : _botText(context, message, body);
      case GroupEvent():
        return _event(context, message, body, previousName);
    }
  }

  Widget _userText(BuildContext context, GroupMessage message, GroupText body) {
    final theme = Theme.of(context);
    final base = FrockTheme.message(theme)
        .copyWith(color: theme.extension<FrockLook>()?.bubbleInk(mine: true));
    return identified(
      GroupIds.message(message.messageId),
      MessageBubble(
        mine: true,
        time: _stamped[message.messageId],
        semanticsLabel: 'You',
        child: Text.rich(_withMentions(context, body, base), style: base),
      ),
    );
  }

  /// The person's words with each resolved mention drawn as its chip, at the
  /// offsets the group resolved it at.
  TextSpan _withMentions(BuildContext context, GroupText body, TextStyle base) {
    final mentions = [...body.mentions]
      ..sort((a, b) => a.start.compareTo(b.start));
    final spans = <InlineSpan>[];
    var at = 0;
    final text = body.text;
    for (final mention in mentions) {
      if (mention.start < at || mention.end > text.length) continue;
      if (mention.start > at) {
        spans.add(TextSpan(text: text.substring(at, mention.start)));
      }
      spans.add(
        mentionChipSpan(
          context,
          text.substring(mention.start, mention.end),
          _faceOf(mention.botId).colour,
          base,
        ),
      );
      at = mention.end;
    }
    if (at < text.length) spans.add(TextSpan(text: text.substring(at)));
    return TextSpan(children: spans);
  }

  Widget _botText(BuildContext context, GroupMessage message, GroupText body) {
    final theme = Theme.of(context);
    final botId = message.botId!;
    final face = _faceOf(botId);
    // A Bot's mention is resolved by the words it wrote, so after Markdown
    // has had its way with the text the same words are found again.
    final chips = <String, Color>{
      for (final mention in body.mentions)
        if (mention.end <= body.text.length && mention.start < mention.end)
          body.text.substring(mention.start, mention.end): _faceOf(
            mention.botId,
          ).colour,
      if (body.mentionsUser) '@User': theme.colorScheme.primary,
    };
    final tokens = chips.keys.toList()
      ..sort((a, b) => b.length.compareTo(a.length));
    InlineSpan decorate(String text, TextStyle style) {
      if (tokens.isEmpty) return TextSpan(text: text, style: style);
      final spans = <InlineSpan>[];
      var at = 0;
      while (at < text.length) {
        var next = -1;
        String? token;
        for (final candidate in tokens) {
          final found = text.indexOf(candidate, at);
          if (found >= 0 && (next < 0 || found < next)) {
            next = found;
            token = candidate;
          }
        }
        if (token == null) {
          spans.add(TextSpan(text: text.substring(at), style: style));
          break;
        }
        if (next > at) {
          spans.add(TextSpan(text: text.substring(at, next), style: style));
        }
        spans.add(mentionChipSpan(context, token, chips[token]!, style));
        at = next + token.length;
      }
      return TextSpan(children: spans);
    }

    final named = _named.contains(message.messageId);
    return identified(
      GroupIds.message(message.messageId),
      Padding(
        padding: EdgeInsets.only(top: named ? 6 : 0),
        child: MessageBubble(
          mine: false,
          label: named ? BotBadge(face: face) : null,
          time: _stamped[message.messageId],
          semanticsLabel: face.name,
          child: ShellMarkdown(text: body.text, decorate: decorate),
        ),
      ),
    );
  }

  Widget _event(
    BuildContext context,
    GroupMessage message,
    GroupEvent event,
    String? previousName,
  ) {
    final theme = Theme.of(context);
    final text = groupEventText(event, message.botId, _nameOf);
    final muted = theme.colorScheme.onSurfaceVariant;
    Widget link(String id, String label, IconData icon, VoidCallback onTap) =>
        identified(id, ThreadLink(icon: icon, label: label, onTap: onTap));
    switch (event.type) {
      case 'turn-failed':
        final botId = event.botId;
        final runId = event.runId;
        return identified(
          GroupIds.message(message.messageId),
          Padding(
            padding: const EdgeInsets.fromLTRB(18, 6, 16, 4),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                if (botId != null) BotBadge(face: _faceOf(botId), small: true),
                const SizedBox(height: 4),
                Wrap(
                  spacing: 6,
                  runSpacing: 2,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    Text(
                      text,
                      style: theme.textTheme.bodySmall?.copyWith(color: muted),
                    ),
                    if (botId != null && runId != null)
                      link(
                        GroupIds.retry(runId),
                        'Retry',
                        Icons.refresh_rounded,
                        () => unawaited(controller.retry(botId, runId)),
                      ),
                  ],
                ),
              ],
            ),
          ),
        );
      case 'bot-message':
        final botId = event.botId;
        final toBotId = event.toBotId;
        final open = widget.onOpenExchange;
        return ThreadMarker(
          identifier: GroupIds.exchange(message.messageId),
          onTap: open == null || botId == null || toBotId == null
              ? null
              : () => open(botId, toBotId),
          children: [
            if (botId != null) BotBadge(face: _faceOf(botId), small: true),
            Text('messaged', style: ThreadMarker.quiet(theme)),
            if (toBotId != null)
              GroupAvatars(faces: [_faceOf(toBotId)], size: 18),
            Text(
              toBotId == null ? 'a Bot' : _nameOf(toBotId),
              style: ThreadMarker.named(theme),
            ),
          ],
        );
    }
    final undo = widget.onUndo;
    final undoable =
        undo != null &&
        switch (event.type) {
          'member-added' =>
            event.botId != null &&
                _members.any((m) => m.botId == event.botId) &&
                _members.length > 2,
          'member-removed' =>
            event.botId != null &&
                !_members.any((m) => m.botId == event.botId) &&
                _members.length < 8,
          'renamed' =>
            (controller.view?.group.name ?? '') == (event.name ?? ''),
          _ => false,
        };
    return identified(
      GroupIds.message(message.messageId),
      Padding(
        padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 8),
        child: Center(
          child: Wrap(
            alignment: WrapAlignment.center,
            crossAxisAlignment: WrapCrossAlignment.center,
            spacing: 6,
            children: [
              Text(
                text,
                textAlign: TextAlign.center,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: muted.withValues(alpha: 0.8),
                ),
              ),
              if (undoable)
                link(
                  'group-chat-undo-${message.messageId}',
                  'Undo',
                  Icons.undo_rounded,
                  () => undo(event, previousName),
                ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _pending(BuildContext context, GroupPendingSend pending) {
    final theme = Theme.of(context);
    final base = FrockTheme.message(theme)
        .copyWith(color: theme.extension<FrockLook>()?.bubbleInk(mine: true));
    return identified(
      GroupIds.pending(pending.commandId),
      Column(
        key: ValueKey('group-pending-${pending.commandId}'),
        crossAxisAlignment: CrossAxisAlignment.end,
        mainAxisSize: MainAxisSize.min,
        children: [
          MessageBubble(mine: true, child: Text(pending.text, style: base)),
          if (pending.failed)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 4),
              child: Wrap(
                spacing: 8,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  Text(
                    'Not sent.',
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                  identified(
                    GroupIds.resend(pending.commandId),
                    TextButton(
                      onPressed: () =>
                          unawaited(controller.resend(pending.commandId)),
                      child: const Text('Send again'),
                    ),
                  ),
                  TextButton(
                    onPressed: () =>
                        unawaited(controller.discard(pending.commandId)),
                    child: const Text('Edit'),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }

  /// Each member whose group Turn is running, at the end of the thread,
  /// working as it is everywhere else it is drawn, side by side. A Bot
  /// waiting its turn is not drawn.
  Widget _working(BuildContext context, List<String> working) {
    final names = [for (final botId in working) _nameOf(botId)];
    return identified(
      GroupIds.working,
      Semantics(
        container: true,
        liveRegion: true,
        label: '${names.join(', ')} working',
        child: Padding(
          padding: const EdgeInsets.fromLTRB(18, 8, 16, 4),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              for (final botId in working)
                Padding(
                  key: ValueKey('group-working-$botId'),
                  padding: const EdgeInsets.only(right: 6),
                  child: CharacterAvatar(
                    size: groupWorkingSize,
                    botId: botId,
                    characterId: _faceOf(botId).characterId,
                    primary: _faceOf(botId).primary,
                    cropToInk: true,
                    working: true,
                  ),
                ),
              if (MediaQuery.disableAnimationsOf(context)) ...[
                const SizedBox(width: 4),
                Text(
                  '${names.join(', ')} working…',
                  style: Theme.of(context).textTheme.labelMedium?.copyWith(
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  // ---------------------------------------------------------- the composer

  Widget _composer(BuildContext context) {
    final theme = Theme.of(context);
    final c = controller;
    final candidates = _candidates;
    if (_highlight >= candidates.length) _highlight = 0;
    final fieldStyle = theme.textTheme.bodyLarge?.copyWith(
      fontWeight: FontWeight.w400,
    );
    final oneLine =
        composerFieldPadding.vertical +
        MediaQuery.textScalerOf(context).scale(fieldStyle?.fontSize ?? 14) *
            (fieldStyle?.height ?? 1.0);
    final line = oneLine < kMinInteractiveDimension
        ? kMinInteractiveDimension
        : oneLine;
    final extent = composerControlExtent(line);
    final empty = editor.text.trim().isEmpty;
    final stoppable = empty && c.working.isNotEmpty;
    final prompt = 'Message ${widget.name}';
    final button = stoppable
        ? identified(
            GroupIds.stop,
            FrockIconButton(
              kind: FrockIconButtonKind.filled,
              round: true,
              tooltip: 'Stop everyone',
              onPressed: c.stopping
                  ? null
                  : () => unawaited(_stop(const GroupStopAll())),
              extent: extent,
              iconSize: composerControlIconSize(extent),
              icon: const Icon(Icons.stop_rounded),
            ),
          )
        : identified(
            GroupIds.send,
            composerSendButton(
              extent: extent,
              onPressed: empty || !c.ready ? null : () => unawaited(_send()),
            ),
          );
    return SafeArea(
      top: false,
      minimum: const EdgeInsets.fromLTRB(12, 0, 12, 12),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (candidates.isNotEmpty)
            _MentionPicker(
              candidates: candidates,
              highlight: _highlight,
              faceOf: _faceOf,
              onChoose: _choose,
            ),
          ComposerFieldFrame(
            focused: focus.hasFocus,
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Expanded(
                  child: CallbackShortcuts(
                    bindings: {
                      const SingleActivator(
                        LogicalKeyboardKey.enter,
                        meta: true,
                      ): () =>
                          unawaited(_send()),
                      const SingleActivator(
                        LogicalKeyboardKey.enter,
                        control: true,
                      ): () =>
                          unawaited(_send()),
                      if (enterSends || candidates.isNotEmpty) ...{
                        const SingleActivator(LogicalKeyboardKey.enter): _enter,
                        const SingleActivator(LogicalKeyboardKey.numpadEnter):
                            _enter,
                      },
                      if (candidates.isNotEmpty) ...{
                        const SingleActivator(LogicalKeyboardKey.arrowUp): () =>
                            setState(
                              () => _highlight =
                                  (_highlight - 1) % candidates.length,
                            ),
                        const SingleActivator(
                          LogicalKeyboardKey.arrowDown,
                        ): () => setState(
                          () =>
                              _highlight = (_highlight + 1) % candidates.length,
                        ),
                        const SingleActivator(LogicalKeyboardKey.tab): () =>
                            _choose(candidates[_highlight]),
                      },
                    },
                    child: identified(
                      GroupIds.composer,
                      Semantics(
                        label: prompt,
                        child: SteadyCaret(
                          child: TextField(
                            controller: editor,
                            focusNode: focus,
                            style: fieldStyle,
                            minLines: 1,
                            maxLines: 6,
                            maxLength: groupMessageMaxCharacters,
                            maxLengthEnforcement: MaxLengthEnforcement.none,
                            keyboardType: TextInputType.multiline,
                            textInputAction: TextInputAction.newline,
                            decoration: InputDecoration(
                              hintText: prompt,
                              hintMaxLines: 1,
                              filled: false,
                              border: InputBorder.none,
                              enabledBorder: InputBorder.none,
                              focusedBorder: InputBorder.none,
                              contentPadding: composerFieldPadding,
                              constraints: BoxConstraints(minHeight: line),
                              counterText: '',
                            ),
                            onChanged: (value) {
                              controller.saveDraft(value);
                              setState(() {});
                            },
                            onTap: () => setState(() {}),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
                SizedBox(
                  height: line,
                  child: Padding(
                    padding: const EdgeInsets.only(right: 4),
                    child: Center(child: button),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  @override
  void dispose() {
    controller.removeListener(_changed);
    scroll.removeListener(_scrolled);
    editor.dispose();
    focus.dispose();
    scroll.dispose();
    _noteTimer?.cancel();
    super.dispose();
  }
}

/// The members an `@` can name, above the field.
class _MentionPicker extends StatelessWidget {
  final List<GroupMemberInfo> candidates;
  final int highlight;
  final GroupFace Function(String botId) faceOf;
  final void Function(GroupMemberInfo member) onChoose;
  const _MentionPicker({
    required this.candidates,
    required this.highlight,
    required this.faceOf,
    required this.onChoose,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Material(
        color: theme.colorScheme.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(14),
        clipBehavior: Clip.antiAlias,
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxHeight: 240),
          child: ListView(
            shrinkWrap: true,
            padding: const EdgeInsets.symmetric(vertical: 4),
            children: [
              for (var index = 0; index < candidates.length; index++)
                identified(
                  GroupIds.mentionOption(candidates[index].botId),
                  ListTile(
                    dense: true,
                    selected: index == highlight,
                    leading: GroupAvatars(
                      faces: [faceOf(candidates[index].botId)],
                      size: 26,
                      ring: theme.colorScheme.surfaceContainerHigh,
                    ),
                    title: Text(candidates[index].name),
                    subtitle: candidates[index].description == null
                        ? null
                        : Text(
                            candidates[index].description!,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                    onTap: () => onChoose(candidates[index]),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
