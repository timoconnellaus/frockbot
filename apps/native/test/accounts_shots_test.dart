/// The review still for holding several accounts, kept outside the
/// repository: `--dart-define=CHAT_SHOTS=<dir>`. Without a directory the
/// scene is skipped: it draws, it does not assert.
library;

import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart' show FontLoader, rootBundle;
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_client/app.dart';
import 'package:frockbot_client/brand.dart';
import 'package:frockbot_client/client/accounts.dart';
import 'package:frockbot_client/client/transport.dart';
import 'package:frockbot_client/shell/semantics.dart';
import 'package:frockbot_client/theme/frock_theme.dart';
import 'package:frockbot_native/brand.dart';

import 'accounts_test.dart';
import 'app_auth_recovery_test.dart' show answer, withoutDeepLinks;
import 'navigation_test.dart' show identifiedBy;

const _out = String.fromEnvironment('CHAT_SHOTS');

void main() {
  testWidgets('two accounts, one switcher', (tester) async {
    if (_out.isEmpty) return;
    installClientBrand(frockbotBrand);
    withoutDeepLinks(tester);
    await tester.runAsync(() async {
      final inter = FontLoader(interFontFamily);
      for (final weight in [400, 500, 600, 700]) {
        inter.addFont(
          rootBundle.load(
            'packages/frockbot_client/assets/fonts/inter-latin-$weight.ttf',
          ),
        );
      }
      await inter.load();
      await (FontLoader(
        'MaterialIcons',
      )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
    });
    // 16:9, the frame the What’s New card draws.
    tester.view.physicalSize = const Size(2560, 1440);
    tester.view.devicePixelRatio = 2;
    addTearDown(tester.view.reset);
    final store = AccountsMemoryStore()
      ..values[AccountDirectory.key] = jsonEncode({
        'version': 1,
        'active': 'hosted',
        'accounts': [
          {
            'id': 'hosted',
            'origin': hostedOrigin,
            'name': 'FrockBot',
            'userId': 'user-hosted',
          },
          {
            'id': 'own',
            'origin': 'https://bots.example.org',
            'name': 'FrockBot',
            'userId': 'user-own',
          },
        ],
      })
      ..values['account/hosted/session'] = session('user-hosted')
      ..values['account/own/session'] = session('user-own');
    await tester.pumpWidget(
      FrockBotApp(
        store: store,
        apiFor: (account, scoped) {
          final hosted = account.origin == hostedOrigin;
          return AccountApi(
            scoped,
            origin: account.origin,
            userId: hosted ? 'user-hosted' : 'user-own',
            bots: hosted
                ? [
                    registration('bot-rose', 'Rosemary'),
                    registration('bot-pip', 'Pip'),
                  ]
                : [registration('bot-clem', 'Clementine')],
            unread: hosted ? 0 : 3,
            paths: [],
          );
        },
      ),
    );
    await answer(tester);
    await tester.tap(identifiedBy(AccountIds.switcher));
    await answer(tester);
    await tester.runAsync(() async {
      // The whole view: the sheet is an overlay above every boundary.
      final view = tester.binding.renderViews.first;
      // Its layer already carries the device pixel ratio.
      final image = await (view.debugLayer! as OffsetLayer).toImage(
        Offset.zero & tester.view.physicalSize,
      );
      final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
      await File('$_out/accounts.png')
          .writeAsBytes(bytes!.buffer.asUint8List());
      image.dispose();
    });
    await tester.pumpWidget(const SizedBox());
    await tester.pump();
  });
}
