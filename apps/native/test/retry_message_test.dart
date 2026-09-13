import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/chat_controller.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/shell/transcript.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'widget_test.dart' show MemoryStore;

const originalAt = '2026-09-13T01:00:00.000Z';
Map<String, dynamic> attempt(
  String id, {
  String status = 'failed',
  String? retryOf,
  String? retriedBy,
  String? at,
}) => {
  'runId': id,
  'input': 'Please help',
  'status': status,
  'admittedAt': at ?? originalAt,
  'messageRunId': 'original',
  'messageAdmittedAt': originalAt,
  'retryOf': ?retryOf,
  'retriedBy': ?retriedBy,
  'events': <Object?>[],
  'outcome': {
    'type': status,
    'message': "This Bot couldn't finish its reply. Try again.",
  },
};

class RetryTransport implements ChatTransport {
  final rows = <String, Map<String, dynamic>>{'original': attempt('original')};
  final sent = <({String id, String? retryOf})>[];
  final lookups = <String>[];
  Completer<void>? gate;
  bool uncertain = false;
  bool admit = true;
  String nextStatus = 'completed';
  @override
  Future<Map<String, dynamic>> page(String botId, {String? before}) async => {
    'runs': rows.values.toList(),
    'page': {'truncated': false},
  };
  @override
  Future<void> send(
    String botId,
    String id,
    String text, {
    String? supersedes,
    String? retryOf,
  }) async {
    sent.add((id: id, retryOf: retryOf));
    if (gate != null) await gate!.future;
    if (!admit) throw const RequestFailure('not admitted');
    rows[id] = attempt(
      id,
      status: nextStatus,
      retryOf: retryOf,
      at: '2026-09-13T02:00:0${sent.length}.000Z',
    );
    rows[retryOf!] = {...rows[retryOf]!, 'retriedBy': id};
  }

  @override
  Future<Map<String, dynamic>?> lookup(
    String botId,
    String id, {
    bool fence = false,
  }) async {
    lookups.add('${fence ? 'fence' : 'lookup'}:$id');
    if (uncertain) throw const RequestFailure('offline');
    return rows[id];
  }

  @override
  Future<Map<String, dynamic>> stop(
    String botId,
    String id,
    String commandId,
  ) async => rows[id]!;
}

void main() {
  testWidgets('a retry of an older message advances the read boundary', (
    tester,
  ) async {
    final reports = <String?>[];
    final lines = projectRuns([
      attempt('original', retriedBy: 'retry'),
      {
        ...attempt(
          'other',
          status: 'completed',
          at: '2026-09-13T02:00:00.000Z',
        ),
        'messageRunId': 'other',
        'messageAdmittedAt': '2026-09-13T02:00:00.000Z',
        'events': [
          {
            'type': 'send/to-user',
            'ordinal': 0,
            'payload': {'type': 'text', 'text': 'Other reply'},
          },
        ],
      },
      attempt('retry', retryOf: 'original', at: '2026-09-13T03:00:00.000Z')
        ..['events'] = [
          {
            'type': 'send/to-user',
            'ordinal': 0,
            'payload': {'type': 'text', 'text': 'Partial reply before failure'},
          },
        ],
    ]);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: TranscriptView(
            lines: lines,
            loading: false,
            hasEarlier: false,
            onRefresh: ({older = false}) async {},
            onOpenRun: (_) {},
            onReadLatest: reports.add,
            focusRunId: 'original',
            storageKey: 'retry-read',
          ),
        ),
      ),
    );
    await tester.pump();
    expect(reports.last, 'retry:failed');
    expect(
      find.ancestor(
        of: find.byKey(const ValueKey('row:original:user')),
        matching: find.byWidgetPredicate(
          (widget) => widget is Container && widget.key is GlobalKey,
        ),
      ),
      findsOneWidget,
    );
  });

  test('a queued retry uses the attempt time for its stopping notice', () {
    final lines = projectRuns([
      attempt(
        'retry',
        status: 'running',
        retryOf: 'original',
        at: '2026-09-13T03:00:00.000Z',
      )..['queued'] = true,
    ]);
    expect(
      supersedeDrainState(lines, DateTime.parse('2026-09-13T03:00:01.000Z')),
      SupersedeDrainState.stopping,
    );
  });

  test(
    'retry persists its target, preserves the draft and blocks duplicate taps',
    () async {
      final store = MemoryStore();
      final transport = RetryTransport()
        ..gate = Completer<void>()
        ..nextStatus = 'failed';
      var id = 0;
      final c = ChatController(
        transport: transport,
        store: store,
        userId: 'u',
        botId: 'b',
        nextId: () => 'retry-${++id}',
      );
      addTearDown(c.dispose);
      await c.initialize();
      await c.saveDraft('Unrelated draft');
      final retrying = c.retryRun('original');
      await Future<void>.delayed(Duration.zero);
      expect(transport.sent, [(id: 'retry-1', retryOf: 'original')]);
      final saved = jsonDecode(store.values[c.key]!);
      expect(saved['pending'].single['retryOf'], 'original');
      expect(saved['pending'].single['messageRunId'], 'original');
      expect(c.draft, 'Unrelated draft');
      expect(c.visiblePendingText, isNull);
      expect(
        projectRuns(c.runs).where((l) => l.role == LineRole.user).single.id,
        'original:user',
      );
      await c.retryRun('original');
      expect(transport.sent.length, 1);
      transport.gate!.complete();
      await retrying;
      expect(c.pending, isEmpty);
      final failed = projectRuns(c.runs)
          .where((l) => l.role == LineRole.user)
          .single;
      expect(failed.runId, 'retry-1');
      expect(failed.status, LineStatus.error);
      expect(failed.failureMessageId, 'retry-1:failed');
      await c.retryRun('original');
      expect(transport.sent.length, 1);
      transport.gate = null;
      transport.nextStatus = 'completed';
      await c.retryRun('retry-1');
      expect(transport.sent.last, (id: 'retry-2', retryOf: 'retry-1'));
      expect(c.draft, 'Unrelated draft');
      final completed = projectRuns(c.runs)
          .where((l) => l.role == LineRole.user)
          .single;
      expect(completed.id, 'original:user');
      expect(completed.status, LineStatus.completed);
      expect(completed.retry, isNull);
    },
  );

  test('failed local persistence makes no retry call and leaves the original actionable', () async {
    final store = MemoryStore();
    final transport = RetryTransport();
    final c = ChatController(
      transport: transport,
      store: store,
      userId: 'u',
      botId: 'b',
    );
    addTearDown(c.dispose);
    await c.initialize();
    await c.saveDraft('Keep this');
    store.fail = true;
    await c.retryRun('original');
    expect(transport.sent, isEmpty);
    expect(c.pending, isEmpty);
    expect(c.draft, 'Keep this');
    expect(projectRuns(c.runs).first.retry, LineRetry.resendTurn);
  });

  test('uncertain retry survives reload and a fence restores its action, not its text', () async {
    final store = MemoryStore();
    final transport = RetryTransport()..uncertain = true;
    store.values['chat/u/b'] = jsonEncode({
      'version': 1,
      'draft': 'Keep this',
      'pending': [
        const PendingSend(
          'retry-1',
          'Please help',
          retryOf: 'original',
          messageRunId: 'original',
          messageAdmittedAt: originalAt,
        ).toJson(),
      ],
    });
    final c = ChatController(
      transport: transport,
      store: store,
      userId: 'u',
      botId: 'b',
    );
    addTearDown(c.dispose);
    await c.initialize();
    expect(c.pending.single.retryOf, 'original');
    expect(c.visiblePendingText, isNull);
    expect(projectRuns(c.runs).where((l) => l.role == LineRole.user).length, 1);
    await c.retryRun('original');
    expect(transport.sent, isEmpty);
    transport.uncertain = false;
    await c.checkDelivery();
    expect(transport.lookups, contains('fence:retry-1'));
    expect(c.pending, isEmpty);
    expect(c.draft, 'Keep this');
    expect(projectRuns(c.runs).first.retry, LineRetry.resendTurn);
  });

  test(
    'a retry-only page and later history keep one stable input and prior sends',
    () {
      final retry = attempt(
        'retry-1',
        retryOf: 'original',
        at: '2026-09-13T02:00:00.000Z',
      );
      final firstPage = projectRuns([retry]);
      expect(
        firstPage.where((l) => l.role == LineRole.user).single.id,
        'original:user',
      );
      final root = attempt('original', retriedBy: 'retry-1')
        ..['events'] = [
          {
            'type': 'send/to-user',
            'ordinal': 0,
            'payload': {'type': 'text', 'text': 'Already said'},
          },
        ];
      final merged = orderTranscript(projectRuns([root, retry]), '');
      expect(merged.first.id, 'original:user');
      expect(merged.where((l) => l.role == LineRole.user).length, 1);
      expect(
        merged.expand((l) => l.sends).single.payload?['text'],
        'Already said',
      );
      expect(
        merged.where((l) => l.role == LineRole.assistant && l.notice != null),
        isEmpty,
      );
      expect(merged.first.retry, LineRetry.resendTurn);
    },
  );

  testWidgets(
    'failure is on the user bubble and clears with an admitted retry',
    (tester) async {
      Future<void> draw(List<Map<String, dynamic>> rows) async {
        await tester.pumpWidget(
          MaterialApp(
            theme: FrockTheme.theme(Brightness.dark),
            home: Scaffold(
              body: TranscriptView(
                lines: projectRuns(rows),
                loading: false,
                hasEarlier: false,
                storageKey: 'retry',
                onRefresh: ({bool older = false}) async {},
                onOpenRun: (_) {},
                onRetryTurn: (_) {},
              ),
            ),
          ),
        );
        await tester.pump(const Duration(milliseconds: 250));
      }

      await draw([attempt('original')]);
      expect(find.text('Please help'), findsOneWidget);
      expect(find.text('Try again'), findsOneWidget);
      expect(find.byKey(const ValueKey('original:failed')), findsNothing);
      final bubble = find.byKey(const ValueKey('original:user'));
      expect(
        find.descendant(of: bubble, matching: find.text('Try again')),
        findsOneWidget,
      );
      await draw([
        attempt('original', retriedBy: 'retry-1'),
        attempt(
          'retry-1',
          status: 'running',
          retryOf: 'original',
          at: '2026-09-13T02:00:00.000Z',
        ),
      ]);
      expect(find.text('Please help'), findsOneWidget);
      expect(find.text('Try again'), findsNothing);
      await draw([
        attempt('original', retriedBy: 'retry-1'),
        attempt(
          'retry-1',
          status: 'completed',
          retryOf: 'original',
          at: '2026-09-13T02:00:00.000Z',
        ),
      ]);
      expect(find.text('Please help'), findsOneWidget);
      expect(find.text("This Bot couldn't finish its reply."), findsNothing);
    },
  );
}
