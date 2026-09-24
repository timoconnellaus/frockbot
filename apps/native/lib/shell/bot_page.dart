/// The Bot page: what this Bot is doing, and the doors to the rest of it.
///
/// One page drawn twice — the right panel's root at the wide tiers, a pushed
/// page on a phone — because the two used to be different maps of the same
/// Bot. It is activity and only activity: the Computer as it is now, the
/// Routines that have fired, the Plugin panels that are open. What the Bot
/// *is* — its character, its name, its switches, its model, the way to archive
/// it — is Settings, one level down behind the gear, and nothing of it is here.
library;

import 'package:flutter/material.dart';

import '../computer/card.dart';
import '../computer/client.dart';
import '../panels/canvas.dart';
import '../routines/page.dart';
import '../theme/rows.dart';
import 'semantics.dart';

/// One door a Plugin panel opened, as the Bot page draws it.
class BotPageDoor {
  final String identifier;
  final IconData icon;
  final String label;
  final VoidCallback onTap;
  const BotPageDoor({
    required this.identifier,
    required this.icon,
    required this.label,
    required this.onTap,
  });
}

/// How many firings the page shows before it sends the reader to the list.
const botPageRunsShownV1 = 3;

class BotPageView extends StatelessWidget {
  final String botName;

  /// The Bot's Computer, where the deployment has one. The card is always the
  /// first thing on the page when it exists: idle it is the last capture and
  /// "Ready", running it is the desktop.
  final ComputerController? computer;
  final bool turnRunning;
  final VoidCallback? onOpenComputer;

  /// The completion inbox, which is where a Routine firing becomes visible.
  final RoutineInboxController? inbox;
  final void Function(RoutineRunSummary run)? onOpenRun;
  final VoidCallback? onOpenRoutines;

  /// Plugin conversation panels for this Bot.
  final PanelCanvasController? panels;
  final List<BotPageDoor> panelDoors;
  const BotPageView({
    super.key,
    required this.botName,
    this.computer,
    this.turnRunning = false,
    this.onOpenComputer,
    this.inbox,
    this.onOpenRun,
    this.onOpenRoutines,
    this.panels,
    this.panelDoors = const [],
  });

  @override
  Widget build(BuildContext context) {
    final machine = computer;
    final sections = <Widget>[
      if (machine != null && machine.available) ...[
        const FrockSectionLabel(
          'Computer',
          padding: EdgeInsets.fromLTRB(12, 8, 4, 6),
        ),
        ComputerCard(
          controller: machine,
          turnRunning: turnRunning,
          botName: botName,
          onOpen: onOpenComputer,
        ),
      ],
      if (onOpenRoutines != null) ...[
        const FrockSectionLabel('Routines'),
        _routines(context),
      ],
      if (panels != null && panelDoors.isNotEmpty) ...[
        const FrockSectionLabel('Panels'),
        _panels(context),
      ],
    ];
    return identified(
      SettingsIds.botPage,
      SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: sections.isEmpty
              ? [
                  Padding(
                    padding: const EdgeInsets.fromLTRB(4, 24, 4, 0),
                    child: Text(
                      'Nothing running. Settings is in the corner.',
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color: Theme.of(context).colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ),
                ]
              : sections,
        ),
      ),
    );
  }

  /// The last few firings, then the way to the list. A firing is what a
  /// Routine leaves behind, so the rows here are runs rather than schedules:
  /// name, time and a mark on one row. They are loose rows, not a card — a
  /// card is for a door, which is All Routines.
  Widget _routines(BuildContext context) {
    final held = inbox;
    return AnimatedBuilder(
      animation: held ?? const AlwaysStoppedAnimation<double>(0),
      builder: (context, _) {
        final runs = (held?.runs ?? const <RoutineRunSummary>[])
            .take(botPageRunsShownV1)
            .toList();
        final now = DateTime.now();
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (runs.isEmpty && (held == null || held.loaded))
              Padding(
                padding: const EdgeInsets.fromLTRB(14, 8, 12, 8),
                child: Text(
                  'No runs yet',
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
                ),
              ),
            for (final run in runs)
              identified(
                SettingsIds.botPageRun(run.entryId),
                RoutineRunRow(
                  run: run,
                  now: now,
                  onTap: onOpenRun == null ? null : () => onOpenRun!(run),
                ),
              ),
            FrockRowGroup(
              rows: [
                identified(
                  SettingsIds.botPageRoutinesAll,
                  FrockRow(
                    icon: Icons.history_rounded,
                    title: 'All Routines',
                    onTap: onOpenRoutines,
                  ),
                ),
              ],
            ),
          ],
        );
      },
    );
  }

  /// Doors into Plugin panel surfaces declared for this Bot.
  Widget _panels(BuildContext context) {
    final controller = panels!;
    return AnimatedBuilder(
      animation: controller,
      builder: (context, _) => FrockRowGroup(
        rows: [
          for (final door in panelDoors)
            identified(
              door.identifier,
              FrockRow(
                icon: door.icon,
                title: door.label,
                onTap: door.onTap,
              ),
            ),
        ],
      ),
    );
  }
}
