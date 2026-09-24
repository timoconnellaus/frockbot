import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/document_cache.dart';
import 'package:frockbot_native/secrets/page.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'settings_test.dart' show SettingsApi;
import 'widget_test.dart' show MemoryStore;

const secretId = 'secret-0123456789abcdef0123456789abcdef';

/// The shape `secretsDocumentV1` produces, written by hand so the Flutter side
/// is pinned to the projection's contract.
Map<String, Object?> secretsDocument() => {
  'schemaVersion': 1,
  'surfaceId': 'secrets',
  'revision': 3,
  'root': {
    'type': 'group',
    'orientation': 'column',
    'children': [
      {
        'type': 'group',
        'orientation': 'column',
        'title': 'Visa',
        'children': [
          {
            'type': 'text',
            'text':
                'Payment detail · Used on https://shop.example · Saved 1 day ago',
            'style': 'status',
          },
          {
            'type': 'action',
            'actionId': 'delete-secret',
            'label': 'Delete',
            'style': 'danger',
            'input': {'kind': 'delete-secret', 'secretId': secretId},
          },
        ],
      },
    ],
  },
  'actions': [
    {
      'id': 'delete-secret',
      'schema': {
        'type': 'object',
        'properties': {
          'kind': {
            'type': 'string',
            'enum': ['delete-secret'],
          },
          'secretId': {'type': 'string', 'maxLength': 64},
        },
        'required': ['kind', 'secretId'],
        'additionalProperties': false,
      },
    },
  ],
};

void main() {
  setUp(clearViewDocumentCacheMemory);

  testWidgets('lists a saved secret by name and deletes it on its own route', (
    tester,
  ) async {
    final store = MemoryStore();
    final posted = <String>[];
    final api = SettingsApi(store, (path, body) async {
      if (body != null) {
        posted.add(path);
        return {'schemaVersion': 1, 'removed': true};
      }
      return secretsDocument();
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: SecretsPage(api: api, store: store, userId: 'tim'),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Saved secrets'), findsOneWidget);
    expect(find.text('Visa'), findsOneWidget);
    await tester.tap(find.text('Delete'));
    await tester.pumpAndSettle();
    expect(posted, ['/api/secrets/$secretId/delete']);
    await tester.pumpWidget(const SizedBox());
    api.close();
  });
}
