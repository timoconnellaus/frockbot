/// Enter sends and Shift+Enter breaks the line, where there is a Shift key.
///
/// On a phone's soft keyboard Enter keeps breaking the line: there is no
/// Shift+Enter there, and Send is the button. Cmd+Enter and Ctrl+Enter send
/// everywhere, as they did before.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/shell/chat_icons.dart';
import 'package:frockbot_native/shell/composer.dart';
import 'package:frockbot_native/shell/skill_menu.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

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

Future<({TextEditingController editor, List<String> sent})> pumpComposer(
  WidgetTester tester, {
  bool ready = true,
  SkillMenuController? skills,
  VoidCallback? onDictate,
}) async {
  final editor = TextEditingController();
  final focus = FocusNode();
  final sent = <String>[];
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
            ready: ready,
            stoppable: false,
            stopping: false,
            onSend: () async => sent.add(editor.text),
            onStop: () async {},
            onChanged: (_) {},
            skills: skills,
            onDictate: onDictate,
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.byKey(const ValueKey('composer')));
  await tester.pump();
  return (editor: editor, sent: sent);
}

Future<void> pressEnter(WidgetTester tester, {bool shift = false}) async {
  if (shift) await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
  await tester.sendKeyEvent(LogicalKeyboardKey.enter);
  if (shift) await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
  await tester.pump();
}

void main() {
  group('with a keyboard', () {
    final desktop = TargetPlatformVariant.desktop();

    testWidgets('Enter sends the draft', (tester) async {
      final c = await pumpComposer(tester);
      await tester.enterText(find.byKey(const ValueKey('composer')), 'Hello');
      await tester.pump();
      await pressEnter(tester);
      expect(c.sent, ['Hello']);
    }, variant: desktop);

    testWidgets('Shift+Enter is left to the field', (tester) async {
      final c = await pumpComposer(tester);
      await tester.enterText(find.byKey(const ValueKey('composer')), 'Hello');
      await tester.pump();
      await pressEnter(tester, shift: true);
      expect(c.sent, isEmpty);
      expect(c.editor.text, 'Hello');
    }, variant: desktop);

    testWidgets('Enter on an empty draft sends nothing and adds no line', (
      tester,
    ) async {
      final c = await pumpComposer(tester);
      await pressEnter(tester);
      expect(c.sent, isEmpty);
      expect(c.editor.text, '');
    }, variant: desktop);

    testWidgets('Enter does not send while the client cannot', (tester) async {
      final c = await pumpComposer(tester, ready: false);
      await tester.enterText(find.byKey(const ValueKey('composer')), 'Hello');
      await tester.pump();
      await pressEnter(tester);
      expect(c.sent, isEmpty);
      expect(c.editor.text, 'Hello');
    }, variant: desktop);

    testWidgets('Enter takes the highlighted Skill while the popover is up', (
      tester,
    ) async {
      final skills = SkillMenuController(
        api: SilentApi(VoidStore()),
        botId: 'bot-1',
      )..catalog = [entry('review'), entry('ship')];
      addTearDown(skills.dispose);
      final c = await pumpComposer(tester, skills: skills);
      await tester.enterText(find.byKey(const ValueKey('composer')), '/');
      await tester.pumpAndSettle();
      expect(find.byType(SkillMenu), findsOneWidget);
      await pressEnter(tester);
      await tester.pumpAndSettle();
      expect(find.byType(SkillMenu), findsNothing);
      expect(c.sent, isEmpty);
      expect(c.editor.text, '');
      expect([for (final e in skills.attached) e.ref], ['bot:review']);
    }, variant: desktop);
  });

  group('on a phone', () {
    final phones = TargetPlatformVariant({
      TargetPlatform.android,
      TargetPlatform.iOS,
    });

    testWidgets('Enter alone does not send; Ctrl+Enter still does', (
      tester,
    ) async {
      final c = await pumpComposer(tester);
      await tester.enterText(find.byKey(const ValueKey('composer')), 'Hello');
      await tester.pump();
      await pressEnter(tester);
      expect(c.sent, isEmpty);
      await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
      await tester.pump();
      expect(c.sent, ['Hello']);
    }, variant: phones);
  });

  testWidgets('the corner button is centred on a one-line draft', (
    tester,
  ) async {
    await pumpComposer(tester, onDictate: () {});
    final mic = find.byKey(const ValueKey('dictate'));
    expect(mic, findsOneWidget);
    expect(find.byType(ChatIcon), findsOneWidget);
    final field = tester.getRect(find.byKey(const ValueKey('composer')));
    final button = tester.getRect(mic);
    expect(button.center.dy, closeTo(field.center.dy, 0.5));
    // The glyph itself sits in the middle of the button.
    final glyph = tester.getRect(find.byType(ChatIcon));
    expect(glyph.center.dx, closeTo(button.center.dx, 0.5));
    expect(glyph.center.dy, closeTo(button.center.dy, 0.5));
  }, variant: TargetPlatformVariant.all());
}
