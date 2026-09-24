/// The review still for deleting a Computer or an account, kept outside the
/// repository: `--dart-define=CHAT_SHOTS=<dir>`. Without a directory the
/// scene is skipped: it draws, it does not assert.
library;

import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart' show FontLoader, rootBundle;
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/settings/account_deletion.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'native_session.dart';
import 'widget_test.dart' show MemoryStore;

const _out = String.fromEnvironment('CHAT_SHOTS');
final _boundary = GlobalKey();

void main() {
  testWidgets('deleting a Computer or an account', (tester) async {
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
      (_, _) async => {'schemaVersion': 1, 'confirmation': 'tim@example.com'},
    );
    addTearDown(api.close);
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: FrockTheme.theme(Brightness.dark),
        home: RepaintBoundary(
          key: _boundary,
          child: DeletionPage(api: api, onAccountDeleted: () async {}),
        ),
      ),
    );
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 300)),
    );
    await tester.pump(const Duration(milliseconds: 300));
    await tester.enterText(find.byType(TextField), 'tim@example.com');
    await tester.pump(const Duration(milliseconds: 300));
    FocusManager.instance.primaryFocus?.unfocus();
    await tester.pump(const Duration(milliseconds: 300));
    await tester.runAsync(() async {
      final image =
          await (_boundary.currentContext!.findRenderObject()!
                  as RenderRepaintBoundary)
              .toImage(pixelRatio: 2);
      final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
      await File('$_out/delete-account.png')
          .writeAsBytes(bytes!.buffer.asUint8List());
      image.dispose();
    });
  });
}
