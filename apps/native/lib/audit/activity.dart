/// What the Activity page asks for, and how its rows fall into days.
///
/// The server writes each row's sentence (`app/audit/activity.ts`); the one
/// thing it cannot know is the person's calendar, so the day a row falls on
/// is decided here, in this device's local time.
library;

import '../protocol/client_wire.generated.dart' as wire;
import '../theme/time.dart';

/// The filters the page offers, in order: each is a set of audit kinds the
/// server holds (`AUDIT_ACTIVITY_FILTERS_V1`).
const activityFilters = <({String slug, String label})>[
  (slug: 'everything', label: 'Everything'),
  (slug: 'sent', label: 'Sent & changed'),
  (slug: 'commands', label: 'Commands'),
  (slug: 'devices', label: 'Devices'),
];

/// The Activity read one query means, as a path. Everything is the default,
/// so it is never spelled out.
String activityPathV1({String? botId, String? filter, String? before}) {
  final query = Uri(
    queryParameters: {
      'botId': ?botId,
      if (filter != null && filter != 'everything') 'filter': filter,
      'before': ?before,
      'as': 'activity',
    },
  ).query;
  return '/api/audit?$query';
}

/// One day's rows, under the heading a person reads it by.
class ActivityDay {
  final String label;
  final List<wire.ActivityRow> rows;
  const ActivityDay(this.label, this.rows);
}

/// "Today", "Yesterday", then the date: "Tue 22 Sep".
String activityDayLabel(DateTime at, DateTime now) {
  final today = DateTime(now.year, now.month, now.day);
  final day = DateTime(at.year, at.month, at.day);
  // Rounded, not truncated: a day that crosses a clock change is 23 or 25
  // hours long.
  final days = (today.difference(day).inHours / 24).round();
  if (days <= 0) return 'Today';
  if (days == 1) return 'Yesterday';
  return '${shortWeekdays[at.weekday - 1]} ${dateLabel(at, now: now)}';
}

/// The rows, newest first as the server sent them, cut where the local day
/// changes.
List<ActivityDay> activityDays(List<wire.ActivityRow> rows, DateTime now) {
  final days = <ActivityDay>[];
  for (final row in rows) {
    final at = DateTime.parse(row.at.value).toLocal();
    final label = activityDayLabel(at, now);
    if (days.isEmpty || days.last.label != label) {
      days.add(ActivityDay(label, [row]));
    } else {
      days.last.rows.add(row);
    }
  }
  return days;
}
