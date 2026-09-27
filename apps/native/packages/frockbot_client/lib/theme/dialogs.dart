/// One shape for every question a Bot asks before it changes.
///
/// A dialog with no maximum grows to its longest sentence, which is how the
/// same three confirmations came out 690, 765 and 897 points wide on a desktop
/// and 280 for the label picker. A confirmation is a sentence and two buttons,
/// so it is always the same column: 400 wide where there is room, and inset by
/// 24 where there is not, which is 342 on a 390-point phone.
library;

import 'package:flutter/material.dart';

/// How wide a Bot confirmation is at its widest.
const double frockDialogWidth = 400;

/// What a dialog leaves at each edge, which is what decides its width on a
/// phone. Material's own 40 would leave 310 there.
const frockDialogInset = EdgeInsets.symmetric(horizontal: 24, vertical: 24);

/// What an [AlertDialog] puts either side of its content and its title.
const double _frockDialogPadding = 24;

/// Gives a dialog's body the one width, so the dialog around it is
/// [frockDialogWidth]. A dialog sizes itself to its widest child, so this is
/// where the width is decided — and a window narrower than that still wins,
/// because a constraint handed down from the window is enforced over this one.
Widget frockDialogBody(Widget child) => ConstrainedBox(
  constraints: BoxConstraints.tightFor(
    width: frockDialogWidth - _frockDialogPadding * 2,
  ),
  child: child,
);

/// Gives a dialog's title the same width as its body.
///
/// An [AlertDialog] is as wide as the widest of its title, its content and its
/// actions, and a title is one unwrapped line however long the Bot's name is —
/// so the body's width is a floor until the title is held to it too, and a
/// long name is where a confirmation came out 700 wide.
Widget frockDialogTitle(Widget child) => frockDialogBody(child);
