import 'dart:async';

import 'package:flutter/material.dart' hide ConnectionState;

import '../client/chat_controller.dart';
import '../flock/sheep.dart';
import 'semantics.dart';
import 'chat_icons.dart';

class ChatHeader extends StatelessWidget implements PreferredSizeWidget {
  final String name;
  final double textScale;
  final String? background;
  final VoidCallback? onBots;
  final VoidCallback onSettings;
  final VoidCallback? onComputer;
  final bool computerRunning;
  final VoidCallback onRoutines;
  final ConnectionState connection;
  final VoidCallback? onApplets;

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
    this.connection = ConnectionState.initializing,
    this.onApplets,
  });

  double get _toolbarHeight => 56 * textScale.clamp(1, 3);
  @override
  Size get preferredSize => Size.fromHeight(_toolbarHeight);

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
      identified(
        AppletIds.chip,
        _destination('Applets', ChatIconKind.applet, onApplets),
      ),
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
