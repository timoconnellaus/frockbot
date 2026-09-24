import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/settings/account_deletion.dart';

import 'native_session.dart';
import 'widget_test.dart' show MemoryStore;

void main() {
  test('the phrase is compared as an email is', () {
    expect(deletionConfirmed('Tim@Example.com', ' tim@example.COM '), isTrue);
    expect(deletionConfirmed('tim@example.com', 'tim@example.co'), isFalse);
  });

  testWidgets(
    'deletes the account only once the address is typed, then signs out',
    (tester) async {
      final posted = <Object?>[];
      var signedOut = 0;
      final api = NativeSessionApi(MemoryStore(), (path, body) async {
        expect(path, accountDeletionPath);
        if (body == null) {
          return {'schemaVersion': 1, 'confirmation': 'tim@example.com'};
        }
        posted.add(body);
        return {'schemaVersion': 1, 'status': 'deleting'};
      });
      await tester.pumpWidget(
        MaterialApp(
          home: DeletionPage(
            api: api,
            onAccountDeleted: () async => signedOut += 1,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Type tim@example.com to confirm.'), findsOneWidget);
      final delete = find.widgetWithText(FilledButton, 'Delete account');
      expect(tester.widget<FilledButton>(delete).onPressed, isNull);

      await tester.enterText(find.byType(TextField), 'someone@example.com');
      await tester.pump();
      expect(tester.widget<FilledButton>(delete).onPressed, isNull);

      await tester.enterText(find.byType(TextField), 'Tim@Example.com');
      await tester.pump();
      await tester.ensureVisible(delete);
      await tester.pumpAndSettle();
      await tester.tap(delete);
      await tester.pumpAndSettle();

      expect(posted, hasLength(1));
      final command = posted.single! as Map;
      expect(command['schemaVersion'], 1);
      expect(command['confirmation'], 'Tim@Example.com');
      expect(command['commandId'], isA<String>());
      expect(signedOut, 1);
      api.close();
    },
  );

  testWidgets(
    'a refused confirmation says what to type and signs nothing out',
    (tester) async {
      var signedOut = 0;
      final api = NativeSessionApi(MemoryStore(), (path, body) async {
        if (body == null) {
          return {'schemaVersion': 1, 'confirmation': 'tim@example.com'};
        }
        throw const RequestFailure(
          'That action could not be completed.',
          409,
          'confirmation-mismatch',
        );
      });
      await tester.pumpWidget(
        MaterialApp(
          home: DeletionPage(
            api: api,
            onAccountDeleted: () async => signedOut += 1,
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), 'tim@example.com');
      await tester.pump();
      final delete = find.widgetWithText(FilledButton, 'Delete account');
      await tester.ensureVisible(delete);
      await tester.pumpAndSettle();
      await tester.tap(delete);
      await tester.pumpAndSettle();

      expect(find.text('Type tim@example.com to confirm.'), findsNWidgets(2));
      expect(signedOut, 0);
      api.close();
    },
  );

  testWidgets(
    'deletes the Computer after asking, and a retried press is the same command',
    (tester) async {
      final commands = <String>[];
      var fail = true;
      final api = NativeSessionApi(MemoryStore(), (path, body) async {
        if (path == accountDeletionPath) {
          return {'schemaVersion': 1, 'confirmation': 'tim@example.com'};
        }
        expect(path, computerDeletionPath);
        commands.add((body! as Map)['commandId'] as String);
        if (fail) {
          fail = false;
          throw const RequestFailure('The Computer host is unavailable', 502);
        }
        return {'schemaVersion': 1, 'status': 'deleted'};
      });
      await tester.pumpWidget(
        MaterialApp(
          home: DeletionPage(api: api, onAccountDeleted: () async {}),
        ),
      );
      await tester.pumpAndSettle();

      Future<void> press({required bool confirm}) async {
        await tester.tap(
          find.widgetWithText(OutlinedButton, 'Delete my Computer'),
        );
        await tester.pumpAndSettle();
        expect(find.text('Delete your Computer?'), findsOneWidget);
        await tester.tap(
          find.descendant(
            of: find.byType(AlertDialog),
            matching: find.text(confirm ? 'Delete' : 'Cancel'),
          ),
        );
        await tester.pumpAndSettle();
      }

      await press(confirm: false);
      expect(commands, isEmpty);

      await press(confirm: true);
      expect(find.text('The Computer host is unavailable'), findsOneWidget);
      await press(confirm: true);
      expect(find.text('Your Computer was deleted.'), findsOneWidget);
      expect(commands, hasLength(2));
      expect(commands.first, commands.last);
      api.close();
    },
  );
}
