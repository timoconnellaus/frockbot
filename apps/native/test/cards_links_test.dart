/// The https-only question, asked of links that are not at the top level
/// (ADR 0030 step 8): admission walks every literal link at any depth, and the
/// host asks again at the moment of opening.
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/cards/frock_catalog/frock_catalog.dart';

import 'cards_families.dart';

void main() {
  testWidgets('an insecure link buried three deep refuses the whole card', (
    tester,
  ) async {
    await drawFamily(tester, [
      {
        'id': 'root',
        'component': 'Column',
        'children': ['head', 'inner'],
      },
      {'id': 'head', 'component': 'SectionHeader', 'title': 'Sources'},
      {
        'id': 'inner',
        'component': 'Column',
        'children': ['link'],
      },
      {
        'id': 'link',
        'component': 'LinkPreview',
        'url': 'http://insecure.example.com/page',
        'title': 'A page',
      },
    ]);
    expect(find.text('This card can’t be shown'), findsOneWidget);
    expect(find.text('Sources'), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('an insecure thumbnail on an otherwise https link also refuses', (
    tester,
  ) async {
    await drawFamily(tester, [
      {
        'id': 'root',
        'component': 'LinkPreview',
        'url': 'https://example.com/page',
        'title': 'A page',
        'imageUrl': 'http://example.com/thumb.png',
      },
    ]);
    expect(find.text('This card can’t be shown'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('an insecure file attachment inside a Column refuses', (
    tester,
  ) async {
    await drawFamily(tester, [
      {
        'id': 'root',
        'component': 'Column',
        'children': ['file'],
      },
      {
        'id': 'file',
        'component': 'FileAttachment',
        'name': 'statement.pdf',
        'url': 'http://example.com/statement.pdf',
      },
    ]);
    expect(find.text('This card can’t be shown'), findsOneWidget);
    expect(find.text('statement.pdf'), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('the same card over https is drawn', (tester) async {
    await drawFamily(tester, [
      {
        'id': 'root',
        'component': 'Column',
        'children': ['file'],
      },
      {
        'id': 'file',
        'component': 'FileAttachment',
        'name': 'statement.pdf',
        'url': 'https://example.com/statement.pdf',
      },
    ]);
    expect(find.text('statement.pdf'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  test('the host refuses to open a non-https link at the moment of opening',
      () async {
    expect(await frockOpenLinkV1('http://example.com'), isFalse);
    expect(await frockOpenLinkV1('javascript:alert(1)'), isFalse);
    expect(await frockOpenLinkV1('file:///etc/passwd'), isFalse);
  });
}
