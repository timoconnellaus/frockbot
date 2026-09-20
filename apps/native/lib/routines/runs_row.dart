/// One recent firing, as a loose row: the name, the time, and how it ended.
library;

import 'package:flutter/material.dart';

import '../theme/frock_theme.dart';

/// How a recent firing should be marked.
enum RoutineRunMarkV1 { running, finished, failed }

/// One firing, as the Bot page and All Routines say it: which Routine, when,
/// and how it ended.
class RoutineRunSummary {
  final String entryId;
  final String routineId;
  final String name;
  final DateTime at;

  /// The inbox is completions, so a row is finished or failed. `running` is
  /// here for a status the list is handed — the inbox does not write one.
  final RoutineRunMarkV1 mark;
  const RoutineRunSummary({
    required this.entryId,
    required this.routineId,
    required this.name,
    required this.at,
    required this.mark,
  });
}

/// The inbox's entries as the Bot page reads them.
///
/// The attribution is the only place the Routine's name survives into the
/// inbox — "Automation: Morning brief" — so it is read back off it rather than
/// by asking the Routines route for a second list the two could disagree
/// about.
List<RoutineRunSummary> routineRunSummariesV1(List<Object?> entries) => [
  for (final raw in entries)
    if (raw is Map &&
        raw['entryId'] is String &&
        raw['routineId'] is String &&
        raw['createdAt'] is String)
      RoutineRunSummary(
        entryId: raw['entryId']! as String,
        routineId: raw['routineId']! as String,
        name: routineRunNameV1(raw['attribution'] as String? ?? ''),
        at:
            DateTime.tryParse(raw['createdAt']! as String)?.toLocal() ??
            DateTime.now(),
        mark: raw['status'] == 'running'
            ? RoutineRunMarkV1.running
            : raw['failure'] == true
            ? RoutineRunMarkV1.failed
            : RoutineRunMarkV1.finished,
      ),
];

/// What the inbox called the thing that fired, without the machinery's prefix.
String routineRunNameV1(String attribution) {
  const prefix = 'Automation: ';
  final name = attribution.startsWith(prefix)
      ? attribution.substring(prefix.length)
      : attribution;
  return name.isEmpty ? 'Routine' : name;
}

/// When a firing happened, in the words a person uses for the last week:
/// "Today 7:02 am", "Yesterday 6:00 pm", "Mon 9:00 am", then the date.
String routineRunWhenV1(DateTime at, DateTime now) {
  final day = DateTime(at.year, at.month, at.day);
  final today = DateTime(now.year, now.month, now.day);
  final days = today.difference(day).inDays;
  final clock = routineRunClockV1(at);
  if (days == 0) return 'Today $clock';
  if (days == 1) return 'Yesterday $clock';
  if (days > 1 && days < 7) return '${_weekdays[at.weekday - 1]} $clock';
  return '${at.day} ${_months[at.month - 1]} $clock';
}

/// The twelve-hour clock this app says times in.
String routineRunClockV1(DateTime at) {
  final hour = at.hour % 12 == 0 ? 12 : at.hour % 12;
  final minute = at.minute.toString().padLeft(2, '0');
  return '$hour:$minute ${at.hour < 12 ? 'am' : 'pm'}';
}

const _weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
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

/// One recent firing: the name, the time, and how it ended, on a single line.
///
/// The time sits on the right, just before the mark, so the name is what you
/// read first and a long name ellipsises without taking the clock with it.
class RoutineRunRow extends StatelessWidget {
  final RoutineRunSummary run;
  final DateTime now;
  final VoidCallback? onTap;
  const RoutineRunRow({
    super.key,
    required this.run,
    required this.now,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final dark = theme.brightness == Brightness.dark;
    // Paper's muted rung is inkMuted; the dark theme's third rung is subtle.
    // ColorScheme.onSurfaceVariant is fine on ink and too faint on cream if
    // a look has remapped muted toward the window.
    final nameColor = dark ? FrockTheme.text : FrockTheme.ink;
    final timeColor = dark ? FrockTheme.muted : FrockTheme.inkMuted;
    return InkWell(
      onTap: onTap,
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: 46),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 8, 12, 8),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  run.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.bodyMedium?.copyWith(
                    fontSize: 14,
                    fontWeight: FontWeight.w500,
                    letterSpacing: -0.1,
                    color: nameColor,
                  ),
                ),
              ),
              const SizedBox(width: 10),
              Text(
                routineRunWhenV1(run.at, now),
                style: theme.textTheme.bodySmall?.copyWith(
                  fontSize: 12.5,
                  color: timeColor,
                ),
              ),
              const SizedBox(width: 8),
              RoutineRunMark(mark: run.mark),
            ],
          ),
        ),
      ),
    );
  }
}

/// The trailing mark on a recent-run row: a spinner, a check, or an x.
class RoutineRunMark extends StatelessWidget {
  final RoutineRunMarkV1 mark;
  const RoutineRunMark({super.key, required this.mark});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final dark = theme.brightness == Brightness.dark;
    final (label, child) = switch (mark) {
      RoutineRunMarkV1.running => (
        'Running',
        SizedBox(
          width: 16,
          height: 16,
          child: CircularProgressIndicator(
            strokeWidth: 2,
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
      ),
      RoutineRunMarkV1.finished => (
        'Finished',
        Icon(
          Icons.check_rounded,
          size: 18,
          color: dark ? FrockTheme.success : FrockTheme.successInk,
        ),
      ),
      RoutineRunMarkV1.failed => (
        'Failed',
        Icon(Icons.close_rounded, size: 18, color: theme.colorScheme.error),
      ),
    };
    return Semantics(label: label, child: child);
  }
}
