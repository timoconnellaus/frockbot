import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/flock/avatar.dart';
import 'package:frockbot_native/shell/chat_header.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'voice_shell_harness.dart';

/// Optional review artifact, kept outside the repository:
/// `--dart-define=COMPANION_VISUAL_OUTPUT=<dir>`.
Future<void> capture(WidgetTester tester, String name) async {
  const output = String.fromEnvironment('COMPANION_VISUAL_OUTPUT');
  if (output.isEmpty) return;
  // The character is an asset image, decoded off the test's fake clock; give
  // it real time to land before the frame is read back.
  await tester.runAsync(() => Future<void>.delayed(const Duration(seconds: 1)));
  await tester.pump();
  await tester.runAsync(() async {
    final boundary = tester.firstRenderObject(
      find.byType(RepaintBoundary),
    ) as RenderRepaintBoundary;
    final image = await boundary.toImage(pixelRatio: 2);
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    await File('$output/$name.png').writeAsBytes(bytes!.buffer.asUint8List());
    image.dispose();
  });
}

void main() {
  for (final width in [390.0, 1280.0]) {
    testWidgets('the companion sits on the composer field at $width', (
      tester,
    ) async {
      final harness = VoiceShellHarness();
      await harness.mount(tester, width: width, brightness: Brightness.dark);
      final inset = width == 390 ? 34.0 : 0.0;
      final companion = find.bySemanticsLabel('Bot is ready');
      expect(companion, findsOneWidget);
      // The field's container is padded ten points off the composer's bottom,
      // above the system inset; the companion's feet rest on the same line at
      // every width, with or without a gesture bar below. On a phone it used
      // to hang the bar's height lower than the field.
      final field = find.byKey(const ValueKey('composer'));
      final fieldBottom = tester.getBottomLeft(field).dy;
      final companionBottom = tester.getBottomLeft(companion).dy;
      expect(companionBottom, closeTo(800 - 10 - inset, 0.01));
      expect(companionBottom, greaterThan(fieldBottom - 40));
      expect(companionBottom, lessThanOrEqualTo(fieldBottom + 20));
      // The bar names the Bot without drawing it: the companion is the one
      // character on the conversation.
      expect(
        find.descendant(
          of: find.byType(ChatHeader),
          matching: find.byType(CharacterAvatar),
        ),
        findsNothing,
      );
      await capture(tester, 'composer-companion-${width.toInt()}');
      await harness.dispose(tester);
    });
  }

  for (final width in [390.0, 1280.0]) {
    testWidgets('typing tucks the companion only on a phone at $width', (
      tester,
    ) async {
      final harness = VoiceShellHarness();
      await harness.mount(tester, width: width, brightness: Brightness.dark);
      final companion = find.bySemanticsLabel('Bot is ready');
      final field = find.byKey(const ValueKey('composer'));
      expect(companion, findsOneWidget);
      final restLeft = tester.getTopLeft(field).dx;

      await tester.enterText(field, 'hello');
      await tester.pump();
      await tester.pump(FrockTheme.enter);

      if (width == 390) {
        expect(companion, findsNothing);
        expect(tester.getTopLeft(field).dx, lessThan(restLeft - 24));
      } else {
        expect(companion, findsOneWidget);
        expect(tester.getTopLeft(field).dx, restLeft);
      }

      await tester.enterText(field, '');
      await tester.pump();
      await tester.pump(FrockTheme.enter);
      expect(companion, findsOneWidget);
      expect(tester.getTopLeft(field).dx, restLeft);
      expect(tester.takeException(), isNull);
      await harness.dispose(tester);
    });
  }
}
