import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/auth/sign_in_page.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

void main() {
  for (final brightness in Brightness.values) {
    testWidgets('sign-in states remain accessible at 200% in $brightness', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(390, 720);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      var taps = 0;
      for (final state in [
        'ready',
        'busy',
        'browser',
        'offline',
        'unavailable',
      ]) {
        await tester.pumpWidget(
          MaterialApp(
            theme: FrockTheme.theme(brightness),
            builder: (context, child) => MediaQuery(
              data: MediaQuery.of(context).copyWith(
                textScaler: const TextScaler.linear(2),
                disableAnimations: true,
              ),
              child: child!,
            ),
            home: SignInPage(
              busy: state == 'busy',
              awaitingBrowser: state == 'browser',
              error: switch (state) {
                'offline' => 'Couldn’t reach FrockBot. Check your connection and try again.',
                'unavailable' => 'Native sign-in is temporarily unavailable. Please try again in a few minutes.',
                _ => null,
              },
              onSignIn: () => taps++,
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
        expect(find.textContaining('preview'), findsNothing);
        expect(find.byType(CircularProgressIndicator), findsNothing);
        if (state != 'busy') {
          final button = find.byKey(const ValueKey('sign-in'));
          await tester.ensureVisible(button);
          await tester.tap(button);
        }
      }
      expect(taps, 4);
    });
  }
}
