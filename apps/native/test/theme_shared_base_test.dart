/// One dark base, every platform.
///
/// A screenshot audit measured #1F1E24 behind both installed apps — the phone
/// and the desktop — which is what this theme has always said. The rule this
/// pins is that the number is the theme's and not the host's: nothing may
/// branch the main background on the platform the app happens to be running
/// on, so the appearance a person prefers on their phone is the appearance
/// they get everywhere.
library;

import 'package:flutter/foundation.dart'
    show debugDefaultTargetPlatformOverride;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

void main() {
  test('the dark window is #1F1E24, and it is the theme that says so', () {
    expect(FrockTheme.window, const Color(0xff1f1e24));
    for (final platform in TargetPlatform.values) {
      debugDefaultTargetPlatformOverride = platform;
      addTearDown(() => debugDefaultTargetPlatformOverride = null);
      final theme = FrockTheme.theme(Brightness.dark);
      expect(
        theme.scaffoldBackgroundColor,
        FrockTheme.window,
        reason: '$platform',
      );
      // The surface a card or a sheet sits on is its own colour, one step up
      // from the window, and it does not move by platform either.
      expect(
        theme.colorScheme.surface,
        FrockTheme.surface,
        reason: '$platform',
      );
    }
    debugDefaultTargetPlatformOverride = null;
  });
}
