import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/gestures.dart' show PointerDeviceKind;
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart' show FontLoader, rootBundle;
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/chat_controller.dart';
import 'package:frockbot_native/flock/avatar.dart';
import 'package:frockbot_native/shell/chat_pane.dart';
import 'package:frockbot_native/shell/semantics.dart';
import 'package:frockbot_native/shell/transcript.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'shell_layout_test.dart' show byIdentifier;
import 'widget_test.dart' show FakeTransport, MemoryStore, running;

final boundary = GlobalKey();

Future<void> loadFonts() async {
  final inter = FontLoader('Inter');
  for (final weight in [400, 500, 600, 700]) {
    inter.addFont(rootBundle.load('assets/fonts/inter-latin-$weight.ttf'));
  }
  await inter.load();
  await (FontLoader(
    'MaterialIcons',
  )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
}

/// Optional review artifact, kept outside the repository:
/// `--dart-define=COMPANION_VISUAL_OUTPUT=<dir>`.
Future<void> capture(WidgetTester tester, String name) async {
  const output = String.fromEnvironment('COMPANION_VISUAL_OUTPUT');
  if (output.isEmpty) return;
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

void main() {
  setUpAll(loadFonts);

  for (final width in [390.0, 1280.0]) {
    testWidgets('a running Turn is worn by the companion, not the thread, at '
        '$width', (tester) async {
      tester.view.physicalSize = Size(width, 800);
      tester.view.devicePixelRatio = 1;
      tester.view.padding = FakeViewPadding(bottom: width == 390 ? 34 : 0);
      addTearDown(tester.view.reset);
      final store = MemoryStore();
      final t = FakeTransport(store)..observed = running();
      final c = ChatController(
        transport: t,
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
            key: boundary,
            child: Scaffold(
              body: ChatPane(
                controller: c,
                onReconnect: () async {},
                background: 'fox',
                primary: '#ff6b57',
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      expect(c.activeRunId, 'send-1');
      // The companion is the working indicator and wears the badge.
      final indicator = byIdentifier(ShellIds.workingIndicator);
      expect(indicator, findsOneWidget);
      expect(
        find.descendant(of: indicator, matching: find.byType(ThinkingBadge)),
        findsOneWidget,
      );
      // The thread draws no working row and no badge of its own.
      final transcript = find.byType(TranscriptView);
      expect(
        find.descendant(of: transcript, matching: find.byType(ThinkingBadge)),
        findsNothing,
      );
      expect(byIdentifier(ShellIds.workingNotice), findsNothing);
      expect(find.byKey(const ValueKey('row:working-space')), findsNothing);

      await capture(tester, 'companion-working-${width.toInt()}');
      await tester.pumpWidget(const SizedBox());
      c.dispose();
    });
  }

  testWidgets('the companion looks where the pointer is over the pane', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1280, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final store = MemoryStore();
    final t = FakeTransport(store);
    final c = ChatController(
      transport: t,
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
        home: Scaffold(
          body: ChatPane(
            controller: c,
            onReconnect: () async {},
            background: 'fox',
            primary: '#ff6b57',
          ),
        ),
      ),
    );
    await tester.pump();
    final state = tester.state(find.byType(ChatPane)) as dynamic;
    final ValueNotifier<Offset?> gaze = state.gaze;
    expect(gaze.value, isNull);

    final companion = tester.getCenter(find.bySemanticsLabel('Bot is ready'));
    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    await mouse.addPointer(location: Offset.zero);
    addTearDown(mouse.removePointer);
    // Up and to the right of the character: the eyes turn that way, and a
    // point well short of the pane's far corner is not yet a full turn.
    await mouse.moveTo(companion + const Offset(200, -120));
    await tester.pump();
    expect(gaze.value, isNotNull);
    expect(gaze.value!.dx, greaterThan(0));
    expect(gaze.value!.dx, lessThan(1));
    expect(gaze.value!.dy, lessThan(0));
    // The far corner is a full turn, clamped rather than beyond it.
    await mouse.moveTo(const Offset(1279, 1));
    await tester.pump();
    expect(gaze.value, const Offset(1, -1));
    // Off the pane, nowhere to look.
    await mouse.moveTo(const Offset(-10, -10));
    await tester.pump();
    expect(gaze.value, isNull);

    await tester.pumpWidget(const SizedBox());
    c.dispose();
  });
}
