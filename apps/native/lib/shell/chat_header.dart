import 'package:flutter/material.dart';

import '../flock/sheep.dart';
import 'semantics.dart';

/// Identity stays separate from destinations so tools never squeeze the name.
class ChatHeader extends StatelessWidget implements PreferredSizeWidget {
  final String name;
  final double textScale;
  final String? background;
  final VoidCallback? onBots;
  final VoidCallback onSettings;
  final VoidCallback? onComputer;
  final VoidCallback onRoutines;
  final VoidCallback? onApplets;

  const ChatHeader({
    super.key,
    required this.name,
    this.textScale = 1,
    this.background,
    this.onBots,
    required this.onSettings,
    this.onComputer,
    required this.onRoutines,
    this.onApplets,
  });

  @override
  Size get preferredSize => Size.fromHeight(116 * textScale.clamp(1, 3));

  @override
  Widget build(BuildContext context) => AppBar(
    toolbarHeight: 64 * textScale.clamp(1, 3),
    leading: onBots == null
        ? null
        : identified(
            ShellIds.sidebarToggle,
            IconButton(
              tooltip: 'Your Bots',
              onPressed: onBots,
              icon: const Icon(Icons.menu),
            ),
          ),
    titleSpacing: 8,
    title: Row(
      children: [
        SheepAvatar(size: 34, background: background),
        const SizedBox(width: 10),
        Expanded(
          child: Text(
            name,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: Theme.of(context).textTheme.titleMedium,
          ),
        ),
      ],
    ),
    actions: [
      identified(
        ShellIds.botPanelToggle,
        IconButton(
          tooltip: 'Bot settings',
          onPressed: onSettings,
          icon: const Icon(Icons.settings_outlined),
        ),
      ),
    ],
    bottom: PreferredSize(
      preferredSize: Size.fromHeight(52 * textScale.clamp(1, 3)),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(8, 0, 8, 4),
        child: Row(
          children: [
            _destination(
              'Computer',
              Icons.desktop_windows_outlined,
              onComputer,
            ),
            _destination('Routines', Icons.schedule, onRoutines),
            _destination('Applets', Icons.widgets_outlined, onApplets),
          ],
        ),
      ),
    ),
  );

  Widget _destination(String label, IconData icon, VoidCallback? open) =>
      Expanded(
        child: TextButton(
          onPressed: open,
          style: TextButton.styleFrom(
            minimumSize: const Size(44, 48),
            padding: const EdgeInsets.symmetric(horizontal: 2),
          ),
          child: Wrap(
            alignment: WrapAlignment.center,
            crossAxisAlignment: WrapCrossAlignment.center,
            spacing: 5,
            children: [Icon(icon, size: 18), Text(label)],
          ),
        ),
      );
}
