import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/routines/document.dart';
import 'package:frockbot_native/routines/editor.dart';
import 'package:frockbot_native/routines/page.dart';
import 'package:frockbot_native/routines/runs.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'settings_test.dart' show SettingsApi;
import 'widget_test.dart' show MemoryStore;

/// The shape `routinesDocumentV1` produces, written by hand so the Flutter
/// side is pinned to the projection's contract rather than to a fixture the
/// server could change without anything noticing.
Map<String, Object?> routinesDocument({
  int revision = 1,
  bool enabled = true,
  bool acknowledged = false,
}) => {
  'schemaVersion': 1,
  'surfaceId': 'routines',
  'revision': revision,
  'root': {
    'type': 'group',
    'orientation': 'column',
    'children': [
      {'type': 'text', 'text': '1 Routine · 1 unread', 'style': 'status'},
      {
        'type': 'group',
        'orientation': 'column',
        'title': 'Morning brief',
        'children': [
          {
            'type': 'text',
            'text':
                '0 9 * * * · Australia/Sydney · Never run · '
                '${enabled ? 'No next firing scheduled' : 'Paused'}',
            'style': 'status',
          },
          {'type': 'text', 'text': 'Summarise overnight email.'},
          {
            'type': 'group',
            'orientation': 'row',
            'children': [
              {
                'type': 'action',
                'actionId': 'set-routine-enabled',
                'label': enabled ? 'Pause' : 'Resume',
                'input': {
                  'kind': 'set-routine-enabled',
                  'routineId': 'r1',
                  'enabled': !enabled,
                },
              },
              {
                'type': 'action',
                'actionId': 'run-routine',
                'label': 'Run now',
                'input': {'kind': 'run-routine', 'routineId': 'r1'},
              },
              {
                'type': 'action',
                'actionId': 'open-runs',
                'label': 'Run log',
                'input': {'kind': 'open-runs', 'routineId': 'r1'},
              },
              {
                'type': 'action',
                'actionId': 'delete-routine',
                'label': 'Delete',
                'style': 'danger',
                'input': {'kind': 'delete-routine', 'routineId': 'r1'},
              },
            ],
          },
        ],
      },
      {
        'type': 'group',
        'orientation': 'column',
        'title': 'Routine completions',
        'children': [
          {
            'type': 'group',
            'orientation': 'column',
            'children': [
              {'type': 'text', 'text': 'Morning brief', 'style': 'status'},
              {'type': 'text', 'text': 'Nine unread, two need you.'},
              if (!acknowledged)
                {
                  'type': 'action',
                  'actionId': 'acknowledge-inbox',
                  'label': 'Mark read',
                  'input': {'kind': 'acknowledge-inbox', 'entryId': 'e1'},
                },
            ],
          },
          if (!acknowledged)
            {
              'type': 'action',
              'actionId': 'acknowledge-inbox',
              'label': 'Mark all read',
              'input': {'kind': 'acknowledge-inbox'},
            },
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
      'id': 'acknowledge-inbox',
      'schema': {
        'type': 'object',
        'properties': {
          'kind': {
            'type': 'string',
            'enum': ['acknowledge-inbox'],
          },
          'entryId': {'type': 'string', 'maxLength': 128},
        },
        'required': ['kind'],
        'additionalProperties': false,
      },
    },
  ],
};

/// The editor as `routinesDocumentV1` projects it: the field the host draws,
/// and the hidden fields that seed it. `collapsed` is what an unnamed Routine
/// starts as.
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
    'title': editing == null ? 'New Routine' : 'Edit ${editing['name']}',
    'collapsed': editing == null,
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

/// One Routine's row: what it fires on, and the two controls a row draws.
Map<String, Object?> routineRow(Map<String, Object?> routine) {
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
    ],
  };
}

/// The surface with the editor on it, above the rows it sits above.
Map<String, Object?> routinesDocumentWithEditor({
  List<Map<String, Object?>> routines = const [],
  Map<String, Object?>? editing,
}) => {
  'schemaVersion': 1,
  'surfaceId': 'routines',
  'revision': 1,
  'root': {
    'type': 'group',
    'orientation': 'column',
    'children': [
      routinesEditorGroup(editing),
      for (final routine in routines) routineRow(routine),
    ],
  },
  'actions': routinesDocument()['actions'],
};

/// The surface as a page, on a display tall enough to hold all of it: a form
/// and the rows under it are both things these tests press.
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

void useTallSurface(WidgetTester tester) {
  tester.view.physicalSize = const Size(1000, 2400);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
}

void main() {
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

  testWidgets('the guided editor only configures the selected trigger type', (
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
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: Scaffold(
          body: SingleChildScrollView(
            child: RoutineEditorV1(
              plugins: [plugin],
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
    );

    expect(find.text('Schedule'), findsOneWidget);
    expect(find.text('Webhook'), findsOneWidget);
    expect(find.text('GitHub'), findsOneWidget);
    expect(find.text('github'), findsNothing);

    await tester.tap(find.text('Webhook'));
    await tester.tap(find.text('Continue'));
    await tester.pumpAndSettle();
    expect(find.text('Configure Webhook'), findsOneWidget);
    expect(find.text('Configure Schedule'), findsNothing);
    expect(find.textContaining('0 9 * * *'), findsNothing);

    await tester.tap(find.text('Back'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('GitHub'));
    await tester.tap(find.text('Continue'));
    await tester.pumpAndSettle();
    expect(find.text('Configure GitHub'), findsOneWidget);
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
      return routinesDocumentWithEditor();
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

  testWidgets('an open editor leaves every row control on its own Routine', (
    tester,
  ) async {
    useTallSurface(tester);
    final store = MemoryStore();
    final sent = <Map<String, Object?>>[];
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

    // The editor is seeded from the Routine it names, so it is the edit form.
    await tester.tap(find.text('Continue'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Continue'));
    await tester.pumpAndSettle();
    expect(find.text('Run now'), findsOneWidget);

    // And the control beside it still pauses the Routine whose row it is.
    await tester.tap(find.text('Pause'));
    await tester.pumpAndSettle();
    expect(sent.single['routineId'], 'r1');
    expect(sent.single['type'], 'routine/pause');
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
    await tester.pumpWidget(routinesPage(api, store));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Continue'));
    await tester.pumpAndSettle();
    expect(find.text('Configure Schedule'), findsOneWidget);

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
    await tester.pumpWidget(routinesPage(api, store));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Continue'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Continue'));
    await tester.pumpAndSettle();
    // A scheduled Routine has no key to mint, whatever the form is about to
    // save it as.
    expect(find.text('Mint key'), findsNothing);

    await tester.tap(find.text('Back'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Back'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Webhook'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Continue'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Continue'));
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
    await tester.pumpWidget(routinesPage(api, store));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Continue'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Continue'));
    await tester.pumpAndSettle();
    expect(find.text('Rotate key'), findsOneWidget);

    // Looking at the schedule form is not saving the Routine as scheduled.
    await tester.tap(find.text('Back'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Back'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Schedule'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Continue'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Continue'));
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

    test('Mark all read names the entries the reader could see', () {
      final onScreen = routineUnacknowledgedOnScreenV1(
        routinesDocument()['root'],
      );
      expect(onScreen, ['e1']);
      expect(
        routineInboxCommandV1(
          {
            'commandId': 'c5',
            'input': {'kind': 'acknowledge-inbox'},
          },
          'bot-1',
          onScreen,
        ),
        {
          'schemaVersion': 1,
          'commandId': 'c5',
          'botId': 'bot-1',
          'type': 'routine/acknowledge-inbox',
          'entryIds': ['e1'],
        },
      );
      // Never an empty list: that is the wire's "acknowledge everything", and
      // a firing nobody has seen would go with it.
      expect(
        () => routineInboxCommandV1(
          {
            'commandId': 'c6',
            'input': {'kind': 'acknowledge-inbox'},
          },
          'bot-1',
          const [],
        ),
        throwsFormatException,
      );
    });

    test('one entry’s acknowledgement names only that entry', () {
      expect(
        routineInboxCommandV1(
          {
            'commandId': 'c7',
            'input': {'kind': 'acknowledge-inbox', 'entryId': 'e2'},
          },
          'bot-1',
          const ['e1', 'e2'],
        ),
        containsPair('entryIds', ['e2']),
      );
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

    test('an acknowledged inbox offers nothing to acknowledge', () {
      expect(
        routineUnacknowledgedOnScreenV1(
          routinesDocument(acknowledged: true)['root'],
        ),
        isEmpty,
      );
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
    await tester.tap(find.text('Pause'));
    await tester.pumpAndSettle();
    expect(sent.single['type'], 'routine/pause');
    expect(sent.single['botId'], 'bot-1');
    expect(find.text('Resume'), findsOneWidget);
  });

  testWidgets('deleting asks first, and Cancel keeps the Routine', (
    tester,
  ) async {
    final store = MemoryStore();
    final sent = <Map<String, Object?>>[];
    final api = SettingsApi(store, (path, body) async {
      if (body == null) return routinesDocument();
      sent.add((body as Map).cast<String, Object?>());
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
    await tester.tap(find.text('Delete'));
    await tester.pumpAndSettle();
    expect(find.text('Delete this Routine?'), findsOneWidget);
    // The whole run log goes with it, which is what the question says.
    expect(find.textContaining('run log'), findsOneWidget);
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(sent, isEmpty);
    expect(find.text('Morning brief'), findsWidgets);

    await tester.tap(find.text('Delete'));
    await tester.pumpAndSettle();
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

  test(
    'acknowledging drops the badge on the receipt, not on the next read',
    () async {
      final store = MemoryStore();
      final counts = <int>[];
      final controller = RoutinesController(
        SettingsApi(store, (path, body) async {
          if (body == null) return routinesDocument();
          return {
            'schemaVersion': 1,
            'commandId': (body as Map)['commandId'],
            'status': 'applied',
          };
        }),
        'bot-1',
        onInbox: counts.add,
      );
      addTearDown(controller.dispose);
      await controller.load();
      expect(counts, [1]);
      // The entry acknowledged was on screen, so what is left is arithmetic.
      await controller.dispatch({
        'commandId': 'c1',
        'actionId': 'acknowledge-inbox',
        'input': {'kind': 'acknowledge-inbox', 'entryId': 'e1'},
      });
      expect(counts, [1, 0]);
    },
  );

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
