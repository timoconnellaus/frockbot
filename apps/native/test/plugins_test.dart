import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/document_cache.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/plugins/page.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'settings_test.dart' show SettingsApi;
import 'widget_test.dart' show MemoryStore;

/// The shape `botPluginsDocumentV1` produces for one switchable row, written
/// by hand so the Flutter side is pinned to the projection's contract.
Map<String, Object?> switchDocument({int revision = 1, bool on = true}) => {
  'schemaVersion': 1,
  'surfaceId': 'bot-plugins',
  'revision': revision,
  'root': {
    'type': 'group',
    'orientation': 'column',
    'children': [
      {
        'type': 'group',
        'orientation': 'column',
        'title': 'Built in',
        'children': [
          {
            'type': 'group',
            'orientation': 'column',
            'title': 'Web',
            'children': [
              {
                'type': 'text',
                'text': 'Read public web pages.',
                'style': 'body',
              },
              {
                'type': 'group',
                'orientation': 'row',
                'children': [
                  {
                    'type': 'action',
                    'actionId': 'set-package-enabled',
                    'label': on ? 'Turn off' : 'Turn on',
                    'input': {
                      'kind': 'set-plugin-enabled',
                      'pluginId': 'web',
                      'enabled': !on,
                      'expectedRevision': revision,
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
  'actions': [
    {
      'id': 'set-package-enabled',
      'schema': {
        'type': 'object',
        'properties': {
          'kind': {
            'type': 'string',
            'enum': ['set-plugin-enabled'],
          },
          'pluginId': {'type': 'string', 'maxLength': 128},
          'enabled': {'type': 'boolean'},
          'expectedRevision': {
            'type': 'number',
            'minimum': 0,
            'maximum': 1000000,
          },
        },
        'required': ['kind', 'pluginId', 'enabled', 'expectedRevision'],
        'additionalProperties': false,
      },
    },
  ],
};

/// The shape `botPluginsDocumentV1` produces: rows filed under a titled
/// section per kind, which is what the search box has to look inside.
Map<String, Object?> botPluginsDocument() => {
  'schemaVersion': 1,
  'surfaceId': 'bot-plugins',
  'revision': 1,
  'root': {
    'type': 'group',
    'orientation': 'column',
    'children': [
      {
        'type': 'group',
        'orientation': 'column',
        'title': 'Built in',
        'children': [
          {
            'type': 'group',
            'orientation': 'column',
            'title': 'Web',
            'children': [
              {'type': 'text', 'text': 'Search and read pages.'},
              {
                'type': 'text',
                'text': 'Reaches example.com.',
                'style': 'status',
              },
              {'type': 'group', 'orientation': 'row', 'children': []},
            ],
          },
          {
            'type': 'group',
            'orientation': 'column',
            'title': 'Files',
            'children': [
              {'type': 'text', 'text': 'Keeps notes for later.'},
              {'type': 'group', 'orientation': 'row', 'children': []},
            ],
          },
        ],
      },
    ],
  },
  'actions': const [],
};

void main() {
  setUp(clearViewDocumentCacheMemory);

  test('search filters visible purposes while preserving authoritative action targets', () async {
    final controller = PluginsController(
      SettingsApi(MemoryStore(), (_, _) async => switchDocument()),
      'tim',
      botId: 'bot-1',
    );
    await controller.load();
    controller.search('no such plugin');
    var root = (controller.document!.toJson() as Map)['root'] as Map;
    expect(
      (root['children'] as List).where(
        (node) => (node as Map)['type'] == 'group',
      ),
      isEmpty,
    );
    controller.search('web pages');
    root = (controller.document!.toJson() as Map)['root'] as Map;
    expect(
      (root['children'] as List).where(
        (node) => (node as Map)['type'] == 'group',
      ),
      hasLength(1),
    );
    controller.dispose();
  });

  test(
    'a search does not replace the document a remount would paint',
    () async {
      final controller = PluginsController(
        SettingsApi(MemoryStore(), (_, _) async => switchDocument()),
        'tim',
        botId: 'bot-1',
      );
      await controller.load();
      controller.search('no such plugin');
      final shown = (controller.document!.toJson() as Map)['root'] as Map;
      expect(
        (shown['children'] as List).where(
          (node) => (node as Map)['type'] == 'group',
        ),
        isEmpty,
      );
      final cached = (controller.cacheDocument!.toJson() as Map)['root'] as Map;
      expect(
        (cached['children'] as List)
            .whereType<Map>()
            .where((node) => node['type'] == 'group')
            .map((node) => node['title']),
        ['Built in'],
      );
      controller.dispose();
    },
  );

  test(
    'a Bot search matches the plugin inside a kind section, not the kind',
    () async {
      final controller = PluginsController(
        SettingsApi(MemoryStore(), (_, _) async => botPluginsDocument()),
        'tim',
        botId: 'bot-1',
      );
      await controller.load();
      controller.search('web');
      var root = (controller.document!.toJson() as Map)['root'] as Map;
      var sections = (root['children'] as List)
          .whereType<Map>()
          .where((node) => node['type'] == 'group')
          .toList();
      expect(sections, hasLength(1));
      expect(
        (sections.single['children'] as List).whereType<Map>().map(
          (row) => row['title'],
        ),
        ['Web'],
      );
      controller.search('notes');
      root = (controller.document!.toJson() as Map)['root'] as Map;
      sections = (root['children'] as List)
          .whereType<Map>()
          .where((node) => node['type'] == 'group')
          .toList();
      expect(
        (sections.single['children'] as List).whereType<Map>().map(
          (row) => row['title'],
        ),
        ['Files'],
      );
      controller.search('no such plugin');
      root = (controller.document!.toJson() as Map)['root'] as Map;
      expect(
        (root['children'] as List).where(
          (node) => (node as Map)['type'] == 'group',
        ),
        isEmpty,
      );
      controller.dispose();
    },
  );

  testWidgets('a Bot switch sends one command and reads back', (tester) async {
    final store = MemoryStore();
    final sent = <Map<String, Object?>>[];
    var on = true;
    var revision = 1;
    final api = SettingsApi(store, (path, body) async {
      if (body == null) return switchDocument(revision: revision, on: on);
      expect(path, '/api/bots/bot-1/plugins');
      sent.add((body as Map).cast<String, Object?>());
      on = false;
      revision = 2;
      return {'status': 'applied', 'revision': revision};
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: PluginsPage(
          api: api,
          store: store,
          userId: 'tim',
          botId: 'bot-1',
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byType(Switch));
    await tester.pumpAndSettle();
    expect(sent.single['kind'], 'set-plugin-enabled');
    expect(sent.single['pluginId'], 'web');
    expect(sent.single['enabled'], isFalse);
    expect(sent.single['expectedRevision'], 1);
    expect(tester.widget<Switch>(find.byType(Switch)).value, isFalse);
  });

  testWidgets('the switch moves on the press, and the read agrees later', (
    tester,
  ) async {
    final store = MemoryStore();
    final gate = Completer<void>();
    var on = true;
    var revision = 1;
    final api = SettingsApi(store, (path, body) async {
      if (body == null) return switchDocument(revision: revision, on: on);
      await gate.future;
      on = false;
      revision = 2;
      return {'status': 'applied', 'revision': revision};
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: PluginsPage(
          api: api,
          store: store,
          userId: 'tim',
          botId: 'bot-1',
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(tester.widget<Switch>(find.byType(Switch)).value, isTrue);
    await tester.tap(find.byType(Switch));
    await tester.pumpAndSettle();
    // The command has not been answered: what the switch shows is what this
    // client sent.
    expect(tester.widget<Switch>(find.byType(Switch)).value, isFalse);
    gate.complete();
    await tester.pumpAndSettle();
    expect(tester.widget<Switch>(find.byType(Switch)).value, isFalse);
  });

  testWidgets('a section control on a Bot page posts the tool it names', (
    tester,
  ) async {
    final store = MemoryStore();
    final sent = <Map<String, Object?>>[];
    var loads = 0;
    final api = SettingsApi(store, (path, body) async {
      if (body == null) {
        loads += 1;
        return {
          'schemaVersion': 1,
          'surfaceId': 'bot-plugins',
          'revision': 3,
          'root': {
            'type': 'group',
            'orientation': 'column',
            'children': [
              {
                'type': 'group',
                'orientation': 'column',
                'title': 'Made by your Bots',
                'children': [
                  {
                    'type': 'group',
                    'orientation': 'column',
                    'title': 'Counter',
                    'children': [
                      {
                        'type': 'text',
                        'text': 'Version 0.0.1, written by your Bot.',
                      },
                      // The shape botPluginsDocumentV1 emits: the section root is
                      // nested inside a wrapper group on the card.
                      {
                        'type': 'group',
                        'orientation': 'column',
                        'children': [
                          {
                            'type': 'group',
                            'orientation': 'column',
                            'children': [
                              {'type': 'text', 'text': 'Count: $loads'},
                              {
                                'type': 'action',
                                'actionId': 'plugin-tool',
                                'label': 'Add two',
                                'input': {
                                  'kind': 'plugin-tool',
                                  'pluginId': 'counter',
                                  'tool': 'counter_bump',
                                  'arguments': '{"by":2}',
                                },
                              },
                            ],
                          },
                        ],
                      },
                      {
                        'type': 'group',
                        'orientation': 'row',
                        'children': [
                          {
                            'type': 'action',
                            'actionId': 'set-package-enabled',
                            'label': 'Turn off',
                            'input': {
                              'kind': 'set-plugin-enabled',
                              'pluginId': 'counter',
                              'enabled': false,
                              'expectedRevision': 3,
                            },
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
          'actions': [
            {
              'id': 'set-package-enabled',
              'schema': {
                'type': 'object',
                'properties': {
                  'kind': {
                    'type': 'string',
                    'enum': ['set-plugin-enabled'],
                  },
                  'pluginId': {'type': 'string', 'maxLength': 128},
                  'enabled': {'type': 'boolean'},
                  'expectedRevision': {
                    'type': 'number',
                    'minimum': 0,
                    'maximum': 1000000,
                  },
                },
                'required': ['kind', 'pluginId', 'enabled', 'expectedRevision'],
                'additionalProperties': false,
              },
            },
            {
              'id': 'plugin-tool',
              'schema': {
                'type': 'object',
                'properties': {
                  'kind': {
                    'type': 'string',
                    'enum': ['plugin-tool'],
                  },
                  'pluginId': {'type': 'string', 'maxLength': 128},
                  'tool': {'type': 'string', 'maxLength': 128},
                  'arguments': {'type': 'string', 'maxLength': 8000},
                },
                'required': ['kind', 'pluginId', 'tool', 'arguments'],
                'additionalProperties': false,
              },
            },
          ],
        };
      }
      expect(path, '/api/bots/bot-1/plugins');
      sent.add((body as Map).cast<String, Object?>());
      return {'status': 'ran', 'content': 'count is 2', 'isError': false};
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: PluginsPage(
          api: api,
          store: store,
          userId: 'tim',
          botId: 'bot-1',
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Count: 1'), findsOneWidget);
    await tester.tap(find.text('Add two'));
    await tester.pumpAndSettle();
    expect(sent.single['kind'], 'plugin-tool');
    expect(sent.single['tool'], 'counter_bump');
    expect(sent.single['arguments'], '{"by":2}');
    // The page is read again, so the section shows what changed.
    expect(find.text('Count: 2'), findsOneWidget);
  });

  testWidgets('Plugins recovers from offline without raw backend detail', (
    tester,
  ) async {
    var offline = true;
    final store = MemoryStore();
    final api = SettingsApi(store, (_, _) async {
      if (offline) throw const RequestFailure('synthetic backend detail');
      return switchDocument();
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: PluginsPage(
          api: api,
          store: store,
          userId: 'tim',
          botId: 'bot-1',
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.textContaining('synthetic backend'), findsNothing);
    expect(find.text('Plugins couldn’t load'), findsOneWidget);
    offline = false;
    await tester.tap(find.text('Try again'));
    await tester.pumpAndSettle();
    expect(find.text('Web'), findsOneWidget);
  });
}
