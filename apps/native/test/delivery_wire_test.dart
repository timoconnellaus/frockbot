import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/chat_controller.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/shell/transcript_model.dart';

import 'widget_test.dart' show MemoryStore;

class WireApi extends NativeApi {
  WireApi(super.store);
  String status = 'completed';
  @override
  Future<Object?> request(
    String path, {
    Object? body,
    int limit = 512000,
    bool authenticated = true,
  }) async {
    final run = {
      'schemaVersion': 3,
      'runId': 'send-1',
      'admittedAt': '2026-09-07T23:49:45.395Z',
      'input': 'hi',
      'status': status,
      'events': [
        {
          'type': 'send/to-user',
          'payload': {'type': 'text', 'text': 'Hi!'},
        },
      ],
      'outcome': status == 'completed'
          ? {'type': 'completed', 'text': 'private final text'}
          : {
              'type': 'failed',
              'message':
                  'The model finished without sending a reply. Try again.',
              'text': 'private partial text',
            },
    };
    return path.endsWith('/send-1')
        ? {'schemaVersion': 1, 'run': run}
        : {
            'schemaVersion': 1,
            'runs': [run],
            'page': {'truncated': false},
          };
  }
}

void main() {
  test('real wire maps through transport and controller keep sends and failure reasons, never scratch text', () async {
    final store = MemoryStore();
    final api = WireApi(store);
    final controller = ChatController(
      transport: BackendChatTransport(api),
      store: store,
      userId: 'user-1',
      botId: 'test',
    );
    try {
      await controller.initialize();
      final completed = projectRuns(controller.runs);
      expect(
        completed
            .where((l) => l.role == LineRole.assistant)
            .map((l) => l.text)
            .join(),
        '',
      );
      expect(completed[1].sends.single.payload?['text'], 'Hi!');
      api.status = 'failed';
      await controller.refresh();
      final failed = projectRuns(controller.runs).last;
      expect(failed.text, '');
      expect(failed.notice, 'The model finished without sending a reply.');
      expect(failed.retry, LineRetry.resendTurn);
      controller.pending = const [PendingSend('send-1', 'do it')];
      await controller.checkDelivery();
      expect(projectRuns(controller.runs).last.notice, failed.notice);
    } finally {
      controller.dispose();
      api.close();
    }
  });

  test(
    'no ordinary assistant text renders, even from a cached decoded run',
    () {
      for (final status in [
        'running',
        'completed',
        'failed',
        'cancelled',
        'superseded',
      ]) {
        final lines = projectRuns([
          {
            'runId': 'r',
            'input': 'hi',
            'status': status,
            'events': [],
            'responseText': 'private final',
            'partialText': 'private partial',
          },
        ]);
        expect(lines.last.text, '', reason: status);
      }
    },
  );

  // Tim's report: a second message sent into a running Turn left the thread
  // saying nothing while the first one wound down, so two Turns of waiting
  // read as one Turn being slow. The send route does not answer until the Turn
  // it replaced has settled, and the transcript is only re-read when authority
  // says so — so the whole drain is over before a durable read could have
  // drawn it. The client draws the queued row itself.
  test(
    'a message that displaces a running Turn says so while it drains',
    () async {
      final store = MemoryStore();
      final transport = HeldSendTransport();
      final controller = ChatController(
        transport: transport,
        store: store,
        userId: 'user-1',
        botId: 'bot-1',
      );
      try {
        await controller.initialize();
        expect(controller.runningRunId, 'run-a');

        // The POST stays open, exactly as it does for the whole drain.
        final sending = controller.send('do this instead');
        await Future<void>.delayed(Duration.zero);

        final lines = projectRuns(controller.runs);
        expect(
          supersedeDrainState(lines, DateTime.now()),
          SupersedeDrainState.stopping,
        );
        // The person's own words are in the thread rather than beside it, and
        // the Turn they displaced is still the one a Stop would reach.
        expect(lines.map((line) => line.text), contains('do this instead'));
        expect(controller.visiblePendingText, isNull);
        expect(controller.runningRunId, 'run-a');
        expect(transport.observedSupersedes, ['run-a']);

        // A refusal takes the row back out: nothing in the thread claims a Turn
        // that was never admitted.
        transport.refuse();
        await sending;
        expect(
          supersedeDrainState(projectRuns(controller.runs), DateTime.now()),
          SupersedeDrainState.none,
        );
        expect(
          projectRuns(controller.runs).map((line) => line.text),
          isNot(contains('do this instead')),
        );
      } finally {
        controller.dispose();
      }
    },
  );
}

/// A transport whose send never answers, which is what superseding a running
/// Turn looks like from the client: the route holds the POST open until the
/// Turn it replaced has settled.
class HeldSendTransport implements ChatTransport {
  final _held = Completer<void>();
  final observedSupersedes = <String?>[];

  void refuse() => _held.completeError(const RequestFailure('refused', 409));

  @override
  Future<Map<String, dynamic>> page(String botId, {String? before}) async => {
    'runs': [
      {
        'runId': 'run-a',
        'admittedAt': '2026-09-05T01:00:00Z',
        'input': 'the first message',
        'status': 'running',
        'events': <Object>[],
      },
    ],
    'page': {'truncated': false},
  };

  @override
  Future<void> send(
    String botId,
    String id,
    String text, {
    String? supersedes,
  }) async {
    observedSupersedes.add(supersedes);
    await _held.future;
  }

  @override
  Future<Map<String, dynamic>?> lookup(
    String botId,
    String id, {
    bool fence = false,
  }) async => null;

  @override
  Future<Map<String, dynamic>> stop(
    String botId,
    String id,
    String commandId,
  ) async => throw UnimplementedError();
}
