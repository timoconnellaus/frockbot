/// What the thread draws for a Card send itself: the renderer, keyed by the
/// surface, and a line saying so when the send names no surface at all. What
/// the renderer then draws is `cards_test.dart`.
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/cards/chat_card.dart';
import 'package:frockbot_native/shell/send_payload.dart';
import 'package:frockbot_native/shell/transcript_model.dart';

Widget drawn(Map<String, Object?>? payload) => MaterialApp(
  home: Scaffold(body: SendPayloadView(send: SendPayloadLine(payload))),
);

void main() {
  testWidgets('a card send is the renderer, keyed by its surface', (
    tester,
  ) async {
    await tester.pumpWidget(
      drawn({
        'type': 'card',
        'surfaceId': 'draft-email',
        'messages': const [],
      }),
    );
    final card = tester.widget<CardChatCard>(find.byType(CardChatCard));
    expect(card.surfaceId, 'draft-email');
    expect(card.key, const ValueKey('draft-email'));
    // Drawn with no Bot to read it as, the host says so rather than spinning.
    expect(find.text('Cards are unavailable here.'), findsOneWidget);
  });

  testWidgets('a card with no surface is a line saying so, not a blank', (
    tester,
  ) async {
    await tester.pumpWidget(drawn({'type': 'card', 'messages': const []}));
    expect(
      find.text('This client cannot display that message.'),
      findsOneWidget,
    );
  });
}
