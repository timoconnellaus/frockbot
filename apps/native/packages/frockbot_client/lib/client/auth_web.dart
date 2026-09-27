import 'package:web/web.dart' as web;

import 'auth.dart';
import 'transport.dart';

/// The browser signs in where the hosted app already does. better-auth owns
/// the Google leg and answers with the URL to navigate to; the session comes
/// back as a cookie, so this client stores nothing and has nothing to accept.
class HostedSignIn implements SignIn {
  final NativeApi api;
  HostedSignIn(this.api);

  @override
  Future<void> start() async {
    final here = Uri.parse(web.window.location.href);
    if (developmentAuth) {
      return _go(
        here
            .replace(
              queryParameters: {
                ...here.queryParameters,
                'as_user': 'development',
              },
            )
            .toString(),
      );
    }
    final callback = Uri.parse(hostedOrigin).replace(path: '/').toString();
    final response = await api.request(
      '/api/auth/sign-in/social',
      authenticated: false,
      limit: 8192,
      body: {
        'provider': 'google',
        'callbackURL': callback,
        'newUserCallbackURL': callback,
        'errorCallbackURL': callback,
      },
    );
    final url = response is Map ? response['url'] : null;
    if (url is! String || !url.startsWith('https://')) {
      throw const RequestFailure('Couldn’t open sign-in. Please try again.');
    }
    _go(url);
  }

  @override
  Future<bool> accept(Uri uri) async => false;

  @override
  Future<void> signOut() async {
    await api.request('/api/auth/sign-out', body: const <String, Object>{});
    _go(Uri.parse(hostedOrigin).replace(path: '/').toString());
  }

  void _go(String url) => web.window.location.assign(url);
}

SignIn signInV1(NativeApi api, LocalStore store) => HostedSignIn(api);
