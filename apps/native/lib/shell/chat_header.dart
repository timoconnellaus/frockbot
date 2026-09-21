import 'dart:async';
import 'dart:ui' show ImageFilter;

import 'package:flutter/material.dart' hide ConnectionState;

import '../client/chat_controller.dart';
import '../voice/voice_mode.dart' show VoiceHeaderPill;
import 'semantics.dart';
import 'chat_icons.dart';
import 'desktop_layout.dart';

/// The blue a running Computer's icon wears: a cooler note beside the
/// accent, so "working" and "yours" never read as the same colour.
const computerRunningColor = Color(0xff5aa9ff);

/// Silhouette height of the conversation companion. The empty canvas around
/// a still is clipped, so this is the drawing, not the frame.
const chatCompanionSize = 88.0;

/// How far the thread fade reaches down from the top of the conversation.
const chatHeaderFadeHeight = 168.0;

/// Shared inset from the top of the conversation. The companion sits a
/// little above it. At a desk the name and panel switch sit a little
/// below so the title meets the drawing's visual mass. On a phone the
/// pills stay on this inset and the companion rises to them.
const chatHeaderChromeTop = 20.0;

/// How far the companion sits above [chatHeaderChromeTop].
const chatHeaderCompanionLift = 8.0;

/// How far the desk name and panel switch sit below [chatHeaderChromeTop].
const chatHeaderChromeDrop = 8.0;

/// Inset from the conversation's left and right for the companion and pills.
const chatHeaderChromeSide = 16.0;

/// Extra list padding at the visual top of the thread, so the first rows
/// clear the companion a little while still sliding under the fade.
const chatHeaderThreadPadding = 28.0;

/// The conversation's title chrome.
///
/// On a call this is still an [AppBar]: the thread is gone, and the bar is
/// the name, a mark that says why, and the Computer. In a conversation it is
/// an overlay — a fade, the Bot's companion at the top-left with the name
/// immediately to its right, and the panel switch on the far right. A phone
/// keeps Back and that same panel switch, because the conversation is a
/// page over the list.
class ChatHeader extends StatelessWidget implements PreferredSizeWidget {
  final String name;
  final double textScale;

  /// Whether this is a phone's chrome, where Back and the panel switch stay
  /// on the original inset and the panel is a page rather than a column.
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

  /// Shows or hides the panel beside the conversation. On a phone it opens
  /// the Bot page, the same door the desk keeps on the far right.
  final VoidCallback? onTogglePanel;
  final bool panelShown;

  /// Whether this Bot is the one on the call (ADR 0031). The bar keeps the
  /// name, a mark that says why the thread is gone, and the Computer: every
  /// other door leads out of a call that has no way out but ending it.
  final bool voiceMode;

  /// The Bot's companion, laid in the overlay a little above the name and
  /// pills. Null while [voiceChrome] is up, and in chrome-only tests.
  final Widget? companion;

  /// Compact call pair (you, the wave, the Bot) while this Bot is on a
  /// call. Takes the companion's slot so the thread stays underneath.
  /// Sized to its own cluster, never stretched across the header.
  final Widget? voiceChrome;

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
    this.companion,
    this.voiceChrome,
  });

  double get _toolbarHeight => 52 * textScale.clamp(1, 3);

  /// A call sits past the lights. A phone page drops a band of the same
  /// surface under them. A conversation beside the list does neither: its
  /// overlay is inside the conversation column.
  DesktopChrome get _chrome => voiceMode
      ? DesktopChrome.leading
      : phone
      ? DesktopChrome.titleBand
      : DesktopChrome.overlay;

  @override
  Size get preferredSize => voiceMode
      ? Size.fromHeight(_toolbarHeight + desktopChromeHeight(_chrome))
      : Size.zero;

  Size get _glyphTarget =>
      chatDesktopChrome ? const Size(36, 36) : const Size(44, 44);

  double get _overlayTop =>
      chatHeaderChromeTop +
      (phone && desktopTitleBarless ? desktopTitleBarBand : 0);

  @override
  Widget build(BuildContext context) =>
      voiceMode ? _bar(context) : _overlay(context);

  Widget _overlay(BuildContext context) {
    final window = Theme.of(context).scaffoldBackgroundColor;
    return Stack(
      fit: StackFit.expand,
      children: [
        Align(
          alignment: Alignment.topCenter,
          child: IgnorePointer(
            child: SizedBox(
              key: const ValueKey('chat-header-fade'),
              height: chatHeaderFadeHeight,
              width: double.infinity,
              child: DecoratedBox(
                decoration: BoxDecoration(
                  gradient: LinearGradient(
                    begin: Alignment.topCenter,
                    end: Alignment.bottomCenter,
                    colors: [
                      window,
                      window.withValues(alpha: 0.82),
                      window.withValues(alpha: 0.38),
                      window.withValues(alpha: 0),
                    ],
                    stops: const [0, 0.42, 0.72, 1],
                  ),
                ),
              ),
            ),
          ),
        ),
        Positioned(
          top: _overlayTop,
          left: chatHeaderChromeSide,
          right: chatHeaderChromeSide,
          child: DesktopWindowDragRegion(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (onBack != null) ...[
                  _chromeInset(
                    identified(
                      ShellIds.sidebarToggle,
                      _ChromePill(
                        tooltip: 'Your Bots',
                        onPressed: onBack,
                        size: _glyphTarget,
                        child: Icon(
                          Icons.arrow_back_rounded,
                          size: chatIconSize,
                          color: Theme.of(context).colorScheme.onSurfaceVariant,
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                ],
                if (voiceChrome != null)
                  Expanded(
                    child: _chromeInset(
                      Align(alignment: Alignment.topLeft, child: voiceChrome!),
                    ),
                  )
                else ...[
                  if (companion != null) ...[
                    Transform.translate(
                      offset: const Offset(0, -chatHeaderCompanionLift),
                      child: IgnorePointer(child: companion!),
                    ),
                    const SizedBox(width: 10),
                  ],
                  Expanded(
                    child: _chromeInset(
                      Align(
                        alignment: Alignment.topLeft,
                        child: _overlayName(context),
                      ),
                    ),
                  ),
                ],
                if (onComputer != null) ...[
                  const SizedBox(width: 8),
                  _chromeInset(
                    identified(
                      ShellIds.computerDestination,
                      _glyphPill(
                        'Computer',
                        ChatIconKind.computer,
                        onComputer,
                        color: computerRunning ? computerRunningColor : null,
                      ),
                    ),
                  ),
                ],
                if (onTogglePanel != null) ...[
                  const SizedBox(width: 8),
                  _chromeInset(
                    identified(
                      ShellIds.rightPanelToggle,
                      phone
                          ? _glyphPill(
                              panelShown ? 'Hide the panel' : 'Show the panel',
                              ChatIconKind.panel,
                              onTogglePanel,
                            )
                          : _glyphButton(
                              panelShown ? 'Hide the panel' : 'Show the panel',
                              ChatIconKind.panel,
                              onTogglePanel,
                            ),
                    ),
                  ),
                ],
              ],
            ),
          ),
        ),
      ],
    );
  }

  Widget _chromeInset(Widget child) => phone
      ? child
      : Padding(
          padding: const EdgeInsets.only(top: chatHeaderChromeDrop),
          child: child,
        );

  /// The Bot's name sits immediately to the right of the companion. On a
  /// phone the Bot page is the panel switch on the far right, so the name
  /// is only the title, as it is at a desk.
  Widget _overlayName(BuildContext context) {
    if (onOpenBot != null) {
      return identified(
        ShellIds.botPanelToggle,
        _ChromePill(
          tooltip: 'Open $name',
          exposeButtonSemantics: true,
          onPressed: onOpenBot,
          padding: const EdgeInsets.fromLTRB(14, 0, 12, 0),
          size: Size(0, chatDesktopChrome ? 40 : 44),
          child: _title(context, chevron: true, flexible: true),
        ),
      );
    }
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: _title(context, chevron: false, flexible: true, prominent: true),
    );
  }

  Widget _glyphPill(
    String label,
    ChatIconKind icon,
    VoidCallback? open, {
    Color? color,
  }) => Builder(
    builder: (context) => _ChromePill(
      tooltip: label,
      onPressed: open,
      size: _glyphTarget,
      child: IconTheme(
        data: IconThemeData(
          color: color ?? Theme.of(context).colorScheme.onSurfaceVariant,
        ),
        child: ChatIcon(icon),
      ),
    ),
  );

  /// The panel switch sits on the fade with no stadium around it: the Bot
  /// page and the Computer already live in that column, so this control is
  /// only "is the column there".
  Widget _glyphButton(
    String label,
    ChatIconKind icon,
    VoidCallback? open, {
    Color? color,
  }) => Builder(
    builder: (context) => IconButton(
      tooltip: label,
      onPressed: open,
      style: IconButton.styleFrom(
        foregroundColor:
            color ?? Theme.of(context).colorScheme.onSurfaceVariant,
        minimumSize: _glyphTarget,
        maximumSize: _glyphTarget,
        fixedSize: _glyphTarget,
        padding: EdgeInsets.zero,
        iconSize: chatIconSize,
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
      ),
      icon: ChatIcon(icon),
    ),
  );

  Widget _title(
    BuildContext context, {
    required bool chevron,
    bool flexible = false,
    bool prominent = false,
  }) {
    final scheme = Theme.of(context).colorScheme;
    final text = Text(
      name,
      maxLines: 2,
      overflow: TextOverflow.ellipsis,
      style: prominent
          ? Theme.of(context).textTheme.titleLarge
          : Theme.of(context).textTheme.titleSmall?.copyWith(
              fontSize: 14,
              fontWeight: FontWeight.w600,
              letterSpacing: -0.15,
            ),
    );
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (connection == ConnectionState.reconnecting) ...[
          const _DelayedConnectionDot(),
          const SizedBox(width: 6),
        ],
        if (flexible) Flexible(child: text) else text,
        if (chevron) ...[
          const SizedBox(width: 3),
          Icon(
            Icons.expand_more_rounded,
            size: 16,
            color: scheme.onSurfaceVariant,
          ),
        ],
      ],
    );
  }

  Widget _bar(BuildContext context) {
    final title = Row(
      mainAxisSize: MainAxisSize.max,
      children: [
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
        const SizedBox(width: 8),
        const VoiceHeaderPill(),
      ],
    );
    return DesktopHeader(
      chrome: _chrome,
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
        titleSpacing: onBack == null ? 14 : 4,
        title: title,
        actions: [
          if (onComputer != null)
            identified(
              ShellIds.computerDestination,
              _destination(
                'Computer',
                ChatIconKind.computer,
                onComputer,
                color: computerRunning ? computerRunningColor : null,
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

/// A frosted stadium for one header control. Pointer-events stay on the
/// control; the fade behind it does not take a tap.
class _ChromePill extends StatelessWidget {
  final String tooltip;
  final bool exposeButtonSemantics;
  final VoidCallback? onPressed;
  final Widget child;
  final Size size;
  final EdgeInsetsGeometry padding;
  const _ChromePill({
    required this.tooltip,
    this.exposeButtonSemantics = false,
    required this.onPressed,
    required this.child,
    required this.size,
    this.padding = EdgeInsets.zero,
  });

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final contents = ConstrainedBox(
      constraints: BoxConstraints(
        minWidth: size.width,
        minHeight: size.height,
        maxWidth: size.width == 0 ? double.infinity : size.width,
        maxHeight: size.width == 0 ? double.infinity : size.height,
      ),
      child: Padding(
        padding: padding,
        child: Center(child: child),
      ),
    );
    final labelledContents = exposeButtonSemantics
        ? contents
        : Semantics(label: tooltip, excludeSemantics: true, child: contents);
    final control = TextButton(
      onPressed: onPressed,
      style: TextButton.styleFrom(
        padding: EdgeInsets.zero,
        minimumSize: Size.zero,
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        shape: const StadiumBorder(),
      ),
      child: labelledContents,
    );
    return Tooltip(
      message: tooltip,
      excludeFromSemantics: true,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(999),
        child: BackdropFilter(
          filter: ImageFilter.blur(sigmaX: 18, sigmaY: 18),
          child: Material(
            color: scheme.surface.withValues(alpha: 0.64),
            shape: StadiumBorder(
              side: BorderSide(color: scheme.outline.withValues(alpha: 0.55)),
            ),
            child: control,
          ),
        ),
      ),
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
