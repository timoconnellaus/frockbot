import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/shell/composer.dart';
import 'package:frockbot_native/theme/caret.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

Widget _app(Widget child, TargetPlatform platform) => MaterialApp(
  theme: FrockTheme.theme(Brightness.dark).copyWith(platform: platform),
  home: Scaffold(body: Center(child: child)),
);

double _cursorOffset(WidgetTester tester) =>
    tester.widget<EditableText>(find.byType(EditableText)).cursorOffset?.dx ??
    0.0;

void main() {
  testWidgets('the composer caret stands where the text ends', (tester) async {
    tester.view.devicePixelRatio = 2;
    tester.view.physicalSize = const Size(1600, 1600);
    addTearDown(tester.view.reset);
    final editor = TextEditingController(text: 'a draft ending in f');
    final focus = FocusNode();
    addTearDown(editor.dispose);
    addTearDown(focus.dispose);
    await tester.pumpWidget(
      _app(
        Composer(
          editor: editor,
          focus: focus,
          ready: true,
          stoppable: false,
          stopping: false,
          onSend: () async {},
          onStop: () async {},
          onChanged: (_) {},
          skills: null,
        ),
        TargetPlatform.macOS,
      ),
    );
    expect(_cursorOffset(tester), closeTo(0, 0.01));
  });

  // The workaround exists for this: Material moves the Apple caret two device
  // pixels into the last letter. When this stops being true, [SteadyCaret] has
  // nothing left to do and goes.
  testWidgets('a bare field still has the caret nudged into the text', (
    tester,
  ) async {
    tester.view.devicePixelRatio = 2;
    tester.view.physicalSize = const Size(1600, 1600);
    addTearDown(tester.view.reset);
    await tester.pumpWidget(_app(const TextField(), TargetPlatform.macOS));
    expect(_cursorOffset(tester), closeTo(-1, 0.01));
  });

  testWidgets('a platform without the nudge keeps its own pixel ratio', (
    tester,
  ) async {
    tester.view.devicePixelRatio = 2;
    tester.view.physicalSize = const Size(1600, 1600);
    addTearDown(tester.view.reset);
    late double ratio;
    await tester.pumpWidget(
      _app(
        SteadyCaret(
          child: Builder(
            builder: (context) {
              ratio = MediaQuery.devicePixelRatioOf(context);
              return const TextField();
            },
          ),
        ),
        TargetPlatform.android,
      ),
    );
    expect(ratio, 2);
    expect(_cursorOffset(tester), 0.0);
  });
}
