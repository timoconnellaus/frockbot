import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/audit/document.dart';
import 'package:frockbot_native/audit/page.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'settings_test.dart' show SettingsApi;
import 'widget_test.dart' show MemoryStore;

/// The shape `auditDocumentV1` produces, written by hand so the Flutter side
/// is pinned to the projection's contract.
Map<String, Object?> auditDocument({
  int revision = 1,
  String? kind,
  String? cursor,
  String outcome = 'ok',
}) => {
  'schemaVersion': 1,
  'surfaceId': 'audit',
  'revision': revision,
  'root': {
    'type': 'group',
    'orientation': 'column',
    'children': [
      {
        'type': 'text',
        'text': '1 audited effect${kind == null ? '' : ' · $kind'}',
        'style': 'status',
      },
      {
        'type': 'group',
        'orientation': 'row',
        'children': [
          {
            'type': 'action',
            'actionId': 'filter-kind',
            'label': 'All',
            'input': {'kind': 'filter-kind'},
          },
          {
            'type': 'action',
            'actionId': 'filter-kind',
            'label': 'shell',
            'input': {'kind': 'filter-kind', 'auditKind': 'shell'},
          },
        ],
      },
      {
        'type': 'group',
        'orientation': 'column',
        'title': 'ls -la /workspace',
        'children': [
          {
            'type': 'text',
            'text': outcome == 'unknown'
                ? 'Outcome unknown · shell_exec · This Computer'
                : 'Completed · shell_exec · This Computer',
            'style': 'status',
          },
          if (outcome == 'unknown')
            {
              'type': 'text',
              'text': 'Its outcome is uncertain. Check the affected service before repeating the action.',
            },
          {
            'type': 'action',
            'actionId': 'open-run',
            'label': 'Open the Turn',
            'input': {'kind': 'open-run', 'runId': 'run-1'},
          },
        ],
      },
      if (cursor != null)
        {
          'type': 'action',
          'actionId': 'load-more',
          'label': 'Earlier activity',
          'input': {'kind': 'load-more', 'cursor': cursor},
        },
      {
        'type': 'action',
        'actionId': 'rebuild',
        'label': 'Rebuild',
        'input': {'kind': 'rebuild'},
      },
    ],
  },
  'actions': [
    {
      'id': 'filter-kind',
      'schema': {
        'type': 'object',
        'properties': {
          'kind': {
            'type': 'string',
            'enum': ['filter-kind'],
          },
          'auditKind': {
            'type': 'string',
            'enum': ['shell', 'browser', 'mcp', 'file', 'process'],
          },
        },
        'required': ['kind'],
        'additionalProperties': false,
      },
    },
    {
      'id': 'load-more',
      'schema': {
        'type': 'object',
        'properties': {
          'kind': {
            'type': 'string',
            'enum': ['load-more'],
          },
          'cursor': {'type': 'string', 'maxLength': 512},
        },
        'required': ['kind', 'cursor'],
        'additionalProperties': false,
      },
    },
    {
      'id': 'rebuild',
      'schema': {
        'type': 'object',
        'properties': {
          'kind': {
            'type': 'string',
            'enum': ['rebuild'],
          },
        },
        'required': ['kind'],
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
          'runId': {'type': 'string', 'maxLength': 128},
        },
        'required': ['kind', 'runId'],
        'additionalProperties': false,
      },
    },
  ],
};

void main() {
  group('the projection read back', () {
    test('the query the host owns is the path it reads', () {
      expect(auditPathV1(botId: 'bot-1'), '/api/audit?botId=bot-1&as=document');
      expect(
        auditPathV1(botId: 'bot-1', kind: 'shell', before: 'p50'),
        '/api/audit?botId=bot-1&kind=shell&before=p50&as=document',
      );
      // No Bot is every Bot this account has.
      expect(auditPathV1(), '/api/audit?as=document');
    });

    test('every action names the kind it means', () {
      expect(
        auditActionKindV1({
          'input': {'kind': 'filter-kind', 'auditKind': 'browser'},
        }),
        'filter-kind',
      );
      expect(
        auditKindV1({
          'input': {'kind': 'filter-kind', 'auditKind': 'browser'},
        }),
        'browser',
      );
      expect(
        auditCursorV1({
          'input': {'kind': 'load-more', 'cursor': 'p50'},
        }),
        'p50',
      );
      expect(
        auditRunIdV1({
          'input': {'kind': 'open-run', 'runId': 'run-1'},
        }),
        'run-1',
      );
      // A kind the vocabulary does not carry names nothing at all.
      expect(
        auditActionKindV1({
          'input': {'kind': 'delete-everything'},
        }),
        isNull,
      );
    });
  });

  test('account-wide activity opens the Bot named by the entry', () async {
    final opened = <String>[];
    final controller = AuditController(
      SettingsApi(MemoryStore(), (_, _) async => null),
      openRun: (runId, botId) async => opened.add('$botId/$runId'),
    );
    await controller.dispatch({
      'commandId': 'open-1',
      'input': {'kind': 'open-run', 'botId': 'bot-2', 'runId': 'run-2'},
    });
    expect(opened, ['bot-2/run-2']);
    controller.dispose();
  });

  testWidgets('a filter re-reads, and a page reads from its own cursor', (
    tester,
  ) async {
    final store = MemoryStore();
    final read = <String>[];
    final api = SettingsApi(store, (path, body) async {
      if (path == "/api/bots") {
        return {"schemaVersion": 1, "revision": 0, "bots": []};
      }
      read.add(path);
      return auditDocument(
        revision: read.length,
        kind: path.contains('kind=shell') ? 'shell' : null,
        cursor: path.contains('before=') ? null : 'p50',
      );
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: AuditPage(
          api: api,
          store: store,
          userId: 'tim',
          botId: 'bot-1',
          botName: 'Scout',
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(read.single, '/api/audit?botId=bot-1&as=document');

    await tester.tap(find.text('shell'));
    await tester.pumpAndSettle();
    expect(read.last, '/api/audit?botId=bot-1&kind=shell&as=document');

    await tester.tap(find.text('Earlier activity'));
    await tester.pumpAndSettle();
    expect(
      read.last,
      '/api/audit?botId=bot-1&kind=shell&before=p50&as=document',
    );

    // Choosing a filter is how a reader gets back to the newest page: a
    // cursor minted under one filter names nothing under another.
    await tester.tap(find.text('All'));
    await tester.pumpAndSettle();
    expect(read.last, '/api/audit?botId=bot-1&as=document');
  });

  testWidgets('an outcome the log cannot explain is drawn, not classified', (
    tester,
  ) async {
    final store = MemoryStore();
    final api = SettingsApi(
      store,
      (_, _) async => auditDocument(outcome: 'unknown'),
    );
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: AuditPage(api: api, store: store, userId: 'tim', botId: 'bot-1'),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.textContaining('Outcome unknown'), findsOneWidget);
    expect(find.textContaining('Its outcome is uncertain'), findsOneWidget);
  });

  testWidgets('a rebuild is the one write, and it re-reads after', (
    tester,
  ) async {
    final store = MemoryStore();
    final written = <String>[];
    final api = SettingsApi(store, (path, body) async {
      if (body != null) {
        written.add(path);
        return {'schemaVersion': 1, 'status': 'rebuilt'};
      }
      return auditDocument(revision: written.length + 1);
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: AuditPage(api: api, store: store, userId: 'tim', botId: 'bot-1'),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Rebuild'));
    await tester.pumpAndSettle();
    expect(written.single, '/api/audit/rebuild');
  });

  testWidgets('Audit recovers from offline without raw backend detail', (
    tester,
  ) async {
    var offline = true;
    final store = MemoryStore();
    final api = SettingsApi(store, (_, _) async {
      if (offline) throw const RequestFailure('synthetic backend detail');
      return auditDocument();
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: AuditPage(api: api, store: store, userId: 'tim', botId: 'bot-1'),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.textContaining('synthetic backend'), findsNothing);
    expect(find.textContaining('couldn’t load'), findsOneWidget);
    offline = false;
    await tester.tap(find.text('Try again'));
    await tester.pumpAndSettle();
    expect(find.text('ls -la /workspace'), findsOneWidget);
  });
}
