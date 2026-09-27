/// Where a value typed into a card's `SecretField` goes.
///
/// `SecretField` is trust chrome: the kernel binds it to a secret request it
/// recorded, and the host draws it. What a person types into it is a password
/// or a card number, so it is never a Card action, never written into the
/// renderer's data model, and never kept by this client: it is posted once,
/// to the one route that seals it into the account, and the field is emptied.
/// The Bot learns a reference to it and nothing else.
library;

import 'package:flutter/material.dart';

/// The host's route for a typed secret.
abstract interface class CardSecretsV1 {
  /// What is typed so far into one request's field, held by the card rather
  /// than the renderer: every adopted record rebuilds the renderer, and a
  /// half-typed password must not be emptied by a notice about something
  /// else. In memory only, and disposed with the card.
  TextEditingController draftV1(String requestId);

  /// Posts one value to the request it answers, under a command id minted
  /// once per value so a retry is the same save. Completes once the account
  /// holds it; throws with words for the person when it does not.
  Future<void> saveSecretV1({
    required String requestId,
    required String value,
    required String commandId,
  });
}

/// How `SecretField` reaches it.
///
/// Absent in a context with no live Bot — a test, a preview — where the field
/// is drawn and cannot be saved.
class CardSecretsScope extends InheritedWidget {
  final CardSecretsV1? secrets;
  const CardSecretsScope({
    super.key,
    required this.secrets,
    required super.child,
  });

  static CardSecretsV1? of(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<CardSecretsScope>()?.secrets;

  @override
  bool updateShouldNotify(CardSecretsScope old) => secrets != old.secrets;
}
