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
  bool pending = false,
}) => TranscriptLine(
  id: '$runId:${role.name}',
  runId: runId,
  role: role,
  text: text,
  at: at,
  status: status,
  pending: pending,
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
                onReadLatest: reports.add,
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

  group('the working row while a supersede drains', () {
    final sentAt = DateTime.parse('2026-09-05T00:00:00.000Z');

    /// The thread the moment a message is sent into a Turn still running.
    List<TranscriptLine> draining() => [
      line(runId: 'run-a', role: LineRole.user, at: '2026-09-04T23:59:00.000Z'),
      // The Turn being displaced: still streaming, not waiting on anything.
      line(
        runId: 'run-a',
        role: LineRole.assistant,
        at: '2026-09-04T23:59:00.000Z',
        status: LineStatus.streaming,
      ),
      line(
        runId: 'run-b',
        role: LineRole.user,
        at: '2026-09-05T00:00:00.000Z',
        pending: true,
      ),
      line(
        runId: 'run-b',
        role: LineRole.assistant,
        at: '2026-09-05T00:00:00.000Z',
        status: LineStatus.streaming,
        pending: true,
      ),
    ];

    test('says the previous reply is being stopped', () {
      final state = supersedeDrainState(draining(), sentAt);

      expect(state, SupersedeDrainState.stopping);
      expect(supersedeDrainLabel(state), supersedeDrainLabelText);
    });

    test('keeps saying it, differently, once the drain runs long', () {
      final state = supersedeDrainState(
        draining(),
        sentAt.add(supersedeDrainSlowAfter),
      );

      expect(state, SupersedeDrainState.slow);
      expect(supersedeDrainLabel(state), supersedeDrainSlowLabelText);
    });

    test('still says the first thing a moment before the bound', () {
      expect(
        supersedeDrainState(
          draining(),
          sentAt
              .add(supersedeDrainSlowAfter)
              .subtract(const Duration(milliseconds: 1)),
        ),
        SupersedeDrainState.stopping,
      );
    });

    // The transition the person is waiting for: the Turn they replaced
    // settles, theirs is admitted, and the row is an ordinary working row.
    test('says nothing once the new Turn has started', () {
      final started = [
        for (final row in draining())
          if (row.runId == 'run-b')
            line(
              runId: row.runId,
              role: row.role,
              at: row.at,
              status: row.status,
            ),
      ];

      final state = supersedeDrainState(
        started,
        sentAt.add(const Duration(seconds: 1)),
      );

      expect(state, SupersedeDrainState.none);
      expect(supersedeDrainLabel(state), isNull);
    });

    test('says nothing about an ordinary running Turn', () {
      expect(
        supersedeDrainState([
          line(
            runId: 'run-a',
            role: LineRole.user,
            at: '2026-09-05T00:00:00.000Z',
          ),
          line(
            runId: 'run-a',
            role: LineRole.assistant,
            at: '2026-09-05T00:00:00.000Z',
            status: LineStatus.streaming,
          ),
        ], sentAt.add(const Duration(minutes: 1))),
        SupersedeDrainState.none,
      );
    });

    test('says nothing when there is no Turn at all', () {
      expect(supersedeDrainState(const [], sentAt), SupersedeDrainState.none);
    });

    // A settled line that somehow kept the flag is not a drain: only a Turn
    // that has not started is waiting on the one before it.
    test('ignores a pending line whose Turn has already ended', () {
      expect(
        supersedeDrainState([
          line(
            runId: 'run-a',
            role: LineRole.assistant,
            at: '2026-09-05T00:00:00.000Z',
            pending: true,
          ),
        ], sentAt),
        SupersedeDrainState.none,
      );
    });

    test('shows the ordinary wording when the line carries no time', () {
      expect(
        supersedeDrainState([
          line(
            runId: 'run-a',
            role: LineRole.assistant,
            status: LineStatus.streaming,
            pending: true,
          ),
        ], sentAt),
        SupersedeDrainState.stopping,
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

    // Quieter than a stopped Turn: the message that superseded it is sitting
    // right underneath, in the person's own words.
    test('a superseded Turn carries no notice at all', () {
      final line = projectRuns([
        run(runId: 'run-a', status: 'superseded', responseText: 'partial'),
      ]).last;

      expect(line.notice, isNull);
      expect(line.status, LineStatus.aborted);
    });

    test('greys a Turn admitted behind the one still running', () {
      final lines = projectRuns([
        run(runId: 'run-a', input: 'next', status: 'running', queued: true),
      ]);

      expect(lines.first.pending, isTrue);
      expect(lines.last.pending, isTrue);
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
      expect(find.text('Voice chat · 3 min'), findsOneWidget);
      expect(find.text('plan my week'), findsNothing);
      await tester.tap(find.text('Voice chat · 3 min'));
      await tester.pump();
      expect(find.text('plan my week'), findsOneWidget);
      expect(find.text('On it.'), findsOneWidget);
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
