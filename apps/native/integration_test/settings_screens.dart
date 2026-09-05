// Physical design runner against the existing local production-worker harness.
// Build only with NATIVE_ACCEPTANCE=true and NATIVE_TEST_ORIGIN on loopback.
// This entrypoint is never imported by the product and never reads its session.
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/client/plain_store.dart';
import 'package:frockbot_native/settings/page.dart';
import 'package:frockbot_native/connections/page.dart';
import 'package:frockbot_native/activity/controller.dart';
import 'package:frockbot_native/activity/page.dart';
import 'package:frockbot_native/recovery/controller.dart';
import 'package:frockbot_native/recovery/page.dart';
import 'package:frockbot_native/protocol/client_wire.generated.dart' as wire;
import 'package:frockbot_native/theme/frock_theme.dart';

class LocalSettingsApi extends NativeApi {
  final Uri origin;
  final HttpClient client = HttpClient();
  LocalSettingsApi(super.store, this.origin) {
    if (!const bool.fromEnvironment('NATIVE_ACCEPTANCE') ||
        origin.scheme != 'http' ||
        origin.host != '127.0.0.1' ||
        origin.userInfo.isNotEmpty ||
        origin.path.isNotEmpty ||
        origin.hasQuery ||
        origin.hasFragment ||
        !origin.hasPort) {
      throw StateError('The design runner requires an explicit local harness');
    }
  }
  @override
  Future<Object?> request(
    String path, {
    Object? body,
    int limit = 512000,
    bool authenticated = true,
  }) async {
    if (!path.startsWith('/api/') ||
        path.contains('..') ||
        path.contains('#')) {
      throw const FormatException('Invalid local route');
    }
    final request = await client.openUrl(
      body == null ? 'GET' : 'POST',
      origin.resolve(path),
    );
    request.followRedirects = false;
    request.headers.set('x-frockbot-user-id', 'native-settings-local');
    request.headers.contentType = ContentType.json;
    if (body != null) request.write(jsonEncode(body));
    final response = await request.close().timeout(const Duration(seconds: 10));
    if (response.statusCode >= 300) {
      await response.drain<void>();
      throw RequestFailure('Local worker refused request', response.statusCode);
    }
    final bytes = <int>[];
    await for (final chunk in response) {
      bytes.addAll(chunk);
      if (bytes.length > limit) throw const FormatException('Response limit');
    }
    return decodeBoundedJson(utf8.decode(bytes), maxBytes: limit);
  }
}

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
  final store = PlainStore(name: 'native-settings-design-v1.json');
  final api = LocalSettingsApi(
    store,
    Uri.parse(const String.fromEnvironment('NATIVE_TEST_ORIGIN')),
  );
  const home = String.fromEnvironment(
    'NATIVE_TEST_HOME',
    defaultValue: 'application',
  );
  if (!{
    'application',
    'models',
    'connections',
    'inbox',
    'recovery',
    'recovery-detail',
  }.contains(home)) {
    throw StateError('Unknown design page');
  }
  wire.BotRegistration? detailBot;
  BotRecoveryController? recovery;
  const recoveryTab = int.fromEnvironment('NATIVE_TEST_TAB');
  if (recoveryTab < 0 || recoveryTab > 2) {
    throw StateError('Unknown recovery tab');
  }
  if (home == 'recovery-detail') {
    recovery = BotRecoveryController(api, store, 'native-settings-local');
    await recovery.load();
    detailBot = recovery.bots.firstWhere(
      (bot) =>
          bot.botId.value ==
          const String.fromEnvironment(
            'NATIVE_TEST_BOT',
            defaultValue: 'native-inbox-design',
          ),
    );
  }
  runApp(
    MaterialApp(
      title: 'FrockBot',
      debugShowCheckedModeBanner: false,
      theme: FrockTheme.theme(Brightness.dark),
      home: home == 'recovery'
          ? BotRecoveryPage(
              api: api,
              store: store,
              userId: 'native-settings-local',
            )
          : home == 'recovery-detail'
          ? BotRecoveryDetail(
              controller: recovery!,
              bot: detailBot!,
              initialTab: recoveryTab,
            )
          : home == 'inbox'
          ? ActivityPage(
              controller: ActivityController(
                api,
                store,
                'native-settings-local',
              )..botNames = {'native-inbox-design': 'Mira'},
              openBot: (_) async {},
            )
          : home == 'connections'
          ? ConnectionsPage(api: api, userId: 'native-settings-local')
          : SettingsPage(
              api: api,
              store: store,
              userId: 'native-settings-local',
              home: home,
            ),
    ),
  );
}
