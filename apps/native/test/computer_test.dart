import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
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
            'capturedAt': '2026-09-05T01:00:00.000Z',
            'contentHash': captureHashV1,
            // The authority's own spelling: a path on this account's
            // authenticated origin, never an address anything anonymous can
            // read. `computer/bot.ts` builds exactly this.
            'url': capturePathV1,
          },
        ]
      : <Object?>[],
};

/// The frame's SHA-256, which is also its address.
const captureHashV1 =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

/// The Bot's frame route, as the projection names it.
const capturePathV1 = '/api/bots/bot-1/computer/frame/$captureHashV1';

/// One decodable picture: a 1×1 PNG, which is what the route answers with.
final capturePngV1 = base64Decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA'
  '60e6kgAAAABJRU5ErkJggg==',
);

/// A gateway that answers the projection, and answers the frame's bytes the
/// way the frame route does — to the client that carries the session, and to
/// nothing else.
class CaptureApi extends SettingsApi {
  CaptureApi(super.store, super.handler, {this.picture});

  /// Absent stands for the route refusing this read.
  final Uint8List? picture;
  final reads = <String>[];

  @override
  Future<Uint8List> bytes(String path, {int limit = 4000000}) async {
    reads.add(path);
    final held = picture;
    if (held == null) {
      throw const RequestFailure('Please sign in again.', 401);
    }
    return held;
  }
}

void main() {
  test(
    'reads the Computer again when its notice arrives, until disposed',
    () async {
      var reads = 0;
      final api = CaptureApi(MemoryStore(), (path, body) async {
        if (path == '/api/bots/bot-1/computer') reads += 1;
        return projection(viewer: false);
      });
      final notices = ValueNotifier(0);
      final controller = ComputerController(api, 'bot-1', notices: notices);

      notices.value++;
      await pumpEventQueue();
      expect(reads, 1);
      expect(controller.state.screenshots.single.url, capturePathV1);

      controller.dispose();
      notices.value++;
      await pumpEventQueue();
      expect(reads, 1);
      notices.dispose();
    },
  );

  group('Bot Computer activity', () {
    Map<String, Object?> run(Object call, {String status = 'running'}) => {
      'status': status,
      'events': [
        {'type': 'tool/call', 'call': call},
      ],
    };

    test('recognizes native and dynamic Computer calls in a live Turn', () {
      expect(
        botComputerRunningV1([
          run({'name': 'computer_browser'}),
        ]),
        isTrue,
      );
      expect(
        botComputerRunningV1([
          run({
            'name': 'call_dynamic_tool',
            'input': {'namespace': 'frockbot', 'toolName': 'computer_exec'},
          }),
        ]),
        isTrue,
      );
    });

    test('ignores finished Turns and unrelated tools', () {
      expect(
        botComputerRunningV1([
          run({'name': 'computer_exec'}, status: 'completed'),
          run({'name': 'memory_search'}),
        ]),
        isFalse,
      );
    });
  });

  group('the projection', () {
    test('carries the phase, the message and the minted session', () {
      final state = ComputerProjection.fromJson(projection());
      expect(state.phase, 'ready');
      expect(state.viewerUrl, contains('view_only=1'));
      expect(state.screenshots.single.contentHash, captureHashV1);
    });

    test('a phase this client does not know is refused whole', () {
      expect(
        () => ComputerProjection.fromJson(projection(phase: 'melted')),
        throwsA(isA<FormatException>()),
      );
    });

    test('waking an existing computer does not claim first-time setup', () {
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
      expect(computerOpeningHeadingV1(cold), 'Preparing computer…');
      expect(computerColdProvisionV1(cold), isFalse);
      expect(cold.progress!.fraction, 0.25);
      expect(cold.progress!.activeLabel, 'Booting');
    });
  });

  test('setup copy follows the provider operation', () {
    for (final kind in ['provision', 'update']) {
      for (final resumed in [false, true]) {
        final state = ComputerProjection.fromJson(
          projection(
            phase: 'provisioning',
            progress: {
              'kind': 'connect',
              'index': 1,
              'total': 4,
              'steps': <Object?>[],
              'provisioning': {'kind': kind, 'resumed': resumed},
            },
          ),
        );
        expect(
          computerOpeningHeadingV1(state),
          kind == 'update'
              ? 'Updating your computer'
              : resumed
              ? 'Resuming computer setup'
              : 'Setting up your computer for the first time',
        );
        expect(computerColdProvisionV1(state), kind == 'provision' && !resumed);
      }
    }
  });

  test('running status does not depend on opening a viewer', () {
    for (final phase in computerPhasesV1) {
      final state = ComputerProjection.fromJson(
        projection(phase: phase, viewer: false),
      );
      expect(
        state.running,
        ['ready', 'taking-control', 'human-control'].contains(phase),
      );
    }
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
    test('says live, or how old the photograph is, and always says one', () {
      final now = DateTime.parse('2026-09-05T01:00:12.000Z');
      expect(
        computerCardStatusV1(
          streaming: true,
          unconfigured: false,
          message: 'browsing github.com',
          now: now,
        ),
        'Live · browsing github.com',
      );
      expect(
        computerCardStatusV1(
          streaming: false,
          unconfigured: false,
          message: 'Ready to start',
          capturedAt: DateTime.parse('2026-09-05T01:00:00.000Z'),
          now: now,
        ),
        'Ready · captured 12s ago',
      );
      expect(
        computerCardStatusV1(
          streaming: false,
          unconfigured: false,
          message: 'Ready to start',
          now: now,
        ),
        'Ready to start',
      );
      expect(
        computerCardStatusV1(
          streaming: false,
          unconfigured: true,
          message: 'This Bot has no computer.',
          now: now,
        ),
        'No computer',
      );
    });

    test('a refusal is said even when a photograph is on the card', () {
      final now = DateTime.parse('2026-09-05T01:00:12.000Z');
      expect(
        computerCardStatusV1(
          streaming: false,
          unconfigured: false,
          message: 'Ready to start',
          failure: 'The Computer host answered 503',
          capturedAt: DateTime.parse('2026-09-05T01:00:00.000Z'),
          now: now,
        ),
        'The Computer host answered 503',
      );
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

  /// Both surfaces that say one line about the Computer — the card's status
  /// row and the full window's subtitle — ask the controller for it, so a
  /// refusal cannot be silent on one of them and said on the other.
  test('a Computer that refused says that, not the phase it was in', () async {
    var reads = 0;
    final controller = ComputerController(
      SettingsApi(MemoryStore(), (path, body) async {
        if (path.endsWith('/commands')) {
          throw const RequestFailure('The Computer host answered 503', 503);
        }
        if (reads++ > 0) {
          throw const RequestFailure('The Computer host answered 503', 503);
        }
        return projection(message: 'Ready to start');
      }),
      'bot-1',
    );
    await controller.read();
    expect(controller.said, 'Ready to start');
    await controller.takeControl();
    expect(controller.state.message, 'Ready to start');
    expect(controller.said, 'The Computer host answered 503');
    controller.dispose();
  });

  /// The seam the capture actually crosses. The projection carries a path on
  /// this account's own authenticated origin, so reading it is a request this
  /// client makes with its session on it — not a URL handed to an anonymous
  /// image loader, which is what drew a placeholder over a capture that was
  /// there.
  group('the capture read', () {
    test('resolves the projection path and signs it', () async {
      final store = MemoryStore();
      store.values['session'] = jsonEncode({
        'schemaVersion': 1,
        'sessionId': 'session-1',
        'userId': 'user-1',
        'expiresAt': '2026-09-09T00:00:00.000Z',
        'sessionToken': 'token-1',
      });
      final asked = <http.BaseRequest>[];
      final api = NativeApi(
        store,
        client: MockClient((request) async {
          asked.add(request);
          return http.Response.bytes(
            capturePngV1,
            200,
            headers: {'content-type': 'image/png'},
          );
        }),
      );

      final bytes = await api.bytes(capturePathV1);

      expect(bytes, capturePngV1);
      expect(asked.single.method, 'GET');
      expect(asked.single.url.path, capturePathV1);
      expect(asked.single.url.query, isEmpty);
      expect(asked.single.headers['authorization'], 'Bearer token-1');
      api.close();
    });

    test('a refused capture is a refusal, not a decoded picture', () async {
      final store = MemoryStore();
      final api = NativeApi(
        store,
        client: MockClient(
          (request) async => http.Response('{"error":"Unauthorized"}', 401),
        ),
      );

      await expectLater(
        api.bytes(capturePathV1),
        throwsA(isA<RequestFailure>()),
      );
      api.close();
    });
  });

  group('the card', () {
    Future<(ComputerController, CaptureApi)> card(
      WidgetTester tester,
      Map<String, Object?> answer, {
      Uint8List? picture,
    }) async {
      final api = CaptureApi(
        MemoryStore(),
        (path, body) async => answer,
        picture: picture,
      );
      final controller = ComputerController(api, 'bot-1');
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: Scaffold(body: ComputerCard(controller: controller)),
        ),
      );
      await tester.pump();
      return (controller, api);
    }

    Future<ComputerController> open(
      WidgetTester tester,
      Map<String, Object?> answer,
    ) async => (await card(tester, answer, picture: capturePngV1)).$1;

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

    /// The Computer host being down is not the same answer as the Bot never
    /// having had a Computer: the first is a card that stays, says what
    /// refused, and opens.
    Future<ComputerController> refused(
      WidgetTester tester,
      Object error,
    ) async {
      final store = MemoryStore();
      final controller = ComputerController(
        SettingsApi(store, (path, body) async => throw error),
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

    testWidgets('a host that cannot be reached keeps the card and says so', (
      tester,
    ) async {
      final controller = await refused(
        tester,
        const RequestFailure('The Computer host answered 503', 500),
      );
      // Available, because the shell registers the panel entry from it: a
      // dependency being down must not read as a Bot with no Computer.
      expect(controller.available, isTrue);
      expect(
        find.text('The Computer host answered 503'),
        findsAtLeastNWidgets(1),
      );
      expect(find.text('No computer'), findsNothing);
      // And it opens, because the full window is where the way out lives.
      expect(
        tester.widget<InkWell>(find.byType(InkWell).first).onTap,
        isNotNull,
      );
      await close(tester, controller);
    });

    testWidgets('a read that answers nothing at all says that', (tester) async {
      final controller = await refused(tester, Exception('socket closed'));
      expect(controller.available, isTrue);
      expect(find.text('Couldn’t read the computer.'), findsAtLeastNWidgets(1));
      await close(tester, controller);
    });

    testWidgets(
      'the full window says what refused, and retries the connection',
      (tester) async {
        final store = MemoryStore();
        final commands = <Object?>[];
        final controller = ComputerController(
          SettingsApi(store, (path, body) async {
            if (body != null) commands.add((body as Map)['type']);
            throw const RequestFailure('The Computer host answered 503', 500);
          }),
          'bot-1',
        );
        await controller.read();
        await tester.pumpWidget(
          MaterialApp(
            theme: FrockTheme.theme(Brightness.dark),
            home: ComputerViewerPage(controller: controller),
          ),
        );
        await tester.pump();
        expect(find.text('No computer'), findsOneWidget);
        expect(find.text('Try again'), findsOneWidget);
        expect(
          find.text('The Computer host answered 503'),
          findsAtLeastNWidgets(1),
        );
        await tester.tap(find.text('Try again'));
        await tester.pump();
        expect(commands, ['connect']);
        await close(tester, controller);
      },
    );

    testWidgets('a settled Computer shows its snapshot and says so', (
      tester,
    ) async {
      final controller = await open(tester, projection());
      await tester.pump();
      expect(find.textContaining('Ready · captured'), findsOneWidget);
      await close(tester, controller);
    });

    /// The capture is on the authenticated origin. Drawing it is a read this
    /// client signs, and what lands on the card is the picture — not the
    /// "Computer" placeholder an anonymous image loader falls back to when the
    /// route answers 401.
    testWidgets('a filed capture is drawn from authenticated bytes', (
      tester,
    ) async {
      final (controller, api) = await card(
        tester,
        projection(),
        picture: capturePngV1,
      );
      await tester.pump();

      expect(api.reads, [capturePathV1]);
      expect(find.byIcon(Icons.desktop_windows_outlined), findsNothing);
      expect(find.text('Computer'), findsNothing);
      final drawn = tester.widget<Image>(find.byType(Image));
      expect(drawn.image, isA<MemoryImage>());
      await close(tester, controller);
    });

    testWidgets('the same capture is read once, however often the card polls', (
      tester,
    ) async {
      final (controller, api) = await card(
        tester,
        projection(),
        picture: capturePngV1,
      );
      await tester.pump();
      for (var poll = 0; poll < 3; poll += 1) {
        await controller.read();
        await tester.pump();
      }

      expect(api.reads, [capturePathV1]);
      await close(tester, controller);
    });

    testWidgets('a capture the route refuses leaves the card saying so', (
      tester,
    ) async {
      final (controller, api) = await card(tester, projection());
      await tester.pump();

      expect(find.byType(Image), findsNothing);
      expect(
        find.text('Couldn’t load the computer screenshot.'),
        findsOneWidget,
      );
      // And it asks once. The card repaints every second; a refusal the next
      // paint retried would be a request a second at a route that is refusing.
      for (var poll = 0; poll < 3; poll += 1) {
        await controller.read();
        await tester.pump(const Duration(seconds: 1));
      }
      expect(api.reads, [capturePathV1]);
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
      expect(find.text('Preparing computer…'), findsOneWidget);
      expect(find.text(computerColdProvisionExpectationV1), findsNothing);
      expect(find.text('Booting'), findsOneWidget);
      await close(tester, controller);
    });
  });
}
