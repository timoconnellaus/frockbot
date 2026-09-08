import 'package:flutter/material.dart';

import '../flock/sheep.dart';
import 'semantics.dart';

typedef ChatApplet = ({String label, VoidCallback onOpen});

class ChatHeader extends StatelessWidget implements PreferredSizeWidget {
  final String name;
  final double textScale;
  final String? background;
  final VoidCallback? onBots;
  final VoidCallback onSettings;
  final VoidCallback? onComputer;
  final VoidCallback onRoutines;
  final List<ChatApplet> applets;
  final VoidCallback? onRetryApplets;

  const ChatHeader({
    super.key,
    required this.name,
    this.textScale = 1,
    this.background,
    this.onBots,
    required this.onSettings,
    this.onComputer,
    required this.onRoutines,
    this.applets = const [],
    this.onRetryApplets,
  });

  double get _toolbarHeight => 56 * textScale.clamp(1, 3);
  double get _appletHeight => 38 * textScale.clamp(1, 3);
  bool get _hasApplets => applets.isNotEmpty || onRetryApplets != null;

  @override
  Size get preferredSize =>
      Size.fromHeight(_toolbarHeight + (_hasApplets ? _appletHeight : 0));

  @override
  Widget build(BuildContext context) => AppBar(
    toolbarHeight: _toolbarHeight,
    leadingWidth: 48,
    leading: onBots == null
        ? null
        : identified(
            ShellIds.sidebarToggle,
            IconButton(
              tooltip: 'Your Bots',
              onPressed: onBots,
              icon: const Icon(Icons.menu, size: 20),
            ),
          ),
    titleSpacing: 4,
    title: Row(
      children: [
        SheepAvatar(size: 28, background: background),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            name,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: Theme.of(context).textTheme.titleMedium
                ?.copyWith(fontWeight: FontWeight.w600),
          ),
        ),
      ],
    ),
    actions: [
      _destination('Computer', Icons.desktop_windows_outlined, onComputer),
      _destination('Routines', Icons.schedule, onRoutines),
      identified(
        ShellIds.botPanelToggle,
        _destination('Bot settings', Icons.settings_outlined, onSettings),
      ),
      const SizedBox(width: 4),
    ],
    bottom: !_hasApplets
        ? null
        : PreferredSize(
            preferredSize: Size.fromHeight(_appletHeight),
            child: Container(
              height: _appletHeight,
              decoration: BoxDecoration(
                color: Theme.of(context).colorScheme.surface,
                border: Border(
                  bottom: BorderSide(
                    color: Theme.of(context).colorScheme.outlineVariant,
                  ),
                ),
              ),
              padding: const EdgeInsets.fromLTRB(12, 0, 12, 3),
              child: ListView(
                scrollDirection: Axis.horizontal,
                children: [
                  for (final applet in applets)
                    ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 240),
                      child: Tooltip(
                        message: applet.label,
                        child: TextButton.icon(
                          onPressed: applet.onOpen,
                          icon: const Icon(Icons.widgets_outlined, size: 16),
                          label: Text(
                            applet.label,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                          style: _appletStyle(context),
                        ),
                      ),
                    ),
                  if (onRetryApplets != null)
                    TextButton.icon(
                      onPressed: onRetryApplets,
                      icon: const Icon(Icons.refresh, size: 16),
                      label: const Text('Couldn’t load Applets · Retry'),
                      style: _appletStyle(context),
                    ),
                ],
              ),
            ),
          ),
  );

  ButtonStyle _appletStyle(BuildContext context) => TextButton.styleFrom(
    foregroundColor: Theme.of(context).colorScheme.onSurfaceVariant,
    textStyle: Theme.of(context).textTheme.bodySmall,
    minimumSize: const Size(40, 34),
    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
    padding: const EdgeInsets.symmetric(horizontal: 10),
  );

  Widget _destination(String label, IconData icon, VoidCallback? open) =>
      IconButton(
        tooltip: label,
        onPressed: open,
        icon: Icon(icon, size: 19),
        style: IconButton.styleFrom(
          minimumSize: const Size(40, 48),
          maximumSize: const Size(40, 48),
          padding: EdgeInsets.zero,
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        ),
      );
}
