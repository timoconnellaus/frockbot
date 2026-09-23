import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/shell/semantics.dart';
import 'package:frockbot_native/theme/frock_theme.dart';
import 'package:frockbot_native/whats_new/feed.dart';
import 'package:frockbot_native/whats_new/page.dart';

import 'navigation_test.dart' show DirectoryApi, identifiedBy;
import 'widget_test.dart' show MemoryStore;

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

void main() {
  test('a missing published day is New, never a guessed merge date', () {
    expect(
      const WhatsNewEntry(
        id: 'a',
        title: 'Search',
        summary: 'Find files.',
        kind: 'feature',
      ).when,
      'New',
    );
    expect(
      const WhatsNewEntry(
        id: 'a',
        title: 'Search',
        summary: 'Find files.',
        kind: 'feature',
        publishedAt: '2026-09-21',
      ).when,
      '21 September 2026',
    );
  });

  test('unseen counts entries newer than the last seen id', () {
    const feed = WhatsNewFeed(
      entries: [
        WhatsNewEntry(id: 'newer', title: 'B', summary: 'B', kind: 'feature'),
        WhatsNewEntry(id: 'older', title: 'A', summary: 'A', kind: 'feature'),
      ],
    );
    expect(feed.unseenCount(null), 2);
    expect(feed.unseenCount('older'), 1);
    expect(feed.unseenCount('newer'), 0);
    expect(feed.isUnread('newer', 'older'), isTrue);
    expect(feed.isUnread('older', 'older'), isFalse);
    expect(feed.isUnread('newer', 'newer'), isFalse);
    expect(feed.isUnread('older', null), isTrue);
  });

  test('an image has to be a What’s New path on this origin', () {
    expect(
      WhatsNewFeed.decode({
        'entries': [
          {
            'id': 'x',
            'title': 'X',
            'summary': 'Y',
            'kind': 'feature',
            'image': {'src': 'https://evil.example/x.webp', 'alt': 'No'},
          },
        ],
      }).entries.single.image,
      isNull,
    );
    expect(
      WhatsNewFeed.decode({
        'entries': [
          {
            'id': 'x',
            'title': 'X',
            'summary': 'Y',
            'kind': 'feature',
            'image': {'src': '/whats-new/whats-new.webp', 'alt': 'The page'},
          },
        ],
      }).entries.single.image?.src,
      '/whats-new/whats-new.webp',
    );
  });

  testWidgets('the page draws the first entry and marks it seen', (
    tester,
  ) async {
    final store = MemoryStore();
    final seen = <String>[];
    tester.view.physicalSize = const Size(400, 1600);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: WhatsNewPage(
          api: DirectoryApi(store),
          origin: 'https://tests.invalid',
          feed: const WhatsNewFeed(
            entries: [
              WhatsNewEntry(
                id: 'whats-new',
                title: 'What’s New in the app',
                summary: 'What landed in each release.',
                kind: 'feature',
                image: WhatsNewImage(
                  src: '/whats-new/whats-new.webp',
                  alt: 'The What’s New page, with this feature as its first entry.',
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
          seenId: 'earlier',
          stillFor: (_) => MemoryImage(_fallbackStill),
          onSeen: (id) async => seen.add(id),
        ),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(identifiedBy('whats-new-page'), findsOneWidget);
    expect(identifiedBy('whats-new-entry-whats-new'), findsOneWidget);
    expect(find.text('What’s New in the app'), findsOneWidget);
    expect(find.text('NEW'), findsOneWidget);
    await tester.scrollUntilVisible(find.text('Search across every Bot'), 200);
    expect(find.text('Search across every Bot'), findsOneWidget);
    expect(identifiedBy(WhatsNewIds.unread), findsOneWidget);
    expect(seen, ['whats-new']);
    await tester.tap(find.byType(InkWell));
    await tester.pumpAndSettle();
    expect(find.byType(Dialog), findsOneWidget);
  });

  testWidgets('entries that shipped on one day share its date', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: WhatsNewPage(
          api: DirectoryApi(MemoryStore()),
          origin: 'https://tests.invalid',
          seenId: 'search',
          feed: const WhatsNewFeed(
            entries: [
              WhatsNewEntry(
                id: 'search',
                title: 'Search across every Bot',
                summary: 'Find a conversation, a file, or a person.',
                kind: 'feature',
                publishedAt: '2026-09-14',
              ),
              WhatsNewEntry(
                id: 'chat-scroll',
                title: 'Earlier messages stay in reach',
                summary: 'A long conversation scrolls back to them.',
                kind: 'fix',
                publishedAt: '2026-09-14',
              ),
              WhatsNewEntry(
                id: 'chat-type',
                title: 'Easier reading in chat',
                summary: 'Messages use Inter at 14.',
                kind: 'improvement',
                publishedAt: '2026-09-12',
              ),
            ],
          ),
        ),
      ),
    );
    await tester.pump();
    expect(find.text('14 SEPTEMBER 2026'), findsOneWidget);
    expect(find.text('12 SEPTEMBER 2026'), findsOneWidget);
    expect(find.byType(Card), findsNWidgets(2));
  });
}
