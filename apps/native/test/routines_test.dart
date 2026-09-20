import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/document_cache.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/routines/document.dart';
import 'package:frockbot_native/routines/editor.dart';
import 'package:frockbot_native/routines/page.dart';
import 'package:frockbot_native/routines/runs.dart';
import 'package:frockbot_native/shell/semantics.dart';
import 'package:frockbot_native/theme/frock_theme.dart';
import 'package:frockbot_native/view/action.dart';
import 'package:frockbot_native/view/document.dart';

import 'settings_test.dart' show SettingsApi;
import 'shell_layout_test.dart' show byIdentifier;
import 'widget_test.dart' show MemoryStore;

/// The shape `routinesDocumentV1` produces, written by hand so the Flutter
/// side is pinned to the projection's contract rather than to a fixture the
/// server could change without anything noticing.
Map<String, Object?> routinesDocument({
  int revision = 1,
  bool enabled = true,
}) => {
  'schemaVersion': 1,
  'surfaceId': 'routines',
  'revision': revision,
  'root': {
    'type': 'group',
    'orientation': 'column',
    'children': [
      {
        'type': 'group',
        'orientation': 'column',
        'title': 'Scheduled',
        'children': [
          routineRow(
            {
              'routineId': 'r1',
              'name': 'Morning brief',
              'schedule': '0 9 * * *',
              'enabled': enabled,
            },
            runs: [
              {
                'entryId': 'e1',
                'routineId': 'r1',
                'name': 'Morning brief',
                'createdAt': '2026-09-02T23:00:10.000Z',
                'mark': 'finished',
              },
            ],
          ),
        ],
      },
    ],
  },
  'actions': [
    {
      'id': 'set-routine-enabled',
      'schema': {
        'type': 'object',
        'properties': {
          'kind': {
            'type': 'string',
            'enum': ['set-routine-enabled'],
          },
          'routineId': {'type': 'string', 'maxLength': 128},
          'enabled': {'type': 'boolean'},
        },
        'required': ['kind', 'routineId', 'enabled'],
        'additionalProperties': false,
      },
    },
    {
      'id': 'run-routine',
      'schema': {
        'type': 'object',
        'properties': {
          'kind': {
            'type': 'string',
            'enum': ['run-routine'],
          },
          'routineId': {'type': 'string', 'maxLength': 128},
        },
        'required': ['kind', 'routineId'],
        'additionalProperties': false,
      },
    },
    {
      'id': 'delete-routine',
      'schema': {
        'type': 'object',
        'properties': {
          'kind': {
            'type': 'string',
            'enum': ['delete-routine'],
          },
          'routineId': {'type': 'string', 'maxLength': 128},
        },
        'required': ['kind', 'routineId'],
        'additionalProperties': false,
      },
    },
    {
      'id': 'open-runs',
      'schema': {
        'type': 'object',
        'properties': {
          'kind': {
            'type': 'string',
            'enum': ['open-runs'],
          },
          'routineId': {'type': 'string', 'maxLength': 128},
        },
        'required': ['kind', 'routineId'],
        'additionalProperties': false,
      },
    },
    {
      'id': 'open-run',
      'schema': {
        'type': 'object',
        'properties': {
          'kind': {
            'type': 'string',
            'enum': ['open-run'],
          },
          'routineId': {'type': 'string', 'maxLength': 128},
          'entryId': {'type': 'string', 'maxLength': 128},
        },
        'required': ['kind', 'routineId', 'entryId'],
        'additionalProperties': false,
      },
    },
    {
      'id': 'edit-routine',
      'schema': {
        'type': 'object',
        'properties': {
          'kind': {
            'type': 'string',
            'enum': ['edit-routine'],
          },
          'routineId': {'type': 'string', 'maxLength': 128},
        },
        'required': ['kind', 'routineId'],
        'additionalProperties': false,
      },
    },
    {
      'id': 'cancel-edit',
      'schema': {
        'type': 'object',
        'properties': {
          'kind': {
            'type': 'string',
            'enum': ['cancel-edit'],
          },
        },
        'required': ['kind'],
        'additionalProperties': false,
      },
    },
  ],
};

/// The editor as `routinesDocumentV1` projects it: the field the host draws,
/// and the hidden fields that seed it. The list never carries this group.
Map<String, Object?> routinesEditorGroup(Map<String, Object?>? editing) {
  final seeds = <String, Object?>{
    'routine.editorId': editing?['routineId'],
    'routine.name': editing?['name'],
    'routine.prompt': editing?['prompt'],
    'routine.schedule': editing?['schedule'] ?? '0 9 * * *',
    'routine.scheduleDescription':
        editing?['scheduleDescription'] ?? 'Every day at 9:00am',
    'routine.timezone': editing?['timezone'] ?? 'Australia/Sydney',
    'routine.keyVersion': editing?['keyVersion'],
  };
  return {
    'type': 'group',
    'orientation': 'column',
    'children': [
      for (final seed in seeds.entries)
        {
          'type': 'field',
          'field': {
            'id': seed.key,
            'label': seed.key,
            'kind': 'text',
            'value': seed.value,
            'editable': true,
            'choiceSource': 'routine-editor-hidden',
          },
        },
      {
        'type': 'field',
        'field': {
          'id': 'routine.timing',
          'label': 'Fires on',
          'kind': 'text',
          'value': editing?['timing'] ?? 'schedule',
          'editable': true,
          'choiceSource': 'routine-editor',
        },
      },
    ],
  };
}

/// One Routine's row: what it fires on, the two controls a row draws, and
/// the completions nested under it.
Map<String, Object?> routineRow(
  Map<String, Object?> routine, {
  List<Map<String, Object?>> runs = const [],
}) {
  final id = routine['routineId'];
  final enabled = routine['enabled'] == true;
  return {
    'type': 'group',
    'orientation': 'column',
    'title': routine['name'],
    'children': [
      {
        'type': 'text',
        'text':
            '${routine['schedule'] ?? 'Webhook trigger'} · Australia/Sydney'
            ' · Never run · ${enabled ? 'No next firing scheduled' : 'Paused'}',
        'style': 'status',
      },
      {
        'type': 'group',
        'orientation': 'row',
        'children': [
          {
            'type': 'action',
            'actionId': 'edit-routine',
            'label': 'Edit',
            'input': {'kind': 'edit-routine', 'routineId': id},
          },
          {
            'type': 'action',
            'actionId': 'set-routine-enabled',
            'label': enabled ? 'Pause' : 'Resume',
            'input': {
              'kind': 'set-routine-enabled',
              'routineId': id,
              'enabled': !enabled,
            },
          },
        ],
      },
      for (final run in runs)
        {
          'type': 'group',
          'orientation': 'column',
          'title': run['name'] ?? routine['name'],
          'children': [
            {'type': 'text', 'text': run['createdAt'], 'style': 'status'},
            {'type': 'text', 'text': run['mark'] ?? 'finished'},
            {
              'type': 'group',
              'orientation': 'row',
              'children': [
                {
                  'type': 'action',
                  'actionId': 'open-run',
                  'label': 'Open',
                  'input': {
                    'kind': 'open-run',
                    'routineId': run['routineId'] ?? id,
                    'entryId': run['entryId'],
                  },
                },
              ],
            },
          ],
        },
    ],
  };
}

/// The editor page: the form alone, not the list with a form on it.
///
/// Revision 3 so the host adopts a new controller when the list (revision 2)
/// becomes this form — a lower number would still differ, but the read that
/// answers an edit is a newer document, not an older one.
Map<String, Object?> routinesDocumentWithEditor({
  List<Map<String, Object?>> routines = const [],
  Map<String, Object?>? editing,
}) => {
  'schemaVersion': 1,
  'surfaceId': 'routines',
  'revision': 3,
  'root': {
    'type': 'group',
    'orientation': 'column',
    'children': [routinesEditorGroup(editing)],
  },
  'actions': routinesDocument()['actions'],
};

/// The list page: what is armed, without the form.
Map<String, Object?> routinesListDocument({
  List<Map<String, Object?>> routines = const [],
}) => {
  'schemaVersion': 1,
  'surfaceId': 'routines',
  'revision': 2,
  'root': {
    'type': 'group',
    'orientation': 'column',
    'children': [for (final routine in routines) routineRow(routine)],
  },
  'actions': routinesDocument()['actions'],
};

/// The document the path asked for: the empty form, a named form, or the list.
Map<String, Object?> routinesDocumentForPath(
  String path, {
  List<Map<String, Object?>> routines = const [],
  Map<String, Object?>? editing,
}) {
  if (path.contains('new=1')) return routinesDocumentWithEditor();
  if (path.contains('edit=')) {
    return routinesDocumentWithEditor(editing: editing, routines: routines);
  }
  return routinesListDocument(routines: routines);
}

/// The surface above, with the action `routinesDocumentV1` declares for Save:
/// pressing it carries the four field values the form holds, which is what a
/// save from the editor is made of.
Map<String, Object?> routinesDocumentThatSaves(Map<String, Object?> document) =>
    {
      ...document,
      'actions': [
        ...(document['actions']! as List),
        {
          'id': 'save-routine',
          'schema': {
            'type': 'object',
            'properties': {
              'kind': {
                'type': 'string',
                'enum': ['save-routine'],
              },
              'routineId': {'type': 'string', 'maxLength': 128},
              'routine.name': {'type': 'string', 'maxLength': 100},
              'routine.prompt': {'type': 'string', 'maxLength': 8000},
              'routine.timing': {'type': 'string', 'maxLength': 256},
              'routine.schedule': {'type': 'string', 'maxLength': 256},
            },
            'required': [
              'kind',
              'routine.name',
              'routine.prompt',
              'routine.timing',
            ],
            'additionalProperties': false,
          },
        },
      ],
    };

/// What the editor's schedule controls hold, as the person sees them.
int dayControl(WidgetTester tester) => tester
    .state<FormFieldState<int>>(find.byType(DropdownButtonFormField<int>))
    .value!;

/// The list as a page, on a display tall enough to hold it and the editor it
/// pushes.
Widget routinesPage(SettingsApi api, MemoryStore store) {
  return MaterialApp(
    theme: FrockTheme.theme(Brightness.dark),
    home: RoutinesView(
      api: api,
      store: store,
      userId: 'tim',
      botId: 'bot-1',
      botName: 'Scout',
    ),
  );
}

/// The editor as its own page, which is how a row and the New Routine
/// button open it.
Widget routinesEditorPage(
  SettingsApi api,
  MemoryStore store, {
  String? routineId,
}) {
  return MaterialApp(
    theme: FrockTheme.theme(Brightness.dark),
    home: RoutineEditorPage(
      api: api,
      store: store,
      userId: 'tim',
      botId: 'bot-1',
      routineId: routineId,
    ),
  );
}

void useTallSurface(WidgetTester tester) {
  tester.view.physicalSize = const Size(1000, 2400);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
}

void main() {
  setUp(clearViewDocumentCacheMemory);

  test('only usable trigger-capable Plugins become Routine sources', () {
    final sources = routinePluginSourcesV1({
      'plugins': [
        {
          'pluginId': 'github',
          'displayName': 'GitHub',
          'on': true,
          'triggers': [
            {
              'name': 'issue-opened',
              'description': 'When a new issue is opened',
            },
          ],
        },
        {
          'pluginId': 'off',
          'displayName': 'Off Plugin',
          'on': false,
          'triggers': [
            {'name': 'event', 'description': 'An event'},
          ],
        },
        {
          'pluginId': 'quarantined',
          'displayName': 'Quarantined Plugin',
          'on': true,
          'quarantined': {'reason': 'review'},
          'triggers': [
            {'name': 'event', 'description': 'An event'},
          ],
        },
      ],
    });

    expect(sources, hasLength(1));
    expect(sources.single.displayName, 'GitHub');
    expect(sources.single.triggers.single.name, 'issue-opened');
    expect(sources.single.triggers.single.displayName, 'Issue Opened');
  });

  testWidgets('the editor only configures the selected trigger type', (
    tester,
  ) async {
    final plugin = RoutinePluginSourceV1(
      pluginId: 'github',
      displayName: 'GitHub',
      triggers: const [
        RoutinePluginTriggerV1(
          'issue-opened',
          'When a new issue is opened in a repository',
        ),
      ],
    );
    final controller = ViewController(
      store: MemoryStore(),
      userId: 'u1',
      surfaceId: 'routines',
      revision: 1,
      dispatch: (_) async => {},
    );
    addTearDown(controller.dispose);
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: Scaffold(
          body: SingleChildScrollView(
            child: ViewScope(
              controller: controller,
              actions: const {},
              frames: const {},
              child: RoutineEditorV1(
                plugins: [plugin],
                pluginsPending: false,
                source: 'schedule',
                routineId: null,
                name: '',
                prompt: '',
                schedule: '0 9 * * *',
                scheduleDescription: 'Every day at 9:00am',
                timezone: 'Australia/Sydney',
                hookKeyVersion: null,
                enabled: true,
                onSourceChanged: (_) {},
              ),
            ),
          ),
        ),
      ),
    );

    expect(find.text('Schedule'), findsOneWidget);
    expect(find.text('Webhook'), findsOneWidget);
    expect(find.text('GitHub'), findsOneWidget);
    expect(find.text('github'), findsNothing);
    expect(find.text('Routine name'), findsOneWidget);
    expect(find.text('Continue'), findsNothing);

    await tester.tap(find.text('Webhook'));
    await tester.pumpAndSettle();
    expect(find.text('Ready for incoming webhooks'), findsOneWidget);
    expect(find.text('Daily'), findsNothing);
    expect(find.textContaining('0 9 * * *'), findsNothing);

    await tester.tap(find.text('GitHub'));
    await tester.pumpAndSettle();
    expect(find.text('Ready for incoming webhooks'), findsNothing);
    expect(find.text('Issue Opened'), findsOneWidget);
    expect(find.text('issue-opened'), findsNothing);
  });

  testWidgets('the guide offers the Plugins the surface read', (tester) async {
    useTallSurface(tester);
    final store = MemoryStore();
    final api = SettingsApi(store, (path, body) async {
      if (path.endsWith('/plugins')) {
        return {
          'plugins': [
            {
              'pluginId': 'github',
              'displayName': 'GitHub',
              'on': true,
              'triggers': [
                {
                  'name': 'issue-opened',
                  'description': 'When a new issue is opened',
                },
              ],
            },
          ],
        };
      }
      return routinesDocumentForPath(path);
    });
    await tester.pumpWidget(routinesPage(api, store));
    await tester.pumpAndSettle();

    // The catalog arrives after the document does, so the choices are the ones
    // the surface holds rather than the ones it held when it was built.
    await tester.tap(find.text('New Routine'));
    await tester.pumpAndSettle();
    expect(find.text('GitHub'), findsOneWidget);
    expect(find.text('github'), findsNothing);
  });

  testWidgets('a new Routine is one form', (tester) async {
    useTallSurface(tester);
    final store = MemoryStore();
    final api = SettingsApi(store, (path, body) async {
      if (path.endsWith('/plugins')) return {'plugins': []};
      return routinesDocumentForPath(path);
    });
    await tester.pumpWidget(routinesPage(api, store));
    await tester.pumpAndSettle();
    expect(find.byType(FilledButton), findsOneWidget);
    expect(find.text('Routine name'), findsNothing);
    await tester.tap(find.text('New Routine'));
    await tester.pumpAndSettle();
    expect(find.text('Continue'), findsNothing);
    expect(find.widgetWithText(AppBar, 'New Routine'), findsOneWidget);
    expect(find.text('New Routine'), findsWidgets);
    expect(find.text('Routine name'), findsOneWidget);
    expect(find.text('Schedule'), findsOneWidget);
    expect(find.text('Daily'), findsOneWidget);
    expect(find.text('Create Routine'), findsOneWidget);
    expect(find.text('Cancel'), findsOneWidget);
    expect(byIdentifier(RoutineIds.editorBack), findsOneWidget);
  });

  testWidgets('Create Routine returns to the list that now holds it', (
    tester,
  ) async {
    useTallSurface(tester);
    final store = MemoryStore();
    final routines = <Map<String, Object?>>[];
    final paths = <String>[];
    Completer<void>? holdRead;
    final api = SettingsApi(store, (path, body) async {
      if (path.endsWith('/plugins')) return {'plugins': []};
      if (body != null) {
        final command = (body as Map).cast<String, Object?>();
        routines.add({
          'routineId': 'r-new',
          'name': command['name'],
          'prompt': command['prompt'],
          'schedule': command['schedule'] ?? '0 9 * * *',
          'enabled': true,
        });
        // Hold the next document read so it is still out when the editor
        // closes — the overlap a browser always hits, and a sync mock hides.
        holdRead = Completer<void>();
        return {
          'schemaVersion': 1,
          'commandId': command['commandId'],
          'status': 'applied',
        };
      }
      paths.add(path);
      final held = holdRead;
      if (held != null && !held.isCompleted) await held.future;
      return routinesDocumentThatSaves(
        routinesDocumentForPath(path, routines: List.of(routines)),
      );
    });
    await tester.pumpWidget(routinesPage(api, store));
    await tester.pumpAndSettle();
    await tester.tap(find.text('New Routine'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextFormField).first, 'Morning brief');
    await tester.enterText(
      find.byType(TextFormField).at(1),
      'Summarise overnight email.',
    );
    await tester.pump();
    await tester.ensureVisible(find.text('Create Routine'));
    await tester.tap(find.text('Create Routine'));
    await tester.pump();
    expect(holdRead, isNotNull);
    expect(holdRead!.isCompleted, isFalse);
    holdRead!.complete();
    await tester.pumpAndSettle();
    expect(find.text('Create Routine'), findsNothing);
    expect(find.text('Morning brief'), findsOneWidget);
    expect(paths.where((path) => path.contains('new=1')), hasLength(1));
    expect(paths.last.contains('new=1'), isFalse);
  });

  test('the panel header back is the editor’s back while it is open', () {
    expect(
      panelBackIdentifierV1(panelKey: 'routines', routinesEditorOpen: true),
      RoutineIds.editorBack,
    );
    expect(
      panelBackIdentifierV1(panelKey: 'routines', routinesEditorOpen: false),
      ShellIds.rightPanelBack,
    );
    expect(
      panelBackIdentifierV1(panelKey: 'plugins', routinesEditorOpen: true),
      ShellIds.rightPanelBack,
    );
  });

  testWidgets('the panel’s new Routine page names itself at the top', (
    tester,
  ) async {
    useTallSurface(tester);
    final store = MemoryStore();
    final panel = RoutinesPanelHandle();
    final api = SettingsApi(store, (path, body) async {
      if (path.endsWith('/plugins')) return {'plugins': []};
      return routinesDocumentForPath(path);
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: Scaffold(
          body: RoutinesView(
            api: api,
            store: store,
            userId: 'tim',
            botId: 'bot-1',
            botName: 'Scout',
            chrome: false,
            panel: panel,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(panel.editorTitle, isNull);
    await tester.tap(find.text('New Routine'));
    await tester.pumpAndSettle();
    expect(panel.editorTitle, 'New Routine');
    expect(find.text('New Routine'), findsWidgets);
    expect(find.text('What should this Bot do?'), findsOneWidget);
  });

  testWidgets('completions sit under their Routine as the Bot page rows', (
    tester,
  ) async {
    useTallSurface(tester);
    final store = MemoryStore();
    final api = SettingsApi(store, (path, body) async {
      if (path.endsWith('/plugins')) return {'plugins': []};
      return routinesDocument();
    });
    await tester.pumpWidget(routinesPage(api, store));
    await tester.pumpAndSettle();
    expect(find.text('Completions'), findsNothing);
    expect(find.text('Mark read'), findsNothing);
    expect(find.text('Mark all read'), findsNothing);
    expect(find.byType(RoutineRunRow), findsOneWidget);
    expect(find.byType(Switch), findsOneWidget);
    expect(find.byIcon(Icons.chevron_right_rounded), findsWidgets);
    expect(find.byIcon(Icons.check_rounded), findsOneWidget);
    expect(find.text('Save changes'), findsNothing);
  });

  testWidgets('tapping a Routine opens it; the switch is only the switch', (
    tester,
  ) async {
    useTallSurface(tester);
    final store = MemoryStore();
    final sent = <Map<String, Object?>>[];
    final api = SettingsApi(store, (path, body) async {
      if (path.endsWith('/plugins')) return {'plugins': []};
      if (body != null) {
        sent.add((body as Map).cast<String, Object?>());
        return {
          'schemaVersion': 1,
          'commandId': body['commandId'],
          'status': 'applied',
        };
      }
      return routinesDocumentForPath(
        path,
        routines: [
          {
            'routineId': 'r1',
            'name': 'Morning brief',
            'schedule': '0 9 * * *',
            'enabled': true,
          },
        ],
        editing: {
          'routineId': 'r1',
          'name': 'Morning brief',
          'prompt': 'Summarise overnight email.',
          'schedule': '0 9 * * *',
          'timing': 'schedule',
        },
      );
    });
    await tester.pumpWidget(routinesPage(api, store));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Morning brief'));
    await tester.pumpAndSettle();
    expect(find.widgetWithText(AppBar, 'Edit Routine'), findsOneWidget);
    expect(find.text('Save changes'), findsOneWidget);
    expect(sent, isEmpty);
    await tester.tap(byIdentifier(RoutineIds.editorBack));
    await tester.pumpAndSettle();
    await tester.tap(find.byType(Switch));
    await tester.pumpAndSettle();
    expect(sent.single['type'], 'routine/pause');
    expect(find.text('Save changes'), findsNothing);
  });

  testWidgets('back leaves a form nobody changed', (tester) async {
    useTallSurface(tester);
    final store = MemoryStore();
    final api = SettingsApi(store, (path, body) async {
      if (path.endsWith('/plugins')) return {'plugins': []};
      return routinesDocumentForPath(
        path,
        routines: [
          {
            'routineId': 'r1',
            'name': 'Morning brief',
            'schedule': '0 9 * * *',
            'enabled': true,
          },
        ],
        editing: {
          'routineId': 'r1',
          'name': 'Morning brief',
          'prompt': 'Summarise overnight email.',
          'schedule': '0 9 * * *',
          'timing': 'schedule',
        },
      );
    });
    await tester.pumpWidget(routinesPage(api, store));
    await tester.pumpAndSettle();

    await tester.tap(find.text('New Routine'));
    await tester.pumpAndSettle();
    expect(find.text('Create Routine'), findsOneWidget);
    await tester.tap(byIdentifier(RoutineIds.editorBack));
    await tester.pumpAndSettle();
    expect(find.text('Discard changes?'), findsNothing);
    expect(find.text('Create Routine'), findsNothing);
    expect(find.text('New Routine'), findsOneWidget);

    await tester.tap(find.text('Morning brief'));
    await tester.pumpAndSettle();
    expect(find.text('Save changes'), findsOneWidget);
    await tester.tap(byIdentifier(RoutineIds.editorBack));
    await tester.pumpAndSettle();
    expect(find.text('Discard changes?'), findsNothing);
    expect(find.text('Save changes'), findsNothing);
    expect(find.text('Morning brief'), findsOneWidget);
  });

  testWidgets('back asks before discarding a dirty form', (tester) async {
    useTallSurface(tester);
    final store = MemoryStore();
    final api = SettingsApi(store, (path, body) async {
      if (path.endsWith('/plugins')) return {'plugins': []};
      return routinesDocumentForPath(
        path,
        routines: [
          {
            'routineId': 'r1',
            'name': 'Morning brief',
            'schedule': '0 9 * * *',
            'enabled': true,
          },
        ],
        editing: {
          'routineId': 'r1',
          'name': 'Morning brief',
          'prompt': 'Summarise overnight email.',
          'schedule': '0 9 * * *',
          'timing': 'schedule',
        },
      );
    });
    await tester.pumpWidget(routinesPage(api, store));
    await tester.pumpAndSettle();

    await tester.tap(find.text('New Routine'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextFormField).first, 'Evening brief');
    await tester.pump();
    await tester.tap(byIdentifier(RoutineIds.editorBack));
    await tester.pumpAndSettle();
    expect(find.text('Discard changes?'), findsOneWidget);
    expect(byIdentifier(RoutineIds.confirmDiscard), findsOneWidget);

    await tester.tap(find.text('Keep editing'));
    await tester.pumpAndSettle();
    expect(find.text('Discard changes?'), findsNothing);
    expect(find.text('Create Routine'), findsOneWidget);
    expect(find.text('Evening brief'), findsOneWidget);

    await tester.tap(byIdentifier(RoutineIds.editorBack));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Discard'));
    await tester.pumpAndSettle();
    expect(find.text('Create Routine'), findsNothing);
    expect(find.text('New Routine'), findsOneWidget);

    await tester.tap(find.text('Morning brief'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextFormField).first, 'Evening brief');
    await tester.pump();
    await tester.tap(byIdentifier(RoutineIds.editorBack));
    await tester.pumpAndSettle();
    expect(find.text('Discard changes?'), findsOneWidget);
    await tester.tap(find.text('Discard'));
    await tester.pumpAndSettle();
    expect(find.text('Save changes'), findsNothing);
    expect(find.text('Morning brief'), findsOneWidget);
  });

  testWidgets('Cancel leaves a dirty form without asking', (tester) async {
    useTallSurface(tester);
    final store = MemoryStore();
    final api = SettingsApi(store, (path, body) async {
      if (path.endsWith('/plugins')) return {'plugins': []};
      return routinesDocumentForPath(path);
    });
    await tester.pumpWidget(routinesPage(api, store));
    await tester.pumpAndSettle();
    await tester.tap(find.text('New Routine'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextFormField).first, 'Evening brief');
    await tester.pump();
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(find.text('Discard changes?'), findsNothing);
    expect(find.text('Create Routine'), findsNothing);
    expect(find.text('New Routine'), findsOneWidget);
  });

  testWidgets('Routines answer while the Plugin catalog is still out', (
    tester,
  ) async {
    useTallSurface(tester);
    final store = MemoryStore();
    final sent = <Map<String, Object?>>[];
    final catalog = Completer<Object?>();
    final api = SettingsApi(store, (path, body) async {
      if (path.endsWith('/plugins')) return catalog.future;
      if (body == null) {
        return routinesDocumentForPath(
          path,
          routines: [
            {
              'routineId': 'r1',
              'name': 'First brief',
              'schedule': '0 9 * * *',
              'enabled': true,
            },
          ],
        );
      }
      final command = (body as Map).cast<String, Object?>();
      sent.add(command);
      return {
        'schemaVersion': 1,
        'commandId': command['commandId'],
        'status': 'applied',
      };
    });
    await tester.pumpWidget(routinesPage(api, store));
    await tester.pumpAndSettle();

    // Only the Plugin read is outstanding, and the document is drawn and
    // answering rather than held behind it.
    expect(find.text('First brief'), findsOneWidget);
    await tester.tap(find.byType(Switch));
    await tester.pumpAndSettle();
    expect(sent.single['type'], 'routine/pause');

    // And the read that is still out is not forgotten: when the catalog lands
    // it is the choices the editor offers.
    catalog.complete({
      'plugins': [
        {
          'pluginId': 'github',
          'displayName': 'GitHub',
          'on': true,
          'triggers': [
            {
              'name': 'issue-opened',
              'description': 'When a new issue is opened',
            },
          ],
        },
      ],
    });
    await tester.pumpAndSettle();
    await tester.tap(find.text('New Routine'));
    await tester.pumpAndSettle();
    expect(find.text('GitHub'), findsOneWidget);
  });

  testWidgets(
    'a Plugin catalog still being read is not an unavailable Plugin',
    (tester) async {
      useTallSurface(tester);
      final store = MemoryStore();
      final catalog = Completer<Object?>();
      final api = SettingsApi(store, (path, body) async {
        if (path.endsWith('/plugins')) return catalog.future;
        return routinesDocumentWithEditor(
          routines: [
            {
              'routineId': 'r1',
              'name': 'Alerts',
              'schedule': null,
              'enabled': true,
            },
          ],
          editing: {
            'routineId': 'r1',
            'name': 'Alerts',
            'prompt': 'Read the alert.',
            'timing': 'plugin:weather:alert',
          },
        );
      });
      await tester.pumpWidget(routinesEditorPage(api, store, routineId: 'r1'));
      await tester.pumpAndSettle();

      // The document landed and the catalog did not: the stored trigger is one
      // nobody has looked for yet, which is not the same as one that is gone.
      expect(find.text('Unavailable for this Bot'), findsNothing);
      expect(find.text('Checking availability…'), findsOneWidget);
      expect(find.text('Checking this Bot’s Plugins…'), findsOneWidget);
      expect(find.text('This Plugin is unavailable'), findsNothing);
      expect(find.text('Still loading Plugins'), findsOneWidget);

      // Once the read settles without it, the editor says what it always said.
      catalog.complete({'plugins': []});
      await tester.pumpAndSettle();
      expect(find.text('Still loading Plugins'), findsNothing);
      expect(find.text('This Plugin is unavailable'), findsOneWidget);
      expect(find.text('Checking availability…'), findsNothing);
      expect(find.text('Unavailable for this Bot'), findsOneWidget);
    },
  );

  testWidgets('an open editor leaves every row control on its own Routine', (
    tester,
  ) async {
    useTallSurface(tester);
    final store = MemoryStore();
    final sent = <Map<String, Object?>>[];
    final api = SettingsApi(store, (path, body) async {
      if (body == null) {
        return routinesDocumentForPath(
          path,
          routines: [
            {
              'routineId': 'r1',
              'name': 'First brief',
              'schedule': '0 9 * * *',
              'enabled': true,
            },
            {
              'routineId': 'r2',
              'name': 'Second brief',
              'schedule': '0 18 * * *',
              'enabled': false,
            },
          ],
          editing: {
            'routineId': 'r2',
            'name': 'Second brief',
            'prompt': 'Summarise the day.',
            'schedule': '0 18 * * *',
            'timing': 'schedule',
          },
        );
      }
      final command = (body as Map).cast<String, Object?>();
      sent.add(command);
      return {
        'schemaVersion': 1,
        'commandId': command['commandId'],
        'status': 'applied',
      };
    });
    await tester.pumpWidget(routinesPage(api, store));
    await tester.pumpAndSettle();

    // The list is on screen, so a switch still names the Routine it pauses.
    await tester.tap(find.byType(Switch).first);
    await tester.pumpAndSettle();
    expect(sent.single['routineId'], 'r1');
    expect(sent.single['type'], 'routine/pause');

    await tester.tap(find.text('Second brief'));
    await tester.pumpAndSettle();
    expect(find.text('Run now'), findsOneWidget);
    expect(find.text('Second brief'), findsWidgets);
    expect(find.text('First brief'), findsNothing);
  });

  testWidgets('the interval control shows the interval the value holds', (
    tester,
  ) async {
    useTallSurface(tester);
    final store = MemoryStore();
    final api = SettingsApi(store, (path, body) async {
      if (body == null) {
        return routinesDocumentWithEditor(
          editing: {
            'routineId': 'r1',
            'name': 'Ninety minutes',
            'prompt': 'Summarise overnight email.',
            'schedule': '@every 90m',
            'scheduleDescription': 'Every 90 minutes',
            'timing': 'schedule',
          },
        );
      }
      final command = (body as Map).cast<String, Object?>();
      return {
        'schemaVersion': 1,
        'commandId': command['commandId'],
        'status': 'applied',
      };
    });
    await tester.pumpWidget(routinesEditorPage(api, store, routineId: 'r1'));
    await tester.pumpAndSettle();
    expect(find.text('Interval'), findsOneWidget);

    // Ninety is what the value says and what the summary under it reads, so it
    // is what the control offers rather than a neighbour it would then write.
    expect(find.text('90'), findsWidgets);
    expect(
      tester
          .state<FormFieldState<int>>(find.byType(DropdownButtonFormField<int>))
          .value,
      90,
    );
  });

  testWidgets('switching cadence shows the day the switch stores', (
    tester,
  ) async {
    useTallSurface(tester);
    final store = MemoryStore();
    final sent = <Map<String, Object?>>[];
    final api = SettingsApi(store, (path, body) async {
      if (body == null) {
        return routinesDocumentThatSaves(
          routinesDocumentWithEditor(
            editing: {
              'routineId': 'r1',
              'name': 'Friday brief',
              'prompt': 'Summarise overnight email.',
              'schedule': '0 9 * * 5',
              'scheduleDescription': 'Every Friday at 9:00am',
              'timing': 'schedule',
            },
          ),
        );
      }
      final command = (body as Map).cast<String, Object?>();
      sent.add(command);
      return {
        'schemaVersion': 1,
        'commandId': command['commandId'],
        'status': 'applied',
      };
    });
    await tester.pumpWidget(routinesEditorPage(api, store, routineId: 'r1'));
    await tester.pumpAndSettle();

    // Friday is a day of the week, not a day of the month: the control the
    // switch draws is the month's, reading the day the value now holds.
    await tester.tap(find.text('Monthly'));
    await tester.pumpAndSettle();
    expect(dayControl(tester), 1);
    expect(find.textContaining('of every month'), findsOneWidget);

    await tester.enterText(find.byType(TextFormField).first, 'Monthly brief');
    await tester.pumpAndSettle();
    await tester.tap(find.text('Save changes'));
    await tester.pumpAndSettle();
    expect(sent.single['schedule'], '0 9 1 * *');
  });

  testWidgets(
    'a day of the month above seven leaves the weekly control whole',
    (tester) async {
      useTallSurface(tester);
      final store = MemoryStore();
      final api = SettingsApi(store, (path, body) async {
        if (body == null) {
          return routinesDocumentWithEditor(
            editing: {
              'routineId': 'r1',
              'name': 'Twentieth',
              'prompt': 'Summarise overnight email.',
              'schedule': '0 9 20 * *',
              'scheduleDescription': 'On day 20 of every month at 9:00am',
              'timing': 'schedule',
            },
          );
        }
        final command = (body as Map).cast<String, Object?>();
        return {
          'schemaVersion': 1,
          'commandId': command['commandId'],
          'status': 'applied',
        };
      });
      await tester.pumpWidget(routinesEditorPage(api, store, routineId: 'r1'));
      await tester.pumpAndSettle();

      // Twenty is not one of the week's seven days, so the control the switch
      // draws holds the stored weekday rather than the number it replaced.
      await tester.tap(find.text('Weekly'));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      expect(dayControl(tester), 1);
      expect(find.textContaining('Every Monday'), findsOneWidget);
    },
  );

  testWidgets('the key controls follow the stored Routine, not the form', (
    tester,
  ) async {
    useTallSurface(tester);
    final store = MemoryStore();
    final api = SettingsApi(store, (path, body) async {
      if (body == null) {
        return routinesDocumentWithEditor(
          routines: [
            {
              'routineId': 'r1',
              'name': 'First brief',
              'schedule': '0 9 * * *',
              'enabled': true,
            },
          ],
          editing: {
            'routineId': 'r1',
            'name': 'First brief',
            'prompt': 'Summarise overnight email.',
            'schedule': '0 9 * * *',
            'timing': 'schedule',
          },
        );
      }
      final command = (body as Map).cast<String, Object?>();
      return {
        'schemaVersion': 1,
        'commandId': command['commandId'],
        'status': 'applied',
      };
    });
    await tester.pumpWidget(routinesEditorPage(api, store, routineId: 'r1'));
    await tester.pumpAndSettle();
    // A scheduled Routine has no key to mint, whatever the form is about to
    // save it as.
    expect(find.text('Mint key'), findsNothing);

    await tester.tap(find.text('Webhook'));
    await tester.pumpAndSettle();
    expect(find.text('Mint key'), findsNothing);
  });

  testWidgets('a stored webhook Routine keeps its key controls', (
    tester,
  ) async {
    useTallSurface(tester);
    final store = MemoryStore();
    final api = SettingsApi(store, (path, body) async {
      if (body == null) {
        return routinesDocumentWithEditor(
          routines: [
            {
              'routineId': 'r1',
              'name': 'On demand',
              'schedule': null,
              'enabled': true,
            },
          ],
          editing: {
            'routineId': 'r1',
            'name': 'On demand',
            'prompt': 'Do the thing.',
            'timing': 'webhook',
            'keyVersion': '2',
          },
        );
      }
      final command = (body as Map).cast<String, Object?>();
      return {
        'schemaVersion': 1,
        'commandId': command['commandId'],
        'status': 'applied',
      };
    });
    await tester.pumpWidget(routinesEditorPage(api, store, routineId: 'r1'));
    await tester.pumpAndSettle();
    expect(find.text('Rotate key'), findsOneWidget);

    // Looking at the schedule form is not saving the Routine as scheduled.
    await tester.tap(find.text('Schedule'));
    await tester.pumpAndSettle();
    expect(find.text('Rotate key'), findsOneWidget);
  });

  group('the projection read back', () {
    test('pausing and resuming are the two Routine enablement commands', () {
      expect(
        routineCommandV1({
          'commandId': 'c1',
          'actionId': 'set-routine-enabled',
          'input': {
            'kind': 'set-routine-enabled',
            'routineId': 'r1',
            'enabled': false,
          },
        }, 'bot-1'),
        {
          'schemaVersion': 1,
          'commandId': 'c1',
          'botId': 'bot-1',
          'routineId': 'r1',
          'type': 'routine/pause',
        },
      );
      expect(
        routineCommandV1({
          'commandId': 'c2',
          'input': {
            'kind': 'set-routine-enabled',
            'routineId': 'r1',
            'enabled': true,
          },
        }, 'bot-1'),
        containsPair('type', 'routine/resume'),
      );
    });

    test('a Routine command carries no expectedRevision', () {
      // A Routine is its own durable record, so an unrelated edit must not
      // make a Routine write conflict — and the reverse.
      expect(
        routineCommandV1({
          'commandId': 'c3',
          'revision': 9,
          'input': {'kind': 'run-routine', 'routineId': 'r1'},
        }, 'bot-1'),
        isNot(contains('expectedRevision')),
      );
    });

    test('navigation is a kind, and no command', () {
      final command = {
        'commandId': 'c4',
        'input': {'kind': 'open-runs', 'routineId': 'r1'},
      };
      expect(routineActionKindV1(command), 'open-runs');
      expect(routineIdV1(command), 'r1');
      expect(() => routineCommandV1(command, 'bot-1'), throwsFormatException);
    });

    test('a firing reads as a moment, never as the wire', () {
      expect(
        routineRunMomentV1('2026-09-07T20:23:18.818Z'),
        matches(RegExp(r'^\d{1,2} [A-Z][a-z]{2} \d{4}, \d{1,2}:\d{2}[ap]m$')),
      );
      // A stamp this client cannot read is shown as it arrived rather than as
      // a moment that is not true.
      expect(routineRunMomentV1('not a moment'), 'not a moment');
      expect(routineRunMomentV1(null), '');
    });
  });

  testWidgets('pausing a Routine sends one command and reads back', (
    tester,
  ) async {
    final store = MemoryStore();
    final sent = <Map<String, Object?>>[];
    var enabled = true;
    var revision = 1;
    final api = SettingsApi(store, (path, body) async {
      if (body == null) {
        return routinesDocument(revision: revision, enabled: enabled);
      }
      sent.add((body as Map).cast<String, Object?>());
      enabled = false;
      revision = 2;
      return {
        'schemaVersion': 1,
        'commandId': body['commandId'],
        'status': 'applied',
      };
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: RoutinesView(
          api: api,
          store: store,
          userId: 'tim',
          botId: 'bot-1',
          botName: 'Scout',
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Morning brief'), findsWidgets);
    await tester.tap(find.byType(Switch));
    await tester.pumpAndSettle();
    expect(sent.single['type'], 'routine/pause');
    expect(sent.single['botId'], 'bot-1');
    expect(tester.widget<Switch>(find.byType(Switch)).value, isFalse);
  });

  testWidgets('deleting asks first, and Cancel keeps the Routine', (
    tester,
  ) async {
    useTallSurface(tester);
    final store = MemoryStore();
    final sent = <Map<String, Object?>>[];
    final api = SettingsApi(store, (path, body) async {
      if (path.endsWith('/plugins')) return {'plugins': []};
      if (body == null) {
        return routinesDocumentForPath(
          path,
          routines: [
            {
              'routineId': 'r1',
              'name': 'Morning brief',
              'schedule': '0 9 * * *',
              'enabled': true,
            },
          ],
          editing: {
            'routineId': 'r1',
            'name': 'Morning brief',
            'prompt': 'Summarise overnight email.',
            'schedule': '0 9 * * *',
            'timing': 'schedule',
          },
        );
      }
      sent.add((body as Map).cast<String, Object?>());
      return {
        'schemaVersion': 1,
        'commandId': body['commandId'],
        'status': 'applied',
      };
    });
    await tester.pumpWidget(routinesPage(api, store));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Morning brief').first);
    await tester.pumpAndSettle();
    expect(find.text('Save changes'), findsOneWidget);
    expect(find.text('Check that action'), findsNothing);
    final delete = find.widgetWithText(OutlinedButton, 'Delete');
    expect(delete, findsOneWidget);
    expect(tester.widget<OutlinedButton>(delete).onPressed, isNotNull);
    await tester.ensureVisible(delete);
    await tester.tap(delete);
    await tester.pump();
    expect(find.text('Delete this Routine?'), findsOneWidget);
    // The whole run log goes with it, which is what the question says.
    expect(find.textContaining('run log'), findsOneWidget);
    await tester.tap(find.widgetWithText(TextButton, 'Cancel'));
    await tester.pumpAndSettle();
    expect(sent, isEmpty);
    expect(find.text('Morning brief'), findsWidgets);

    await tester.ensureVisible(delete);
    await tester.tap(delete);
    await tester.pump();
    await tester.tap(find.text('Delete Routine'));
    await tester.pumpAndSettle();
    expect(sent.single['type'], 'routine/delete');
  });

  test('the inbox count is what the surface read, and says so', () async {
    final store = MemoryStore();
    var notified = 0;
    final controller = RoutineInboxController(
      SettingsApi(store, (_, _) async => {'unacknowledged': 3}),
      'bot-1',
    );
    addTearDown(controller.dispose);
    controller.addListener(() => notified++);
    expect(controller.unacknowledged, 0);
    await controller.load();
    expect(controller.unacknowledged, 3);
    expect(controller.badge, '3');
    expect(notified, 1);

    // The same count again is not news.
    controller.adopt(3);
    expect(notified, 1);

    // Past ninety-nine the badge stops counting and says so.
    controller.adopt(1200);
    expect(controller.badge, '99+');
    expect(notified, 2);
  });

  testWidgets('Routines recovers from offline without raw backend detail', (
    tester,
  ) async {
    var offline = true;
    final store = MemoryStore();
    final api = SettingsApi(store, (_, _) async {
      if (offline) throw const RequestFailure('synthetic backend detail');
      return routinesDocument();
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: RoutinesView(
          api: api,
          store: store,
          userId: 'tim',
          botId: 'bot-1',
          botName: 'Scout',
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.textContaining('synthetic backend'), findsNothing);
    expect(find.text('Routines couldn’t load'), findsOneWidget);
    offline = false;
    await tester.tap(find.text('Try again'));
    await tester.pumpAndSettle();
    expect(find.text('Morning brief'), findsWidgets);
  });
  group('the editor turns one press into', () {
    Map<String, Object?> save(Map<String, Object?> input) => {
      'commandId': 'c1',
      'input': {'kind': 'save-routine', ...input},
    };

    test('a create when it names no Routine', () {
      expect(
        routineCommandV1(
          save({
            'routine.name': '  Morning brief  ',
            'routine.prompt': 'Summarise overnight email.',
            'routine.timing': 'schedule',
            'routine.schedule': ' 0 9 * * * ',
          }),
          'bot-1',
        ),
        {
          'schemaVersion': 1,
          'commandId': 'c1',
          'botId': 'bot-1',
          'type': 'routine/create',
          'name': 'Morning brief',
          'prompt': 'Summarise overnight email.',
          'schedule': '0 9 * * *',
        },
      );
    });

    test('an update when it does, carrying every field the form held', () {
      final command = routineCommandV1(
        save({
          'routineId': 'r1',
          'routine.name': 'Evening brief',
          'routine.prompt': 'Summarise the day.',
          'routine.timing': 'schedule',
          'routine.schedule': '0 18 * * *',
        }),
        'bot-1',
      );
      expect(command['type'], 'routine/update');
      expect(command['routineId'], 'r1');
      expect(command['name'], 'Evening brief');
    });

    test('a webhook Routine, which carries a trigger and never a schedule', () {
      final command = routineCommandV1(
        save({
          'routine.name': 'On demand',
          'routine.prompt': 'Do the thing.',
          'routine.timing': 'webhook',
          'routine.schedule': '0 9 * * *',
        }),
        'bot-1',
      );
      expect(command['trigger'], {'kind': 'webhook'});
    });

    test('a Plugin-triggered Routine names the Plugin and its trigger', () {
      final command = routineCommandV1(
        save({
          'routine.name': 'Alerts',
          'routine.prompt': 'Read the alert.',
          'routine.timing': 'plugin:weather:alert',
        }),
        'bot-1',
      );
      expect(command['type'], 'routine/create');
      expect(command['trigger'], {
        'kind': 'plugin',
        'pluginId': 'weather',
        'trigger': 'alert',
      });
      expect(command.containsKey('schedule'), isFalse);
      expect(
        () => routineCommandV1(
          save({
            'routine.name': 'Alerts',
            'routine.prompt': 'Read the alert.',
            'routine.timing': 'plugin:weather:',
          }),
          'bot-1',
        ),
        throwsFormatException,
      );
      expect(command.containsKey('schedule'), isFalse);
    });

    test('a refusal said before anything is sent', () {
      expect(
        () => routineCommandV1(
          save({
            'routine.name': '  ',
            'routine.prompt': 'x',
            'routine.timing': 'schedule',
          }),
          'bot-1',
        ),
        throwsFormatException,
      );
      expect(
        () => routineCommandV1(
          save({
            'routine.name': 'x',
            'routine.prompt': ' ',
            'routine.timing': 'schedule',
          }),
          'bot-1',
        ),
        throwsFormatException,
      );
      // A scheduled Routine with no schedule would be refused by the route; it
      // is refused here instead, beside the field it is about.
      expect(
        () => routineCommandV1(
          save({
            'routine.name': 'x',
            'routine.prompt': 'y',
            'routine.timing': 'schedule',
            'routine.schedule': '   ',
          }),
          'bot-1',
        ),
        throwsFormatException,
      );
    });

    test('nothing at all, when the form was opened and left alone', () {
      final seeds = routineEditorSeedsV1({
        'type': 'group',
        'orientation': 'column',
        'children': [
          for (final pair in const [
            ('routine.name', 'Morning brief'),
            ('routine.prompt', 'Summarise overnight email.'),
            ('routine.timing', 'schedule'),
            ('routine.schedule', '0 9 * * *'),
          ])
            {
              'type': 'field',
              'field': {
                'id': pair.$1,
                'label': pair.$1,
                'kind': 'text',
                'value': pair.$2,
                'editable': true,
              },
            },
        ],
      });
      final untouched = save({
        'routineId': 'r1',
        'routine.name': 'Morning brief',
        'routine.prompt': 'Summarise overnight email.',
        'routine.timing': 'schedule',
        'routine.schedule': '0 9 * * *',
      });
      expect(routineSaveIsNoOpV1(untouched, seeds), isTrue);
      final edited = save({
        'routineId': 'r1',
        'routine.name': 'Morning brief',
        'routine.prompt': 'Summarise overnight email.',
        'routine.timing': 'webhook',
        'routine.schedule': '0 9 * * *',
      });
      expect(routineSaveIsNoOpV1(edited, seeds), isFalse);
      // A create names no Routine, so it is never a no-op.
      expect(
        routineSaveIsNoOpV1(save(const {'routine.name': 'x'}), seeds),
        isFalse,
      );
    });

    test('a form is dirty only after a field leaves what it was shown', () {
      final seeds = {
        'routine.name': 'Morning brief',
        'routine.prompt': 'Summarise overnight email.',
        'routine.timing': 'schedule',
        'routine.schedule': '0 9 * * *',
      };
      expect(routineEditorIsDirtyV1(const {}, seeds), isFalse);
      expect(routineEditorIsDirtyV1(seeds, seeds), isFalse);
      expect(
        routineEditorIsDirtyV1({
          ...seeds,
          'routine.name': 'Evening brief',
        }, seeds),
        isTrue,
      );
      expect(routineEditorIsDirtyV1({'routine.name': ''}, const {}), isFalse);
      expect(routineEditorIsDirtyV1({'routine.name': 'x'}, const {}), isTrue);
    });

    test('the two key commands the route takes', () {
      for (final pair in [
        ('rotate-key', 'routine/rotate-key'),
        ('revoke-key', 'routine/revoke-key'),
      ]) {
        expect(
          routineCommandV1({
            'commandId': 'c1',
            'input': {'kind': pair.$1, 'routineId': 'r1'},
          }, 'bot-1')['type'],
          pair.$2,
        );
      }
    });
  });
}
