/// The rich text family (ADR 0030 step 8): prose, code and quotation.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_client/cards/frock_catalog/frock_catalog.dart';
import 'package:frockbot_client/shell/markdown.dart';

import 'cards_families.dart';

void main() {
  setUpAll(() async {
    if (familyVisualOutput.isNotEmpty) await loadFamilyFont();
  });

  testWidgets('Markdown is drawn by the renderer the Bot’s own messages use', (
    tester,
  ) async {
    await drawFamily(tester, [
      {
        'id': 'root',
        'component': 'Markdown',
        'text':
            '**Three things changed**\n\n- the retainer is monthly now\n'
            '- the scope covers support',
      },
    ]);
    expect(find.byType(ShellMarkdown), findsOneWidget);
    expect(find.textContaining('Three things changed'), findsWidgets);
    expect(find.textContaining('the retainer is monthly now'), findsWidgets);
    await captureFamily(tester, 'family-rich-markdown');
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a Markdown link opens through the host, and only over https', (
    tester,
  ) async {
    final opened = <String>[];
    final host = frockOpenLinkV1;
    frockOpenLinkV1 = (url) async {
      opened.add(url);
      return true;
    };
    addTearDown(() => frockOpenLinkV1 = host);
    await drawFamily(tester, [
      {
        'id': 'root',
        'component': 'Markdown',
        'text': 'See [the thread](https://example.com/thread).',
      },
    ]);
    await tester.tap(find.textContaining('the thread'));
    await tester.pumpAndSettle();
    expect(opened, ['https://example.com/thread']);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('CodeBlock keeps the text exactly, and copies it', (
    tester,
  ) async {
    final clipboard = <String>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (call) async {
        if (call.method == 'Clipboard.setData') {
          clipboard.add((call.arguments as Map)['text'] as String);
        }
        return null;
      },
    );
    addTearDown(
      () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        null,
      ),
    );
    await drawFamily(tester, [
      {
        'id': 'root',
        'component': 'CodeBlock',
        'code': 'bun run dev\n  --port 8797',
        'language': 'bash',
        'caption': 'From the README',
      },
    ]);
    expect(find.text('bash'), findsOneWidget);
    expect(find.text('From the README'), findsOneWidget);
    expect(find.text('Copy'), findsOneWidget);
    await tester.tap(find.text('Copy'));
    await tester.pumpAndSettle();
    expect(clipboard, ['bun run dev\n  --port 8797']);
    expect(find.text('Copied'), findsOneWidget);
    await captureFamily(tester, 'family-rich-code');
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('Quote sets someone else’s words apart, with who said them', (
    tester,
  ) async {
    await drawFamily(
      tester,
      [
        {
          'id': 'root',
          'component': 'Quote',
          'text': {'path': '/said'},
          'attribution': 'Nick, Tuesday 9:14am',
        },
      ],
      dataModel: {'said': 'Can we make the retainer monthly?'},
    );
    expect(find.text('Can we make the retainer monthly?'), findsOneWidget);
    expect(find.text('Nick, Tuesday 9:14am'), findsOneWidget);
    await captureFamily(tester, 'family-rich-quote');
    await tester.pumpWidget(const SizedBox());
  });
}
