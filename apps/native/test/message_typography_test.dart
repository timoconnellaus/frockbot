/// How a message reads.
///
/// Inter at 14, tracking off — Manrope at 15 read heavy on ink. Headings
/// stay body size and only pick up weight. List items get a little air.
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/shell/markdown.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

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
  testWidgets('a Bot message is Inter 14 with semibold emphasis', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: const Scaffold(body: ShellMarkdown(text: 'Plain **strong**')),
      ),
    );
    final styles = leafStyles(tester);

    expect(styles['Plain ']!.fontFamily, 'Inter');
    expect(styles['Plain ']!.fontWeight, FontWeight.w400);
    expect(styles['Plain ']!.height, 1.55);
    expect(styles['Plain ']!.fontSize, 14);
    expect(styles['Plain ']!.letterSpacing, 0);
    expect(styles['strong']!.fontSize, 14);
    expect(styles['strong']!.fontWeight, FontWeight.w600);
  });

  testWidgets('the message style is the theme body', (tester) async {
    final theme = FrockTheme.theme(Brightness.dark);
    final style = FrockTheme.message(theme);
    final body = theme.textTheme.bodyLarge!;

    expect(style.fontFamily, 'Inter');
    expect(style.fontWeight, FontWeight.w400);
    expect(style.height, 1.55);
    expect(style.fontSize, 14);
    expect(body.fontSize, 14);
    expect(style.letterSpacing, 0);
    expect(style.letterSpacing, body.letterSpacing);
  });

  testWidgets('a heading stays body size and only gains weight', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: const Scaffold(
          body: ShellMarkdown(text: '## Morning inbox triage\n\nA clock.'),
        ),
      ),
    );
    final styles = leafStyles(tester);
    expect(styles['Morning inbox triage']!.fontSize, 14);
    expect(styles['Morning inbox triage']!.fontWeight, FontWeight.w600);
    expect(styles['A clock.']!.fontSize, 14);
    expect(styles['A clock.']!.fontWeight, FontWeight.w400);
  });
}
