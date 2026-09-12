import 'dart:async';

import 'package:flutter/material.dart' hide ConnectionState;

import '../client/chat_controller.dart';
import '../flock/sheep.dart';
import 'semantics.dart';
import 'chat_icons.dart';

/// The blue a running Computer's icon wears: a cooler note beside the
/// accent, so "working" and "yours" never read as the same colour.
const computerRunningColor = Color(0xff5aa9ff);

/// The conversation's title bar.
///
/// On a phone it is GrokBot's: the way back to the Bot list, the Bot's name as
/// a pill that opens the Bot's page, and the Computer. Everything else the Bot
/// holds — its Routines, its Applets, the pages its Packages mount — is on that
/// page rather than in a row of icons. At the wider tiers the right panel is a
/// column or a drawer beside the conversation, and the bar names each entry of
/// it separately.
class ChatHeader extends StatelessWidget implements PreferredSizeWidget {
  final String name;
  final double textScale;
  final String? background;

  /// Back to the Bot list. The phone's, where the conversation is a page.
  final VoidCallback? onBack;

  /// Opens the Bot's page from its name. The phone's: at wider tiers the
  /// settings icon opens the panel's entry instead.
  final VoidCallback? onOpenBot;
  final VoidCallback? onSettings;
  final VoidCallback? onComputer;
  final bool computerRunning;
  final VoidCallback? onRoutines;

  /// The Bot's Plugins: what it could run and whether it does. Bot settings,
  /// so it is a door beside Routines and never a Profile entry.
  final VoidCallback? onPlugins;
  final ConnectionState connection;
  final VoidCallback? onApplets;

  /// The doors this Bot's Packages declare, already built and identified.
  /// They belong to the Bot, so they are drawn in the Bot's own bar rather
  /// than over the list of every Bot.
  final List<Widget> packageEntries;

  /// Shows or hides the panel beside the conversation. Null on a phone, where
  /// the panel's entries are pages and there is no column to hide.
  final VoidCallback? onTogglePanel;
  final bool panelShown;

  const ChatHeader({
    super.key,
    required this.name,
    this.textScale = 1,
    this.background,
    this.onBack,
    this.onOpenBot,
    this.onSettings,
    this.onComputer,
    this.computerRunning = false,
    this.onRoutines,
    this.onPlugins,
    this.connection = ConnectionState.initializing,
    this.onApplets,
    this.packageEntries = const [],
    this.onTogglePanel,
    this.panelShown = false,
  });

  double get _toolbarHeight => 52 * textScale.clamp(1, 3);
  @override
  Size get preferredSize => Size.fromHeight(_toolbarHeight);

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final title = Row(
      mainAxisSize: onOpenBot == null ? MainAxisSize.max : MainAxisSize.min,
      children: [
        Stack(
          clipBehavior: Clip.none,
          children: [
            SheepAvatar(size: 24, background: background),
            if (connection == ConnectionState.reconnecting)
              const Positioned(
                right: -2,
                bottom: -2,
                child: _DelayedConnectionDot(),
              ),
          ],
        ),
        const SizedBox(width: 8),
        Flexible(
          child: Text(
            name,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: Theme.of(context).textTheme.titleSmall?.copyWith(
              fontSize: 14,
              fontWeight: FontWeight.w500,
              letterSpacing: -0.15,
            ),
          ),
        ),
        if (onOpenBot != null) ...[
          const SizedBox(width: 3),
          Icon(
            Icons.expand_more_rounded,
            size: 16,
            color: scheme.onSurfaceVariant,
          ),
        ],
      ],
    );
    return AppBar(
      toolbarHeight: _toolbarHeight,
      leadingWidth: 48,
      leading: onBack == null
          ? null
          : identified(
              ShellIds.sidebarToggle,
              IconButton(
                tooltip: 'Your Bots',
                onPressed: onBack,
                icon: const Icon(Icons.arrow_back_rounded, size: 20),
              ),
            ),
      // With no back arrow the avatar is the first thing in the bar, and it
      // sits as far from the left edge as the last icon's glyph does from the
      // right: 4 of trailing space plus the icon's own margin inside its
      // 40-wide button.
      titleSpacing: onBack == null ? 14 : 4,
      title: onOpenBot == null
          ? title
          : Align(
              alignment: Alignment.centerLeft,
              // A button rather than a bare InkWell, so its semantics are the
              // same shape as every other control in this bar: one node that
              // is the identifier, one tappable node inside it.
              child: identified(
                ShellIds.botPanelToggle,
                Tooltip(
                  message: 'Bot settings',
                  child: TextButton(
                    onPressed: onOpenBot,
                    style: TextButton.styleFrom(
                      backgroundColor: scheme.onSurface.withValues(alpha: 0.06),
                      foregroundColor: scheme.onSurface,
                      shape: const StadiumBorder(),
                      padding: const EdgeInsets.fromLTRB(5, 5, 9, 5),
                      minimumSize: const Size(0, 34),
                      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                    ),
                    child: title,
                  ),
                ),
              ),
            ),
      actions: [
        ...packageEntries,
        if (onApplets != null)
          identified(
            AppletIds.chip,
            _destination('Applets', ChatIconKind.applet, onApplets),
          ),
        if (onComputer != null)
          _destination(
            'Computer',
            ChatIconKind.computer,
            onComputer,
            color: computerRunning ? computerRunningColor : null,
          ),
        if (onRoutines != null)
          identified(
            RoutineIds.panelToggle,
            _destination('Routines', ChatIconKind.routines, onRoutines),
          ),
        if (onPlugins != null)
          identified(
            PluginIds.panelToggle,
            _destination('Plugins', ChatIconKind.plugins, onPlugins),
          ),
        if (onSettings != null)
          identified(
            ShellIds.botPanelToggle,
            _destination('Bot settings', ChatIconKind.settings, onSettings),
          ),
        // The wide tiers' one switch for the panel beside the conversation:
        // rightmost, against the column it shows and hides.
        if (onTogglePanel != null)
          identified(
            ShellIds.rightPanelToggle,
            _destination(
              panelShown ? 'Hide the panel' : 'Show the panel',
              ChatIconKind.panel,
              onTogglePanel,
            ),
          ),
        const SizedBox(width: 4),
      ],
    );
  }

  Widget _destination(
    String label,
    ChatIconKind icon,
    VoidCallback? open, {
    Color? color,
  }) => Builder(
    builder: (context) => IconButton(
      tooltip: label,
      color: color ?? Theme.of(context).colorScheme.onSurfaceVariant,
      onPressed: open,
      icon: ChatIcon(icon),
      style: IconButton.styleFrom(
        minimumSize: const Size(38, 44),
        maximumSize: const Size(38, 44),
        iconSize: 20,
        padding: EdgeInsets.zero,
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
      ),
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
