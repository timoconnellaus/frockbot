/// The data family (ADR 0030 step 8): a number, a proportion, a grid, a
/// sequence.
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_client/cards/chat_card.dart';
import 'package:frockbot_client/cards/frock_catalog/frock_catalog.dart';

import 'cards_families.dart';

void main() {
  setUpAll(() async {
    if (familyVisualOutput.isNotEmpty) await loadFamilyFont();
  });

  testWidgets('MetricTile draws the number, the name and the movement', (
    tester,
  ) async {
    await drawFamily(tester, [
      {
        'id': 'root',
        'component': 'Row',
        'children': ['open', 'overdue'],
      },
      {
        'id': 'open',
        'component': 'MetricTile',
        'label': 'Open invoices',
        'value': r'$4,120',
        'delta': '+12%',
        'caption': 'since Friday',
      },
      {
        'id': 'overdue',
        'component': 'MetricTile',
        'label': 'Overdue',
        'value': '2',
        'tone': 'warning',
      },
    ]);
    expect(find.text(r'$4,120'), findsOneWidget);
    expect(find.text('Open invoices'), findsOneWidget);
    expect(find.text('+12%'), findsOneWidget);
    expect(find.text('since Friday'), findsOneWidget);
    // The arrow follows the sign; what the movement means is the tile's tone.
    expect(find.byIcon(Icons.arrow_upward), findsOneWidget);
    await captureFamily(tester, 'family-data-metrics');
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('two MetricTiles share the row rather than overflowing it', (
    tester,
  ) async {
    await drawFamily(tester, [
      {
        'id': 'root',
        'component': 'Row',
        'children': ['a', 'b'],
      },
      {
        'id': 'a',
        'component': 'MetricTile',
        'label': 'Invoices waiting on a signature from the client',
        'value': r'$412,000.00',
      },
      {
        'id': 'b',
        'component': 'MetricTile',
        'label': 'Overdue more than thirty days',
        'value': '128',
      },
    ], width: 412);
    expectInside(tester, find.text('128'), find.byType(CardChatCard));
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('ProgressBar fills to a bound proportion and clamps a bad one', (
    tester,
  ) async {
    await drawFamily(
      tester,
      [
        {
          'id': 'root',
          'component': 'ProgressBar',
          'label': 'Importing',
          'caption': '3 of 7',
          'value': {'path': '/done'},
        },
      ],
      dataModel: {'done': 0.42},
    );
    expect(find.text('Importing'), findsOneWidget);
    expect(find.text('3 of 7'), findsOneWidget);
    expect(
      tester
          .widget<LinearProgressIndicator>(find.byType(LinearProgressIndicator))
          .value,
      closeTo(0.42, 0.001),
    );

    await drawFamily(tester, [
      {'id': 'root', 'component': 'ProgressBar', 'value': 4},
    ]);
    expect(
      tester
          .widget<LinearProgressIndicator>(find.byType(LinearProgressIndicator))
          .value,
      1.0,
    );
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('an indeterminate ProgressBar has no proportion at all', (
    tester,
  ) async {
    await drawFamily(tester, [
      {
        'id': 'root',
        'component': 'ProgressBar',
        'value': 0,
        'indeterminate': true,
      },
    ], settle: false);
    expect(
      tester
          .widget<LinearProgressIndicator>(find.byType(LinearProgressIndicator))
          .value,
      isNull,
    );
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('DataTable lines its columns up, row after row', (tester) async {
    await drawFamily(tester, [
      {
        'id': 'root',
        'component': 'DataTable',
        'columns': [
          {'label': 'Item', 'weight': 3},
          {'label': 'Qty', 'align': 'end'},
          {'label': 'Amount', 'align': 'end'},
        ],
        'rows': [
          {
            'cells': ['Retainer — September', '1', r'$4,000'],
          },
          {
            'cells': ['Scope change', '2', r'$1,200'],
          },
        ],
        'caption': 'Showing 2 of 2 line items',
      },
    ], width: 412);
    expect(find.text('Retainer — September'), findsOneWidget);
    expect(find.text('Showing 2 of 2 line items'), findsOneWidget);
    // The columns are the same columns every row: an amount is under the
    // amount heading, whatever the row above it said.
    final heading = tester.getRect(find.text('Amount'));
    for (final amount in [r'$4,000', r'$1,200']) {
      final cell = tester.getRect(find.text(amount));
      expect(cell.right, closeTo(heading.right, 1));
    }
    await captureFamily(tester, 'family-data-table');
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a table too wide for the card scrolls rather than squeezes', (
    tester,
  ) async {
    // What the first live Turn to draw a table wrote: four columns, one of
    // them heavy, at phone width. Squeezed, "INV-0912" broke across two lines
    // mid-word — so the table takes its floor and scrolls instead.
    await drawFamily(tester, [
      {
        'id': 'root',
        'component': 'DataTable',
        'columns': [
          {'label': 'Client', 'weight': 3},
          {'label': 'Invoice'},
          {'label': 'Status'},
          {'label': 'Amount', 'align': 'end'},
        ],
        'rows': [
          {
            'cells': ['Harper & Co', 'INV-0912', 'Overdue 14d', r'$3,850'],
          },
        ],
      },
    ], width: 412);
    expect(find.text('INV-0912'), findsOneWidget);
    final scroller = find.descendant(
      of: find.byType(CardChatCard),
      matching: find.byType(SingleChildScrollView),
    );
    expect(scroller, findsOneWidget);
    // The table is laid out at its floor, which is wider than the card: the
    // last column sits past the card's edge until the person drags it in.
    expect(
      tester.getRect(find.text(r'$3,850')).right,
      greaterThan(tester.getRect(find.byType(CardChatCard)).right),
    );
    await captureFamily(tester, 'wide-table-before-drag');

    // Dragging the table sideways brings that last column back inside the
    // card, which is what makes a scroller an answer rather than a loss.
    await tester.drag(scroller, const Offset(-400, 0));
    await tester.pumpAndSettle();
    expect(
      tester.getRect(find.text(r'$3,850')).right,
      lessThanOrEqualTo(tester.getRect(find.byType(CardChatCard)).right + 0.5),
    );
    expect(find.text('INV-0912'), findsOneWidget);
    await captureFamily(tester, 'wide-table-after-drag');

    // Three columns fit, and nothing scrolls.
    await drawFamily(tester, [
      {
        'id': 'root',
        'component': 'DataTable',
        'columns': [
          {'label': 'Client'},
          {'label': 'Status'},
          {'label': 'Amount', 'align': 'end'},
        ],
        'rows': [
          {
            'cells': ['Harper & Co', 'Overdue 14d', r'$3,850'],
          },
        ],
      },
    ], width: 412);
    expect(
      find.descendant(
        of: find.byType(CardChatCard),
        matching: find.byType(SingleChildScrollView),
      ),
      findsNothing,
    );
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a short row is padded and a long one loses its tail', (
    tester,
  ) async {
    await drawFamily(tester, [
      {
        'id': 'root',
        'component': 'DataTable',
        'columns': [
          {'label': 'Item'},
          {'label': 'Amount'},
        ],
        'rows': [
          {
            'cells': ['Only a name'],
          },
          {
            'cells': ['Too many', '1', 'dropped'],
          },
        ],
      },
    ]);
    expect(find.text('Only a name'), findsOneWidget);
    expect(find.text('Too many'), findsOneWidget);
    expect(find.text('dropped'), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('Timeline runs a rail that stops at the last entry', (
    tester,
  ) async {
    await drawFamily(tester, [
      {
        'id': 'root',
        'component': 'Timeline',
        'entries': [
          {'title': 'Fetched the thread', 'time': '9:14am'},
          {
            'title': 'Drafted the reply',
            'detail': 'Two paragraphs, no attachments',
            'time': '9:15am',
            'tone': 'success',
          },
        ],
      },
    ]);
    expect(find.text('Fetched the thread'), findsOneWidget);
    expect(find.text('Two paragraphs, no attachments'), findsOneWidget);
    final rails = tester
        .widgetList<FrockTimelineRail>(find.byType(FrockTimelineRail))
        .toList();
    expect(rails, hasLength(2));
    expect(rails.first.last, isFalse);
    expect(rails.last.last, isTrue);
    expect(rails.last.tone, FrockTone.success);
    await captureFamily(tester, 'family-data-timeline');
    await tester.pumpWidget(const SizedBox());
  });
}
