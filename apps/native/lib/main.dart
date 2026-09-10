/// The app entry and the sign-in door.
///
/// Everything the person actually looks at is `lib/shell/`. This holds the
/// three things that are true before any of it: the `MaterialApp`, the session
/// — restoring one, completing one, ending one — and the deep link that names
/// a Bot, which it hands to the shell rather than acting on itself.
library;

import 'dart:async';
import 'dart:convert';

import 'package:app_links/app_links.dart';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart' hide ConnectionState;

import 'acceptance_metrics.dart';
import 'activity/controller.dart';
import 'auth/sign_in_page.dart';
import 'client/auth.dart';
import 'client/bot_sessions.dart';
import 'client/identity.dart';
import 'client/plain_store.dart';
import 'client/transport.dart';
import 'orientation.dart';
import 'shell/app_shell.dart';
import 'theme/frock_theme.dart';
import 'protocol/client_wire.generated.dart' as wire;

Future<void> main() async {
  final binding = WidgetsFlutterBinding.ensureInitialized();
  await setMobileOrientation();
  // The browser draws to a canvas, so the accessibility tree is the only DOM
  // there is: without it a screen reader sees an empty page and a browser test
  // has nothing to select. The engine builds it lazily, behind a hidden
  // "enable accessibility" button nobody should have to find, so the web build
  // holds it open from the first frame. The phone's platform already asks for
  // it when someone turns a screen reader on.
  if (kIsWeb) binding.ensureSemantics();
  AcceptanceMetrics.instance.start();
  runApp(const FrockBotApp());
}

class FrockBotApp extends StatefulWidget {
  final LocalStore? store;
  final NativeApi? api;
  const FrockBotApp({super.key, this.store, this.api});
  @override
  State<FrockBotApp> createState() => _FrockBotAppState();
}

class _FrockBotAppState extends State<FrockBotApp> {
  final navigatorKey = GlobalKey<NavigatorState>();
  final botLinks = ValueNotifier<String?>(null);
  late final LocalStore store = widget.store ?? nativeStore();
  late final NativeApi api = widget.api ?? NativeApi(store);
  late final SignIn auth = signInV1(api, store);
  late final BotSessions sessions = BotSessions(api: api, store: store);
  StreamSubscription<Uri>? links;
  String? userId = localDevelopment ? 'development' : null;
  String? error;
  bool busy = true;
  bool awaitingBrowser = false;

  @override
  void initState() {
    super.initState();
    links = AppLinks().uriLinkStream.listen(
      (uri) => unawaited(accept(uri)),
      onError: (Object _) {
        if (mounted) {
          setState(() {
            error = 'Couldn’t open that sign-in link. Please try again.';
          });
        }
      },
    );
    unawaited(restore());
  }

  Future<void> accept(Uri uri) async {
    final target = botLink(uri);
    if (target != null) {
      botLinks.value = target;
      return;
    }
    try {
      if (await auth.accept(uri)) {
        navigatorKey.currentState?.popUntil((route) => route.isFirst);
        sessions.clear();
        if (mounted) setState(() => userId = null);
        await restore();
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          error = 'Couldn’t finish signing in. Please try again.';
          busy = false;
        });
      }
    }
  }

  /// A stored session is adopted before the identity read, so the shell paints
  /// its cached directory rather than the sign-in door on a cold start.
  ///
  /// The identity read happens either way. The phone carries its session as a
  /// stored token; the browser carries it as an ambient cookie it cannot see,
  /// and learns the account from the document the gateway rendered — the read
  /// then confirms it.
  Future<void> restore() async {
    try {
      // The browser's session is an ambient cookie it cannot read, but the
      // document it was served names the account, so the shell paints before
      // the identity read rather than after it.
      final bootstrap = bootstrapUserIdV1();
      if (bootstrap != null && mounted) setState(() => userId = bootstrap);
      final savedSession = await store.read('session');
      if (savedSession != null && !localDevelopment) {
        api.adoptSession(savedSession);
        final cached = wire.AuthSessionView.fromJson(jsonDecode(savedSession));
        if (mounted) setState(() => userId = cached.userId.value);
      }
      final identity = wire.AuthIdentity.fromJson(
        await api.request('/api/identity'),
      );
      if (mounted) {
        setState(() {
          userId = identity.userId.value;
          error = null;
        });
      }
    } on RequestFailure catch (failure) {
      if (failure.status == 401) {
        // A bearer may expire or be revoked while the cached shell is still
        // perfectly readable. Keeping that shell open makes every transcript
        // read and state-channel reconnect look like a network outage, with no
        // route back to authentication.
        await store.delete('session');
        api.adoptSession(null);
        sessions.clear();
        if (mounted) {
          setState(() {
            userId = null;
            error = null;
          });
        }
      } else if (mounted) {
        setState(() => error = failure.message);
      }
    } catch (_) {
      if (mounted) {
        setState(() => error = 'Couldn’t reach FrockBot. Please try again.');
      }
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> signIn() async {
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await auth.start();
      if (mounted) setState(() => awaitingBrowser = true);
    } catch (failure) {
      if (mounted) {
        setState(() {
          error = failure is RequestFailure
              ? failure.message
              : 'Couldn’t open sign-in. Please try again.';
        });
      }
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> signOut() async {
    try {
      await auth.signOut();
      sessions.clear();
      if (mounted) setState(() => userId = null);
    } catch (_) {
      if (mounted) {
        setState(() {
          error = 'Couldn’t sign out. Please reconnect and try again.';
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'FrockBot',
    navigatorKey: navigatorKey,
    debugShowCheckedModeBanner: false,
    theme: FrockTheme.theme(Brightness.light),
    darkTheme: FrockTheme.theme(Brightness.dark),
    themeMode: ThemeMode.dark,
    home: userId == null
        ? SignInPage(
            busy: busy,
            awaitingBrowser: awaitingBrowser,
            error: error,
            onSignIn: signIn,
          )
        : AppShell(
            key: ValueKey(userId),
            api: api,
            store: store,
            sessions: sessions,
            userId: userId!,
            botLinks: botLinks,
            onSignOut: signOut,
          ),
  );

  @override
  void dispose() {
    unawaited(links?.cancel());
    botLinks.dispose();
    sessions.clear();
    api.close();
    super.dispose();
  }
}
