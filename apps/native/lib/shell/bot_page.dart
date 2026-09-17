/// The Bot page: what this Bot is doing, and the doors to the rest of it.
///
/// One page drawn twice — the right panel's root at the wide tiers, a pushed
/// page on a phone — because the two used to be different maps of the same
/// Bot. It is activity and only activity: the Computer as it is now, the
/// Routines that have fired, the Applets that are running, the doors this
/// Bot's Packages open. What the Bot *is* — its character, its name, its
/// switches, its model, the way to archive it — is Settings, one level down
/// behind the gear, and nothing of it is here.
library;

import 'package:flutter/material.dart';

import '../applets/canvas.dart';
import '../computer/card.dart';
import '../computer/client.dart';
import '../routines/page.dart';
import '../theme/rows.dart';
import 'semantics.dart';

/// One door a Package opened, as the Bot page draws it.
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

/// How many Applets the page names before the same.
const botPageAppletsShownV1 = 2;

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

  /// The Applets this Bot holds. Absent where the Composition has no Applets.
  final AppletCanvasController? applets;
  final void Function(String appletId)? onOpenApplet;
  final VoidCallback? onOpenApplets;
  final List<BotPageDoor> doors;
  const BotPageView({
    super.key,
    required this.botName,
    this.computer,
    this.turnRunning = false,
    this.onOpenComputer,
    this.inbox,
    this.onOpenRun,
    this.onOpenRoutines,
    this.applets,
    this.onOpenApplet,
    this.onOpenApplets,
    this.doors = const [],
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
      if (applets != null) ...[
        const FrockSectionLabel('Applets'),
        _applets(context),
      ],
      if (doors.isNotEmpty) ...[
        const FrockSectionLabel('More'),
        FrockRowGroup(
          rows: [
            for (final door in doors)
              identified(
                door.identifier,
                FrockRow(icon: door.icon, title: door.label, onTap: door.onTap),
              ),
          ],
        ),
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
  /// what a person checks is whether the morning brief ran, not what time it
  /// is set for.
  Widget _routines(BuildContext context) {
    final held = inbox;
    return AnimatedBuilder(
      animation: held ?? const AlwaysStoppedAnimation<double>(0),
      builder: (context, _) {
        final runs = (held?.runs ?? const <RoutineRunSummary>[])
            .take(botPageRunsShownV1)
            .toList();
        final now = DateTime.now();
        return FrockRowGroup(
          rows: [
            if (runs.isEmpty)
              FrockRow(
                icon: Icons.schedule_rounded,
                title: 'No runs yet',
                chevron: false,
              ),
            for (final run in runs)
              identified(
                SettingsIds.botPageRun(run.entryId),
                FrockRow(
                  icon: run.needsYou
                      ? Icons.error_outline_rounded
                      : Icons.check_circle_outline_rounded,
                  title: run.name,
                  subtitle:
                      '${routineRunWhenV1(run.at, now)} · '
                      '${run.needsYou ? 'Needs you' : 'Done'}',
                  onTap: onOpenRun == null ? null : () => onOpenRun!(run),
                ),
              ),
            identified(
              SettingsIds.botPageRoutinesAll,
              FrockRow(
                icon: Icons.history_rounded,
                title: 'All Routines',
                trailing: held == null || held.unacknowledged == 0
                    ? null
                    : Badge(label: Text(held.badge)),
                onTap: onOpenRoutines,
              ),
            ),
          ],
        );
      },
    );
  }

  /// What this Bot has built and is running, then the way to the rest.
  Widget _applets(BuildContext context) {
    final canvas = applets!;
    return AnimatedBuilder(
      animation: canvas,
      builder: (context, _) {
        final shown = canvas.directory.take(botPageAppletsShownV1).toList();
        return FrockRowGroup(
          rows: [
            for (final applet in shown)
              identified(
                SettingsIds.botPageApplet(applet.appletId),
                FrockRow(
                  icon: Icons.web_asset_rounded,
                  title: applet.displayName,
                  subtitle: applet.appletId == canvas.focusedId
                      ? 'Open now'
                      : applet.access == 'shared'
                      ? 'Shared with this Bot'
                      : 'Built by this Bot',
                  onTap: onOpenApplet == null
                      ? null
                      : () => onOpenApplet!(applet.appletId),
                ),
              ),
            identified(
              SettingsIds.botPageAppletsAll,
              FrockRow(
                icon: Icons.widgets_outlined,
                title: 'All Applets',
                onTap: onOpenApplets,
              ),
            ),
          ],
        );
      },
    );
  }
}
