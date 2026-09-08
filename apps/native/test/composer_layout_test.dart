import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/shell/composer.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

void main() {
  for (final scale in [0.85, 1.0, 2.0, 3.0]) {
    testWidgets(
      'draft, Stop and Send remain usable at ${scale}x with keyboard',
      (tester) async {
        tester.view.physicalSize = const Size(320, 800);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final editor = TextEditingController();
        final focus = FocusNode();
        addTearDown(editor.dispose);
        addTearDown(focus.dispose);
        var stops = 0;
        String? sent;
        await tester.pumpWidget(
          MaterialApp(
            theme: FrockTheme.theme(Brightness.dark),
            home: MediaQuery(
              data: MediaQueryData(
                textScaler: TextScaler.linear(scale),
                viewInsets: const EdgeInsets.only(bottom: 280),
              ),
              child: Scaffold(
                body: Align(
                  alignment: Alignment.bottomCenter,
                  child: Composer(
                    editor: editor,
                    focus: focus,
                    ready: true,
                    stoppable: true,
                    stopping: false,
                    onSend: () async {
                      sent = editor.text;
                    },
                    onStop: () async {
                      stops++;
                    },
                    onChanged: (_) {},
                    skills: null,
                  ),
                ),
              ),
            ),
          ),
        );
        final field = find.byKey(const ValueKey('composer'));
        await tester.enterText(
          field,
          'Keep the afternoon free\nLeave room for a walk',
        );
        await tester.pump();
        expect(tester.takeException(), isNull);
        expect(tester.widget<TextField>(field).style!.fontSize, 15);
        expect(
          MediaQuery.textScalerOf(tester.element(field)).scale(15),
          15 * scale,
        );
        expect(tester.widget<TextField>(field).decoration!.labelText, isNull);
        await tester.tap(find.byKey(const ValueKey('stop')));
        await tester.pump();
        expect(stops, 1);
        expect(editor.text, contains('afternoon'));
        await tester.tap(find.byTooltip('Send'));
        expect(sent, editor.text);
        expect(tester.takeException(), isNull);
      },
    );
  }
}
