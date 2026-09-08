import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/applets/canvas.dart';
import 'package:frockbot_native/applets/client.dart';
import 'package:frockbot_native/applets/failure.dart';
import 'package:frockbot_native/applets/progress.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/protocol/client_wire.generated.dart' as wire;
import 'package:frockbot_native/shell/transcript_model.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'settings_test.dart' show SettingsApi;
import 'widget_test.dart' show MemoryStore;

wire.AppletSummary applet({String? generationId}) =>
    wire.AppletSummary.fromJson({
      'appletId': 'todo.applet',
      'displayName': 'Weekly Todos',
      'status': generationId == null ? 'draft' : 'published',
      'currentGenerationId': ?generationId,
      'tools': <String>[],
      'createdAt': '2026-09-05T01:00:00.000Z',
    });

AppletSource source(List<String> paths, {String changedAt = ''}) =>
    AppletSource(
      appletId: 'todo.applet',
      truncated: false,
      files: [
        for (final path in paths)
          AppletSourceFile(
            path: path,
            text: 'export class TodoApplet {}',
            generationId: 'g1',
            changedAt: changedAt.isEmpty ? null : changedAt,
          ),
      ],
    );

ToolActivity tool(String name, String status, {String? text, Object? input}) =>
    ToolActivity(
      id: '$name:$status',
      name: name,
      status: status,
      text: text,
      input: input,
    );

Map<String, Object?> sourceView(List<String> paths) => {
  'appletId': 'todo.applet',
  'truncated': false,
  'files': [
    for (final path in paths)
      {
        'path': path,
        'text': 'export class TodoApplet {}',
        'generationId': 'g1',
        'changedAt': '2026-09-05T01:00:00.000Z',
      },
  ],
};

void main() {
  group('the source the canvas draws', () {
    test('machine output is left out at any depth', () {
      expect(appletSourceArtefactPathV1('.wrangler/cache/cf.json'), isTrue);
      expect(appletSourceArtefactPathV1('web/node_modules/x/index.js'), isTrue);
      expect(appletSourceArtefactPathV1('server.ts'), isFalse);
      expect(
        appletSourceFilesV1(source(['.wrangler/cache/cf.json', 'server.ts']))
            .map((file) => file.path),
        ['server.ts'],
      );
    });

    test('a tie on time opens on the file a Bot edits first', () {
      expect(
        mostRecentlyChangedFileV1(source(['README.md', 'server.ts'])),
        'server.ts',
      );
    });

    test('the newest change wins over the alphabet', () {
      final view = AppletSource(
        appletId: 'todo.applet',
        truncated: false,
        files: const [
          AppletSourceFile(
            path: 'a.ts',
            text: '',
            generationId: 'g1',
            changedAt: '2026-09-05T01:00:00.000Z',
          ),
          AppletSourceFile(
            path: 'z.ts',
            text: '',
            generationId: 'g1',
            changedAt: '2026-09-05T02:00:00.000Z',
          ),
        ],
      );
      expect(mostRecentlyChangedFileV1(view), 'z.ts');
    });

    test('the fingerprint moves only when a file does', () {
      final before = appletSourceFingerprintV1(source(['server.ts']));
      expect(appletSourceFingerprintV1(source(['server.ts'])), before);
      expect(
        appletSourceFingerprintV1(source(['server.ts', 'ui.tsx'])),
        isNot(before),
      );
    });
  });

  group('the viewer credential in hand', () {
    AppletViewer held(Duration left) => AppletViewer(
      appletId: 'todo.applet',
      generationId: 'g2',
      uiUrl: 'https://ui.example/packages/abc.html',
      token: 't',
      socketUrl: 'wss://example/socket',
      expiresAt: DateTime.now().add(left),
    );

    test('is kept while the generation and the expiry both hold', () {
      expect(
        appletViewerStillCurrentV1(
          held: held(const Duration(minutes: 10)),
          appletId: 'todo.applet',
          generationId: 'g2',
        ),
        isTrue,
      );
    });

    test('is re-minted for a new generation, or near expiry', () {
      expect(
        appletViewerStillCurrentV1(
          held: held(const Duration(minutes: 10)),
          appletId: 'todo.applet',
          generationId: 'g3',
        ),
        isFalse,
      );
      expect(
        appletViewerStillCurrentV1(
          held: held(const Duration(minutes: 1)),
          appletId: 'todo.applet',
          generationId: 'g2',
        ),
        isFalse,
      );
    });
  });

  group('what the Bot is doing to the Applet', () {
    test('nothing is said about an Applet that is not there', () {
      expect(appletProgressV1(), isNull);
    });

    test('files on the Workspace mean the code is being written', () {
      final progress = appletProgressV1(
        applet: applet(),
        source: source(['server.ts']),
      );
      expect(progress!.label, 'Writing the code');
      expect(appletIsBeingBuiltV1(progress), isTrue);
    });

    test('a check that came back clean gets its own sentence', () {
      final progress = appletProgressV1(
        applet: applet(),
        source: source(['server.ts']),
        tools: [
          tool(
            'computer_exec',
            'completed',
            text: 'applet check: no problems found',
          ),
        ],
      );
      expect(progress!.label, 'The code checks out');
      expect(progress.failure, isNull);
      expect(progress.output, contains('applet check: no problems found'));
    });

    test('a check with errors says so, and keeps the tail', () {
      final progress = appletProgressV1(
        applet: applet(),
        tools: [
          tool(
            'computer_exec',
            'completed',
            text: 'ui.tsx:3:1 Unexpected any\napplet check: 1 error(s)',
          ),
        ],
      );
      expect(progress!.failure, 'The code has problems that need fixing.');
      expect(progress.output.last, 'applet check: 1 error(s)');
    });

    test('a publish of another Applet never moves this one', () {
      final progress = appletProgressV1(
        applet: applet(),
        source: source(['server.ts']),
        tools: [
          tool(
            'applet_publish',
            'completed',
            input: {'appletId': 'other.applet'},
          ),
        ],
      );
      expect(progress!.stage, AppletStage.writing);
    });

    test('a current generation is the settled fact', () {
      final progress = appletProgressV1(applet: applet(generationId: 'g1'));
      expect(progress!.label, 'Ready to use');
      expect(appletIsBeingBuiltV1(progress), isFalse);
    });

    test('a running Turn is working, whatever the stage says', () {
      final progress = appletProgressV1(
        applet: applet(generationId: 'g1'),
        running: true,
      );
      expect(progress!.working, isTrue);
    });

    test('the line is read from every Turn, oldest first', () {
      final lines = [
        TranscriptLine(
          id: 'm1',
          runId: 'r1',
          role: LineRole.assistant,
          text: '',
          status: LineStatus.completed,
          tools: [tool('applet_create', 'completed')],
        ),
        TranscriptLine(
          id: 'm2',
          runId: 'r2',
          role: LineRole.user,
          text: 'and publish it',
          status: LineStatus.completed,
          tools: [tool('applet_publish', 'completed')],
        ),
      ];
      expect(appletProgressToolsV1(lines).map((t) => t.name), [
        'applet_create',
      ]);
    });
  });

  test('a focus write carries exactly the one key the route takes', () async {
    Object? sent;
    final api = SettingsApi(MemoryStore(), (path, body) async {
      sent = body;
      return {'appletId': 'todo.applet'};
    });
    final kept = await AppletsApi(api).setFocus('bot-1', 'todo.applet');
    expect(sent, {'appletId': 'todo.applet'});
    expect(kept, 'todo.applet');
  });

  test('a focus the backend refused reads back as the focus it kept', () async {
    final api = SettingsApi(
      MemoryStore(),
      (path, body) async => {'appletId': null},
    );
    expect(await AppletsApi(api).setFocus('bot-1', 'todo.applet'), isNull);
  });

  group('a read that failed', () {
    test('a deployment that cannot sign a token is not retried', () {
      final failure = appletCanvasFailureV1(
        const RequestFailure('unavailable', 503),
      );
      expect(failure.kind, AppletFailureKind.unavailable);
      expect(failure.retry, AppletRetry.manual);
    });

    test('a gateway that never answered is retried on a widening backoff', () {
      final failure = appletCanvasFailureV1(const RequestFailure('offline'));
      expect(failure.kind, AppletFailureKind.unreachable);
      expect(failure.retry, AppletRetry.auto);
      expect(appletCanvasRetryDelayV1(1).inSeconds, 2);
      expect(appletCanvasRetryDelayV1(2).inSeconds, 4);
      expect(appletCanvasRetryDelayV1(9).inSeconds, 30);
    });

    test('an unpublished Applet says so, once', () {
      expect(
        appletCanvasFailureV1(const RequestFailure('missing', 404)).message,
        'This Applet hasn’t been published yet.',
      );
    });
  });

  group('the canvas', () {
    Future<AppletCanvasController> open(
      WidgetTester tester, {
      bool published = true,
    }) async {
      final store = MemoryStore();
      final api = SettingsApi(store, (path, body) async {
        if (path == '/api/applets') {
          return {
            'schemaVersion': 1,
            'applets': [applet(generationId: published ? 'g1' : null).toJson()],
          };
        }
        if (path.endsWith('/applets/focus')) return {'appletId': 'todo.applet'};
        if (path.endsWith('/source')) {
          return sourceView(['server.ts', 'ui.tsx']);
        }
        if (path.endsWith('/build')) return {'status': 'unknown'};
        if (path.endsWith('/ui')) {
          return {
            'uiUrl': 'https://ui.example/packages/abc.html',
            if (published) 'generationId': '2026-09-05T01:00:00.000Z:abcdef0',
          };
        }
        if (path.endsWith('/token')) {
          return {
            'token': 'viewer-token',
            // Millisecond precision exactly, because `Instant` is 24
            // characters and Dart writes microseconds when it has them.
            'expiresAt':
                '${DateTime.now().add(const Duration(minutes: 15)).toUtc().toIso8601String().substring(0, 23)}Z',
            'socketUrl':
                'wss://bot.frockbot.com/api/applets/todo.applet/socket',
          };
        }
        throw const RequestFailure('unexpected', 404);
      });
      final controller = AppletCanvasController(api, 'bot-1');
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: Scaffold(body: AppletCanvas(controller: controller)),
        ),
      );
      await controller.load();
      await tester.pumpAndSettle();
      return controller;
    }

    testWidgets('a draft opens on its code, with the progress line', (
      tester,
    ) async {
      await open(tester, published: false);
      expect(find.text('Weekly Todos'), findsOneWidget);
      expect(find.text('Writing the code'), findsOneWidget);
      expect(find.text('server.ts'), findsOneWidget);
      expect(find.text('ui.tsx'), findsOneWidget);
      // Nothing to run yet, so there is no view to toggle to.
      expect(find.text('App'), findsNothing);
    });

    testWidgets('a focus that moves to a draft never keeps the last live page', (
      tester,
    ) async {
      final store = MemoryStore();
      var focus = 'todo.applet';
      final api = SettingsApi(store, (path, body) async {
        if (path == '/api/applets') {
          return {
            'schemaVersion': 1,
            'applets': [
              applet(generationId: 'g1').toJson(),
              wire.AppletSummary.fromJson({
                'appletId': 'draft.applet',
                'displayName': 'Reading List',
                'status': 'draft',
                'tools': <String>[],
                'createdAt': '2026-09-05T01:00:00.000Z',
              }).toJson(),
            ],
          };
        }
        if (path.endsWith('/applets/focus')) return {'appletId': focus};
        if (path.endsWith('/source')) {
          return {
            ...sourceView(['server.ts']),
            'appletId': focus,
          };
        }
        if (path.endsWith('/build')) return {'status': 'unknown'};
        if (path.contains('draft.applet')) {
          // What the route answers for an Applet with nothing published.
          throw const RequestFailure('no active generation', 404);
        }
        if (path.endsWith('/ui')) {
          return {
            'uiUrl': 'https://ui.example/packages/abc.html',
            'generationId': '2026-09-05T01:00:00.000Z:abcdef0',
          };
        }
        if (path.endsWith('/token')) {
          return {
            'token': 'viewer-token',
            'expiresAt':
                '${DateTime.now().add(const Duration(minutes: 15)).toUtc().toIso8601String().substring(0, 23)}Z',
            'socketUrl':
                'wss://bot.frockbot.com/api/applets/todo.applet/socket',
          };
        }
        throw const RequestFailure('unexpected', 404);
      });
      final controller = AppletCanvasController(api, 'bot-1');
      await controller.load();
      expect(controller.viewer, isNotNull);
      focus = 'draft.applet';
      await controller.load();
      expect(controller.viewer, isNull);
      expect(controller.focused?.displayName, 'Reading List');
      // A draft is not a failed read: the code view is what there is to show.
      expect(controller.failure, isNull);
      controller.dispose();
    });

    testWidgets('a published Applet opens on the Applet, and toggles back', (
      tester,
    ) async {
      await open(tester);
      expect(find.textContaining('Live since'), findsOneWidget);
      expect(find.text('App'), findsOneWidget);
      await tester.tap(find.text('Code'));
      await tester.pumpAndSettle();
      expect(find.text('server.ts'), findsOneWidget);
    });
  });
}
