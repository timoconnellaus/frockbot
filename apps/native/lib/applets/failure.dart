/// One honest state per way an Applet read can fail.
///
/// A port of `app/shell/client/applet-canvas-failure.ts`. The canvas used to
/// put whatever string reached its `catch` on screen and keep polling. A
/// permanent 503 — the deployment could not sign a viewer token — therefore
/// read as "Couldn't reach FrockBot." on the first attempt and "That didn't
/// work." on the next, forever, while nothing about it was ever going to
/// change (2026-09-05).
///
/// So a failure is classified once, into a sentence that says which of these
/// happened, and a retry policy that matches: a network that might come back
/// is retried on a widening backoff, and a refusal the deployment has already
/// settled is not retried at all.
///
/// Five kinds rather than the browser's six. The browser separates "you are
/// offline" from "FrockBot didn't answer" on `navigator.onLine`, which the app
/// has no equivalent of on either target: an unreachable gateway is the same
/// sentence and the same retry either way, so there is one of them here.
library;

import '../client/transport.dart';

enum AppletFailureKind {
  unreachable,
  unavailable,
  unpublished,
  denied,
  refused,
}

/// `auto` retries on the backoff below and offers the button as well; `manual`
/// waits for the person, because retrying changes nothing.
enum AppletRetry { auto, manual }

class AppletCanvasFailure {
  final AppletFailureKind kind;

  /// The one sentence the panel shows.
  final String message;
  final AppletRetry retry;
  const AppletCanvasFailure(this.kind, this.message, this.retry);
}

/// How long to wait before the nth automatic retry.
Duration appletCanvasRetryDelayV1(int attempt) => Duration(
  milliseconds: (2000 * (1 << (attempt < 1 ? 0 : attempt - 1))).clamp(
    2000,
    30000,
  ),
);

/// After this many automatic attempts the panel stops and waits for the person.
const appletCanvasMaxAutoRetriesV1 = 4;

/// What a caught Applet read amounts to.
AppletCanvasFailure appletCanvasFailureV1(Object error) {
  final status = error is RequestFailure ? error.status : null;
  if (status == null) {
    return const AppletCanvasFailure(
      AppletFailureKind.unreachable,
      'FrockBot didn’t answer.',
      AppletRetry.auto,
    );
  }
  if (status == 401 || status == 403) {
    return const AppletCanvasFailure(
      AppletFailureKind.denied,
      'You’re not signed in any more. Sign in again to open this.',
      AppletRetry.manual,
    );
  }
  if (status == 404) {
    return const AppletCanvasFailure(
      AppletFailureKind.unpublished,
      'This Applet hasn’t been published yet.',
      AppletRetry.manual,
    );
  }
  if (status >= 500) {
    // The deployment answered, and what it answered was that Applets do not
    // work here. Nothing the person can do makes that untrue, so the panel
    // says so once and stops.
    return const AppletCanvasFailure(
      AppletFailureKind.unavailable,
      'Applets are unavailable right now. This one is at our end.',
      AppletRetry.manual,
    );
  }
  return const AppletCanvasFailure(
    AppletFailureKind.refused,
    'FrockBot wouldn’t open this Applet.',
    AppletRetry.manual,
  );
}
