import 'package:frockbot_native/client/transport.dart';

/// A request-level client for native integration tests.
///
/// It keeps the real NativeApi surface while replacing only the network
/// boundary. Auth tests intentionally use their own clients because their
/// assertions concern credential exchange and rejection.
class NativeSessionApi extends NativeApi {
  final Future<Object?> Function(String, Object?) handler;

  NativeSessionApi(super.store, this.handler);

  @override
  Future<Object?> request(
    String path, {
    Object? body,
    int limit = 512000,
    bool authenticated = true,
  }) => handler(path, body);
}
