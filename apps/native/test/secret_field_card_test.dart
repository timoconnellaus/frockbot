import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/cards/chat_card.dart';
import 'package:frockbot_native/cards/frock_catalog/frock_catalog.dart';
import 'package:frockbot_native/shell/semantics.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'cards_test.dart' show cardJson;
import 'settings_test.dart' show SettingsApi;
import 'widget_test.dart' show MemoryStore;

const requestId = 'secret-request-0123456789abcdef0123456789abcdef';
const typed = 'hunter2-correct-horse';

/// The secret request the `credentials` Plugin draws, as the kernel bound it.
List<Map<String, Object?>> request({String state = 'waiting'}) => [
  {
    'id': 'root',
    'component': 'Column',
    'children': ['header', 'field'],
  },
  {
    'id': 'header',
    'component': 'CardHeader',
    'title': 'Your shop password',
    'subtitle': 'Secret',
  },
  {
    'id': 'field',
    'component': 'SecretField',
    'requestId': requestId,
    'payment': false,
    'state': state,
  },
];

void main() {
  late List<(String, Object?)> requests;

  Future<void> draw(WidgetTester tester) async {
    requests = [];
    var saved = false;
    final api = SettingsApi(MemoryStore(), (path, body) async {
      requests.add((path, body));
      if (path.contains('/secret-requests/')) {
        saved = true;
        return {
          'schemaVersion': 1,
          'status': 'saved',
          'card': cardJson(components: request(state: 'saved'), dataModel: {}),
        };
      }
      return cardJson(
        components: request(state: saved ? 'saved' : 'waiting'),
        dataModel: {},
      );
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.light),
        home: Scaffold(
          body: CardChatScope(
            api: api,
            botId: 'bot-1',
            child: const CardChatCard(surfaceId: 'draft-1'),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('a typed secret goes to its own route and nowhere else', (
    tester,
  ) async {
    await draw(tester);
    expect(
      find.bySemanticsIdentifier(ShellIds.secretField(requestId)),
      findsOneWidget,
    );
    final field = find.byType(TextField);
    final input = tester.widget<TextField>(field);
    expect(input.obscureText, isTrue);
    expect(input.enableSuggestions, isFalse);
    expect(input.autocorrect, isFalse);

    await tester.enterText(field, typed);
    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle();

    final posts = requests.where((request) => request.$2 != null).toList();
    expect(posts, hasLength(1));
    expect(
      posts.single.$1,
      '/api/bots/bot-1/secret-requests/$requestId',
    );
    final body = (posts.single.$2! as Map).cast<String, Object?>();
    expect(body['value'], typed);
    expect(body['commandId'], isA<String>());
    // Not a card action: nothing else carried it, and the card now says it
    // is saved rather than holding the value in a field.
    expect(
      requests
          .where((request) => request.$1.endsWith('/cards'))
          .every((request) => !request.$2.toString().contains(typed)),
      isTrue,
    );
    expect(find.text('Saved to your account'), findsOneWidget);
    expect(find.text(typed), findsNothing);
    expect(find.byType(TextField), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a field with nowhere to go cannot be saved', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.light),
        home: const Scaffold(
          body: FrockSecretFieldView(requestId: requestId),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Secrets can’t be saved here.'), findsOneWidget);
    expect(
      tester.widget<FilledButton>(find.byType(FilledButton)).onPressed,
      isNull,
    );
    await tester.pumpWidget(const SizedBox());
  });
}
