import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/connections/document.dart';
import 'package:frockbot_native/connections/page.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'settings_test.dart' show SettingsApi;
import 'widget_test.dart' show MemoryStore;

/// The shape `connectionsDocumentV1` produces for one API-key provider,
/// written by hand so the Flutter side is pinned to the projection's contract
/// rather than to whatever the server happens to emit today.
Map<String, Object?> connectionsDocument({
  int revision = 1,
  List<Map<String, Object?>> accounts = const [],
  bool mayConnect = true,
}) => {
  'schemaVersion': 1,
  'surfaceId': 'connections',
  'revision': revision,
  'root': {
    'type': 'group',
    'orientation': 'column',
    'children': [
      {
        'type': 'group',
        'orientation': 'column',
        'title': 'Model in use',
        'children': [
          {'type': 'text', 'text': 'Auto · Frock AI', 'style': 'status'},
        ],
      },
      {
        'type': 'group',
        'orientation': 'column',
        'title': 'Provider accounts',
        'children': [
          {
            'type': 'group',
            'orientation': 'column',
            'title': 'Ollama Cloud',
            'children': [
              {
                'type': 'text',
                'text': accounts.isEmpty
                    ? 'No account connected'
                    : '1 account connected',
                'style': 'status',
              },
              for (final account in accounts)
                {
                  'type': 'group',
                  'orientation': 'column',
                  'children': [
                    {
                      'type': 'text',
                      'text': account['label'],
                      'style': 'label',
                    },
                    {
                      'type': 'text',
                      'text': account['detail'],
                      'style': 'status',
                    },
                    {
                      'type': 'group',
                      'orientation': 'row',
                      'children': [
                        {
                          'type': 'action',
                          'actionId': 'disconnect',
                          'label': 'Disconnect',
                          'style': 'danger',
                          'input': {
                            'kind': 'disconnect',
                            'connectionId': account['id'],
                          },
                        },
                      ],
                    },
                  ],
                },
              if (mayConnect) ...[
                {
                  'type': 'field',
                  'field': {
                    'id': 'c0.label',
                    'label': 'Connection label',
                    'kind': 'text',
                    'value': 'Ollama Cloud',
                    'editable': true,
                    'required': true,
                    'maxLength': 120,
                  },
                },
                {
                  'type': 'field',
                  'field': {
                    'id': 'c0.key',
                    'label': 'API key',
                    'kind': 'secret',
                    'value': null,
                    'editable': true,
                    'required': true,
                  },
                },
                {
                  'type': 'field',
                  'field': {
                    'id': 'c0.s.api-base-url',
                    'label': 'API base URL',
                    'kind': 'text',
                    'value': null,
                    'editable': true,
                  },
                },
                {
                  'type': 'action',
                  'actionId': 'connect-0',
                  'label': 'Connect account',
                  'style': 'primary',
                  'input': {
                    'kind': 'connect-api-key',
                    'packageId': 'provider-ollama-cloud',
                    'connectionTypeId': 'ollama-cloud-account',
                  },
                },
              ],
            ],
          },
        ],
      },
    ],
  },
  'actions': [
    {
      'id': 'disconnect',
      'schema': {
        'type': 'object',
        'properties': {
          'kind': {
            'type': 'string',
            'enum': ['disconnect', 'connect-api-key'],
          },
          'connectionId': {'type': 'string', 'maxLength': 128},
        },
        'required': ['kind', 'connectionId'],
        'additionalProperties': false,
      },
    },
    {
      'id': 'connect-0',
      'schema': {
        'type': 'object',
        'properties': {
          'kind': {
            'type': 'string',
            'enum': ['connect-api-key'],
          },
          'packageId': {'type': 'string', 'maxLength': 128},
          'connectionTypeId': {'type': 'string', 'maxLength': 128},
          'c0.label': {'type': 'string', 'maxLength': 120},
          'c0.key': {'type': 'string', 'maxLength': 8000},
          'c0.s.api-base-url': {'type': 'string', 'maxLength': 2000},
        },
        'required': [
          'kind',
          'packageId',
          'connectionTypeId',
          'c0.label',
          'c0.key',
        ],
        'additionalProperties': false,
      },
    },
  ],
};

void main() {
  group('the projection read back', () {
    test('a connect action becomes the credential route\'s command', () {
      expect(
        connectionRequestV1({
          'commandId': 'c1',
          'revision': 3,
          'actionId': 'connect-0',
          'input': {
            'kind': 'connect-api-key',
            'packageId': 'provider-ollama-cloud',
            'connectionTypeId': 'ollama-cloud-account',
            'c0.label': 'Local Ollama',
            'c0.key': 'synthetic-test-key',
            'c0.s.api-base-url': 'http://127.0.0.1:9999',
          },
        }).body,
        {
          'schemaVersion': 1,
          'type': 'connection/create-api-key',
          'commandId': 'c1',
          'packageId': 'provider-ollama-cloud',
          'connectionTypeId': 'ollama-cloud-account',
          'label': 'Local Ollama',
          'apiKey': 'synthetic-test-key',
          'settings': {'api-base-url': 'http://127.0.0.1:9999'},
        },
      );
    });

    test('an untouched Connection setting is not part of the command', () {
      final request = connectionRequestV1({
        'commandId': 'c2',
        'actionId': 'connect-0',
        'input': {
          'kind': 'connect-api-key',
          'packageId': 'provider-ollama-cloud',
          'connectionTypeId': 'ollama-cloud-account',
          'c0.label': 'Local Ollama',
          'c0.key': 'synthetic-test-key',
          'c0.s.api-base-url': '',
        },
      });
      expect(request.body.containsKey('settings'), isFalse);
    });

    test('a revocation goes to the Package\'s own route', () {
      final request = connectionRequestV1({
        'commandId': 'c3',
        'actionId': 'revoke',
        'input': {
          'kind': 'revoke',
          'packageId': 'connector-calendar',
          'connectionId': 'work',
        },
      });
      expect(
        request.path,
        '/api/plugins/connector-calendar/connections/work/revoke',
      );
      expect(request.body['type'], 'connection/revoke');
    });

    test('disconnecting never revokes upstream on the person\'s behalf', () {
      expect(
        connectionRequestV1({
          'commandId': 'c4',
          'actionId': 'disconnect',
          'input': {'kind': 'disconnect', 'connectionId': 'work'},
        }).body,
        containsPair('revokeUpstream', false),
      );
    });

    test('an action naming no kind Connectors takes is refused', () {
      expect(
        () => connectionRequestV1({
          'commandId': 'c5',
          'actionId': 'save-0',
          'input': {'sectionId': 'profile'},
        }),
        throwsA(isA<FormatException>()),
      );
    });
  });

  testWidgets('a key is typed once, sent once, and never read back', (
    tester,
  ) async {
    final store = MemoryStore();
    final sent = <Map<String, Object?>>[];
    var revision = 1;
    final api = SettingsApi(store, (path, body) async {
      if (body == null) return connectionsDocument(revision: revision);
      sent.add((body as Map).cast<String, Object?>());
      revision = 2;
      return {
        'schemaVersion': 1,
        'commandId': body['commandId'],
        'connectionId': 'conn-1',
        'status': 'applied',
      };
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: ConnectionsPage(api: api, store: store, userId: 'tim'),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Auto · Frock AI'), findsOneWidget);

    await tester.enterText(
      find.widgetWithText(TextFormField, 'Connection label'),
      'Local Ollama',
    );
    await tester.enterText(
      find.widgetWithText(TextFormField, 'API key'),
      'synthetic-test-key',
    );
    await tester.tap(find.text('Connect account'));
    await tester.pumpAndSettle();

    expect(sent.single['apiKey'], 'synthetic-test-key');
    expect(sent.single['label'], 'Local Ollama');
    // The document that comes back carries no key, and the widget that took
    // one starts empty again rather than holding a credential in memory.
    expect(find.text('synthetic-test-key'), findsNothing);
  });

  testWidgets('a connect with no key refuses before anything is sent', (
    tester,
  ) async {
    final store = MemoryStore();
    final sent = <Object?>[];
    final api = SettingsApi(store, (path, body) async {
      if (body == null) return connectionsDocument();
      sent.add(body);
      return {'commandId': 'x', 'status': 'applied'};
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: ConnectionsPage(api: api, store: store, userId: 'tim'),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Connect account'));
    await tester.pumpAndSettle();
    expect(sent, isEmpty);
    expect(find.text('This action still needs an answer.'), findsOneWidget);
  });

  testWidgets('Connectors recovers from offline without raw backend detail', (
    tester,
  ) async {
    var offline = true;
    final store = MemoryStore();
    final api = SettingsApi(store, (_, _) async {
      if (offline) throw const RequestFailure('synthetic backend detail');
      return connectionsDocument(
        accounts: [
          {
            'id': 'conn-1',
            'label': 'Local Ollama',
            'detail': 'Ready · model list up to date',
          },
        ],
        mayConnect: false,
      );
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: ConnectionsPage(api: api, store: store, userId: 'tim'),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.textContaining('synthetic backend'), findsNothing);
    expect(find.text('Connected apps couldn’t load'), findsOneWidget);
    offline = false;
    await tester.tap(find.text('Try again'));
    await tester.pumpAndSettle();
    expect(find.text('Ready · model list up to date'), findsOneWidget);
    expect(find.text('Disconnect'), findsOneWidget);
  });

  for (final brightness in Brightness.values) {
    testWidgets('Connectors stays readable at 200% ($brightness)', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final store = MemoryStore();
      final api = SettingsApi(
        store,
        (_, _) async => connectionsDocument(
          accounts: [
            {
              'id': 'conn-1',
              'label': 'My long work account label',
              'detail': 'Needs attention',
            },
          ],
        ),
      );
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(brightness),
          home: MediaQuery(
            data: const MediaQueryData(
              textScaler: TextScaler.linear(2),
              disableAnimations: true,
            ),
            child: ConnectionsPage(api: api, store: store, userId: 'tim'),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(
        find.text('Needs attention'),
        200,
        scrollable: find.byType(Scrollable).first,
      );
      expect(find.text('Needs attention'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  }
}
