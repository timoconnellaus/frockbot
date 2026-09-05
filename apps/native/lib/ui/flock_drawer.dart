import 'package:flutter/material.dart';

import '../protocol/client_wire.generated.dart' as wire;
import 'frock_tokens.dart';
import 'frock_widgets.dart';

/// The wire's recipe as the widget set's look.
SheepLook lookOf(wire.SheepRecipe sheep) => SheepLook(
  background: sheep.background,
  upper: sheep.upper,
  middle: sheep.middle,
  lower: sheep.lower,
);

/// The flock: every Bot in the account, one row each, with the selected Bot
/// named in accent. Chat is the room; this is the corridor. On a phone it is
/// the drawer behind the menu button; on a wide window it stays open beside
/// the conversation.
class FlockDrawer extends StatelessWidget {
  const FlockDrawer({
    super.key,
    required this.bots,
    required this.selectedId,
    required this.onSelect,
    required this.onRefresh,
    required this.onSettings,
    required this.onSignOut,
    this.stateOf,
    this.onInbox,
    this.inboxCount = 0,
    this.unreadOf,
  });
  final List<wire.BotRegistration> bots;
  final String? selectedId;
  final ValueChanged<wire.BotRegistration> onSelect;
  final VoidCallback onRefresh;
  final VoidCallback onSettings;
  final VoidCallback onSignOut;

  /// What the ring around each sheep says. Unknown Bots get no ring.
  final BotState Function(String botId)? stateOf;

  /// Opens the Inbox of notices from every Bot; absent until it has loaded.
  final VoidCallback? onInbox;
  final int inboxCount;

  /// Unread activity per Bot: the last line as the caption, the count as a chip.
  final wire.UnreadView? Function(String botId)? unreadOf;

  static String? _lastLine(wire.UnreadView? view) {
    final message = view?.lastMessage;
    final text = message?['text'];
    if (text is! String || text.trim().isEmpty) return null;
    return text.trim();
  }

  static String _countLabel(wire.UnreadView view) =>
      view.count == 0 ? 'New' : '${view.count}${view.capped ? '+' : ''}';

  @override
  Widget build(BuildContext context) {
    final t = FrockTokens.of(context);
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(
          FrockTokens.edge,
          12,
          FrockTokens.edge,
          12,
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const FrockEyebrow('Your Bots'),
            const SizedBox(height: FrockTokens.eyebrowToGroup),
            Expanded(
              child: bots.isEmpty
                  ? Padding(
                      padding: const EdgeInsets.only(top: 8),
                      child: Text(
                        'Your Bots will appear here once they’re created.',
                        style: t.body,
                      ),
                    )
                  : ListView(
                      padding: EdgeInsets.zero,
                      children: [
                        FrockGroup(
                          children: [
                            for (final bot in bots)
                              FrockRow(
                                key: ValueKey('bot-${bot.botId.value}'),
                                leading: FrockSheep(
                                  look: lookOf(bot.sheep),
                                  size: FrockTokens.avatarMd,
                                  state:
                                      stateOf?.call(bot.botId.value) ??
                                      BotState.none,
                                ),
                                title: bot.initialName,
                                caption: _lastLine(
                                  unreadOf?.call(bot.botId.value),
                                ),
                                trailing: switch (unreadOf?.call(
                                  bot.botId.value,
                                )) {
                                  final view? when view.unread => FrockChip(
                                    _countLabel(view),
                                    tone: TileTone.accent,
                                  ),
                                  _ when bot.botId.value == selectedId => Icon(
                                    Icons.check_rounded,
                                    size: FrockTokens.icon,
                                    color: t.accent,
                                  ),
                                  _ => null,
                                },
                                onTap: () => onSelect(bot),
                              ),
                          ],
                        ),
                      ],
                    ),
            ),
            const SizedBox(height: FrockTokens.groupGap),
            FrockGroup(
              children: [
                if (onInbox != null)
                  FrockRow(
                    key: const ValueKey('inbox'),
                    leading: const FrockIconTile(Icons.inbox_rounded),
                    title: 'Inbox',
                    trailing: inboxCount == 0
                        ? null
                        : FrockChip('$inboxCount', tone: TileTone.accent),
                    chevron: true,
                    onTap: onInbox,
                  ),
                FrockRow(
                  leading: const FrockIconTile(Icons.refresh_rounded),
                  title: 'Refresh',
                  onTap: onRefresh,
                ),
                FrockRow(
                  leading: const FrockIconTile(Icons.tune_rounded),
                  title: 'Settings',
                  chevron: true,
                  onTap: onSettings,
                ),
                FrockRow(
                  leading: const FrockIconTile(Icons.logout_rounded),
                  title: 'Sign out',
                  onTap: onSignOut,
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
