import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/theme/frock_theme.dart';
import 'package:frockbot_native/whats_new/feed.dart';
import 'package:frockbot_native/whats_new/page.dart';

import 'navigation_test.dart' show DirectoryApi, identifiedBy;
import 'widget_test.dart' show MemoryStore;

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
        WhatsNewEntry(
          id: 'newer',
          title: 'B',
          summary: 'B',
          kind: 'feature',
        ),
        WhatsNewEntry(
          id: 'older',
          title: 'A',
          summary: 'A',
          kind: 'feature',
        ),
      ],
    );
    expect(feed.unseenCount(null), 2);
    expect(feed.unseenCount('older'), 1);
    expect(feed.unseenCount('newer'), 0);
  });

  test('the page opens itself after a native update, not on first launch or web', () {
    expect(
      shouldOpenWhatsNewAfterLaunchV1(
        web: false,
        previousVersion: 'Version 1.5.0+1',
        currentVersion: 'Version 1.6.0+1',
        unseen: 1,
      ),
      isTrue,
    );
    expect(
      shouldOpenWhatsNewAfterLaunchV1(
        web: false,
        previousVersion: null,
        currentVersion: 'Version 1.6.0+1',
        unseen: 1,
      ),
      isFalse,
    );
    expect(
      shouldOpenWhatsNewAfterLaunchV1(
        web: true,
        previousVersion: 'Version 1.5.0+1',
        currentVersion: 'Version 1.6.0+1',
        unseen: 1,
      ),
      isFalse,
    );
    expect(
      shouldOpenWhatsNewAfterLaunchV1(
        web: false,
        previousVersion: 'Version 1.6.0+1',
        currentVersion: 'Version 1.6.0+1',
        unseen: 1,
      ),
      isFalse,
    );
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
            'image': {
              'src': 'https://evil.example/x.webp',
              'alt': 'No',
            },
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

  testWidgets('the page draws the first entry and marks it seen', (tester) async {
    final store = MemoryStore();
    final seen = <String>[];
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
            ],
          ),
          onSeen: (id) async => seen.add(id),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(identifiedBy('whats-new-page'), findsOneWidget);
    expect(identifiedBy('whats-new-entry-whats-new'), findsOneWidget);
    expect(find.text('What’s New in the app'), findsOneWidget);
    expect(find.text('NEW'), findsOneWidget);
    expect(seen, ['whats-new']);
    await tester.tap(find.byType(InkWell));
    await tester.pumpAndSettle();
    expect(find.byType(Dialog), findsOneWidget);
  });
}
