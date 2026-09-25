import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/document_cache.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/machines/page.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'settings_test.dart' show SettingsApi;
import 'widget_test.dart' show MemoryStore;

/// The shape `machinesDocumentV1` produces, written by hand so the Flutter side
/// is pinned to the projection's contract rather than to a fixture the server
/// could change without anything noticing.
Map<String, Object?> machinesDocument({bool revoked = false}) => {
  'schemaVersion': 1,
  'surfaceId': 'machines',
  'revision': 7,
  'root': {
    'type': 'group',
    'orientation': 'column',
    'children': [
      {
        'type': 'group',
        'orientation': 'column',
        'title': 'Register a machine',
        'collapsed': true,
        'children': [
          {
            'type': 'field',
            'field': {
              'id': 'machine.label',
              'label': 'Name',
              'kind': 'text',
              'value': null,
              'editable': true,
              'maxLength': 200,
            },
          },
          {
            'type': 'action',
            'actionId': 'pair-machine',
            'label': 'Get a pairing code',
            'style': 'primary',
            'input': {'kind': 'pair-machine'},
          },
        ],
      },
      {
        'type': 'group',
        'orientation': 'column',
        'title': 'Studio laptop',
        'children': [
          {
            'type': 'text',
            'text': 'macos · run commands · Connected · last seen now',
            'style': 'status',
          },
          if (!revoked)
            {
              'type': 'action',
              'actionId': 'revoke-machine',
              'label': 'Revoke',
              'style': 'danger',
              'input': {'kind': 'revoke-machine', 'machineId': 'm-1'},
            },
        ],
      },
    ],
  },
  'actions': [
    {
      'id': 'pair-machine',
      'schema': {
        'type': 'object',
        'properties': {
          'kind': {
            'type': 'string',
            'enum': ['pair-machine', 'revoke-machine'],
          },
          'machine.label': {'type': 'string', 'maxLength': 200},
        },
        'required': ['kind'],
        'additionalProperties': false,
      },
    },
    {
      'id': 'revoke-machine',
      'schema': {
        'type': 'object',
        'properties': {
          'kind': {
            'type': 'string',
            'enum': ['pair-machine', 'revoke-machine'],
          },
          'machineId': {'type': 'string', 'maxLength': 200},
        },
        'required': ['kind', 'machineId'],
        'additionalProperties': false,
      },
    },
  ],
};

void main() {
  setUp(clearViewDocumentCacheMemory);

  testWidgets('the page owns replacement and disposal of its controller', (
    tester,
  ) async {
    final store = MemoryStore();
    final firstApi = SettingsApi(store, (_, _) async => machinesDocument());
    final secondApi = SettingsApi(store, (_, _) async => machinesDocument());

    Widget page(NativeApi api) => MaterialApp(
      home: MachinesPage(api: api, store: store, userId: 'tim'),
    );

    await tester.pumpWidget(page(firstApi));
    await tester.pumpAndSettle();
    final state = tester.state(find.byType(MachinesPage)) as dynamic;
    final first = state.controller as MachinesController;

    await tester.pumpWidget(page(secondApi));
    await tester.pumpAndSettle();
    final second = state.controller as MachinesController;
    expect(second, isNot(same(first)));
    expect(() => first.addListener(() {}), throwsFlutterError);

    await tester.pumpWidget(const SizedBox.shrink());
    expect(() => second.addListener(() {}), throwsFlutterError);
    firstApi.close();
    secondApi.close();
  });

  testWidgets('a pairing code is shown once, by the host, and then let go', (
    tester,
  ) async {
    final store = MemoryStore();
    final paths = <String>[];
    final api = SettingsApi(store, (path, body) async {
      paths.add(path);
      if (path.startsWith('/api/machines/pair')) {
        return {
          'schemaVersion': 1,
          'code': 'pair.code.here',
          'machineId': 'm-2',
          'expiresAt': '2026-09-06T02:00:00.000Z',
        };
      }
      return machinesDocument();
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: MachinesPage(api: api, store: store, userId: 'tim'),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Studio laptop'), findsOneWidget);
    expect(find.text('pair.code.here'), findsNothing);

    await tester.tap(find.text('Register a machine'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Get a pairing code'));
    await tester.pumpAndSettle();
    expect(paths, contains('/api/machines/pair'));
    expect(find.text('pair.code.here'), findsOneWidget);
    expect(find.textContaining('One use only'), findsOneWidget);

    // Dismissing is the only way the code leaves: a re-read never carries one.
    await tester.tap(find.text('Done'));
    await tester.pumpAndSettle();
    expect(find.text('pair.code.here'), findsNothing);
    await tester.pumpWidget(const SizedBox());
    api.close();
  });

  test('a pairing code says how long it has, not when it stops', () {
    final now = DateTime.parse('2026-09-06T12:00:00.000Z');
    expect(
      pairingWindowV1('2026-09-06T12:05:00.000Z', now: now),
      'in 5 minutes',
    );
    expect(
      pairingWindowV1('2026-09-06T12:01:00.000Z', now: now),
      'in 1 minute',
    );
    expect(
      pairingWindowV1('2026-09-06T12:00:30.000Z', now: now),
      'in under a minute',
    );
    expect(
      pairingWindowV1('2026-09-06T11:59:00.000Z', now: now),
      'now — get another',
    );
    expect(pairingWindowV1('never', now: now), 'shortly');
  });

  testWidgets('revoking lands on the machine’s own route', (tester) async {
    final store = MemoryStore();
    final posted = <String>[];
    final api = SettingsApi(store, (path, body) async {
      if (body != null) {
        posted.add(path);
        return null;
      }
      return machinesDocument();
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: MachinesPage(api: api, store: store, userId: 'tim'),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Revoke'));
    await tester.pumpAndSettle();
    expect(posted, ['/api/machines/m-1/revoke']);
    await tester.pumpWidget(const SizedBox());
    api.close();
  });

  testWidgets('a deployment that registers no machine says so, once', (
    tester,
  ) async {
    final store = MemoryStore();
    final api = SettingsApi(store, (path, body) async {
      throw const RequestFailure('machine registration is not configured', 503);
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: MachinesPage(api: api, store: store, userId: 'tim'),
      ),
    );
    await tester.pumpAndSettle();
    expect(
      find.text('This deployment doesn’t register machines.'),
      findsOneWidget,
    );
    await tester.pumpWidget(const SizedBox());
    api.close();
  });
}
