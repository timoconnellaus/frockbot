/// The thread's own rules: how a Turn is ordered, and what the working row says
/// while a supersede drains.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/material.dart';
import 'package:frockbot_native/shell/transcript.dart';
import 'package:frockbot_native/theme/frock_theme.dart';
import 'package:frockbot_native/theme/states.dart';

/// How the thread reads, one line per row, in the order it is drawn.
List<String> thread(List<TranscriptLine> lines) => [
  for (final line in orderTranscript(lines, '2026-09-05T12:30:00.000Z')) ...[
    for (final send in line.sends)
      '${line.role.name}: ${send.payload?['text']}',
    if (line.voiceCall != null) 'system: ${voiceCallTitle(line.voiceCall!)}',
    if (line.text.isNotEmpty || line.notice != null)
      '${line.role.name}: ${line.text.isNotEmpty ? line.text : line.notice}',
  ],
];

Map<String, dynamic> run({
  required String runId,
  String input = '',
  String status = 'completed',
  String admittedAt = '2026-09-05T12:19:00.000Z',
  String? responseText,
  String? sentText,
  List<Object?> events = const [],
  bool queued = false,
  String? failure,
}) => {
  'runId': runId,
  'input': input,
  'status': status,
  'canRetry': status == 'failed' && input.isNotEmpty,
  'admittedAt': admittedAt,
  'events': [
    if (sentText != null)
      {
        'type': 'send/to-user',
        'payload': {'type': 'text', 'text': sentText},
        'ordinal': 0,
      },
    ...events,
  ],
  'responseText': ?responseText,
  if (queued) 'queued': true,
  // A failed Turn's reason reaches a client on the run's `outcome`, which is
  // where the projection puts the sentence it wrote for the person. The stored
  // `failure` is a provider diagnostic and never crosses the wire, so a
  // fixture that carried one would be testing a shape the product cannot
  // receive.
  if (status != 'running')
    'outcome': {'type': status, 'message': ?failure, 'text': ?responseText},
};

const haiku = 'Soft wool on green hills';
const answer = 'Got it — both messages arrived.';

TranscriptLine line({
  required String runId,
  required LineRole role,
  String text = '',
  String? at,
  LineStatus status = LineStatus.completed,
}) => TranscriptLine(
  id: '$runId:${role.name}',
  runId: runId,
  role: role,
  text: text,
  at: at,
  status: status,
);

/// Whether [finder] overlaps the thread viewport. A row the cache has built
/// but not scrolled into view is still in the tree.
bool _onScreen(WidgetTester tester, Finder finder) {
  if (finder.evaluate().isEmpty) return false;
  final viewport = find.descendant(
    of: find.byType(ListView),
    matching: find.byType(Viewport),
  );
  if (viewport.evaluate().isEmpty) return false;
  return tester.getRect(finder.first).overlaps(tester.getRect(viewport.first));
}

void main() {
  testWidgets(
    'reports read while the newest delivered message is on screen, not only '
    'while the thread is pinned to its end',
    (tester) async {
      final reports = <String?>[];
      final newest = <String?>[];
      final lines = [
        TranscriptLine(
          id: 'run-old:send:0',
          runId: 'run-old',
          role: LineRole.assistant,
          // Tall enough to fill the viewport on its own, so the far end of the
          // thread is genuinely a screen with no newest message on it rather
          // than one that depends on a line's rendered height.
          text: List.filled(400, 'Old').join(' '),
          status: LineStatus.completed,
        ),
        TranscriptLine(
          id: 'run-new:send:0',
          runId: 'run-new',
          role: LineRole.assistant,
          // Long enough to still be on screen a nudge away from the end, and
          // to be well out of it at the other end of the thread.
          text: List.filled(400, 'New').join(' '),
          status: LineStatus.completed,
        ),
      ];
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SizedBox(
              height: 120,
              child: TranscriptView(
                lines: lines,
                loading: false,
                hasEarlier: false,
                onRefresh: ({older = false}) async {},
                onOpenRun: (_) {},
                onReadLatest: (message, onScreen) {
                  newest.add(message);
                  reports.add(onScreen ? message : null);
                },
                storageKey: 'read-test',
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      expect(reports, contains('run-new:send:0'));

      final scrollable = tester.state<ScrollableState>(find.byType(Scrollable));
      // A thread nudged off its end — to copy a line, or because the composer
      // grew — is still the thread being read while the reply is in view.
      scrollable.position.jumpTo(40);
      await tester.pump();
      expect(reports.last, 'run-new:send:0');

      scrollable.position.jumpTo(scrollable.position.maxScrollExtent);
      await tester.pump();
      expect(reports.last, isNull);
      // Out of view is not out of the chat: the newest is still named, so the
      // shell can keep holding its alert back without reading it.
      expect(newest.last, 'run-new:send:0');
    },
  );

  testWidgets('chat text lives in a selection area so it can be copied', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: Scaffold(
          body: TranscriptView(
            lines: [
              line(
                runId: 'run-a',
                role: LineRole.user,
                text: 'Copy this line',
                at: '2026-09-05T12:19:00.000Z',
              ),
              TranscriptLine(
                id: 'run-a:send:0',
                runId: 'run-a',
                role: LineRole.assistant,
                text: 'And this reply',
                at: '2026-09-05T12:19:01.000Z',
                status: LineStatus.completed,
              ),
            ],
            loading: false,
            hasEarlier: false,
            onRefresh: ({older = false}) async {},
            onOpenRun: (_) {},
            storageKey: 'selection-test',
          ),
        ),
      ),
    );
    await tester.pump();
    expect(find.byType(SelectionArea), findsOneWidget);
    expect(
      find.descendant(
        of: find.byType(SelectionArea),
        matching: find.text('Copy this line'),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: find.byType(SelectionArea),
        matching: find.textContaining('And this reply'),
      ),
      findsOneWidget,
    );
  });

  testWidgets(
    'a reverse thread reaches earlier messages without laying out every row',
    (tester) async {
      tester.view.physicalSize = const Size(400, 360);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      var olderPages = 0;
      final lines = [
        for (var index = 0; index < 16; index++)
          TranscriptLine(
            id: 'line-$index',
            runId: 'run-$index',
            role: LineRole.assistant,
            text: index < 8
                ? List.filled(50, 'Earlier$index').join(' ')
                : 'Latest $index',
            at: '2026-09-05T12:${index.toString().padLeft(2, '0')}:00.000Z',
            status: LineStatus.completed,
          ),
      ];
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: Scaffold(
            body: TranscriptView(
              lines: lines,
              loading: false,
              hasEarlier: true,
              onRefresh: ({older = false}) async {
                if (older) olderPages++;
              },
              onOpenRun: (_) {},
              storageKey: 'extent-test',
            ),
          ),
        ),
      );
      await tester.pump();
      expect(_onScreen(tester, find.text('Latest 15')), isTrue);
      expect(_onScreen(tester, find.textContaining('Earlier0')), isFalse);
      expect(olderPages, 0);

      final position = tester
          .state<ScrollableState>(find.byType(Scrollable))
          .position;
      for (var attempt = 0; attempt < 24; attempt++) {
        if (_onScreen(tester, find.text('Earlier messages')) &&
            _onScreen(tester, find.textContaining('Earlier0'))) {
          break;
        }
        position.jumpTo(position.maxScrollExtent);
        await tester.pump();
      }
      expect(_onScreen(tester, find.text('Earlier messages')), isTrue);
      expect(_onScreen(tester, find.textContaining('Earlier0')), isTrue);
      expect(olderPages, greaterThan(0));
    },
  );

  testWidgets('a long thread builds the oldest row when jumped to the end', (
    tester,
  ) async {
    final lines = [
      for (var index = 0; index < 80; index++)
        TranscriptLine(
          id: 'tall-$index',
          runId: 'tall-$index',
          role: LineRole.assistant,
          text: List.filled(40, 'Tall row $index stays put').join('\n'),
          at: '2026-09-05T${(index ~/ 60).toString().padLeft(2, '0')}:${(index % 60).toString().padLeft(2, '0')}:00.000Z',
          status: LineStatus.completed,
        ),
    ];
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: Scaffold(
          body: TranscriptView(
            lines: lines,
            loading: false,
            hasEarlier: false,
            onRefresh: ({older = false}) async {},
            onOpenRun: (_) {},
            storageKey: 'tall-test',
          ),
        ),
      ),
    );
    expect(find.textContaining('Tall row 79 stays put'), findsOneWidget);
    expect(find.textContaining('Tall row 0 stays put'), findsNothing);

    final position = tester
        .state<ScrollableState>(find.byType(Scrollable))
        .position;
    for (var attempt = 0; attempt < 24; attempt++) {
      if (find.textContaining('Tall row 0 stays put').evaluate().isNotEmpty) {
        break;
      }
      position.jumpTo(position.maxScrollExtent);
      await tester.pump();
    }
    expect(find.textContaining('Tall row 0 stays put'), findsOneWidget);
  });

  testWidgets(
    'an empty thread shows the greeting and never an Earlier messages button',
    (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: Scaffold(
            body: TranscriptView(
              lines: const [],
              loading: false,
              hasEarlier: true,
              onRefresh: ({older = false}) async {},
              onOpenRun: (_) {},
              storageKey: 'empty-test',
            ),
          ),
        ),
      );
      await tester.pump();
      expect(find.text('What would you like to work on?'), findsOneWidget);
      expect(find.text('Earlier messages'), findsNothing);
    },
  );

  testWidgets(
    'a loading empty thread shows the spinner and never an Earlier messages button',
    (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: Scaffold(
            body: TranscriptView(
              lines: const [],
              loading: true,
              hasEarlier: true,
              onRefresh: ({older = false}) async {},
              onOpenRun: (_) {},
              storageKey: 'loading-empty-test',
            ),
          ),
        ),
      );
      await tester.pump();
      expect(find.byType(FrockLoading), findsOneWidget);
      expect(
        find.bySemanticsLabel('Loading your conversation'),
        findsOneWidget,
      );
      expect(find.text('Earlier messages'), findsNothing);
    },
  );

  testWidgets(
    'a thread that already fits does not fetch older pages from the first frame',
    (tester) async {
      var olderPages = 0;
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: Scaffold(
            body: SizedBox(
              height: 400,
              child: TranscriptView(
                lines: [
                  line(
                    runId: 'run-short',
                    role: LineRole.assistant,
                    text: 'Fits on one screen',
                    at: '2026-09-05T12:19:00.000Z',
                  ),
                ],
                loading: false,
                hasEarlier: true,
                onRefresh: ({older = false}) async {
                  if (older) olderPages++;
                },
                onOpenRun: (_) {},
                storageKey: 'fits-test',
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      expect(find.text('Fits on one screen'), findsOneWidget);
      expect(find.text('Earlier messages'), findsOneWidget);
      expect(olderPages, 0);
      await tester.fling(find.byType(Scrollable), const Offset(0, 400), 2000);
      await tester.pumpAndSettle();
      expect(olderPages, 0);
    },
  );

  group('the bubbles a thread is drawn in', () {
    /// The fill of the bubble whose content is announced as [speaker].
    Color fill(WidgetTester tester, String speaker) {
      final bubble = tester.widget<Container>(
        find
            .ancestor(
              of: find.byWidgetPredicate(
                (widget) =>
                    widget is Semantics && widget.properties.label == speaker,
              ),
              matching: find.byWidgetPredicate(
                (widget) =>
                    widget is Container && widget.constraints?.maxWidth == 720,
              ),
            )
            .first,
      );
      return (bubble.decoration! as BoxDecoration).color!;
    }

    for (final brightness in Brightness.values) {
      testWidgets('gives the Bot a neutral slab distinct from the person\'s '
          '(${brightness.name})', (tester) async {
        final theme = FrockTheme.theme(brightness);
        await tester.pumpWidget(
          MaterialApp(
            theme: theme,
            home: Scaffold(
              body: TranscriptView(
                lines: [
                  line(
                    runId: 'run-a',
                    role: LineRole.user,
                    text: 'Hello',
                    at: '2026-09-05T12:19:00.000Z',
                  ),
                  TranscriptLine(
                    id: 'run-a:send:0',
                    runId: 'run-a',
                    role: LineRole.assistant,
                    text: 'Hi there',
                    at: '2026-09-05T12:19:01.000Z',
                    status: LineStatus.completed,
                  ),
                ],
                loading: false,
                hasEarlier: false,
                onRefresh: ({older = false}) async {},
                onOpenRun: (_) {},
                storageKey: 'bubble-test-${brightness.name}',
              ),
            ),
          ),
        );
        await tester.pump(const Duration(seconds: 1));

        final mine = fill(tester, 'You');
        final bot = fill(tester, 'Bot');
        expect(mine.a, greaterThan(0));
        expect(bot.a, greaterThan(0));
        expect(bot, theme.colorScheme.surfaceContainerHighest);
        expect(bot, isNot(theme.colorScheme.surface));
        expect(mine, isNot(bot));
      });
    }
  });

  test('names each send by the ordinal the cloud minted, not its position', () {
    // A Turn that outgrew the wire budget arrives with its earliest sends
    // dropped and a truncation marker in their place. The read the cloud can
    // match is `run-a:send:7`, which is what the surviving line has to be
    // called however few sends this client received.
    final lines = projectRuns([
      run(
        runId: 'run-a',
        input: 'Long turn',
        events: [
          {'type': 'run/events-truncated', 'omittedInteractions': 7},
          {
            'type': 'send/to-user',
            'payload': {'type': 'text', 'text': 'Last'},
            'ordinal': 7,
          },
        ],
      ),
    ]);

    expect(
      lines
          .where((line) => line.role == LineRole.assistant && !line.empty)
          .map((line) => line.id),
      ['run-a:send:7'],
    );
  });

  group('a firing that broke before it could speak', () {
    // The cloud tells the person as an ordinary message and projects it onto
    // the run in place of the send the firing never made. Drawing the outcome's
    // generic line underneath would be the same event said twice.
    const said =
        '"Morning brief" did not run: The model couldn\'t finish '
        'its reply. Try again.';
    Map<String, dynamic> brokenFiring() => run(
      runId: 'rf-brief',
      status: 'failed',
      // The cloud's notice for this run is the message it sent, word for word.
      failure: said,
      events: [
        {
          'type': 'send/to-user',
          'payload': {'type': 'text', 'text': said},
          'ordinal': 0,
        },
      ],
    );

    test('says what happened once', () {
      final lines = projectRuns([brokenFiring()]);
      expect(thread(lines), ['assistant: $said']);
      // Nothing to press: the Turn nobody typed cannot be sent again.
      expect(lines.where((line) => line.retry != null), isEmpty);
    });

    test('still draws the row the Turn hangs its work on', () {
      // The message is drawn, the notice is not, and the run is still failed.
      final closing = projectRuns([brokenFiring()])
          .firstWhere((line) => line.id == 'rf-brief:failed');
      expect(closing.status, LineStatus.error);
      expect(closing.notice, isNull);
      expect(closing.empty, isTrue);
    });

    test('says a stopped firing once too', () {
      // A firing stopped before it could speak is told the same way, and its
      // message already says the person stopped it.
      const stopped = '"Morning brief" was stopped: You stopped this.';
      final lines = projectRuns([
        run(
          runId: 'rf-brief',
          status: 'cancelled',
          failure: stopped,
          events: [
            {
              'type': 'send/to-user',
              'payload': {'type': 'text', 'text': stopped},
              'ordinal': 0,
            },
          ],
        ),
      ]);
      expect(thread(lines), ['assistant: $stopped']);
      final closing = lines.firstWhere(
        (line) => line.id == 'rf-brief:assistant',
      );
      expect(closing.status, LineStatus.aborted);
      expect(closing.notice, isNull);
    });

    test('leaves an ordinary stopped Turn saying it was stopped', () {
      final lines = projectRuns([
        run(runId: 'run-a', input: 'Hello', status: 'cancelled'),
      ]);
      expect(thread(lines), ['user: Hello', 'assistant: You stopped this.']);
    });

    test('leaves an ordinary broken reply saying why it broke', () {
      // Actual sends remain visible; the failed input owns the retry action.
      final lines = projectRuns([
        run(
          runId: 'run-a',
          input: 'Hello',
          status: 'failed',
          failure: "This Bot couldn't finish its reply. Try again.",
          sentText: 'Half an answer',
        ),
      ]);
      expect(thread(lines), ['user: Hello', 'assistant: Half an answer']);
      expect(lines.first.notice, "This Bot couldn't finish its reply.");
      expect(
        lines.where((line) => line.retry == LineRetry.resendTurn),
        isNotEmpty,
      );
    });
  });

  group('a reply the account could not pay for', () {
    test('says so in the product’s words and offers Billing, not a resend', () {
      for (final refusal in billingFailureCopy) {
        final lines = projectRuns([
          run(
            runId: 'run-a',
            input: 'Hello',
            status: 'failed',
            failure: refusal,
          ),
        ]);
        expect(thread(lines), ['user: Hello']);
        final failed = lines.firstWhere((line) => line.id == 'run-a:user');
        expect(failed.notice, refusal);
        expect(failed.retry, LineRetry.openBilling);
      }
    });
  });

  group('the order a thread is drawn in', () {
    Map<String, Object?> sent(String text, int ordinal, int seq) => {
      'type': 'send/to-user',
      'payload': {'type': 'text', 'text': text},
      'ordinal': ordinal,
      'seq': seq,
    };

    // A message sent while the Bot works lands where it was sent, as in any
    // chat. The answer the running Turn went on to give is drawn under it,
    // though the Bot read the message only after giving that answer.
    test('draws a message sent mid-Turn where it landed', () {
      final lines = projectRuns([
        run(
          runId: 'run-a',
          input: 'Plan the launch.',
          admittedAt: '2026-09-05T12:19:00.000Z',
          events: [sent('On it.', 0, 3), sent('Here is the plan.', 1, 9)],
        ),
        {
          ...run(
            runId: 'run-b',
            input: 'Keep it under ten thousand.',
            admittedAt: '2026-09-05T12:19:20.000Z',
            events: [sent('Trimmed it to nine.', 0, 14)],
          ),
          'landedAt': {'runId': 'run-a', 'seq': 6},
        },
      ]);

      expect(thread(lines), [
        'user: Plan the launch.',
        'assistant: On it.',
        'user: Keep it under ten thousand.',
        'assistant: Here is the plan.',
        'assistant: Trimmed it to nine.',
      ]);
    });

    test('keeps two messages sent mid-Turn in the order they landed', () {
      final lines = projectRuns([
        run(
          runId: 'run-a',
          input: 'Plan the launch.',
          admittedAt: '2026-09-05T12:19:00.000Z',
          events: [sent('On it.', 0, 3), sent('Here is the plan.', 1, 9)],
        ),
        {
          ...run(
            runId: 'run-b',
            input: 'Keep it cheap.',
            admittedAt: '2026-09-05T12:19:10.000Z',
            status: 'running',
            queued: true,
          ),
          'landedAt': {'runId': 'run-a', 'seq': 5},
        },
        {
          ...run(
            runId: 'run-c',
            input: 'And quick.',
            admittedAt: '2026-09-05T12:19:12.000Z',
            status: 'running',
            queued: true,
          ),
          'landedAt': {'runId': 'run-a', 'seq': 7},
        },
      ]);

      expect(thread(lines), [
        'user: Plan the launch.',
        'assistant: On it.',
        'user: Keep it cheap.',
        'user: And quick.',
        'assistant: Here is the plan.',
      ]);
    });

    // Nothing is committed while the model thinks, so two messages sent
    // during one call land at the same place: they keep the order they were
    // sent in.
    test('two messages that landed at the same place keep their order', () {
      final lines = projectRuns([
        run(
          runId: 'run-a',
          input: 'Plan the launch.',
          admittedAt: '2026-09-05T12:19:00.000Z',
          events: [sent('On it.', 0, 3), sent('Here is the plan.', 1, 9)],
        ),
        for (final (id, words, at) in [
          ('run-b', 'Keep it cheap.', '2026-09-05T12:19:10.000Z'),
          ('run-c', 'And quick.', '2026-09-05T12:19:12.000Z'),
        ])
          {
            ...run(
              runId: id,
              input: words,
              admittedAt: at,
              status: 'running',
              queued: true,
            ),
            'landedAt': {'runId': 'run-a', 'seq': 6},
          },
      ]);

      expect(thread(lines), [
        'user: Plan the launch.',
        'assistant: On it.',
        'user: Keep it cheap.',
        'user: And quick.',
        'assistant: Here is the plan.',
      ]);
    });

    // A Routine firing counts in a log of its own, so its positions say
    // nothing about where a message sent during another Turn landed.
    test('a firing earlier in the thread is not measured against', () {
      final lines = projectRuns([
        run(
          runId: 'run-digest',
          admittedAt: '2026-09-05T09:00:00.000Z',
          events: [sent('Morning digest.', 0, 40)],
        ),
        run(
          runId: 'run-a',
          input: 'Plan the launch.',
          admittedAt: '2026-09-05T12:19:00.000Z',
          events: [sent('On it.', 0, 3), sent('Here is the plan.', 1, 9)],
        ),
        {
          ...run(
            runId: 'run-b',
            input: 'Keep it cheap.',
            admittedAt: '2026-09-05T12:19:10.000Z',
            status: 'running',
            queued: true,
          ),
          'landedAt': {'runId': 'run-a', 'seq': 6},
        },
      ]);

      expect(thread(lines), [
        'assistant: Morning digest.',
        'user: Plan the launch.',
        'assistant: On it.',
        'user: Keep it cheap.',
        'assistant: Here is the plan.',
      ]);
    });

    // A retry of an older message answers where that message was. A message
    // that lands while it runs still never climbs above what the person had
    // already said after it.
    test('a message never lands above one sent before it', () {
      final lines = projectRuns([
        {
          ...run(
            runId: 'venue-1',
            input: 'Book the venue.',
            admittedAt: '2026-09-05T12:00:00.000Z',
            status: 'failed',
            failure: 'This Bot couldn’t finish its reply.',
          ),
          'canRetry': false,
          'retriedBy': 'venue-2',
        },
        run(
          runId: 'invite',
          input: 'Draft the invite.',
          admittedAt: '2026-09-05T12:05:00.000Z',
          sentText: 'Drafted.',
        ),
        {
          ...run(
            runId: 'venue-2',
            input: 'Book the venue.',
            admittedAt: '2026-09-05T12:10:00.000Z',
            status: 'running',
            events: [sent('Booked it.', 0, 20)],
          ),
          'retryOf': 'venue-1',
          'messageRunId': 'venue-1',
          'messageAdmittedAt': '2026-09-05T12:00:00.000Z',
        },
        {
          ...run(
            runId: 'budget',
            input: 'Under two thousand, please.',
            admittedAt: '2026-09-05T12:11:00.000Z',
            status: 'running',
            queued: true,
          ),
          'landedAt': {'runId': 'venue-2', 'seq': 15},
        },
      ]);

      final drawn = thread(lines);
      expect(
        drawn.indexOf('assistant: Booked it.'),
        lessThan(drawn.indexOf('user: Draft the invite.')),
      );
      expect(drawn.last, 'user: Under two thousand, please.');
    });

    test('a message that landed after the Turn had spoken stays under it', () {
      final lines = projectRuns([
        run(
          runId: 'run-a',
          input: 'Plan the launch.',
          admittedAt: '2026-09-05T12:19:00.000Z',
          events: [sent('Here is the plan.', 0, 3)],
        ),
        {
          ...run(
            runId: 'run-b',
            input: 'Thanks.',
            admittedAt: '2026-09-05T12:19:20.000Z',
            status: 'running',
            queued: true,
          ),
          'landedAt': {'runId': 'run-a', 'seq': 4},
        },
      ]);

      expect(thread(lines), [
        'user: Plan the launch.',
        'assistant: Here is the plan.',
        'user: Thanks.',
      ]);
    });

    /*
     * The production sweep: a message is sent, and while its reply is
     * streaming two more are sent. Each Turn is admitted a moment after the
     * client drew it, so a Turn's user line carries the run's durable
     * `admittedAt` while the reply this client received from its own POST
     * carried the device clock from before the send.
     */
    test('keeps a reply under the messages it answers across three sends', () {
      final lines = projectRuns([
        run(
          runId: 'run-a',
          input: 'QA check: reply with a short haiku about avatar.',
          admittedAt: '2026-09-05T12:19:00.000Z',
          sentText: haiku,
        ),
        run(
          runId: 'run-b',
          input: 'Second message sent while the first reply is still running.',
          admittedAt: '2026-09-05T12:19:21.000Z',
          sentText: answer,
        ),
        run(
          runId: 'run-c',
          input: 'Third message queued during the run.',
          admittedAt: '2026-09-05T12:19:31.000Z',
          status: 'running',
        ),
      ]);

      // What the POST for the second message did before this rule: stamp the
      // reply with the device's clock at the moment send was pressed, which is
      // earlier than every durable stamp the backend went on to assign.
      final stamped = [
        for (final row in lines)
          if (row.runId == 'run-b' && row.role == LineRole.assistant)
            TranscriptLine(
              id: row.id,
              runId: row.runId,
              role: row.role,
              text: row.text,
              sends: row.sends,
              at: '2026-09-05T12:19:20.000Z',
              status: row.status,
            )
          else
            row,
      ];

      expect(thread(stamped), [
        'user: QA check: reply with a short haiku about avatar.',
        'assistant: $haiku',
        'user: Second message sent while the first reply is still running.',
        'assistant: $answer',
        'user: Third message queued during the run.',
      ]);
    });

    test("anchors a Turn on the moment its own message was admitted", () {
      final lines = projectRuns([
        run(
          runId: 'run-b',
          input: 'Second message sent while the first reply is still running.',
          admittedAt: '2026-09-05T12:19:21.000Z',
          sentText: answer,
        ),
      ]);

      expect(turnAnchors(lines)['run-b'], '2026-09-05T12:19:21.000Z');
    });

    test(
      'still sorts a line the product wrote between Turns by its own time',
      () {
        expect(
          thread([
            line(
              runId: 'run-a',
              role: LineRole.user,
              text: 'first',
              at: '2026-09-05T12:19:00.000Z',
            ),
            line(
              runId: 'run-a',
              role: LineRole.assistant,
              text: 'first reply',
              at: '2026-09-05T12:19:00.000Z',
            ),
            line(
              runId: 'run-b',
              role: LineRole.user,
              text: 'second',
              at: '2026-09-05T12:20:00.000Z',
            ),
            line(
              runId: 'announcement-1',
              role: LineRole.system,
              text: 'Renamed to Test by user',
              at: '2026-09-05T12:19:30.000Z',
            ),
          ]),
          [
            'user: first',
            'assistant: first reply',
            'system: Renamed to Test by user',
            'user: second',
          ],
        );
      },
    );

    test('sorts a line with no time at all to the bottom', () {
      expect(
        thread([
          line(runId: 'run-z', role: LineRole.user, text: 'unstamped'),
          line(
            runId: 'run-a',
            role: LineRole.user,
            text: 'stamped',
            at: '2026-09-05T12:19:00.000Z',
          ),
        ]),
        ['user: stamped', 'user: unstamped'],
      );
    });
  });

  group('what a Turn is projected as', () {
    test('a Routine that spoke draws its message and no empty bubble', () {
      final lines = projectRuns([
        run(runId: 'run-routine', input: '', sentText: 'The report is ready.'),
      ]);

      // A Routine's Turn is projected with no input: nobody typed it, and an
      // empty right-aligned pill above every Routine message is a bubble the
      // person did not send.
      expect(
        [for (final row in lines) row.id],
        ['run-routine:send:0', 'run-routine:assistant'],
      );
    });

    test(
      'a send with no durable ordinal is dropped rather than positioned',
      () {
        final lines = projectRuns([
          run(
            runId: 'run-a',
            input: 'do it',
            events: [
              {
                'type': 'send/to-user',
                'payload': {'type': 'text', 'text': 'Unidentifiable.'},
              },
              {
                'type': 'send/to-user',
                'payload': {'type': 'text', 'text': 'Done.'},
                'ordinal': 4,
              },
            ],
          ),
        ]);

        expect(
          [for (final row in lines) row.id],
          ['run-a:user', 'run-a:send:4', 'run-a:assistant'],
        );
      },
    );

    test('draws one bubble per send, in the order the Bot sent them', () {
      final lines = projectRuns([
        run(
          runId: 'run-a',
          input: 'do it',
          responseText: 'model scratch space',
          events: [
            {
              'type': 'send/to-user',
              'payload': {'type': 'text', 'text': 'On it.'},
              'ordinal': 0,
            },
            {
              'type': 'send/to-user',
              'payload': {'type': 'text', 'text': 'Done.'},
              'ordinal': 1,
            },
          ],
        ),
      ]);

      expect(
        [for (final row in lines) row.id],
        ['run-a:user', 'run-a:send:0', 'run-a:send:1', 'run-a:assistant'],
      );
      // A Turn that sent anything is drawn entirely from its sends; the text
      // the model wrote beside them is scratch space.
      expect(lines.last.text, '');
      expect(lines[1].sends.single.payload!['text'], 'On it.');
    });

    test('keeps private partial text hidden and shows the failure reason', () {
      final line = projectRuns([
        run(
          runId: 'run-a',
          input: 'do it',
          status: 'failed',
          responseText: 'Half an answer',
          failure: "The model couldn't finish its reply. Try again.",
        ),
      ]).firstWhere((line) => line.role == LineRole.user);

      expect(line.text, 'do it');
      expect(line.notice, "The model couldn't finish its reply.");
      expect(line.retry, LineRetry.resendTurn);
      expect(line.status, LineStatus.error);
    });

    test('never lets a provider diagnostic under a bubble', () {
      final line = projectRuns([
        run(
          runId: 'run-a',
          status: 'failed',
          failure: 'Bot turn ended with outcome model-error: socket hang up',
        ),
      ]).last;

      expect(line.notice, "This Bot couldn't finish its reply.");
      expect(line.retry, isNull);
    });

    // The deadline sentences say something the outcome alone cannot, so they
    // are carried through as written rather than collapsed to the generic line.
    test('keeps the Turn deadline warning word for word', () {
      const deadline =
          'This Turn ran for 15 minutes without finishing and was stopped. '
          'Try sending it again.';
      final line = projectRuns([
        run(runId: 'run-a', status: 'failed', failure: deadline),
      ]).last;

      expect(line.notice, deadline);
      // It already says what to do, so it does not also grow a button.
      expect(line.retry, isNull);
    });

    test('offers nothing again for an ending the person chose', () {
      final line = projectRuns([run(runId: 'run-a', status: 'cancelled')]).last;

      expect(line.notice, 'You stopped this.');
      expect(line.retry, isNull);
    });

    test('a Turn admitted behind the one still running says nothing yet', () {
      final lines = projectRuns([
        run(runId: 'run-a', input: 'next', status: 'running', queued: true),
      ]);

      expect(lines.first.text, 'next');
      expect(lines.last.empty, isTrue);
    });

    test('says a Stop was accepted rather than staying silent', () {
      final line = projectRuns([
        {...run(runId: 'run-a', status: 'running'), 'stopRequestedAt': 'now'},
      ]).last;

      expect(line.stopRequested, isTrue);
    });
  });

  group('the conversation\'s own announcements', () {
    test('a rename and a compaction each become one system line', () {
      final lines = projectAnnouncements([
        {
          'type': 'bot/renamed',
          'announcementId': 'announcement-3',
          'at': '2026-09-05T12:19:30.000Z',
          'from': 'Scout',
          'to': 'Test',
          'namedBy': 'user',
        },
        {
          'type': 'conversation/compacted',
          'announcementId': 'compaction-9',
          'at': '2026-09-05T12:18:00.000Z',
          'throughTurn': 4,
        },
      ]);
      expect(lines.map((line) => line.role), everyElement(LineRole.system));
      expect(lines.first.text, 'Renamed to Test by user');
      // The summary itself is never on the wire: every Turn it covers is
      // still readable, unchanged, immediately above the line.
      expect(lines.last.text, compactedAnnouncementText);
      expect(lines.map((line) => line.id), ['announcement-3', 'compaction-9']);
    });

    test('a hang-up becomes a collapsible Voice chat line', () {
      final lines = projectAnnouncements([
        {
          'type': 'voice/call',
          'announcementId': 'voice-call-call-9',
          'at': '2026-09-05T12:22:00.000Z',
          'callId': 'call-9',
          'startedAt': '2026-09-05T12:19:00.000Z',
          'endedAt': '2026-09-05T12:22:00.000Z',
          'turns': [
            {'transcript': 'plan my week', 'answer': 'On it.'},
          ],
        },
      ]);
      expect(lines, hasLength(1));
      expect(lines.single.voiceCall?.turns.single.transcript, 'plan my week');
      expect(voiceCallTitle(lines.single.voiceCall!), 'Voice chat · 3 min');
      expect(
        thread([
          line(
            runId: 'run-a',
            role: LineRole.user,
            text: 'typed later',
            at: '2026-09-05T12:23:00.000Z',
          ),
          ...lines,
        ]),
        ['system: Voice chat · 3 min', 'user: typed later'],
      );
    });

    testWidgets('a stop with nothing said is a marker, not a bubble', (
      tester,
    ) async {
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: Scaffold(
            body: TranscriptView(
              lines: projectRuns([
                run(
                  runId: 'run-a',
                  input: 'Draft the update',
                  status: 'cancelled',
                  admittedAt: '2026-09-05T12:19:00.000Z',
                ),
              ]),
              loading: false,
              hasEarlier: false,
              onRefresh: ({older = false}) async {},
              onOpenRun: (_) {},
              storageKey: 'stopped-test',
            ),
          ),
        ),
      );
      await tester.pump();
      expect(find.text('You stopped this.'), findsOneWidget);
      expect(
        find.ancestor(
          of: find.text('You stopped this.'),
          matching: find.bySemanticsLabel('Bot'),
        ),
        findsNothing,
      );
    });

    testWidgets('expands a hang-up accordion to the spoken turns', (
      tester,
    ) async {
      final lines = projectAnnouncements([
        {
          'type': 'voice/call',
          'announcementId': 'voice-call-call-9',
          'at': '2026-09-05T12:22:00.000Z',
          'callId': 'call-9',
          'startedAt': '2026-09-05T12:19:00.000Z',
          'endedAt': '2026-09-05T12:22:00.000Z',
          'turns': [
            {'transcript': 'plan my week', 'answer': 'On it.'},
          ],
        },
      ]);
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: Scaffold(
            body: TranscriptView(
              lines: lines,
              loading: false,
              hasEarlier: false,
              onRefresh: ({older = false}) async {},
              onOpenRun: (_) {},
              storageKey: 'voice-call-test',
            ),
          ),
        ),
      );
      await tester.pump();
      // Closed, it is a card that says what the call was and how it began.
      expect(find.text('Voice chat'), findsOneWidget);
      expect(find.text('3 min · 1 exchange'), findsOneWidget);
      expect(find.text('“plan my week”'), findsOneWidget);
      expect(find.text('plan my week'), findsNothing);
      await tester.tap(find.text('Voice chat'));
      await tester.pump();
      // Open, it is the call itself, each side in its own bubble.
      expect(find.text('plan my week'), findsOneWidget);
      expect(find.text('On it.'), findsOneWidget);
      expect(find.text('“plan my week”'), findsNothing);
      expect(
        tester.getCenter(find.text('plan my week')).dx,
        greaterThan(tester.getCenter(find.text('On it.')).dx),
      );
    });

    test('a marker is seated among the Turns it happened between', () {
      expect(
        thread([
          line(
            runId: 'run-a',
            role: LineRole.user,
            text: 'first',
            at: '2026-09-05T12:19:00.000Z',
          ),
          line(
            runId: 'run-b',
            role: LineRole.user,
            text: 'second',
            at: '2026-09-05T12:20:00.000Z',
          ),
          ...projectAnnouncements([
            {
              'type': 'conversation/compacted',
              'announcementId': 'compaction-1',
              'at': '2026-09-05T12:19:30.000Z',
              'throughTurn': 1,
            },
          ]),
        ]),
        ['user: first', 'system: $compactedAnnouncementText', 'user: second'],
      );
    });

    test('an announcement this client cannot read is skipped, not thrown', () {
      expect(
        projectAnnouncements([
          'nonsense',
          {'type': 'bot/renamed'},
          {
            'type': 'future/shape',
            'announcementId': 'announcement-9',
            'at': '2026-09-05T12:19:30.000Z',
          },
        ]),
        isEmpty,
      );
    });
  });
}
