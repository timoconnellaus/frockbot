/// The Bot list: pinned tiles, label groups, unread, and the way out of it.
///
/// A pinned Bot is a tile above the list instead of a row inside it, never
/// both — the tile *is* the row, moved — so grouping runs over what is left.
/// Hidden and archived are different states: archiving stops a Bot
/// working, hiding only takes it out of this list, so a hidden Bot stays
/// selectable and its own group is how a person reaches it again.
library;

import 'package:flutter/material.dart';

import '../flock/sheep.dart';
import '../protocol/client_wire.generated.dart' as wire;
import '../theme/frock_theme.dart';
import 'focus.dart';
import 'semantics.dart';

/// What the sidebar's voice control offers right now. [ending] is the window
/// between the footer leaving and the previous call's teardown finishing: a
/// start in it would be dropped, so the control says so instead of inviting
/// one.
enum VoiceControlState { idle, active, ending }

/// Mirrors the shell's own start guard — a start is refused while the session
/// is still active — so the control cannot promise what the guard would drop.
VoiceControlState voiceControlStateV1({
  required bool footerOpen,
  required bool sessionActive,
}) => footerOpen
    ? VoiceControlState.active
    : sessionActive
    ? VoiceControlState.ending
    : VoiceControlState.idle;

/// The mutable half of a Bot's identity, as the sidebar reads it.
class SidebarProfile {
  final String? name;
  final String? title;
  final String? label;
  final String? pinnedAt;
  final bool hiddenFromSidebar;
  const SidebarProfile({
    this.name,
    this.title,
    this.label,
    this.pinnedAt,
    this.hiddenFromSidebar = false,
  });

  static SidebarProfile? decode(Object? value) {
    if (value is! Map) return null;
    return SidebarProfile(
      name: value['name'] as String?,
      title: value['title'] as String?,
      label: value['label'] as String?,
      pinnedAt: value['pinnedAt'] as String?,
      hiddenFromSidebar: value['hiddenFromSidebar'] == true,
    );
  }
}

class PinnedSidebarBots<T> {
  /// Pinned Bots, earliest pin first. Rendered as tiles above the list.
  final List<T> pinned;

  /// Everything else, in the order it arrived.
  final List<T> rest;
  const PinnedSidebarBots(this.pinned, this.rest);
}

/// Splits the pinned Bots out of the list.
///
/// Order is by pin time — earliest first — because the tile row is a place a
/// person builds up over time and a Bot pinned today must not displace the one
/// they pinned last month. Ties and unparseable instants keep list order.
PinnedSidebarBots<T> partitionPinnedSidebarBots<T>(
  List<T> bots,
  String Function(T) idOf,
  Map<String, SidebarProfile> profiles,
) {
  final pinned = <({T bot, int at, int index})>[];
  final rest = <T>[];
  for (var index = 0; index < bots.length; index++) {
    final bot = bots[index];
    final pinnedAt = profiles[idOf(bot)]?.pinnedAt?.trim();
    if (pinnedAt == null || pinnedAt.isEmpty) {
      rest.add(bot);
      continue;
    }
    final at = DateTime.tryParse(pinnedAt);
    pinned.add((bot: bot, at: at?.millisecondsSinceEpoch ?? 0, index: index));
  }
  pinned.sort(
    (left, right) =>
        left.at == right.at ? left.index - right.index : left.at - right.at,
  );
  return PinnedSidebarBots([for (final entry in pinned) entry.bot], rest);
}

class SidebarBotGroup<T> {
  final String key;
  final String label;
  final List<T> bots;
  const SidebarBotGroup(this.key, this.label, this.bots);
}

class GroupedSidebarBots<T> {
  final bool showHeadings;
  final List<SidebarBotGroup<T>> groups;
  const GroupedSidebarBots(this.showHeadings, this.groups);
}

/// Groups labels by their case-insensitive trimmed value while preserving the
/// spelling of the first Bot in each group. Unassigned is always last. Until a
/// visible Bot has a label, the sidebar remains one plain list with no heading.
GroupedSidebarBots<T> groupSidebarBots<T>(
  List<T> bots,
  String Function(T) idOf,
  Map<String, SidebarProfile> profiles,
) {
  final labelled = <String, SidebarBotGroup<T>>{};
  final unassigned = <T>[];
  for (final bot in bots) {
    final label = profiles[idOf(bot)]?.label?.trim() ?? '';
    if (label.isEmpty) {
      unassigned.add(bot);
      continue;
    }
    final key = label.toLowerCase();
    final group = labelled[key];
    if (group != null) {
      group.bots.add(bot);
    } else {
      labelled[key] = SidebarBotGroup('label:$key', label, [bot]);
    }
  }
  if (labelled.isEmpty) {
    return GroupedSidebarBots(false, [
      SidebarBotGroup('all', '', [...bots]),
    ]);
  }
  return GroupedSidebarBots(true, [
    ...labelled.values,
    if (unassigned.isNotEmpty)
      SidebarBotGroup('unassigned', 'Unassigned', unassigned),
  ]);
}

/// The local time label beside the latest message: a time today, a weekday
/// inside the last week, a date beyond it.
String formatSidebarMessageTime(String at, [DateTime? clock]) {
  final message = DateTime.tryParse(at)?.toLocal();
  if (message == null) return '';
  final now = clock ?? DateTime.now();
  final today = DateTime(now.year, now.month, now.day);
  final tomorrow = today.add(const Duration(days: 1));
  if (!message.isBefore(today) && message.isBefore(tomorrow)) {
    final hour = message.hour % 12 == 0 ? 12 : message.hour % 12;
    final minute = message.minute.toString().padLeft(2, '0');
    return '$hour:$minute ${message.hour < 12 ? 'am' : 'pm'}';
  }
  if (!message.isBefore(today.subtract(const Duration(days: 6))) &&
      message.isBefore(tomorrow)) {
    const days = [
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
      'Saturday',
      'Sunday',
    ];
    return days[message.weekday - 1];
  }
  return '${message.month}/${message.day}';
}

// ------------------------------------------------------------ the widget

class ShellSidebar extends StatelessWidget {
  final List<wire.BotRegistration> bots;
  final Map<String, SidebarProfile> profiles;
  final Map<String, wire.UnreadView> unread;
  final Set<String> archived;
  final String? activeBotId;

  /// The Bot the User is actually reading: its chat is open, this window holds
  /// focus, and nothing is covering it. Its row draws no count, because the
  /// read receipt for the message that raised one is still in flight. See
  /// [sidebarUnreadFor].
  final String? focusedBotId;

  /// The Bot the shell knows is working, which it learns a poll sooner than
  /// the unread fan-out does.
  final String? workingBotId;
  final bool loaded;
  final String? error;
  final bool showHidden;
  final void Function(String botId) onSelect;
  final VoidCallback onCreateBot;
  final VoidCallback onSearch;
  final VoidCallback onProfile;

  /// Opens the Marketplace: the services a Bot can be given, and the accounts
  /// already on them. Where it is drawn depends on [phone].
  final VoidCallback onMarketplace;

  /// Whether this list is a phone's whole screen. There the Marketplace is a
  /// control in the header beside the account, because the foot of a
  /// full-height list is the last place a thumb reaches; on a wider layout
  /// the column has a foot, and the Marketplace is a named row on it.
  final bool phone;

  /// Opens the voice footer and starts the call, in the one gesture.
  final VoidCallback onVoice;

  /// What the control says and whether it can be pressed.
  final VoiceControlState voiceControl;
  final VoidCallback onToggleHidden;
  final Future<void> Function() onRetry;
  const ShellSidebar({
    super.key,
    required this.bots,
    required this.profiles,
    required this.unread,
    required this.archived,
    required this.activeBotId,
    required this.focusedBotId,
    required this.workingBotId,
    required this.loaded,
    required this.showHidden,
    required this.onSelect,
    required this.onCreateBot,
    required this.onSearch,
    required this.onProfile,
    required this.onMarketplace,
    required this.onVoice,
    required this.voiceControl,
    required this.onToggleHidden,
    required this.onRetry,
    this.phone = false,
    this.error,
  });

  String _id(wire.BotRegistration bot) => bot.botId.value;
  String _name(wire.BotRegistration bot) =>
      profiles[_id(bot)]?.name ?? bot.initialName;
  bool _hidden(wire.BotRegistration bot) =>
      profiles[_id(bot)]?.hiddenFromSidebar == true;

  /// The open Bot's own Turn is the shell's — it projects the run and knows
  /// about it a poll sooner — so that row reads [workingBotId]. Every other
  /// row reads the unread fan-out, which is the only thing that knows a Bot in
  /// another conversation is working.
  bool _working(wire.BotRegistration bot) => _id(bot) == activeBotId
      ? _id(bot) == workingBotId
      : unread[_id(bot)]?.working == true;

  /// Every badge, bold name and total on this list reads the fan-out through
  /// the focus rule, so no surface of it can disagree with another.
  SidebarUnread _unread(String botId) =>
      sidebarUnreadFor(unread[botId], focused: botId == focusedBotId);

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final visible = [
      for (final bot in bots)
        if (!_hidden(bot)) bot,
    ];
    final hidden = [
      for (final bot in bots)
        if (_hidden(bot)) bot,
    ];
    final partitioned = partitionPinnedSidebarBots(visible, _id, profiles);
    final grouped = groupSidebarBots(partitioned.rest, _id, profiles);
    final hiddenUnread = hidden.fold(
      0,
      (total, bot) => total + _unread(_id(bot)).count,
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _Header(
          onCreateBot: onCreateBot,
          onSearch: phone ? onSearch : null,
          onProfile: onProfile,
          onMarketplace: phone ? onMarketplace : null,
          onVoice: onVoice,
          voiceControl: voiceControl,
        ),
        if (!phone)
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 4, 12, 14),
            child: identified(
              ShellIds.sidebarSearch,
              Material(
                color: Theme.of(context).colorScheme.surfaceContainerHigh,
                borderRadius: BorderRadius.circular(11),
                child: InkWell(
                  onTap: onSearch,
                  borderRadius: BorderRadius.circular(11),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 12,
                      vertical: 11,
                    ),
                    child: Row(
                      children: [
                        Icon(
                          Icons.search_rounded,
                          size: 19,
                          color: Theme.of(context).colorScheme.onSurfaceVariant,
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            'Search',
                            style: TextStyle(
                              color: Theme.of(context)
                                  .colorScheme
                                  .onSurfaceVariant,
                            ),
                          ),
                        ),
                        Semantics(
                          label:
                              Theme.of(context).platform == TargetPlatform.macOS
                              ? 'Command K'
                              : 'Control K',
                          excludeSemantics: true,
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              if (Theme.of(context).platform ==
                                  TargetPlatform.macOS)
                                Icon(
                                  Icons.keyboard_command_key,
                                  size: 13,
                                  color: Theme.of(context)
                                      .colorScheme
                                      .onSurfaceVariant,
                                ),
                              Text(
                                Theme.of(context).platform ==
                                        TargetPlatform.macOS
                                    ? 'K'
                                    : 'Ctrl+K',
                                style: Theme.of(context).textTheme.labelSmall,
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        Expanded(
          child: ListView(
            padding: const EdgeInsets.only(bottom: 12),
            children: [
              // An unreadable list is not an empty one, and it is not a
              // loading one either. Offering to add a first Bot to someone
              // whose Bots simply did not load is the worst thing this column
              // can say, so the failure takes the slot first and offers the
              // read again.
              if (error != null && bots.isEmpty)
                _Error(message: error!, onRetry: onRetry)
              else if (!loaded)
                const _Skeleton()
              else if (bots.isEmpty)
                const _NoBots()
              else ...[
                if (partitioned.pinned.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(10, 4, 10, 6),
                    child: Wrap(
                      spacing: 4,
                      runSpacing: 4,
                      children: [
                        for (final bot in partitioned.pinned)
                          identified(
                            ShellIds.sidebarPinned(_id(bot)),
                            _PinnedTile(
                              name: _name(bot),
                              background: bot.sheep.background,
                              active: _id(bot) == activeBotId,
                              unread: _unread(_id(bot)).unread,
                              working: _working(bot),
                              onTap: () => onSelect(_id(bot)),
                            ),
                          ),
                      ],
                    ),
                  ),
                for (final group in grouped.groups)
                  identified(
                    ShellIds.sidebarGroup(group.key),
                    Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        if (grouped.showHeadings && group.label.isNotEmpty)
                          Padding(
                            padding: const EdgeInsets.fromLTRB(20, 14, 16, 4),
                            child: Text(
                              group.label.toUpperCase(),
                              style: theme.textTheme.labelSmall?.copyWith(
                                color: theme.colorScheme.onSurfaceVariant
                                    .withValues(alpha: 0.85),
                              ),
                            ),
                          ),
                        for (final bot in group.bots) _row(context, bot),
                      ],
                    ),
                  ),
                if (hidden.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(12, 6, 12, 0),
                    child: Align(
                      alignment: Alignment.centerLeft,
                      child: identified(
                        ShellIds.sidebarHiddenToggle,
                        TextButton(
                          onPressed: onToggleHidden,
                          style: TextButton.styleFrom(
                            foregroundColor: theme.colorScheme.onSurfaceVariant,
                            minimumSize: const Size(0, 32),
                            padding: const EdgeInsets.symmetric(horizontal: 8),
                            textStyle: theme.textTheme.labelMedium,
                          ),
                          child: Text(
                            showHidden
                                ? 'Hide ${hidden.length} hidden'
                                : 'Show ${hidden.length} hidden'
                                      '${hiddenUnread > 0 ? ' ($hiddenUnread)' : ''}',
                          ),
                        ),
                      ),
                    ),
                  ),
                if (showHidden)
                  for (final bot in hidden) _row(context, bot),
              ],
              // The same failure over a list that still has rows: a banner,
              // not a replacement, because what is on screen is still the last
              // thing known.
              if (error != null && bots.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Icon(
                        Icons.cloud_off_rounded,
                        size: 16,
                        color: theme.colorScheme.error.withValues(alpha: 0.9),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          error!,
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: theme.colorScheme.onSurfaceVariant,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
            ],
          ),
        ),
        if (!phone) _Foot(onMarketplace: onMarketplace),
      ],
    );
  }

  Widget _row(BuildContext context, wire.BotRegistration bot) {
    final theme = Theme.of(context);
    final botId = _id(bot);
    final view = unread[botId];
    final preview = view?.lastMessage?['text'] as String?;
    final at = view?.lastMessage?['at'] as String?;
    final shown = _unread(botId);
    final badge = shown.label;
    final isArchived = archived.contains(botId);
    final isUnread = shown.unread;
    final selected = botId == activeBotId;
    return identified(
      ShellIds.sidebarBot(botId),
      _BotRow(
        key: ValueKey('bot-$botId'),
        selected: selected,
        enabled: !isArchived,
        onTap: isArchived ? null : () => onSelect(botId),
        avatar: SheepAvatar(
          size: 36,
          background: bot.sheep.background,
          working: _working(bot),
        ),
        name: _name(bot),
        nameStyle: theme.textTheme.bodyMedium?.copyWith(
          fontSize: 14,
          fontWeight: isUnread ? FontWeight.w600 : FontWeight.w500,
          letterSpacing: -0.1,
          color: isArchived
              ? theme.colorScheme.onSurfaceVariant
              : theme.colorScheme.onSurface,
        ),
        time: at == null ? null : formatSidebarMessageTime(at),
        preview: preview ?? profiles[botId]?.title ?? 'No messages yet',
        previewStyle: theme.textTheme.bodySmall?.copyWith(
          fontSize: 12.5,
          color: isUnread
              ? theme.colorScheme.onSurface.withValues(alpha: 0.78)
              : theme.colorScheme.onSurfaceVariant,
        ),
        // One slot, one meaning. The row's own selected state already says
        // which Bot is open, so the slot carries unread and archived — the two
        // things a row can say that its appearance does not.
        trailing: badge == null && !isArchived
            ? null
            : Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (isArchived)
                    Text(
                      'Archived',
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                        letterSpacing: 0.2,
                      ),
                    ),
                  if (badge != null) ...[
                    if (isArchived) const SizedBox(width: 6),
                    Badge(label: Text(badge)),
                  ],
                ],
              ),
      ),
    );
  }
}

/// One Bot in the list: the face, the name and the last thing said, in a row
/// no taller than it has to be. The selected tint is inset from the column's
/// edges so the list reads as a list and not as a table.
class _BotRow extends StatelessWidget {
  final bool selected;
  final bool enabled;
  final VoidCallback? onTap;
  final Widget avatar;
  final String name;
  final TextStyle? nameStyle;
  final String? time;
  final String preview;
  final TextStyle? previewStyle;
  final Widget? trailing;
  const _BotRow({
    super.key,
    required this.selected,
    required this.enabled,
    required this.onTap,
    required this.avatar,
    required this.name,
    required this.nameStyle,
    required this.time,
    required this.preview,
    required this.previewStyle,
    required this.trailing,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8),
      child: Semantics(
        selected: selected,
        button: enabled,
        child: Material(
          color: selected
              ? theme.colorScheme.onSurface.withValues(alpha: 0.06)
              : Colors.transparent,
          borderRadius: BorderRadius.circular(10),
          child: InkWell(
            onTap: onTap,
            borderRadius: BorderRadius.circular(10),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(10, 8, 12, 8),
              child: Opacity(
                opacity: enabled ? 1 : 0.6,
                child: Row(
                  children: [
                    avatar,
                    const SizedBox(width: 11),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Row(
                            crossAxisAlignment: CrossAxisAlignment.baseline,
                            textBaseline: TextBaseline.alphabetic,
                            children: [
                              Expanded(
                                child: Text(
                                  name,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: nameStyle,
                                ),
                              ),
                              if (time case final String stamp) ...[
                                const SizedBox(width: 8),
                                Text(
                                  stamp,
                                  style: theme.textTheme.bodySmall?.copyWith(
                                    fontSize: 11.5,
                                    color: theme.colorScheme.onSurfaceVariant
                                        .withValues(alpha: 0.9),
                                  ),
                                ),
                              ],
                            ],
                          ),
                          const SizedBox(height: 2),
                          Row(
                            children: [
                              Expanded(
                                child: Text(
                                  preview,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: previewStyle,
                                ),
                              ),
                              if (trailing case final Widget end) ...[
                                const SizedBox(width: 8),
                                end,
                              ],
                            ],
                          ),
                        ],
                      ),
                    ),
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

/// The list's own controls, GrokBot's plus voice: you, a call, search, and
/// a new Bot — and on a phone, the Marketplace beside you.
///
/// Everything about the account is behind the first one; everything about one
/// Bot is on that Bot's page. The list itself carries no title — the rows say
/// what it is.
class _Header extends StatelessWidget {
  final VoidCallback onCreateBot;
  final VoidCallback? onSearch;
  final VoidCallback onProfile;

  /// The Marketplace, where the header is the place for it; null where the
  /// column's foot names it instead.
  final VoidCallback? onMarketplace;

  /// Starts the continuous voice session. One gesture: the footer opens and
  /// the call starts, because a footer that opens and then waits to be
  /// started again is two gestures for one intention.
  final VoidCallback onVoice;
  final VoiceControlState voiceControl;
  const _Header({
    required this.onCreateBot,
    required this.onSearch,
    required this.onVoice,
    required this.voiceControl,
    required this.onProfile,
    this.onMarketplace,
  });

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    // Quiet controls: a glyph and nothing round it until it is pressed. The
    // one exception is the new-Bot button, which is the row's one invitation
    // and wears the accent.
    final quiet = IconButton.styleFrom(
      foregroundColor: scheme.onSurfaceVariant,
      minimumSize: const Size(34, 34),
      fixedSize: const Size(34, 34),
      padding: EdgeInsets.zero,
      iconSize: 20,
      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(9)),
    );
    final active = quiet.copyWith(
      foregroundColor: WidgetStatePropertyAll(scheme.primary),
      backgroundColor: WidgetStatePropertyAll(
        scheme.primary.withValues(alpha: 0.14),
      ),
    );
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 10, 10, 6),
      child: Row(
        children: [
          identified(
            ShellIds.sidebarProfile,
            IconButton(
              tooltip: 'You',
              onPressed: onProfile,
              style: quiet,
              icon: Container(
                width: 28,
                height: 28,
                decoration: BoxDecoration(
                  color: scheme.onSurface.withValues(alpha: 0.08),
                  shape: BoxShape.circle,
                  border: Border.all(
                    color: scheme.onSurface.withValues(alpha: 0.08),
                  ),
                ),
                child: Icon(
                  Icons.person_rounded,
                  size: 17,
                  color: scheme.onSurfaceVariant,
                ),
              ),
            ),
          ),
          if (onMarketplace case final VoidCallback open) ...[
            const SizedBox(width: 2),
            identified(
              ShellIds.sidebarMarketplace,
              IconButton(
                tooltip: 'Marketplace',
                onPressed: open,
                style: quiet,
                icon: const Icon(Icons.storefront_outlined),
              ),
            ),
          ],
          const Spacer(),
          identified(
            VoiceIds.sidebarStart,
            IconButton(
              tooltip: switch (voiceControl) {
                VoiceControlState.active => 'Voice session active',
                VoiceControlState.ending => 'Ending voice session…',
                VoiceControlState.idle => 'Start voice session',
              },
              isSelected: voiceControl == VoiceControlState.active,
              style: voiceControl == VoiceControlState.active ? active : quiet,
              onPressed: voiceControl == VoiceControlState.ending
                  ? null
                  : onVoice,
              icon: const Icon(Icons.graphic_eq_rounded),
            ),
          ),
          const SizedBox(width: 2),
          if (onSearch != null)
            identified(
              ShellIds.sidebarSearch,
              IconButton(
                tooltip: 'Search',
                onPressed: onSearch,
                style: quiet,
                icon: const Icon(Icons.search_rounded),
              ),
            ),
          const SizedBox(width: 2),
          identified(
            ShellIds.sidebarCreateBot,
            IconButton(
              tooltip: 'Add a sheep',
              onPressed: onCreateBot,
              style: active,
              icon: const Icon(Icons.add_rounded),
            ),
          ),
        ],
      ),
    );
  }
}

/// The foot of the column on a wider layout: the Marketplace, named.
///
/// A row rather than an icon because the column has the width for a word, and
/// a word is what makes a door someone has never opened worth opening.
class _Foot extends StatelessWidget {
  final VoidCallback onMarketplace;
  const _Foot({required this.onMarketplace});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        const Divider(height: 1),
        Padding(
          padding: const EdgeInsets.fromLTRB(8, 6, 8, 8),
          child: identified(
            ShellIds.sidebarMarketplace,
            InkWell(
              onTap: onMarketplace,
              borderRadius: BorderRadius.circular(10),
              child: Padding(
                padding: const EdgeInsets.fromLTRB(12, 9, 12, 9),
                child: Row(
                  children: [
                    Icon(
                      Icons.storefront_outlined,
                      size: 19,
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                    const SizedBox(width: 11),
                    Expanded(
                      child: Text(
                        'Marketplace',
                        style: theme.textTheme.bodyMedium?.copyWith(
                          fontWeight: FontWeight.w500,
                          letterSpacing: -0.1,
                        ),
                      ),
                    ),
                    Icon(
                      Icons.chevron_right_rounded,
                      size: 18,
                      color: theme.colorScheme.onSurfaceVariant.withValues(
                        alpha: 0.6,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }
}

class _PinnedTile extends StatelessWidget {
  final String name;
  final String background;
  final bool active;
  final bool unread;
  final bool working;
  final VoidCallback onTap;
  const _PinnedTile({
    required this.name,
    required this.background,
    required this.active,
    required this.unread,
    required this.working,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Material(
      color: active
          ? theme.colorScheme.onSurface.withValues(alpha: 0.06)
          : Colors.transparent,
      borderRadius: BorderRadius.circular(10),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(10),
        child: Container(
          width: 66,
          padding: const EdgeInsets.fromLTRB(4, 8, 4, 6),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Stack(
                clipBehavior: Clip.none,
                children: [
                  SheepAvatar(
                    size: 40,
                    background: background,
                    working: working,
                  ),
                  if (unread)
                    Positioned(
                      right: -3,
                      top: -3,
                      child: Container(
                        width: 12,
                        height: 12,
                        decoration: BoxDecoration(
                          color: theme.colorScheme.primary,
                          shape: BoxShape.circle,
                          border: Border.all(
                            color: theme.colorScheme.surface,
                            width: 2,
                          ),
                        ),
                      ),
                    ),
                ],
              ),
              const SizedBox(height: 5),
              Text(
                name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.bodySmall?.copyWith(
                  fontSize: 11.5,
                  fontWeight: unread ? FontWeight.w600 : FontWeight.w500,
                  color: theme.colorScheme.onSurface.withValues(
                    alpha: unread ? 1 : 0.85,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Error extends StatelessWidget {
  final String message;
  final Future<void> Function() onRetry;
  const _Error({required this.message, required this.onRetry});

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.all(16),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          message,
          style: Theme.of(context).textTheme.bodyMedium
              ?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant),
        ),
        const SizedBox(height: 10),
        identified(
          ShellIds.sidebarRetry,
          OutlinedButton(
            onPressed: () => onRetry(),
            style: OutlinedButton.styleFrom(
              minimumSize: const Size(0, 34),
              padding: const EdgeInsets.symmetric(horizontal: 14),
            ),
            child: const Text('Retry'),
          ),
        ),
      ],
    ),
  );
}

/// The skeleton is for a list nobody has yet, not for every request: a reload
/// after creating a Bot must keep the list already on screen rather than
/// blanking it.
class _Skeleton extends StatelessWidget {
  const _Skeleton();

  @override
  Widget build(BuildContext context) => Semantics(
    label: 'Loading your flock',
    child: Column(
      children: [
        for (var row = 0; row < 3; row++)
          const Padding(
            padding: EdgeInsets.fromLTRB(18, 10, 20, 2),
            child: Row(
              children: [
                FrockSkeleton(width: 36, height: 36),
                SizedBox(width: 11),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      FrockSkeleton(width: 120, height: 12),
                      SizedBox(height: 8),
                      FrockSkeleton(width: 180, height: 10),
                    ],
                  ),
                ),
              ],
            ),
          ),
      ],
    ),
  );
}

class _NoBots extends StatelessWidget {
  const _NoBots();

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(20, 24, 20, 24),
    child: Text(
      'No Bots yet. Add your first sheep.',
      style: Theme.of(context).textTheme.bodyMedium
          ?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant),
    ),
  );
}
