/// When the app stops working in the background.
///
/// The rule is one line, and it is here because getting it wrong cost the
/// browser every poller and the live conversation channel: a tab that merely
/// loses focus sits in `inactive` indefinitely, and treating that as away meant
/// nothing recovered until a reload.
library;

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/shell/lifecycle.dart';

void main() {
  test('a visible app keeps working, focused or not', () {
    // `inactive` is visible but unfocused — an overlay on the phone, another
    // window on top in a browser. Somebody can still see the result.
    expect(appIsAwayV1(AppLifecycleState.resumed), isFalse);
    expect(appIsAwayV1(AppLifecycleState.inactive), isFalse);
  });

  test('an app nobody can see stops', () {
    expect(appIsAwayV1(AppLifecycleState.hidden), isTrue);
    expect(appIsAwayV1(AppLifecycleState.paused), isTrue);
    expect(appIsAwayV1(AppLifecycleState.detached), isTrue);
  });
}
