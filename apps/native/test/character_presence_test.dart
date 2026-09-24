import 'package:flutter/gestures.dart' show PointerDeviceKind;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/flock/avatar.dart';
import 'package:frockbot_native/groups/faces.dart';

/// A Bot drawn where the shell draws it at once: a square in the sidebar and
/// the cropped companion in the header, beside another Bot's sidebar row.
Widget cast({
  ValueNotifier<Offset?>? gaze,
  bool header = true,
  bool working = false,
  bool headerWorking = false,
}) => MaterialApp(
  home: Scaffold(
    body: Row(
      children: [
        CharacterAvatar(
          key: const ValueKey('sidebar'),
          botId: 'bob',
          characterId: 'pixel',
          motion: CharacterMotion.quiet,
          working: working,
        ),
        const SizedBox(width: 40),
        if (header)
          CharacterAvatar(
            key: const ValueKey('header'),
            size: 52,
            botId: 'bob',
            characterId: 'pixel',
            cropToInk: true,
            motion: CharacterMotion.quiet,
            gaze: gaze,
            working: headerWorking,
          ),
        const SizedBox(width: 40),
        const CharacterAvatar(
          key: ValueKey('dog'),
          botId: 'dog',
          characterId: 'dog',
          motion: CharacterMotion.quiet,
        ),
      ],
    ),
  ),
);

dynamic avatar(WidgetTester tester, String key) =>
    tester.state(find.byKey(ValueKey(key)));

double light(WidgetTester tester, Finder sheen) =>
    (tester.state(sheen) as dynamic).light as double;

void main() {
  testWidgets('every avatar of a Bot greets a pointer together', (
    tester,
  ) async {
    await tester.pumpWidget(cast());
    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    await mouse.addPointer(location: const Offset(600, 500));
    addTearDown(mouse.removePointer);

    await mouse.moveTo(tester.getCenter(find.byKey(const ValueKey('sidebar'))));
    await tester.pump();
    expect(avatar(tester, 'sidebar').greeting, isTrue);
    expect(avatar(tester, 'header').greeting, isTrue);
    expect(avatar(tester, 'dog').greeting, isFalse);

    await mouse.moveTo(const Offset(600, 500));
    await tester.pump();
    expect(avatar(tester, 'sidebar').greeting, isFalse);
    expect(avatar(tester, 'header').greeting, isFalse);

    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a Bot twitches everywhere it is drawn at once', (tester) async {
    await tester.pumpWidget(cast());
    var twitched = false;
    for (var at = 0; at < 19000; at += 50) {
      await tester.pump(const Duration(milliseconds: 50));
      final sidebar = avatar(tester, 'sidebar').greeting as bool;
      expect(avatar(tester, 'header').greeting, sidebar);
      twitched |= sidebar;
    }
    expect(twitched, isTrue);

    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a Bot looks where its header companion looks', (tester) async {
    final gaze = ValueNotifier<Offset?>(null);
    addTearDown(gaze.dispose);
    await tester.pumpWidget(cast(gaze: gaze));

    gaze.value = const Offset(0.6, -0.3);
    expect(avatar(tester, 'sidebar').looking, const Offset(0.6, -0.3));
    expect(avatar(tester, 'header').looking, const Offset(0.6, -0.3));
    expect(avatar(tester, 'dog').looking, isNull);

    // The conversation closed with the pointer still over it: nothing is
    // left for the rest of the Bot to stare at.
    await tester.pumpWidget(cast(gaze: gaze, header: false));
    expect(avatar(tester, 'sidebar').looking, isNull);

    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a working Bot holds still, looks ahead and wears the light', (
    tester,
  ) async {
    final gaze = ValueNotifier<Offset?>(null);
    addTearDown(gaze.dispose);
    await tester.pumpWidget(cast(gaze: gaze, working: true));

    final sidebar = find.byKey(const ValueKey('sidebar'));
    expect(
      find.descendant(of: sidebar, matching: find.byType(WorkingSheen)),
      findsOneWidget,
    );
    gaze.value = const Offset(0.6, -0.3);
    expect(avatar(tester, 'sidebar').looking, isNull);

    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    await mouse.addPointer(location: tester.getCenter(sidebar));
    addTearDown(mouse.removePointer);
    await tester.pump();
    expect(avatar(tester, 'sidebar').greeting, isFalse);

    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('every working light is on the one clock', (tester) async {
    await tester.pumpWidget(cast(working: true, header: false));
    // The header appears well into the sidebar's pass, as it does when a
    // conversation is opened on a Bot already working.
    await tester.pump(const Duration(milliseconds: 170));
    await tester.pumpWidget(cast(working: true, headerWorking: true));
    final sidebar = find.descendant(
      of: find.byKey(const ValueKey('sidebar')),
      matching: find.byType(WorkingSheen),
    );
    final header = find.descendant(
      of: find.byKey(const ValueKey('header')),
      matching: find.byType(WorkingSheen),
    );
    final seen = <double>{};
    for (var at = 0; at < workingSheenCycle.inMilliseconds; at += 60) {
      await tester.pump(const Duration(milliseconds: 60));
      expect(light(tester, header), light(tester, sidebar));
      seen.add(light(tester, sidebar));
    }
    expect(seen.length, greaterThan(3));

    // The light meets the drawing, not the empty canvas a square keeps
    // around it, so it crosses the silhouette in the same time in both.
    final ink = characterCatalogV1['pixel']!.ink;
    expect(tester.widget<WorkingSheen>(sidebar).across, ink.withinSquare);
    expect(
      tester.widget<WorkingSheen>(header).across,
      const Rect.fromLTWH(0, 0, 1, 1),
    );

    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('with less motion the light holds still across the middle', (
    tester,
  ) async {
    await tester.pumpWidget(
      MediaQuery(
        data: const MediaQueryData(disableAnimations: true),
        child: cast(working: true, headerWorking: true),
      ),
    );
    final sheens = find.byType(WorkingSheen);
    for (var at = 0; at < 5; at++) {
      await tester.pump(const Duration(milliseconds: 300));
      for (final sheen in sheens.evaluate()) {
        expect(((sheen as StatefulElement).state as dynamic).light, 0.5);
      }
    }

    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a working group shines as one picture', (tester) async {
    const faces = [
      GroupFace(botId: 'bob', name: 'Bob', characterId: 'pixel'),
      GroupFace(botId: 'dog', name: 'Dog', characterId: 'dog'),
    ];
    await tester.pumpWidget(
      const MaterialApp(home: GroupAvatars(faces: faces)),
    );
    expect(find.byType(WorkingSheen), findsNothing);
    await tester.pumpWidget(
      const MaterialApp(home: GroupAvatars(faces: faces, working: true)),
    );
    expect(find.byType(WorkingSheen), findsOneWidget);

    await tester.pumpWidget(const SizedBox());
  });
}
