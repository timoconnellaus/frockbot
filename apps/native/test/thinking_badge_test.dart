import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/flock/sheep.dart';

void main() {
  testWidgets('the typing badge keeps bouncing after its tempo changes', (
    tester,
  ) async {
    Widget badge(Duration tempo) => MaterialApp(
      home: Center(child: ThinkingBadge(height: 12, tempo: tempo)),
    );

    await tester.pumpWidget(badge(const Duration(milliseconds: 1200)));
    await tester.pump(const Duration(milliseconds: 300));

    await tester.pumpWidget(badge(const Duration(milliseconds: 1600)));
    expect(tester.binding.hasScheduledFrame, isTrue);

    Offset firstDot() => tester
        .widgetList<Transform>(
          find.descendant(
            of: find.byType(ThinkingBadge),
            matching: find.byType(Transform),
          ),
        )
        .map((transform) => transform.transform.getTranslation())
        .map((translation) => Offset(translation.x, translation.y))
        .first;

    final before = firstDot();
    await tester.pump(const Duration(milliseconds: 200));
    expect(firstDot(), isNot(before));
    expect(tester.binding.hasScheduledFrame, isTrue);
  });
}
