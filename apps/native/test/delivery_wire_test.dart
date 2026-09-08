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
}
