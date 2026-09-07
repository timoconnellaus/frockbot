import 'dart:convert';

import '../protocol/client_wire.generated.dart' as wire;
import 'credential.dart';
import 'store.dart';

/// The session is the one secret this client holds, and every request needs
/// it. It is read from the keystore once and then kept in memory; sign-in,
/// sign-out and restore hand the new value straight in, so no request waits
/// on the platform keystore or on writes queued ahead of it.
class BearerCredential implements AuthCredential {
  final LocalStore store;
  BearerCredential(this.store);
  String? _authorization;
  bool _known = false;
  Future<void>? _read;

  @override
  void adopt(String? session) {
    _authorization = session == null ? null : _bearer(session);
    _known = true;
    _read = null;
  }

  static String _bearer(String session) =>
      'Bearer ${wire.AuthSessionView.fromJson(jsonDecode(session)).sessionToken}';

  @override
  Future<String?> authorization() async {
    if (_known) return _authorization;
    final read = _read ??= store.read('session').then((session) {
      // A sign-in that landed while this read was in flight already holds
      // the current session and must not be overwritten by the older one.
      if (_known) return;
      _authorization = session == null ? null : _bearer(session);
      _known = true;
    });
    try {
      await read;
    } catch (_) {
      // A failed read stays retryable rather than caching its failure.
      if (identical(_read, read)) _read = null;
      rethrow;
    }
    return _authorization;
  }
}

AuthCredential authCredentialV1(LocalStore store) => BearerCredential(store);
