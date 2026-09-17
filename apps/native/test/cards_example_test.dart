/// The Skill's published examples, drawn rather than read.
///
/// `app/cards/skills/a2ui/references/examples.md` is generated output a Bot
/// composes against, so whatever it publishes is what a Bot sends. Each card
/// in it is decoded and handed to the host: a published example this host
/// refuses, or one that draws outside the card it was sent into, is a wrong
/// instruction to every Bot that reads the reference.
library;

import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/cards/chat_card.dart';

import 'cards_families.dart';

/// The reference, from the app's own directory — or wherever the live runner
/// was told it is, since a built app does not run from the repository.
const examplesPath = String.fromEnvironment(
  'CARD_EXAMPLES_MD',
  defaultValue: '../../app/cards/skills/a2ui/references/examples.md',
);

/// One card the reference tells a Bot to send.
class PublishedCard {
  final String surfaceId;
  final List<Map<String, Object?>> components;
  final Map<String, Object?> dataModel;
  final bool sendDataModel;
  const PublishedCard(
    this.surfaceId,
    this.components,
    this.dataModel,
    this.sendDataModel,
  );
}

List<Map<String, Object?>> _jsonBlocks(String markdown) {
  final blocks = <Map<String, Object?>>[];
  final lines = markdown.split('\n');
  List<String>? open;
  for (final line in lines) {
    if (open == null) {
      if (line.trim() == '```json') open = [];
      continue;
    }
    if (line.trim() == '```') {
      final decoded = jsonDecode(open.join('\n'));
      if (decoded is Map) blocks.add(decoded.cast<String, Object?>());
      open = null;
      continue;
    }
    open.add(line);
  }
  return blocks;
}

/// Every `createSurface` the reference publishes, in the order it teaches
/// them.
List<PublishedCard> publishedCards(String markdown) {
  final cards = <PublishedCard>[];
  for (final block in _jsonBlocks(markdown)) {
    final payload = block['payload'];
    if (payload is! Map || payload['type'] != 'card') continue;
    for (final message in (payload['messages'] as List? ?? const [])) {
      final create = (message as Map)['createSurface'];
      if (create is! Map) continue;
      cards.add(
        PublishedCard(
          create['surfaceId']! as String,
          (create['components']! as List)
              .map((component) => (component as Map).cast<String, Object?>())
              .toList(),
          ((create['dataModel'] as Map?) ?? const {}).cast<String, Object?>(),
          create['sendDataModel'] == true,
        ),
      );
    }
  }
  return cards;
}

/// Whether [element] sits in a sideways scroller — the one place the host
/// deliberately draws past the card's edge, because the person can drag it
/// back.
bool _insideSideScroller(Element element) {
  var found = false;
  element.visitAncestorElements((ancestor) {
    final widget = ancestor.widget;
    if (widget is Scrollable && widget.axis == Axis.horizontal) {
      found = true;
      return false;
    }
    return true;
  });
  return found;
}

void _expectTextInsideCard(WidgetTester tester) {
  final frame = tester.getRect(find.byType(CardChatCard));
  for (final element in find.byType(Text).evaluate()) {
    final box = element.renderObject as RenderBox?;
    if (box == null || !box.hasSize || box.size.isEmpty) continue;
    if (_insideSideScroller(element)) continue;
    final rect = box.localToGlobal(Offset.zero) & box.size;
    expect(
      rect.left >= frame.left - 0.5 && rect.right <= frame.right + 0.5,
      isTrue,
      reason:
          'expected “${(element.widget as Text).data}” at $rect to sit inside '
          'the card at $frame',
    );
  }
}

void main() {
  final cards = publishedCards(File(examplesPath).readAsStringSync());

  test('the reference publishes cards to draw', () {
    expect(cards, isNotEmpty);
  });

  for (final card in cards) {
    testWidgets('the published card ${card.surfaceId} draws inside the card', (
      tester,
    ) async {
      await drawFamily(
        tester,
        card.components,
        dataModel: card.dataModel,
        sendDataModel: card.sendDataModel,
      );
      expect(find.text('This card can’t be shown'), findsNothing);
      _expectTextInsideCard(tester);
      await captureFamily(tester, 'published-${card.surfaceId}-412');
      await tester.pumpWidget(const SizedBox());
    });
  }

  testWidgets('a published table wide enough to fit is not a scroller', (
    tester,
  ) async {
    final withTable = cards.firstWhere(
      (card) => card.components.any(
        (component) => component['component'] == 'DataTable',
      ),
    );
    await drawFamily(
      tester,
      withTable.components,
      dataModel: withTable.dataModel,
      sendDataModel: withTable.sendDataModel,
      width: 1440,
    );
    expect(
      find.byWidgetPredicate(
        (widget) => widget is Scrollable && widget.axis == Axis.horizontal,
      ),
      findsNothing,
    );
    await captureFamily(tester, 'published-${withTable.surfaceId}-1440');
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('the published card that asks a question answers what was ticked', (
    tester,
  ) async {
    final asking = cards.firstWhere(
      (card) =>
          card.sendDataModel &&
          card.components.any((it) => it['component'] == 'MultiSelect'),
    );
    final multiSelect = asking.components.firstWhere(
      (it) => it['component'] == 'MultiSelect',
    );
    final path = ((multiSelect['values']! as Map)['path']! as String).substring(
      1,
    );
    final options = (multiSelect['options']! as List)
        .map((option) => (option as Map).cast<String, Object?>())
        .toList();
    final seeded = (asking.dataModel[path]! as List).cast<String>();
    final ticking = options.firstWhere(
      (option) => !seeded.contains(option['value']),
    );
    final submit = asking.components.firstWhere(
      (it) => it['component'] == 'Button' && it['action'] != null,
    );
    final action =
        ((submit['action']! as Map)['event']! as Map)['name']! as String;
    final submitLabel = asking.components.firstWhere(
      (it) => it['id'] == submit['child'],
    )['text']! as String;

    final posts = await drawFamily(
      tester,
      asking.components,
      dataModel: asking.dataModel,
      sendDataModel: asking.sendDataModel,
    );
    // An option's label may also be a value in the card's own table; the
    // control is drawn after it.
    await tester.tap(find.text(ticking['label']! as String).last);
    await tester.pumpAndSettle();
    await captureFamily(tester, 'published-${asking.surfaceId}-ticked');
    await tester.tap(find.text(submitLabel));
    await tester.pumpAndSettle();

    expect((posts.single['event']! as Map)['name'], action);
    expect((posts.single['dataModel']! as Map)[path], [
      for (final option in options)
        if (seeded.contains(option['value']) || identical(option, ticking))
          option['value'],
    ]);
    await tester.pumpWidget(const SizedBox());
  });
}
