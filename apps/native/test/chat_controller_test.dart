import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/chat_controller.dart';
import 'package:frockbot_native/client/page_cache.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/shell/transcript_model.dart';

import 'widget_test.dart' show MemoryStore;

class _StaleRunningPage implements ChatTransport {
  @override
  Future<Map<String, dynamic>> page(String botId, {String? before}) async => {
    'schemaVersion': 1,
    'runs': [run(runId: 'run-1')],
    'page': {'truncated': false},
  };

  @override
  Future<void> send(
    String botId,
    String id,
    String text, {
    String? retryOf,
  }) async {}

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

class _FixedPage implements ChatTransport {
  _FixedPage(this.runs);
  final List<Object> runs;

  @override
  Future<Map<String, dynamic>> page(String botId, {String? before}) async => {
    'schemaVersion': 1,
    'runs': runs,
    'page': {'truncated': false},
  };

  @override
  Future<void> send(
    String botId,
    String id,
    String text, {
    String? retryOf,
  }) async {}

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

Map<String, dynamic> send(int ordinal) => {
  'type': 'send/to-user',
  'payload': {'type': 'text', 'text': 'Send $ordinal'},
  'ordinal': ordinal,
};

class RecordingTransport implements ChatTransport {
  int pages = 0;
  @override
  Future<Map<String, dynamic>> page(String botId, {String? before}) async {
    pages += 1;
    return {
      'schemaVersion': 1,
      'runs': <Object>[],
      'page': {'truncated': false},
    };
  }

  @override
  Future<void> send(
    String botId,
    String id,
    String text, {
    String? retryOf,
  }) async {}

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

Map<String, dynamic> run({
  required String runId,
  String input = 'Hi',
  List<Object?> events = const [],
}) => {
  'schemaVersion': 1,
  'runId': runId,
  'admittedAt': '2026-09-22T00:00:00.000Z',
  'input': input,
  'status': 'running',
  'events': events,
};

void main() {
  test('a committed send renders without a transcript GET', () async {
    final store = MemoryStore();
    final transport = RecordingTransport();
    final controller = ChatController(
      transport: transport,
      store: store,
      userId: 'user-1',
      botId: 'bot-1',
    );
    await controller.initialize(liveChannel: true);
    expect(transport.pages, 0);
    await controller.applyFrame({
      'schemaVersion': 1,
      'type': 'state/snapshot',
      'epoch': '1',
      'cursor': '0',
      'reason': 'initial',
      'conversation': {
        'schemaVersion': 1,
        'runs': [
          run(runId: 'run-1', events: const []),
        ],
        'page': {'truncated': false},
      },
    });
    await controller.applyFrame({
      'schemaVersion': 1,
      'type': 'state/update',
      'epoch': '1',
      'cursor': '1',
      'kind': 'message',
      'entityId': 'msg:s:run-1:occ-1',
      'revision': 1,
      'payload': {
        'runId': 'run-1',
        'sessionId': 's',
        'occurrenceId': 'occ-1',
        'event': {
          'type': 'send/to-user',
          'payload': {'type': 'text', 'text': 'Hello from the Bot'},
          'ordinal': 0,
        },
      },
    });
    expect(transport.pages, 0);
    expect(controller.runs.single['events'], isNotEmpty);
    expect(controller.publicationCursor, '1');
    final cached = decodePageCache(store.values[pageCacheKey('user-1', 'bot-1')]);
    expect(cached?.cursor, '1');
    expect(cached?.epoch, '1');
    controller.dispose();
  });

  test('a late page cannot put a settled Turn back to work', () async {
    final store = MemoryStore();
    final controller = ChatController(
      transport: _StaleRunningPage(),
      store: store,
      userId: 'user-1',
      botId: 'bot-1',
    );
    await controller.applyFrame({
      'type': 'state/update',
      'epoch': '1',
      'cursor': '2',
      'kind': 'run-status',
      'entityId': 'run:run-1',
      'revision': 2,
      'payload': {
        'run': {
          ...run(runId: 'run-1'),
          'status': 'completed',
          'events': [
            {
              'type': 'send/to-user',
              'payload': {'type': 'text', 'text': 'Rendered this for you'},
              'ordinal': 0,
            },
          ],
        },
      },
    });
    expect(controller.activeRunId, isNull);
    await controller.refresh();
    expect(controller.runs.single['status'], 'completed');
    expect(controller.activeRunId, isNull);
    controller.dispose();
  });

  test('a late page cannot take back a send the live channel drew', () async {
    final store = MemoryStore();
    final controller = ChatController(
      transport: _StaleRunningPage(),
      store: store,
      userId: 'user-1',
      botId: 'bot-1',
    );
    await controller.applyFrame({
      'type': 'state/update',
      'epoch': '1',
      'cursor': '1',
      'kind': 'run-status',
      'entityId': 'run:run-1',
      'revision': 1,
      'payload': {'run': run(runId: 'run-1')},
    });
    await controller.applyFrame({
      'type': 'state/update',
      'epoch': '1',
      'cursor': '2',
      'kind': 'message',
      'entityId': 'msg:s:run-1:occ-1',
      'revision': 1,
      'payload': {
        'runId': 'run-1',
        'sessionId': 's',
        'occurrenceId': 'occ-1',
        'event': {
          'type': 'send/to-user',
          'payload': {'type': 'text', 'text': 'Still working on it'},
          'ordinal': 0,
        },
      },
    });
    // The page was read before that send was delivered, and lands after it.
    await controller.refresh();
    expect(controller.activeRunId, 'run-1');
    expect(controller.runs.single['events'], [
      {
        'type': 'send/to-user',
        'payload': {'type': 'text', 'text': 'Still working on it'},
        'ordinal': 0,
      },
    ]);
    controller.dispose();
  });

  test('a page that cut a long Turn short keeps only the sends after its own', () async {
    final truncated = {
      'type': 'run/events-truncated',
      'omittedInteractions': 3,
    };
    for (final (page, expected) in [
      // Send 0 was cut from the page, 3 is on it, 4 came after it.
      ([truncated, send(3)], [send(3), send(4)]),
      // Every send was cut, so none can be told apart from one that came after.
      ([truncated], <Object>[]),
    ]) {
      final controller = ChatController(
        transport: _FixedPage([run(runId: 'run-1', events: page)]),
        store: MemoryStore(),
        userId: 'user-1',
        botId: 'bot-1',
      );
      await controller.applyFrame({
        'type': 'state/update',
        'epoch': '1',
        'cursor': '1',
        'kind': 'run-status',
        'entityId': 'run:run-1',
        'revision': 1,
        'payload': {
          'run': run(runId: 'run-1', events: [send(0), send(3), send(4)]),
        },
      });
      await controller.refresh();
      expect(
        [
          for (final event in controller.runs.single['events'] as List)
            if ((event as Map)['type'] == 'send/to-user') event,
        ],
        expected,
      );
      controller.dispose();
    }
  });

  test('stale revisions and computer updates leave the transcript alone', () async {
    final store = MemoryStore();
    final controller = ChatController(
      transport: RecordingTransport(),
      store: store,
      userId: 'user-1',
      botId: 'bot-1',
    );
    await controller.initialize(liveChannel: true);
    await controller.applyFrame({
      'type': 'state/update',
      'epoch': '1',
      'cursor': '1',
      'kind': 'message',
      'entityId': 'msg:s:run-1:occ-1',
      'revision': 2,
      'payload': {
        'runId': 'run-1',
        'sessionId': 's',
        'occurrenceId': 'occ-1',
        'event': {
          'type': 'send/to-user',
          'payload': {'type': 'text', 'text': 'First'},
          'ordinal': 0,
        },
      },
    });
    await controller.applyFrame({
      'type': 'state/update',
      'epoch': '1',
      'cursor': '2',
      'kind': 'message',
      'entityId': 'msg:s:run-1:occ-1',
      'revision': 1,
      'payload': {
        'runId': 'run-1',
        'sessionId': 's',
        'occurrenceId': 'occ-1',
        'event': {
          'type': 'send/to-user',
          'payload': {'type': 'text', 'text': 'Stale'},
          'ordinal': 0,
        },
      },
    });
    await controller.applyFrame({
      'type': 'state/update',
      'epoch': '1',
      'cursor': '3',
      'kind': 'computer',
      'entityId': 'computer',
      'revision': 3,
      'payload': <String, Object?>{},
    });
    final events = controller.runs.single['events'] as List;
    expect((events.single as Map)['payload']['text'], 'First');
    expect(controller.invalidations.value, 0);
    controller.dispose();
  });

  test('repeated card sends keep one transcript row', () {
    final first = TranscriptLine(
      id: 'run-1:assistant',
      runId: 'run-1',
      role: LineRole.assistant,
      text: '',
      status: LineStatus.completed,
      at: '2026-09-22T00:00:00.000Z',
      sends: [
        SendPayloadLine({
          'type': 'card',
          'surfaceId': 'surface-1',
          'messages': const <Object>[],
        }),
      ],
    );
    final second = TranscriptLine(
      id: 'run-2:assistant',
      runId: 'run-2',
      role: LineRole.assistant,
      text: '',
      status: LineStatus.completed,
      at: '2026-09-22T00:00:01.000Z',
      sends: [
        SendPayloadLine({
          'type': 'card',
          'surfaceId': 'surface-1',
          'messages': const <Object>[],
        }),
      ],
    );
    final kept = dedupeCardSendsV1([first, second]);
    expect(kept.first.sends, hasLength(1));
    expect(kept.last.sends, isEmpty);
  });

  test('a replacement snapshot bumps cards and keeps pending commands', () async {
    final store = MemoryStore();
    store.values['chat/user-1/bot-1'] = jsonEncode({
      'version': 1,
      'draft': '',
      'pending': [
        {'id': 'pending-1', 'text': 'still sending'},
      ],
    });
    final transport = RecordingTransport();
    final controller = ChatController(
      transport: transport,
      store: store,
      userId: 'user-1',
      botId: 'bot-1',
    );
    await controller.initialize(liveChannel: true);
    expect(controller.draft, contains('still sending'));
    await controller.applyFrame({
      'schemaVersion': 1,
      'type': 'state/snapshot',
      'epoch': '2',
      'cursor': '4',
      'reason': 'epoch',
      'conversation': {
        'schemaVersion': 1,
        'runs': [run(runId: 'run-9')],
        'page': {'truncated': false},
      },
    });
    expect(controller.runs.single['runId'], 'run-9');
    expect(controller.publicationEpoch, '2');
    expect(controller.invalidations.value, 1);
    controller.dispose();
  });

  test('a card revision refreshes cards without a transcript GET', () async {
    final store = MemoryStore();
    final transport = RecordingTransport();
    final controller = ChatController(
      transport: transport,
      store: store,
      userId: 'user-1',
      botId: 'bot-1',
    );
    await controller.initialize(liveChannel: true);
    await controller.applyFrame({
      'type': 'state/update',
      'epoch': '1',
      'cursor': '1',
      'kind': 'card-revision',
      'entityId': 'card:surface-1',
      'revision': 2,
      'payload': {'surfaceId': 'surface-1', 'revision': 2},
    });
    expect(transport.pages, 0);
    expect(controller.invalidations.value, 1);
    controller.dispose();
  });
}
