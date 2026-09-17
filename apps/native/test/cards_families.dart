/// The harness the per-family component tests share.
///
/// A family test asks one question: given the JSON a Bot would write, does the
/// host draw the thing it promised. So it needs a card read that answers with
/// those components and nothing else, and — for the layout promises, which are
/// the ones prose could not keep — the width the card is read at and the
/// geometry of what came out.
library;

import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/cards/chat_card.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'settings_test.dart' show SettingsApi;
import 'widget_test.dart' show MemoryStore;

/// One card record, as the read route answers it.
Map<String, Object?> familyCardJson({
  required List<Map<String, Object?>> components,
  Map<String, Object?>? dataModel,
  int revision = 1,
  bool sendDataModel = false,
}) => {
  'schemaVersion': 1,
  'surfaceId': 'family-1',
  'revision': revision,
  'components': components,
  'dataModel': dataModel ?? <String, Object?>{},
  'createdAt': '2026-09-18T00:00:00.000Z',
  'updatedAt': '2026-09-18T00:00:00.000Z',
  'sendDataModel': sendDataModel,
  'deleted': false,
};

/// Optional review artifact, kept outside the repository:
/// `--dart-define=CARD_VISUAL_OUTPUT=<dir>`.
const familyVisualOutput = String.fromEnvironment('CARD_VISUAL_OUTPUT');

/// The app's own typeface, so a captured card is read rather than measured.
Future<void> loadFamilyFont() async {
  final loader = FontLoader('Inter');
  for (final weight in [400, 500, 600, 700]) {
    loader.addFont(
      File('assets/fonts/inter-latin-$weight.ttf')
          .readAsBytes()
          .then((bytes) => ByteData.view(Uint8List.fromList(bytes).buffer)),
    );
  }
  await loader.load();
}

Future<void> captureFamily(WidgetTester tester, String name) async {
  const output = familyVisualOutput;
  if (output.isEmpty) return;
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

/// Draws one surface in the transcript's own chrome, at [width] logical
/// pixels, and answers a press with the same record back. The list it returns
/// is what the card posted, which is how a control's action name is checked.
Future<List<Map<String, Object?>>> drawFamily(
  WidgetTester tester,
  List<Map<String, Object?>> components, {
  Map<String, Object?>? dataModel,
  double width = 412,
  bool sendDataModel = false,
}) async {
  tester.view.physicalSize = Size(width * 2, 900 * 2);
  tester.view.devicePixelRatio = 2;
  addTearDown(tester.view.reset);
  final posts = <Map<String, Object?>>[];
  final api = SettingsApi(MemoryStore(), (path, body) async {
    if (body != null) {
      posts.add((body as Map).cast<String, Object?>());
      return {
        'schemaVersion': 1,
        'routed': 'input',
        'card': familyCardJson(
          components: components,
          dataModel: dataModel,
          revision: 1,
          sendDataModel: sendDataModel,
        ),
      };
    }
    return familyCardJson(
      components: components,
      dataModel: dataModel,
      sendDataModel: sendDataModel,
    );
  });
  await tester.pumpWidget(
    MaterialApp(
      theme: FrockTheme.theme(Brightness.dark),
      home: Scaffold(
        body: Align(
          alignment: Alignment.topCenter,
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(16),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 680),
              child: CardChatScope(
                api: api,
                botId: 'bot-1',
                child: const CardChatCard(surfaceId: 'family-1'),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return posts;
}

/// Whether [inner] is drawn inside [outer], which is the promise a layout
/// component makes and a `Row` of hand-written parts does not.
void expectInside(WidgetTester tester, Finder inner, Finder outer) {
  final child = tester.getRect(inner);
  final parent = tester.getRect(outer);
  expect(
    child.left >= parent.left - 0.5 && child.right <= parent.right + 0.5,
    isTrue,
    reason: 'expected $child to sit inside $parent',
  );
}
