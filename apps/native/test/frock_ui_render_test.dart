import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/ui/frock_tokens.dart';
import 'package:frockbot_native/ui/gallery.dart';

/// Renders the Frock UI reference screens with the real brand fonts and
/// writes PNGs to docs/design/evidence/, where they sit beside the same
/// screens rendered from docs/design/frock-ui.html by Playwright. This is the
/// match check for the design system: two renderers, one set of tokens.
///
/// Set FROCK_EVIDENCE=1 to write the files; otherwise the test only proves
/// the screen builds and lays out at phone size.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  Future<void> loadFonts() async {
    Future<void> load(String family, String asset) async {
      final loader = FontLoader(family)..addFont(rootBundle.load(asset));
      await loader.load();
    }

    await load('Manrope', 'assets/fonts/manrope-latin.ttf');
    await load('Archivo Black', 'assets/fonts/archivo-black-latin.ttf');
    await load('JetBrains Mono', 'assets/fonts/jetbrains-mono-latin.ttf');
    // The icon font ships with the SDK, not the app bundle; the harness has
    // no icons unless we load it ourselves.
    final root =
        Platform.environment['FLUTTER_ROOT'] ?? '/Users/tim/repos/flutter';
    final icons = File(
      '$root/bin/cache/artifacts/material_fonts/MaterialIcons-Regular.otf',
    );
    if (icons.existsSync()) {
      final loader = FontLoader('MaterialIcons')
        ..addFont(Future.value(icons.readAsBytesSync().buffer.asByteData()));
      await loader.load();
    }
  }

  testWidgets('Today renders at phone size with the brand fonts', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(390 * 3, 780 * 3);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);

    final key = GlobalKey();
    await tester.runAsync(loadFonts);
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: FrockTokens.themeData(FrockTokens.dark),
        home: RepaintBoundary(key: key, child: const FrockTodayScreen()),
      ),
    );
    await tester.runAsync(() async {
      await precacheImage(
        const AssetImage('assets/sheep.png'),
        key.currentContext!,
      );
    });
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    expect(find.text('Good afternoon,\nTim.'), findsOneWidget);
    expect(find.text('Bob wants to send an email'), findsOneWidget);
    expect(find.text('Ask any Bot'), findsOneWidget);
    expect(tester.takeException(), isNull);

    if (Platform.environment['FROCK_EVIDENCE'] != '1') return;
    final boundary =
        key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
    final image = await tester.runAsync(() => boundary.toImage(pixelRatio: 3));
    final bytes = await tester.runAsync(
      () => image!.toByteData(format: ui.ImageByteFormat.png),
    );
    final out = File('../../docs/design/evidence/flutter-today.png');
    out.parent.createSync(recursive: true);
    out.writeAsBytesSync(bytes!.buffer.asUint8List());
  });
}
