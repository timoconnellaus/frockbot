/// Where the caret sits at the end of a line.
library;

import 'package:flutter/material.dart';

/// A text field whose caret stands after the last letter rather than through
/// it.
///
/// On Apple platforms Material draws the caret two device pixels left of where
/// the text ends and paints it over the glyphs, which native AppKit fields can
/// afford because their letters stop inside their advance. Inter's `f` leans
/// past its own, so the caret lands on the hook and the last letter of a draft
/// is unreadable while it is being typed.
///
/// The nudge is `-2 / devicePixelRatio` and [TextField] offers no way to set
/// it, so the field is handed a ratio the nudge rounds away in. Nothing under
/// a text field reads the ratio for anything else, and on a platform without
/// the nudge this is not in the tree at all.
class SteadyCaret extends StatelessWidget {
  final Widget child;
  const SteadyCaret({super.key, required this.child});

  @override
  Widget build(BuildContext context) {
    final platform = Theme.of(context).platform;
    final nudged =
        platform == TargetPlatform.iOS || platform == TargetPlatform.macOS;
    if (!nudged) return child;
    return MediaQuery(
      data: MediaQuery.of(context).copyWith(devicePixelRatio: 1e6),
      child: child,
    );
  }
}
