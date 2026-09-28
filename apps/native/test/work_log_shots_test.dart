/// The review still for the Work log, kept outside the repository:
/// `--dart-define=CHAT_SHOTS=<dir>`. Without a directory the scene is
/// skipped: it draws, it does not assert.
library;

import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart' show FontLoader, rootBundle;
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_client/shell/chat_header.dart';
import 'package:frockbot_client/theme/frock_theme.dart';
import 'package:frockbot_client/work_log/page.dart';

import 'native_session.dart';
import 'widget_test.dart' show MemoryStore;

const _out = String.fromEnvironment('CHAT_SHOTS');

/// A monospaced face the host has, standing in for the platform's.
const _mono = String.fromEnvironment(
  'CHAT_SHOTS_MONO',
  defaultValue: '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
);
final _boundary = GlobalKey();

var _second = 0;
Map<String, Object?> _e(
  String kind,
  String title, {
  int step = 1,
  int gap = 1,
  Map<String, Object?> more = const {},
}) {
  _second += gap;
  final at = DateTime.utc(
    2026,
    9,
    28,
    9,
    14,
    18,
  ).add(Duration(seconds: _second));
  return {
    'seq': _second,
    'at': at.toIso8601String().replaceFirst(RegExp(r'\.\d+Z$'), '.000Z'),
    'kind': kind,
    'step': step,
    'title': title,
    ...more,
  };
}

Map<String, Object?> _tokens(int input, int cached, int output) => {
  'input': input,
  'cachedInput': cached,
  'output': output,
  'reasoning': 0,
};

Map<String, Object?> _totals({
  required int steps,
  required int tools,
  required int jev,
  int retries = 0,
  int input = 0,
  int output = 0,
}) => {
  'steps': steps,
  'modelRequests': steps,
  'inputTokens': input,
  'cachedInputTokens': 0,
  'outputTokens': output,
  'reasoningTokens': 0,
  'toolCalls': tools,
  'toolErrors': 0,
  'jevChecks': jev,
  'retries': retries,
  'computerMs': 0,
};

Map<String, Object?> _page() {
  _second = 0;
  final newest = [
    _e(
      'compaction',
      'Compacted turns 1–38',
      step: 0,
      more: {
        'detail': '9 names kept verbatim',
        'durationMs': 4100,
        'beforeTurn': true,
      },
    ),
    _e(
      'input',
      'Find a free Thursday evening and book Diggies for four',
      step: 0,
    ),
    _e(
      'jev',
      'Turn read',
      step: 0,
      more: {
        'label': 'Turn read',
        'verdict': 'Moderate',
        'detail': 'moderate · consequence 3 · needs web',
        'durationMs': 180,
      },
    ),
    _e(
      'memory',
      'Recalled 3 facts',
      step: 0,
      more: {
        'detail': 'Sam is vegetarian · prefers 7 pm · Diggies is the usual',
        'durationMs': 36,
      },
    ),
    _e(
      'model',
      'Checking Thursday on the calendar',
      more: {
        'label': 'Request #1',
        'detail': '1 tool call',
        'durationMs': 1840,
        'tokens': _tokens(14210, 11980, 188),
      },
    ),
    _e(
      'jev',
      'Step review',
      more: {
        'label': 'Step review',
        'verdict': 'Release',
        'detail': 'release · 1 call allowed',
        'durationMs': 140,
      },
    ),
    _e(
      'tool',
      'calendar/freebusy',
      more: {'detail': 'Free after 6:00 pm', 'durationMs': 412},
    ),
    _e(
      'retry',
      'Model call retried',
      step: 2,
      more: {
        'detail': 'transient · attempt 2 · waited 2.0 s',
        'durationMs': 2000,
      },
    ),
    _e(
      'model',
      'Diggies has 7:00 free. Booking it once you say yes.',
      step: 2,
      gap: 2,
      more: {
        'label': 'Request #2',
        'detail': '2 tool calls',
        'durationMs': 2004,
        'tokens': _tokens(14550, 12440, 246),
        'fields': [
          {'label': 'Provider', 'value': 'Frock AI'},
          {'label': 'Messages', 'value': '9'},
          {'label': 'Tools offered', 'value': '14'},
        ],
        'sections': [
          {
            'label': 'What the model said',
            'text': 'Diggies has 7:00 free. Booking it once you say yes — a table for four, one vegetarian.',
            'tab': 'output',
          },
          {
            'label': 'Tool calls',
            'text': 'opentable/search\nopentable/book',
            'mono': true,
            'tab': 'tools',
          },
          {
            'label': 'System prompt',
            'text': 'You are Pixel, Tim’s Bot…',
            'tab': 'prompt',
          },
        ],
      },
    ),
    _e(
      'tool',
      'opentable/search',
      step: 2,
      more: {'detail': 'Thu: 6:30, 7:00, 8:15 pm', 'durationMs': 1203},
    ),
    _e(
      'jev',
      'Call review · opentable/book',
      step: 2,
      more: {
        'label': 'Call review',
        'verdict': 'Allow',
        'detail': 'allow · books with a third party',
        'durationMs': 212,
      },
    ),
    _e(
      'send',
      'Asked you to approve: Book Diggies, Thu 7 pm, 4 people',
      step: 2,
      more: {'detail': 'approved by you in 14.0 s'},
    ),
    _e(
      'tool',
      'opentable/book',
      step: 2,
      gap: 14,
      more: {'detail': 'Confirmed · ref DG-48213', 'durationMs': 2410},
    ),
    _e(
      'model',
      'Booked Diggies for Thursday at 7, table for four.',
      step: 3,
      gap: 3,
      more: {
        'label': 'Request #3',
        'detail': 'no tool calls',
        'durationMs': 1210,
        'tokens': _tokens(15030, 13100, 96),
      },
    ),
    _e(
      'jev',
      'Final reply review',
      step: 3,
      more: {'verdict': 'Release', 'detail': 'release', 'durationMs': 118},
    ),
    _e(
      'memory',
      'Saved a memory',
      step: 3,
      more: {'detail': 'log · user · Diggies booked Thu 1 Oct'},
    ),
  ];
  return {
    'schemaVersion': 1,
    'turns': [
      {
        'runId': 'run-42',
        'at': '2026-09-28T09:14:18.000Z',
        'status': 'completed',
        'via': 'You',
        'input': 'Find a free Thursday evening and book Diggies for four',
        'turn': 42,
        'durationMs': 38200,
        'outcome': 'Completed',
        'totals': _totals(
          steps: 3,
          tools: 3,
          jev: 4,
          retries: 1,
          input: 43790,
          output: 530,
        ),
        'entries': newest,
      },
      {
        'runId': 'run-41',
        'at': '2026-09-28T07:00:00.000Z',
        'status': 'completed',
        'via': 'Routine',
        'input': 'Morning brief',
        'turn': 41,
        'durationMs': 21400,
        'outcome': 'Completed',
        'totals': _totals(
          steps: 3,
          tools: 6,
          jev: 4,
          input: 31020,
          output: 690,
        ),
        'entries': [
          {
            'seq': 1,
            'at': '2026-09-28T07:00:01.000Z',
            'kind': 'model',
            'step': 1,
            'title': 'Pulling the calendar and the weather',
            'durationMs': 1500,
          },
          {
            'seq': 2,
            'at': '2026-09-28T07:00:03.000Z',
            'kind': 'tool',
            'step': 1,
            'title': 'weather/today',
            'durationMs': 900,
            'isError': true,
            'detail': 'timed out',
          },
        ],
      },
    ],
  };
}

void main() {
  testWidgets('the Work log, with a model request open', (tester) async {
    if (_out.isEmpty) return;
    await tester.runAsync(() async {
      final inter = FontLoader(interFontFamily);
      for (final weight in [400, 500, 600, 700]) {
        inter.addFont(
          rootBundle.load(
            'packages/frockbot_client/assets/fonts/inter-latin-$weight.ttf',
          ),
        );
      }
      await inter.load();
      await (FontLoader(
        'MaterialIcons',
      )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
      final mono = await File(_mono).readAsBytes();
      await (FontLoader(
        'monospace',
      )..addFont(Future.value(ByteData.sublistView(mono)))).load();
    });
    // 16:9, the frame the What’s New card draws.
    tester.view.physicalSize = const Size(2560, 1440);
    tester.view.devicePixelRatio = 2;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final api = NativeSessionApi(MemoryStore(), (_, _) async => _page());
    addTearDown(api.close);
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: FrockTheme.theme(Brightness.dark),
        home: RepaintBoundary(
          key: _boundary,
          child: Scaffold(
            body: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                ChatHeader(name: 'Pixel', view: 'work-log', onView: (_) {}),
                Expanded(
                  child: WorkLogView(api: api, botId: 'pixel'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    final row = find.text(
      'Diggies has 7:00 free. Booking it once you say yes.',
    );
    await tester.ensureVisible(row);
    await tester.pumpAndSettle();
    await tester.tap(row);
    await tester.pumpAndSettle();
    await tester.runAsync(() async {
      final image =
          await (_boundary.currentContext!.findRenderObject()!
                  as RenderRepaintBoundary)
              .toImage(pixelRatio: 2);
      final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
      await File('$_out/work-log.png')
          .writeAsBytes(bytes!.buffer.asUint8List());
      image.dispose();
    });
  });
}
