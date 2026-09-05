import 'package:flutter/material.dart';

import 'frock_tokens.dart';
import 'frock_widgets.dart';

/// A secondary screen: the bar with a way back, a name in the middle, at most
/// one action on the right, and the content bounded to a readable width. Every
/// screen that is not the room (Applets, Inbox, Settings) sits in this frame so
/// the way back and the width feel the same wherever the User goes.
class FrockPage extends StatelessWidget {
  const FrockPage({
    super.key,
    required this.title,
    required this.child,
    this.trailing,
    this.maxWidth = 680,
    this.padded = true,
  });
  final String title;
  final Widget child;
  final Widget? trailing;
  final double maxWidth;

  /// Content gets the page edge unless it manages its own (a WebView, a list
  /// that scrolls under the bar).
  final bool padded;

  @override
  Widget build(BuildContext context) {
    final t = FrockTokens.of(context);
    final navigator = Navigator.of(context);
    return Scaffold(
      backgroundColor: t.window,
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 6),
              child: FrockBar(
                leading: navigator.canPop()
                    ? FrockIconButton(
                        Icons.arrow_back_rounded,
                        key: const ValueKey('back'),
                        semanticLabel: 'Back',
                        onTap: navigator.pop,
                      )
                    : null,
                title: Text(
                  title,
                  style: t.barTitle,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                trailing: trailing,
              ),
            ),
            Expanded(
              child: Center(
                child: ConstrainedBox(
                  constraints: BoxConstraints(maxWidth: maxWidth),
                  child: padded
                      ? Padding(
                          padding: const EdgeInsets.fromLTRB(
                            FrockTokens.edge,
                            8,
                            FrockTokens.edge,
                            FrockTokens.edge,
                          ),
                          child: child,
                        )
                      : child,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// A short paragraph under an eyebrow: the page explaining itself once.
class FrockLead extends StatelessWidget {
  const FrockLead(this.text, {super.key});
  final String text;
  @override
  Widget build(BuildContext context) {
    final t = FrockTokens.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: FrockTokens.groupGap),
      child: Text(text, style: t.body.copyWith(color: t.ink2)),
    );
  }
}

/// A notice: a title, its body, when it happened, and what the User can do
/// about it. Lives inside a [FrockGroup] with its siblings.
class FrockNotice extends StatelessWidget {
  const FrockNotice({
    super.key,
    required this.title,
    required this.body,
    this.stamp,
    this.actions = const [],
  });
  final String title;
  final String body;
  final String? stamp;
  final List<Widget> actions;
  @override
  Widget build(BuildContext context) {
    final t = FrockTokens.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(child: Text(title, style: t.row)),
              if (stamp != null) ...[
                const SizedBox(width: 12),
                Text(stamp!, style: t.caption),
              ],
            ],
          ),
          const SizedBox(height: 6),
          Text(body, style: t.body),
          if (actions.isNotEmpty) ...[
            const SizedBox(height: 12),
            Wrap(spacing: 8, runSpacing: 8, children: actions),
          ],
        ],
      ),
    );
  }
}
