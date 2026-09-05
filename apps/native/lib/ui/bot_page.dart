import 'package:flutter/material.dart';

import '../client/chat_controller.dart';
import '../protocol/client_wire.generated.dart' as wire;
import 'chat_pane.dart' show stampFor;
import 'flock_drawer.dart' show lookOf;
import 'frock_page.dart';
import 'frock_tokens.dart';
import 'frock_widgets.dart';
import 'receipts.dart';

/// A Bot's home: who it is, whether it is working, and its Work as receipts.
/// Chat never shows what a Bot did; this is where that lives (screen 03).
class BotPage extends StatefulWidget {
  const BotPage({
    super.key,
    required this.bot,
    required this.controller,
    this.state = BotState.none,
  });
  final wire.BotRegistration bot;
  final ChatController controller;
  final BotState state;
  @override
  State<BotPage> createState() => _BotPageState();
}

class _BotPageState extends State<BotPage> {
  @override
  void initState() {
    super.initState();
    widget.controller.addListener(update);
  }

  void update() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    widget.controller.removeListener(update);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = FrockTokens.of(context);
    final runs = widget.controller.runs.reversed.take(20).toList();
    final turns = <(String, List<Receipt>)>[
      for (final run in runs)
        if (receiptsFor(run['events'] as List) case final r when r.isNotEmpty)
          (stampFor(run['admittedAt'] as String), r),
    ];
    final (label, tone) = switch (widget.state) {
      BotState.working => ('Working', TileTone.accent),
      BotState.ready => ('Ready', TileTone.good),
      BotState.idle => ('Idle', TileTone.neutral),
      BotState.none => ('Quiet', TileTone.neutral),
    };
    return FrockPage(
      title: widget.bot.initialName,
      padded: false,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(
          FrockTokens.edge,
          8,
          FrockTokens.edge,
          FrockTokens.edge,
        ),
        children: [
          Center(
            child: Stack(
              alignment: Alignment.center,
              children: [
                if (widget.state == BotState.working)
                  const FrockGlow(size: 200),
                Column(
                  children: [
                    FrockSheep(
                      look: lookOf(widget.bot.sheep),
                      size: FrockTokens.avatarHero,
                      state: widget.state,
                    ),
                    const SizedBox(height: 14),
                    Text(widget.bot.initialName, style: t.nameStyle),
                    const SizedBox(height: 10),
                    FrockChip(
                      label,
                      tone: tone,
                      dot: widget.state == BotState.working,
                    ),
                  ],
                ),
              ],
            ),
          ),
          const SizedBox(height: FrockTokens.groupGap + 6),
          const FrockEyebrow('Work'),
          if (turns.isEmpty)
            const FrockGroup(
              children: [
                FrockRow(
                  leading: FrockIconTile(Icons.history_rounded),
                  title: 'Nothing to show yet',
                  caption: 'What this Bot does for you will appear here.',
                ),
              ],
            ),
          for (final (stamp, receipts) in turns) ...[
            Padding(
              padding: const EdgeInsets.only(top: 8, bottom: 6),
              child: Text(
                stamp,
                style: t.monoStyle.copyWith(fontSize: 11, color: t.ink3),
              ),
            ),
            FrockGroup(
              children: [
                for (final r in receipts)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 4),
                    child: FrockReceipt(
                      icon: r.icon,
                      text: r.text,
                      detail: r.detail,
                      time: r.time,
                      tone: r.tone,
                    ),
                  ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}
