import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/chat_controller.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/shell/transcript_model.dart';

import 'widget_test.dart' show MemoryStore;

class WireApi extends NativeApi {
  WireApi(super.store);
  String status = 'completed';
  String? retryOf;
  Map<String, Object?>? sentCommand;
  @override
  Future<Object?> request(
    String path, {
    Object? body,
    int limit = 512000,
    bool authenticated = true,
  }) async {
    if (body is Map<String, Object?>) {
      sentCommand = body;
      return {'schemaVersion': 1, 'runId': body['commandId']};
    }
    final run = {
      'schemaVersion': 4,
      'runId': 'send-1',
      'admittedAt': '2026-09-07T23:49:45.395Z',
      'messageRunId': retryOf ?? 'send-1',
      'messageAdmittedAt': '2026-09-07T23:49:45.395Z',
      'retryOf': ?retryOf,
      'input': 'hi',
      'status': status,
      'canRetry': status == 'failed',
      'events': [
        {
          'type': 'send/to-user',
          'payload': {'type': 'text', 'text': 'Hi!'},
          'ordinal': 0,
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
        ? {'schemaVersion': 1, 'state': 'terminal', 'run': run}
        : {
            'schemaVersion': 1,
            'runs': [run],
            'page': {'truncated': false},
          };
  }
}

void main() {
  test(
    'the wire carries retry intent and preserves its message identity',
    () async {
      final api = WireApi(MemoryStore())..retryOf = 'original';
      addTearDown(api.close);
      final transport = BackendChatTransport(api);
      await transport.send('bot', 'retry-command', 'hi', retryOf: 'original');
      expect(api.sentCommand, {
        'schemaVersion': 1,
        'commandId': 'retry-command',
        'text': 'hi',
        'retryOf': 'original',
      });
      final run = await transport.lookup('bot', 'send-1');
      expect(run!['messageRunId'], 'original');
      expect(projectRuns([run]).first.id, 'original:user');
      await transport.send('bot', 'ordinary', 'hi');
      expect(api.sentCommand!.containsKey('retryOf'), isFalse);
    },
  );

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
      final failed = projectRuns(controller.runs)
          .firstWhere((line) => line.role == LineRole.user);
      expect(failed.text, 'hi');
      expect(failed.notice, 'The model finished without sending a reply.');
      expect(failed.retry, LineRetry.resendTurn);
      controller.pending = const [PendingSend('send-1', 'do it')];
      await controller.checkDelivery();
      expect(
        projectRuns(controller.runs)
            .firstWhere((line) => line.role == LineRole.user)
            .notice,
        failed.notice,
      );
    } finally {
      controller.dispose();
      api.close();
    }
  });

  test(
    'no ordinary assistant text renders, even from a cached decoded run',
    () {
      for (final status in ['running', 'completed', 'failed', 'cancelled']) {
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

  // A message sent into a running Turn joins the thread at once, queued until
  // the Bot reads it at its next step. The running Turn is untouched: it is
  // still the one a Stop would reach, and it keeps working.
  test('a message sent into a running Turn waits in the thread', () async {
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

      final sending = controller.send('also check B');
      await Future<void>.delayed(Duration.zero);

      final lines = projectRuns(controller.runs);
      final waiting = lines.firstWhere((line) => line.text == 'also check B');
      expect(waiting.role, LineRole.user);
      expect(
        controller.runs.firstWhere(
          (run) => run['input'] == 'also check B',
        )['queued'],
        isTrue,
      );
      expect(controller.visiblePending, isNull);
      expect(controller.runningRunId, 'run-a');

      // A refusal takes the row back out: nothing in the thread claims a
      // message that was never admitted.
      transport.refuse();
      await sending;
      expect(
        projectRuns(controller.runs).map((line) => line.text),
        isNot(contains('also check B')),
      );
    } finally {
      controller.dispose();
    }
  });

  // One beat earlier: the message ahead has been sent but its own POST has
  // not answered, so there is no durable run yet. The composer is open either
  // way, and the second message waits in the thread just the same.
  test('a message sent behind one still being delivered waits too', () async {
    final store = MemoryStore();
    final transport = HeldSendTransport(runs: const []);
    final controller = ChatController(
      transport: transport,
      store: store,
      userId: 'user-1',
      botId: 'bot-1',
    );
    try {
      await controller.initialize();
      expect(controller.runningRunId, isNull);

      unawaited(controller.send('first'));
      await Future<void>.delayed(Duration.zero);
      unawaited(controller.send('second'));
      await Future<void>.delayed(Duration.zero);

      expect(
        projectRuns(controller.runs).map((line) => line.text),
        contains('second'),
      );
      expect(
        controller.runs.firstWhere((run) => run['input'] == 'second')['queued'],
        isTrue,
      );
    } finally {
      controller.dispose();
    }
  });
}

/// A transport whose send never answers, so a test can look at the thread
/// while the message is still on its way.
class HeldSendTransport implements ChatTransport {
  HeldSendTransport({List<Map<String, dynamic>>? runs})
    : runs = runs ?? _oneRunning;

  static const _oneRunning = [
    {
      'runId': 'run-a',
      'admittedAt': '2026-09-05T01:00:00Z',
      'input': 'the first message',
      'status': 'running',
      'events': <Object>[],
    },
  ];

  final List<Map<String, dynamic>> runs;
  final _held = Completer<void>();

  void refuse() => _held.completeError(const RequestFailure('refused', 409));

  @override
  Future<Map<String, dynamic>> page(String botId, {String? before}) async => {
    'runs': runs,
    'page': {'truncated': false},
  };

  @override
  Future<void> send(
    String botId,
    String id,
    String text, {
    String? retryOf,
  }) async {
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
