/// Choosing a Skill must not cost the composer its trigger.
///
/// Attaching rewrites the field from Dart, and no `onChanged` follows a write
/// the widget did not receive from the engine — so the popover's idea of the
/// text stayed at the message the trigger had been in, and a later `/` was
/// matched against it and opened nothing.
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
}
