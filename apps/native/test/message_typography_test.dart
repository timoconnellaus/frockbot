/// How a message reads, by platform.
///
/// Inter ships here at 400 and up, so a desktop cannot go lighter by weight:
/// on the Mac the same 15-point regular that reads right on a phone draws
/// heavy, and a Bot's emphasis at semibold heavier still. The desktop reads
/// messages a point smaller with emphasis at medium; the phone is untouched.
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
  testWidgets(
    'a Bot message is lighter at a desk and unchanged on a phone',
    (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: const Scaffold(
            body: ShellMarkdown(text: 'Plain **strong**'),
          ),
        ),
      );
      final styles = leafStyles(tester);
      final desktop = desktops.contains(defaultTargetPlatform);

      expect(styles['Plain ']!.fontFamily, 'Inter');
      expect(styles['Plain ']!.fontWeight, FontWeight.w400);
      expect(styles['Plain ']!.height, 1.5);
      expect(styles['Plain ']!.fontSize, desktop ? 14 : 15);
      expect(styles['strong']!.fontSize, desktop ? 14 : 15);
      expect(
        styles['strong']!.fontWeight,
        desktop ? FontWeight.w500 : FontWeight.w600,
      );
    },
    variant: TargetPlatformVariant.all(),
  );

  testWidgets(
    'the message style is the theme body on a phone, a point smaller at a desk',
    (tester) async {
      final theme = FrockTheme.theme(Brightness.dark);
      final style = FrockTheme.message(theme);
      final body = theme.textTheme.bodyLarge!;
      final desktop = desktops.contains(defaultTargetPlatform);

      expect(style.fontWeight, FontWeight.w400);
      expect(style.height, 1.5);
      expect(style.fontSize, desktop ? 14 : body.fontSize);
      expect(style.letterSpacing, body.letterSpacing);
    },
    variant: TargetPlatformVariant.all(),
  );
}
