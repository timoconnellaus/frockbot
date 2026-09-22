import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/shell/person_avatar.dart';
import 'package:frockbot_native/shell/semantics.dart';
import 'package:frockbot_native/shell/sidebar.dart';
import 'package:frockbot_native/theme/frock_theme.dart';
import 'package:frockbot_native/theme/initials.dart';

Finder identifiedBy(String id) => find.byWidgetPredicate(
  (widget) => widget is Semantics && widget.properties.identifier == id,
);

void main() {
  test('initials are the first letters of the name, not Voice', () {
    expect(personInitialsV1('Tim O’Connell'), 'TO');
    expect(personInitialsV1('Tim OConnell'), 'TO');
    expect(personInitialsV1('Ada'), 'A');
    expect(personInitialsV1('ada@example.com'), 'AE');
    expect(personInitialsV1('  '), '?');
    expect(personInitialsV1('Voice'), 'V');
  });

  testWidgets('the person avatar draws initials from the name', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: const Scaffold(
          body: PersonAvatar(name: 'Tim OConnell', size: 48),
        ),
      ),
    );
    expect(find.text('TO'), findsOneWidget);
    expect(find.text('V'), findsNothing);
  });

  testWidgets('the You control is the person\'s face, not a person icon', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: Scaffold(
          body: ShellSidebar(
            bots: const [],
            profiles: const {},
            unread: const {},
            archived: const {},
            activeBotId: null,
            focusedBotId: null,
            workingBotId: null,
            loaded: true,
            showHidden: false,
            onSelect: (_) {},
            onCreateBot: () {},
            onSearch: () {},
            onProfile: () {},
            profileName: 'Tim OConnell',
            onMarketplace: () {},
            onVoice: () {},
            voiceControl: VoiceControlState.idle,
            onToggleHidden: () {},
            onRetry: () async {},
          ),
        ),
      ),
    );
    expect(
      find.descendant(
        of: identifiedBy(ShellIds.sidebarProfile),
        matching: find.byType(PersonAvatar),
      ),
      findsOneWidget,
    );
    expect(find.text('TO'), findsOneWidget);
    expect(find.byIcon(Icons.person_rounded), findsNothing);
  });
}
