import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/chat_controller.dart';
import 'package:frockbot_native/protocol/client_wire.generated.dart' as wire;
import 'package:frockbot_native/ui/bot_page.dart';
import 'package:frockbot_native/ui/chat_pane.dart';
import 'package:frockbot_native/ui/frock_tokens.dart';
import 'package:frockbot_native/ui/frock_widgets.dart';

import 'widget_test.dart' show FakeTransport, MemoryStore;

Map<String, dynamic> turnWithWork() => {
  'runId': 'turn-1',
  'admittedAt': '2026-09-05T01:00:00Z',
  'input': 'Find Sarah’s email',
  'status': 'completed',
  'outcome': {'text': 'Found it. She wants Q3 by region.'},
  'events': [
    {
      'type': 'tool/call',
      'call': {
        'id': 'c1',
        'name': 'computer_exec',
        'input': {'command': 'ls'},
      },
    },
    {'type': 'tool/result', 'callId': 'c1', 'isError': false, 'content': ''},
  ],
};

Map<String, dynamic> registration() => {
  'schemaVersion': 1,
  'botId': 'bot-1',
  'registeredAt': '2026-09-05T00:00:00.000Z',
  'initialName': 'Bob',
  'sheep': {
    'schemaVersion': 1,
    'background': 'a',
    'upper': 'b',
    'middle': 'c',
    'lower': 'd',
  },
};

void main() {
  testWidgets('a Bot’s Work shows its tool calls as receipts; chat does not', (
    tester,
  ) async {
    final store = MemoryStore();
    final transport = FakeTransport(store)..observed = turnWithWork();
    final controller = ChatController(
      transport: transport,
      store: store,
      userId: 'user-1',
      botId: 'bot-1',
    );
    await controller.initialize();
    controller.connection = ConnectionState.connected;

    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTokens.themeData(FrockTokens.dark),
        home: Scaffold(
          body: ChatPane(controller: controller, onReconnect: () async {}),
        ),
      ),
    );
    await tester.pump();
    expect(find.text('Found it. She wants Q3 by region.'), findsOneWidget);
    expect(find.byType(FrockReceipt), findsNothing);

    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTokens.themeData(FrockTokens.dark),
        home: BotPage(
          bot: wire.BotRegistration.fromJson(registration()),
          controller: controller,
          state: BotState.working,
        ),
      ),
    );
    await tester.pump();
    expect(find.text('Bob'), findsWidgets);
    expect(find.text('Working'), findsOneWidget);
    expect(find.byType(FrockReceipt), findsOneWidget);
    expect(find.text('done'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
