import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/applets/canvas.dart';
import 'package:frockbot_native/applets/chat_card.dart';
import 'package:frockbot_native/applets/picker.dart';
import 'package:frockbot_native/client/transport.dart';

import 'package:frockbot_native/shell/transcript.dart';

import 'applets_test.dart' show applet, sourceView;
import 'settings_test.dart' show SettingsApi;
import 'widget_test.dart' show MemoryStore;

void main() {
  testWidgets('picker deletes only after confirmation and removes the entry', (
    tester,
  ) async {
    var deleted = false;
    final api = SettingsApi(MemoryStore(), (path, body) async {
      if (path == '/api/applets') {
        return {
          'schemaVersion': 1,
          'applets': [if (!deleted) applet().toJson()],
        };
      }
      if (path.endsWith('/focus')) return {'appletId': null};
      if (path.endsWith('/delete')) {
        deleted = true;
        return {'schemaVersion': 1, 'status': 'deleted'};
      }
      throw StateError(path);
    });
    final controller = AppletCanvasController(api, 'bot-1');
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: AppletPicker(controller: controller)),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Delete Weekly Todos'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(deleted, isFalse);
    await tester.tap(find.byTooltip('Delete Weekly Todos'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Delete'));
    await tester.pumpAndSettle();
    expect(deleted, isTrue);
    expect(find.text('Weekly Todos'), findsNothing);
    expect(
      find.text('No Applets yet. Ask a Bot to build one.'),
      findsOneWidget,
    );
    await tester.pumpWidget(const SizedBox());
    controller.dispose();
  });

  testWidgets(
    'live card holds its viewer across refresh and clears it on deletion without focusing',
    (tester) async {
      var deleted = false;
      var tokens = 0;
      final api = SettingsApi(MemoryStore(), (path, body) async {
        expect(body, isNull);
        expect(path.contains('/focus'), isFalse);
        if (path == '/api/applets') {
          return {
            'schemaVersion': 1,
            'applets': [if (!deleted) applet(generationId: 'g1').toJson()],
          };
        }
        if (path.endsWith('/ui')) {
          return {
            'uiUrl': 'https://ui.example/applet.html',
            'generationId': 'g1',
          };
        }
        if (path.endsWith('/token')) {
          tokens++;
          return {
            'token': 'viewer-token',
            'expiresAt': '2027-01-01T00:00:00.000Z',
            'socketUrl':
                'wss://bot.frockbot.com/api/applets/todo.applet/socket',
          };
        }
        throw StateError(path);
      });
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: AppletChatScope(
              api: api,
              child: const AppletChatCard(appletId: 'todo.applet'),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byType(AppletViewerFrame), findsOneWidget);
      expect(tokens, 1);
      await tester.pump(const Duration(seconds: 30));
      await tester.pumpAndSettle();
      expect(tokens, 1);
      deleted = true;
      await tester.pump(const Duration(seconds: 30));
      await tester.pumpAndSettle();
      expect(find.byType(AppletViewerFrame), findsNothing);
      expect(
        find.text('This Applet has been deleted or is unavailable.'),
        findsOneWidget,
      );
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'a failed directory read offers a retry instead of the empty state',
    (tester) async {
      var down = true;
      final api = SettingsApi(MemoryStore(), (path, body) async {
        if (down) throw const RequestFailure('applets are unavailable', 503);
        if (path == '/api/applets') {
          return {
            'schemaVersion': 1,
            'applets': [applet().toJson()],
          };
        }
        if (path.endsWith('/focus')) return {'appletId': null};
        throw StateError(path);
      });
      final controller = AppletCanvasController(api, 'bot-1');
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(body: AppletPicker(controller: controller)),
        ),
      );
      await tester.pumpAndSettle();
      expect(
        find.text('No Applets yet. Ask a Bot to build one.'),
        findsNothing,
      );
      expect(
        find.text('Couldn\u2019t load Applets \u00b7 Retry'),
        findsOneWidget,
      );
      down = false;
      await tester.tap(find.text('Couldn\u2019t load Applets \u00b7 Retry'));
      await tester.pumpAndSettle();
      expect(find.text('Weekly Todos'), findsOneWidget);
      expect(
        find.text('No Applets yet. Ask a Bot to build one.'),
        findsNothing,
      );
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
    },
  );

  testWidgets('a live card keeps its frame through a failed refresh', (
    tester,
  ) async {
    var down = false;
    var tokens = 0;
    final api = SettingsApi(MemoryStore(), (path, body) async {
      if (down) throw const RequestFailure('FrockBot didn\u2019t answer');
      if (path == '/api/applets') {
        return {
          'schemaVersion': 1,
          'applets': [applet(generationId: 'g1').toJson()],
        };
      }
      if (path.endsWith('/ui')) {
        return {
          'uiUrl': 'https://ui.example/applet.html',
          'generationId': 'g1',
        };
      }
      if (path.endsWith('/token')) {
        tokens++;
        return {
          'token': 'viewer-token',
          'expiresAt': '2027-01-01T00:00:00.000Z',
          'socketUrl': 'wss://bot.frockbot.com/api/applets/todo.applet/socket',
        };
      }
      throw StateError(path);
    });
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: AppletChatScope(
            api: api,
            child: const AppletChatCard(appletId: 'todo.applet'),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byType(AppletViewerFrame), findsOneWidget);
    expect(tokens, 1);
    down = true;
    await tester.pump(const Duration(seconds: 30));
    await tester.pumpAndSettle();
    expect(find.byType(AppletViewerFrame), findsOneWidget);
    // The frame stays up, and the card says why it stopped refreshing and
    // offers the read that re-mints its credential.
    expect(find.text('FrockBot didn\u2019t answer.'), findsOneWidget);
    expect(find.text('Retry'), findsOneWidget);
    expect(
      find.text('This Applet has been deleted or is unavailable.'),
      findsNothing,
    );
    down = false;
    await tester.tap(find.text('Retry'));
    await tester.pumpAndSettle();
    expect(find.byType(AppletViewerFrame), findsOneWidget);
    expect(find.text('Retry'), findsNothing);
    expect(find.text('FrockBot didn\u2019t answer.'), findsNothing);
    expect(tokens, 1);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'a live card keeps its viewer when scrolled out of the viewport',
    (tester) async {
      var tokens = 0;
      final api = SettingsApi(MemoryStore(), (path, body) async {
        if (path == '/api/applets') {
          return {
            'schemaVersion': 1,
            'applets': [applet(generationId: 'g1').toJson()],
          };
        }
        if (path.endsWith('/ui')) {
          return {
            'uiUrl': 'https://ui.example/applet.html',
            'generationId': 'g1',
          };
        }
        if (path.endsWith('/token')) {
          tokens++;
          return {
            'token': 'viewer-token',
            'expiresAt': '2027-01-01T00:00:00.000Z',
            'socketUrl':
                'wss://bot.frockbot.com/api/applets/todo.applet/socket',
          };
        }
        throw StateError(path);
      });
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: AppletChatScope(
              api: api,
              child: ListView(
                children: const [
                  AppletChatCard(appletId: 'todo.applet'),
                  SizedBox(height: 4000, child: Text('below')),
                ],
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byType(AppletViewerFrame), findsOneWidget);
      expect(tokens, 1);
      // Well past the card and its cache extent: an ordinary card would be
      // unmounted here, taking a half-finished interaction with it.
      await tester.drag(find.byType(ListView), const Offset(0, -3000));
      await tester.pumpAndSettle();
      expect(
        find.byType(AppletViewerFrame, skipOffstage: false),
        findsOneWidget,
      );
      await tester.drag(find.byType(ListView), const Offset(0, 3000));
      await tester.pumpAndSettle();
      expect(find.byType(AppletViewerFrame), findsOneWidget);
      // A remount would have re-listed, re-read the UI and minted a second
      // viewer credential; the held one is still the only one.
      expect(tokens, 1);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'a directory that read fine renders when only the focus read fails',
    (tester) async {
      final api = SettingsApi(MemoryStore(), (path, body) async {
        if (path == '/api/applets') {
          return {
            'schemaVersion': 1,
            'applets': [applet().toJson()],
          };
        }
        // The Applets listed fine; the per-Bot focus route is the one that is
        // down, and it says nothing about whether the User has Applets.
        if (path.endsWith('/focus')) {
          throw const RequestFailure('applets are unavailable', 503);
        }
        throw StateError(path);
      });
      final controller = AppletCanvasController(api, 'bot-1');
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(body: AppletPicker(controller: controller)),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Weekly Todos'), findsOneWidget);
      expect(
        find.text('Couldn\u2019t load Applets \u00b7 Retry'),
        findsNothing,
      );
      expect(
        find.text('No Applets yet. Ask a Bot to build one.'),
        findsNothing,
      );
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
    },
  );

  testWidgets('deleting an Applet that is already gone is not a failure', (
    tester,
  ) async {
    var deleted = false;
    final api = SettingsApi(MemoryStore(), (path, body) async {
      if (path == '/api/applets') {
        return {
          'schemaVersion': 1,
          'applets': [if (!deleted) applet().toJson()],
        };
      }
      if (path.endsWith('/focus')) return {'appletId': null};
      if (path.endsWith('/delete')) {
        // Another window already deleted it, so the route answers with the
        // settled truth that there is no such Applet.
        deleted = true;
        throw const RequestFailure('Applet "todo.applet" is unavailable', 404);
      }
      throw StateError(path);
    });
    final controller = AppletCanvasController(api, 'bot-1');
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: AppletPicker(controller: controller)),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Delete Weekly Todos'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Delete'));
    await tester.pumpAndSettle();
    expect(
      find.text('Couldn\u2019t delete this Applet. Try again.'),
      findsNothing,
    );
    expect(find.text('Weekly Todos'), findsNothing);
    expect(
      find.text('No Applets yet. Ask a Bot to build one.'),
      findsOneWidget,
    );
    await tester.pumpWidget(const SizedBox());
    controller.dispose();
  });

  testWidgets('a focused Applet that will not open is not a picker failure', (
    tester,
  ) async {
    final api = SettingsApi(MemoryStore(), (path, body) async {
      if (path == '/api/applets') {
        return {
          'schemaVersion': 1,
          'applets': [applet(generationId: 'g1').toJson()],
        };
      }
      if (path.endsWith('/focus')) return {'appletId': 'todo.applet'};
      // The directory read answered; only this Applet's own detail is down.
      throw const RequestFailure('applets are unavailable', 503);
    });
    final controller = AppletCanvasController(api, 'bot-1');
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: AppletPicker(controller: controller)),
      ),
    );
    await tester.pumpAndSettle();
    expect(controller.failure, isNotNull);
    expect(find.text('Weekly Todos'), findsOneWidget);
    expect(find.text('Couldn\u2019t load Applets \u00b7 Retry'), findsNothing);
    expect(find.text('No Applets yet. Ask a Bot to build one.'), findsNothing);
    await tester.pumpWidget(const SizedBox());
    controller.dispose();
  });

  testWidgets(
    'an off-screen card stops refreshing and catches up when it returns',
    (tester) async {
      var reads = 0;
      final api = SettingsApi(MemoryStore(), (path, body) async {
        if (path == '/api/applets') {
          reads++;
          return {
            'schemaVersion': 1,
            'applets': [applet(generationId: 'g1').toJson()],
          };
        }
        if (path.endsWith('/ui')) {
          return {
            'uiUrl': 'https://ui.example/applet.html',
            'generationId': 'g1',
          };
        }
        if (path.endsWith('/token')) {
          return {
            'token': 'viewer-token',
            'expiresAt': '2027-01-01T00:00:00.000Z',
            'socketUrl':
                'wss://bot.frockbot.com/api/applets/todo.applet/socket',
          };
        }
        throw StateError(path);
      });
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: AppletChatScope(
              api: api,
              child: ListView(
                children: const [
                  AppletChatCard(appletId: 'todo.applet'),
                  SizedBox(height: 4000, child: Text('below')),
                ],
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(reads, 1);
      // On screen, the card refreshes on its cadence.
      await tester.pump(const Duration(seconds: 30));
      await tester.pumpAndSettle();
      expect(reads, 2);
      await tester.drag(find.byType(ListView), const Offset(0, -3000));
      await tester.pumpAndSettle();
      final hidden = reads;
      await tester.pump(const Duration(seconds: 30));
      await tester.pumpAndSettle();
      await tester.pump(const Duration(seconds: 30));
      await tester.pumpAndSettle();
      // Nothing is looking at the frame, so nothing is read for it.
      expect(reads, hidden);
      await tester.drag(find.byType(ListView), const Offset(0, 3000));
      await tester.pumpAndSettle();
      // Back on screen, the card catches up rather than waiting out the
      // remainder of a cadence it spent hidden.
      expect(reads, hidden + 1);
      expect(find.byType(AppletViewerFrame), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'a live card in the thread survives a message arriving while it is off-screen',
    (tester) async {
      var tokens = 0;
      final api = SettingsApi(MemoryStore(), (path, body) async {
        if (path == '/api/applets') {
          return {
            'schemaVersion': 1,
            'applets': [applet(generationId: 'g1').toJson()],
          };
        }
        if (path.endsWith('/ui')) {
          return {
            'uiUrl': 'https://ui.example/applet.html',
            'generationId': 'g1',
          };
        }
        if (path.endsWith('/token')) {
          tokens++;
          return {
            'token': 'viewer-token',
            'expiresAt': '2027-01-01T00:00:00.000Z',
            'socketUrl':
                'wss://bot.frockbot.com/api/applets/todo.applet/socket',
          };
        }
        throw StateError(path);
      });
      TranscriptLine chatter(int index) => TranscriptLine(
        id: 'chatter-$index',
        runId: 'chatter-$index',
        role: index.isEven ? LineRole.user : LineRole.assistant,
        text: 'Message $index',
        at: '2026-09-05T01:${index.toString().padLeft(2, '0')}:00.000Z',
        status: LineStatus.completed,
      );
      final card = TranscriptLine(
        id: 'card',
        runId: 'card',
        role: LineRole.assistant,
        text: '',
        at: '2026-09-05T02:00:00.000Z',
        status: LineStatus.completed,
        sends: const [
          SendPayloadLine({'type': 'applet', 'appletId': 'todo.applet'}),
        ],
      );
      final lines = <TranscriptLine>[
        for (var index = 0; index < 40; index++) chatter(index),
        card,
      ];
      Widget thread(List<TranscriptLine> rows) => MaterialApp(
        home: Scaffold(
          body: AppletChatScope(
            api: api,
            child: SizedBox(
              height: 500,
              child: TranscriptView(
                lines: rows,
                loading: false,
                hasEarlier: false,
                onRefresh: ({older = false}) async {},
                onOpenRun: (_) {},
                storageKey: 'card-thread',
              ),
            ),
          ),
        ),
      );
      await tester.pumpWidget(thread(lines));
      await tester.pumpAndSettle();
      expect(find.byType(AppletViewerFrame), findsOneWidget);
      expect(tokens, 1);
      // The User scrolls back through the thread; the card leaves the viewport
      // with an interaction half-finished inside it.
      final scrollable = tester.state<ScrollableState>(
        find.byType(Scrollable).first,
      );
      scrollable.position.jumpTo(2000);
      await tester.pumpAndSettle();
      // The Bot says one more thing. In a reversed thread every row shifts by
      // one, and a card found only by its index would be rebuilt as its
      // neighbour.
      await tester.pumpWidget(
        thread([
          ...lines,
          TranscriptLine(
            id: 'later',
            runId: 'later',
            role: LineRole.assistant,
            text: 'One more thing',
            at: '2026-09-05T03:00:00.000Z',
            status: LineStatus.completed,
          ),
        ]),
      );
      await tester.pumpAndSettle();
      scrollable.position.jumpTo(0);
      await tester.pumpAndSettle();
      expect(find.byType(AppletViewerFrame), findsOneWidget);
      // A rebuilt card would have minted a second viewer credential and lost
      // whatever was in the frame; the held one is still the only one.
      expect(tokens, 1);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('a focus newer than the listing is re-read before it is dropped', (
    tester,
  ) async {
    var listings = 0;
    final api = SettingsApi(MemoryStore(), (path, body) async {
      if (path == '/api/applets') {
        listings++;
        // The Turn created the Applet between this canvas read's listing and
        // its focus read, so the first listing cannot know about it.
        return {
          'schemaVersion': 1,
          'applets': [if (listings > 1) applet(generationId: 'g1').toJson()],
        };
      }
      if (path.endsWith('/focus')) return {'appletId': 'todo.applet'};
      if (path.endsWith('/source')) return sourceView(['ui.tsx']);
      if (path.endsWith('/build')) return {'status': 'unknown'};
      if (path.endsWith('/ui')) {
        return {
          'uiUrl': 'https://ui.example/applet.html',
          'generationId': 'g1',
        };
      }
      if (path.endsWith('/token')) {
        return {
          'token': 'viewer-token',
          'expiresAt': '2027-01-01T00:00:00.000Z',
          'socketUrl': 'wss://bot.frockbot.com/api/applets/todo.applet/socket',
        };
      }
      throw StateError(path);
    });
    final controller = AppletCanvasController(api, 'bot-1');
    await controller.load();
    expect(controller.focusedId, 'todo.applet');
    expect(controller.focused?.displayName, 'Weekly Todos');
    controller.dispose();
  });
}
