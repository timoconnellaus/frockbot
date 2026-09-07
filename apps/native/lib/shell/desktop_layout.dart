/// The shell's three responsive tiers.
///
/// The same three the Vue shell's stylesheet has, at the same two widths. Wide
/// enough and the shell is three columns — the Bot list, the conversation, and
/// whatever a feature registered into the right panel. Below 980 the right
/// panel stops being a column and becomes a drawer over the conversation,
/// because two columns plus a panel leaves the conversation too narrow to
/// read. Below 640 the Bot list goes the same way: a hand-held viewport has
/// room for exactly one column, and squeezing three into 390 points is how the
/// conversation ended up a hundred points wide with every label clipped.
///
/// Only one drawer is ever open. Opening either closes the other here, so
/// nothing below has to reason about them overlapping, and one scrim serves
/// whichever is open.
library;

import 'dart:math' show min;

import 'package:flutter/material.dart';

import '../theme/frock_theme.dart';
import 'semantics.dart';

/// The width at or below which the right panel is a drawer rather than a
/// column, matching the stylesheet's first breakpoint.
const double shellPanelInlineWidth = 980;

/// The width at or below which the Bot list is a drawer too.
const double shellSinglePaneWidth = 640;

/// How wide the Bot list is when it is a column, and when it is a drawer.
const double shellSidebarWidth = 288;
const double shellDrawerWidth = 312;

/// How wide the right panel is when it is a column.
const double shellRightPanelWidth = 380;

enum ShellTier {
  /// One column; both the Bot list and the right panel are drawers.
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
/// [navOpen] and [panelOpen] are the drawers' state and belong to the caller,
/// which is what lets a feature open the right panel from a message. At a tier
/// where a region is a column, the flag is ignored: the column is drawn
/// whenever a feature has filled it.
class ShellLayout extends StatelessWidget {
  final Widget sidebar;
  final Widget conversation;

  /// What the right panel holds, or null when no feature has filled it.
  final Widget? rightPanel;
  final bool navOpen;
  final bool panelOpen;
  final VoidCallback onDismiss;
  const ShellLayout({
    super.key,
    required this.sidebar,
    required this.conversation,
    required this.rightPanel,
    required this.navOpen,
    required this.panelOpen,
    required this.onDismiss,
  });

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) {
      final tier = shellTierForWidth(constraints.maxWidth);
      final panel = rightPanel;
      final inlineSidebar = tier != ShellTier.single;
      // At the widest tier the panel is a column, and a column a feature has
      // filled is simply there — the way the Vue shell's Bot panel is. The
      // open flag is a drawer's, and only the narrower tiers have one.
      final inlinePanel = tier == ShellTier.triple && panel != null;
      // A drawer is only ever asked to open at a tier where it is a drawer.
      final drawnNav = navOpen && !inlineSidebar;
      final drawnPanel = panelOpen && panel != null && !inlinePanel;
      final drawerWidth = tier == ShellTier.single
          ? constraints.maxWidth
          : shellRightPanelWidth;
      final divider = Theme.of(context).colorScheme.outlineVariant;
      return Stack(
        children: [
          Row(
            children: [
              if (inlineSidebar)
                _Column(
                  width: shellSidebarWidth,
                  border: Border(right: BorderSide(color: divider)),
                  child: identified(ShellIds.sidebar, sidebar),
                ),
              Expanded(child: identified(ShellIds.conversation, conversation)),
              if (inlinePanel)
                _Column(
                  width: shellRightPanelWidth,
                  border: Border(left: BorderSide(color: divider)),
                  child: identified(ShellIds.rightPanel, panel),
                ),
            ],
          ),
          _Scrim(open: drawnNav || drawnPanel, onDismiss: onDismiss),
          // A region is a column or a drawer, never both: building it twice
          // would put two of every control in the tree.
          if (!inlineSidebar)
            _Drawer(
              open: drawnNav,
              width: min(shellDrawerWidth, constraints.maxWidth),
              from: AxisDirection.left,
              child: identified(ShellIds.sidebar, sidebar),
            ),
          if (panel != null && !inlinePanel)
            _Drawer(
              open: drawnPanel,
              width: min(drawerWidth, constraints.maxWidth),
              from: AxisDirection.right,
              child: identified(ShellIds.rightPanel, panel),
            ),
        ],
      );
    },
  );
}

class _Column extends StatelessWidget {
  final double width;
  final Border border;
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
  final AxisDirection from;
  final Widget child;
  const _Drawer({
    required this.open,
    required this.width,
    required this.from,
    required this.child,
  });

  @override
  Widget build(BuildContext context) => Align(
    alignment: from == AxisDirection.left
        ? Alignment.centerLeft
        : Alignment.centerRight,
    child: AnimatedSlide(
      offset: open
          ? Offset.zero
          : Offset(from == AxisDirection.left ? -1 : 1, 0),
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
            child: ColoredBox(color: Colors.black.withValues(alpha: 0.45)),
          ),
        ),
      ),
    ),
  );
}
