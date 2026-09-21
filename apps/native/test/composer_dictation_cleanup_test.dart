/// What the composer shows while a capture is being tidied, and the way back.
///
/// Tidying is done to somebody's words without them asking, so two things
/// have to be true on screen: while it runs they are told, and once it has
/// run they can undo it. The undo is withdrawn the moment they edit inside
/// the tidied text, because from then on the field is partly theirs and
/// swapping it would take their edit with it.
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/shell/composer.dart';
import 'package:frockbot_native/theme/frock_theme.dart';
import 'package:frockbot_native/voice/dictation.dart';

import 'voice_fakes.dart';

/// A composer wired the way the chat pane wires one: what the person types
/// goes to the draft store the capture reads, and that same change rebuilds
/// the composer. The revert offer is asked of the controller on every build,
/// which is the whole point — a value read once cannot be withdrawn.
class _WiredComposer extends StatefulWidget {
  final DictationController controller;
  final ComposerDraftStore drafts;
  const _WiredComposer({required this.controller, required this.drafts});

  @override
  State<_WiredComposer> createState() => _WiredComposerState();
}

class _WiredComposerState extends State<_WiredComposer> {
  late final TextEditingController editor = TextEditingController(
    text: widget.drafts.draftFor('bot-a'),
  );
  final FocusNode focus = FocusNode();

  @override
  void dispose() {
    editor.dispose();
    focus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => MaterialApp(
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
          onChanged: (value) => setState(() {
            widget.drafts.setDraft('bot-a', value);
          }),
          skills: null,
          onDictate: () {},
          onStopDictation: () {},
          dictationState: widget.controller.state,
          canRevertDictation: () => widget.controller.cleaned,
          onRevertDictation: widget.controller.revertCleanup,
        ),
      ),
    ),
  );
}

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
            canRevertDictation: cleaned ? () => true : null,
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

  // The raw transcript has already landed. Tidying is a swap in a field
  // they can already edit, not a second spin they cannot type into.
  testWidgets('a capture being tidied shows the draft, not a finishing wait', (
    tester,
  ) async {
    await pumpComposer(tester, dictationState: DictationState.cleaning);
    expect(find.byKey(const ValueKey('finishing')), findsNothing);
    expect(find.byKey(const ValueKey('dictation-pill')), findsNothing);
    expect(find.byType(TextField), findsOneWidget);
    expect(DictationState.cleaning.active, isFalse);
    expect(DictationState.cleaning.finishing, isFalse);
  });

  // The offer is drawn from a live predicate, so it has to be asked again
  // when the draft changes. Driven through a real edit rather than the prop:
  // a snapshot taken in an ancestor's build survives the edit, which is
  // exactly how "Use what I said" came to sit over a span it could no longer
  // replace.
  testWidgets('a draft edit inside the tidied span withdraws the offer', (
    tester,
  ) async {
    final drafts = ComposerDraftStore();
    final socket = FakeVoiceSocket();
    final capture = FakeVoiceCapture();
    final controller = DictationController(
      openSocket: () async => socket,
      capture: capture,
      onDraft: drafts.setDraft,
      readDraft: drafts.draftFor,
    );
    addTearDown(controller.dispose);

    await tester.runAsync(() async {
      await controller.start('bot-a');
      await settle();
      void say(String type, [Map<String, Object?> extra = const {}]) => socket
          .deliver(jsonEncode({'schemaVersion': 1, 'type': type, ...extra}));
      say('ready');
      say('segment', {'text': 'um so check the Friday flights'});
      await settle();
      unawaited(controller.stop());
      await settle();
      say('cleaning');
      say('cleaned', {'text': 'Check the Friday flights.'});
      say('final');
      await settle();
    });

    expect(drafts.draftFor('bot-a'), 'Check the Friday flights.');
    await tester.pumpWidget(
      _WiredComposer(controller: controller, drafts: drafts),
    );
    await tester.pump();
    expect(revert, findsOneWidget);

    await tester.enterText(
      find.byType(TextField),
      'Check the SATURDAY flights.',
    );
    await tester.pump();
    expect(revert, findsNothing);
    expect(drafts.draftFor('bot-a'), 'Check the SATURDAY flights.');
  });

  testWidgets('a capture still recording is not drawn as finishing', (
    tester,
  ) async {
    await pumpComposer(tester, dictationState: DictationState.capturing);
    expect(find.byKey(const ValueKey('finishing')), findsNothing);
  });
}
