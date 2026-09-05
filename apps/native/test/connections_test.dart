import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/connections/page.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'settings_test.dart' show SettingsApi;
import 'widget_test.dart' show MemoryStore;

void main() {
  testWidgets(
    'Connectors recovers from offline without showing raw backend errors',
    (tester) async {
      var offline = true;
      final api = SettingsApi(MemoryStore(), (_, _) async {
        if (offline) throw const RequestFailure('synthetic backend detail');
        return {
          'schemaVersion': 1,
          'ownerId': 'tim',
          'revision': 1,
          'accounts': [],
        };
      });
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: ConnectionsPage(api: api, userId: 'tim'),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.textContaining('synthetic backend'), findsNothing);
      expect(find.text('Connections couldn’t load'), findsOneWidget);
      offline = false;
      await tester.tap(find.text('Try again'));
      await tester.pumpAndSettle();
      expect(find.text('Your accounts, together'), findsOneWidget);
      expect(find.text('Manage connections'), findsOneWidget);
    },
  );
}
