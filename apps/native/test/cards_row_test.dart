/// Every Frock component inside a `Row`, which is a composition the Skill
/// invites and `genui` does not constrain.
///
/// `genui`'s `Row` wraps a child in a `Flexible` only when the model wrote a
/// `weight` on it or the component declares itself implicitly flexible. A
/// child it does not wrap is laid out with unbounded width — and a component
/// with a scroller, an `Expanded` or a stretched `Column` inside it does not
/// survive that. A Frock component may not be a card that fails to draw
/// because of where it was put, so every one of them takes a share of the row
/// it is in, and this is the test that says so for all of them at once.
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/cards/frock_catalog/frock_catalog.dart';

import 'cards_families.dart';

/// One minimal, valid instance of each Frock component, by name. Every
/// component in the catalog must appear here: the last test fails when the
/// catalog grows past this list.
final Map<String, Map<String, Object?>> minimalFrockComponents = {
  'StatusPill': {'label': 'Ready'},
  'KeyValueRows': {
    'rows': [
      {'label': 'To', 'value': 'nick@example.com'},
    ],
  },
  'CollapsibleText': {'text': 'A body of the draft.'},
  'ApprovalActions': {'approvalId': 'ap-1'},
  'ConnectApp': {
    'app': 'gmail',
    'name': 'Gmail',
    'description': 'Read, search, label and send email in a Gmail account.',
    'packageId': 'connect',
    'connectionTypeId': 'connect-gmail',
  },
  'Receipt': {'title': 'Following up', 'status': 'Sent'},
  'CardHeader': {'title': 'September invoices', 'status': 'Action needed'},
  'SectionHeader': {'title': 'Line items', 'caption': '4'},
  'Callout': {'text': 'Chased twice already.', 'tone': 'warning'},
  'IdentityRow': {'name': 'Nick Adams', 'detail': 'nick@example.com'},
  'MetricTile': {'label': 'Outstanding', 'value': r'$12,400'},
  'ProgressBar': {'value': 0.4, 'label': 'Importing', 'caption': '3 of 7'},
  'DataTable': {
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
  'Timeline': {
    'entries': [
      {'title': 'Fetched the thread', 'time': '9:14am'},
      {'title': 'Drafted the reply', 'detail': 'Two paragraphs'},
    ],
  },
  'Markdown': {
    'text': '**Three things changed**\n\n- the retainer\n- the rate',
  },
  'CodeBlock': {'code': 'bun run dev --port 8797', 'language': 'bash'},
  'Quote': {'text': 'Can we make it monthly?', 'attribution': 'Nick'},
  'ImageGallery': {
    'images': [
      {'url': 'https://example.com/a.png', 'alt': 'One'},
      {'url': 'https://example.com/b.png', 'alt': 'Two'},
      {'url': 'https://example.com/c.png', 'alt': 'Three'},
    ],
  },
  'FileAttachment': {
    'name': 'September invoices.pdf',
    'detail': 'PDF · 1.2 MB',
    'url': 'https://example.com/september.pdf',
  },
  'LinkPreview': {'url': 'https://example.com/pricing', 'title': 'Pricing'},
  'ChoiceChips': {
    'value': {'path': '/tone'},
    'options': [
      {'label': 'Warm', 'value': 'warm'},
      {'label': 'Brief', 'value': 'brief'},
    ],
  },
  'MultiSelect': {
    'values': {'path': '/include'},
    'options': [
      {'label': 'The invoice', 'value': 'invoice'},
      {'label': 'The timesheet', 'value': 'timesheet'},
    ],
  },
  'SegmentedControl': {
    'value': {'path': '/view'},
    'options': [
      {'label': 'Summary', 'value': 'summary'},
      {'label': 'Full', 'value': 'full'},
    ],
  },
  'Rating': {
    'value': {'path': '/stars'},
    'label': 'How was that reply?',
  },
};

void main() {
  for (final entry in minimalFrockComponents.entries) {
    testWidgets('${entry.key} draws inside a Row at phone width', (
      tester,
    ) async {
      await drawFamily(
        tester,
        [
          {
            'id': 'root',
            'component': 'Row',
            'children': ['label', 'subject'],
          },
          {'id': 'label', 'component': 'Text', 'text': 'Beside it:'},
          {'id': 'subject', 'component': entry.key, ...entry.value},
        ],
        dataModel: {
          'tone': 'warm',
          'include': <String>[],
          'view': 'summary',
          'stars': 0,
        },
        width: 412,
      );
      // The card drew: the host's unavailable region is what a refusal looks
      // like, and an exception in the build would have been rethrown by the
      // test binding before this line.
      expect(find.text('This card can’t be shown'), findsNothing);
      expect(find.text('Beside it:'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    });
  }

  test('every Frock component is covered by that Row test', () {
    expect(
      minimalFrockComponents.keys.toSet(),
      frockCatalogSchemasV1.keys.toSet(),
    );
  });

  test('every Frock component takes a share of the row it is in', () {
    for (final item in frockCatalogItemsV1) {
      expect(
        item.isImplicitlyFlexible,
        isTrue,
        reason:
            '${item.name} would be laid out at unbounded width in a Row, '
            'which is a composition the Skill invites',
      );
    }
  });
}
