import 'package:flutter/material.dart';

/// Touch opens a sheet; a secondary click opens the same actions at the pointer.
Future<String?> showMessageActions({
  required BuildContext context,
  required bool canCopy,
  required bool canMarkUnread,
  required bool hasUnread,
  required bool readActionsEnabled,
  Offset? position,
}) {
  final actions = [
    if (hasUnread)
      (
        id: 'read',
        label: 'Mark as read',
        icon: Icons.mark_chat_read_outlined,
        enabled: readActionsEnabled,
      ),
    if (canCopy) (id: 'copy', label: 'Copy', icon: Icons.copy, enabled: true),
    if (canMarkUnread)
      (
        id: 'unread',
        label: 'Mark unread from here',
        icon: Icons.mark_chat_unread_outlined,
        enabled: readActionsEnabled,
      ),
    (
      id: 'work',
      label: 'Work details',
      icon: Icons.receipt_long_outlined,
      enabled: true,
    ),
  ];
  if (position != null) {
    final overlay =
        Overlay.of(context).context.findRenderObject()! as RenderBox;
    final point = overlay.globalToLocal(position);
    return showMenu<String>(
      context: context,
      position: RelativeRect.fromRect(
        Rect.fromLTWH(point.dx, point.dy, 0, 0),
        Offset.zero & overlay.size,
      ),
      items: [
        for (final action in actions)
          PopupMenuItem(
            value: action.id,
            enabled: action.enabled,
            child: Row(
              children: [
                Icon(action.icon, size: 22),
                const SizedBox(width: 12),
                Flexible(child: Text(action.label)),
              ],
            ),
          ),
      ],
    );
  }
  return showModalBottomSheet<String>(
    context: context,
    showDragHandle: true,
    builder: (context) => SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (final action in actions)
            ListTile(
              leading: Icon(action.icon),
              title: Text(action.label),
              enabled: action.enabled,
              onTap: () => Navigator.pop(context, action.id),
            ),
        ],
      ),
    ),
  );
}
