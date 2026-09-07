import 'credential.dart';
import 'store.dart';

/// The browser is already signed in to the origin it was served from, and the
/// better-auth cookie travels with every request the client makes. There is no
/// header to add and nothing to store, so a session handed in is discarded.
class CookieCredential implements AuthCredential {
  const CookieCredential();

  @override
  Future<String?> authorization() async => null;

  @override
  void adopt(String? session) {}
}

AuthCredential authCredentialV1(LocalStore store) => const CookieCredential();
