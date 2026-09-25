import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/panels/plugin_page.dart';

void main() {
  group('what a Plugin page may say', () {
    test('hello, and a call to one of its own tools', () {
      expect(
        decodePluginPageMessageV1({'frockbotPage': 1, 'type': 'hello'}),
        isA<PluginPageHelloV1>(),
      );
      final call = decodePluginPageMessageV1({
        'frockbotPage': 1,
        'type': 'callTool',
        'callId': 'c1',
        'tool': 'record_move',
        'input': {'to': 'e4'},
      });
      expect(call, isA<PluginPageCallV1>());
      call as PluginPageCallV1;
      expect(
        [call.callId, call.tool, call.input],
        [
          'c1',
          'record_move',
          {'to': 'e4'},
        ],
      );
    });

    test('nothing else, and nothing with an extra key', () {
      for (final message in <Map<String, Object?>>[
        {'type': 'hello'},
        {'frockbotPage': 2, 'type': 'hello'},
        {'frockbotPage': 1, 'type': 'hello', 'extra': true},
        {'frockbotPage': 1, 'type': 'init'},
        {
          'frockbotPage': 1,
          'type': 'callTool',
          'callId': 'c1',
          'tool': 'Bad-Name',
          'input': {},
        },
        {
          'frockbotPage': 1,
          'type': 'callTool',
          'callId': 'c1',
          'tool': 'go',
          'input': [],
        },
        {'frockbotPage': 1, 'type': 'callTool', 'callId': 'c1', 'tool': 'go'},
      ]) {
        expect(decodePluginPageMessageV1(message), isNull, reason: '$message');
      }
    });
  });

  group('the host answers', () {
    Map<String, Object?> init() => {'type': 'init'};

    test('a tool call with its text, or the reason it did not run', () async {
      final ran = await pluginPageAnswerV1(
        const PluginPageCallV1('c1', 'score_add', {}),
        init: init,
        runTool: (tool, arguments) async =>
            PluginPageToolAnswerV1.ran('$tool $arguments'),
      );
      expect(ran, {
        'frockbotPage': 1,
        'type': 'result',
        'callId': 'c1',
        'ok': true,
        'output': 'score_add {}',
      });
      final refused = await pluginPageAnswerV1(
        const PluginPageCallV1('c2', 'score_add', {}),
        init: init,
        runTool: (tool, arguments) async =>
            const PluginPageToolAnswerV1.refused('Score is off for this Bot'),
      );
      expect(refused?['ok'], false);
      expect(refused?['error'], 'Score is off for this Bot');
    });

    test('an input past the command cap is refused without running', () async {
      var ran = false;
      final answer = await pluginPageAnswerV1(
        PluginPageCallV1('c1', 'score_add', {'blob': 'x' * 9000}),
        init: init,
        runTool: (tool, arguments) async {
          ran = true;
          return const PluginPageToolAnswerV1.ran('ran');
        },
      );
      expect(ran, isFalse);
      expect(answer?['ok'], false);
    });
  });

  group('PluginPageFrame', () {
    late ValueChanged<Map<String, Object?>> say;
    late VoidCallback loaded;
    late List<Map<String, Object?>> heard;
    late List<String> identities;

    PluginPageFrame frame(
      Map<String, Object?> state, {
      String url = 'https://ui.bot.example/packages/a.html',
      PluginPageToolRunnerV1? runTool,
      PluginPageReporterV1? onReport,
    }) => PluginPageFrame(
      url: url,
      state: state,
      pluginId: 'score',
      botId: 'bot-1',
      surfaceId: 'score',
      label: 'Score',
      onReport: onReport,
      runTool:
          runTool ??
          (tool, arguments) async => const PluginPageToolAnswerV1.ran('ok'),
      frameBuilder:
          (
            context, {
            required url,
            required label,
            required identity,
            required onMessage,
            required outbox,
            required onLoaded,
          }) {
            say = onMessage;
            loaded = onLoaded;
            identities.add(identity);
            return _Listening(outbox: outbox, heard: heard);
          },
    );

    setUp(() {
      heard = [];
      identities = [];
    });

    testWidgets('greets the page, then hands it each new state', (
      tester,
    ) async {
      await tester.pumpWidget(MaterialApp(home: frame({'score': 1})));
      // Nothing is posted before the page has said who is listening.
      await tester.pumpWidget(MaterialApp(home: frame({'score': 2})));
      expect(heard, isEmpty);
      say({'frockbotPage': 1, 'type': 'hello'});
      await tester.pump();
      expect(heard.single, containsPair('type', 'init'));
      expect(heard.single['state'], {'score': 2});
      expect(heard.single['themeTokens'], isA<Map<String, String>>());
      await tester.pumpWidget(MaterialApp(home: frame({'score': 3})));
      await tester.pump();
      expect(heard.last, {
        'frockbotPage': 1,
        'type': 'state',
        'state': {'score': 3},
      });
      // The same state again is not news.
      await tester.pumpWidget(MaterialApp(home: frame({'score': 3})));
      await tester.pump();
      expect(heard, hasLength(2));
      // New state keeps the same document: the frame's identity is its URL.
      expect(identities.toSet(), hasLength(1));
    });

    testWidgets('greets a document once it has loaded, asked or not', (
      tester,
    ) async {
      // A WebView forwards nothing a page says while it is still parsing, and
      // that is when the helper says hello, so the host cannot wait for it.
      await tester.pumpWidget(MaterialApp(home: frame({'score': 1})));
      expect(heard, isEmpty);
      loaded();
      await tester.pump();
      expect(heard.single, containsPair('type', 'init'));
      expect(heard.single['state'], {'score': 1});
      expect(
        heard.single['themeTokens'],
        containsPair('surface', isA<String>()),
      );
      // Greeted, it hears new state without saying anything.
      await tester.pumpWidget(MaterialApp(home: frame({'score': 2})));
      await tester.pump();
      expect(heard.last, containsPair('type', 'state'));
      // A hello that did get through is answered too: the helper takes the
      // first and is unharmed by the second.
      say({'frockbotPage': 1, 'type': 'hello'});
      await tester.pump();
      expect(heard.last, containsPair('type', 'init'));
    });

    testWidgets('covers the page until it has been greeted and has drawn', (
      tester,
    ) async {
      await tester.pumpWidget(MaterialApp(home: frame({'score': 1})));
      final cover = find.byKey(const ValueKey('plugin-page-cover'));
      expect(cover, findsOneWidget);
      loaded();
      await tester.pump();
      expect(cover, findsOneWidget);
      await tester.pump(pluginPageRevealDelayV1);
      expect(cover, findsNothing);
    });

    testWidgets('answers a tool call with a result naming it', (tester) async {
      final calls = <String>[];
      await tester.pumpWidget(
        MaterialApp(
          home: frame(
            {'score': 1},
            runTool: (tool, arguments) async {
              calls.add('$tool $arguments');
              return const PluginPageToolAnswerV1.ran('added');
            },
          ),
        ),
      );
      say({
        'frockbotPage': 1,
        'type': 'callTool',
        'callId': 'c7',
        'tool': 'score_add',
        'input': {'by': 1},
      });
      await tester.pump();
      expect(calls, ['score_add {"by":1}']);
      expect(heard.single, {
        'frockbotPage': 1,
        'type': 'result',
        'callId': 'c7',
        'ok': true,
        'output': 'added',
      });
    });

    testWidgets('passes on what the page reports, twenty a minute', (
      tester,
    ) async {
      final reports = <PluginPageReportV1>[];
      await tester.pumpWidget(
        MaterialApp(home: frame({}, onReport: reports.add)),
      );
      say({
        'frockbotPage': 1,
        'type': 'report',
        'level': 'error',
        'text': 'TypeError: a4 is undefined',
      });
      await tester.pump();
      expect(reports.single.level, 'error');
      expect(reports.single.text, 'TypeError: a4 is undefined');
      // A page that posts past the helper's own cap is not echoed.
      for (var index = 0; index < 40; index++) {
        say({
          'frockbotPage': 1,
          'type': 'report',
          'level': 'log',
          'text': 'level $index',
        });
      }
      await tester.pump();
      expect(reports, hasLength(pluginPageReportsPerMinuteV1));
      // Nothing else is a report, and nothing is posted back.
      say({'frockbotPage': 1, 'type': 'report', 'level': 'warn', 'text': 'x'});
      await tester.pump();
      expect(reports, hasLength(pluginPageReportsPerMinuteV1));
      expect(heard, isEmpty);
    });

    testWidgets('ignores what it does not understand', (tester) async {
      await tester.pumpWidget(MaterialApp(home: frame({})));
      say({'frockbotPage': 1, 'type': 'init'});
      say({'type': 'hello'});
      await tester.pump();
      expect(heard, isEmpty);
    });
  });
}

/// Stands in for the host frame: records what the host posts to the page.
class _Listening extends StatefulWidget {
  final Stream<Map<String, Object?>> outbox;
  final List<Map<String, Object?>> heard;
  const _Listening({required this.outbox, required this.heard});

  @override
  State<_Listening> createState() => _ListeningState();
}

class _ListeningState extends State<_Listening> {
  StreamSubscription<Map<String, Object?>>? _subscription;

  @override
  void initState() {
    super.initState();
    _subscription = widget.outbox.listen(widget.heard.add);
  }

  @override
  void dispose() {
    unawaited(_subscription?.cancel());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => const SizedBox.expand();
}
