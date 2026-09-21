/// When the app should stop working in the background.
///
/// `inactive` is not away. It means visible but not receiving input — a phone
/// showing the app under a system overlay, and, on the web, a tab that is still
/// on screen while the window has focus somewhere else. Treating it as away is
/// what the phone got away with and the browser does not: a Playwright page and
/// an unfocused tab both sit in `inactive` indefinitely, so every poller and
/// every socket stopped on the first blur and only a reload brought them back.
///
/// Away is `hidden`, `paused` and `detached` — the states in which nobody can
/// see the result of the work. A live voice call sleeps through `hidden` and
/// `paused` rather than hanging up, so coming back continues the same
/// conversation; `detached` still ends it, because the view is gone.
library;

import 'package:flutter/widgets.dart';

bool appIsAwayV1(AppLifecycleState state) =>
    state == AppLifecycleState.hidden ||
    state == AppLifecycleState.paused ||
    state == AppLifecycleState.detached;

/// What a live voice call does when the app's lifecycle moves.
enum VoiceLifecycleActionV1 {
  /// Stay on the line. The app is still visible (`resumed`, `inactive`).
  continueCall,

  /// Close Gemini and the microphone, keep the socket. Coming back resumes.
  sleep,

  /// Hang up. The view is gone (`detached`), or the call is not live yet.
  hangUp,
}

VoiceLifecycleActionV1 voiceLifecycleActionV1(AppLifecycleState state) {
  if (state == AppLifecycleState.detached) {
    return VoiceLifecycleActionV1.hangUp;
  }
  if (appIsAwayV1(state)) return VoiceLifecycleActionV1.sleep;
  return VoiceLifecycleActionV1.continueCall;
}
