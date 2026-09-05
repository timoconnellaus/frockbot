import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/extensions/catalog.dart';

void main() {
  test('deterministic tree detaches caller state', () {
    final decoded = validateDocument(deterministicForm);
    decoded[0]['children'] = [];
    expect(deterministicForm[0]['children'], ['intro', 'name', 'save']);
  });
  test('cyclic data, cyclic graph, shared child, unknown and oversized regions fail closed', () {
    final cycle = <Object>[];
    cycle.add(cycle);
    final invalid = <Object>[
      cycle,
      [
        {
          'id': 'root',
          'component': 'Column',
          'children': ['root'],
        },
      ],
      [
        {
          'id': 'root',
          'component': 'Column',
          'children': ['child', 'child'],
        },
        {'id': 'child', 'component': 'Text', 'text': 'Hi'},
      ],
      [
        {'id': 'root', 'component': 'WebView', 'url': 'https://evil.test'},
      ],
      [
        {'id': 'root', 'component': 'Text', 'text': '<script>steal()</script>'},
      ],
      [
        {
          'id': 'root',
          'component': 'Text',
          'text': 'hello',
          'function': 'native.open',
        },
      ],
      List.generate(
        501,
        (i) => {
          'id': i == 0 ? 'root' : 'node$i',
          'component': 'Text',
          'text': 'x',
        },
      ),
      [
        {
          'id': 'root',
          'component': 'Text',
          'text': List.filled(262145, 'x').join(),
        },
      ],
      List.generate(
        17,
        (i) => {
          'id': i == 0 ? 'root' : 'node$i',
          'component': 'Column',
          'children': i == 16 ? [] : ['node${i + 1}'],
        },
      ),
    ];
    for (final value in invalid) {
      expect(() => validateDocument(value), throwsFormatException);
    }
  });
  testWidgets('real GenUI renders fixed input and isolates a hostile region', (
    tester,
  ) async {
    var saves = 0;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: CatalogRegion(
            document: jsonDecode(jsonEncode(deterministicForm)),
            submit: (input) async {
              expect(input, {'name': 'Pixel'});
              saves++;
            },
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const ValueKey('form-name')), 'Pixel');
    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle();
    expect(saves, 1);
    expect(find.text('Saved.'), findsOneWidget);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Column(
            children: [
              const Text('Conversation'),
              CatalogRegion(
                document: [
                  {'id': 'root', 'component': 'Unknown'},
                ],
                submit: (_) async {},
              ),
            ],
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Conversation'), findsOneWidget);
    expect(find.textContaining('couldn’t be opened'), findsOneWidget);
  });
}
