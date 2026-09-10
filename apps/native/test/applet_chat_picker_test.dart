import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/applets/canvas.dart';
import 'package:frockbot_native/applets/chat_card.dart';
import 'package:frockbot_native/applets/picker.dart';
import 'package:frockbot_native/client/transport.dart';

import 'applets_test.dart' show applet;
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
}
