import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/document_cache.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/routines/document.dart';
import 'package:frockbot_native/routines/page.dart';
import 'package:frockbot_native/shell/semantics.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'settings_test.dart' show SettingsApi;
import 'shell_layout_test.dart' show byIdentifier;
import 'widget_test.dart' show MemoryStore;

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
          routineRow({
            'routineId': 'r1',
            'name': 'Morning brief',
            'schedule': '0 9 * * *',
            'enabled': enabled,
          }, runs: [
            {
              'entryId': 'e1',
              'routineId': 'r1',
              'name': 'Morning brief',
              'createdAt': '2026-09-02T23:00:10.000Z',
              'mark': 'finished',
            },
          ]),
        ],
      },
    ],
  },
  'actions': _actions,
};

Map<String, Object?> routinesDetailDocument({
  String name = 'Morning brief',
  String prompt = 'Summarise overnight email.',
  String timing = 'Every day at 9:00am · Australia/Sydney',
  String? config,
  bool webhook = false,
  int? hookKeyVersion,
}) => {
  'schemaVersion': 1,
  'surfaceId': 'routines',
  'revision': 2,
  'root': {
    'type': 'group',
    'orientation': 'column',
    'children': [
      {
        'type': 'field',
        'field': {
          'id': 'routine.name',
          'label': 'Name',
          'kind': 'text',
          'value': name,
          'editable': false,
        },
      },
      {
        'type': 'field',
        'field': {
          'id': 'routine.prompt',
          'label': 'Instructions',
          'kind': 'text',
          'value': prompt,
          'editable': false,
        },
      },
      {
        'type': 'field',
        'field': {
          'id': 'routine.timing',
          'label': 'Fires on',
          'kind': 'text',
          'value': timing,
          'editable': false,
        },
      },
      if (config != null)
        {
          'type': 'field',
          'field': {
            'id': 'routine.config',
            'label': 'Trigger config',
            'kind': 'text',
            'value': config,
            'editable': false,
          },
        },
      {
        'type': 'group',
        'orientation': 'row',
        'children': [
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
          if (webhook)
            {
              'type': 'action',
              'actionId': 'rotate-key',
              'label': hookKeyVersion == null ? 'Mint key' : 'Rotate key',
              'input': {'kind': 'rotate-key', 'routineId': 'r1'},
            },
          if (webhook && hookKeyVersion != null)
            {
              'type': 'action',
              'actionId': 'revoke-key',
              'label': 'Revoke key',
              'style': 'danger',
              'input': {'kind': 'revoke-key', 'routineId': 'r1'},
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
  'actions': _actions,
};

final _actions = <Map<String, Object?>>[
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
    'id': 'open-routine',
    'schema': {
      'type': 'object',
      'properties': {
        'kind': {
          'type': 'string',
          'enum': ['open-routine'],
        },
        'routineId': {'type': 'string', 'maxLength': 128},
      },
      'required': ['kind', 'routineId'],
      'additionalProperties': false,
    },
  },
  {
    'id': 'rotate-key',
    'schema': {
      'type': 'object',
      'properties': {
        'kind': {
          'type': 'string',
          'enum': ['rotate-key'],
        },
        'routineId': {'type': 'string', 'maxLength': 128},
      },
      'required': ['kind', 'routineId'],
      'additionalProperties': false,
    },
  },
  {
    'id': 'revoke-key',
    'schema': {
      'type': 'object',
      'properties': {
        'kind': {
          'type': 'string',
          'enum': ['revoke-key'],
        },
        'routineId': {'type': 'string', 'maxLength': 128},
      },
      'required': ['kind', 'routineId'],
      'additionalProperties': false,
    },
  },
];

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
            'actionId': 'open-routine',
            'label': 'Open',
            'input': {'kind': 'open-routine', 'routineId': id},
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
          'title': run['name'],
          'children': [
            {
              'type': 'text',
              'text': run['createdAt'],
              'style': 'status',
            },
            {'type': 'text', 'text': run['mark']},
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
                    'routineId': run['routineId'],
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

Future<void> pumpRoutines(
  WidgetTester tester, {
  required SettingsApi api,
  String? initialRoutineId,
  RoutinesPanelHandle? panel,
}) async {
  tester.view.physicalSize = const Size(1000, 2400);
  tester.view.devicePixelRatio = 1;
  await tester.pumpWidget(
    MaterialApp(
      theme: FrockTheme.theme(Brightness.dark),
      home: RoutinesView(
        api: api,
        store: MemoryStore(),
        userId: 'tim',
        botId: 'bot-1',
        botName: 'Scout',
        initialRoutineId: initialRoutineId,
        panel: panel,
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  setUp(clearViewDocumentCacheMemory);

  test('the panel header back is the detail’s back while it is open', () {
    expect(
      panelBackIdentifierV1(panelKey: 'routines', routinesEditorOpen: true),
      RoutineIds.detailBack,
    );
    expect(
      panelBackIdentifierV1(panelKey: 'routines', routinesEditorOpen: false),
      ShellIds.rightPanelBack,
    );
  });

  testWidgets('completions sit under their Routine as the Bot page rows', (
    tester,
  ) async {
    final api = SettingsApi(MemoryStore(), (_, _) async => routinesDocument());
    await pumpRoutines(tester, api: api);
    expect(find.text('Morning brief'), findsWidgets);
    expect(byIdentifier(RoutineIds.completion('e1')), findsOneWidget);
    expect(find.text('New Routine'), findsNothing);
  });

  testWidgets('tapping a Routine opens the detail; the switch is only the switch', (
    tester,
  ) async {
    final paths = <String>[];
    final api = SettingsApi(MemoryStore(), (path, body) async {
      paths.add(path);
      if (path.contains('routine=r1')) return routinesDetailDocument();
      return routinesDocument();
    });
    await pumpRoutines(tester, api: api);
    await tester.tap(find.text('Morning brief').first);
    await tester.pumpAndSettle();
    expect(paths.any((path) => path.contains('routine=r1')), isTrue);
    expect(find.text('Summarise overnight email.'), findsOneWidget);
    expect(find.text('Run now'), findsOneWidget);
    expect(find.text('Delete'), findsOneWidget);
  });

  testWidgets('a connected-app detail shows the event and optional config', (
    tester,
  ) async {
    final api = SettingsApi(MemoryStore(), (_, _) async {
      return routinesDetailDocument(
        timing: 'App event · gmail new gmail message',
        config: 'query: from:stripe.com',
      );
    });
    await pumpRoutines(tester, api: api, initialRoutineId: 'r1');
    expect(find.text('App event · gmail new gmail message'), findsOneWidget);
    expect(find.text('query: from:stripe.com'), findsOneWidget);
    expect(find.text('Mint key'), findsNothing);
  });

  testWidgets('a stored webhook Routine keeps its key controls', (
    tester,
  ) async {
    final sent = <Map<String, Object?>>[];
    final api = SettingsApi(MemoryStore(), (path, body) async {
      if (body != null) {
        sent.add((body as Map).cast<String, Object?>());
        return {
          'status': 'applied',
          'hook': {
            'token': 'hook-token',
            'path': '/api/bots/bot-1/routines/r1/hook',
            'keyVersion': 3,
          },
        };
      }
      return routinesDetailDocument(webhook: true, hookKeyVersion: 2);
    });
    await pumpRoutines(tester, api: api, initialRoutineId: 'r1');
    expect(find.text('Rotate key'), findsOneWidget);
    expect(find.text('Revoke key'), findsOneWidget);
    await tester.tap(find.text('Rotate key'));
    await tester.pumpAndSettle();
    expect(sent.single['type'], 'routine/rotate-key');
    expect(find.textContaining('Webhook key, version 3'), findsOneWidget);
    expect(find.text('hook-token'), findsOneWidget);
  });

  testWidgets('pausing a Routine sends one command and reads back', (
    tester,
  ) async {
    final sent = <Map<String, Object?>>[];
    var enabled = true;
    final api = SettingsApi(MemoryStore(), (path, body) async {
      if (body != null) {
        sent.add((body as Map).cast<String, Object?>());
        enabled = false;
        return {'status': 'applied'};
      }
      return routinesDocument(revision: enabled ? 1 : 2, enabled: enabled);
    });
    await pumpRoutines(tester, api: api);
    await tester.tap(find.byType(Switch));
    await tester.pumpAndSettle();
    expect(sent.single['type'], 'routine/pause');
  });

  testWidgets('deleting asks first, and Cancel keeps the Routine', (
    tester,
  ) async {
    final sent = <Map<String, Object?>>[];
    final api = SettingsApi(MemoryStore(), (path, body) async {
      if (body != null) {
        sent.add((body as Map).cast<String, Object?>());
        return {'status': 'applied'};
      }
      if (path.contains('routine=r1')) return routinesDetailDocument();
      return routinesDocument();
    });
    await pumpRoutines(tester, api: api);
    await tester.tap(find.text('Morning brief').first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Delete'));
    await tester.pump();
    expect(byIdentifier(RoutineIds.confirmDelete), findsOneWidget);
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(sent, isEmpty);
    expect(find.text('Morning brief'), findsWidgets);

    await tester.tap(find.text('Delete'));
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
    controller.adopt(3);
    expect(notified, 1);
    controller.adopt(1200);
    expect(controller.badge, '99+');
    expect(notified, 2);
  });

  testWidgets('Routines recovers from offline without raw backend detail', (
    tester,
  ) async {
    var offline = true;
    final api = SettingsApi(MemoryStore(), (_, _) async {
      if (offline) throw const RequestFailure('synthetic backend detail');
      return routinesDocument();
    });
    await pumpRoutines(tester, api: api);
    expect(find.textContaining('synthetic backend'), findsNothing);
    expect(find.text('Routines couldn’t load'), findsOneWidget);
    offline = false;
    await tester.tap(find.text('Try again'));
    await tester.pumpAndSettle();
    expect(find.text('Morning brief'), findsWidgets);
  });

  group('a press becomes', () {
    Map<String, Object?> command(String kind) => {
      'commandId': 'c1',
      'input': {'kind': kind, 'routineId': 'r1'},
    };

    test('a pause, a run, a rotate, or a delete', () {
      expect(routineCommandV1(command('set-routine-enabled'), 'bot-1')['type'], 'routine/pause');
      expect(
        routineCommandV1({
          'commandId': 'c1',
          'input': {
            'kind': 'set-routine-enabled',
            'routineId': 'r1',
            'enabled': true,
          },
        }, 'bot-1')['type'],
        'routine/resume',
      );
      expect(routineCommandV1(command('run-routine'), 'bot-1')['type'], 'routine/run');
      expect(routineCommandV1(command('rotate-key'), 'bot-1')['type'], 'routine/rotate-key');
      expect(routineCommandV1(command('delete-routine'), 'bot-1')['type'], 'routine/delete');
    });

    test('and refuses a write the list never offers', () {
      expect(
        () => routineCommandV1({
          'commandId': 'c1',
          'input': {'kind': 'open-routine', 'routineId': 'r1'},
        }, 'bot-1'),
        throwsFormatException,
      );
    });
  });
}
