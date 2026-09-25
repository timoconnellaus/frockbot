import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/attachments.dart';
import 'package:frockbot_native/computer/card.dart';
import 'package:frockbot_native/computer/client.dart';
import 'package:frockbot_native/shell/semantics.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'computer_test.dart' show projection;
import 'settings_test.dart' show SettingsApi;
import 'widget_test.dart' show MemoryStore;

const _log = {
  'kind': 'document',
  'uploadId':
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'name': 'demonstration-0123456789abcdef.json',
  'mediaType': 'application/json',
  'bytes': 2048,
};
const _shot = {
  'kind': 'image',
  'uploadId':
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  'name': 'demonstration-0123456789abcdef-screenshot-1.jpg',
  'mediaType': 'image/jpeg',
  'bytes': 40000,
};

Map<String, Object?> _recording(DateTime startedAt) => {
  'version': 1,
  'id': '0123456789abcdef',
  'status': 'recording',
  'startedAt': startedAt.toUtc().toIso8601String(),
  'endsAt': startedAt
      .add(const Duration(minutes: 10))
      .toUtc()
      .toIso8601String(),
};

const _ready = {
  'version': 1,
  'id': '0123456789abcdef',
  'status': 'ready',
  'startedAt': '2026-09-24T10:00:00.000Z',
  'steps': 12,
  'attachments': [_log, _shot],
};

/// The projection of a Computer the person holds, with what they recorded.
Map<String, Object?> _held({Map<String, Object?>? demonstration}) => {
  ...projection(phase: 'human-control', snapshot: false),
  'controlLease': {
    'version': 1,
    'ownerId': 'human:1',
    'acquiredAt': '2026-09-24T10:00:00.000Z',
    'expiresAt': '2026-09-24T10:01:30.000Z',
  },
  'demonstration': ?demonstration,
};

/// A gateway that answers the projection it is given and records every
/// command, answering each with the receipt [receipt] names.
class _Gateway {
  Map<String, Object?> state;
  Map<String, Object?> Function(String type) receipt;
  final commands = <String>[];
  _Gateway(this.state, {Map<String, Object?> Function(String type)? receipt})
    : receipt =
          receipt ??
          ((type) => {
            'version': 1,
            'commandId': 'c',
            'type': type,
            'status': 'applied',
            'completedAt': '2026-09-24T10:00:00.000Z',
          });

  ComputerController controller() => ComputerController(
    SettingsApi(MemoryStore(), (path, body) async {
      if (body != null) {
        final type = (body as Map)['type'] as String;
        commands.add(type);
        return receipt(type);
      }
      return state;
    }),
    'bot-1',
  );
}

/// A widget the app names with a semantics identifier.
Finder _identified(String id) => find.byWidgetPredicate(
  (widget) => widget is Semantics && widget.properties.identifier == id,
);

void main() {
  group('a recording, as the projection says it', () {
    test('decodes one running and one kept', () {
      final started = DateTime.utc(2026, 9, 24, 10);
      final running = ComputerProjection.fromJson(
        _held(demonstration: _recording(started)),
      ).demonstration!;
      expect(running.recording, isTrue);
      expect(running.startedAt, started);
      expect(running.endsAt, started.add(const Duration(minutes: 10)));

      final kept = ComputerProjection.fromJson(_held(demonstration: _ready))
          .demonstration!;
      expect(kept.ready, isTrue);
      expect(kept.steps, 12);
      expect(kept.screenshots, 1);
      expect(kept.attachments.map((file) => file.name), [
        _log['name'],
        _shot['name'],
      ]);
      expect(ComputerProjection.fromJson(_held()).demonstration, isNull);
    });

    test('says how long it has run', () {
      expect(computerRecordingElapsedV1(const Duration(seconds: 42)), '0:42');
      expect(computerRecordingElapsedV1(const Duration(minutes: 10)), '10:00');
      expect(computerRecordingElapsedV1(const Duration(seconds: -3)), '0:00');
    });
  });

  group('the controller', () {
    test(
      'says why a recording command did nothing, until the next one',
      () async {
        final gateway = _Gateway(
          _held(),
          receipt: (type) => {
            'version': 1,
            'commandId': 'c',
            'type': type,
            'status': 'rejected',
            'completedAt': '2026-09-24T10:00:00.000Z',
            'failure': 'Nothing was recorded.',
          },
        );
        final controller = gateway.controller();
        await controller.stopRecording();
        expect(gateway.commands, ['stopDemonstration']);
        expect(controller.recordingNotice, 'Nothing was recorded.');
        // A projection read is not an answer to the person's gesture.
        await controller.read();
        expect(controller.recordingNotice, 'Nothing was recorded.');

        gateway.receipt = (type) => {
          'version': 1,
          'commandId': 'c',
          'type': type,
          'status': 'applied',
          'completedAt': '2026-09-24T10:00:00.000Z',
        };
        await controller.startRecording();
        expect(gateway.commands.last, 'startDemonstration');
        expect(controller.recordingNotice, isNull);
        controller.dispose();
      },
    );

    test('teaches the Bot with the kept files, in the words given', () async {
      final gateway = _Gateway(_held(demonstration: _ready));
      final controller = gateway.controller();
      await controller.read();
      final sent = <(String, List<MessageAttachment>)>[];
      expect(await controller.teach('Book a court'), isFalse);
      controller.onTeach = (text, files) async {
        sent.add((text, files));
        return true;
      };

      expect(await controller.teach('  Book a court '), isTrue);
      expect(await controller.teach(''), isTrue);
      expect(sent.map((entry) => entry.$1), [
        'Learn this: Book a court',
        'Learn this.',
      ]);
      expect(sent.first.$2.map((file) => file.uploadId), [
        _log['uploadId'],
        _shot['uploadId'],
      ]);
      controller.dispose();
    });

    testWidgets('holds control while the full window shows it, and not after', (
      tester,
    ) async {
      final gateway = _Gateway(_held());
      final controller = gateway.controller();
      controller.expanded = true;
      await controller.read();
      await tester.pump(computerControlHeartbeatV1);
      expect(gateway.commands, ['refreshControl']);

      await controller.close();
      final after = gateway.commands.length;
      await tester.pump(computerControlHeartbeatV1 * 3);
      expect(
        gateway.commands.skip(after).where((type) => type == 'refreshControl'),
        isEmpty,
      );
      controller.dispose();
    });
  });

  group('the full window', () {
    Future<ComputerController> viewer(
      WidgetTester tester,
      _Gateway gateway, {
      bool pushed = false,
      Future<bool> Function(String text, List<MessageAttachment> files)?
      onTeach,
    }) async {
      // Upright: a phone on its side shows the desktop and nothing else.
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(500, 900);
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final controller = gateway.controller()..onTeach = onTeach;
      await controller.read();
      final page = ComputerViewerPage(controller: controller, botName: 'Fox');
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: pushed
              ? Builder(
                  builder: (context) => Scaffold(
                    body: TextButton(
                      onPressed: () => Navigator.of(context)
                          .push(MaterialPageRoute<void>(builder: (_) => page)),
                      child: const Text('Open'),
                    ),
                  ),
                )
              : page,
        ),
      );
      if (pushed) {
        await tester.tap(find.text('Open'));
      }
      await tester.pumpAndSettle();
      return controller;
    }

    Future<void> close(
      WidgetTester tester,
      ComputerController controller,
    ) async {
      await tester.pumpWidget(const SizedBox.shrink());
      controller.dispose();
    }

    testWidgets('offers Record to the person holding control, and only them', (
      tester,
    ) async {
      final gateway = _Gateway(projection(snapshot: false));
      var controller = await viewer(tester, gateway);
      expect(_identified(ComputerIds.record), findsNothing);
      await close(tester, controller);

      gateway.state = _held();
      controller = await viewer(tester, gateway);
      expect(find.text('Record'), findsOneWidget);
      await tester.tap(find.text('Record'));
      await tester.pump();
      expect(gateway.commands, ['startDemonstration']);
      await close(tester, controller);
    });

    testWidgets('shows a recording running, and Stop', (tester) async {
      final gateway = _Gateway(
        _held(demonstration: _recording(DateTime.now())),
      );
      final controller = await viewer(tester, gateway);
      expect(find.text('Stop'), findsOneWidget);
      expect(_identified(ComputerIds.recording), findsOneWidget);
      expect(find.textContaining('Recording 0:0'), findsOneWidget);
      expect(find.text('Only the browser'), findsOneWidget);
      await tester.tap(find.text('Stop'));
      await tester.pump();
      expect(gateway.commands, ['stopDemonstration']);
      await close(tester, controller);
    });

    testWidgets('sends a kept recording to the Bot and goes back to it', (
      tester,
    ) async {
      final gateway = _Gateway(_held(demonstration: _ready));
      final sent = <String>[];
      final controller = await viewer(
        tester,
        gateway,
        pushed: true,
        onTeach: (text, files) async {
          sent.add(text);
          gateway.state = _held();
          return true;
        },
      );
      expect(find.text('Teach Fox this?'), findsOneWidget);
      expect(
        find.textContaining('12 steps and 1 screenshot from the browser'),
        findsOneWidget,
      );
      expect(find.textContaining('never recorded'), findsOneWidget);
      await tester.enterText(
        find.descendant(
          of: _identified(ComputerIds.teachName),
          matching: find.byType(TextField),
        ),
        'Book a squash court',
      );
      await tester.tap(find.text('Send to Fox'));
      await tester.pumpAndSettle();
      expect(sent, ['Learn this: Book a squash court']);
      expect(find.byType(ComputerViewerPage), findsNothing);
      await close(tester, controller);
    });

    testWidgets('discards a kept recording', (tester) async {
      final gateway = _Gateway(_held(demonstration: _ready));
      final controller = await viewer(tester, gateway);
      await tester.tap(find.text('Discard'));
      await tester.pump();
      expect(gateway.commands, ['discardDemonstration']);
      await close(tester, controller);
    });
  });
}
