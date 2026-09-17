/// What the composer shows while a capture is being tidied, and the way back.
///
/// Tidying is done to somebody's words without them asking, so two things
/// have to be true on screen: while it runs they are told, and once it has
/// run they can undo it. The undo is withdrawn the moment they edit inside
/// the tidied text, because from then on the field is partly theirs and
/// swapping it would take their edit with it.
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/shell/composer.dart';
import 'package:frockbot_native/theme/frock_theme.dart';
import 'package:frockbot_native/voice/dictation.dart';

Future<List<String>> pumpComposer(
  WidgetTester tester, {
  required DictationState dictationState,
  bool cleaned = false,
  bool offerRevert = true,
}) async {
  final editor = TextEditingController(text: 'Check the Friday flights.');
  final focus = FocusNode();
  final reverted = <String>[];
  addTearDown(editor.dispose);
  addTearDown(focus.dispose);
  await tester.pumpWidget(
    MaterialApp(
      theme: FrockTheme.theme(Brightness.dark),
      home: Scaffold(
        body: Align(
          alignment: Alignment.bottomCenter,
          child: Composer(
            editor: editor,
            focus: focus,
            ready: true,
            stoppable: false,
            stopping: false,
            onSend: () async {},
            onStop: () async {},
            onChanged: (_) {},
            skills: null,
            onDictate: () {},
            onStopDictation: () {},
            dictationState: dictationState,
            dictationCleaned: cleaned,
            onRevertDictation: offerRevert
                ? () => reverted.add('reverted')
                : null,
          ),
        ),
      ),
    ),
  );
  await tester.pump();
  return reverted;
}

void main() {
  final revert = find.byKey(const ValueKey('dictation-revert'));

  testWidgets('offers the raw transcript back once a tidy-up has landed', (
    tester,
  ) async {
    final reverted = await pumpComposer(
      tester,
      dictationState: DictationState.idle,
      cleaned: true,
    );
    expect(revert, findsOneWidget);
    await tester.tap(revert);
    await tester.pump();
    expect(reverted, ['reverted']);
  });

  testWidgets('says nothing when the draft is the person\'s own words', (
    tester,
  ) async {
    await pumpComposer(tester, dictationState: DictationState.idle);
    expect(revert, findsNothing);
  });

  // The controller withdraws the callback once its range is fenced. The
  // composer must take that as "no offer", not draw a button that does
  // nothing.
  testWidgets('withdraws the offer when there is nothing to revert to', (
    tester,
  ) async {
    await pumpComposer(
      tester,
      dictationState: DictationState.idle,
      cleaned: true,
      offerRevert: false,
    );
    expect(revert, findsNothing);
  });

  // Tidying is a wait the person cannot speak into, exactly like the commit
  // before it, so it is drawn the same way rather than inventing a second
  // kind of busy.
  testWidgets('a capture being tidied reads as finishing, not as recording', (
    tester,
  ) async {
    await pumpComposer(tester, dictationState: DictationState.cleaning);
    expect(find.byKey(const ValueKey('finishing')), findsOneWidget);
    expect(find.byKey(const ValueKey('dictation-stop')), findsOneWidget);
    final stop = tester.widget<IconButton>(
      find.byKey(const ValueKey('dictation-stop')),
    );
    // Nothing left to stop: the microphone is already off.
    expect(stop.onPressed, isNull);
    expect(DictationState.cleaning.active, isTrue);
    expect(DictationState.cleaning.finishing, isTrue);
  });

  testWidgets('a capture still recording is not drawn as finishing', (
    tester,
  ) async {
    await pumpComposer(tester, dictationState: DictationState.capturing);
    expect(find.byKey(const ValueKey('finishing')), findsNothing);
  });
}
