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

Map<String, Object?> billing({int complimentaryMicros = 0}) => {
  'includedMicros': 0,
  'purchasedMicros': 0,
  'complimentaryMicros': complimentaryMicros,
  'reservedMicros': 0,
  'subscribed': false,
  'canSpend': complimentaryMicros > 0,
  'suspended': false,
};

Map<String, Object?> accounts({
  required bool guestApplets,
  int guestCreditMicros = 0,
}) => {
  'schemaVersion': 1,
  'users': [
    {
      'userId': 'tim-id',
      'email': 'tim@example.com',
      'name': 'Tim',
      'features': features(applets: true),
      'billing': billing(),
    },
    {
      'userId': 'guest-id',
      'email': 'guest@example.com',
      'name': 'Guest',
      'features': features(applets: guestApplets),
      'billing': billing(complimentaryMicros: guestCreditMicros),
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

    // The Plugin-authoring switch (ADR 0026) sends the account's Applets
    // value along unchanged, so flipping one never resets the other.
    sent.clear();
    final authoring = find.descendant(
      of: find.bySemanticsIdentifier(AdminIds.pluginAuthoring('guest-id')),
      matching: find.byType(SwitchListTile),
    );
    expect(tester.widget<SwitchListTile>(authoring).value, isFalse);
    await tester.tap(authoring);
    await tester.pumpAndSettle();
    expect(sent, {
      'schemaVersion': 1,
      'type': 'user/set-features',
      'applets': true,
      'pluginAuthoring': true,
    });
  });

  testWidgets('an admin grants an account credit, once, with a reason', (
    tester,
  ) async {
    // Each account is three rows now; the list is lazy, so the rows this
    // test reaches need a surface tall enough to build them.
    await tester.binding.setSurfaceSize(const Size(800, 2000));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    var guestCredit = 0;
    final sent = <Map<String, Object?>>[];
    final api = SettingsApi(MemoryStore(), (path, body) async {
      if (path == '/api/admin/policy') return policy();
      if (path == '/api/admin/users') {
        return accounts(guestApplets: false, guestCreditMicros: guestCredit);
      }
      if (path == '/api/admin/users/guest-id/credit') {
        final command = (body as Map).cast<String, Object?>();
        sent.add(command);
        guestCredit += (command['cents'] as int) * 10000;
        return billing(complimentaryMicros: guestCredit);
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
    expect(
      find.descendant(
        of: find.bySemanticsIdentifier(AdminIds.credit('guest-id')),
        matching: find.textContaining('US\$0.00 complimentary'),
      ),
      findsOneWidget,
    );
    await tester.tap(
      find.bySemanticsIdentifier(AdminIds.addCredit('guest-id')),
    );
    await tester.pumpAndSettle();
    expect(find.bySemanticsIdentifier(AdminIds.creditDialog), findsOneWidget);
    // Nothing to send until an amount and a reason are both given.
    final confirm = find.descendant(
      of: find.bySemanticsIdentifier(AdminIds.creditConfirm),
      matching: find.byType(FilledButton),
    );
    expect(tester.widget<FilledButton>(confirm).onPressed, isNull);
    await tester.tap(find.bySemanticsIdentifier(AdminIds.creditAmount(1000)));
    await tester.pumpAndSettle();
    expect(tester.widget<FilledButton>(confirm).onPressed, isNull);
    await tester.enterText(
      find.descendant(
        of: find.bySemanticsIdentifier(AdminIds.creditReason),
        matching: find.byType(TextField),
      ),
      'Early tester',
    );
    await tester.pumpAndSettle();
    await tester.tap(confirm);
    await tester.pumpAndSettle();
    expect(sent, hasLength(1));
    expect(sent.single, {
      'schemaVersion': 1,
      'type': 'user/grant-credit',
      'id': sent.single['id'],
      'cents': 1000,
      'reason': 'Early tester',
    });
    expect((sent.single['id'] as String).isNotEmpty, isTrue);
    expect(find.bySemanticsIdentifier(AdminIds.creditDialog), findsNothing);
    // The answer is what is shown: the balance the grant left.
    expect(
      find.descendant(
        of: find.bySemanticsIdentifier(AdminIds.credit('guest-id')),
        matching: find.textContaining('US\$10.00 complimentary'),
      ),
      findsOneWidget,
    );
  });

  testWidgets(
    'an account whose Applets setting could not be read is unreadable, not off',
    (tester) async {
      // Each account is three rows now; the list is lazy, so the rows this
      // test reaches need a surface tall enough to build them.
      await tester.binding.setSurfaceSize(const Size(800, 2000));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      var reads = 0;
      final api = SettingsApi(MemoryStore(), (path, body) async {
        if (path == '/api/admin/policy') return policy();
        if (path == '/api/admin/users') {
          reads += 1;
          final listed = accounts(guestApplets: true);
          if (reads == 1) {
            final users = (listed['users'] as List)
                .cast<Map<String, Object?>>();
            listed['users'] = [
              users[0],
              {
                ...users[1],
                'features': {'unavailable': true},
              },
            ];
          }
          return listed;
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
      final guest = find.descendant(
        of: find.bySemanticsIdentifier(AdminIds.applets('guest-id')),
        matching: find.byType(SwitchListTile),
      );
      expect(tester.widget<SwitchListTile>(guest).onChanged, isNull);
      expect(
        find.text('Couldn’t read whether Applets are on for this account.'),
        findsOneWidget,
      );
      final tim = find.descendant(
        of: find.bySemanticsIdentifier(AdminIds.applets('tim-id')),
        matching: find.byType(SwitchListTile),
      );
      expect(tester.widget<SwitchListTile>(tim).onChanged, isNotNull);
      expect(tester.widget<SwitchListTile>(tim).value, isTrue);
      expect(
        find.text('Couldn’t load the accounts. Refresh to try again.'),
        findsNothing,
      );

      await tester.tap(
        find.descendant(
          of: find.bySemanticsIdentifier(AdminIds.appletsRetry('guest-id')),
          matching: find.byType(TextButton),
        ),
      );
      await tester.pumpAndSettle();
      expect(reads, 2);
      expect(tester.widget<SwitchListTile>(guest).onChanged, isNotNull);
      expect(tester.widget<SwitchListTile>(guest).value, isTrue);
      expect(
        find.text('Couldn’t read whether Applets are on for this account.'),
        findsNothing,
      );
    },
  );

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
