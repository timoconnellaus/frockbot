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
import 'package:frockbot_client/theme/frock_theme.dart';
import 'package:frockbot_client/work_log/page.dart';

import 'native_session.dart';
import 'widget_test.dart' show MemoryStore;
import 'work_log_test.dart' show entry;

const _out = String.fromEnvironment('CHAT_SHOTS');

/// A monospaced face the host has, standing in for the platform's.
const _mono = String.fromEnvironment(
  'CHAT_SHOTS_MONO',
  defaultValue: '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
);
final _boundary = GlobalKey();

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

final _page = {
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
        jev: 6,
        retries: 1,
        input: 43790,
        output: 530,
      ),
      'entries': [
        entry(
          0,
          'input',
          'Find a free Thursday evening and book Diggies for four',
          step: 0,
        ),
        entry(
          1,
          'jev',
          'Turn read',
          step: 0,
          detail: 'moderate · consequence 3 · needs web',
          durationMs: 180,
        ),
        entry(
          2,
          'memory',
          'Recalled 3 facts',
          step: 0,
          detail: 'Sam is vegetarian · prefers 7 pm · Diggies is the usual',
          durationMs: 36,
        ),
        entry(
          3,
          'model',
          'Checking Thursday on the calendar',
          detail: '1 tool call',
          durationMs: 1840,
          tokens: _tokens(14210, 11980, 188),
        ),
        entry(
          4,
          'jev',
          'Step review',
          detail: 'release · 1 call allowed',
          durationMs: 140,
        ),
        entry(
          5,
          'tool',
          'calendar/freebusy',
          detail: 'Free after 6:00 pm',
          durationMs: 412,
        ),
        entry(
          6,
          'retry',
          'Model call retried',
          step: 2,
          detail: 'transient · attempt 2 · waited 2.0 s',
          durationMs: 2000,
        ),
        entry(
          7,
          'model',
          'Diggies has 7:00 free. Booking it once you say yes.',
          step: 2,
          detail: '2 tool calls',
          durationMs: 2004,
          tokens: _tokens(14550, 12440, 246),
          fields: [
            {'label': 'Provider', 'value': 'Frock AI'},
            {'label': 'Messages', 'value': '9'},
            {'label': 'Tools offered', 'value': '14'},
          ],
          sections: [
            {
              'label': 'What the model said',
              'text': 'Diggies has 7:00 free. Booking it once you say yes — a table for four, one vegetarian.',
            },
            {
              'label': 'Tool calls',
              'text': 'opentable/search\nopentable/book',
              'mono': true,
            },
          ],
        ),
        entry(
          8,
          'tool',
          'opentable/search',
          step: 2,
          detail: 'Thu: 6:30, 7:00, 8:15 pm',
          durationMs: 1203,
        ),
        entry(
          9,
          'jev',
          'Call review · opentable/book',
          step: 2,
          detail: 'allow · books with a third party',
          durationMs: 212,
        ),
        entry(
          10,
          'send',
          'Asked you to approve: Book Diggies, Thu 7 pm, 4 people',
          step: 2,
          detail: 'approved by you in 14.0 s',
        ),
        entry(
          11,
          'tool',
          'opentable/book',
          step: 2,
          detail: 'Confirmed · ref DG-48213',
          durationMs: 2410,
        ),
        entry(
          12,
          'model',
          'Booked Diggies for Thursday at 7, table for four.',
          step: 3,
          detail: 'no tool calls',
          durationMs: 1210,
          tokens: _tokens(15030, 13100, 96),
        ),
        entry(
          13,
          'jev',
          'Final reply review',
          step: 3,
          detail: 'release',
          durationMs: 118,
        ),
        entry(
          14,
          'memory',
          'Saved a memory',
          step: 3,
          detail: 'log · user · Diggies booked Thu 1 Oct',
        ),
      ],
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
      'totals': _totals(steps: 3, tools: 6, jev: 4, input: 31020, output: 690),
      'entries': [
        entry(
          0,
          'model',
          'Pulling the calendar and the weather',
          durationMs: 1500,
        ),
        entry(1, 'tool', 'weather/today', durationMs: 900),
      ],
    },
  ],
};

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

    final api = NativeSessionApi(MemoryStore(), (_, _) async => _page);
    addTearDown(api.close);
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: FrockTheme.theme(Brightness.dark),
        home: RepaintBoundary(
          key: _boundary,
          child: WorkLogPage(api: api, botId: 'pixel', botName: 'Pixel'),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(
      find.text('Diggies has 7:00 free. Booking it once you say yes.'),
    );
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
