/// One dark base, every platform.
///
/// The dark window is the theme's number, not the host's: nothing may
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
  test('the dark window is #18161a, and it is the theme that says so', () {
    expect(FrockTheme.window, const Color(0xff18161a));
    for (final platform in TargetPlatform.values) {
      debugDefaultTargetPlatformOverride = platform;
      addTearDown(() => debugDefaultTargetPlatformOverride = null);
      final theme = FrockTheme.theme(Brightness.dark);
      expect(
        theme.scaffoldBackgroundColor,
        FrockTheme.window,
        reason: '$platform',
      );
      // The chrome — app bar, composer, sidebar — has its own colour, one
      // step below the window, and it does not move by platform either.
      expect(
        theme.colorScheme.surface,
        FrockTheme.surface,
        reason: '$platform',
      );
    }
    debugDefaultTargetPlatformOverride = null;
  });
}
