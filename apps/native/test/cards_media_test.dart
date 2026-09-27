/// The media family (ADR 0030 step 8): pictures, files and links.
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_client/cards/frock_catalog/frock_catalog.dart';

import 'cards_families.dart';

void main() {
  setUpAll(() async {
    if (familyVisualOutput.isNotEmpty) await loadFamilyFont();
  });

  /// The host's link handling, replaced for the span of one test.
  List<String> watchLinks() {
    final opened = <String>[];
    final host = frockOpenLinkV1;
    frockOpenLinkV1 = (url) async {
      opened.add(url);
      return true;
    };
    addTearDown(() => frockOpenLinkV1 = host);
    return opened;
  }

  testWidgets('one image is the card’s picture; several are a strip', (
    tester,
  ) async {
    await drawFamily(tester, [
      {
        'id': 'root',
        'component': 'ImageGallery',
        'images': [
          {
            'url': 'https://example.com/a.png',
            'caption': 'The first draft',
            'alt': 'A page of the draft',
          },
        ],
      },
    ]);
    expect(find.text('The first draft'), findsOneWidget);
    expect(find.byType(ListView), findsNothing);

    await drawFamily(tester, [
      {
        'id': 'root',
        'component': 'ImageGallery',
        'images': [
          {'url': 'https://example.com/a.png', 'alt': 'One'},
          {'url': 'https://example.com/b.png', 'alt': 'Two'},
          {'url': 'https://example.com/c.png', 'alt': 'Three'},
        ],
      },
    ]);
    expect(find.byType(ListView), findsOneWidget);
    expect(find.byType(Image), findsWidgets);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a gallery over an insecure link is a card that is not drawn', (
    tester,
  ) async {
    await drawFamily(tester, [
      {
        'id': 'root',
        'component': 'ImageGallery',
        'images': [
          {'url': 'http://example.com/a.png'},
        ],
      },
    ]);
    expect(find.text('This card can’t be shown'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('FileAttachment says what it is and opens through the host', (
    tester,
  ) async {
    final opened = watchLinks();
    await drawFamily(tester, [
      {
        'id': 'root',
        'component': 'FileAttachment',
        'name': 'September invoices.pdf',
        'detail': 'PDF · 1.2 MB',
        'kind': 'document',
        'url': 'https://example.com/exports/september.pdf',
      },
    ]);
    expect(find.text('September invoices.pdf'), findsOneWidget);
    expect(find.text('PDF · 1.2 MB'), findsOneWidget);
    expect(find.byIcon(frockFileIconV1('document')), findsOneWidget);
    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();
    expect(opened, ['https://example.com/exports/september.pdf']);
    await captureFamily(tester, 'family-media-attachment');
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a file with no link is a row, not a control', (tester) async {
    await drawFamily(tester, [
      {
        'id': 'root',
        'component': 'FileAttachment',
        'name': 'draft.md',
        'kind': 'document',
      },
    ]);
    expect(find.text('draft.md'), findsOneWidget);
    expect(find.text('Open'), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('LinkPreview names the site it goes to, and follows it', (
    tester,
  ) async {
    final opened = watchLinks();
    await drawFamily(tester, [
      {
        'id': 'root',
        'component': 'LinkPreview',
        'url': 'https://example.com/pricing',
        'title': 'Pricing — Example',
        'description': 'What the retainer covers, and what it does not.',
      },
    ]);
    expect(find.text('Pricing — Example'), findsOneWidget);
    // No `site` was written, so the host takes it from the link itself.
    expect(find.text('example.com'), findsOneWidget);
    await tester.tap(find.text('Pricing — Example'));
    await tester.pumpAndSettle();
    expect(opened, ['https://example.com/pricing']);
    await captureFamily(tester, 'family-media-link');
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a link with no host still names where it goes', (tester) async {
    watchLinks();
    await drawFamily(tester, [
      {
        'id': 'root',
        'component': 'LinkPreview',
        'url': 'https://',
        'title': 'Somewhere',
      },
    ]);
    expect(find.text('the web'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });
}
