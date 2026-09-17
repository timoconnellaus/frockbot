import 'package:flutter/widgets.dart';

/// Which press this card is waiting on, for the components that can say so.
///
/// One press at a time: the card is frozen while its POST is in flight, so a
/// second tap cannot mint a second command against the revision the first one
/// is about to move. The whole surface is held still by the renderer; a
/// component that draws its own controls — `ApprovalActions` — reads this as
/// well, so the control the person actually pressed says it is working rather
/// than simply stopping responding.
class CardPressScope extends InheritedWidget {
  /// The action name in flight, or null when the card is idle.
  final String? pending;
  const CardPressScope({
    super.key,
    required this.pending,
    required super.child,
  });

  static String? pendingOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<CardPressScope>()?.pending;

  @override
  bool updateShouldNotify(CardPressScope old) => pending != old.pending;
}
