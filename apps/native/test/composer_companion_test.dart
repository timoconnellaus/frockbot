import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart' show FontLoader, rootBundle;
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/chat_controller.dart';
import 'package:frockbot_native/flock/avatar.dart';
import 'package:frockbot_native/shell/chat_header.dart';
import 'package:frockbot_native/shell/chat_pane.dart';
import 'package:frockbot_native/theme/frock_theme.dart';
import 'package:frockbot_native/voice/dictation.dart';

import 'voice_shell_harness.dart';
import 'widget_test.dart' show FakeTransport, MemoryStore;

/// Optional review artifact, kept outside the repository:
/// `--dart-define=COMPANION_VISUAL_OUTPUT=<dir>`.
Future<void> capture(WidgetTester tester, String name) async {
  const output = String.fromEnvironment('COMPANION_VISUAL_OUTPUT');
  if (output.isEmpty) return;
  // The character is an asset image, decoded off the test's fake clock; give
  // it real time to land before the frame is read back.
  await tester.runAsync(() => Future<void>.delayed(const Duration(seconds: 1)));
  await tester.pump();
  await tester.runAsync(() async {
    final boundary = tester.firstRenderObject(
      find.byType(RepaintBoundary),
    ) as RenderRepaintBoundary;
    final image = await boundary.toImage(pixelRatio: 2);
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    await File('$output/$name.png').writeAsBytes(bytes!.buffer.asUint8List());
    image.dispose();
  });
}

void main() {
  const visual = String.fromEnvironment('COMPANION_VISUAL_OUTPUT');
  if (visual.isNotEmpty) {
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
  }
  for (final width in [390.0, 1280.0]) {
    testWidgets('the companion sits in the header band at $width', (
      tester,
    ) async {
      final harness = VoiceShellHarness();
      await harness.mount(tester, width: width, brightness: Brightness.dark);
      final companion = find.bySemanticsLabel('Bot is ready');
      expect(companion, findsOneWidget);
      // In the header's band, above the thread.
      expect(
        tester.getTopLeft(companion).dy,
        greaterThanOrEqualTo(
          width == 390 ? chatHeaderPhoneChromeTop : chatHeaderChromeTop,
        ),
      );
      expect(
        tester.getTopLeft(companion).dy,
        lessThan(chatHeaderChromeTop + 8),
      );
      // A phone's companion is smaller: the header shares a thumb-wide
      // screen with the thread.
      expect(
        tester.getSize(companion).height,
        chatCompanionSizeFor(phone: width == 390),
      );
      final field = find.byKey(const ValueKey('composer'));
      expect(
        tester.getBottomLeft(companion).dy,
        lessThan(tester.getTopLeft(field).dy),
      );
      // The header draws the companion; the composer is the field alone.
      expect(
        find.descendant(
          of: find.byType(ChatHeader),
          matching: find.byType(CharacterAvatar),
        ),
        findsOneWidget,
      );
      await capture(tester, 'composer-companion-${width.toInt()}');
      await harness.dispose(tester);
    });
  }

  for (final width in [390.0, 1280.0]) {
    testWidgets('typing leaves the companion in the header at $width', (
      tester,
    ) async {
      tester.view.physicalSize = Size(width, 800);
      tester.view.devicePixelRatio = 1;
      tester.view.padding = FakeViewPadding(bottom: width == 390 ? 34 : 0);
      addTearDown(tester.view.reset);
      final store = MemoryStore();
      final c = ChatController(
        transport: FakeTransport(store),
        store: store,
        userId: 'user-1',
        botId: 'bot-1',
        nextId: () => 'send-1',
      );
      await c.initialize();
      c.connection = ConnectionState.connected;
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: RepaintBoundary(
            child: Scaffold(
              body: ChatPane(
                controller: c,
                onReconnect: () async {},
                background: 'fox',
                onDictate: () {},
                onStopDictation: () {},
                onVoice: () {},
              ),
            ),
          ),
        ),
      );
      await tester.pump();

      final companion = find.bySemanticsLabel('Bot is ready');
      final field = find.byKey(const ValueKey('composer'));
      expect(companion, findsOneWidget);
      final restLeft = tester.getTopLeft(field).dx;
      final restTop = tester.getTopLeft(companion).dy;
      await capture(tester, 'companion-tuck-rest-${width.toInt()}');

      await tester.enterText(field, 'hello');
      await tester.pump();
      await tester.pump(FrockTheme.enter);

      expect(companion, findsOneWidget);
      expect(tester.getTopLeft(companion).dy, restTop);
      expect(tester.getTopLeft(field).dx, restLeft);
      await capture(tester, 'companion-tuck-typing-${width.toInt()}');

      await tester.enterText(field, '');
      await tester.pump();
      await tester.pump(FrockTheme.enter);
      expect(companion, findsOneWidget);
      expect(tester.getTopLeft(field).dx, restLeft);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      c.dispose();
    });
  }

  for (final width in [390.0, 1280.0]) {
    testWidgets('dictation fills the field in place at $width', (tester) async {
      tester.view.physicalSize = Size(width, 800);
      tester.view.devicePixelRatio = 1;
      tester.view.padding = FakeViewPadding(bottom: width == 390 ? 34 : 0);
      addTearDown(tester.view.reset);
      final store = MemoryStore();
      final c = ChatController(
        transport: FakeTransport(store),
        store: store,
        userId: 'user-1',
        botId: 'bot-1',
        nextId: () => 'send-1',
      );
      await c.initialize();
      c.connection = ConnectionState.connected;
      final level = ValueNotifier(0.65);
      addTearDown(level.dispose);
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: RepaintBoundary(
            child: Scaffold(
              body: ChatPane(
                controller: c,
                onReconnect: () async {},
                background: 'pixel',
                onDictate: () {},
                onStopDictation: () {},
                onDiscardDictation: () {},
                onVoice: () {},
                dictationState: DictationState.capturing,
                dictationLevel: level,
              ),
            ),
          ),
        ),
      );
      await tester.pump();

      final pill = find.byKey(const ValueKey('dictation-pill'));
      final voice = find.byKey(const ValueKey('composer-voice'));
      expect(pill, findsOneWidget);
      expect(find.byKey(const ValueKey('dictation-discard')), findsOneWidget);
      expect(find.byKey(const ValueKey('dictation-stop')), findsOneWidget);
      expect(find.byKey(const ValueKey('dictation-strip')), findsOneWidget);
      expect(find.byType(TextField).hitTestable(), findsNothing);
      expect(
        tester.getTopLeft(voice).dx,
        greaterThanOrEqualTo(tester.getTopRight(pill).dx - 1),
      );
      expect(find.bySemanticsLabel('Bot is ready'), findsOneWidget);
      await capture(tester, 'composer-dictation-${width.toInt()}');
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      c.dispose();
    });
  }
}
