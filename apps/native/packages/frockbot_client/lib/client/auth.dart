export 'auth_io.dart' if (dart.library.js_interop) 'auth_web.dart';

/// A development build signs in through the local stack's development door
/// instead of Google.
const developmentAuth = bool.fromEnvironment('FROCKBOT_DEV_AUTH');

/// The sign-in door this build uses. The app runs PKCE in the system browser
/// and comes back on its own scheme with a bearer token; the browser hands the
/// User to the hosted better-auth flow and comes back as a session cookie.
abstract interface class SignIn {
  /// Opens sign-in. Answers true when it finished here, false when the person
  /// closed it, and null when it continues in the browser and returns as a
  /// link to [accept] — or, in a browser, as a navigation.
  Future<bool?> start();

  /// Finish a sign-in that returned over [uri], answering whether it was one.
  /// Nothing returns this way in a browser, which navigates instead.
  Future<bool> accept(Uri uri);

  Future<void> signOut();
}
