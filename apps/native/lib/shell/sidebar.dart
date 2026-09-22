/// The Bot list: pinned tiles, label groups, unread, and the way out of it.
///
/// Every row also offers its Bot's quick actions — the list of them is
/// `bot_actions.dart`'s — reached the way each tier reaches a row: a phone
/// long-presses it, or swipes it (towards the trailing edge to mark it read
/// or unread, towards the leading edge to reveal Hide, or all the way to
/// hide) the way Mail's rows swipe, through `flutter_slidable`; a desktop
/// secondary-clicks it, or presses the control the row grows under the
/// pointer and on focus.
///
/// A pinned Bot is a tile above the list instead of a row inside it, never
/// both — the tile *is* the row, moved — so grouping runs over what is left.
/// Hidden and archived are different states: archiving stops a Bot
/// working, hiding only takes it out of this list, so a hidden Bot stays
/// selectable and its own group is how a person reaches it again.
library;

import 'package:flutter/gestures.dart' show kTouchSlop;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_slidable/flutter_slidable.dart';

import '../flock/avatar.dart';
import '../protocol/client_wire.generated.dart' as wire;
import '../theme/frock_theme.dart';
import '../update/desktop_update.dart';
import 'chat_icons.dart';
import 'desktop_layout.dart';
import 'focus.dart';
import 'person_avatar.dart';
import 'semantics.dart';
import 'sidebar_order.dart';

/// The mutable half of a Bot's identity, as the sidebar reads it.
class SidebarProfile {
  final String? name;
  final String? title;
  final String? label;
  final String? pinnedAt;
  final bool hiddenFromSidebar;

  /// Where the Bot sits among the Bots of its label, lower first. Absent
  /// puts it after every Bot that has one, in the order the directory lists.
  final int? sidebarOrder;
  const SidebarProfile({
    this.name,
    this.title,
    this.label,
    this.pinnedAt,
    this.hiddenFromSidebar = false,
    this.sidebarOrder,
  });

  static SidebarProfile? decode(Object? value) {
    if (value is! Map) return null;
    final order = value['sidebarOrder'];
    return SidebarProfile(
      name: value['name'] as String?,
      title: value['title'] as String?,
      label: value['label'] as String?,
      pinnedAt: value['pinnedAt'] as String?,
      hiddenFromSidebar: value['hiddenFromSidebar'] == true,
      sidebarOrder: order is num ? order.toInt() : null,
    );
  }

  /// This profile with a `bot/set-profile` patch drawn over it: what the
  /// sidebar shows while the command is on its way. The empty string clears
  /// a text field, the way the authority reads it.
  SidebarProfile patched(Map<String, Object?> patch) => SidebarProfile(
    name: patch.containsKey('name') ? patch['name'] as String? : name,
    title: patch.containsKey('title') ? patch['title'] as String? : title,
    label: patch.containsKey('label') ? patch['label'] as String? : label,
    pinnedAt: patch.containsKey('pinnedAt')
        ? patch['pinnedAt'] as String?
        : pinnedAt,
    hiddenFromSidebar: patch.containsKey('hiddenFromSidebar')
        ? patch['hiddenFromSidebar'] == true
        : hiddenFromSidebar,
    sidebarOrder: patch.containsKey('sidebarOrder')
        ? (patch['sidebarOrder'] as num?)?.toInt()
        : sidebarOrder,
  );
}

/// The Bots of one group in the order the sidebar draws them: by
/// `sidebarOrder`, lowest first, with the Bots that have none after them in
/// the order they arrived. Stable, so two equal numbers keep directory order.
List<T> orderSidebarBots<T>(
  List<T> bots,
  String Function(T) idOf,
  Map<String, SidebarProfile> profiles,
) {
  final placed = [
    for (var index = 0; index < bots.length; index++)
      (
        bot: bots[index],
        order: profiles[idOf(bots[index])]?.sidebarOrder,
        index: index,
      ),
  ];
  placed.sort((left, right) {
    final l = left.order;
    final r = right.order;
    if (l == null && r == null) return left.index - right.index;
    if (l == null) return 1;
    if (r == null) return -1;
    return l != r ? l.compareTo(r) : left.index - right.index;
  });
  return [for (final entry in placed) entry.bot];
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
  List<T> ordered(List<T> group) => orderSidebarBots(group, idOf, profiles);
  if (labelled.isEmpty) {
    return GroupedSidebarBots(false, [
      SidebarBotGroup('all', '', ordered(bots)),
    ]);
  }
  return GroupedSidebarBots(true, [
    for (final group in labelled.values)
      SidebarBotGroup(group.key, group.label, ordered(group.bots)),
    if (unassigned.isNotEmpty)
      SidebarBotGroup('unassigned', 'Unassigned', ordered(unassigned)),
  ]);
}

/// The label a drop into [group] writes: the group's own spelling, or the
/// empty string for Unassigned and for the plain list.
String sidebarGroupDropLabel<T>(SidebarBotGroup<T> group) =>
    group.key.startsWith('label:') ? group.label : '';

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

  /// The person's face on the You control: Google photo, or initials.
  final String? profileName;
  final String? profileImageUrl;

  /// Opens the Marketplace: the services a Bot can be given, and the accounts
  /// already on them. Where it is drawn depends on [phone].
  final VoidCallback onMarketplace;

  /// Whether this list is a phone's whole screen. There the Marketplace is a
  /// control in the header beside the account, because the foot of a
  /// full-height list is the last place a thumb reaches; on a wider layout
  /// the column has a foot, and the Marketplace is a named row on it.
  final bool phone;

  final VoidCallback onToggleHidden;
  final Future<void> Function() onRetry;

  /// Opens the Bot's quick actions; [position] is where a secondary click
  /// landed, and null when a press or the row's control asked instead.
  final void Function(String botId, {Offset? position})? onActions;

  /// A phone's swipe towards the trailing edge: mark read, or unread when
  /// there is nothing unread.
  final void Function(String botId)? onSwipeRead;

  /// A phone's swipe towards the leading edge, then the button it reveals.
  final void Function(String botId)? onSwipeHide;

  /// A row dragged and let go over the list: above or below another row, or
  /// on a group's heading. Reordering and moving between labels are the one
  /// gesture; a pointer drags a row outright, a finger holds it first. Null
  /// leaves the rows where they are.
  final void Function(SidebarDrop drop)? onMove;
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
    required this.onToggleHidden,
    required this.onRetry,
    this.onActions,
    this.onSwipeRead,
    this.onSwipeHide,
    this.onMove,
    this.phone = false,
    this.error,
    this.profileName,
    this.profileImageUrl,
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
    // A phone's rows are cards a shade lighter than the ground they sit on,
    // so the thing a thumb slides is a thing and not a stripe of the page.
    // The ground itself is the app's page surface: the list does not get a
    // lighter backdrop than every other screen just to frame its own rows.
    final ground = phone ? sidebarGroundColor(theme.colorScheme) : null;
    final column = Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _Header(
          onCreateBot: onCreateBot,
          onSearch: phone ? onSearch : null,
          onProfile: onProfile,
          profileName: profileName,
          profileImageUrl: profileImageUrl,
          onMarketplace: phone ? onMarketplace : null,
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
                          size: chatIconSize,
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
          // One row is slid open at a time: opening a second closes the
          // first, and a scroll closes whichever it was.
          child: SlidableAutoCloseBehavior(
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
                                background: bot.avatar.characterId,
                                primary: bot.avatar.primary,
                                active: _id(bot) == activeBotId,
                                unread: _unread(_id(bot)).unread,
                                working: _working(bot),
                                onTap: () => onSelect(_id(bot)),
                                onActions: onActions == null
                                    ? null
                                    : ({Offset? position}) => onActions!(
                                        _id(bot),
                                        position: position,
                                      ),
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
                            _HeadingTarget(
                              label: sidebarGroupDropLabel(group),
                              groupIds: [
                                for (final bot in group.bots) _id(bot),
                              ],
                              onMove: onMove,
                              child: Padding(
                                padding: const EdgeInsets.fromLTRB(
                                  20,
                                  14,
                                  16,
                                  4,
                                ),
                                child: Text(
                                  group.label.toUpperCase(),
                                  style: theme.textTheme.labelSmall?.copyWith(
                                    color: theme.colorScheme.onSurfaceVariant
                                        .withValues(alpha: 0.85),
                                  ),
                                ),
                              ),
                            ),
                          for (final bot in group.bots)
                            _row(context, bot, group: group),
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
                              foregroundColor:
                                  theme.colorScheme.onSurfaceVariant,
                              minimumSize: const Size(0, 32),
                              padding: const EdgeInsets.symmetric(
                                horizontal: 8,
                              ),
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
        ),
        if (!phone) _Foot(onMarketplace: onMarketplace),
      ],
    );
    return ground == null ? column : ColoredBox(color: ground, child: column);
  }

  /// One row. In a [group] it can be dragged to another place or another
  /// group, and is where another row can be dropped; a hidden Bot's row is
  /// outside every group, so it is neither.
  Widget _row(
    BuildContext context,
    wire.BotRegistration bot, {
    SidebarBotGroup<wire.BotRegistration>? group,
  }) {
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
    final actions = onActions == null
        ? null
        : ({Offset? position}) => onActions!(botId, position: position);
    final move = onMove;
    // A finger holds a row to lift it, which is the press that used to open
    // the actions; letting go without having moved still opens them, so the
    // hold keeps both meanings.
    final touchDrag =
        move != null &&
        group != null &&
        !isArchived &&
        sidebarDragIsHeld(context);
    final row = _BotRow(
      key: ValueKey('bot-$botId'),
      identifier: ShellIds.sidebarBot(botId),
      card: phone,
      selected: selected,
      enabled: !isArchived,
      onTap: isArchived ? null : () => onSelect(botId),
      onActions: actions,
      longPressOpens: !touchDrag,
      // A phone reaches the actions by pressing the row, and so may any
      // touch screen; a pointer has the control and the secondary click.
      control: !phone && actions != null
          ? identified(
              BotActionIds.menu(botId),
              _RowControl(onPressed: (at) => actions(position: at)),
            )
          : null,
      // The character is drawn larger than the slot it is laid out in: the
      // row's two lines of text set its height, and a character the size of
      // the text column looked lost beside it. The artboard's picture has
      // room around the figure, so the overflow spills into the row's own
      // padding rather than onto the rows above and below.
      avatar: SizedBox.square(
        dimension: sidebarRowAvatarSlot,
        child: OverflowBox(
          maxWidth: sidebarRowAvatarSize,
          maxHeight: sidebarRowAvatarSize,
          child: CharacterAvatar(
            size: sidebarRowAvatarSize,
            characterId: bot.avatar.characterId,
            primary: bot.avatar.primary,
            motion: CharacterMotion.quiet,
            activity: _working(bot)
                ? CharacterActivity.working
                : CharacterActivity.idle,
            working: _working(bot),
          ),
        ),
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
    );
    // An archived Bot has stopped: it is not dragged about, though the rows
    // around it still are, so it stays a place another row can land beside.
    final Widget lifted = move == null || group == null || isArchived
        ? row
        : _DragSource(
            botId: botId,
            held: touchDrag,
            onHeldInPlace: actions == null ? null : () => actions(),
            ghost: _DragGhost(
              card: phone,
              name: _name(bot),
              characterId: bot.avatar.characterId,
              primary: bot.avatar.primary,
            ),
            child: row,
          );
    final Widget swiped = _swipeRow(bot, lifted, isArchived, isUnread, view);
    if (move == null || group == null) return swiped;
    return _RowDropTarget(
      key: ValueKey('drop-$botId'),
      botId: botId,
      label: sidebarGroupDropLabel(group),
      groupIds: [for (final member in group.bots) _id(member)],
      onMove: move,
      child: swiped,
    );
  }

  /// A phone's row slides to mark read or to reveal Hide; a desk's does not.
  Widget _swipeRow(
    wire.BotRegistration bot,
    Widget row,
    bool isArchived,
    bool isUnread,
    wire.UnreadView? view,
  ) {
    final botId = _id(bot);
    // An archived Bot has stopped: nothing to read, nothing worth hiding.
    if (!phone || isArchived) return row;
    final read = onSwipeRead;
    final hide = onSwipeHide;
    final onRead = read == null || view?.lastActivityCursor == null
        ? null
        : () => read(botId);
    final onHide = hide == null || _hidden(bot) ? null : () => hide(botId);
    if (onRead == null && onHide == null) return row;
    return _SwipeRow(
      key: ValueKey('swipe-$botId'),
      botId: botId,
      unread: isUnread,
      onRead: onRead,
      onHide: onHide,
      child: row,
    );
  }
}

/// Whether a row must be held before it lifts: on a touch platform a drag
/// that starts at once would be a scroll, so the row waits for a long press,
/// the way `ReorderableListView` does; a pointer lifts the row outright.
bool sidebarDragIsHeld(BuildContext context) =>
    switch (Theme.of(context).platform) {
      TargetPlatform.android ||
      TargetPlatform.iOS ||
      TargetPlatform.fuchsia => true,
      TargetPlatform.macOS ||
      TargetPlatform.windows ||
      TargetPlatform.linux => false,
    };

/// The strip a drop draws where the row would land.
const double _dropLineHeight = 2;

/// A row in the air: the face and the name on a raised card, narrower than
/// the row so the list beneath it stays legible.
class _DragGhost extends StatelessWidget {
  /// Whether the rows this floats over are cards, a phone's. It decides
  /// which plane the ghost has to clear to read as held in the air.
  final bool card;
  final String name;
  final String characterId;
  final String primary;
  const _DragGhost({
    required this.card,
    required this.name,
    required this.characterId,
    required this.primary,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    // Anchored at the pointer, so the drop target reads the pointer itself;
    // drawn a little up and left of it, the way a picked-up card sits under
    // a fingertip rather than hanging from it.
    return Transform.translate(
      offset: const Offset(-24, -26),
      child: Material(
        elevation: 6,
        color: card
            ? sidebarDragGhostColor(theme.colorScheme)
            : theme.colorScheme.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(10),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(10, 8, 16, 8),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              CharacterAvatar(
                size: 28,
                characterId: characterId,
                primary: primary,
                motion: CharacterMotion.quiet,
              ),
              const SizedBox(width: 10),
              ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 180),
                child: Text(
                  name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.bodyMedium?.copyWith(
                    fontWeight: FontWeight.w600,
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

/// What lifts a row. [held] waits for a long press first; otherwise the row
/// lifts as soon as the pointer moves.
///
/// A held row let go where it was lifted is the press it used to be, so
/// [onHeldInPlace] opens the actions the long press opened before rows could
/// be moved. A row let go anywhere else, over nothing, just settles back.
class _DragSource extends StatefulWidget {
  final String botId;
  final bool held;
  final VoidCallback? onHeldInPlace;
  final Widget ghost;
  final Widget child;
  const _DragSource({
    required this.botId,
    required this.held,
    required this.onHeldInPlace,
    required this.ghost,
    required this.child,
  });

  @override
  State<_DragSource> createState() => _DragSourceState();
}

class _DragSourceState extends State<_DragSource> {
  double _travelled = 0;

  void _update(DragUpdateDetails details) {
    _travelled += details.delta.distance;
  }

  void _ended(DraggableDetails details) {
    final stayed = _travelled < kTouchSlop;
    _travelled = 0;
    if (!details.wasAccepted && stayed) widget.onHeldInPlace?.call();
  }

  @override
  Widget build(BuildContext context) {
    final faded = Opacity(opacity: 0.35, child: widget.child);
    if (widget.held) {
      return LongPressDraggable<String>(
        data: widget.botId,
        dragAnchorStrategy: pointerDragAnchorStrategy,
        feedback: widget.ghost,
        childWhenDragging: faded,
        onDragStarted: () => _travelled = 0,
        onDragUpdate: _update,
        onDragEnd: _ended,
        child: widget.child,
      );
    }
    return Draggable<String>(
      data: widget.botId,
      axis: Axis.vertical,
      dragAnchorStrategy: pointerDragAnchorStrategy,
      feedback: widget.ghost,
      childWhenDragging: faded,
      child: widget.child,
    );
  }
}

/// Where a lifted row can land beside another: its upper half means above
/// that row, its lower half below. The line says which before letting go.
class _RowDropTarget extends StatefulWidget {
  final String botId;
  final String label;
  final List<String> groupIds;
  final void Function(SidebarDrop drop) onMove;
  final Widget child;
  const _RowDropTarget({
    super.key,
    required this.botId,
    required this.label,
    required this.groupIds,
    required this.onMove,
    required this.child,
  });

  @override
  State<_RowDropTarget> createState() => _RowDropTargetState();
}

class _RowDropTargetState extends State<_RowDropTarget> {
  /// Null while nothing hovers; otherwise whether it hovers the lower half.
  bool? _below;

  bool _lowerHalf(Offset global) {
    final box = context.findRenderObject();
    if (box is! RenderBox || !box.hasSize) return false;
    return box.globalToLocal(global).dy > box.size.height / 2;
  }

  /// The row a drop below this one lands above: the next in the group that
  /// is not the row in the air, or nothing at the group's end.
  String? _after(String dragged) {
    final ids = widget.groupIds;
    for (
      var index = ids.indexOf(widget.botId) + 1;
      index < ids.length;
      index++
    ) {
      if (ids[index] != dragged) return ids[index];
    }
    return null;
  }

  @override
  Widget build(BuildContext context) => DragTarget<String>(
    onWillAcceptWithDetails: (details) => details.data != widget.botId,
    onMove: (details) {
      if (details.data == widget.botId) return;
      final below = _lowerHalf(details.offset);
      if (below != _below) setState(() => _below = below);
    },
    onLeave: (_) {
      if (_below != null) setState(() => _below = null);
    },
    onAcceptWithDetails: (details) {
      final below = _lowerHalf(details.offset);
      setState(() => _below = null);
      widget.onMove(
        SidebarDrop(
          botId: details.data,
          label: widget.label,
          beforeBotId: below ? _after(details.data) : widget.botId,
          group: widget.groupIds,
        ),
      );
    },
    builder: (context, candidates, rejected) => Stack(
      children: [
        widget.child,
        if (_below case final bool below)
          Positioned(
            left: 16,
            right: 16,
            top: below ? null : 0,
            bottom: below ? 0 : null,
            child: const _DropLine(),
          ),
      ],
    ),
  );
}

/// A group's heading as a place to land: the row goes to the top of that
/// group, and into its label.
class _HeadingTarget extends StatefulWidget {
  final String label;
  final List<String> groupIds;
  final void Function(SidebarDrop drop)? onMove;
  final Widget child;
  const _HeadingTarget({
    required this.label,
    required this.groupIds,
    required this.onMove,
    required this.child,
  });

  @override
  State<_HeadingTarget> createState() => _HeadingTargetState();
}

class _HeadingTargetState extends State<_HeadingTarget> {
  bool _over = false;

  @override
  Widget build(BuildContext context) {
    final move = widget.onMove;
    if (move == null) return widget.child;
    return DragTarget<String>(
      onWillAcceptWithDetails: (_) => true,
      onMove: (_) {
        if (!_over) setState(() => _over = true);
      },
      onLeave: (_) {
        if (_over) setState(() => _over = false);
      },
      onAcceptWithDetails: (details) {
        setState(() => _over = false);
        final first = widget.groupIds
            .where((id) => id != details.data)
            .firstOrNull;
        move(
          SidebarDrop(
            botId: details.data,
            label: widget.label,
            beforeBotId: first,
            group: widget.groupIds,
          ),
        );
      },
      builder: (context, candidates, rejected) => Stack(
        children: [
          widget.child,
          if (_over)
            const Positioned(
              left: 16,
              right: 16,
              bottom: 0,
              child: _DropLine(),
            ),
        ],
      ),
    );
  }
}

class _DropLine extends StatelessWidget {
  const _DropLine();

  @override
  Widget build(BuildContext context) => IgnorePointer(
    child: Container(
      height: _dropLineHeight,
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.primary,
        borderRadius: BorderRadius.circular(1),
      ),
    ),
  );
}

/// The control a desktop row grows under the pointer and on focus: one quiet
/// glyph where the time was, because a row that carried a button on every
/// line would read as a toolbar.
class _RowControl extends StatelessWidget {
  final void Function(Offset at) onPressed;
  const _RowControl({required this.onPressed});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return SizedBox(
      width: 24,
      height: 20,
      child: IconButton(
        onPressed: () {
          final box = context.findRenderObject()! as RenderBox;
          onPressed(box.localToGlobal(box.size.bottomLeft(Offset.zero)));
        },
        tooltip: 'Bot actions',
        padding: EdgeInsets.zero,
        iconSize: 18,
        constraints: const BoxConstraints(),
        style: IconButton.styleFrom(
          foregroundColor: scheme.onSurfaceVariant,
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        ),
        icon: const Icon(Icons.more_horiz_rounded),
      ),
    );
  }
}

/// A phone list's ground: the app's own page surface, unlightened. The list
/// is a page like every other page here, so it is the rows that are told
/// apart from it rather than the page that is told apart from the app.
Color sidebarGroundColor(ColorScheme scheme) => scheme.surface;

/// A phone list's row: the surface, a shade lighter than the ground, so what
/// a thumb slides is visibly the thing that moves — lifted off the page the
/// way a card is, not cut out of it.
Color sidebarCardColor(ColorScheme scheme) =>
    Color.alphaBlend(Colors.white.withValues(alpha: 0.07), scheme.surface);

/// A row picked up off a phone's list: the one plane above the card, so a
/// dragged Bot reads as held in the air over its neighbours. It has to stay
/// lighter than the card, or the thing in hand looks pressed into the page
/// instead. A desk's rows are not cards but lines on the plain ground, so a
/// ghost there is already above what it floats over at the M3 role it has
/// always used and keeps.
Color sidebarDragGhostColor(ColorScheme scheme) =>
    Color.alphaBlend(Colors.white.withValues(alpha: 0.14), scheme.surface);

/// What a swipe reveals under the row: the page, recessed, so the track the
/// pill slides along reads as below it and never as another card.
Color sidebarSwipeTrackColor(ColorScheme scheme) =>
    Color.alphaBlend(Colors.black.withValues(alpha: 0.22), scheme.surface);

/// How far, as a share of the row's width, a swipe towards the trailing edge
/// travels before letting go marks the Bot read. Far enough that a scroll that
/// wandered sideways never fires it; near enough that a deliberate swipe
/// need not cross the screen.
const sidebarSwipeReadFraction = 0.34;

/// How far, as a share of the row's width, a swipe towards the leading edge
/// travels before letting go hides the Bot outright, the way Mail's long
/// swipe archives. Short of it the swipe only reveals the button.
const sidebarSwipeHideFraction = 0.6;

/// The share of the row the Hide button takes when the swipe rests on it.
const sidebarSwipeRevealFraction = 0.22;

/// The share of the row the read mark takes when the swipe rests on it. A
/// touch wider than the Hide button, because 'Unread' is the longer word.
const sidebarSwipeReadRevealFraction = 0.26;

/// The square a Bot row lays its character out in; the row's height comes
/// from its text, and this keeps the avatar from adding to it.
const double sidebarRowAvatarSlot = 36;

/// How large the character is actually drawn in that slot. It overflows the
/// slot by seven points a side, inside the row's eight points of padding.
const double sidebarRowAvatarSize = 50;

/// The inset a phone's row sits at inside the list, and the radius of its
/// corners. The row's own card, its ink and the clip the swipe panes slide
/// behind all take these, so what slides is exactly the pill that moves.
const sidebarCardInset = EdgeInsets.fromLTRB(8, 2, 8, 2);
const sidebarCardRadius = Radius.circular(10);

/// A phone's row, and the two things a thumb can do to it without opening it.
///
/// Both are the swipe rows have on a phone since Mail had them, and the
/// package that carries that behaviour for Flutter carries it here: the
/// action slides in with the row and stretches as the swipe goes on. Towards
/// the trailing edge, letting go past a third of the row marks the Bot, and
/// the row springs back, because marking read removes nothing. Towards the
/// leading edge, a short swipe rests on a Hide button for a tap; a long
/// swipe, past most of the row, hides without the tap, and the button says so
/// by changing colour before the finger lets go. Crossing either line ticks
/// under the thumb.
class _SwipeRow extends StatelessWidget {
  final String botId;
  final bool unread;

  /// Null where the side has nothing to do: no cursor to mark up to, or a
  /// Bot already hidden. That side then does not slide at all.
  final VoidCallback? onRead;
  final VoidCallback? onHide;
  final Widget child;
  const _SwipeRow({
    super.key,
    required this.botId,
    required this.unread,
    this.onRead,
    this.onHide,
    required this.child,
  });

  @override
  Widget build(BuildContext context) {
    final onRead = this.onRead;
    final onHide = this.onHide;
    return ClipRRect(
      clipper: const _RowShape(),
      child: Slidable(
        key: ValueKey('slidable-$botId'),
        groupTag: 'bots',
        startActionPane: onRead == null
            ? null
            : ActionPane(
                motion: const StretchMotion(),
                extentRatio: sidebarSwipeReadRevealFraction,
                dismissible: DismissiblePane(
                  dismissThreshold: sidebarSwipeReadFraction,
                  closeOnCancel: true,
                  // The full swipe performs the action and keeps the row:
                  // the veto is what brings it back.
                  confirmDismiss: () async {
                    HapticFeedback.lightImpact();
                    onRead();
                    return false;
                  },
                  onDismissed: () {},
                ),
                children: [
                  _SwipeAction(
                    icon: unread
                        ? Icons.mark_chat_read_outlined
                        : Icons.mark_chat_unread_outlined,
                    label: unread ? 'Read' : 'Unread',
                    threshold: sidebarSwipeReadFraction,
                    accent: true,
                    onPressed: onRead,
                    alignment: AlignmentDirectional.centerEnd,
                    padding: const EdgeInsetsDirectional.only(
                      start: 8,
                      end: 18,
                    ),
                  ),
                ],
              ),
        endActionPane: onHide == null
            ? null
            : ActionPane(
                motion: const StretchMotion(),
                extentRatio: sidebarSwipeRevealFraction,
                dismissible: DismissiblePane(
                  dismissThreshold: sidebarSwipeHideFraction,
                  onDismissed: () {
                    HapticFeedback.mediumImpact();
                    onHide();
                  },
                ),
                children: [
                  _SwipeAction(
                    identifier: BotActionIds.swipeHide(botId),
                    icon: Icons.visibility_off_outlined,
                    label: 'Hide',
                    threshold: sidebarSwipeHideFraction,
                    accent: false,
                    onPressed: onHide,
                    alignment: AlignmentDirectional.centerEnd,
                    padding: const EdgeInsetsDirectional.only(
                      start: 8,
                      end: 18,
                    ),
                  ),
                ],
              ),
        child: child,
      ),
    );
  }
}

/// One swipe action: its glyph and word anchored at the row's outer edge
/// while the pane stretches behind them, quiet until the swipe crosses
/// [threshold] — the line past which letting go performs it — and the
/// accent from there, with a tick under the thumb on the way over.
class _SwipeAction extends StatefulWidget {
  /// The name the browser specs select on, where one does.
  final String? identifier;
  final IconData icon;
  final String label;
  final double threshold;

  /// Whether the pane wears the accent from the start (the read mark) or
  /// only once the swipe means it (Hide, which removes the row).
  final bool accent;
  final VoidCallback onPressed;
  final AlignmentGeometry alignment;
  final EdgeInsetsGeometry padding;
  const _SwipeAction({
    this.identifier,
    required this.icon,
    required this.label,
    required this.threshold,
    required this.accent,
    required this.onPressed,
    required this.alignment,
    required this.padding,
  });

  @override
  State<_SwipeAction> createState() => _SwipeActionState();
}

class _SwipeActionState extends State<_SwipeAction> {
  SlidableController? _controller;
  bool _past = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final controller = Slidable.of(context);
    if (controller != _controller) {
      _controller?.animation.removeListener(_moved);
      _controller = controller;
      _controller?.animation.addListener(_moved);
    }
  }

  @override
  void dispose() {
    _controller?.animation.removeListener(_moved);
    super.dispose();
  }

  void _moved() {
    final past = (_controller?.ratio.abs() ?? 0) >= widget.threshold;
    if (past == _past) return;
    _past = past;
    if (past) HapticFeedback.selectionClick();
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final lit = widget.accent || _past;
    final ink = lit ? scheme.primary : scheme.onSurfaceVariant;
    // The pane lays its actions out as a Flex, so this stays its direct
    // child and the name goes inside.
    final identifier = widget.identifier;
    Widget named(Widget child) =>
        identifier == null ? child : identified(identifier, child);
    return Expanded(
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 160),
        curve: Curves.easeOut,
        color: lit
            ? scheme.primary.withValues(alpha: _past ? 0.28 : 0.16)
            : sidebarSwipeTrackColor(scheme),
        child: named(
          Material(
            type: MaterialType.transparency,
            child: InkWell(
              onTap: () {
                _controller?.close();
                widget.onPressed();
              },
              child: Align(
                alignment: widget.alignment,
                child: Padding(
                  padding: widget.padding,
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(widget.icon, size: 20, color: ink),
                      const SizedBox(height: 3),
                      Text(
                        widget.label,
                        softWrap: false,
                        style: theme.textTheme.labelSmall?.copyWith(
                          color: ink,
                          fontWeight: _past ? FontWeight.w600 : FontWeight.w500,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// The row's own pill, taken from [sidebarCardInset] and
/// [sidebarCardRadius] so it cannot drift from the card it clips to.
class _RowShape extends CustomClipper<RRect> {
  const _RowShape();

  @override
  RRect getClip(Size size) => RRect.fromRectAndRadius(
    Rect.fromLTWH(
      sidebarCardInset.left,
      sidebarCardInset.top,
      size.width - sidebarCardInset.horizontal,
      size.height - sidebarCardInset.vertical,
    ),
    sidebarCardRadius,
  );

  @override
  bool shouldReclip(_RowShape oldClipper) => false;
}

/// One Bot in the list: the face, the name and the last thing said, in a row
/// no taller than it has to be. The selected tint is inset from the column's
/// edges so the list reads as a list and not as a table.
class _BotRow extends StatefulWidget {
  /// The row's own identifier, on its button node alone: were the control a
  /// child of that node, the engine would carry the row's text as a label
  /// rather than as text.
  final String identifier;

  /// Whether the row is a card lifted off the page, a phone's, or a line in
  /// a column, a desktop's.
  final bool card;
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

  /// The quick actions, by a long press anywhere and a secondary click at
  /// the pointer.
  final void Function({Offset? position})? onActions;

  /// A control that takes the time's place while the pointer is over the row
  /// or the row has focus; null where a press is how the actions are reached.
  final Widget? control;

  /// Off where a long press lifts the row instead; the lift opens the
  /// actions itself when the row is let go where it was.
  final bool longPressOpens;
  const _BotRow({
    super.key,
    required this.identifier,
    this.card = false,
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
    this.onActions,
    this.control,
    this.longPressOpens = true,
  });

  @override
  State<_BotRow> createState() => _BotRowState();
}

class _BotRowState extends State<_BotRow> {
  bool _hovered = false;
  bool _focused = false;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final selected = widget.selected;
    final enabled = widget.enabled;
    final onActions = widget.onActions;
    final time = widget.time;
    final trailing = widget.trailing;
    final showControl = widget.control != null && (_hovered || _focused);
    final row = Semantics(
      container: true,
      identifier: widget.identifier,
      selected: selected,
      button: enabled,
      child: Material(
        color: widget.card
            ? sidebarCardColor(theme.colorScheme)
            : selected
            ? theme.colorScheme.onSurface.withValues(alpha: 0.06)
            : Colors.transparent,
        borderRadius: const BorderRadius.all(sidebarCardRadius),
        child: InkWell(
          onTap: widget.onTap,
          onLongPress: onActions == null || !widget.longPressOpens
              ? null
              : () => onActions(),
          onSecondaryTapUp: onActions == null
              ? null
              : (details) => onActions(position: details.globalPosition),
          borderRadius: const BorderRadius.all(sidebarCardRadius),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(10, 8, 12, 8),
            child: Opacity(
              opacity: enabled ? 1 : 0.6,
              child: Row(
                children: [
                  widget.avatar,
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
                                widget.name,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: widget.nameStyle,
                              ),
                            ),
                            // The control itself sits over this space,
                            // beside the row's node rather than inside it.
                            if (showControl)
                              const SizedBox(width: 8 + 24)
                            else if (time case final String stamp) ...[
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
                                widget.preview,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: widget.previewStyle,
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
    );
    return Padding(
      padding: widget.card
          ? sidebarCardInset
          : const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      // Hover and focus are the row's and its control's together, so moving
      // onto the control or tabbing to it keeps it on screen.
      child: MouseRegion(
        onEnter: (_) => setState(() => _hovered = true),
        onExit: (_) => setState(() => _hovered = false),
        child: CharacterHoverScope(
          hovered: _hovered,
          child: Focus(
            canRequestFocus: false,
            skipTraversal: true,
            onFocusChange: (has) => setState(() => _focused = has),
            child: Stack(
              children: [
                row,
                if (showControl)
                  Positioned(top: 8, right: 12, child: widget.control!),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The list's own controls, GrokBot's: you, search, and a new Bot — and on a
/// phone, the Marketplace beside you.
///
/// Voice is not here: a call addresses one Bot, so it is started from that
/// Bot's composer and nowhere else (ADR 0029).
///
/// Everything about the account is behind the first one; everything about one
/// Bot is on that Bot's page. The list itself carries no title — the rows say
/// what it is.
class _Header extends StatelessWidget {
  final VoidCallback onCreateBot;
  final VoidCallback? onSearch;
  final VoidCallback onProfile;
  final String? profileName;
  final String? profileImageUrl;

  /// The Marketplace, where the header is the place for it; null where the
  /// column's foot names it instead.
  final VoidCallback? onMarketplace;

  const _Header({
    required this.onCreateBot,
    required this.onSearch,
    required this.onProfile,
    this.profileName,
    this.profileImageUrl,
    this.onMarketplace,
  });

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final desktopUpdates = DesktopUpdateScope.maybeOf(context);
    // Quiet controls: a glyph and nothing round it until it is pressed. The
    // one exception is the new-Bot button, which is the row's one invitation
    // and wears the accent.
    final quiet = IconButton.styleFrom(
      foregroundColor: scheme.onSurfaceVariant,
      minimumSize: Size.square(chatControlExtent),
      fixedSize: Size.square(chatControlExtent),
      padding: EdgeInsets.zero,
      iconSize: chatIconSize,
      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(9)),
    );
    final active = quiet.copyWith(
      foregroundColor: WidgetStatePropertyAll(scheme.primary),
      backgroundColor: WidgetStatePropertyAll(
        scheme.primary.withValues(alpha: 0.14),
      ),
    );
    return DesktopWindowDragRegion(
      child: Padding(
        padding: EdgeInsets.fromLTRB(
          12,
          desktopTitleBarless ? desktopSidebarTrafficLightClearance : 10,
          10,
          desktopTitleBarless ? 10 : 6,
        ),
        child: Row(
          children: [
            identified(
              ShellIds.sidebarProfile,
              IconButton(
                tooltip: 'You',
                onPressed: onProfile,
                style: quiet,
                icon: PersonAvatar(
                  name: profileName?.trim().isNotEmpty == true
                      ? profileName!
                      : 'You',
                  imageUrl: profileImageUrl,
                  size: 32,
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
            // A desktop app replaces itself to update, and says so beside the
            // account; the row's slack is where it speaks, and it draws nothing
            // while there is nothing to do.
            Expanded(
              child: Align(
                alignment: Alignment.centerLeft,
                child: desktopUpdates == null
                    ? const SizedBox.shrink()
                    : Padding(
                        padding: const EdgeInsets.only(left: 6, right: 4),
                        child: DesktopUpdateButton(controller: desktopUpdates),
                      ),
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
                tooltip: 'Add a Bot',
                onPressed: onCreateBot,
                style: active,
                icon: const Icon(Icons.add_rounded),
              ),
            ),
          ],
        ),
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
                      size: chatIconSize,
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                    const SizedBox(width: 11),
                    Expanded(
                      child: Text(
                        'Marketplace',
                        // The foot is a door, not a heading: normal weight,
                        // the same as the words in the list above it.
                        style: theme.textTheme.bodyMedium?.copyWith(
                          fontWeight: FontWeight.w400,
                          letterSpacing: -0.1,
                        ),
                      ),
                    ),
                    Icon(
                      Icons.chevron_right_rounded,
                      size: 20,
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

class _PinnedTile extends StatefulWidget {
  final String name;
  final String background;
  final String primary;
  final bool active;
  final bool unread;
  final bool working;
  final VoidCallback onTap;
  final void Function({Offset? position})? onActions;
  const _PinnedTile({
    required this.name,
    required this.background,
    required this.primary,
    required this.active,
    required this.unread,
    required this.working,
    required this.onTap,
    this.onActions,
  });

  @override
  State<_PinnedTile> createState() => _PinnedTileState();
}

class _PinnedTileState extends State<_PinnedTile> {
  bool hovered = false;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return MouseRegion(
      onEnter: (_) => setState(() => hovered = true),
      onExit: (_) => setState(() => hovered = false),
      child: CharacterHoverScope(
        hovered: hovered,
        child: Material(
          color: widget.active
              ? theme.colorScheme.onSurface.withValues(alpha: 0.06)
              : Colors.transparent,
          borderRadius: BorderRadius.circular(10),
          child: InkWell(
            onTap: widget.onTap,
            onLongPress: widget.onActions == null
                ? null
                : () => widget.onActions!(),
            onSecondaryTapUp: widget.onActions == null
                ? null
                : (details) =>
                      widget.onActions!(position: details.globalPosition),
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
                      CharacterAvatar(
                        size: 40,
                        characterId: widget.background,
                        primary: widget.primary,
                        motion: CharacterMotion.quiet,
                        activity: widget.working
                            ? CharacterActivity.working
                            : CharacterActivity.idle,
                        working: widget.working,
                      ),
                      if (widget.unread)
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
                    widget.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.bodySmall?.copyWith(
                      fontSize: 11.5,
                      fontWeight: widget.unread
                          ? FontWeight.w600
                          : FontWeight.w500,
                      color: theme.colorScheme.onSurface.withValues(
                        alpha: widget.unread ? 1 : 0.85,
                      ),
                    ),
                  ),
                ],
              ),
            ),
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
      'No Bots yet. Add your first Bot.',
      style: Theme.of(context).textTheme.bodyMedium
          ?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant),
    ),
  );
}
