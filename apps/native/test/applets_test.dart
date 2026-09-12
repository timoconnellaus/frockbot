import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/applets/canvas.dart';
import 'package:frockbot_native/applets/picker.dart';
import 'package:frockbot_native/applets/client.dart';
import 'package:frockbot_native/applets/failure.dart';
import 'package:frockbot_native/applets/progress.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/protocol/client_wire.generated.dart' as wire;
import 'package:frockbot_native/shell/transcript_model.dart';
import 'package:frockbot_native/theme/frock_theme.dart';
import 'package:frockbot_native/view/host_frame_io.dart'
    if (dart.library.js_interop) 'package:frockbot_native/view/host_frame_web.dart';
import 'package:frockbot_native/view/host_frame_messages.dart';

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

/// The viewer half of an open answer for a published Applet.
Map<String, Object?> openViewer() => {
  'generationId': '2026-09-05T01:00:00.000Z:abcdef0',
  'uiUrl': 'https://ui.example/packages/abc.html',
  'token': 'viewer-token',
  // Millisecond precision exactly, because `Instant` is 24 characters and
  // Dart writes microseconds when it has them.
  'expiresAt':
      '${DateTime.now().add(const Duration(minutes: 15)).toUtc().toIso8601String().substring(0, 23)}Z',
  'socketUrl': 'wss://bot.frockbot.com/api/applets/todo.applet/socket',
};

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

  group('the frame keeps its document across a re-minted credential', () {
    AppletViewer viewer(String token, {String generationId = 'g1'}) =>
        AppletViewer(
          appletId: 'todo.applet',
          generationId: generationId,
          uiUrl: 'https://ui.example/packages/abc.html',
          token: token,
          socketUrl: 'wss://bot.frockbot.com/api/applets/todo.applet/socket',
          expiresAt: DateTime.utc(2026, 9, 5, 1, 15),
        );

    test('the document is the generation and the page, never the token', () {
      expect(viewer('t1').documentIdentity, viewer('t2').documentIdentity);
      expect(
        viewer('t1').documentIdentity,
        isNot(viewer('t1', generationId: 'g2').documentIdentity),
      );
      expect(
        viewer('t1').refreshAt,
        DateTime.utc(2026, 9, 5, 1, 15).subtract(appletViewerRefreshV1),
      );
    });

    test('a fresh token is a refresh behind the init the page loaded with', () {
      const tokens = {'surface': '#000000'};
      expect(
        appletFrameMessagesV1(
          loaded: viewer('t1'),
          current: viewer('t1'),
          themeTokens: tokens,
        ).map((message) => message['type']),
        ['init'],
      );
      final rotated = appletFrameMessagesV1(
        loaded: viewer('t1'),
        current: viewer('t2'),
        themeTokens: tokens,
      );
      expect(rotated.map((message) => message['type']), ['init', 'refresh']);
      // The init still names the credential the document loaded with, so a
      // host frame re-reading the list finds it unchanged and delivers only
      // the refresh; the refresh is init-shaped with the new credential.
      expect((rotated[0]['applet']! as Map)['token'], 't1');
      final refresh = rotated[1];
      expect(refresh['schemaVersion'], 1);
      expect(refresh['themeTokens'], tokens);
      expect((refresh['applet']! as Map)['token'], 't2');
      expect((refresh['applet']! as Map)['generationId'], 'g1');
      expect((refresh['applet']! as Map)['tokenTransport'], 'subprotocol-v1');
    });

    test('a host frame delivers only what changed or was added', () {
      final init = {'type': 'init', 'token': 't1'};
      final refresh = {'type': 'refresh', 'token': 't2'};
      expect(hostFrameChangedMessagesV1([init], [init, refresh]), [refresh]);
      expect(hostFrameChangedMessagesV1([init], [init]), isEmpty);
      final moved = {'type': 'state', 'value': 2};
      expect(
        hostFrameChangedMessagesV1(
          [
            init,
            {'type': 'state', 'value': 1},
          ],
          [init, moved],
        ),
        [moved],
      );
    });

    testWidgets('the frame is not rebuilt when the token moves', (
      tester,
    ) async {
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: Scaffold(body: AppletViewerFrame(viewer: viewer('t1'))),
        ),
      );
      await tester.pump();
      final before = tester.state(find.byType(HostFrameView));
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: Scaffold(body: AppletViewerFrame(viewer: viewer('t2'))),
        ),
      );
      await tester.pump();
      expect(tester.state(find.byType(HostFrameView)), same(before));
      final frame = tester.widget<HostFrameView>(find.byType(HostFrameView));
      expect(frame.messages.map((message) => message['type']), [
        'init',
        'refresh',
      ]);
      // A new generation is a new document, and starts from its own init.
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: Scaffold(
            body: AppletViewerFrame(viewer: viewer('t3', generationId: 'g2')),
          ),
        ),
      );
      await tester.pump();
      expect(tester.state(find.byType(HostFrameView)), isNot(same(before)));
      expect(
        tester
            .widget<HostFrameView>(find.byType(HostFrameView))
            .messages
            .map((message) => message['type']),
        ['init'],
      );
      await tester.pumpWidget(const SizedBox());
    });
  });

  group('the canvas', () {
    final requested = <String>[];
    setUp(requested.clear);
    Future<AppletCanvasController> open(
      WidgetTester tester, {
      bool published = true,
    }) async {
      final store = MemoryStore();
      final api = SettingsApi(store, (path, body) async {
        requested.add(path);
        if (path.endsWith('/applets/open')) {
          return {
            'schemaVersion': 1,
            'applets': [applet(generationId: published ? 'g1' : null).toJson()],
            'focused': {
              'appletId': 'todo.applet',
              if (published) ...openViewer(),
            },
          };
        }
        if (path.endsWith('/source')) {
          return sourceView(['server.ts', 'ui.tsx']);
        }
        if (path.endsWith('/build')) return {'status': 'unknown'};
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

    testWidgets('the frame is given its page before the code is asked for', (
      tester,
    ) async {
      final controller = await open(tester);
      // One read put the frame up. The source and the build are the code
      // view's, and the code view is not what is showing.
      expect(requested, ['/api/bots/bot-1/applets/open']);
      expect(controller.viewer, isNotNull);
      expect(controller.source, isNull);

      // A Turn working on a live Applet re-reads the open route alone.
      await controller.poll();
      expect(requested, [
        '/api/bots/bot-1/applets/open',
        '/api/bots/bot-1/applets/open',
      ]);

      // The code is read when it is looked at.
      await tester.tap(find.text('Code'));
      await tester.pumpAndSettle();
      expect(requested.skip(2), [
        '/api/bots/bot-1/applets/todo.applet/source',
        '/api/bots/bot-1/applets/todo.applet/build',
      ]);
      expect(controller.source, isNotNull);
      controller.dispose();
    });

    testWidgets(
      'the credential is re-read before it expires, with no Turn running',
      (tester) async {
        var minted = 0;
        final api = SettingsApi(MemoryStore(), (path, body) async {
          if (path.endsWith('/applets/open')) {
            minted += 1;
            return {
              'schemaVersion': 1,
              'applets': [applet(generationId: 'g1').toJson()],
              'focused': {
                'appletId': 'todo.applet',
                ...openViewer(),
                'token': 'viewer-token-$minted',
              },
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
        expect(controller.viewer?.token, 'viewer-token-1');
        // Fifteen minutes less the refresh margin: the open route is read
        // again and the fresh token is adopted — the frame itself stays.
        final before = tester.state(find.byType(HostFrameView));
        await tester.pump(const Duration(minutes: 12, seconds: 1));
        await tester.pumpAndSettle();
        expect(minted, 2);
        expect(controller.viewer?.token, 'viewer-token-2');
        expect(tester.state(find.byType(HostFrameView)), same(before));
        controller.dispose();
        await tester.pumpWidget(const SizedBox());
      },
    );

    testWidgets(
      'a draft reads its code behind the open answer, in that order',
      (tester) async {
        final controller = await open(tester, published: false);
        expect(requested, [
          '/api/bots/bot-1/applets/open',
          '/api/bots/bot-1/applets/todo.applet/source',
          '/api/bots/bot-1/applets/todo.applet/build',
        ]);
        expect(controller.viewer, isNull);
        // With nothing published the code is the content, so a poll keeps it
        // fresh too.
        requested.clear();
        await controller.poll();
        expect(requested.first, '/api/bots/bot-1/applets/open');
        expect(
          requested,
          contains('/api/bots/bot-1/applets/todo.applet/source'),
        );
      },
    );

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

    testWidgets(
      'a focus that moves to a draft never keeps the last live page',
      (tester) async {
        final store = MemoryStore();
        var focus = 'todo.applet';
        final api = SettingsApi(store, (path, body) async {
          if (path.endsWith('/applets/open')) {
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
              // A draft's focus is its id and nothing else: what the route
              // answers for an Applet with nothing published.
              'focused': {
                'appletId': focus,
                if (focus == 'todo.applet') ...openViewer(),
              },
            };
          }
          if (path.endsWith('/source')) {
            return {
              ...sourceView(['server.ts']),
              'appletId': focus,
            };
          }
          if (path.endsWith('/build')) return {'status': 'unknown'};
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
      },
    );

    testWidgets('a published Applet opens on the Applet, and toggles back', (
      tester,
    ) async {
      final controller = await open(tester);
      expect(find.textContaining('Live since'), findsOneWidget);
      expect(find.text('App'), findsOneWidget);
      await tester.tap(find.text('Code'));
      await tester.pumpAndSettle();
      expect(find.text('server.ts'), findsOneWidget);
      controller.dispose();
    });
  });

  group('the picker answers the tap, not the round trip', () {
    Map<String, Object?> summary(String appletId, String name) => {
      'appletId': appletId,
      'displayName': name,
      'status': 'published',
      'currentGenerationId': 'g1',
      'tools': <String>[],
      'createdAt': '2026-09-05T01:00:00.000Z',
    };

    testWidgets('a confirmed delete takes the row now and restores it if the '
        'delete genuinely failed', (tester) async {
      final deletes = Completer<void>();
      final api = SettingsApi(MemoryStore(), (path, body) async {
        if (path.endsWith('/applets/open')) {
          return {
            'schemaVersion': 1,
            'applets': [
              summary('todo.applet', 'Weekly Todos'),
              summary('notes.applet', 'Field Notes'),
            ],
          };
        }
        if (path == '/api/applets/todo.applet/delete') {
          await deletes.future;
          throw const RequestFailure('synthetic backend detail', 500);
        }
        throw const RequestFailure('unexpected', 404);
      });
      final controller = AppletCanvasController(api, 'bot-1');
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: Scaffold(body: AppletPicker(controller: controller)),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Weekly Todos'), findsOneWidget);

      await tester.tap(find.byTooltip('Delete Weekly Todos'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Delete'));
      await tester.pump();

      // One frame, and the row is gone: the confirmation was the decision.
      expect(find.text('Weekly Todos'), findsNothing);
      // Nothing else waited on it — a single flag used to disable every row.
      expect(find.text('Field Notes'), findsOneWidget);
      expect(
        tester
            .widget<IconButton>(
              find.ancestor(
                of: find.byTooltip('Delete Field Notes'),
                matching: find.byType(IconButton),
              ),
            )
            .onPressed,
        isNotNull,
      );

      deletes.complete();
      await tester.pumpAndSettle();
      expect(find.text('Weekly Todos'), findsOneWidget);
      expect(
        find.text('Couldn’t delete this Applet. Try again.'),
        findsOneWidget,
      );
      controller.dispose();
    });

    test(
      'the focus moves on the choice and reconciles against what was kept',
      () async {
        final kept = Completer<String>();
        var focus = 'todo.applet';
        final api = SettingsApi(MemoryStore(), (path, body) async {
          if (path.endsWith('/applets/open')) {
            return {
              'schemaVersion': 1,
              'applets': [
                summary('todo.applet', 'Weekly Todos'),
                summary('notes.applet', 'Field Notes'),
              ],
              'focused': {'appletId': focus, ...openViewer()},
            };
          }
          if (path.endsWith('/applets/focus')) {
            focus = await kept.future;
            return {'appletId': focus};
          }
          throw const RequestFailure('unexpected', 404);
        });
        final controller = AppletCanvasController(api, 'bot-1');
        await controller.load();
        expect(controller.focusedId, 'todo.applet');

        final moving = controller.setFocus('notes.applet');
        // The canvas is on the chosen Applet before either request answers.
        expect(controller.focusedId, 'notes.applet');
        expect(controller.viewer, isNull);

        // The backend answers with what it kept, which need not be what was
        // asked, and that answer is what the canvas ends up on.
        kept.complete('todo.applet');
        await moving;
        expect(controller.focusedId, 'todo.applet');
        controller.dispose();
      },
    );
  });
}
