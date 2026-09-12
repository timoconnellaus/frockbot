import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/protocol/client_wire.generated.dart' as wire;
import 'package:frockbot_native/theme/frock_theme.dart';
import 'package:frockbot_native/view/action.dart';
import 'package:frockbot_native/view/budgets.dart';
import 'package:frockbot_native/view/document.dart';
import 'package:frockbot_native/view/embed.dart';
import 'package:frockbot_native/view/sample_page.dart';

import 'widget_test.dart' show MemoryStore;

const _openAction = {
  'id': 'open',
  'schema': {
    'type': 'object',
    'properties': <String, Object?>{},
    'required': <String>[],
    'additionalProperties': false,
  },
};

Map<String, Object?> document(
  Map<String, Object?> root, {
  List<Object?> actions = const [_openAction],
}) => {
  'schemaVersion': 1,
  'surfaceId': 'sample',
  'revision': 1,
  'root': root,
  'actions': actions,
};

const _enableAction = {
  'id': 'set-package-enabled',
  'schema': {
    'type': 'object',
    'properties': {
      'kind': {
        'type': 'string',
        'enum': ['set-package-enabled'],
      },
      'packageId': {'type': 'string', 'maxLength': 128},
      'enabled': {'type': 'boolean'},
    },
    'required': ['kind', 'packageId', 'enabled'],
    'additionalProperties': false,
  },
};

const _installAction = {
  'id': 'install-package',
  'schema': {
    'type': 'object',
    'properties': {
      'kind': {
        'type': 'string',
        'enum': ['install-package'],
      },
      'packageId': {'type': 'string', 'maxLength': 128},
      'version': {'type': 'string', 'maxLength': 64},
    },
    'required': ['kind', 'packageId', 'version'],
    'additionalProperties': false,
  },
};

const _deleteRoutine = {
  'id': 'delete-routine',
  'schema': {
    'type': 'object',
    'properties': {
      'kind': {
        'type': 'string',
        'enum': ['delete-routine'],
      },
      'routineId': {'type': 'string', 'maxLength': 200},
    },
    'required': ['kind', 'routineId'],
    'additionalProperties': false,
  },
};

const _chooseA = {
  'id': 'choose-a',
  'schema': {
    'type': 'object',
    'properties': <String, Object?>{},
    'required': <String>[],
    'additionalProperties': false,
  },
};

const _chooseB = {
  'id': 'choose-b',
  'schema': {
    'type': 'object',
    'properties': <String, Object?>{},
    'required': <String>[],
    'additionalProperties': false,
  },
};

/// A Plugins card, as `pluginsDocumentV1` draws one: the switch beside the
/// title is the card's own action read backwards, and the same switch carries
/// an install on a package that is not there yet.
Map<String, Object?> _card({required bool on, bool installing = false}) => {
  'type': 'group',
  'orientation': 'column',
  'children': [
    {
      'type': 'group',
      'orientation': 'column',
      'title': 'Ollama Cloud',
      'children': [
        {'type': 'text', 'text': 'Models', 'style': 'label'},
        {
          'type': 'group',
          'orientation': 'row',
          'children': [
            {
              'type': 'action',
              'actionId': installing
                  ? 'install-package'
                  : 'set-package-enabled',
              'label': on ? 'Turn off' : 'Turn on',
              'input': installing
                  ? {
                      'kind': 'install-package',
                      'packageId': 'provider-ollama-cloud',
                      'version': '1.0.0',
                    }
                  : {
                      'kind': 'set-package-enabled',
                      'packageId': 'provider-ollama-cloud',
                      'enabled': !on,
                    },
            },
          ],
        },
      ],
    },
  ],
};

/// A list whose rows are a choice: one of them is the answer.
Map<String, Object?> _rows() => {
  'type': 'list',
  'rows': [
    {
      'id': 'a',
      'actionId': 'choose-a',
      'selected': true,
      'node': {'type': 'text', 'text': 'Sydney'},
    },
    {
      'id': 'b',
      'actionId': 'choose-b',
      'node': {'type': 'text', 'text': 'Frankfurt'},
    },
  ],
};

/// Two Routines, each a titled group with a Delete, as
/// `routinesDocumentV1` draws them.
Map<String, Object?> _routines() => {
  'type': 'group',
  'orientation': 'column',
  'children': [
    for (final name in ['Morning digest', 'Evening digest'])
      {
        'type': 'group',
        'orientation': 'column',
        'title': name,
        'children': [
          {
            'type': 'action',
            'actionId': 'delete-routine',
            'label': name == 'Morning digest' ? 'Delete' : 'Delete too',
            'style': 'danger',
            'input': {'kind': 'delete-routine', 'routineId': name},
          },
        ],
      },
  ],
};

class Harness {
  final MemoryStore store = MemoryStore();
  final List<Map<String, Object?>> dispatched = [];
  Map<String, Object?> receipt = const {'status': 'applied'};

  /// Held open to look at what the client drew for itself while the command
  /// is still in flight, which is the whole of what a prediction covers.
  Completer<void>? gate;
  late final ViewController controller = ViewController(
    store: store,
    userId: 'tim',
    surfaceId: 'sample',
    revision: 1,
    dispatch: (command) async {
      dispatched.add(command);
      if (gate != null) await gate!.future;
      return {'commandId': command['commandId'], ...receipt};
    },
  );
}

Future<Harness> pump(
  WidgetTester tester,
  Map<String, Object?> json, {
  Map<String, ViewFrameBuilder>? frames,
  bool cardGroups = false,
}) async {
  final harness = Harness();
  await tester.pumpWidget(
    MaterialApp(
      theme: FrockTheme.theme(Brightness.dark),
      home: Scaffold(
        body: SingleChildScrollView(
          child: ViewDocumentView(
            document: wire.ViewDocument.fromJson(json),
            controller: harness.controller,
            frames: frames,
            cardGroups: cardGroups,
          ),
        ),
      ),
    ),
  );
  return harness;
}

void main() {
  testWidgets('text renders its four styles as host typography', (
    tester,
  ) async {
    await pump(
      tester,
      document({
        'type': 'group',
        'orientation': 'column',
        'children': [
          {'type': 'text', 'text': 'Plain'},
          {'type': 'text', 'text': 'Heading', 'style': 'heading'},
          {'type': 'text', 'text': 'Label', 'style': 'label'},
          {'type': 'text', 'text': 'Working…', 'style': 'status'},
        ],
      }),
    );
    for (final text in ['Plain', 'Heading', 'Label', 'Working…']) {
      expect(find.text(text), findsOneWidget);
    }
    final heading = tester.widget<Text>(find.text('Heading')).style!;
    expect(heading.fontSize, 16);
    expect(heading.fontWeight, FontWeight.w700);
  });

  testWidgets('group titles its children and collapses when it says so', (
    tester,
  ) async {
    await pump(
      tester,
      document({
        'type': 'group',
        'orientation': 'column',
        'title': 'Details',
        'collapsed': true,
        'children': [
          {'type': 'text', 'text': 'Hidden until opened'},
        ],
      }),
    );
    expect(find.text('Details'), findsOneWidget);
    expect(find.text('Hidden until opened'), findsNothing);
    await tester.tap(find.text('Details'));
    await tester.pumpAndSettle();
    expect(find.text('Hidden until opened'), findsOneWidget);
  });

  testWidgets('field binds one typed input to its key', (tester) async {
    final harness = await pump(
      tester,
      document({
        'type': 'group',
        'orientation': 'column',
        'children': [
          {
            'type': 'field',
            'field': {
              'id': 'name',
              'label': 'Name',
              'kind': 'text',
              'value': 'Sydney',
              'editable': true,
            },
          },
          {
            'type': 'field',
            'field': {
              'id': 'notify',
              'label': 'Notify me',
              'kind': 'boolean',
              'value': false,
              'editable': true,
            },
          },
        ],
      }),
    );
    expect(harness.controller.values, {'name': 'Sydney', 'notify': false});
    await tester.enterText(find.byType(TextFormField), 'Frankfurt');
    await tester.tap(find.byType(SwitchListTile));
    await tester.pump();
    expect(harness.controller.values, {'name': 'Frankfurt', 'notify': true});
  });

  testWidgets('action submits the declared input merged with field values', (
    tester,
  ) async {
    final harness = await pump(
      tester,
      document(
        {
          'type': 'group',
          'orientation': 'column',
          'children': [
            {
              'type': 'field',
              'field': {
                'id': 'region',
                'label': 'Region',
                'kind': 'text',
                'value': 'syd',
                'editable': true,
              },
            },
            {
              'type': 'action',
              'actionId': 'deploy',
              'label': 'Deploy',
              'style': 'primary',
              'input': {'confirm': true, 'region': 'ignored'},
            },
          ],
        },
        actions: [
          {
            'id': 'deploy',
            'schema': {
              'type': 'object',
              'properties': {
                'region': {'type': 'string', 'maxLength': 64},
                'confirm': {'type': 'boolean'},
              },
              'required': ['region'],
              'additionalProperties': false,
            },
          },
        ],
      ),
    );
    await tester.tap(find.text('Deploy'));
    await tester.pumpAndSettle();
    expect(harness.dispatched, hasLength(1));
    expect(harness.dispatched.single['input'], {
      'confirm': true,
      'region': 'syd',
    });
    expect(harness.dispatched.single['surfaceId'], 'sample');
    // The command was persisted before dispatch and cleared by the receipt.
    expect(harness.store.values, isEmpty);
    expect(find.text('Done.'), findsOneWidget);
  });

  testWidgets('an uncertain action keeps its own id for the next attempt', (
    tester,
  ) async {
    final harness = await pump(
      tester,
      document({'type': 'action', 'actionId': 'open', 'label': 'Open'}),
    );
    harness.receipt = const {'status': 'pending'};
    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();
    expect(harness.store.values['view-pending.tim.sample'], isNotNull);
    harness.receipt = const {'status': 'applied'};
    await tester.tap(find.text('Check that action'));
    await tester.pumpAndSettle();
    expect(harness.dispatched.map((c) => c['commandId']).toSet(), hasLength(1));
    expect(harness.store.values, isEmpty);
  });

  testWidgets('list repeats rows, marks the selected one and dispatches', (
    tester,
  ) async {
    final harness = await pump(
      tester,
      document({
        'type': 'list',
        'empty': 'No deploys yet.',
        'rows': [
          {
            'id': 'syd',
            'selected': true,
            'node': {'type': 'text', 'text': 'Sydney'},
          },
          {
            'id': 'fra',
            'actionId': 'open',
            'node': {'type': 'text', 'text': 'Frankfurt'},
          },
        ],
      }),
    );
    expect(find.byIcon(Icons.check_rounded), findsOneWidget);
    await tester.tap(find.text('Frankfurt'));
    await tester.pumpAndSettle();
    expect(harness.dispatched.single['actionId'], 'open');
  });

  testWidgets('an empty list says so rather than leaving a hole', (
    tester,
  ) async {
    await pump(
      tester,
      document({
        'type': 'list',
        'empty': 'No deploys yet.',
        'rows': <Object?>[],
      }),
    );
    expect(find.text('No deploys yet.'), findsOneWidget);
  });

  testWidgets('embed draws host frames and refuses a name the host has not', (
    tester,
  ) async {
    await pump(
      tester,
      document({
        'type': 'group',
        'orientation': 'column',
        'children': [
          {
            'type': 'embed',
            'kind': 'frame',
            'source': appletViewerFrameV1,
            'label': 'Applet preview',
          },
          {
            'type': 'embed',
            'kind': 'frame',
            'source': 'trust-chrome',
            'label': 'Account',
          },
        ],
      }),
    );
    expect(find.text('The Applet viewer opens here.'), findsOneWidget);
    expect(hostViewFramesV1.containsKey(computerViewerFrameV1), isTrue);
    expect(
      find.text('This part of the view isn’t available here.'),
      findsOneWidget,
    );
  });

  testWidgets('the budgets refuse a document before a widget is built', (
    tester,
  ) async {
    Map<String, Object?> nest(int depth) => depth == 0
        ? {'type': 'text', 'text': 'leaf'}
        : {
            'type': 'group',
            'orientation': 'column',
            'children': [nest(depth - 1)],
          };
    await pump(tester, document(nest(maxViewDepthV1 + 1)));
    expect(find.text('leaf'), findsNothing);
    expect(
      find.text('This view is nested deeper than the host renders.'),
      findsOneWidget,
    );

    await pump(tester, document(nest(maxViewDepthV1 - 1)));
    expect(find.text('leaf'), findsOneWidget);

    // Inside the schema's own 256-child cap, so what refuses this is the node
    // budget rather than the shape.
    final wide = {
      'type': 'group',
      'orientation': 'column',
      'children': [
        for (var group = 0; group < 3; group++)
          {
            'type': 'group',
            'orientation': 'column',
            'children': [
              for (var i = 0; i < 200; i++)
                {'type': 'text', 'text': 'row $group.$i'},
            ],
          },
      ],
    };
    await pump(tester, document(wide));
    expect(
      find.text('This view has more parts than the host renders.'),
      findsOneWidget,
    );

    expect(
      () => checkViewBudgetsV1(
        document({'type': 'text', 'text': 'x' * (maxViewBytesV1 + 1)}),
      ),
      throwsA(isA<ViewBudgetFailure>()),
    );
  });

  test('the schema refuses a node the renderer would have to guess at', () {
    expect(
      () => wire.ViewDocument.fromJson(
        document({'type': 'card', 'text': 'Ready.'}),
      ),
      throwsFormatException,
    );
    expect(
      () => wire.ViewNode.fromJson({
        'type': 'embed',
        'kind': 'frame',
        'source': 'https://attacker.example/frame.html',
        'label': 'Applet preview',
      }),
      throwsFormatException,
    );
  });

  test('an input the action never declared does not travel', () {
    const schema = {
      'type': 'object',
      'properties': {
        'region': {
          'type': 'string',
          'enum': ['syd', 'fra'],
        },
      },
      'required': ['region'],
      'additionalProperties': false,
    };
    expect(
      viewActionInputV1(const {}, schema, const {
        'region': 'syd',
        'sessionToken': 'secret',
      }),
      {'region': 'syd'},
    );
    expect(
      () => viewActionInputV1(const {}, schema, const {}),
      throwsFormatException,
    );
    expect(
      () => viewActionInputV1(const {}, schema, const {'region': 'mars'}),
      throwsFormatException,
    );
  });

  test('a field that was never answered does not travel as a null', () {
    const schema = {
      'type': 'object',
      'properties': {
        'region': {'type': 'string', 'maxLength': 20},
        'quota': {'type': 'number', 'minimum': 0, 'maximum': 10},
      },
      'required': <String>[],
      'additionalProperties': false,
    };
    expect(
      viewActionInputV1(const {}, schema, const {
        'region': 'syd',
        'quota': null,
      }),
      {'region': 'syd'},
    );
  });

  testWidgets('a select whose value is not one of its choices says so', (
    tester,
  ) async {
    final harness = Harness();
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: Scaffold(
          body: ViewDocumentView(
            document: wire.ViewDocument.fromJson(
              document({
                'type': 'field',
                'field': {
                  'id': 'format',
                  'label': 'Format',
                  // What an unset projected setting carries: the JSON `null`,
                  // encoded, which is no choice's value.
                  'kind': 'select',
                  'value': 'null',
                  'editable': true,
                  'choices': [
                    {'label': 'WebP', 'value': '"webp"'},
                    {'label': 'PNG', 'value': '"png"'},
                  ],
                },
              }),
            ),
            controller: harness.controller,
          ),
        ),
      ),
    );
    expect(tester.takeException(), isNull);
    expect(find.text('Not set'), findsOneWidget);
  });

  testWidgets('a host field builder owns the field its choiceSource names', (
    tester,
  ) async {
    final harness = Harness();
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: Scaffold(
          body: ViewDocumentView(
            document: wire.ViewDocument.fromJson(
              document({
                'type': 'field',
                'field': {
                  'id': 'model',
                  'label': 'Model',
                  'kind': 'select',
                  'value': 'null',
                  'editable': true,
                  'choiceSource': 'account-models',
                },
              }),
            ),
            controller: harness.controller,
            fields: {
              'account-models': (context, field, id, value, onChanged) =>
                  TextButton(
                    onPressed: onChanged == null
                        ? null
                        : () => onChanged('"picked"'),
                    child: Text('host:$id:$value'),
                  ),
            },
          ),
        ),
      ),
    );
    expect(find.text('host:model:null'), findsOneWidget);
    await tester.tap(find.byType(TextButton));
    await tester.pumpAndSettle();
    expect(harness.controller.values['model'], '"picked"');
  });

  testWidgets('the sample document renders every node type', (tester) async {
    tester.view.physicalSize = const Size(1000, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: ViewSamplePage(store: MemoryStore(), userId: 'tim'),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Deploy target'), findsOneWidget);
    expect(find.text('Recent deploys'), findsOneWidget);
    expect(find.text('Sydney · 2 minutes ago'), findsOneWidget);
    expect(find.text('Applet preview'), findsOneWidget);
    expect(find.text('Deploy'), findsOneWidget);
    // The sample is a real document, not a fixture shaped to pass.
    expect(
      jsonDecode(
        jsonEncode(wire.ViewDocument.fromJson(sampleViewDocumentV1).toJson()),
      ),
      sampleViewDocumentV1,
    );
  });

  group('what the client draws for itself', () {
    testWidgets('a plugin switch moves on the press, not on the read', (
      tester,
    ) async {
      final harness = await pump(
        tester,
        document(_card(on: true), actions: const [_enableAction]),
        cardGroups: true,
      );
      harness.gate = Completer<void>();
      expect(tester.widget<Switch>(find.byType(Switch)).value, isTrue);
      await tester.tap(find.byType(Switch));
      await tester.pump();
      expect(tester.widget<Switch>(find.byType(Switch)).value, isFalse);
      expect(harness.dispatched.single['actionId'], 'set-package-enabled');
      harness.gate!.complete();
      await tester.pumpAndSettle();
      // Applied: a prediction covers the window up to the document that
      // replaces it, so it is still what the switch shows.
      expect(tester.widget<Switch>(find.byType(Switch)).value, isFalse);
    });

    testWidgets('a refused enablement puts the switch back', (tester) async {
      final harness = await pump(
        tester,
        document(_card(on: true), actions: const [_enableAction]),
        cardGroups: true,
      );
      harness.receipt = const {'status': 'rejected'};
      harness.gate = Completer<void>();
      await tester.tap(find.byType(Switch));
      await tester.pump();
      expect(tester.widget<Switch>(find.byType(Switch)).value, isFalse);
      harness.gate!.complete();
      await tester.pumpAndSettle();
      expect(tester.widget<Switch>(find.byType(Switch)).value, isTrue);
      expect(harness.controller.predicted, isEmpty);
    });

    testWidgets('an install is not predicted: the version is not ours', (
      tester,
    ) async {
      final harness = await pump(
        tester,
        document(
          _card(on: false, installing: true),
          actions: const [_installAction],
        ),
        cardGroups: true,
      );
      harness.gate = Completer<void>();
      await tester.tap(find.byType(Switch));
      await tester.pump();
      expect(tester.widget<Switch>(find.byType(Switch)).value, isFalse);
      expect(harness.dispatched.single['actionId'], 'install-package');
      expect(harness.controller.predicted, isEmpty);
      harness.gate!.complete();
      await tester.pumpAndSettle();
      expect(tester.widget<Switch>(find.byType(Switch)).value, isFalse);
    });

    testWidgets('a tapped row takes the check from its sibling at once', (
      tester,
    ) async {
      final harness = await pump(
        tester,
        document(_rows(), actions: const [_chooseA, _chooseB]),
      );
      harness.gate = Completer<void>();
      ListTile row(String id) =>
          tester.widget<ListTile>(find.byKey(ValueKey('view-row-$id')));
      expect(row('a').selected, isTrue);
      await tester.tap(find.text('Frankfurt'));
      await tester.pump();
      expect(row('a').selected, isFalse);
      expect(row('b').selected, isTrue);
      expect(find.byIcon(Icons.check_rounded), findsOneWidget);
      harness.gate!.complete();
      await tester.pumpAndSettle();
    });

    testWidgets('a deleted Routine leaves the document on the press', (
      tester,
    ) async {
      final harness = await pump(
        tester,
        document(_routines(), actions: const [_deleteRoutine]),
      );
      harness.gate = Completer<void>();
      expect(find.text('Morning digest'), findsOneWidget);
      await tester.tap(find.text('Delete'));
      await tester.pump();
      expect(find.text('Morning digest'), findsNothing);
      expect(find.text('Evening digest'), findsOneWidget);
      harness.gate!.complete();
      await tester.pumpAndSettle();
      expect(find.text('Morning digest'), findsNothing);
    });

    testWidgets('a refused delete brings the Routine back', (tester) async {
      final harness = await pump(
        tester,
        document(_routines(), actions: const [_deleteRoutine]),
      );
      harness.receipt = const {'status': 'rejected'};
      harness.gate = Completer<void>();
      await tester.tap(find.text('Delete'));
      await tester.pump();
      expect(find.text('Morning digest'), findsNothing);
      harness.gate!.complete();
      await tester.pumpAndSettle();
      expect(find.text('Morning digest'), findsOneWidget);
      expect(harness.controller.predicted, isEmpty);
    });

    test('a prediction is keyed by what the press acts on, not by its id', () {
      final first = {
        'actionId': 'set-package-enabled',
        'input': {'packageId': 'one', 'enabled': false},
      };
      final second = {
        'actionId': 'set-package-enabled',
        'input': {'packageId': 'two', 'enabled': false},
      };
      expect(
        viewPredictionKeyV1(first, without: 'enabled'),
        isNot(viewPredictionKeyV1(second, without: 'enabled')),
      );
      // The value being predicted is the one that changes, so it is not part
      // of the key: the switch reads back what it wrote.
      expect(
        viewPredictionKeyV1(first, without: 'enabled'),
        viewPredictionKeyV1({
          'actionId': 'set-package-enabled',
          'input': {'packageId': 'one', 'enabled': true},
        }, without: 'enabled'),
      );
    });
  });
}
