import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/applets/canvas.dart';
import 'package:frockbot_native/applets/chat_card.dart';
import 'package:frockbot_native/client/transport.dart';

import 'package:frockbot_native/shell/transcript.dart';

import 'applets_test.dart' show applet;
import 'settings_test.dart' show SettingsApi;
import 'widget_test.dart' show MemoryStore;

/// The token a card mints, as the Bot-scoped route answers it.
Map<String, Object?> viewerToken() => {
  'token': 'viewer-token',
  'expiresAt': '2027-01-01T00:00:00.000Z',
  'socketUrl': 'wss://bot.frockbot.com/api/applets/todo.applet/socket',
};

void main() {
  testWidgets(
    'live card holds its viewer across refresh and clears it on deletion without focusing',
    (tester) async {
      var deleted = false;
      var tokens = 0;
      final api = SettingsApi(MemoryStore(), (path, body) async {
        expect(body, isNull);
        expect(path.contains('/focus'), isFalse);
        if (path == '/api/bots/bot-1/applets') {
          return {
            'schemaVersion': 1,
            'applets': [if (!deleted) applet(generationId: 'g1').toJson()],
          };
        }
        if (path == '/api/bots/bot-1/applets/todo.applet/ui') {
          return {
            'uiUrl': 'https://ui.example/applet.html',
            'generationId': 'g1',
          };
        }
        if (path == '/api/bots/bot-1/applets/todo.applet/token') {
          tokens++;
          return viewerToken();
        }
        throw StateError(path);
      });
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: AppletChatScope(
              api: api,
              botId: 'bot-1',
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

  testWidgets('a card is read as the Bot of the transcript it is in', (
    tester,
  ) async {
    final requested = <String>[];
    final api = SettingsApi(MemoryStore(), (path, body) async {
      requested.add(path);
      // Scout has not been shared this Applet, so its directory does not
      // name it.
      if (path == '/api/bots/scout/applets') {
        return {'schemaVersion': 1, 'applets': <Object?>[]};
      }
      throw StateError(path);
    });
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: AppletChatScope(
            api: api,
            botId: 'scout',
            child: const AppletChatCard(appletId: 'todo.applet'),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(requested, ['/api/bots/scout/applets']);
    expect(find.byType(AppletViewerFrame), findsNothing);
    expect(
      find.text('This Applet has been deleted or is unavailable.'),
      findsOneWidget,
    );
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a live card keeps its frame through a failed refresh', (
    tester,
  ) async {
    var down = false;
    var tokens = 0;
    final api = SettingsApi(MemoryStore(), (path, body) async {
      if (down) throw const RequestFailure('FrockBot didn’t answer');
      if (path == '/api/bots/bot-1/applets') {
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
        return viewerToken();
      }
      throw StateError(path);
    });
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: AppletChatScope(
            api: api,
            botId: 'bot-1',
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
    expect(find.text('FrockBot didn’t answer.'), findsOneWidget);
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
    expect(find.text('FrockBot didn’t answer.'), findsNothing);
    expect(tokens, 1);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'a live card keeps its viewer when scrolled out of the viewport',
    (tester) async {
      var tokens = 0;
      final api = SettingsApi(MemoryStore(), (path, body) async {
        if (path == '/api/bots/bot-1/applets') {
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
          return viewerToken();
        }
        throw StateError(path);
      });
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: AppletChatScope(
              api: api,
              botId: 'bot-1',
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
    'an off-screen card stops refreshing and catches up when it returns',
    (tester) async {
      var reads = 0;
      final api = SettingsApi(MemoryStore(), (path, body) async {
        if (path == '/api/bots/bot-1/applets') {
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
        if (path.endsWith('/token')) return viewerToken();
        throw StateError(path);
      });
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: AppletChatScope(
              api: api,
              botId: 'bot-1',
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
        if (path == '/api/bots/bot-1/applets') {
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
          return viewerToken();
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
            botId: 'bot-1',
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
}
