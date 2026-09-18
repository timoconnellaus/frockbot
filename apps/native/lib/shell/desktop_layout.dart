/// The shell's three responsive tiers.
///
/// Three tiers at two widths. Wide enough and the shell is three columns — the
/// Bot list, the conversation, and whatever a feature registered into the right
/// panel. Below 980 the right panel stops being a column and becomes a drawer
/// over the conversation, because two columns plus a panel leaves the
/// conversation too narrow to read. Below 640 there is room for exactly one
/// column, and the shell stops being columns at all: the Bot list is the first
/// screen, a conversation is a page over it, and the way back is the way back.
/// Squeezing three columns into 390 points is how the conversation ended up a
/// hundred points wide with every label clipped, and a Bot list kept in a
/// drawer beside the conversation was a second door to the same room.
library;

import 'dart:math' show max, min;

import 'package:flutter/foundation.dart' show defaultTargetPlatform, kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme/frock_theme.dart';
import 'semantics.dart';

/// Whether this is the Mac app, whose window has no title bar: the app keeps
/// a strip across the top of the window clear for the traffic lights, and
/// every page starts below it.
bool get desktopTitleBarless =>
    !kIsWeb && defaultTargetPlatform == TargetPlatform.macOS;

/// How tall that strip is. The traffic lights sit 12 points from the top of
/// a title-less window and are 12 points tall; the strip is what a
/// title bar would have been, so the eye finds them where it expects to.
const double desktopTitleBarInset = 28;

/// The window's own gestures, which Flutter cannot perform itself: dragging
/// the window by the strip where its title bar was, and zooming on a
/// double-click there.
abstract final class DesktopWindow {
  static const _channel = MethodChannel('com.frockbot/window');
  static Future<void> startDrag() async {
    try {
      await _channel.invokeMethod<void>('startDrag');
    } on MissingPluginException {
      // A host without the channel — a test, the web — has no window to move.
    }
  }

  static Future<void> zoom() async {
    try {
      await _channel.invokeMethod<void>('zoom');
    } on MissingPluginException {
      // As above.
    }
  }
}

/// The title bar's height, told to every page as a top inset.
///
/// A title-less window has no status bar to report, so nothing under the
/// app knew the traffic lights were there: a page pushed over the shell put
/// its back arrow and its title in the top-left corner, under them. This
/// says the strip is not the page's, the way a phone's status bar is not,
/// and every `AppBar` and `SafeArea` below it moves down by itself. On any
/// other platform it is the child, untouched — a phone keeps its own insets
/// and gains none.
///
/// The strip itself is drawn here too, over the whole width of the window
/// and nothing else: because every page keeps out of the inset, the strip
/// covers no control, and the window follows a drag that starts anywhere
/// along its top and zooms on a double-click there, the way a Mac window
/// with a title bar does — on the shell and on any page over it alike.
class DesktopTitleBarPadding extends StatelessWidget {
  final Widget child;
  const DesktopTitleBarPadding({super.key, required this.child});

  @override
  Widget build(BuildContext context) {
    if (!desktopTitleBarless) return child;
    final media = MediaQuery.of(context);
    return MediaQuery(
      data: media.copyWith(
        padding: media.padding.copyWith(
          top: max(media.padding.top, desktopTitleBarInset),
        ),
        viewPadding: media.viewPadding.copyWith(
          top: max(media.viewPadding.top, desktopTitleBarInset),
        ),
      ),
      child: Stack(
        fit: StackFit.expand,
        children: [
          child,
          const Positioned(
            top: 0,
            left: 0,
            right: 0,
            height: desktopTitleBarInset,
            child: DesktopTitleStrip(),
          ),
        ],
      ),
    );
  }
}

/// The strip across the top of the window where the title bar was. Empty, so
/// the traffic lights have the room they need; the window follows a drag that
/// starts on it and zooms on a double-click, over the channel the Mac window
/// answers. Drawn once, by [DesktopTitleBarPadding], above every page.
class DesktopTitleStrip extends StatelessWidget {
  const DesktopTitleStrip({super.key});

  @override
  Widget build(BuildContext context) => GestureDetector(
    behavior: HitTestBehavior.opaque,
    onPanStart: (_) => DesktopWindow.startDrag(),
    onDoubleTap: DesktopWindow.zoom,
    child: const SizedBox(height: desktopTitleBarInset, width: double.infinity),
  );
}

/// The width at or below which the right panel is a drawer rather than a
/// column, matching the stylesheet's first breakpoint.
const double shellPanelInlineWidth = 980;

/// The width at or below which the shell is one column.
const double shellSinglePaneWidth = 640;

/// How wide the Bot list is when it is a column.
const double shellSidebarWidth = 288;

/// How wide the right panel is when it is a column.
const double shellRightPanelWidth = 380;

enum ShellTier {
  /// One column: the Bot list, or the conversation over it.
  single,

  /// The Bot list and the conversation; the right panel is a drawer.
  dual,

  /// The Bot list, the conversation and the right panel, all three drawn.
  triple,
}

ShellTier shellTierForWidth(double width) => width <= shellSinglePaneWidth
    ? ShellTier.single
    : width <= shellPanelInlineWidth
    ? ShellTier.dual
    : ShellTier.triple;

/// Lays the shell out for the width it is given.
///
/// [panelOpen] is the right-panel drawer's state and belongs to the caller,
/// which is what lets a feature open the right panel from a message. At a tier
/// where the panel is a column, the flag is ignored: the column is drawn
/// whenever a feature has filled it, unless the person has [panelCollapsed]
/// it — the column's own state, so that closing the drawer at one width does
/// not take the column away at another.
///
/// [conversationOpen] matters only at the single tier, where the Bot list is
/// the root and the conversation is a page over it. The system Back gesture
/// from that page calls [onBack] rather than leaving the app.
class ShellLayout extends StatelessWidget {
  final PreferredSizeWidget? header;
  final Widget sidebar;
  final Widget conversation;

  /// What the right panel holds, or null when no feature has filled it.
  final Widget? rightPanel;

  /// When set, the panel (column or drawer) paints this Bot's look. Inherit
  /// leaves this null so the panel stays on the account Theme.
  final ThemeData? panelTheme;
  final bool panelOpen;
  final bool panelCollapsed;
  final VoidCallback onDismiss;
  final bool conversationOpen;
  final VoidCallback onBack;

  /// Whether the Bot on screen is in voice mode (ADR 0029).
  ///
  /// The way out of a Bot is to end the call first, so Back does that
  /// instead of leaving the page — including the Android system gesture,
  /// which is the one people reach for and must not be swallowed.
  final bool voiceMode;
  final VoidCallback? onEndVoice;
  const ShellLayout({
    super.key,
    this.header,
    required this.sidebar,
    required this.conversation,
    required this.rightPanel,
    this.panelTheme,
    required this.panelOpen,
    this.panelCollapsed = false,
    required this.onDismiss,
    required this.conversationOpen,
    required this.onBack,
    this.voiceMode = false,
    this.onEndVoice,
  });

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) {
      final tier = shellTierForWidth(constraints.maxWidth);
      if (tier == ShellTier.single) return _single(context);
      final panel = rightPanel;
      // At the widest tier the panel is a column, and a column a feature has
      // filled is simply there. The open flag is a drawer's, and only the
      // dual tier has one.
      final inlinePanel =
          tier == ShellTier.triple && panel != null && !panelCollapsed;
      // The drawer, its scrim and its focus trap are the dual tier's alone: a
      // collapsed column at the widest tier is simply gone, not a drawer
      // waiting under a scrim.
      final drawnPanel = tier == ShellTier.dual && panelOpen && panel != null;
      final divider = FrockTheme.hairline(
        (panelTheme ?? Theme.of(context)).colorScheme,
      );
      return PopScope(
        canPop: !drawnPanel && !voiceMode,
        onPopInvokedWithResult: (didPop, _) {
          if (didPop) return;
          if (drawnPanel) {
            onDismiss();
            return;
          }
          if (voiceMode) onEndVoice?.call();
        },
        child: Stack(
          fit: StackFit.expand,
          children: [
            ExcludeFocus(
              excluding: drawnPanel,
              child: ExcludeSemantics(
                excluding: drawnPanel,
                child: Scaffold(
                  body: SafeArea(
                    bottom: false,
                    child: Row(
                      children: [
                        // In voice mode the Bot fills the window (ADR 0029):
                        // the list of every other Bot is not what the person
                        // is doing, and the call is.
                        _Column(
                          width: voiceMode ? 0 : shellSidebarWidth,
                          border: voiceMode
                              ? null
                              : Border(right: BorderSide(color: divider)),
                          // The Mac's title strip is the app's inset now
                          // ([DesktopTitleBarPadding]), read by the safe area
                          // above; the column draws nothing for it.
                          child: SafeArea(
                            top: false,
                            child: identified(ShellIds.sidebar, sidebar),
                          ),
                        ),
                        // The header is the conversation's, not the window's:
                        // a bar named after one Bot that ran over the list of
                        // all of them read as the list being inside that Bot.
                        Expanded(
                          child: Scaffold(
                            appBar: header,
                            body: SizedBox.expand(
                              child: identified(
                                ShellIds.conversation,
                                conversation,
                              ),
                            ),
                          ),
                        ),
                        if (inlinePanel)
                          _withPanelTheme(
                            _Column(
                              width: shellRightPanelWidth,
                              border: Border(left: BorderSide(color: divider)),
                              child: SafeArea(
                                top: false,
                                child: identified(ShellIds.rightPanel, panel),
                              ),
                            ),
                          ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
            Positioned.fill(
              child: _Scrim(open: drawnPanel, onDismiss: onDismiss),
            ),
            if (panel != null && tier == ShellTier.dual)
              _withPanelTheme(
                _Drawer(
                  open: drawnPanel,
                  width: min(shellRightPanelWidth, constraints.maxWidth),
                  child: identified(ShellIds.rightPanel, panel),
                ),
              ),
          ],
        ),
      );
    },
  );

  Widget _withPanelTheme(Widget child) {
    final theme = panelTheme;
    if (theme == null) return child;
    return Theme(
      key: const ValueKey('panel-theme'),
      data: theme,
      child: ColoredBox(
        color: theme.scaffoldBackgroundColor,
        child: child,
      ),
    );
  }

  /// One column. The Bot list is the root page; the conversation slides over
  /// it and Back slides it away. The right panel's entries are pages of their
  /// own at this width, so there is no drawer to reason about.
  Widget _single(BuildContext context) => PopScope(
    canPop: !conversationOpen && !voiceMode,
    onPopInvokedWithResult: (didPop, _) {
      if (didPop) return;
      // In voice mode the gesture ends the call rather than leaving the Bot:
      // to leave, you hang up first.
      if (voiceMode) {
        onEndVoice?.call();
        return;
      }
      if (conversationOpen) onBack();
    },
    child: _PageSwitch(
      forward: conversationOpen,
      child: conversationOpen
          ? Scaffold(
              key: const ValueKey('conversation'),
              appBar: header,
              body: SafeArea(
                top: header == null,
                // The composer paints through the gesture inset itself.
                bottom: false,
                child: SizedBox.expand(
                  child: identified(ShellIds.conversation, conversation),
                ),
              ),
            )
          : Scaffold(
              key: const ValueKey('bots'),
              body: SafeArea(
                child: SizedBox.expand(
                  child: identified(ShellIds.sidebar, sidebar),
                ),
              ),
            ),
    ),
  );
}

/// A push-and-pop between two pages, drawn in place. The page coming in slides
/// from the side it lives on and the page going out makes room, the way a
/// route transition does — but both pages are this widget's children, so the
/// shell keeps one state for both rather than one per route.
class _PageSwitch extends StatelessWidget {
  final bool forward;
  final Widget child;
  const _PageSwitch({required this.forward, required this.child});

  @override
  Widget build(BuildContext context) => AnimatedSwitcher(
    duration: FrockTheme.motion(context),
    switchInCurve: Curves.easeOutCubic,
    switchOutCurve: Curves.easeInCubic,
    layoutBuilder: (current, previous) =>
        Stack(fit: StackFit.expand, children: [...previous, ?current]),
    transitionBuilder: (page, animation) {
      final entering = page.key == child.key;
      // Forward: the conversation enters from the right and the list parks a
      // little to the left. Back: the reverse of both.
      final side = forward == entering
          ? const Offset(1, 0)
          : const Offset(-0.25, 0);
      return SlideTransition(
        position: Tween(begin: side, end: Offset.zero).animate(animation),
        child: page,
      );
    },
    child: child,
  );
}

class _Column extends StatelessWidget {
  final double width;

  /// Absent for a column that is collapsed to nothing: a hairline with no
  /// column beside it is a stray line down the window.
  final Border? border;
  final Widget child;
  const _Column({
    required this.width,
    required this.border,
    required this.child,
  });

  @override
  Widget build(BuildContext context) => DecoratedBox(
    decoration: BoxDecoration(border: border),
    child: SizedBox(width: width, child: child),
  );
}

/// A parked drawer is inert as well as off-canvas: not something to tab into,
/// read out, hit-test or animate inside. It stays mounted so that opening it
/// is a slide rather than a rebuild.
class _Drawer extends StatelessWidget {
  final bool open;
  final double width;
  final Widget child;
  const _Drawer({required this.open, required this.width, required this.child});

  @override
  Widget build(BuildContext context) => Align(
    alignment: Alignment.centerRight,
    child: AnimatedSlide(
      offset: open ? Offset.zero : const Offset(1, 0),
      duration: FrockTheme.motion(context),
      curve: Curves.easeOutCubic,
      child: TickerMode(
        enabled: open,
        child: ExcludeSemantics(
          excluding: !open,
          child: IgnorePointer(
            ignoring: !open,
            child: Material(
              color: Theme.of(context).colorScheme.surface,
              elevation: open ? 8 : 0,
              child: SizedBox(
                width: width,
                child: SafeArea(child: child),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

class _Scrim extends StatelessWidget {
  final bool open;
  final VoidCallback onDismiss;
  const _Scrim({required this.open, required this.onDismiss});

  @override
  Widget build(BuildContext context) => IgnorePointer(
    ignoring: !open,
    child: AnimatedOpacity(
      opacity: open ? 1 : 0,
      duration: FrockTheme.motion(context),
      child: identified(
        ShellIds.scrim,
        Semantics(
          label: 'Close',
          button: true,
          child: GestureDetector(
            onTap: onDismiss,
            behavior: HitTestBehavior.opaque,
            // Sized by the fill above rather than by a child. A `ColoredBox`
            // with no child takes the smallest size its constraints allow, and
            // a `Stack`'s non-positioned children are loosely constrained — so
            // an unpositioned scrim is 0x0: it never dims anything, never takes
            // a tap, and is dropped from the accessibility tree for having no
            // area. Tapping the conversation beside an open drawer did nothing.
            child: ColoredBox(color: Colors.black.withValues(alpha: 0.45)),
          ),
        ),
      ),
    ),
  );
}
