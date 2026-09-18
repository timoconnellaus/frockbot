import 'dart:async';

import 'package:flutter/material.dart' hide ConnectionState;

import '../client/chat_controller.dart';
import '../voice/voice_mode.dart' show VoiceHeaderPill;
import 'semantics.dart';
import 'chat_icons.dart';
import 'desktop_layout.dart';

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

  /// Whether this is a phone's bar, where the name is always a pill and the
  /// panel is a page rather than a column.
  final bool phone;

  /// Back to the Bot list. The phone's, where the conversation is a page.
  final VoidCallback? onBack;

  /// Opens the Bot's page from its name, at every tier: the right panel's root
  /// on a desktop, a pushed page on a phone. It is the one door to everything
  /// else this Bot holds.
  final VoidCallback? onOpenBot;
  final VoidCallback? onComputer;
  final bool computerRunning;
  final ConnectionState connection;

  /// Shows or hides the panel beside the conversation. Null on a phone, where
  /// the panel's entries are pages and there is no column to hide.
  final VoidCallback? onTogglePanel;
  final bool panelShown;

  /// Whether this Bot is the one on the call (ADR 0031). The bar keeps the
  /// name, a mark that says why the thread is gone, and the Computer: every
  /// other door leads out of a call that has no way out but ending it.
  final bool voiceMode;

  const ChatHeader({
    super.key,
    required this.name,
    this.textScale = 1,
    this.phone = false,
    this.onBack,
    this.onOpenBot,
    this.onComputer,
    this.computerRunning = false,
    this.connection = ConnectionState.initializing,
    this.onTogglePanel,
    this.panelShown = false,
    this.voiceMode = false,
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
        // Slow recovery marks the name itself: the bar carries no character
        // now that the Bot's companion sits beside the composer.
        if (connection == ConnectionState.reconnecting) ...[
          const _DelayedConnectionDot(),
          const SizedBox(width: 6),
        ],
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
        if (voiceMode) ...[const SizedBox(width: 8), const VoiceHeaderPill()],
        if (onOpenBot != null && !voiceMode) ...[
          const SizedBox(width: 3),
          Icon(
            Icons.expand_more_rounded,
            size: 16,
            color: scheme.onSurfaceVariant,
          ),
        ],
      ],
    );
    return DesktopHeader(
      // A call collapses the list; the phone layout has no list beside this
      // bar. Either way this is the window's top-left row on a Mac.
      atWindowLeading: voiceMode || phone,
      child: AppBar(
        toolbarHeight: _toolbarHeight,
        leadingWidth: 48,
        leading: onBack == null
            ? null
            : identified(
                ShellIds.sidebarToggle,
                IconButton(
                  tooltip: 'Your Bots',
                  onPressed: onBack,
                  icon: Icon(Icons.arrow_back_rounded, size: chatIconSize),
                ),
              ),
        // With no back arrow the name is the first thing in the bar, and it
        // sits as far from the left edge as the last icon's glyph does from the
        // right: 4 of trailing space plus the icon's own margin inside its
        // 40-wide button.
        titleSpacing: onBack == null ? 14 : 4,
        title: onOpenBot == null || voiceMode
            ? title
            : Align(
                alignment: Alignment.centerLeft,
                // A button rather than a bare InkWell, so its semantics are the
                // same shape as every other control in this bar: one node that
                // is the identifier, one tappable node inside it.
                child: identified(
                  ShellIds.botPanelToggle,
                  Tooltip(
                    message: 'Open $name',
                    child: _BotNameButton(
                      phone: phone,
                      onPressed: onOpenBot!,
                      child: title,
                    ),
                  ),
                ),
              ),
        actions: [
          if (onComputer != null)
            _destination(
              'Computer',
              ChatIconKind.computer,
              onComputer,
              color: computerRunning ? computerRunningColor : null,
            ),
          // The wide tiers' one switch for the panel beside the conversation:
          // rightmost, against the column it shows and hides.
          if (onTogglePanel != null && !voiceMode)
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
      ),
    );
  }

  Widget _destination(
    String label,
    ChatIconKind icon,
    VoidCallback? open, {
    Color? color,
  }) => Builder(
    builder: (context) {
      // A phone keeps 44-point targets; a desk packs the doors closer.
      final target = chatDesktopChrome
          ? const Size(36, 40)
          : const Size(44, 46);
      return IconButton(
        tooltip: label,
        color: color ?? Theme.of(context).colorScheme.onSurfaceVariant,
        onPressed: open,
        icon: ChatIcon(icon),
        style: IconButton.styleFrom(
          minimumSize: target,
          maximumSize: target,
          iconSize: chatIconSize,
          padding: EdgeInsets.zero,
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        ),
      );
    },
  );
}

/// The Bot's name, which is the door to its page.
///
/// A phone wears the pill all the time: it is the only affordance in that bar
/// saying the name can be pressed. At a desk there is a pointer to say it
/// instead, so the fill arrives on hover and on focus and the resting bar is
/// the name and nothing else.
class _BotNameButton extends StatefulWidget {
  final bool phone;
  final VoidCallback onPressed;
  final Widget child;
  const _BotNameButton({
    required this.phone,
    required this.onPressed,
    required this.child,
  });

  @override
  State<_BotNameButton> createState() => _BotNameButtonState();
}

class _BotNameButtonState extends State<_BotNameButton> {
  bool _lit = false;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final filled = widget.phone || _lit;
    return TextButton(
      onPressed: widget.onPressed,
      onHover: widget.phone ? null : (over) => setState(() => _lit = over),
      onFocusChange: widget.phone ? null : (has) => setState(() => _lit = has),
      style: TextButton.styleFrom(
        backgroundColor: filled
            ? scheme.onSurface.withValues(alpha: 0.06)
            : Colors.transparent,
        foregroundColor: scheme.onSurface,
        shape: const StadiumBorder(),
        padding: const EdgeInsets.fromLTRB(12, 5, 9, 5),
        minimumSize: const Size(0, 34),
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
      ),
      child: widget.child,
    );
  }
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
