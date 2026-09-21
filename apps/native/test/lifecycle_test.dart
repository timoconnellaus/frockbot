/// When the app stops working in the background.
///
/// The rule is one line, and it is here because getting it wrong cost the
/// browser every poller and the live conversation channel: a tab that merely
/// loses focus sits in `inactive` indefinitely, and treating that as away meant
/// nothing recovered until a reload. Voice is the one exception: a live call
/// sleeps through `hidden` and `paused` so coming back continues it, and only
/// `detached` hangs up.
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
    expect(
      voiceLifecycleActionV1(AppLifecycleState.resumed),
      VoiceLifecycleActionV1.continueCall,
    );
    expect(
      voiceLifecycleActionV1(AppLifecycleState.inactive),
      VoiceLifecycleActionV1.continueCall,
    );
  });

  test('an app nobody can see stops', () {
    expect(appIsAwayV1(AppLifecycleState.hidden), isTrue);
    expect(appIsAwayV1(AppLifecycleState.paused), isTrue);
    expect(appIsAwayV1(AppLifecycleState.detached), isTrue);
  });

  test(
    'a live call sleeps when the app is hidden, and hangs up when detached',
    () {
      expect(
        voiceLifecycleActionV1(AppLifecycleState.hidden),
        VoiceLifecycleActionV1.sleep,
      );
      expect(
        voiceLifecycleActionV1(AppLifecycleState.paused),
        VoiceLifecycleActionV1.sleep,
      );
      expect(
        voiceLifecycleActionV1(AppLifecycleState.detached),
        VoiceLifecycleActionV1.hangUp,
      );
    },
  );
}
