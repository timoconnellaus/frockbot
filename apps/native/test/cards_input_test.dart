/// The input family (ADR 0030 step 8): the answers a card can take.
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'cards_families.dart';

void main() {
  setUpAll(() async {
    if (familyVisualOutput.isNotEmpty) await loadFamilyFont();
  });

  /// A card that takes an answer and has a Button to send it with: the shape
  /// `input.md` tells a Bot to write.
  List<Map<String, Object?>> withSubmit(Map<String, Object?> control) => [
    {
      'id': 'root',
      'component': 'Column',
      'children': ['control', 'send'],
    },
    control,
    {
      'id': 'send',
      'component': 'Button',
      'child': 'sendLabel',
      'action': {
        'event': {'name': 'submit'},
      },
    },
    {'id': 'sendLabel', 'component': 'Text', 'text': 'Send'},
  ];

  testWidgets('ChoiceChips writes the pick where a press will carry it', (
    tester,
  ) async {
    final posts = await drawFamily(
      tester,
      withSubmit({
        'id': 'control',
        'component': 'ChoiceChips',
        'value': {'path': '/tone'},
        'options': [
          {'label': 'Warm', 'value': 'warm'},
          {'label': 'Brief', 'value': 'brief'},
          {'label': 'Formal', 'value': 'formal'},
        ],
      }),
      dataModel: {'tone': 'warm'},
      sendDataModel: true,
    );
    expect(find.text('Warm'), findsOneWidget);
    await tester.tap(find.text('Formal'));
    await tester.pumpAndSettle();
    await captureFamily(tester, 'family-input-chips');
    await tester.tap(find.text('Send'));
    await tester.pumpAndSettle();
    expect(posts.single['dataModel'], {'tone': 'formal'});
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a chip with its own action is a press the moment it is tapped', (
    tester,
  ) async {
    final posts = await drawFamily(tester, [
      {
        'id': 'root',
        'component': 'ChoiceChips',
        'value': {'path': '/when'},
        'action': {
          'event': {'name': 'pick-date'},
        },
        'options': [
          {'label': 'Tuesday', 'value': 'tue'},
          {'label': 'Wednesday', 'value': 'wed'},
        ],
      },
    ], sendDataModel: true);
    await tester.tap(find.text('Wednesday'));
    await tester.pumpAndSettle();
    expect((posts.single['event']! as Map)['name'], 'pick-date');
    expect(posts.single['dataModel'], {'when': 'wed'});
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('MultiSelect answers in the order the options were declared', (
    tester,
  ) async {
    final posts = await drawFamily(
      tester,
      withSubmit({
        'id': 'control',
        'component': 'MultiSelect',
        'values': {'path': '/include'},
        'options': [
          {'label': 'The invoice', 'value': 'invoice', 'detail': 'PDF, 1 page'},
          {'label': 'The timesheet', 'value': 'timesheet'},
          {'label': 'The contract', 'value': 'contract'},
        ],
      }),
      dataModel: {'include': <String>[]},
      sendDataModel: true,
    );
    expect(find.text('PDF, 1 page'), findsOneWidget);
    // Ticked back to front; read back front to back.
    await tester.tap(find.text('The contract'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('The invoice'));
    await tester.pumpAndSettle();
    await captureFamily(tester, 'family-input-multiselect');
    await tester.tap(find.text('Send'));
    await tester.pumpAndSettle();
    expect(posts.single['dataModel'], {
      'include': ['invoice', 'contract'],
    });
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('past maxSelected the unticked stop responding', (tester) async {
    await drawFamily(
      tester,
      [
        {
          'id': 'root',
          'component': 'MultiSelect',
          'values': {'path': '/include'},
          'maxSelected': 1,
          'options': [
            {'label': 'The invoice', 'value': 'invoice'},
            {'label': 'The timesheet', 'value': 'timesheet'},
          ],
        },
      ],
      dataModel: {
        'include': ['invoice'],
      },
    );
    expect(find.text('Pick one.'), findsOneWidget);
    await tester.tap(find.text('The timesheet'));
    await tester.pumpAndSettle();
    // Still the one they chose: a limit never undoes an earlier choice.
    final boxes = tester.widgetList<Checkbox>(find.byType(Checkbox)).toList();
    expect(boxes.first.value, isTrue);
    expect(boxes.last.value, isFalse);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('SegmentedControl lights the first segment when nothing is set', (
    tester,
  ) async {
    final posts = await drawFamily(tester, [
      {
        'id': 'root',
        'component': 'SegmentedControl',
        'value': {'path': '/view'},
        'action': {
          'event': {'name': 'view'},
        },
        'options': [
          {'label': 'Summary', 'value': 'summary'},
          {'label': 'Full', 'value': 'full'},
        ],
      },
    ], sendDataModel: true);
    final button = tester.widget<SegmentedButton<String>>(
      find.byType(SegmentedButton<String>),
    );
    expect(button.selected, {'summary'});
    await tester.tap(find.text('Full'));
    await tester.pumpAndSettle();
    expect(posts.single['dataModel'], {'view': 'full'});
    await captureFamily(tester, 'family-input-segmented');
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('Rating takes stars, and the star it is on clears it', (
    tester,
  ) async {
    final posts = await drawFamily(
      tester,
      withSubmit({
        'id': 'control',
        'component': 'Rating',
        'label': 'How was that reply?',
        'value': {'path': '/stars'},
      }),
      dataModel: {'stars': 0},
      sendDataModel: true,
    );
    expect(find.text('How was that reply?'), findsOneWidget);
    await tester.tap(find.bySemanticsLabel('4 of 5'));
    await tester.pumpAndSettle();
    expect(find.byIcon(Icons.star), findsNWidgets(4));
    await captureFamily(tester, 'family-input-rating');
    await tester.tap(find.bySemanticsLabel('4 of 5'));
    await tester.pumpAndSettle();
    expect(find.byIcon(Icons.star), findsNothing);
    await tester.tap(find.bySemanticsLabel('2 of 5'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Send'));
    await tester.pumpAndSettle();
    expect(posts.single['dataModel'], {'stars': 2});
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a read-only Rating shows a rating rather than asking for one', (
    tester,
  ) async {
    await drawFamily(tester, [
      {
        'id': 'root',
        'component': 'Rating',
        'value': 3,
        'max': 5,
        'readOnly': true,
      },
    ]);
    expect(find.byIcon(Icons.star), findsNWidgets(3));
    for (final button in tester.widgetList<IconButton>(
      find.byType(IconButton),
    )) {
      expect(button.onPressed, isNull);
    }
    await tester.pumpWidget(const SizedBox());
  });
}
