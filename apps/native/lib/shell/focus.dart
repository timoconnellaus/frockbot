/// One definition of "focused", and what a focused Bot's row draws.
///
/// The rule, stated once so the shell and the sidebar cannot drift:
///
/// > A Bot is **focused** when its chat is the open one, this window holds
/// > focus, and nothing is covering it.
///
/// All three, because each one on its own gets a case wrong. Only the open Bot
/// is being read, so another Bot's reply is news however attentive the User is.
/// A window in the background is not being read even though its chat is still
/// "open", and neither is one behind a drawer, a run or another route.
///
/// The Bot Durable Object counts every settled Turn, because it cannot know
/// which chat is on screen; the read receipt that clears the count is a round
/// trip behind the message that raised it. Rendering the fan-out verbatim
/// therefore painted a badge on the row the User was already reading, for as
/// long as the receipt took to land. The receipt is still sent — "read" is
/// durable, and it is what makes the badge stay gone on the next launch and
/// the next device — but the row never renders a count it is about to lose.
///
/// Presence is claimed for the same Bot, and the cloud holds its push back;
/// that lease is best-effort, so it decides alerting only. The count stays
/// honest in the cloud and this device, which is the only thing that knows
/// what is on screen, decides what to draw.
library;

import '../protocol/client_wire.generated.dart' as wire;

/// The unread a sidebar row renders, after the focus rule.
class SidebarUnread {
  /// What the badge says, or null where the row shows no badge.
  final String? label;

  /// What the row contributes to a group's total.
  final int count;

  /// Whether the row's name is bold.
  final bool unread;
  const SidebarUnread({
    required this.label,
    required this.count,
    required this.unread,
  });

  /// A row with nothing to say.
  const SidebarUnread.quiet() : label = null, count = 0, unread = false;
}

/// How many unread a badge says, or nothing where the row shows no badge.
String? _label(wire.UnreadView view) {
  if (!view.unread) return null;
  if (view.count == 0) return view.manuallyUnread ? '•' : null;
  return view.capped ? '${view.count}+' : '${view.count}';
}

/// The view a row renders: the fan-out's, unless the User is looking at it.
///
/// `manuallyUnread` is the exception: a Bot the User deliberately marked
/// unread stays bold while they look at it, because that flag is intent rather
/// than arithmetic, and only opening the Bot again clears it.
SidebarUnread sidebarUnreadFor(
  wire.UnreadView? view, {
  required bool focused,
}) {
  if (view == null) return const SidebarUnread.quiet();
  if (focused && !view.manuallyUnread) return const SidebarUnread.quiet();
  return SidebarUnread(
    label: _label(view),
    count: view.count,
    unread: view.unread,
  );
}
