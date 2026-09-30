import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_client/client/document_cache.dart';
import 'package:frockbot_client/client/transport.dart';
import 'package:frockbot_client/machines/page.dart';
import 'package:frockbot_client/theme/frock_theme.dart';

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
      'id': 'revoke-machine',
      'schema': {
        'type': 'object',
        'properties': {
          'kind': {
            'type': 'string',
            'enum': ['revoke-machine'],
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

  testWidgets('the page offers no way to enroll, only to revoke', (
    tester,
  ) async {
    final store = MemoryStore();
    final paths = <String>[];
    final api = SettingsApi(store, (path, body) async {
      paths.add(path);
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
    expect(find.textContaining('pairing code'), findsNothing);
    expect(
      paths.where((path) => path.startsWith('/api/machines/enroll')),
      isEmpty,
    );
    // The desktop app pairs its own Mac; the page no longer knows the command.
    expect(
      machineActionKindV1({
        'input': {'kind': 'pair-machine'},
      }),
      isNull,
    );
    await tester.pumpWidget(const SizedBox());
    api.close();
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
