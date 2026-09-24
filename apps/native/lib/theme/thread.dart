import 'package:flutter/material.dart';

import 'frock_theme.dart';

/// The widest a message grows, however wide the thread is.
const messageMaxWidth = 720.0;

/// One message in a thread: the person's on the right in grey, anyone else's
/// on the left on the raised surface under a hairline.
///
/// [time] sits inside the top of someone else's message and above the
/// person's own. [label] names the sender above the bubble, for a thread with
/// more than one other voice.
class MessageBubble extends StatelessWidget {
  final bool mine;
  final Widget child;
  final String? time;
  final Widget? label;

  /// Rises into place the first time it is drawn.
  final bool animate;

  /// Who is speaking, for a screen reader.
  final String? semanticsLabel;

  const MessageBubble({
    super.key,
    required this.mine,
    required this.child,
    this.time,
    this.label,
    this.animate = false,
    this.semanticsLabel,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final look = theme.extension<FrockLook>();
    final line = look?.bubbleLine(mine: mine);
    final timeStyle = theme.textTheme.bodySmall?.copyWith(
      fontFeatures: FrockTheme.tabularFigures,
    );
    final ink = look?.bubbleInk(mine: mine);
    Widget body = DefaultTextStyle.merge(
      style: FrockTheme.message(theme).copyWith(color: ink),
      child: semanticsLabel == null
          ? child
          : Semantics(label: semanticsLabel, child: child),
    );
    if (time != null && !mine) {
      body = Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(time!, style: timeStyle),
          const SizedBox(height: 4),
          body,
        ],
      );
    }
    final bubble = Container(
      constraints: const BoxConstraints(maxWidth: messageMaxWidth),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 11),
      decoration: BoxDecoration(
        color:
            look?.bubbleFill(mine: mine) ??
            theme.colorScheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(FrockTheme.radiusBubble),
        border: line == null ? null : Border.all(color: line),
      ),
      child: body,
    );
    final above = [
      if (label case final Widget name) name,
      if (time != null && mine) Text(time!, style: timeStyle),
    ];
    final Widget drawn = Padding(
      padding: EdgeInsets.fromLTRB(mine ? 64 : 20, 5, mine ? 20 : 64, 5),
      child: Column(
        crossAxisAlignment: mine
            ? CrossAxisAlignment.end
            : CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          for (final item in above) ...[item, const SizedBox(height: 4)],
          bubble,
        ],
      ),
    );
    if (!animate) return drawn;
    return TweenAnimationBuilder<double>(
      tween: Tween(begin: 0, end: 1),
      duration: FrockTheme.motion(context),
      curve: Curves.easeOutCubic,
      builder: (context, value, child) => Opacity(
        opacity: (0.7 + value * 0.3).clamp(0.0, 1.0),
        child: Transform.translate(
          offset: Offset(0, 6 * (1 - value)),
          child: child,
        ),
      ),
      child: drawn,
    );
  }
}

/// Where the unread messages begin: a rule in the accent with its words in
/// the middle.
class UnreadDivider extends StatelessWidget {
  const UnreadDivider({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final rule = theme.colorScheme.primary;
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 10, 20, 6),
      child: Row(
        children: [
          Expanded(child: Divider(color: rule, height: 1)),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 10),
            child: Text(
              'Unread from here',
              style: theme.textTheme.labelSmall?.copyWith(
                color: FrockTheme.accentInk(theme),
                letterSpacing: 0.3,
              ),
            ),
          ),
          Expanded(child: Divider(color: rule, height: 1)),
        ],
      ),
    );
  }
}

/// The way to older messages, at the far end of a thread.
class EarlierMessages extends StatelessWidget {
  final VoidCallback? onPressed;
  final bool loading;
  const EarlierMessages({
    super.key,
    required this.onPressed,
    this.loading = false,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: TextButton(
        onPressed: loading ? null : onPressed,
        style: TextButton.styleFrom(
          foregroundColor: theme.colorScheme.onSurfaceVariant,
          textStyle: theme.textTheme.labelMedium,
          minimumSize: const Size(0, 32),
        ),
        child: Text(loading ? 'Loading…' : 'Earlier messages'),
      ),
    );
  }
}

/// A one-line mark in the thread that is not a message — another Bot was
/// asked something, a call happened — centred, quiet, and the way into it.
class ThreadMarker extends StatelessWidget {
  final String? identifier;
  final Key? tapKey;
  final VoidCallback? onTap;
  final List<Widget> children;
  const ThreadMarker({
    super.key,
    this.identifier,
    this.tapKey,
    required this.onTap,
    required this.children,
  });

  /// The marker's connecting words.
  static TextStyle? quiet(ThemeData theme) =>
      theme.textTheme.bodySmall?.copyWith(
        color: theme.colorScheme.onSurfaceVariant.withValues(alpha: 0.8),
      );

  /// A name in the marker.
  static TextStyle? named(ThemeData theme) =>
      theme.textTheme.bodySmall?.copyWith(
        color: theme.colorScheme.onSurfaceVariant,
        fontWeight: FontWeight.w500,
      );

  @override
  Widget build(BuildContext context) {
    final radius = BorderRadius.circular(FrockTheme.radiusPill);
    final pill = Material(
      color: Colors.transparent,
      borderRadius: radius,
      child: InkWell(
        key: tapKey,
        borderRadius: radius,
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
          child: Wrap(
            crossAxisAlignment: WrapCrossAlignment.center,
            spacing: 6,
            runSpacing: 2,
            children: children,
          ),
        ),
      ),
    );
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 6),
      child: Center(
        child: identifier == null
            ? pill
            : Semantics(identifier: identifier, child: pill),
      ),
    );
  }
}

/// The action beside a notice in the thread — Retry, Open Billing, Undo —
/// written in the accent with its glyph.
class ThreadLink extends StatelessWidget {
  final IconData icon;
  final String label;
  final VoidCallback onTap;
  const ThreadLink({
    super.key,
    required this.icon,
    required this.label,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final ink = FrockTheme.accentInk(theme);
    return InkWell(
      borderRadius: BorderRadius.circular(8),
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.all(4),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 15, color: ink),
            const SizedBox(width: 4),
            Text(
              label,
              style: theme.textTheme.labelMedium?.copyWith(
                color: ink,
                fontWeight: FontWeight.w600,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// A thread with nothing in it yet: a heading, a line under it, and what it
/// offers to start with.
class EmptyThread extends StatelessWidget {
  final String title;
  final String detail;
  final Widget? child;
  const EmptyThread({
    super.key,
    required this.title,
    required this.detail,
    this.child,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.all(32),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: theme.textTheme.headlineMedium),
          const SizedBox(height: 8),
          Text(
            detail,
            style: theme.textTheme.bodyMedium?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
          if (child case final Widget more) ...[
            const SizedBox(height: 16),
            more,
          ],
        ],
      ),
    );
  }
}
