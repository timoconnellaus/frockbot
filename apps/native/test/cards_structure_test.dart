/// The structure family (ADR 0030 step 8): the frame a card is read through.
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/cards/chat_card.dart';
import 'package:frockbot_native/cards/frock_catalog/frock_catalog.dart';

import 'cards_families.dart';

void main() {
  setUpAll(() async {
    if (familyVisualOutput.isNotEmpty) await loadFamilyFont();
  });

  testWidgets('CardHeader is a title, a quiet line and the state pill', (
    tester,
  ) async {
    await drawFamily(
      tester,
      [
        {
          'id': 'root',
          'component': 'CardHeader',
          'title': 'Reply to Nick',
          'subtitle': 'nick@example.com · today',
          'status': {'path': '/status'},
          'tone': 'ready',
        },
      ],
      dataModel: {'status': 'Ready to send'},
    );
    expect(find.text('Reply to Nick'), findsOneWidget);
    expect(find.text('nick@example.com · today'), findsOneWidget);
    expect(find.text('Ready to send'), findsOneWidget);
    expect(
      tester.widget<FrockStatusPillView>(find.byType(FrockStatusPillView)).tone,
      FrockTone.ready,
    );
    await captureFamily(tester, 'family-structure-header');
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'a CardHeader keeps its pill inside the card, whatever the title is',
    (tester) async {
      // The step 5 failure, made a test: the model wrote a long title beside a
      // pill and the pill left the card on a phone. The header owns the
      // layout now, so there is nothing left for a card to get wrong.
      await drawFamily(tester, [
        {
          'id': 'root',
          'component': 'CardHeader',
          'title':
              'Draft reply to Nick about the retainer, the scope change '
              'and next month’s invoice',
          'status': 'Ready to send',
          'tone': 'ready',
        },
      ], width: 412);
      expectInside(
        tester,
        find.byType(FrockStatusPillView),
        find.byType(CardChatCard),
      );
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('a bare StatusPill cannot leave the card either', (tester) async {
    // Whatever a card was written before this family existed still has to
    // draw: a pill in a hand-written Row is flexible whether or not the model
    // said so.
    await drawFamily(tester, [
      {
        'id': 'root',
        'component': 'Row',
        'children': ['title', 'pill'],
      },
      {
        'id': 'title',
        'component': 'Text',
        'text': 'Draft reply to Nick about the retainer and the scope change',
      },
      {
        'id': 'pill',
        'component': 'StatusPill',
        'label': 'Waiting on you',
        'tone': 'ready',
      },
    ], width: 412);
    expectInside(
      tester,
      find.byType(FrockStatusPillView),
      find.byType(CardChatCard),
    );
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('SectionHeader names a part and rules a line under it', (
    tester,
  ) async {
    await drawFamily(tester, [
      {
        'id': 'root',
        'component': 'SectionHeader',
        'title': 'Attachments',
        'caption': '3 files',
      },
    ]);
    expect(find.text('Attachments'), findsOneWidget);
    expect(find.text('3 files'), findsOneWidget);
    expect(find.byType(Divider), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('Callout says its tone with a colour and an icon', (
    tester,
  ) async {
    await drawFamily(tester, [
      {
        'id': 'root',
        'component': 'Callout',
        'title': 'This sends immediately',
        'text': 'There is no undo once the reply leaves.',
        'tone': 'warning',
      },
    ]);
    expect(find.text('This sends immediately'), findsOneWidget);
    expect(
      find.text('There is no undo once the reply leaves.'),
      findsOneWidget,
    );
    expect(find.byIcon(frockCalloutIconV1(FrockTone.warning)), findsOneWidget);
    await captureFamily(tester, 'family-structure-callout');
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('IdentityRow draws initials when there is no avatar', (
    tester,
  ) async {
    await drawFamily(tester, [
      {
        'id': 'root',
        'component': 'IdentityRow',
        'name': 'Nick Adams',
        'detail': 'nick@example.com',
      },
    ]);
    expect(find.text('Nick Adams'), findsOneWidget);
    expect(find.text('nick@example.com'), findsOneWidget);
    expect(find.text('NA'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('an avatar over an insecure link is a card that is not drawn', (
    tester,
  ) async {
    await drawFamily(tester, [
      {
        'id': 'root',
        'component': 'IdentityRow',
        'name': 'Nick Adams',
        'imageUrl': 'http://example.com/nick.png',
      },
    ]);
    expect(find.text('Nick Adams'), findsNothing);
    expect(find.text('This card can’t be shown'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });
}
