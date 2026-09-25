/// The review still for emailing a Bot, kept outside the repository:
/// `--dart-define=CHAT_SHOTS=<dir>`. Without a directory the scene is
/// skipped: it draws, it does not assert.
library;

import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart' show FontLoader, rootBundle;
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/email/page.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'native_session.dart';
import 'widget_test.dart' show MemoryStore;

const _out = String.fromEnvironment('CHAT_SHOTS');
final _boundary = GlobalKey();

void main() {
  testWidgets('a Bot’s email address and who may write to it', (tester) async {
    if (_out.isEmpty) return;
    await tester.runAsync(() async {
      final inter = FontLoader('Inter');
      for (final weight in [400, 500, 600, 700]) {
        inter.addFont(rootBundle.load('assets/fonts/inter-latin-$weight.ttf'));
      }
      await inter.load();
      await (FontLoader(
        'MaterialIcons',
      )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
    });
    // 16:9, the frame the What’s New card draws.
    tester.view.physicalSize = const Size(2560, 1440);
    tester.view.devicePixelRatio = 2;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final api = NativeSessionApi(
      MemoryStore(),
      (_, _) async => {
        'schemaVersion': 1,
        'available': true,
        'username': 'tim',
        'address': 'fox.tim@frockbot.com',
        'receiving': true,
        'senders': [
          {'address': 'tim@example.com', 'status': 'sign-in'},
          {
            'address': 'tim@studio.example',
            'status': 'verified',
            'verifiedAt': '2026-09-24T09:00:00.000Z',
          },
          {
            'address': 'tim@home.example',
            'status': 'pending',
            'code': 'FROCK-7K3P-9QXM',
            'expiresAt': '2026-09-25T09:00:00.000Z',
          },
        ],
      },
    );
    addTearDown(api.close);
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: FrockTheme.theme(Brightness.dark),
        home: RepaintBoundary(
          key: _boundary,
          child: BotEmailPage(api: api, botId: 'fox'),
        ),
      ),
    );
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 300)),
    );
    await tester.pump(const Duration(milliseconds: 300));
    await tester.runAsync(() async {
      final image =
          await (_boundary.currentContext!.findRenderObject()!
                  as RenderRepaintBoundary)
              .toImage(pixelRatio: 2);
      final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
      await File('$_out/email-your-bot.png')
          .writeAsBytes(bytes!.buffer.asUint8List());
      image.dispose();
    });
  });
}
