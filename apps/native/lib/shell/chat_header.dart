import 'dart:async';
import 'dart:ui' show ImageFilter;

import 'package:flutter/material.dart' hide ConnectionState;

import '../client/chat_controller.dart';
import '../theme/controls.dart';
import '../theme/frock_theme.dart';
import '../voice/voice_mode.dart' show VoiceHeaderPill;
import 'semantics.dart';
import 'chat_icons.dart';
import 'desktop_layout.dart';

/// The blue a running Computer's icon wears: a cooler note beside the
/// accent, so "working" and "yours" never read as the same colour. It is
/// Chill's blue, so it still reads as one of the flock.
const computerRunningColor = Color(0xff59c7ff);

/// Silhouette height of the conversation companion. The empty canvas around
/// a still is clipped, so this is the drawing, not the frame.
const chatCompanionSize = 56.0;

/// The same companion on a phone, where the header shares the screen with a
/// thread that is only a thumb wide.
const chatCompanionPhoneSize = 40.0;

double chatCompanionSizeFor({required bool phone}) =>
    phone ? chatCompanionPhoneSize : chatCompanionSize;

/// Inset from the top of the header band to its row, and from the row to
/// the band's hairline.
const chatHeaderChromeTop = 14.0;

/// The same inset on a phone, where the band shares a thumb-wide screen.
const chatHeaderPhoneChromeTop = 10.0;

/// Inset from the conversation's left and right for the header's row.
const chatHeaderChromeSide = 16.0;

/// Space at the top of the thread, under the header band.
const chatHeaderThreadPadding = 12.0;

/// The band's least height at a desk, its hairline included. A column beside
/// the conversation draws its own header at exactly this height, so the two
/// lines meet.
const chatHeaderBandHeight = 88.0;

/// What the header says about the conversation's state, beside a dot.
enum ChatHeaderStatus { online, working, reconnecting, offline }

ChatHeaderStatus? chatHeaderStatusFor(
  ConnectionState connection, {
  required bool working,
}) => switch (connection) {
  ConnectionState.initializing => null,
  ConnectionState.reconnecting => ChatHeaderStatus.reconnecting,
  ConnectionState.disconnected ||
  ConnectionState.paused => ChatHeaderStatus.offline,
  ConnectionState.connected =>
    working ? ChatHeaderStatus.working : ChatHeaderStatus.online,
};

/// The conversation's title chrome.
///
/// On a call this is still an [AppBar]: the thread is gone, and the bar is
/// the name, a mark that says why, and the Computer. In a conversation it is
/// a band above the thread: the Bot's companion, its name with what it is
/// doing and its title under it, and the conversation's actions on the right.
/// A phone keeps Back and the panel switch, because the conversation is a
/// page over the list.
class ChatHeader extends StatelessWidget implements PreferredSizeWidget {
  final String name;
  final double textScale;

  /// The line under the name: the Bot's title, or who is in a group.
  final String? subtitle;

  /// Whether a Turn is running here, which the status line says.
  final bool working;

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

  /// Searches the conversations.
  final VoidCallback? onSearch;

  /// This Bot's actions — pin, mute, hide and the rest — the same menu its
  /// row in the list opens.
  final VoidCallback? onActions;

  /// Shows or hides the panel beside the conversation. On a phone it opens
  /// the Bot page, the same door the desk keeps on the far right.
  final VoidCallback? onTogglePanel;
  final bool panelShown;

  /// A Group Chat's members sheet, where a Bot's header has its panel.
  final VoidCallback? onMembers;

  /// Whether this Bot is the one on the call (ADR 0031). The bar keeps the
  /// name, a mark that says why the thread is gone, and the Computer: every
  /// other door leads out of a call that has no way out but ending it.
  final bool voiceMode;

  /// The Bot's companion, at the start of the band. Null in chrome-only
  /// tests.
  final Widget? companion;

  /// What sits under the band, in order: the conversation's notices, then a
  /// live call.
  final List<Widget> below;

  const ChatHeader({
    super.key,
    required this.name,
    this.textScale = 1,
    this.subtitle,
    this.working = false,
    this.phone = false,
    this.onBack,
    this.onOpenBot,
    this.onComputer,
    this.computerRunning = false,
    this.connection = ConnectionState.initializing,
    this.onSearch,
    this.onActions,
    this.onTogglePanel,
    this.panelShown = false,
    this.onMembers,
    this.voiceMode = false,
    this.companion,
    this.below = const [],
  });

  double get _toolbarHeight => 52 * textScale.clamp(1, 3);

  /// A call sits past the lights. A phone page drops a band of the same
  /// surface under them. A conversation beside the list does neither: its
  /// band is inside the conversation column.
  DesktopChrome get _chrome => voiceMode
      ? DesktopChrome.leading
      : phone
      ? DesktopChrome.titleBand
      : DesktopChrome.overlay;

  @override
  Size get preferredSize => voiceMode
      ? Size.fromHeight(_toolbarHeight + desktopChromeHeight(_chrome))
      : Size.zero;

  double get _actionExtent => chatControlExtent;

  double get _bandTop =>
      (phone ? chatHeaderPhoneChromeTop : chatHeaderChromeTop) +
      (phone && desktopTitleBarless ? desktopTitleBarBand : 0);

  @override
  Widget build(BuildContext context) =>
      voiceMode ? _bar(context) : _band(context);

  Widget _band(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final actions = [
      if (onComputer != null)
        identified(
          ShellIds.computerDestination,
          _action(
            'Computer',
            const ChatIcon(ChatIconKind.computer),
            onComputer,
            color: computerRunning ? computerRunningColor : null,
          ),
        ),
      if (onSearch != null)
        identified(
          ShellIds.headerSearch,
          _action('Search', const Icon(Icons.search_rounded), onSearch),
        ),
      if (onActions != null)
        identified(
          ShellIds.headerActions,
          _action(
            'More for $name',
            const Icon(Icons.more_horiz_rounded),
            onActions,
          ),
        ),
      if (onMembers != null)
        identified(
          GroupIds.membersButton,
          _action('Members', const Icon(Icons.group_outlined), onMembers),
        ),
      if (onTogglePanel != null)
        identified(
          ShellIds.rightPanelToggle,
          _action(
            panelShown ? 'Hide the panel' : 'Show the panel',
            const ChatIcon(ChatIconKind.panel),
            onTogglePanel,
          ),
        ),
    ];
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        DesktopWindowDragRegion(
          child: DecoratedBox(
            key: const ValueKey('chat-header-band'),
            decoration: BoxDecoration(
              color: scheme.surface,
              border: Border(
                bottom: BorderSide(color: FrockTheme.hairline(scheme)),
              ),
            ),
            child: Padding(
              padding: EdgeInsets.fromLTRB(
                chatHeaderChromeSide,
                _bandTop,
                chatHeaderChromeSide,
                phone ? chatHeaderPhoneChromeTop : chatHeaderChromeTop,
              ),
              child: ConstrainedBox(
                constraints: BoxConstraints(
                  minHeight: phone
                      ? 0
                      : chatHeaderBandHeight - 2 * chatHeaderChromeTop,
                ),
                child: Row(
                  children: [
                    if (onBack != null) ...[
                      identified(
                        ShellIds.sidebarToggle,
                        FrockIconButton(
                          tooltip: 'Your Bots',
                          onPressed: onBack,
                          extent: _actionExtent,
                          iconSize: chatIconSize,
                          icon: const Icon(Icons.arrow_back_rounded),
                        ),
                      ),
                      const SizedBox(width: 4),
                    ],
                    if (companion != null) ...[
                      IgnorePointer(child: companion!),
                      const SizedBox(width: 12),
                    ],
                    Expanded(child: _overlayName(context)),
                    for (final action in actions) ...[
                      const SizedBox(width: 8),
                      action,
                    ],
                  ],
                ),
              ),
            ),
          ),
        ),
        ...below,
      ],
    );
  }

  Widget _action(
    String label,
    Widget icon,
    VoidCallback? onPressed, {
    Color? color,
  }) => headerAction(
    tooltip: label,
    onPressed: onPressed,
    color: color,
    icon: icon,
  );

  /// The Bot's name, with what it is doing and its title under it. Where the
  /// shell opens the Bot page from the name, the name is that door.
  Widget _overlayName(BuildContext context) {
    final status = chatHeaderStatusFor(connection, working: working);
    if (onOpenBot != null) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          identified(
            ShellIds.botPanelToggle,
            _ChromePill(
              tooltip: 'Open $name',
              exposeButtonSemantics: true,
              onPressed: onOpenBot,
              padding: const EdgeInsets.fromLTRB(14, 0, 12, 0),
              size: Size(0, chatDesktopChrome ? 40 : 44),
              child: _title(context, chevron: true, flexible: true),
            ),
          ),
          if (status != null) ...[
            const SizedBox(height: 2),
            _StatusLine(status: status),
          ],
        ],
      );
    }
    final theme = Theme.of(context);
    final line = subtitle?.trim();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        _title(context, chevron: false, flexible: true, prominent: true),
        if (status != null) ...[
          const SizedBox(height: 1),
          _StatusLine(status: status),
        ],
        if (!phone && line != null && line.isNotEmpty) ...[
          const SizedBox(height: 1),
          Text(
            line,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: theme.textTheme.bodySmall?.copyWith(
              fontSize: 12.5,
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
        ],
      ],
    );
  }

  Widget _title(
    BuildContext context, {
    required bool chevron,
    bool flexible = false,
    bool prominent = false,
  }) {
    final scheme = Theme.of(context).colorScheme;
    final text = Text(
      name,
      maxLines: prominent ? 1 : 2,
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

/// The header of the column beside the conversation: what it is showing,
/// the way back, and its own controls. The chat header's band at the same
/// height, so the column and the conversation share one line under them.
class PanelHeader extends StatelessWidget {
  /// The way back to the page under this one, or the face of what is shown.
  final Widget? leading;
  final Widget title;
  final List<Widget> actions;
  const PanelHeader({
    super.key,
    this.leading,
    required this.title,
    this.actions = const [],
  });

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return DesktopWindowDragRegion(
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: scheme.surface,
          border: Border(
            bottom: BorderSide(color: FrockTheme.hairline(scheme)),
          ),
        ),
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: chatHeaderBandHeight),
          child: Padding(
            padding: EdgeInsets.fromLTRB(leading == null ? 16 : 8, 8, 12, 8),
            child: Row(
              children: [
                if (leading case final Widget start) ...[
                  start,
                  const SizedBox(width: 8),
                ],
                Expanded(
                  child: DefaultTextStyle.merge(
                    style: Theme.of(context).textTheme.titleMedium,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    child: title,
                  ),
                ),
                for (final action in actions) ...[
                  const SizedBox(width: 8),
                  action,
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// One of a header's controls: a glyph in a hairline frame.
Widget headerAction({
  Key? key,
  required String tooltip,
  required Widget icon,
  required VoidCallback? onPressed,
  Color? color,
}) => FrockIconButton(
  key: key,
  kind: FrockIconButtonKind.outlined,
  tooltip: tooltip,
  onPressed: onPressed,
  extent: chatControlExtent,
  iconSize: chatIconSize,
  color: color,
  icon: icon,
);

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

/// What the conversation is doing, beside a dot: online, working, gone
/// quiet. Reconnecting waits a moment before it says so, because most
/// reconnects are over before anyone would read it.
class _StatusLine extends StatelessWidget {
  final ChatHeaderStatus status;
  const _StatusLine({required this.status});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    if (status == ChatHeaderStatus.reconnecting) {
      return const _DelayedConnectionDot(label: 'Reconnecting…');
    }
    final (colour, label) = switch (status) {
      ChatHeaderStatus.online => (FrockTheme.success, 'Online'),
      ChatHeaderStatus.working => (theme.colorScheme.primary, 'Working…'),
      ChatHeaderStatus.offline => (
        theme.colorScheme.onSurfaceVariant,
        'Offline',
      ),
      ChatHeaderStatus.reconnecting => (FrockTheme.warning, 'Reconnecting…'),
    };
    return Row(
      key: ValueKey('chat-status-${status.name}'),
      mainAxisSize: MainAxisSize.min,
      children: [
        StatusDot(color: colour),
        const SizedBox(width: 6),
        Flexible(
          child: Text(
            label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: _statusStyle(theme),
          ),
        ),
      ],
    );
  }
}

TextStyle? _statusStyle(ThemeData theme) => theme.textTheme.bodySmall?.copyWith(
  fontSize: 12.5,
  color: theme.colorScheme.onSurfaceVariant,
);

class _DelayedConnectionDot extends StatefulWidget {
  /// Said beside the dot, where there is room for words.
  final String? label;
  const _DelayedConnectionDot({this.label});

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
    final dot = Semantics(
      container: true,
      liveRegion: true,
      label: 'Updating conversation',
      child: Tooltip(
        message: 'Updating conversation',
        excludeFromSemantics: true,
        child: FadeTransition(
          key: const ValueKey('conversation-update'),
          opacity: opacity,
          child: const StatusDot(color: FrockTheme.warning, size: 8),
        ),
      ),
    );
    final label = widget.label;
    if (label == null) return dot;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        dot,
        const SizedBox(width: 6),
        Flexible(
          child: Text(
            label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: _statusStyle(Theme.of(context)),
          ),
        ),
      ],
    );
  }

  @override
  void dispose() {
    delay?.cancel();
    pulse.dispose();
    super.dispose();
  }
}
