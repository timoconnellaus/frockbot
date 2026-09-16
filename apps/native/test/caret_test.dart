import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart' show FontLoader, rootBundle;
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/shell/composer.dart';
import 'package:frockbot_native/theme/caret.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

Widget _app(Widget child, TargetPlatform platform) => MaterialApp(
  theme: FrockTheme.theme(Brightness.dark).copyWith(platform: platform),
  home: Scaffold(body: Center(child: child)),
);

/// A field with the composer's text style and nothing around it, so the two
/// arrangements below differ only by the wrapper.
Widget _field(
  TextEditingController editor,
  FocusNode focus, {
  required bool steady,
}) => SizedBox(
  width: 400,
  child: Builder(
    builder: (context) {
      final field = TextField(
        controller: editor,
        focusNode: focus,
        style: Theme.of(
          context,
        ).textTheme.bodyLarge?.copyWith(fontWeight: FontWeight.w400),
        decoration: const InputDecoration(
          filled: false,
          border: InputBorder.none,
          contentPadding: EdgeInsets.zero,
        ),
      );
      return steady ? SteadyCaret(child: field) : field;
    },
  ),
);

RenderEditable _editable(WidgetTester tester) {
  late RenderEditable found;
  void search(RenderObject node) {
    if (node is RenderEditable) {
      found = node;
      return;
    }
    node.visitChildren(search);
  }

  search(tester.renderObject(find.byType(EditableText)));
  return found;
}

/// The same text laid out independently of the field, to measure against.
TextPainter _painter(WidgetTester tester, String text, double width) {
  final painter = TextPainter(
    text: TextSpan(
      text: text,
      style: tester.widget<EditableText>(find.byType(EditableText)).style,
    ),
    textDirection: TextDirection.ltr,
  )..layout(maxWidth: width);
  return painter;
}

double _cursorOffset(WidgetTester tester) =>
    tester.widget<EditableText>(find.byType(EditableText)).cursorOffset?.dx ??
    0.0;

const _draft = 'a draft ending in f';

void main() {
  setUpAll(() async {
    final inter = FontLoader('Inter');
    for (final weight in [400, 500, 600, 700]) {
      inter.addFont(rootBundle.load('assets/fonts/inter-latin-$weight.ttf'));
    }
    await inter.load();
  });

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

  // The pixel ratio the wrapper hands the field is only meant to move the
  // caret. Everything else the field measures in it has to come out where it
  // did: a tap has to land on the letter it was aimed at, ...
  testWidgets('a tap inside a wrapped field lands on the same character', (
    tester,
  ) async {
    tester.view.devicePixelRatio = 2;
    tester.view.physicalSize = const Size(1600, 1600);
    addTearDown(tester.view.reset);

    Future<int> tappedOffset({required bool steady}) async {
      final editor = TextEditingController(text: _draft);
      final focus = FocusNode();
      addTearDown(editor.dispose);
      addTearDown(focus.dispose);
      await tester.pumpWidget(
        _app(_field(editor, focus, steady: steady), TargetPlatform.macOS),
      );
      final editable = _editable(tester);
      final origin = editable.localToGlobal(Offset.zero);
      await tester.tapAt(origin + Offset(60, editable.size.height / 2));
      await tester.pumpAndSettle();
      return editor.selection.baseOffset;
    }

    final wrapped = await tappedOffset(steady: true);
    final bare = await tappedOffset(steady: false);
    final painter = _painter(tester, _draft, 400);
    final aimedAt = painter
        .getPositionForOffset(Offset(60, painter.height / 2))
        .offset;
    painter.dispose();

    // A point mid-draft, not either end, so this says something.
    expect(aimedAt, greaterThan(0));
    expect(aimedAt, lessThan(_draft.length));
    expect(wrapped, aimedAt);
    expect(wrapped, bare);
  });

  // ... and a selection has to cover the word it was made over and no more.
  testWidgets('a selection in a wrapped field covers exactly its word', (
    tester,
  ) async {
    tester.view.devicePixelRatio = 2;
    tester.view.physicalSize = const Size(1600, 1600);
    addTearDown(tester.view.reset);
    final editor = TextEditingController(text: _draft);
    final focus = FocusNode();
    addTearDown(editor.dispose);
    addTearDown(focus.dispose);
    await tester.pumpWidget(
      _app(_field(editor, focus, steady: true), TargetPlatform.macOS),
    );
    focus.requestFocus();
    await tester.pumpAndSettle();

    const word = 'ending';
    final start = _draft.indexOf(word);
    final selection = TextSelection(
      baseOffset: start,
      extentOffset: start + word.length,
    );
    editor.selection = selection;
    await tester.pumpAndSettle();

    final editable = _editable(tester);
    expect(editable.selection, selection);
    final painted = editable.getBoxesForSelection(selection);
    final whole = editable.getBoxesForSelection(
      const TextSelection(baseOffset: 0, extentOffset: _draft.length),
    );

    final painter = _painter(tester, _draft, editable.size.width);
    final expected = painter.getBoxesForSelection(selection);
    final expectedWhole = painter.getBoxesForSelection(
      const TextSelection(baseOffset: 0, extentOffset: _draft.length),
    );
    painter.dispose();

    expect(painted, hasLength(1));
    expect(expected, hasLength(1));
    // Measured from where the text starts, so this compares the highlight
    // itself rather than the field's padding.
    expect(
      painted.single.left - whole.single.left,
      closeTo(expected.single.left - expectedWhole.single.left, 0.01),
    );
    expect(
      painted.single.right - painted.single.left,
      closeTo(expected.single.right - expected.single.left, 0.01),
    );
  });
}
