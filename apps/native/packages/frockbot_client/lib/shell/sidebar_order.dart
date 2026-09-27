/// Where a dragged Bot row landed, and the profile writes that make it so.
///
/// A Bot's place in the list is a profile field, `sidebarOrder`, the way its
/// pin is: the Bot Durable Object holds it, the identity directory reads it
/// through, and the sidebar draws whatever it reads. So a drop is a command to
/// the authority, not a rearrangement the client keeps for itself, and it
/// comes back the same on every device and every reload.
///
/// The number is sparse. Neighbours are spaced a thousand apart, a drop takes
/// the midpoint between the rows it landed between, and only when there is no
/// room left does the row after it move too. The first drop into a list that
/// was never ordered numbers the rows above the drop as well, because a Bot
/// without a number sits after every Bot with one.
library;

import 'sidebar.dart';

/// The room left between two rows that were placed one after the other.
const int sidebarOrderStride = 1000;

/// A row let go over the list.
class SidebarDrop {
  final String botId;

  /// The Bot it landed above, or null for the end of the list.
  final String? beforeBotId;

  /// The list's rows as they were drawn, top to bottom, which is the order
  /// the person was looking at when they let go.
  final List<String> rows;
  const SidebarDrop({
    required this.botId,
    required this.beforeBotId,
    required this.rows,
  });

  @override
  bool operator ==(Object other) =>
      other is SidebarDrop &&
      other.botId == botId &&
      other.beforeBotId == beforeBotId &&
      _sameList(other.rows, rows);

  @override
  int get hashCode => Object.hash(botId, beforeBotId, rows.length);

  @override
  String toString() => 'SidebarDrop($botId before $beforeBotId of $rows)';
}

bool _sameList(List<String> left, List<String> right) {
  if (left.length != right.length) return false;
  for (var index = 0; index < left.length; index++) {
    if (left[index] != right[index]) return false;
  }
  return true;
}

/// One `bot/set-profile` patch a drop needs.
class SidebarProfileWrite {
  final String botId;
  final Map<String, Object?> patch;
  const SidebarProfileWrite(this.botId, this.patch);

  @override
  bool operator ==(Object other) =>
      other is SidebarProfileWrite &&
      other.botId == botId &&
      other.patch.length == patch.length &&
      other.patch.entries.every((entry) => patch[entry.key] == entry.value);

  @override
  int get hashCode => Object.hash(botId, patch.length);

  @override
  String toString() => 'SidebarProfileWrite($botId, $patch)';
}

/// The writes a drop needs, the dragged Bot's own first.
///
/// Empty when the drop changes nothing: a row let go where it already was, or
/// on itself.
List<SidebarProfileWrite> planSidebarDropV1(
  SidebarDrop drop,
  Map<String, SidebarProfile> profiles,
) {
  if (drop.beforeBotId == drop.botId) return const [];
  final sequence = [
    for (final id in drop.rows)
      if (id != drop.botId) id,
  ];
  final at = drop.beforeBotId == null
      ? sequence.length
      : sequence.indexOf(drop.beforeBotId!);
  if (at < 0) return const [];
  sequence.insert(at, drop.botId);

  // The dragged row is placed afresh; every other row keeps its number where
  // its number still puts it after the row above.
  final current = <String, int?>{
    for (final id in sequence)
      id: id == drop.botId ? null : profiles[id]?.sidebarOrder,
  };
  final assigned = <String, int>{};
  int? last;
  for (var index = 0; index < sequence.length; index++) {
    final id = sequence[index];
    final own = current[id];
    if (own != null && (last == null || own > last)) {
      assigned[id] = own;
      last = own;
      continue;
    }
    int? next;
    for (var ahead = index + 1; ahead < sequence.length; ahead++) {
      final candidate = current[sequence[ahead]];
      if (candidate != null && (last == null || candidate > last)) {
        next = candidate;
        break;
      }
    }
    final order = last == null
        ? (next == null ? 0 : next - sidebarOrderStride)
        : next == null
        ? last + sidebarOrderStride
        : next - last >= 2
        ? last + (next - last) ~/ 2
        : last + 1;
    assigned[id] = order;
    last = order;
  }

  final writes = <SidebarProfileWrite>[];
  final draggedOrder = assigned[drop.botId]!;
  if (draggedOrder != profiles[drop.botId]?.sidebarOrder) {
    writes.add(SidebarProfileWrite(drop.botId, {'sidebarOrder': draggedOrder}));
  }
  for (final id in sequence) {
    if (id == drop.botId) continue;
    final order = assigned[id]!;
    if (order == profiles[id]?.sidebarOrder) continue;
    writes.add(SidebarProfileWrite(id, {'sidebarOrder': order}));
  }
  return writes;
}
