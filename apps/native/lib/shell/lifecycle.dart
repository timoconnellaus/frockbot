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
/// see the result of the work.
library;

import 'package:flutter/widgets.dart';

bool appIsAwayV1(AppLifecycleState state) =>
    state == AppLifecycleState.hidden ||
    state == AppLifecycleState.paused ||
    state == AppLifecycleState.detached;
