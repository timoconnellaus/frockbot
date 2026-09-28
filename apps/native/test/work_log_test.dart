import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_client/client/transport.dart';
import 'package:frockbot_client/protocol/client_wire.generated.dart' as wire;
import 'package:frockbot_client/theme/frock_theme.dart';
import 'package:frockbot_client/work_log/page.dart';

import 'native_session.dart';
import 'widget_test.dart' show MemoryStore;

Map<String, Object?> entry(
  int seq,
  String kind,
  String title, {
  int step = 1,
  String? detail,
  int? durationMs,
  bool? isError,
  Map<String, Object?>? tokens,
  List<Map<String, Object?>>? fields,
  List<Map<String, Object?>>? sections,
}) => {
  'seq': seq,
  'at': '2026-09-28T09:14:${(18 + seq).toString().padLeft(2, '0')}.000Z',
  'kind': kind,
  'step': step,
  'title': title,
  'detail': ?detail,
  'durationMs': ?durationMs,
  'isError': ?isError,
  'tokens': ?tokens,
  'fields': ?fields,
  'sections': ?sections,
};

/// The shape `readWorkLogV1` produces, written by hand so the Flutter side
/// is pinned to the projection's contract.
Map<String, Object?> workLogPage({String? cursor}) => {
  'schemaVersion': 1,
  'turns': [
    {
      'runId': 'run-42',
      'at': '2026-09-28T09:14:18.000Z',
      'status': 'completed',
      'via': 'You',
      'input': 'Find a free Thursday evening and book Diggies for 4',
      'turn': 42,
      'durationMs': 38200,
      'outcome': 'Completed',
      'totals': {
        'steps': 1,
        'modelRequests': 1,
        'inputTokens': 14210,
        'cachedInputTokens': 11980,
        'outputTokens': 188,
        'reasoningTokens': 0,
        'toolCalls': 1,
        'toolErrors': 0,
        'jevChecks': 1,
        'retries': 0,
        'computerMs': 0,
      },
      'entries': [
        entry(0, 'input', 'Find a free Thursday evening', step: 0),
        entry(
          1,
          'model',
          'Checking Thursday.',
          detail: '1 tool call',
          durationMs: 1840,
          tokens: {
            'input': 14210,
            'cachedInput': 11980,
            'output': 188,
            'reasoning': 0,
          },
          fields: [
            {'label': 'Provider', 'value': 'Frock AI'},
          ],
        ),
        entry(
          2,
          'jev',
          'Call review · calendar_freebusy',
          detail: 'allow',
          durationMs: 212,
        ),
        entry(
          3,
          'tool',
          'calendar_freebusy',
          detail: 'Free after 6:00 pm',
          durationMs: 412,
          sections: [
            {'label': 'Input', 'text': '{"day": "Thu"}', 'mono': true},
            {'label': 'Result', 'text': 'Free after 6:00 pm', 'mono': true},
          ],
        ),
      ],
    },
    {
      'runId': 'run-41',
      'at': '2026-09-28T07:00:00.000Z',
      'status': 'failed',
      'via': 'Routine',
      'input': 'Morning brief',
      'turn': 41,
      'outcome': 'A tool failed',
      'totals': {
        'steps': 1,
        'modelRequests': 0,
        'inputTokens': 0,
        'cachedInputTokens': 0,
        'outputTokens': 0,
        'reasoningTokens': 0,
        'toolCalls': 1,
        'toolErrors': 1,
        'jevChecks': 0,
        'retries': 0,
        'computerMs': 0,
      },
      'entries': [
        entry(0, 'tool', 'weather.today', detail: 'timed out', isError: true),
      ],
    },
  ],
  'nextCursor': ?cursor,
};

Widget host(NativeApi api) => MaterialApp(
  theme: FrockTheme.theme(Brightness.dark),
  home: WorkLogPage(api: api, botId: 'pixel', botName: 'Pixel'),
);

void main() {
  test('the page reads its fixture through the generated decoder', () {
    final page = wire.WorkLogPage.fromJson(workLogPage(cursor: 'c'));
    expect(page.turns, hasLength(2));
    expect(workLogPathV1('pixel'), '/api/bots/pixel/work-log');
    expect(
      workLogPathV1('pixel', before: 'run-index:a:b'),
      '/api/bots/pixel/work-log?before=run-index%3Aa%3Ab',
    );
    expect(workLogDuration(412), '412 ms');
    expect(workLogDuration(38200), '38.2 s');
    expect(workLogDuration(64000), '1 m 4 s');
    expect(workLogTokens(14210), '14.2k');
  });

  testWidgets('the newest Turn is open, step by step, and older ones fold', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1400, 1000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final paths = <String>[];
    final api = NativeSessionApi(MemoryStore(), (path, _) async {
      paths.add(path);
      return workLogPage();
    });
    addTearDown(api.close);
    await tester.pumpWidget(host(api));
    await tester.pumpAndSettle();
    expect(paths, ['/api/bots/pixel/work-log']);
    expect(find.text('Work log'), findsOneWidget);
    expect(find.text('Turn 42'), findsOneWidget);
    expect(find.text('Step 1'), findsOneWidget);
    expect(find.text('Checking Thursday.'), findsOneWidget);
    expect(find.text('calendar_freebusy'), findsOneWidget);
    // The older Turn is folded to its header.
    expect(find.text('Turn 41'), findsOneWidget);
    expect(find.text('A tool failed'), findsOneWidget);
    expect(find.text('weather.today'), findsNothing);
    await tester.tap(find.text('Turn 41'));
    await tester.pumpAndSettle();
    expect(find.text('weather.today'), findsOneWidget);
  });

  testWidgets('a row opens beside the log when there is room', (tester) async {
    tester.view.physicalSize = const Size(1400, 1000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final api = NativeSessionApi(MemoryStore(), (_, _) async => workLogPage());
    addTearDown(api.close);
    await tester.pumpWidget(host(api));
    await tester.pumpAndSettle();
    expect(find.text('Pick a row to see it in full.'), findsOneWidget);
    await tester.tap(find.text('calendar_freebusy'));
    await tester.pumpAndSettle();
    expect(find.byType(WorkLogInspector), findsOneWidget);
    expect(find.text('INPUT'), findsWidgets);
    expect(find.text('{"day": "Thu"}'), findsOneWidget);
    expect(find.text('412 ms'), findsWidgets);
  });

  testWidgets('on a phone a row is a page of its own', (tester) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final api = NativeSessionApi(MemoryStore(), (_, _) async => workLogPage());
    addTearDown(api.close);
    await tester.pumpWidget(host(api));
    await tester.pumpAndSettle();
    expect(find.text('Pick a row to see it in full.'), findsNothing);
    await tester.tap(find.text('Checking Thursday.'));
    await tester.pumpAndSettle();
    expect(find.byType(WorkLogInspector), findsOneWidget);
    expect(find.text('Frock AI'), findsOneWidget);
    expect(find.text('14.2k'), findsOneWidget);
  });

  testWidgets('filters and search narrow the rows, across folded Turns', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1400, 1000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final api = NativeSessionApi(MemoryStore(), (_, _) async => workLogPage());
    addTearDown(api.close);
    await tester.pumpWidget(host(api));
    await tester.pumpAndSettle();

    await tester.tap(find.widgetWithText(ChoiceChip, 'Tools'));
    await tester.pumpAndSettle();
    expect(find.text('Checking Thursday.'), findsNothing);
    expect(find.text('calendar_freebusy'), findsOneWidget);
    expect(find.text('weather.today'), findsOneWidget);

    await tester.tap(find.widgetWithText(ChoiceChip, 'Errors'));
    await tester.pumpAndSettle();
    expect(find.text('calendar_freebusy'), findsNothing);
    expect(find.text('weather.today'), findsOneWidget);

    await tester.tap(find.widgetWithText(ChoiceChip, 'All'));
    await tester.enterText(find.byType(TextField), 'thursday');
    await tester.pumpAndSettle();
    expect(find.text('Checking Thursday.'), findsOneWidget);
    expect(find.text('calendar_freebusy'), findsNothing);
    expect(find.text('Turn 41'), findsNothing);
  });

  testWidgets('earlier Turns load from the cursor', (tester) async {
    tester.view.physicalSize = const Size(1400, 1000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final paths = <String>[];
    final api = NativeSessionApi(MemoryStore(), (path, _) async {
      paths.add(path);
      return path.contains('before=')
          ? {'schemaVersion': 1, 'turns': <Object?>[]}
          : workLogPage(cursor: 'run-index:c');
    });
    addTearDown(api.close);
    await tester.pumpWidget(host(api));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Show earlier Turns'));
    await tester.tap(find.text('Show earlier Turns'));
    await tester.pumpAndSettle();
    expect(paths.last, '/api/bots/pixel/work-log?before=run-index%3Ac');
    expect(find.text('Show earlier Turns'), findsNothing);
  });

  testWidgets('a running Turn, a Routine included, can be stopped from here', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1400, 1000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    var stopped = false;
    final bodies = <String, Object?>{};
    Map<String, Object?> page() {
      final fixture = workLogPage();
      final turns = [...fixture['turns']! as List<Object?>];
      turns[1] = {
        ...turns[1]! as Map<String, Object?>,
        'status': stopped ? 'cancelled' : 'running',
      }..remove('outcome');
      return {...fixture, 'turns': turns};
    }

    final api = NativeSessionApi(MemoryStore(), (path, body) async {
      if (path.endsWith('/stop')) {
        bodies[path] = body;
        stopped = true;
        return <String, Object?>{};
      }
      return page();
    });
    addTearDown(api.close);
    await tester.pumpWidget(host(api));
    await tester.pumpAndSettle();

    // The finished Turn offers nothing to stop; the running Routine does.
    expect(find.widgetWithText(TextButton, 'Stop'), findsOneWidget);
    await tester.tap(find.widgetWithText(TextButton, 'Stop'));
    await tester.pumpAndSettle();

    final sent = bodies['/api/bots/pixel/turns/run-41/stop']!;
    expect(sent, isA<Map<String, Object?>>());
    expect(sent, containsPair('action', 'stop'));
    expect(sent, containsPair('runId', 'run-41'));
    expect(find.widgetWithText(TextButton, 'Stop'), findsNothing);
    expect(find.text('Stopped'), findsOneWidget);
  });

  testWidgets('a Work log that will not load says so and retries', (
    tester,
  ) async {
    var fail = true;
    final api = NativeSessionApi(MemoryStore(), (_, _) async {
      if (fail) throw Exception('offline');
      return workLogPage();
    });
    addTearDown(api.close);
    await tester.pumpWidget(host(api));
    await tester.pumpAndSettle();
    expect(find.text('The Work log couldn’t load'), findsOneWidget);
    fail = false;
    await tester.tap(find.text('Try again'));
    await tester.pumpAndSettle();
    expect(find.text('Turn 42'), findsOneWidget);
  });
}
