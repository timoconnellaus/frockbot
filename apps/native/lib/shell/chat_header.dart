import 'dart:async';

import 'package:flutter/material.dart' hide ConnectionState;

import '../client/chat_controller.dart';
import '../flock/sheep.dart';
import 'semantics.dart';
import 'chat_icons.dart';

typedef ChatApplet = ({String label, VoidCallback onOpen});

class ChatHeader extends StatelessWidget implements PreferredSizeWidget {
  final String name;
  final double textScale;
  final String? background;
  final VoidCallback? onBots;
  final VoidCallback onSettings;
  final VoidCallback? onComputer;
  final bool computerRunning;
  final VoidCallback onRoutines;
  final List<ChatApplet> applets;
  final VoidCallback? onRetryApplets;
  final ConnectionState connection;

  const ChatHeader({
    super.key,
    required this.name,
    this.textScale = 1,
    this.background,
    this.onBots,
    required this.onSettings,
    this.onComputer,
    this.computerRunning = false,
    required this.onRoutines,
    this.applets = const [],
    this.onRetryApplets,
    this.connection = ConnectionState.initializing,
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
              icon: const ChatIcon(ChatIconKind.menu, size: 20),
            ),
          ),
    titleSpacing: 4,
    title: Row(
      children: [
        Stack(
          clipBehavior: Clip.none,
          children: [
            SheepAvatar(size: 28, background: background),
            if (connection == ConnectionState.reconnecting)
              const Positioned(
                right: -1,
                bottom: -1,
                child: _DelayedConnectionDot(),
              ),
          ],
        ),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            name,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: Theme.of(context).textTheme.titleMedium
                ?.copyWith(fontWeight: FontWeight.w500),
          ),
        ),
      ],
    ),
    actions: [
      _destination(
        'Computer',
        ChatIconKind.computer,
        onComputer,
        color: computerRunning ? Colors.blue : null,
      ),
      _destination('Routines', ChatIconKind.routines, onRoutines),
      identified(
        ShellIds.botPanelToggle,
        _destination('Bot settings', ChatIconKind.settings, onSettings),
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
                  // The header's entry to the Applets, named as one thing: how
                  // many buttons are in it is the header's business, and what
                  // a reader means by "open the Applets" is the first of them.
                  // The failure's Retry is outside it deliberately — pressing
                  // the entry has to mean opening an Applet, never asking for
                  // the list again.
                  if (applets.isNotEmpty)
                    identified(
                      AppletIds.chip,
                      Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          for (final applet in applets)
                            ConstrainedBox(
                              constraints: const BoxConstraints(maxWidth: 240),
                              child: Tooltip(
                                message: applet.label,
                                child: TextButton.icon(
                                  onPressed: applet.onOpen,
                                  icon: const ChatIcon(
                                    ChatIconKind.applet,
                                    size: 16,
                                  ),
                                  label: Text(
                                    applet.label,
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                  ),
                                  style: _appletStyle(context),
                                ),
                              ),
                            ),
                        ],
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

  Widget _destination(
    String label,
    ChatIconKind icon,
    VoidCallback? open, {
    Color? color,
  }) => IconButton(
    tooltip: label,
    color: color,
    onPressed: open,
    icon: ChatIcon(icon),
    style: IconButton.styleFrom(
      minimumSize: const Size(40, 48),
      maximumSize: const Size(40, 48),
      padding: EdgeInsets.zero,
      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
    ),
  );
}

class _DelayedConnectionDot extends StatefulWidget {
  const _DelayedConnectionDot();

  @override
  State<_DelayedConnectionDot> createState() => _DelayedConnectionDotState();
}

class _DelayedConnectionDotState extends State<_DelayedConnectionDot>
    with SingleTickerProviderStateMixin {
  late final AnimationController pulse = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1100),
    value: 1,
  );
  late final Animation<double> opacity = Tween(
    begin: 0.55,
    end: 1.0,
  ).animate(CurvedAnimation(parent: pulse, curve: Curves.easeInOut));
  Timer? delay;
  bool visible = false;

  @override
  void initState() {
    super.initState();
    delay = Timer(const Duration(milliseconds: 1500), () {
      if (!mounted) return;
      setState(() => visible = true);
      _syncMotion();
    });
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _syncMotion();
  }

  void _syncMotion() {
    if (!visible) return;
    if (MediaQuery.disableAnimationsOf(context)) {
      pulse
        ..stop()
        ..value = 1;
    } else if (!pulse.isAnimating) {
      pulse.repeat(reverse: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (!visible) return const SizedBox.shrink();
    final scheme = Theme.of(context).colorScheme;
    return Semantics(
      container: true,
      liveRegion: true,
      label: 'Updating conversation',
      child: Tooltip(
        message: 'Updating conversation',
        excludeFromSemantics: true,
        child: FadeTransition(
          key: const ValueKey('conversation-update'),
          opacity: opacity,
          child: Container(
            width: 9,
            height: 9,
            decoration: BoxDecoration(
              color: Color.alphaBlend(
                scheme.primary.withValues(alpha: 0.68),
                scheme.surface,
              ),
              shape: BoxShape.circle,
              border: Border.all(color: scheme.surface, width: 1.5),
            ),
          ),
        ),
      ),
    );
  }

  @override
  void dispose() {
    delay?.cancel();
    pulse.dispose();
    super.dispose();
  }
}
