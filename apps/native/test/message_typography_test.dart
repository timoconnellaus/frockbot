/// How a message reads, by platform.
///
/// Body copy is 14 everywhere — Manrope at 15 read heavy on ink. Emphasis
/// still drops to medium at a desk, because a semibold on that face draws
/// heavier still and a desktop cannot go lighter than 400.
library;

import 'package:flutter/foundation.dart' show defaultTargetPlatform;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/shell/markdown.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

const desktops = {
  TargetPlatform.macOS,
  TargetPlatform.windows,
  TargetPlatform.linux,
};

Map<String, TextStyle> leafStyles(WidgetTester tester) {
  final styles = <String, TextStyle>{};
  for (final rich in tester.widgetList<RichText>(find.byType(RichText))) {
    rich.text.visitChildren((span) {
      if (span is TextSpan && span.text != null && span.style != null) {
        styles[span.text!] = span.style!;
      }
      return true;
    });
  }
  return styles;
}

void main() {
  testWidgets('a Bot message is 14 on every platform, lighter emphasis at a desk', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: const Scaffold(body: ShellMarkdown(text: 'Plain **strong**')),
      ),
    );
    final styles = leafStyles(tester);
    final desktop = desktops.contains(defaultTargetPlatform);

    expect(styles['Plain ']!.fontFamily, 'Manrope');
    expect(styles['Plain ']!.fontWeight, FontWeight.w400);
    expect(styles['Plain ']!.height, 1.5);
    expect(styles['Plain ']!.fontSize, 14);
    expect(styles['strong']!.fontSize, 14);
    expect(
      styles['strong']!.fontWeight,
      desktop ? FontWeight.w500 : FontWeight.w600,
    );
  }, variant: TargetPlatformVariant.all());

  testWidgets('the message style is the theme body', (tester) async {
    final theme = FrockTheme.theme(Brightness.dark);
    final style = FrockTheme.message(theme);
    final body = theme.textTheme.bodyLarge!;

    expect(style.fontWeight, FontWeight.w400);
    expect(style.height, 1.5);
    expect(style.fontSize, 14);
    expect(body.fontSize, 14);
    expect(style.letterSpacing, body.letterSpacing);
  }, variant: TargetPlatformVariant.all());
}
