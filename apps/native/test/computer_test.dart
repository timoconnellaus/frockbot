import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/computer/card.dart';
import 'package:frockbot_native/computer/client.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'settings_test.dart' show SettingsApi;
import 'widget_test.dart' show MemoryStore;

/// The shape `decodeComputerProjectionV1` produces, written by hand so the
/// Flutter side is pinned to the protocol's contract rather than to a fixture
/// the server could change without anything noticing.
Map<String, Object?> projection({
  String phase = 'ready',
  String message = 'Ready',
  bool viewer = true,
  bool snapshot = true,
  Map<String, Object?>? progress,
}) => {
  'version': 1,
  'botId': 'bot-1',
  'providerLabel': 'Fly',
  'phase': phase,
  'message': message,
  'progress': ?progress,
  if (viewer)
    'viewerSession': {
      'version': 1,
      'id': 'session-1',
      'url': 'https://vnc.example/vnc.html?path=x#password=secret&view_only=1',
      'expiresAt': '2026-09-05T02:00:00.000Z',
    },
  'screenshots': snapshot
      ? [
          {
            'version': 1,
            'path': 'screen.png',
            'capturedAt': '2026-09-05T01:00:00.000Z',
            'contentHash': 'abc',
            'url': 'https://shots.example/abc.png',
          },
        ]
      : <Object?>[],
};

void main() {
  group('the projection', () {
    test('carries the phase, the message and the minted session', () {
      final state = ComputerProjection.fromJson(projection());
      expect(state.phase, 'ready');
      expect(state.viewerUrl, contains('view_only=1'));
      expect(state.screenshots.single.contentHash, 'abc');
    });

    test('a phase this client does not know is refused whole', () {
      expect(
        () => ComputerProjection.fromJson(projection(phase: 'melted')),
        throwsA(isA<FormatException>()),
      );
    });

    test('a provisioning run names itself, and only a cold one promises', () {
      final cold = ComputerProjection.fromJson(
        projection(
          phase: 'provisioning',
          message: 'Starting',
          viewer: false,
          progress: {
            'version': 1,
            'kind': 'connect',
            'startedAt': '2026-09-05T01:00:00.000Z',
            'updatedAt': '2026-09-05T01:00:10.000Z',
            'index': 1,
            'total': 4,
            'steps': [
              {
                'version': 1,
                'id': 'boot',
                'label': 'Booting',
                'status': 'active',
              },
            ],
          },
        ),
      );
      expect(
        computerOpeningHeadingV1(cold),
        'Setting up your computer for the first time',
      );
      expect(computerColdProvisionV1(cold), isTrue);
      expect(cold.progress!.fraction, 0.25);
      expect(cold.progress!.activeLabel, 'Booting');
    });
  });

  group('live while working', () {
    test('a desktop that exists, watched, while the Bot is working', () {
      expect(
        computerStreamsV1(
          viewerUrl: 'https://vnc.example',
          phase: 'ready',
          expanded: false,
          turnRunning: true,
          onScreen: true,
        ),
        isTrue,
      );
    });

    test('a host mid-operation draws progress, never a frame', () {
      expect(
        computerStreamsV1(
          viewerUrl: 'https://vnc.example',
          phase: 'provisioning',
          expanded: true,
          turnRunning: true,
          onScreen: true,
        ),
        isFalse,
      );
    });

    test('a settled Turn keeps the connection for the grace window', () {
      bool since(Duration ago) => computerStreamsV1(
        viewerUrl: 'https://vnc.example',
        phase: 'ready',
        expanded: false,
        turnRunning: false,
        onScreen: true,
        sinceTurnEnded: ago,
      );
      expect(since(const Duration(seconds: 5)), isTrue);
      expect(since(const Duration(seconds: 30)), isFalse);
    });

    test('a card nobody is looking at holds nothing', () {
      expect(
        computerStreamsV1(
          viewerUrl: 'https://vnc.example',
          phase: 'ready',
          expanded: false,
          turnRunning: true,
          onScreen: false,
        ),
        isFalse,
      );
    });
  });

  group('the line under the screen', () {
    test('says live, or how old the photograph is', () {
      final now = DateTime.parse('2026-09-05T01:00:12.000Z');
      expect(computerScreenStatusLabelV1(streaming: true, now: now), 'Live');
      expect(
        computerScreenStatusLabelV1(
          streaming: false,
          capturedAt: DateTime.parse('2026-09-05T01:00:00.000Z'),
          now: now,
        ),
        'Snapshot · 12s ago',
      );
      expect(computerScreenStatusLabelV1(streaming: false, now: now), isNull);
    });

    test('the age is a whole unit at every scale', () {
      expect(computerSnapshotAgeLabelV1(const Duration(seconds: 5)), '5s ago');
      expect(computerSnapshotAgeLabelV1(const Duration(minutes: 9)), '9m ago');
      expect(computerSnapshotAgeLabelV1(const Duration(hours: 3)), '3h ago');
      expect(computerSnapshotAgeLabelV1(const Duration(days: 2)), '2d ago');
    });
  });

  test('control changes only the input fence on the one minted session', () {
    const url =
        'https://vnc.example/vnc.html?path=x#password=secret&view_only=1';
    final driving = viewerUrlForControlV1(url, true);
    expect(driving, contains('password=secret'));
    expect(driving, contains('view_only=0'));
    expect(Uri.parse(driving).path, Uri.parse(url).path);
    expect(viewerUrlForControlV1(driving, false), contains('view_only=1'));
  });

  group('the card', () {
    Future<ComputerController> open(
      WidgetTester tester,
      Map<String, Object?> answer,
    ) async {
      final store = MemoryStore();
      final controller = ComputerController(
        SettingsApi(store, (path, body) async => answer),
        'bot-1',
      );
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: Scaffold(body: ComputerCard(controller: controller)),
        ),
      );
      await tester.pump();
      return controller;
    }

    /// The card polls and ticks; a test that leaves either running fails the
    /// binding's own invariant rather than the assertion it came for.
    Future<void> close(
      WidgetTester tester,
      ComputerController controller,
    ) async {
      controller.dispose();
      await tester.pumpWidget(const SizedBox.shrink());
    }

    testWidgets('an account without one is silence, not an error', (
      tester,
    ) async {
      final store = MemoryStore();
      final controller = ComputerController(
        SettingsApi(store, (path, body) async {
          throw const RequestFailure('no computer here', 404);
        }),
        'bot-1',
      );
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: Scaffold(body: ComputerCard(controller: controller)),
        ),
      );
      await tester.pump();
      expect(find.byType(Image), findsNothing);
      expect(find.textContaining('computer'), findsNothing);
      await close(tester, controller);
    });

    testWidgets('a settled Computer shows its snapshot and says so', (
      tester,
    ) async {
      final controller = await open(tester, projection());
      await tester.pump();
      expect(find.textContaining('Snapshot ·'), findsOneWidget);
      await close(tester, controller);
    });

    testWidgets('a provisioning host draws its progress, not a frame', (
      tester,
    ) async {
      final controller = await open(
        tester,
        projection(
          phase: 'provisioning',
          message: 'Starting',
          viewer: false,
          snapshot: false,
          progress: {
            'version': 1,
            'kind': 'connect',
            'startedAt': '2026-09-05T01:00:00.000Z',
            'updatedAt': '2026-09-05T01:00:10.000Z',
            'index': 1,
            'total': 4,
            'steps': [
              {
                'version': 1,
                'id': 'boot',
                'label': 'Booting',
                'status': 'active',
              },
            ],
          },
        ),
      );
      await tester.pump();
      expect(
        find.text('Setting up your computer for the first time'),
        findsOneWidget,
      );
      expect(find.text(computerColdProvisionExpectationV1), findsOneWidget);
      expect(find.text('Booting'), findsOneWidget);
      await close(tester, controller);
    });
  });
}
