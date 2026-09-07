import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/admin/page.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'settings_test.dart' show SettingsApi;
import 'widget_test.dart' show MemoryStore;

Map<String, Object?> policy({bool open = true, int revision = 3}) => {
  'schemaVersion': 1,
  'revision': revision,
  'signups': {'open': open},
  'updatedAt': '2026-09-05T10:00:00.000Z',
  'updatedBy': 'tim',
};

void main() {
  testWidgets('an admin opens signups and the answer is what is shown', (
    tester,
  ) async {
    var open = false;
    final sent = <Map<String, Object?>>[];
    final api = SettingsApi(MemoryStore(), (_, body) async {
      if (body == null) return policy(open: open);
      final command = (body as Map).cast<String, Object?>();
      sent.add(command);
      open = command['open'] == true;
      return policy(open: open, revision: 4);
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: AdminPage(api: api),
      ),
    );
    await tester.pumpAndSettle();
    expect(
      find.text('Only people who already have an account can sign in.'),
      findsOneWidget,
    );
    await tester.tap(find.byType(SwitchListTile));
    await tester.pumpAndSettle();
    expect(sent.single, {
      'schemaVersion': 1,
      'type': 'deployment/set-signups',
      'open': true,
      'revision': 3,
    });
    expect(
      find.text('Anyone with the link can create an account.'),
      findsOneWidget,
    );
  });

  testWidgets('a refusal says who it is for and not what the route said', (
    tester,
  ) async {
    final api = SettingsApi(MemoryStore(), (_, _) async {
      throw const RequestFailure('synthetic backend detail', 403);
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: AdminPage(api: api),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Admin only'), findsOneWidget);
    expect(find.textContaining('synthetic backend'), findsNothing);
  });
}
