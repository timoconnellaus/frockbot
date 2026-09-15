import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/shell/transcript.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

Map<String, dynamic> voiceRun({
  String status = 'completed',
  bool queued = false,
  bool reply = true,
}) => {
  'runId': 'voice-request',
  'input': 'What changed in the morning report?',
  'status': status,
  'queued': queued,
  'admittedAt': '2026-09-13T12:00:00.000Z',
  'via': {'kind': 'voice'},
  'events': <Object?>[
    {'type': 'model/text-delta', 'text': 'Private scratch'},
    if (reply)
      {
        'type': 'reply/to-caller',
        'caller': 'voice',
        'text': 'The report now includes the overnight orders and the revised delivery dates.',
      },
  ],
};

Map<String, dynamic> chatRun(int index) => {
  'runId': 'chat-$index',
  'input': 'Question number $index about the morning report',
  'status': 'completed',
  'admittedAt': '2026-09-13T12:${index.toString().padLeft(2, '0')}:00.000Z',
  'events': <Object?>[
    {
      'type': 'send/to-user',
      'ordinal': 0,
      'payload': {
        'type': 'text',
        'text':
            'Answer number $index. It runs long enough to push the voice card '
            'well above the first screen of the thread, so the card is mounted '
            'for the first time only once the list has been scrolled.',
      },
    },
  ],
};

void main() {
  setUpAll(() async {
    final inter = FontLoader('Inter');
    for (final weight in [400, 500, 600, 700]) {
      inter.addFont(rootBundle.load('assets/fonts/inter-latin-$weight.ttf'));
    }
    await inter.load();
    await (FontLoader(
      'MaterialIcons',
    )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
  });
  test(
    'projects a voice request and only its addressed answer as one exchange',
    () {
      final source = voiceRun();
      (source['events'] as List).add({
        'type': 'send/to-user',
        'ordinal': 0,
        'payload': {'type': 'text', 'text': 'A separate update for you'},
      });
      final lines = projectRuns([source]);
      expect(lines, hasLength(2));
      expect(lines.where((line) => line.role == LineRole.user), isEmpty);
      expect(lines.first.voiceExchange!.status, VoiceExchangeStatus.answered);
      expect(lines.first.voiceExchange!.reply, startsWith('The report now'));
      expect(
        lines.last.sends.single.payload!['text'],
        'A separate update for you',
      );
      expect(lines.first.text, isEmpty);
    },
  );

  test(
    'queued voice work does not pretend to stop the active routine or chat',
    () {
      final lines = projectRuns([
        voiceRun(status: 'running', queued: true, reply: false),
      ]);
      expect(lines.single.voiceExchange!.status, VoiceExchangeStatus.queued);
      expect(
        supersedeDrainState(lines, DateTime.utc(2026, 9, 13, 12, 2)),
        SupersedeDrainState.none,
      );
      expect(
        projectRuns([voiceRun(status: 'running', reply: false)])
            .single
            .voiceExchange!
            .status,
        VoiceExchangeStatus.working,
      );
      expect(
        projectRuns([voiceRun(reply: false)]).single.voiceExchange!.status,
        VoiceExchangeStatus.failed,
      );
    },
  );

  for (final width in [360.0, 1200.0]) {
    for (final brightness in Brightness.values) {
      testWidgets('voice exchange at $width in ${brightness.name}', (
        tester,
      ) async {
        tester.view.physicalSize = Size(width, 900);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final boundary = GlobalKey();
        final reads = <String?>[];
        await tester.pumpWidget(
          MaterialApp(
            theme: FrockTheme.theme(brightness),
            home: RepaintBoundary(
              key: boundary,
              child: Scaffold(
                body: TranscriptView(
                  lines: projectRuns([voiceRun()]),
                  loading: false,
                  hasEarlier: false,
                  onRefresh: ({older = false}) async {},
                  onOpenRun: (_) {},
                  onReadLatest: reads.add,
                  storageKey: 'voice-visual',
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text('Voice session'), findsOneWidget);
        expect(find.byIcon(Icons.graphic_eq_rounded), findsOneWidget);
        expect(find.text('Request to Bot'), findsOneWidget);
        expect(find.text('Reply to voice'), findsOneWidget);
        expect(find.text('Answered'), findsOneWidget);
        expect(find.text('Played'), findsNothing);
        expect(find.textContaining('Private scratch'), findsNothing);
        expect(reads.whereType<String>(), isEmpty);
        expect(tester.takeException(), isNull);
        final card = tester.getRect(
          find.byKey(const ValueKey('voice-exchange:voice-request')),
        );
        expect(card.left, greaterThanOrEqualTo(0));
        expect(card.right, lessThanOrEqualTo(width));
        // Optional review artifacts, kept outside the repository.
        const output = String.fromEnvironment('VOICE_VISUAL_OUTPUT');
        if (output.isNotEmpty) {
          await tester.runAsync(() async {
            final image =
                await (boundary.currentContext!.findRenderObject()!
                        as RenderRepaintBoundary)
                    .toImage(pixelRatio: 1);
            final bytes = await image.toByteData(
              format: ui.ImageByteFormat.png,
            );
            await File('$output/voice-${width.toInt()}-${brightness.name}.png')
                .writeAsBytes(bytes!.buffer.asUint8List());
            image.dispose();
          });
        }
        await tester.tap(find.text('Voice session'));
        await tester.pumpAndSettle();
        expect(find.text('Reply to voice'), findsNothing);
      });
    }
  }

  testWidgets('a voice card keeps its expanded flag out of the scroll slot', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(400, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    // The exchange sits above a long tail of chat, so its card mounts for the
    // first time only after a scroll — the point at which the list has already
    // saved its offset. Both used to name the same page storage entry, so the
    // tile read that double back as its expanded flag and threw on mount,
    // which a release build paints as a grey box over the whole thread.
    final lines = projectRuns([
      voiceRun(),
      for (var index = 1; index <= 14; index++) chatRun(index),
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
            onReadLatest: (_) {},
            storageKey: 'voice-storage',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Voice session'), findsNothing);

    await tester.dragUntilVisible(
      find.text('Voice session'),
      find.byType(ListView),
      const Offset(0, 300),
    );
    await tester.pumpAndSettle();

    expect(tester.takeException(), isNull);
    expect(find.text('Voice session'), findsOneWidget);
    expect(find.text('Reply to voice'), findsOneWidget);
  });
}
