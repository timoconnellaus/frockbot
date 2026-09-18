import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/shell/exchange_view.dart';
import 'package:frockbot_native/shell/transcript.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

const xero = {'kind': 'bot', 'name': 'Xero Books', 'botId': 'xero-books'};

Map<String, dynamic> chatRun({
  required String id,
  required String at,
  required String input,
  List<Object?> events = const [],
  String status = 'completed',
}) => {
  'runId': id,
  'input': input,
  'status': status,
  'admittedAt': at,
  'events': [
    {'type': 'model/text-delta', 'text': 'Private scratch'},
    ...events,
  ],
};

Map<String, Object?> send(int ordinal, String text) => {
  'type': 'send/to-user',
  'ordinal': ordinal,
  'payload': {'type': 'text', 'text': text},
};

Map<String, Object?> toBot(
  String callId,
  String text, {
  String botId = 'codex-watch',
}) => {
  'type': 'message/to-bot',
  'callId': callId,
  'botId': botId,
  'text': text,
};

Map<String, Object?> result(String callId, String text, {bool error = false}) =>
    {
      'type': 'tool/result',
      'callId': callId,
      'content': text,
      'isError': error,
    };

/// A Turn another party asked for.
Map<String, dynamic> inboundRun({
  required String id,
  required String at,
  required Map<String, Object?> via,
  required String input,
  String? reply,
  List<Object?> sends = const [],
  String status = 'completed',
  bool queued = false,
}) => {
  'runId': id,
  'input': input,
  'status': status,
  'queued': queued,
  'admittedAt': at,
  'via': via,
  'events': [
    {'type': 'model/text-delta', 'text': 'Private scratch'},
    if (reply != null)
      {'type': 'reply/to-caller', 'caller': via['kind'], 'text': reply},
    ...sends,
  ],
};

/// General's thread, as the GrokBot reference draws it: a request that
/// messaged another Bot, a ping from Xero Books, and a voice question.
List<Map<String, dynamic>> generalRuns() => [
  inboundRun(
    id: 'xero-sep-4',
    at: '2026-09-03T22:31:00.000Z',
    via: xero,
    input:
        '4 Sep CMI review: same \$88,550 overdue AR, INV-0024 \$550 due 10 '
        'Sep, 6 unreconciled Stripe fees \$150.30. TB Westpac cash now '
        '\$23,499.70. No unpaid bills. Please file a brief Inbox note.',
    reply: 'Filed Todoist Inbox note: CMI 4 Sep review (AR, INV-0024, Stripe).',
  ),
  inboundRun(
    id: 'xero-sep-9',
    at: '2026-09-08T22:29:00.000Z',
    via: xero,
    input:
        '9 Sep CMI review: INV-0024 Cambridge \$550 due tomorrow. Overdue AR '
        'still \$88,550; 6 unreconciled Stripe fees \$150.30; no unpaid '
        'bills. Please file a brief Inbox note.',
    reply: 'Filed Todoist Inbox note: CMI Cambridge INV-0024 \$550 due 10 Sep.',
  ),
  inboundRun(
    id: 'xero-sep-10',
    at: '2026-09-09T22:39:00.000Z',
    via: xero,
    input:
        '10 Sep CMI review posted. INV-0024 Cambridge \$550 paid via Stripe; '
        'new INV-0025 \$550 due 17 Sep. Overdue AR still \$88,550. '
        'Unreconciled Stripe fees now 7 totalling \$160.50. TB Westpac YTD '
        'debit \$24,039.50. Please file Inbox note.',
    reply:
        'Filed Todoist Inbox note: CMI INV-0024 paid, INV-0025 \$550 due 17 '
        'Sep (plus AR/Stripe/Westpac snapshot).',
  ),
  chatRun(
    id: 'codex',
    at: '2026-09-15T23:53:00.000Z',
    input: 'Can you watch for the daily Codex usage reset and let me know?',
    events: [
      send(0, 'Setting up a daily Codex-reset watcher for you.'),
      toBot(
        'tool-2',
        'Please create a daily routine at 9am Sydney (weekends too) that '
            'checks Tibo and official OpenAI channels for Codex usage-reset '
            'signals, and only pings Tim when there is a real one.',
      ),
      result(
        'tool-2',
        'Done. Routine "Codex reset check" runs daily at 09:00 '
            'Australia/Sydney and notifies on a confirmed reset only.',
      ),
      send(
        1,
        'Created **Codex Watch** under Work. It’ll check around 9am Sydney '
        'every day (weekends too — resets have landed then) for '
        'Tibo/official Codex reset signals, and only ping you when '
        'there’s a real one.',
      ),
    ],
  ),
  inboundRun(
    id: 'xero-sep-16',
    at: '2026-09-15T22:14:00.000Z',
    via: xero,
    input:
        '16 Sep CMI ping: Cambridge INV-0025 \$550 due tomorrow. Overdue AR '
        'still \$88,550; 7 unreconciled Stripe fees \$160.50; Westpac YTD '
        '\$24,039.50; no unpaid bills. Please file a brief Inbox note.',
    reply:
        'Filed Todoist Inbox note: CMI Cambridge INV-0025 \$550 due 17 Sep '
        '(plus AR/Stripe/Westpac snapshot).',
    sends: [
      send(
        0,
        'Xero Books pinged: Cambridge INV-0025 is due tomorrow. Filing a '
        'quick Inbox note.',
      ),
    ],
  ),
  inboundRun(
    id: 'voice-1',
    at: '2026-09-16T00:02:00.000Z',
    via: const {'kind': 'voice'},
    input: 'What is due this week?',
    reply:
        'Just one thing: the Cambridge invoice for five hundred and fifty '
        'dollars is due tomorrow.',
  ),
  chatRun(
    id: 'tradie',
    at: '2026-09-16T00:20:00.000Z',
    input: 'Ask Tradie Sites whether the Bendigo quote went out',
    status: 'running',
    events: [
      toBot(
        'tool-1',
        'Did the Bendigo plumbing quote go out yesterday?',
        botId: 'tradie-sites',
      ),
    ],
  ),
];

Future<void> loadFonts() async {
  final inter = FontLoader('Inter');
  for (final weight in [400, 500, 600, 700]) {
    inter.addFont(rootBundle.load('assets/fonts/inter-latin-$weight.ttf'));
  }
  await inter.load();
  await (FontLoader(
    'Manrope',
  )..addFont(rootBundle.load('assets/fonts/manrope-latin.ttf'))).load();
  await (FontLoader(
    'MaterialIcons',
  )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
}

/// Optional review artifacts, kept outside the repository.
Future<void> capture(
  WidgetTester tester,
  GlobalKey boundary,
  String name,
) async {
  const output = String.fromEnvironment('EXCHANGE_VISUAL_OUTPUT');
  if (output.isEmpty) return;
  // The sheep are asset images, decoded off the test's fake clock; give them
  // real time to land before the frame is read back.
  await tester.runAsync(() => Future<void>.delayed(const Duration(seconds: 1)));
  await tester.pump();
  await tester.runAsync(() async {
    final image =
        await (boundary.currentContext!.findRenderObject()!
                as RenderRepaintBoundary)
            .toImage(pixelRatio: 2);
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    await File('$output/$name.png').writeAsBytes(bytes!.buffer.asUint8List());
    image.dispose();
  });
}

String? backgroundOf(String botId) => switch (botId) {
  'xero-books' => 'electric-blue',
  'codex-watch' => 'bright-orange',
  'tradie-sites' => 'lime-green',
  _ => null,
};

String? nameOf(String botId) => switch (botId) {
  'xero-books' => 'Xero Books',
  'codex-watch' => 'Codex Watch',
  'tradie-sites' => 'Tradie Sites',
  _ => null,
};

final clock = DateTime(2026, 9, 16, 10, 30);

void main() {
  setUpAll(loadFonts);

  test('a Turn a Bot asked for is a marker, not the person\'s message', () {
    final lines = projectRuns([
      inboundRun(
        id: 'r',
        at: '2026-09-15T22:14:00.000Z',
        via: xero,
        input: 'Please file a note.',
        reply: 'Filed.',
        sends: [send(0, 'Xero Books pinged.')],
      ),
    ]);
    expect(lines.where((line) => line.role == LineRole.user), isEmpty);
    final marker = lines.first.exchange!;
    expect(marker.direction, ExchangeDirection.inbound);
    expect(marker.counterpart.label, 'Xero Books');
    expect(marker.request, 'Please file a note.');
    expect(marker.reply, 'Filed.');
    expect(marker.status, ExchangeStatus.answered);
    expect(lines[1].sends.single.payload!['text'], 'Xero Books pinged.');
    expect(lines.last.notice, isNull);
  });

  test('a voice request only takes the answer addressed to it', () {
    final lines = projectRuns([
      inboundRun(
        id: 'v',
        at: '2026-09-16T00:02:00.000Z',
        via: const {'kind': 'voice'},
        input: 'What is due?',
        reply: 'One invoice.',
        sends: [send(0, 'A separate update for you')],
      ),
    ]);
    expect(lines.first.exchange!.counterpart.isVoice, isTrue);
    expect(lines.first.exchange!.reply, 'One invoice.');
    expect(lines.where((line) => line.sends.isNotEmpty), hasLength(1));
  });

  test('queued and running exchanges do not read as a supersede drain', () {
    final queued = projectRuns([
      inboundRun(
        id: 'q',
        at: '2026-09-16T00:02:00.000Z',
        via: const {'kind': 'voice'},
        input: 'Later?',
        status: 'running',
        queued: true,
      ),
    ]);
    expect(queued.first.exchange!.status, ExchangeStatus.queued);
    expect(
      supersedeDrainState(queued, DateTime.utc(2026, 9, 16, 0, 3)),
      SupersedeDrainState.none,
    );
    expect(
      projectRuns([
        inboundRun(
          id: 'w',
          at: '2026-09-16T00:02:00.000Z',
          via: xero,
          input: 'Now?',
          status: 'running',
        ),
      ]).first.exchange!.status,
      ExchangeStatus.working,
    );
    expect(
      projectRuns([
        inboundRun(
          id: 'f',
          at: '2026-09-16T00:02:00.000Z',
          via: xero,
          input: 'Now?',
          status: 'failed',
        ),
      ]).first.exchange!.status,
      ExchangeStatus.failed,
    );
  });

  test('a running exchange says nothing the working row already says', () {
    String? labelOf(ExchangeStatus status) => Exchange(
      id: 'x',
      counterpart: const ExchangeCounterpart.voice(),
      direction: ExchangeDirection.inbound,
      request: 'Now?',
      status: status,
    ).statusLabel;
    expect(labelOf(ExchangeStatus.working), isNull);
    expect(labelOf(ExchangeStatus.answered), isNull);
    expect(labelOf(ExchangeStatus.queued), 'queued');
    expect(labelOf(ExchangeStatus.stopped), 'stopped');
    expect(labelOf(ExchangeStatus.failed), 'couldn\u2019t answer');
  });

  test('a message to another Bot sits among the sends in order', () {
    final lines = projectRuns([generalRuns()[3]]);
    final ids = lines.map((line) => line.id).toList();
    expect(ids, [
      'codex:user',
      'codex:send:0',
      'codex:exchange:tool-2',
      'codex:send:1',
      'codex:assistant',
    ]);
    final exchange = lines[2].exchange!;
    expect(exchange.direction, ExchangeDirection.outbound);
    expect(exchange.counterpart.botId, 'codex-watch');
    expect(exchange.counterpart.name, isNull);
    expect(exchange.reply, startsWith('Done.'));
    expect(exchange.status, ExchangeStatus.answered);
    final open = projectRuns([generalRuns().last]);
    expect(open[1].exchange!.status, ExchangeStatus.working);
    expect(open[1].exchange!.reply, isNull);
  });

  test('a refused message is a failed exchange with no answer', () {
    final lines = projectRuns([
      chatRun(
        id: 'r',
        at: '2026-09-16T00:20:00.000Z',
        input: 'Ask',
        events: [
          toBot('tool-1', 'Hello?'),
          result('tool-1', 'bot_message was refused', error: true),
        ],
      ),
    ]);
    expect(lines[1].exchange!.status, ExchangeStatus.failed);
    expect(lines[1].exchange!.reply, isNull);
  });

  test('the pair chat holds both directions, oldest first', () {
    final runs = generalRuns()
      ..add(
        chatRun(
          id: 'ask-xero',
          at: '2026-09-16T01:00:00.000Z',
          input: 'Ask Xero what is overdue',
          events: [
            toBot('tool-1', 'What is overdue?', botId: 'xero-books'),
            result('tool-1', '\$88,550 across four invoices.'),
          ],
        ),
      );
    final exchanges = projectExchanges(
      runs,
      const ExchangeCounterpart.bot(botId: 'xero-books', name: 'Xero Books'),
    );
    expect(exchanges, hasLength(5));
    expect(exchanges.first.request, startsWith('4 Sep'));
    expect(exchanges.last.direction, ExchangeDirection.outbound);
    expect(exchanges.last.reply, '\$88,550 across four invoices.');
    expect(
      projectExchanges(runs, const ExchangeCounterpart.voice()),
      hasLength(1),
    );
  });

  testWidgets('two messages in one Turn are two rows', (tester) async {
    tester.view.physicalSize = const Size(390, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    // Both messages carry their Turn's admission time, so only their own
    // identity tells the two rows apart.
    final exchanges = projectExchanges([
      chatRun(
        id: 'twice',
        at: '2026-09-16T01:00:00.000Z',
        input: 'Ask Xero twice',
        events: [
          toBot('tool-1', 'What is overdue?', botId: 'xero-books'),
          result('tool-1', 'Four invoices.'),
          toBot('tool-2', 'Which is oldest?', botId: 'xero-books'),
          result('tool-2', 'The 4 Sep one.'),
        ],
      ),
    ], const ExchangeCounterpart.bot(botId: 'xero-books', name: 'Xero Books'));
    expect(exchanges.map((e) => e.request), [
      'What is overdue?',
      'Which is oldest?',
    ]);
    expect(exchanges.map((e) => e.id).toSet(), hasLength(2));
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ExchangeView(
            self: const ExchangeParty(name: 'General', background: 'hot-pink'),
            counterpart: const ExchangeCounterpart.bot(
              botId: 'xero-books',
              name: 'Xero Books',
            ),
            counterpartBackground: 'electric-blue',
            exchanges: exchanges,
            clock: clock,
          ),
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 400));
    expect(tester.takeException(), isNull);
    expect(find.text('What is overdue?'), findsOneWidget);
    expect(find.text('Which is oldest?'), findsOneWidget);
  });

  test('exchange times read as a person says them', () {
    expect(formatExchangeTime('2026-09-16T00:14:00.000Z', clock), isNot(''));
    final local = DateTime(2026, 9, 16, 8, 14).toUtc().toIso8601String();
    expect(formatExchangeTime(local, clock), 'Today 8:14 am');
    final yesterday = DateTime(2026, 9, 15, 22, 5).toUtc().toIso8601String();
    expect(formatExchangeTime(yesterday, clock), 'Yesterday 10:05 pm');
    final week = DateTime(2026, 9, 12, 12, 0).toUtc().toIso8601String();
    expect(formatExchangeTime(week, clock), 'Sat 12:00 pm');
    final older = DateTime(2026, 9, 4, 8, 31).toUtc().toIso8601String();
    expect(formatExchangeTime(older, clock), 'Fri, Sep 4 8:31 am');
    final lastYear = DateTime(2025, 12, 24, 17, 0).toUtc().toIso8601String();
    expect(formatExchangeTime(lastYear, clock), 'Dec 24, 2025 5:00 pm');
    expect(formatExchangeTime(null), '');
  });

  for (final width in [390.0, 1200.0]) {
    for (final brightness in Brightness.values) {
      testWidgets('thread markers at $width in ${brightness.name}', (
        tester,
      ) async {
        tester.view.physicalSize = Size(width, 1800);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final boundary = GlobalKey();
        final opened = <TranscriptLine>[];
        await tester.pumpWidget(
          MaterialApp(
            theme: FrockTheme.theme(brightness),
            home: RepaintBoundary(
              key: boundary,
              child: Scaffold(
                body: Row(
                  children: [
                    Expanded(
                      child: Center(
                        child: ConstrainedBox(
                          constraints: const BoxConstraints(maxWidth: 860),
                          child: TranscriptView(
                            lines: projectRuns(generalRuns()),
                            loading: false,
                            hasEarlier: false,
                            background: 'hot-pink',
                            backgroundOf: backgroundOf,
                            nameOf: nameOf,
                            onRefresh: ({older = false}) async {},
                            onOpenRun: (_) {},
                            onOpenExchange: opened.add,
                            storageKey: 'exchange-visual',
                          ),
                        ),
                      ),
                    ),
                    if (width >= 600) ...[
                      const VerticalDivider(width: 1),
                      SizedBox(
                        width: 380,
                        child: ExchangeView(
                          self: const ExchangeParty(
                            name: 'General',
                            background: 'hot-pink',
                          ),
                          counterpart: const ExchangeCounterpart.bot(
                            botId: 'xero-books',
                            name: 'Xero Books',
                          ),
                          counterpartBackground: 'electric-blue',
                          exchanges: projectExchanges(
                            generalRuns(),
                            const ExchangeCounterpart.bot(
                              botId: 'xero-books',
                              name: 'Xero Books',
                            ),
                          ),
                          onClose: () {},
                          clock: clock,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ),
        );
        await tester.pump(const Duration(milliseconds: 400));
        expect(find.text('Messaged'), findsNWidgets(2));
        expect(find.text('Message from'), findsNWidgets(5));
        expect(find.text('Codex Watch'), findsOneWidget);
        expect(find.text('Voice'), findsOneWidget);
        expect(find.textContaining('· working'), findsNothing);
        expect(find.textContaining('Private scratch'), findsNothing);
        expect(
          find.descendant(
            of: find.byType(TranscriptView),
            matching: find.textContaining('Please file a brief'),
          ),
          findsNothing,
        );
        expect(tester.takeException(), isNull);
        await capture(
          tester,
          boundary,
          'thread-${width.toInt()}-${brightness.name}',
        );
        await tester.tap(find.text('Codex Watch'));
        await tester.pump();
        expect(opened.single.exchange!.counterpart.botId, 'codex-watch');
      });

      testWidgets('exchange view at $width in ${brightness.name}', (
        tester,
      ) async {
        final panel = width < 600;
        tester.view.physicalSize = Size(panel ? width : 380, 900);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final boundary = GlobalKey();
        const counterpart = ExchangeCounterpart.bot(
          botId: 'xero-books',
          name: 'Xero Books',
        );
        const self = ExchangeParty(name: 'General', background: 'hot-pink');
        final exchanges = projectExchanges(generalRuns(), counterpart);
        await tester.pumpWidget(
          MaterialApp(
            theme: FrockTheme.theme(brightness),
            home: RepaintBoundary(
              key: boundary,
              child: panel
                  ? Scaffold(
                      appBar: AppBar(
                        titleSpacing: 0,
                        title: const ExchangeTitle(
                          self: self,
                          counterpart: counterpart,
                          counterpartBackground: 'electric-blue',
                        ),
                      ),
                      body: ExchangeView(
                        self: self,
                        counterpart: counterpart,
                        counterpartBackground: 'electric-blue',
                        exchanges: exchanges,
                        header: false,
                        clock: clock,
                      ),
                    )
                  : Scaffold(
                      body: ExchangeView(
                        self: self,
                        counterpart: counterpart,
                        counterpartBackground: 'electric-blue',
                        exchanges: exchanges,
                        onClose: () {},
                        clock: clock,
                      ),
                    ),
            ),
          ),
        );
        await tester.pump(const Duration(milliseconds: 400));
        expect(find.text('This chat is view-only'), findsOneWidget);
        expect(find.text('Xero Books'), findsWidgets);
        expect(find.textContaining('Filed Todoist Inbox note'), findsWidgets);
        expect(tester.takeException(), isNull);
        await capture(
          tester,
          boundary,
          'exchange-${width.toInt()}-${brightness.name}',
        );
      });
    }
  }
}
