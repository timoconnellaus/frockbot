/// The review still for teaching a Bot by showing it: a recording kept and
/// waiting in the Computer's full window, over the page it ended on. Kept
/// outside the repository:
/// `--dart-define=CHAT_SHOTS=<dir> --dart-define=DEMONSTRATION_DESKTOP=<png>`,
/// where the PNG is a real browser page to stand in for the desktop. Without
/// both, the scene is skipped: it draws, it does not assert.
library;

import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart' show FontLoader, rootBundle;
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/computer/client.dart';
import 'package:frockbot_native/computer/recording.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'computer_test.dart' show projection;
import 'settings_test.dart' show SettingsApi;
import 'widget_test.dart' show MemoryStore;

const _out = String.fromEnvironment('CHAT_SHOTS');
const _desktop = String.fromEnvironment('DEMONSTRATION_DESKTOP');
final _boundary = GlobalKey();

Future<void> _loadFonts() async {
  final inter = FontLoader('Inter');
  for (final weight in [400, 500, 600, 700]) {
    inter.addFont(rootBundle.load('assets/fonts/inter-latin-$weight.ttf'));
  }
  await inter.load();
  await (FontLoader(
    'MaterialIcons',
  )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
}

void main() {
  testWidgets('a kept recording waits to be sent', (tester) async {
    if (_out.isEmpty || _desktop.isEmpty) return;
    await tester.runAsync(_loadFonts);
    tester.view.physicalSize = const Size(960, 540);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final desktop = File(_desktop).readAsBytesSync();
    final controller = ComputerController(
      SettingsApi(MemoryStore(), (_, _) async => <String, Object?>{}),
      'bot-1',
    );
    addTearDown(controller.dispose);
    controller
      ..onTeach = ((_, _) async => true)
      ..state = ComputerProjection.fromJson({
        ...projection(phase: 'human-control', snapshot: false),
        'message': 'You have control. Release when finished with private data.',
        'controlLease': {
          'version': 1,
          'ownerId': 'human:1',
          'acquiredAt': '2026-09-24T10:00:00.000Z',
          'expiresAt': '2026-09-24T10:01:30.000Z',
        },
        'demonstration': {
          'version': 1,
          'id': '0123456789abcdef',
          'status': 'ready',
          'startedAt': '2026-09-24T10:00:00.000Z',
          'steps': 14,
          'attachments': [
            {
              'kind': 'document',
              'uploadId': 'a' * 64,
              'name': 'demonstration-0123456789abcdef.json',
              'mediaType': 'application/json',
              'bytes': 3000,
            },
            for (var index = 1; index <= 3; index += 1)
              {
                'kind': 'image',
                'uploadId': '$index' * 64,
                'name': 'demonstration-0123456789abcdef-screenshot-$index.jpg',
                'mediaType': 'image/jpeg',
                'bytes': 60000,
              },
          ],
        },
      });
    final demonstration = controller.state.demonstration!;
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: FrockTheme.theme(Brightness.dark),
        home: RepaintBoundary(
          key: _boundary,
          // The full window's own arrangement: its title and actions, the
          // desktop under the control border, and the panel over it.
          child: Scaffold(
            appBar: AppBar(
              title: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Text('Computer · Fox'),
                  Builder(
                    builder: (context) => Text(
                      controller.state.message,
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color: Theme.of(context).colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ),
                ],
              ),
              actions: [
                ComputerRecordButton(controller: controller),
                TextButton(
                  onPressed: () {},
                  child: const Text('Release control'),
                ),
              ],
            ),
            body: Stack(
              fit: StackFit.expand,
              children: [
                Image.memory(desktop, fit: BoxFit.cover),
                DecoratedBox(
                  decoration: BoxDecoration(
                    border: Border.all(color: FrockTheme.accent, width: 3),
                  ),
                ),
                Positioned(
                  left: 16,
                  right: 16,
                  bottom: 20,
                  child: Center(
                    child: ComputerTeachPanel(
                      controller: controller,
                      demonstration: demonstration,
                      botName: 'Fox',
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
    await tester.enterText(find.byType(TextField), 'Book a squash court');
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(seconds: 1)),
    );
    await tester.pump(const Duration(milliseconds: 600));
    await tester.runAsync(() async {
      final image =
          await (_boundary.currentContext!.findRenderObject()!
                  as RenderRepaintBoundary)
              .toImage(pixelRatio: 2);
      final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
      await File('$_out/learn-from-demonstration.png')
          .writeAsBytes(bytes!.buffer.asUint8List());
      image.dispose();
    });
  });
}
