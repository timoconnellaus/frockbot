/// The review still for the BYO plan, kept outside the repository:
/// `--dart-define=BILLING_SHOTS=<dir>`. Without a directory the scene is
/// skipped: it draws, it does not assert.
library;

import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart' show FontLoader, rootBundle;
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_client/settings/billing.dart';
import 'package:frockbot_client/theme/frock_theme.dart';

import 'billing_test.dart' show billing, spending;
import 'settings_test.dart' show SettingsApi;
import 'widget_test.dart' show MemoryStore;

const _out = String.fromEnvironment('BILLING_SHOTS');
final _boundary = GlobalKey();

void main() {
  testWidgets('choosing a plan, with BYO beside Standard and Plus', (
    tester,
  ) async {
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
    });
    // 16:9, the frame the What’s New card draws.
    tester.view.physicalSize = const Size(2560, 1440);
    tester.view.devicePixelRatio = 2;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final account = billing({'canSpend': false, 'metered': false});
    final api = SettingsApi(MemoryStore(), (path, _) async {
      if (path.startsWith('/api/billing/spending')) {
        return spending(Uri.parse(path));
      }
      return account;
    });
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: FrockTheme.theme(Brightness.dark),
        home: RepaintBoundary(
          key: _boundary,
          child: BillingPage(api: api),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.runAsync(() async {
      final image =
          await (_boundary.currentContext!.findRenderObject()!
                  as RenderRepaintBoundary)
              .toImage(pixelRatio: 2);
      final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
      await File('$_out/byo-plan.png')
          .writeAsBytes(bytes!.buffer.asUint8List());
      image.dispose();
    });
  });
}
