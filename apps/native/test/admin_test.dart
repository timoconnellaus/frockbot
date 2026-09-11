import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/admin/page.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/shell/semantics.dart';
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

Map<String, Object?> features({required bool applets}) => {
  'schemaVersion': 1,
  'applets': applets,
  'updatedAt': '2026-09-05T10:00:00.000Z',
  'updatedBy': applets ? 'tim' : 'deployment-default',
};

Map<String, Object?> accounts({required bool guestApplets}) => {
  'schemaVersion': 1,
  'users': [
    {
      'userId': 'tim-id',
      'email': 'tim@example.com',
      'name': 'Tim',
      'features': features(applets: true),
    },
    {
      'userId': 'guest-id',
      'email': 'guest@example.com',
      'name': 'Guest',
      'features': features(applets: guestApplets),
    },
  ],
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

  testWidgets('an admin turns Applets on for one account', (tester) async {
    var guestApplets = false;
    final sent = <String, Object?>{};
    final api = SettingsApi(MemoryStore(), (path, body) async {
      if (path == '/api/admin/policy') return policy();
      if (path == '/api/admin/users') {
        return accounts(guestApplets: guestApplets);
      }
      if (path == '/api/admin/users/guest-id/features') {
        sent.addAll((body as Map).cast<String, Object?>());
        guestApplets = sent['applets'] == true;
        return features(applets: guestApplets);
      }
      throw StateError('unexpected $path');
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: AdminPage(api: api),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Tim'), findsOneWidget);
    expect(find.text('Guest'), findsOneWidget);
    final guest = find.descendant(
      of: find.bySemanticsIdentifier(AdminIds.applets('guest-id')),
      matching: find.byType(SwitchListTile),
    );
    expect(tester.widget<SwitchListTile>(guest).value, isFalse);
    await tester.tap(guest);
    await tester.pumpAndSettle();
    expect(sent, {
      'schemaVersion': 1,
      'type': 'user/set-features',
      'applets': true,
    });
    expect(tester.widget<SwitchListTile>(guest).value, isTrue);
    final tim = find.descendant(
      of: find.bySemanticsIdentifier(AdminIds.applets('tim-id')),
      matching: find.byType(SwitchListTile),
    );
    expect(tester.widget<SwitchListTile>(tim).value, isTrue);
  });

  testWidgets('a write that fails says so after the list reloads', (
    tester,
  ) async {
    final api = SettingsApi(MemoryStore(), (path, body) async {
      if (path == '/api/admin/policy') return policy();
      if (path == '/api/admin/users') return accounts(guestApplets: false);
      throw const RequestFailure('synthetic backend detail', 500);
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: AdminPage(api: api),
      ),
    );
    await tester.pumpAndSettle();
    final guest = find.descendant(
      of: find.bySemanticsIdentifier(AdminIds.applets('guest-id')),
      matching: find.byType(SwitchListTile),
    );
    await tester.tap(guest);
    await tester.pumpAndSettle();
    expect(
      find.text('That change didn’t stick. Refresh and try again.'),
      findsOneWidget,
    );
    expect(tester.widget<SwitchListTile>(guest).value, isFalse);
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
