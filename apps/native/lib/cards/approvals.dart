/// What the host knows about the kernel Approvals a card is the face of.
///
/// `ApprovalActions` is trust chrome: a component only the host draws, bound
/// to an id only the kernel issues (ADR 0030). Drawing the controls is half of
/// that. The other half is saying what was decided — a card answered on
/// another device, or expired by the alarm, has to show what was actually
/// recorded rather than a live-looking button.
///
/// The Card record cannot say it. A Card settles when somebody redraws it, and
/// nobody redraws a decision card: the Approval is the kernel's own record and
/// its decision moves without the surface moving. So the component reads the
/// decision from the same place the old approval bubble read it — the Bot's
/// `/approvals` projection — and the scope below is how it reaches it.
library;

import 'package:flutter/widgets.dart';

/// One Approval, as the backend reports it.
@immutable
class CardApprovalStateV1 {
  /// `pending`, `approved`, `denied` or `expired`, in the kernel's words.
  final String decision;

  /// When silence becomes a refusal. Only meaningful while pending.
  final String? expiresAt;

  /// Whether this client is posting a decision on it right now.
  final bool deciding;
  const CardApprovalStateV1({
    required this.decision,
    this.expiresAt,
    this.deciding = false,
  });
}

/// The decisions this transcript's Bot holds, however they are held.
///
/// A `Listenable`, because a decision lands after the card was drawn — this
/// client pressed one, or another device did — and the component drawing it
/// has to be told.
abstract interface class CardApprovalsV1 implements Listenable {
  /// What was recorded against this id, or null when nothing is known — a
  /// deployment with no approvals route, or a read that has not landed.
  CardApprovalStateV1? approvalStateV1(String approvalId);

  /// Re-reads the Bot's decisions.
  ///
  /// A press on `ApprovalActions` goes to the Card action route, which records
  /// the decision and answers with the card; the approvals projection this is
  /// read from does not move on its own. So the card asks for a re-read after
  /// a press it routed to an Approval, and the component draws the answer.
  Future<void> refreshApprovalsV1();
}

/// How `ApprovalActions` reaches them.
///
/// Absent in a context with no live Bot — a test, a preview — where the card
/// draws its controls and says nothing about a decision it cannot read.
class CardApprovalsScope extends InheritedNotifier<CardApprovalsV1> {
  const CardApprovalsScope({
    super.key,
    required CardApprovalsV1? approvals,
    required super.child,
  }) : super(notifier: approvals);

  static CardApprovalsV1? of(BuildContext context) => context
      .dependOnInheritedWidgetOfExactType<CardApprovalsScope>()
      ?.notifier;
}
