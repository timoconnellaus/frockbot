/// You on a desktop is two columns: the rows, and the page the chosen one
/// opens in its own Navigator. The rows stay in the accessibility tree beside
/// that page — a route's barrier blocks what was painted before it, and
/// without a container of its own it blocked the whole column.
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/shell/profile_page.dart';
import 'package:frockbot_native/shell/semantics.dart';

void main() {
  Widget page() => MaterialApp(
    home: ProfilePage(
      identity: const Text('Tim'),
      credit: (_) => null,
      creditSection: 'billing',
      groups: [
        ProfileGroup('Account', [
          ProfileSection(
            id: 'details',
            icon: Icons.person_outline,
            title: 'Personal details',
            page: () => const Scaffold(body: Text('Details page')),
          ),
          ProfileSection(
            id: 'models',
            icon: Icons.auto_awesome_outlined,
            title: 'Models',
            page: () => const Scaffold(body: Text('Models page')),
          ),
        ]),
      ],
      version: const Text('Development build'),
      open: (_) async {},
      onSignOut: () {},
    ),
  );

  testWidgets('the rows are still read beside the page they opened', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1440, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final semantics = tester.ensureSemantics();

    await tester.pumpWidget(page());
    await tester.pumpAndSettle();

    expect(find.text('Details page'), findsOneWidget);
    expect(find.bySemanticsIdentifier(SettingsIds.profileMenu), findsOneWidget);
    expect(find.bySemanticsLabel('Models'), findsOneWidget);
    expect(find.bySemanticsLabel('Sign out'), findsOneWidget);

    semantics.dispose();
  });
}
