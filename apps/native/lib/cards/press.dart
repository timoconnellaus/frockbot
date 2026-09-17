import 'package:flutter/widgets.dart';

/// The press this card is waiting on, as the host knows it.
///
/// A component that draws its own controls needs more than the action name to
/// tell its controls apart: `ApprovalActions` dispatches one name for both
/// buttons and separates them by the decision it carries. So the scope names
/// the press whole — the action, the component that raised it, and the context
/// that went with it — and a component decides for itself which of its controls
/// that was.
@immutable
class CardPress {
  /// The action name in flight.
  final String name;

  /// The component that raised it, so two components dispatching one name are
  /// still two presses.
  final String? componentId;

  /// What the control sent with it. `ApprovalActions` reads its `decision`.
  final Map<String, Object?>? context;
  const CardPress({required this.name, this.componentId, this.context});
}

/// Which press this card is waiting on, for the components that can say so.
///
/// One press at a time: the card is frozen while its POST is in flight, so a
/// second tap cannot mint a second command against the revision the first one
/// is about to move. The whole surface is held still by the renderer; a
/// component that draws its own controls — `ApprovalActions` — reads this as
/// well, so the control the person actually pressed says it is working while
/// its siblings simply stop responding.
class CardPressScope extends InheritedWidget {
  /// The press in flight, or null when the card is idle.
  final CardPress? pending;
  const CardPressScope({
    super.key,
    required this.pending,
    required super.child,
  });

  static CardPress? pendingOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<CardPressScope>()?.pending;

  @override
  bool updateShouldNotify(CardPressScope old) => pending != old.pending;
}
