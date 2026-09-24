/// What the host knows about the apps a card's `ConnectApp` offers.
///
/// `ConnectApp` is trust chrome: the kernel names the app from its own
/// catalog, and the host draws the button. The press is not a Card action —
/// nothing about it goes to the Bot. It opens the app's hosted sign-in under
/// the person's own session, the same door Connect in the Marketplace opens,
/// because connecting an app is the User granting and never the Bot.
///
/// And the card has to say what happened. A person who signed in and came
/// back should see the app connected, not the same live button; so, like
/// `ApprovalActions`, the component reads the answer from the account itself
/// rather than from the Card, which never moves when a Connection does.
library;

import 'package:flutter/widgets.dart';

/// One app, as the account and this client know it.
@immutable
class CardConnectionStateV1 {
  /// Accounts of this app the person holds that are working.
  final int ready;

  /// Whether this client is opening the app's sign-in right now.
  final bool opening;

  /// Whether the sign-in was opened in the browser and has not been read
  /// back yet: the person is, or was, on the app's own page.
  final bool opened;

  /// Why the last press did not open anything, in words for the person.
  final String? failure;
  const CardConnectionStateV1({
    this.ready = 0,
    this.opening = false,
    this.opened = false,
    this.failure,
  });
}

/// The account's Connections, and the door that adds one.
///
/// A `Listenable`, because a Connection lands after the card was drawn — the
/// person comes back from the app's page — and the component drawing it has
/// to be told.
abstract interface class CardConnectionsV1 implements Listenable {
  /// What is known about one Connection Type, or null before the first read
  /// lands — or in a deployment where it cannot be read.
  CardConnectionStateV1? connectionStateV1(String connectionTypeId);

  /// Opens the hosted sign-in for one Connection Type.
  Future<void> connectV1({
    required String packageId,
    required String connectionTypeId,
  });
}

/// How `ConnectApp` reaches them.
///
/// Absent in a context with no signed-in account — a test, a preview — where
/// the card draws the app and a button that cannot be pressed.
class CardConnectionsScope extends InheritedNotifier<CardConnectionsV1> {
  const CardConnectionsScope({
    super.key,
    required CardConnectionsV1? connections,
    required super.child,
  }) : super(notifier: connections);

  static CardConnectionsV1? of(BuildContext context) => context
      .dependOnInheritedWidgetOfExactType<CardConnectionsScope>()
      ?.notifier;
}
