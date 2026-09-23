/// A running reply is stopped with `/stop`, typed in the composer.
///
/// It is a command, not a message: offered only while there is something to
/// stop, run the moment it is chosen, and never sent to the Bot.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/shell/composer.dart';
import 'package:frockbot_native/shell/skill_menu.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'skill_popover_reopen_test.dart' show SilentApi, VoidStore;

SkillCatalogEntry _skill(String slug) => SkillCatalogEntry(
  ref: 'bot:$slug',
  skill: {'schemaVersion': 1, 'source': 'bot', 'slug': slug},
  name: slug,
  description: '',
  path: '/skills/$slug',
);

void main() {
  late TextEditingController editor;
  late FocusNode focus;
  late SkillMenuController skills;
  late int stops;
  late List<String> sent;

  setUp(() {
    editor = TextEditingController();
    focus = FocusNode();
    skills = SkillMenuController(api: SilentApi(VoidStore()), botId: 'bot-1')
      ..catalog = [_skill('standup'), _skill('review')];
    stops = 0;
    sent = [];
  });

  tearDown(() {
    editor.dispose();
    focus.dispose();
    skills.dispose();
  });

  Future<void> mount(
    WidgetTester tester, {
    required bool stoppable,
    String? botName,
  }) => tester.pumpWidget(
    MaterialApp(
      theme: FrockTheme.theme(Brightness.dark),
      home: Scaffold(
        body: Align(
          alignment: Alignment.bottomCenter,
          child: Composer(
            editor: editor,
            focus: focus,
            ready: true,
            botName: botName,
            stoppable: stoppable,
            onSend: () async => sent.add(editor.text),
            onStop: () async => stops++,
            onChanged: (_) {},
            skills: skills,
          ),
        ),
      ),
    ),
  );

  final field = find.byKey(const ValueKey('composer'));
  final stop = find.byKey(const ValueKey('command:stop'));

  testWidgets('/stop is offered only while a reply runs', (tester) async {
    await mount(tester, stoppable: false);
    await tester.enterText(field, '/');
    await tester.pump();
    expect(find.text('review'), findsOneWidget);
    expect(stop, findsNothing);
    expect(find.text('Commands'), findsNothing);

    await mount(tester, stoppable: true);
    await tester.enterText(field, '/');
    await tester.pump();
    expect(stop, findsOneWidget);
    expect(find.text('Commands'), findsOneWidget);
    expect(find.text('Skills'), findsOneWidget);
    // Listed ahead of the Skills, and the one Enter chooses.
    expect(
      tester.getTopLeft(stop).dy,
      lessThan(tester.getTopLeft(find.text('review')).dy),
    );
    expect(skills.highlightedCommand?.name, stopCommandName);

    // A query that is not the command's name drops it.
    await tester.enterText(field, '/rev');
    await tester.pump();
    expect(stop, findsNothing);
    expect(find.text('review'), findsOneWidget);
  });

  // Where Enter sends; on a phone's soft keyboard Enter is a line break and
  // the row is tapped instead (composer_layout_test).
  final desktop = TargetPlatformVariant.desktop();

  testWidgets('choosing /stop with Enter stops and sends nothing', (
    tester,
  ) async {
    await mount(tester, stoppable: true);
    await tester.enterText(field, '/st');
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(stops, 1);
    expect(sent, isEmpty);
    expect(editor.text, isEmpty);
    expect(skills.open, isFalse);
    expect(skills.attached, isEmpty);
  }, variant: desktop);

  testWidgets('the arrows move from the command into the Skills', (
    tester,
  ) async {
    await mount(tester, stoppable: true);
    await tester.enterText(field, '/');
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.pump();
    expect(skills.highlightedCommand, isNull);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(stops, 0);
    expect(skills.attached.single.ref, 'bot:review');
  }, variant: desktop);

  testWidgets('the empty composer is addressed to the Bot by name', (
    tester,
  ) async {
    await mount(tester, stoppable: true, botName: 'Fox');
    final decoration = tester.widget<TextField>(field).decoration!;
    // Whether or not a reply is running: stopping is the command's to say.
    expect(decoration.hintText, 'Message Fox');
    // A long name is cut rather than growing the field by lines.
    expect(decoration.hintMaxLines, 1);

    await mount(tester, stoppable: false);
    expect(
      tester.widget<TextField>(field).decoration!.hintText,
      'Message your Bot',
    );
  });
}
