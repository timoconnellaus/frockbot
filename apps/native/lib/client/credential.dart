export 'credential_io.dart' if (dart.library.js_interop) 'credential_web.dart';

/// How this build proves who it is on every request.
///
/// The phone holds a bearer token it obtained through PKCE and keeps in the
/// platform keystore. The browser holds nothing: the better-auth session is a
/// cookie it never hands to script, and it travels on its own.
abstract interface class AuthCredential {
  /// The `authorization` header value, or null when the session is ambient.
  Future<String?> authorization();

  /// Adopt a session the sign-in path just established — or null to forget
  /// one — so the next request does not wait on the platform keystore.
  void adopt(String? session);
}
