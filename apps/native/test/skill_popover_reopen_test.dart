/// Choosing a Skill must not cost the composer its trigger.
///
/// Attaching rewrites the field from Dart. The popover used to be read only
/// from `TextField.onChanged`, which the programmatic rewrite never fires, so
/// the controller's idea of what was typed went stale and a later `/` opened
/// nothing.
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/shell/composer.dart';
import 'package:frockbot_native/shell/skill_menu.dart';

class VoidStore implements LocalStore {
  @override
  Future<String?> read(String key) async => null;
  @override
  Future<void> write(String key, String value) async {}
  @override
  Future<void> delete(String key) async {}
}

class SilentApi extends NativeApi {
  SilentApi(super.store);
  @override
  Future<Object?> request(
    String path, {
    Object? body,
    int limit = 512000,
    bool authenticated = true,
  }) async => const <String, Object?>{'skills': <Object?>[]};
}

SkillCatalogEntry entry(String slug) => SkillCatalogEntry(
  ref: 'bot:$slug',
  skill: {'schemaVersion': 1, 'source': 'bot', 'slug': slug},
  name: slug,
  description: '',
  path: '/skills/$slug',
);

void main() {
  testWidgets('a Skill chosen from the popover leaves the trigger armed', (
    tester,
  ) async {
    final editor = TextEditingController();
    final focus = FocusNode();
    final skills = SkillMenuController(
      api: SilentApi(VoidStore()),
      botId: 'bot-1',
    )..catalog = [entry('review'), entry('ship'), entry('plan')];
    addTearDown(editor.dispose);
    addTearDown(focus.dispose);
    addTearDown(skills.dispose);

    await tester.pumpWidget(
      MaterialApp(
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
              skills: skills,
            ),
          ),
        ),
      ),
    );

    final field = find.byKey(const ValueKey('composer'));
    await tester.enterText(field, '/');
    await tester.pumpAndSettle();
    expect(find.byType(SkillMenu), findsOneWidget);

    await tester.tap(find.text('review'));
    await tester.pumpAndSettle();
    expect(find.byType(SkillMenu), findsNothing);
    expect(editor.text, '');
    expect([for (final e in skills.attached) e.ref], ['bot:review']);

    // The regression: the field was rewritten from Dart, and the next trigger
    // opened nothing at all.
    await tester.enterText(field, '/');
    await tester.pumpAndSettle();
    expect(find.byType(SkillMenu), findsOneWidget);
  });

  testWidgets('a trigger written straight to the controller opens it', (
    tester,
  ) async {
    final editor = TextEditingController();
    final focus = FocusNode();
    final skills = SkillMenuController(
      api: SilentApi(VoidStore()),
      botId: 'bot-1',
    )..catalog = [entry('review'), entry('ship')];
    addTearDown(editor.dispose);
    addTearDown(focus.dispose);
    addTearDown(skills.dispose);

    await tester.pumpWidget(
      MaterialApp(
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
              skills: skills,
            ),
          ),
        ),
      ),
    );

    // Not a keystroke: the text arrives on the controller, which is the one
    // thing every path that changes the draft has in common.
    editor.value = const TextEditingValue(
      text: '/',
      selection: TextSelection.collapsed(offset: 1),
    );
    await tester.pumpAndSettle();
    expect(find.byType(SkillMenu), findsOneWidget);
  });
}
