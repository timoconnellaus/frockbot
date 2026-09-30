import 'package:flutter/foundation.dart';

import '../client/transport.dart';
import '../protocol/client_wire.generated.dart' as wire;
import 'document.dart';

/// Reads the settings document and carries one action to the settings route.
///
/// The retained command envelope is no longer here: `ViewController` owns it
/// for every plugin-described view, and settings is now one of those. What is
/// left is the read and the translation from a view
/// action to the settings command the route already takes.
class SettingsController extends ChangeNotifier {
  final NativeApi api;
  final String userId;
  final String home;
  wire.ViewDocument? document;
  bool busy = false;
  bool _closed = false;
  String? message;
  SettingsController(this.api, this.userId, this.home);

  String get surfaceId => 'settings-$home';

  void adoptCachedDocument(wire.ViewDocument cached) {
    if (_closed || document != null) return;
    if (cached.surfaceId.value != surfaceId) return;
    document = cached;
    _changed();
  }

  void _changed() {
    if (!_closed) notifyListeners();
  }

  Future<void> load() async {
    if (busy) return;
    busy = true;
    message = null;
    _changed();
    try {
      final next = wire.ViewDocument.fromJson(
        await api.request(
          Uri(
            path: '/api/settings/$home',
            queryParameters: {'as': 'document'},
          ).toString(),
        ),
      );
      if (next.surfaceId.value != surfaceId) {
        throw const FormatException('Settings surface mismatch');
      }
      document = next;
    } catch (_) {
      message =
          'Couldn’t load your settings. Check your connection and try again.';
    } finally {
      busy = false;
      _changed();
    }
  }

  /// The settings route is where a view action on this surface lands. The
  /// receipt is returned as it arrived: the command's identity, and what
  /// happened to it, are `ViewController`'s to read.
  Future<Map<String, Object?>> dispatch(Map<String, Object?> command) async {
    final answer = await api.request(
      '/api/settings/$home',
      body: settingsChangeCommandV1(command: command, userId: userId),
    );
    return (answer! as Map).cast<String, Object?>();
  }

  @override
  void dispose() {
    _closed = true;
    super.dispose();
  }
}
