import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/shell/semantics.dart';
import 'package:frockbot_native/theme/frock_theme.dart';
import 'package:frockbot_native/theme/rows.dart';
import 'package:frockbot_native/whats_new/feed.dart';
import 'package:frockbot_native/whats_new/mark.dart';
import 'package:frockbot_native/whats_new/page.dart';

import 'navigation_test.dart' show DirectoryApi, identifiedBy;
import 'widget_test.dart' show MemoryStore;

const _shot = Key('whats-new-shot');

/// 1×1 PNG so the card still has a picture when the captured card file is absent.
final Uint8List _fallbackStill = Uint8List.fromList(<int>[
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  0x00,
  0x00,
  0x00,
  0x0d,
  0x49,
  0x48,
  0x44,
  0x52,
  0x00,
  0x00,
  0x00,
  0x01,
  0x00,
  0x00,
  0x00,
  0x01,
  0x08,
  0x02,
  0x00,
  0x00,
  0x00,
  0x90,
  0x77,
  0x53,
  0xde,
  0x00,
  0x00,
  0x00,
  0x0c,
  0x49,
  0x44,
  0x41,
  0x54,
  0x08,
  0xd7,
  0x63,
  0xf8,
  0xcf,
  0xc0,
  0x00,
  0x00,
  0x00,
  0x03,
  0x00,
  0x01,
  0x00,
  0x05,
  0xfe,
  0xd4,
  0xef,
  0x00,
  0x00,
  0x00,
  0x00,
  0x49,
  0x45,
  0x4e,
  0x44,
  0xae,
  0x42,
  0x60,
  0x82,
]);

ImageProvider _cardStill() {
  for (final path in [
    Platform.environment['WHATS_NEW_SHOTS'],
    '/opt/cursor/artifacts',
  ]) {
    if (path == null || path.isEmpty) continue;
    final file = File('$path/whats-new-card.png');
    if (file.existsSync()) return MemoryImage(file.readAsBytesSync());
  }
  return MemoryImage(_fallbackStill);
}

Future<void> _save(WidgetTester tester, String name) async {
  final dir = Platform.environment['WHATS_NEW_SHOTS'];
  if (dir == null || dir.isEmpty) return;
  await tester.pump();
  final boundary = tester.renderObject<RenderRepaintBoundary>(
    find.byKey(_shot),
  );
  await tester.runAsync(() async {
    final image = await boundary.toImage(pixelRatio: 2);
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    File('$dir/$name').writeAsBytesSync(bytes!.buffer.asUint8List());
  });
}

void main() {
  testWidgets('megaphone row with the unread mark', (tester) async {
    tester.view.physicalSize = const Size(800, 280);
    tester.view.devicePixelRatio = 2;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: Scaffold(
          body: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: RepaintBoundary(
                key: _shot,
                child: FrockRowGroup(
                  rows: [
                    FrockRow(
                      icon: Icons.campaign_outlined,
                      title: 'What’s New',
                      trailing: const WhatsNewUnreadMark(),
                      onTap: () {},
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    expect(find.byIcon(Icons.campaign_outlined), findsOneWidget);
    expect(identifiedBy(WhatsNewIds.unread), findsOneWidget);
    await _save(tester, 'whats_new_unread_row.png');
  });

  testWidgets('open page with new news, read news, and a picture', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(780, 1280);
    tester.view.devicePixelRatio = 2;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: RepaintBoundary(
          key: _shot,
          child: WhatsNewPage(
            api: DirectoryApi(MemoryStore()),
            origin: 'https://tests.invalid',
            seenId: 'earlier',
            stillFor: (_) => _cardStill(),
            feed: const WhatsNewFeed(
              entries: [
                WhatsNewEntry(
                  id: 'whats-new',
                  title: 'What’s New in the app',
                  summary: 'What landed in each release.',
                  kind: 'feature',
                  image: WhatsNewImage(
                    src: '/whats-new/whats-new.webp',
                    alt: 'The What’s New card.',
                  ),
                ),
                WhatsNewEntry(
                  id: 'earlier',
                  title: 'Search across every Bot',
                  summary: 'Find a conversation, a file, or a person.',
                  kind: 'feature',
                  publishedAt: '2026-09-14',
                ),
              ],
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.text('What’s New in the app'), findsOneWidget);
    expect(find.text('Search across every Bot'), findsOneWidget);
    expect(identifiedBy(WhatsNewIds.unread), findsOneWidget);
    await _save(tester, 'whats_new_open.png');
  });
}
