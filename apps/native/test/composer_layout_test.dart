import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/shell/composer.dart';
import 'package:frockbot_native/shell/skill_menu.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'skill_popover_reopen_test.dart' show SilentApi, VoidStore;

void main() {
  for (final scale in [0.85, 1.0, 2.0, 3.0]) {
    testWidgets(
      'draft, /stop and Send remain usable at ${scale}x with keyboard',
      (tester) async {
        tester.view.physicalSize = const Size(320, 800);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final editor = TextEditingController();
        final focus = FocusNode();
        final skills = SkillMenuController(
          api: SilentApi(VoidStore()),
          botId: 'bot-1',
        );
        addTearDown(editor.dispose);
        addTearDown(focus.dispose);
        addTearDown(skills.dispose);
        var stops = 0;
        String? sent;
        await tester.pumpWidget(
          MaterialApp(
            theme: FrockTheme.theme(Brightness.dark),
            home: Builder(
              builder: (context) => MediaQuery(
                data: MediaQuery.of(context).copyWith(
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
                      onSend: () async {
                        sent = editor.text;
                      },
                      onStop: () async {
                        stops++;
                      },
                      onChanged: (_) {},
                      skills: skills,
                    ),
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
        final body = FrockTheme.theme(Brightness.dark)
            .textTheme
            .bodyLarge!
            .fontSize!;
        expect(tester.widget<TextField>(field).style!.fontSize, body);
        expect(
          MediaQuery.textScalerOf(tester.element(field)).scale(body),
          body * scale,
        );
        expect(tester.widget<TextField>(field).decoration!.labelText, isNull);
        // Stop is the command typed on its own; choosing it sends nothing
        // and leaves the field empty for what they say next.
        final draft = editor.text;
        await tester.enterText(field, '/stop');
        await tester.pump();
        await tester.ensureVisible(find.byKey(const ValueKey('command:stop')));
        await tester.tap(find.byKey(const ValueKey('command:stop')));
        await tester.pump();
        expect(stops, 1);
        expect(sent, isNull);
        expect(editor.text, isEmpty);
        expect(tester.takeException(), isNull);
        await tester.enterText(field, draft);
        await tester.pump();
        await tester.tap(find.byTooltip('Send'));
        expect(sent, editor.text);
        expect(tester.takeException(), isNull);
      },
    );
  }
}
