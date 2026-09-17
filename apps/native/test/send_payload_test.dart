/// What the thread draws for a Card before there is a renderer for one.
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/shell/send_payload.dart';
import 'package:frockbot_native/shell/transcript_model.dart';

Widget drawn(Map<String, Object?>? payload) => MaterialApp(
  home: Scaffold(body: SendPayloadView(send: SendPayloadLine(payload))),
);

void main() {
  testWidgets('a card names its surface and claims nothing else', (
    tester,
  ) async {
    await tester.pumpWidget(
      drawn({
        'type': 'card',
        'surfaceId': 'draft-email',
        'messages': const [],
      }),
    );
    expect(find.text('Card'), findsOneWidget);
    expect(find.text('draft-email'), findsOneWidget);
  });

  testWidgets('a card with no surface is a line saying so, not a blank', (
    tester,
  ) async {
    await tester.pumpWidget(drawn({'type': 'card', 'messages': const []}));
    expect(find.text('This client cannot display that message.'), findsOneWidget);
  });
}
