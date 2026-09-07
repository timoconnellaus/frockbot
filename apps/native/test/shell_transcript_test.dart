/// The thread's own rules, ported from the Vue shell's `transcript-order` and
/// `supersede-drain` suites case for case.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/shell/transcript_model.dart';

/// How the thread reads, one line per row, in the order it is drawn.
List<String> thread(List<TranscriptLine> lines) => [
  for (final line in orderTranscript(lines, '2026-09-05T12:30:00.000Z'))
    if (line.text.isNotEmpty || line.notice != null)
      '${line.role.name}: ${line.text.isNotEmpty ? line.text : line.notice}',
];

Map<String, dynamic> run({
  required String runId,
  String input = '',
  String status = 'completed',
  String admittedAt = '2026-09-05T12:19:00.000Z',
  String? responseText,
  List<Object?> events = const [],
  bool queued = false,
  String? failure,
}) => {
  'runId': runId,
  'input': input,
  'status': status,
  'admittedAt': admittedAt,
  'events': events,
  'responseText': ?responseText,
  if (queued) 'queued': true,
  'failure': ?failure,
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

void main() {
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
          input: 'QA check: reply with a short haiku about sheep.',
          admittedAt: '2026-09-05T12:19:00.000Z',
          responseText: haiku,
        ),
        run(
          runId: 'run-b',
          input: 'Second message sent while the first reply is still running.',
          admittedAt: '2026-09-05T12:19:21.000Z',
          responseText: answer,
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
              at: '2026-09-05T12:19:20.000Z',
              status: row.status,
            )
          else
            row,
      ];

      expect(thread(stamped), [
        'user: QA check: reply with a short haiku about sheep.',
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
          responseText: answer,
        ),
      ]);

      expect(turnAnchors(lines)['run-b'], '2026-09-05T12:19:21.000Z');
    });

    test('still sorts a line the product wrote between Turns by its own time', () {
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
    });

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
      line(
        runId: 'run-a',
        role: LineRole.user,
        at: '2026-09-04T23:59:00.000Z',
      ),
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
          sentAt.add(supersedeDrainSlowAfter).subtract(
            const Duration(milliseconds: 1),
          ),
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
          line(runId: 'run-a', role: LineRole.user, at: '2026-09-05T00:00:00.000Z'),
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
            },
            {
              'type': 'send/to-user',
              'payload': {'type': 'text', 'text': 'Done.'},
            },
          ],
        ),
      ]);

      expect([for (final row in lines) row.id], [
        'run-a:user',
        'run-a:send:0',
        'run-a:send:1',
        'run-a:assistant',
      ]);
      // A Turn that sent anything is drawn entirely from its sends; the text
      // the model wrote beside them is scratch space.
      expect(lines.last.text, '');
      expect(lines[1].sends.single.payload!['text'], 'On it.');
    });

    test('keeps what a broken Turn said, with the reason underneath', () {
      final line = projectRuns([
        run(
          runId: 'run-a',
          input: 'do it',
          status: 'failed',
          responseText: 'Half an answer',
          failure: "The model couldn't finish its reply. Try again.",
        ),
      ]).last;

      expect(line.text, 'Half an answer');
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
      expect(line.retry, LineRetry.resendTurn);
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
      final line = projectRuns([
        run(runId: 'run-a', status: 'cancelled'),
      ]).last;

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

  group('what a failed Turn would be sent again as', () {
    test('the retry sends the original words, not what is typed', () {
      expect(
        resendableTurnText('  book it  ', maxCharacters: 32000),
        'book it',
      );
    });

    test('a Turn with nothing to say again is not offered again', () {
      expect(resendableTurnText(null, maxCharacters: 32000), isNull);
      expect(resendableTurnText('   ', maxCharacters: 32000), isNull);
      expect(
        resendableTurnText('x' * 32001, maxCharacters: 32000),
        isNull,
      );
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
        ]),
        isEmpty,
      );
    });
  });
}
