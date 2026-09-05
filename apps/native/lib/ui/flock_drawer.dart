import 'package:flutter/material.dart';

import '../protocol/client_wire.generated.dart' as wire;
import 'frock_tokens.dart';
import 'frock_widgets.dart';

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
    required this.onSignOut,
    this.stateOf,
  });
  final List<wire.BotRegistration> bots;
  final String? selectedId;
  final ValueChanged<wire.BotRegistration> onSelect;
  final VoidCallback onRefresh;
  final VoidCallback onSignOut;

  /// What the ring around each sheep says. Unknown Bots get no ring.
  final BotState Function(String botId)? stateOf;

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
                                  size: FrockTokens.avatarMd,
                                  state:
                                      stateOf?.call(bot.botId.value) ??
                                      BotState.none,
                                ),
                                title: bot.initialName,
                                trailing: bot.botId.value == selectedId
                                    ? Icon(
                                        Icons.check_rounded,
                                        size: FrockTokens.icon,
                                        color: t.accent,
                                      )
                                    : null,
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
                FrockRow(
                  leading: const FrockIconTile(Icons.refresh_rounded),
                  title: 'Refresh',
                  onTap: onRefresh,
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
