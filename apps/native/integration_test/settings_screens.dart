// Physical design runner against the existing local production-worker harness.
// Build only with NATIVE_ACCEPTANCE=true and NATIVE_TEST_ORIGIN on loopback.
// This entrypoint is never imported by the product and never reads its session.
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:frockbot_client/client/transport.dart';
import 'package:frockbot_client/client/plain_store.dart';
import 'package:frockbot_client/settings/personal_details.dart';
import 'package:frockbot_client/theme/frock_theme.dart';
import 'package:frockbot_client/brand.dart';
import 'package:frockbot_native/brand.dart';

class LocalSettingsApi extends NativeApi {
  final Uri local;
  final HttpClient client = HttpClient();
  LocalSettingsApi(super.store, this.local) {
    if (!const bool.fromEnvironment('NATIVE_ACCEPTANCE') ||
        local.scheme != 'http' ||
        local.host != '127.0.0.1' ||
        local.userInfo.isNotEmpty ||
        local.path.isNotEmpty ||
        local.hasQuery ||
        local.hasFragment ||
        !local.hasPort) {
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
      local.resolve(path),
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
  installClientBrand(frockbotBrand);
  SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
  final store = PlainStore(name: 'native-settings-design-v1.json');
  final api = LocalSettingsApi(
    store,
    Uri.parse(const String.fromEnvironment('NATIVE_TEST_ORIGIN')),
  );
  runApp(
    MaterialApp(
      title: 'FrockBot',
      debugShowCheckedModeBanner: false,
      theme: FrockTheme.theme(Brightness.dark),
      home: PersonalDetailsPage(
        api: api,
        store: store,
        userId: 'native-settings-local',
      ),
    ),
  );
}
