/// How the app writes a time: one clock and one house order for a day, so a
/// message, a sidebar row and a Routine's run all say "5:53 am" and
/// "24 Sep 2026" the same way the server's documents do.
library;

const shortWeekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const shortMonths = [
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

/// The twelve-hour clock, lower case: "5:53 am".
String clockLabel(DateTime at) {
  final hour = at.hour % 12 == 0 ? 12 : at.hour % 12;
  final minute = at.minute.toString().padLeft(2, '0');
  return '$hour:$minute ${at.hour < 12 ? 'am' : 'pm'}';
}

/// A day in the house order, day first: "24 Sep", with the year when it is
/// not [now]'s year or when [year] asks for it.
String dateLabel(DateTime at, {DateTime? now, bool year = false}) {
  final day = '${at.day} ${shortMonths[at.month - 1]}';
  return year || (now != null && at.year != now.year) ? '$day ${at.year}' : day;
}

/// A moment in the house order: "24 Sep 2026, 9:00 am".
String momentLabel(DateTime at) =>
    '${dateLabel(at, year: true)}, ${clockLabel(at)}';

/// A wire instant as this device's local time, or null when it is not one.
DateTime? localInstant(String? iso) =>
    iso == null ? null : DateTime.tryParse(iso)?.toLocal();

/// A message's time: the clock today, "Yesterday" or the weekday with it
/// inside the last week, and the date with it beyond.
String messageTimeLabel(DateTime at, DateTime now) {
  final today = DateTime(now.year, now.month, now.day);
  final day = DateTime(at.year, at.month, at.day);
  // Rounded, not truncated: a day that crosses a clock change is 23 or 25
  // hours long.
  final days = (today.difference(day).inHours / 24).round();
  final clock = clockLabel(at);
  if (days <= 0) return clock;
  if (days == 1) return 'Yesterday $clock';
  if (days < 7) return '${shortWeekdays[at.weekday - 1]} $clock';
  return '${dateLabel(at, now: now)}, $clock';
}
