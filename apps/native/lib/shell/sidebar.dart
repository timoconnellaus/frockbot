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
import 'semantics.dart';

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

/// How many unread a badge says, or nothing where the row shows no badge.
String? unreadBadgeLabel(wire.UnreadView? view) {
  if (view == null || !view.unread) return null;
  if (view.count == 0) return view.manuallyUnread ? "•" : null;
  return view.capped ? '${view.count}+' : '${view.count}';
}

// ------------------------------------------------------------ the widget

class ShellSidebar extends StatelessWidget {
  final List<wire.BotRegistration> bots;
  final Map<String, SidebarProfile> profiles;
  final Map<String, wire.UnreadView> unread;
  final Set<String> archived;
  final String? activeBotId;

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

  /// Whether a call is live, which is what the control's pressed state says.
  final bool voiceActive;
  final VoidCallback onToggleHidden;
  final Future<void> Function() onRetry;
  const ShellSidebar({
    super.key,
    required this.bots,
    required this.profiles,
    required this.unread,
    required this.archived,
    required this.activeBotId,
    required this.workingBotId,
    required this.loaded,
    required this.showHidden,
    required this.onSelect,
    required this.onCreateBot,
    required this.onSearch,
    required this.onProfile,
    required this.onMarketplace,
    required this.onVoice,
    required this.voiceActive,
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
      (total, bot) => total + (unread[_id(bot)]?.count ?? 0),
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _Header(
          onCreateBot: onCreateBot,
          onSearch: onSearch,
          onProfile: onProfile,
          onMarketplace: phone ? onMarketplace : null,
          onVoice: onVoice,
          voiceActive: voiceActive,
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
                    padding: const EdgeInsets.fromLTRB(12, 8, 12, 4),
                    child: Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      children: [
                        for (final bot in partitioned.pinned)
                          identified(
                            ShellIds.sidebarPinned(_id(bot)),
                            _PinnedTile(
                              name: _name(bot),
                              background: bot.sheep.background,
                              active: _id(bot) == activeBotId,
                              unread: unread[_id(bot)]?.unread == true,
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
                            padding: const EdgeInsets.fromLTRB(16, 14, 16, 4),
                            child: Text(
                              group.label.toUpperCase(),
                              style: theme.textTheme.labelSmall?.copyWith(
                                color: theme.colorScheme.onSurfaceVariant,
                                letterSpacing: 0.8,
                              ),
                            ),
                          ),
                        for (final bot in group.bots) _row(context, bot),
                      ],
                    ),
                  ),
                if (hidden.isNotEmpty)
                  identified(
                    ShellIds.sidebarHiddenToggle,
                    TextButton(
                      onPressed: onToggleHidden,
                      child: Text(
                        showHidden
                            ? 'Hide ${hidden.length} hidden'
                            : 'Show ${hidden.length} hidden'
                                  '${hiddenUnread > 0 ? ' ($hiddenUnread)' : ''}',
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
                  padding: const EdgeInsets.all(16),
                  child: Text(
                    error!,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.error,
                    ),
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
    final badge = unreadBadgeLabel(view);
    final isArchived = archived.contains(botId);
    return identified(
      ShellIds.sidebarBot(botId),
      ListTile(
        key: ValueKey('bot-$botId'),
        selected: botId == activeBotId,
        enabled: !isArchived,
        leading: SheepAvatar(
          size: 34,
          background: bot.sheep.background,
          working: _working(bot),
        ),
        title: Row(
          children: [
            Expanded(
              child: Text(
                _name(bot),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.bodyLarge?.copyWith(
                  fontWeight: view?.unread == true
                      ? FontWeight.w700
                      : FontWeight.w600,
                ),
              ),
            ),
            if (at != null)
              Text(
                formatSidebarMessageTime(at),
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
          ],
        ),
        subtitle: Text(
          preview ?? profiles[botId]?.title ?? 'No messages yet',
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
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
                    Text('Archived', style: theme.textTheme.labelSmall),
                  if (badge != null) Badge(label: Text(badge)),
                ],
              ),
        onTap: isArchived ? null : () => onSelect(botId),
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
  final VoidCallback onSearch;
  final VoidCallback onProfile;

  /// The Marketplace, where the header is the place for it; null where the
  /// column's foot names it instead.
  final VoidCallback? onMarketplace;

  /// Starts the continuous voice session. One gesture: the footer opens and
  /// the call starts, because a footer that opens and then waits to be
  /// started again is two gestures for one intention.
  final VoidCallback onVoice;
  final bool voiceActive;
  const _Header({
    required this.onCreateBot,
    required this.onSearch,
    required this.onVoice,
    required this.voiceActive,
    required this.onProfile,
    this.onMarketplace,
  });

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 8, 8, 4),
      child: Row(
        children: [
          identified(
            ShellIds.sidebarProfile,
            IconButton(
              tooltip: 'You',
              onPressed: onProfile,
              icon: CircleAvatar(
                radius: 18,
                backgroundColor: scheme.surfaceContainerHighest,
                foregroundColor: scheme.onSurface,
                child: const Icon(Icons.person_outline, size: 22),
              ),
            ),
          ),
          if (onMarketplace case final VoidCallback open)
            identified(
              ShellIds.sidebarMarketplace,
              IconButton(
                tooltip: 'Marketplace',
                onPressed: open,
                icon: const Icon(Icons.storefront_outlined),
              ),
            ),
          const Spacer(),
          identified(
            VoiceIds.sidebarStart,
            IconButton.filledTonal(
              tooltip: voiceActive
                  ? 'Voice session active'
                  : 'Start voice session',
              isSelected: voiceActive,
              onPressed: onVoice,
              icon: const Icon(Icons.graphic_eq),
            ),
          ),
          const SizedBox(width: 4),
          identified(
            ShellIds.sidebarSearch,
            IconButton.filledTonal(
              tooltip: 'Search',
              onPressed: onSearch,
              icon: const Icon(Icons.search),
            ),
          ),
          const SizedBox(width: 4),
          identified(
            ShellIds.sidebarCreateBot,
            IconButton.filledTonal(
              tooltip: 'Add a sheep',
              onPressed: onCreateBot,
              icon: const Icon(Icons.add),
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
        Divider(height: 1, color: theme.colorScheme.outlineVariant),
        identified(
          ShellIds.sidebarMarketplace,
          ListTile(
            leading: const Icon(Icons.storefront_outlined),
            title: Text(
              'Marketplace',
              style: theme.textTheme.bodyLarge?.copyWith(
                fontWeight: FontWeight.w600,
              ),
            ),
            onTap: onMarketplace,
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
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(12),
      child: Container(
        width: 76,
        padding: const EdgeInsets.symmetric(vertical: 8),
        decoration: BoxDecoration(
          color: active
              ? theme.colorScheme.primary.withValues(alpha: 0.14)
              : null,
          borderRadius: BorderRadius.circular(12),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Stack(
              children: [
                SheepAvatar(size: 40, background: background, working: working),
                if (unread)
                  Positioned(
                    right: 0,
                    top: 0,
                    child: Container(
                      width: 10,
                      height: 10,
                      decoration: BoxDecoration(
                        color: theme.colorScheme.primary,
                        shape: BoxShape.circle,
                      ),
                    ),
                  ),
              ],
            ),
            const SizedBox(height: 6),
            Text(
              name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: theme.textTheme.bodySmall,
            ),
          ],
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
        Text(message, style: Theme.of(context).textTheme.bodyMedium),
        const SizedBox(height: 8),
        identified(
          ShellIds.sidebarRetry,
          FilledButton.tonal(
            onPressed: () => onRetry(),
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
            padding: EdgeInsets.fromLTRB(16, 10, 16, 0),
            child: Row(
              children: [
                FrockSkeleton(width: 34, height: 34),
                SizedBox(width: 12),
                Expanded(child: FrockSkeleton(height: 34)),
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
    padding: const EdgeInsets.all(24),
    child: Text(
      'No Bots yet. Add your first sheep.',
      style: Theme.of(context).textTheme.bodyMedium
          ?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant),
    ),
  );
}
