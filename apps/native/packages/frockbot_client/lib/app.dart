/// The app entry and the sign-in door.
///
/// An application calls [runFrockbot] with its brand; that is the whole of
/// what makes it FrockBot or another product (ADR 0038).
///
/// Everything the person actually looks at is `lib/shell/`. This holds the
/// things that are true before any of it: the `MaterialApp`, the accounts an
/// app is signed in to and which one is on screen, each account's session —
/// restoring one, completing one, ending one — and the deep link that names a
/// Bot, which it routes to its account and hands to the shell rather than
/// acting on itself.
library;

import 'dart:async';
import 'dart:convert';

import 'package:app_links/app_links.dart';
import 'package:flutter/foundation.dart'
    show TargetPlatform, defaultTargetPlatform, kIsWeb;
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:rive/rive.dart' show RiveNative;

import 'acceptance_metrics.dart';
import 'activity/accounts_unread.dart';
import 'activity/controller.dart';
import 'activity/push.dart' show signOutOfPushV1;
import 'auth/server_page.dart';
import 'auth/sign_in_page.dart';
import 'brand.dart';
import 'client/accounts.dart';
import 'client/auth.dart';
import 'client/bot_sessions.dart';
import 'client/discovery.dart';
import 'client/identity.dart';
import 'client/plain_store.dart';
import 'client/transport.dart';
import 'connections/document.dart'
    show
        connectReturnNotice,
        connectReturns,
        isConnectReturnV1,
        mcpSignInCompletionV1,
        mcpSignInRefusalV1;
import 'flock/avatar.dart' show riveRuntimeReady;
import 'orientation.dart';
import 'shell/account_switcher.dart';
import 'shell/app_shell.dart';
import 'theme/frock_theme.dart';
import 'update/desktop_update.dart';
import 'update/update_ready.dart';
import 'protocol/client_wire.generated.dart' as wire;

Future<void> runFrockbot(ClientBrand brand) async {
  installClientBrand(brand);
  final binding = WidgetsFlutterBinding.ensureInitialized();
  // Rive's animated characters need their runtime, but the app is not their
  // waiting room: the first frame does not wait for it. Every avatar begins
  // as its checked-in still and swaps to the artboard when the runtime lands.
  // On the web the loader appends a `<script>` and awaits its `load` event,
  // which a Content-Security-Policy refusal or a 404 never fires — so the
  // deadline is what settles it then, and the stills simply stay. The outcome
  // is recorded rather than dropped: a renderer asked for while the runtime
  // is absent throws from inside `build`, and a thrown avatar is an empty
  // slot with an error where the still should be. A brand whose characters
  // are all stills has nothing for the runtime to draw, and fetches none.
  if (brand.characters.any((character) => character.rive != null)) {
    unawaited(
      RiveNative.init()
          .timeout(const Duration(seconds: 10), onTimeout: () => false)
          .catchError((Object _) => false)
          .then((ready) => riveRuntimeReady.value = ready),
    );
  }
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

  /// The one account's client, for a test that drives a single account on
  /// [store] as the app did before it held several. Left null, a browser runs
  /// the one account it was served for and an app runs its account directory.
  final NativeApi? api;

  /// The client for an account, for a test that drives several.
  final NativeApi Function(AccountRecord account, LocalStore store)? apiFor;

  /// How "Use another server" reads a server, for a test.
  final Future<ServerDiscovery> Function(String address)? discover;
  final MobileUpdateService? updateService;

  /// The desktop updater, where this build has one. Defaults to Sparkle on
  /// macOS when the brand names a release channel, and to none otherwise.
  final DesktopUpdater? desktopUpdater;
  const FrockBotApp({
    super.key,
    this.store,
    this.api,
    this.apiFor,
    this.discover,
    this.updateService,
    this.desktopUpdater,
  });
  @override
  State<FrockBotApp> createState() => _FrockBotAppState();
}

/// One account's live objects: its client, its store, its sign-in and its
/// open conversations. Only the account on screen and an account being added
/// have one.
class AccountSession {
  AccountRecord? account;
  final LocalStore store;
  final NativeApi api;
  final SignIn auth;
  final BotSessions sessions;
  AccountSession({this.account, required this.store, required this.api})
    : auth = signInV1(api, store),
      sessions = BotSessions(api: api, store: store);

  void dispose() {
    sessions.clear();
    api.close();
  }
}

class _FrockBotAppState extends State<FrockBotApp> {
  final navigatorKey = GlobalKey<NavigatorState>();
  final messengerKey = GlobalKey<ScaffoldMessengerState>();
  final botLinks = ValueNotifier<String?>(null);
  late final LocalStore store = widget.store ?? nativeStore();

  /// Whether this app holds accounts. A browser is the one account of the
  /// origin that served it, and so is an app a test hands one client.
  late final bool holdsAccounts = !kIsWeb && widget.api == null;
  late final AccountDirectory? directory = holdsAccounts
      ? AccountDirectory(store)
      : null;
  late final AccountsUnread otherUnread = AccountsUnread(
    apiFor: (account) => _apiFor(account, directory!.storeFor(account)),
  );

  /// What [otherUnread] adds up to, for the shell's badge.
  final elsewhere = ValueNotifier<int>(0);

  /// The account on screen, or the only one.
  AccountSession? current;

  /// The account a sign-in is adding, until it completes.
  AccountSession? adding;
  late final MobileUpdateController updates = MobileUpdateController(
    service:
        widget.updateService ??
        switch (clientBrand.releaseChannel) {
          ClientReleaseChannel.shorebird => ShorebirdMobileUpdateService(),
          null => const InertMobileUpdateService(),
        },
    beforeRestart: () => checkpointStore(store),
  );
  late final DesktopUpdateController? desktopUpdates =
      switch (widget.desktopUpdater ??
      (!kIsWeb &&
              defaultTargetPlatform == TargetPlatform.macOS &&
              clientBrand.releaseChannel != null
          ? MacDesktopUpdater()
          : null)) {
        final DesktopUpdater updater => DesktopUpdateController(
          updater: updater,
          beforeRestart: () => checkpointStore(store),
        ),
        null => null,
      };
  StreamSubscription<Uri>? links;
  String? userId = localDevelopment ? 'development' : null;
  String? error;
  bool busy = true;
  bool awaitingBrowser = false;

  /// The sign-in page is over the account on screen, adding another.
  bool signingIn = false;

  /// The server address page is open.
  bool choosingServer = false;

  /// The server a person chose to sign in to; null is the build's own.
  ServerDiscovery? server;

  NativeApi _apiFor(AccountRecord account, LocalStore store) =>
      widget.apiFor?.call(account, store) ??
      NativeApi(store, origin: account.origin);

  AccountSession _sessionFor(AccountRecord account) {
    final scoped = directory!.storeFor(account);
    return AccountSession(
      account: account,
      store: scoped,
      api: _apiFor(account, scoped),
    );
  }

  @override
  void initState() {
    super.initState();
    otherUnread.addListener(_countElsewhere);
    if (!holdsAccounts) {
      _adopt(AccountSession(store: store, api: widget.api ?? NativeApi(store)));
    }
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
    unawaited(holdsAccounts ? _loadAccounts() : restore());
  }

  void _countElsewhere() => elsewhere.value = otherUnread.total;

  /// Makes [session] the account on screen. The one it replaces is closed
  /// once its shell has gone, which is after the frame that swaps them.
  void _adopt(AccountSession session) {
    final previous = current;
    current = session;
    session.api.onSessionRejected = (message) =>
        unawaited(forget(message, session));
    if (previous != null && !identical(previous, session)) {
      previous.api.onSessionRejected = null;
      WidgetsBinding.instance.addPostFrameCallback((_) => previous.dispose());
    }
    final directory = this.directory;
    if (directory != null) {
      otherUnread.watch([
        for (final account in directory.accounts)
          if (account.id != session.account?.id) account,
      ]);
    }
  }

  Future<void> _loadAccounts() async {
    final directory = this.directory!;
    try {
      await directory.load();
    } catch (_) {
      // An unreadable directory is no accounts: the person signs in again.
    }
    final active = directory.active;
    if (active == null) {
      if (mounted) setState(() => busy = false);
      return;
    }
    if (mounted) setState(() => userId = active.userId);
    _adopt(_sessionFor(active));
    await restore();
  }

  Future<void> accept(Uri uri) async {
    final directory = this.directory;
    // A tapped alert or a shared link: the account on its server, and the
    // User it names where it names one.
    if (uri.scheme == 'https') {
      final user = uri.queryParameters['user'];
      final account = directory?.accounts
          .where(
            (account) =>
                account.origin == uri.origin &&
                (user == null || user.isEmpty || account.userId == user),
          )
          .firstOrNull;
      if (directory != null && account == null) return;
      if (account != null && account.id != current?.account?.id) {
        await switchTo(account);
      }
      final target = botLink(uri, origin: current?.api.origin);
      if (target != null) botLinks.value = target;
      return;
    }
    // A hosted door closing: Setup is still where the person left it, and it
    // reads the account again to show what they did there. An MCP server's
    // sign-in is finished here first, under the session of the account whose
    // server handed it back.
    if (isConnectReturnV1(uri)) {
      final account = directory?.accounts
          .where((account) => account.host == uri.host)
          .fold<AccountRecord?>(
            null,
            (best, account) =>
                best ?? (account.id == current?.account?.id ? account : null),
          );
      final owner =
          account ??
          directory?.accounts
              .where((account) => account.host == uri.host)
              .firstOrNull;
      if (directory != null && owner == null) return;
      if (owner != null && owner.id != current?.account?.id) {
        await switchTo(owner);
      }
      final session = current;
      if (session == null) return;
      String? refusal;
      final completion = mcpSignInCompletionV1(uri);
      if (completion != null) {
        try {
          await session.api.request(completion.path, body: completion.body);
        } on RequestFailure catch (failure) {
          refusal = mcpSignInRefusalV1(failure.status);
        }
      }
      connectReturnNotice.value = refusal;
      connectReturns.value += 1;
      return;
    }
    try {
      if (directory == null) {
        final session = current!;
        if (await session.auth.accept(uri)) {
          navigatorKey.currentState?.popUntil((route) => route.isFirst);
          session.sessions.clear();
          if (mounted) setState(() => userId = null);
          await restore();
        }
        return;
      }
      // An Android sign-in returning, perhaps to a process started since it
      // left: the account it is adding is kept for exactly this.
      final pending = directory.pending;
      final session =
          adding ?? (pending == null ? null : adding = _sessionFor(pending));
      if (session != null && await session.auth.accept(uri)) {
        await _added(session);
      }
    } catch (failure) {
      if (mounted) {
        setState(() {
          error = failure is RequestFailure
              ? failure.message
              : 'Couldn’t finish signing in. Please try again.';
          busy = false;
          awaitingBrowser = false;
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
    final session = current;
    if (session == null) {
      if (mounted) setState(() => busy = false);
      return;
    }
    try {
      // The browser's session is an ambient cookie it cannot read, but the
      // document it was served names the account, so the shell paints before
      // the identity read rather than after it.
      final bootstrap = bootstrapUserIdV1();
      if (bootstrap != null && mounted) setState(() => userId = bootstrap);
      final savedSession = await session.store.read('session');
      if (savedSession != null && !localDevelopment) {
        session.api.adoptSession(savedSession);
        final cached = wire.AuthSessionView.fromJson(jsonDecode(savedSession));
        if (mounted && identical(session, current)) {
          setState(() => userId = cached.userId.value);
        }
      }
      final identity = wire.AuthIdentity.fromJson(
        await session.api.request('/api/identity'),
      );
      if (!identical(session, current)) return;
      if (mounted) {
        setState(() {
          userId = identity.userId.value;
          error = null;
        });
      }
      final account = session.account;
      if (account != null) {
        await directory?.identify(account, identity.userId.value);
        session.account = directory?.active;
      }
    } on RequestFailure catch (failure) {
      if (failure.status == 401) {
        await forget(failure.message, session);
      } else if (mounted && identical(session, current)) {
        setState(() => error = failure.message);
      }
    } catch (_) {
      if (mounted && identical(session, current)) {
        setState(
          () => error =
              'Couldn’t reach ${clientBrand.productName}. Please try again.',
        );
      }
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  /// Ends a session the gateway has stopped accepting.
  ///
  /// A bearer may expire or be revoked while the cached shell is still
  /// perfectly readable. Keeping that shell open makes every transcript read
  /// and state-channel reconnect look like a network outage, with no route
  /// back to authentication. The rejected token is forgotten in memory first,
  /// so a keystore that refuses the durable delete cannot hold the shell open,
  /// and the refusal's own sentence says why sign-in is being asked for again
  /// — where there was a session to lose, rather than to someone who has yet
  /// to sign in at all. An app that holds other accounts goes on to the next,
  /// and says which account ended.
  Future<void> forget(String message, [AccountSession? session]) =>
      forgetting ??= _forget(
        message,
        session ?? current,
      ).whenComplete(() => forgetting = null);
  Future<void>? forgetting;

  Future<void> _forget(String message, AccountSession? session) async {
    if (session == null || !identical(session, current)) return;
    final signedIn = userId != null;
    session.api.adoptSession(null);
    session.sessions.clear();
    final account = session.account;
    final directory = this.directory;
    if (directory != null && account != null) {
      try {
        await directory.remove(account);
      } catch (_) {
        // The token is already forgotten in memory.
      }
      final next = directory.active;
      if (next != null) {
        _adopt(_sessionFor(next));
        if (mounted) setState(() => userId = next.userId);
        messengerKey.currentState?.showSnackBar(
          SnackBar(content: Text('${account.serverLabel}: $message')),
        );
        await restore();
        return;
      }
      current = null;
      otherUnread.watch(const []);
    }
    if (mounted) {
      setState(() {
        userId = null;
        error = signedIn ? message : null;
      });
    }
    if (directory == null) {
      try {
        await session.store.delete('session');
      } catch (_) {
        // The token is already forgotten in memory; a keystore that cannot
        // delete it will hand back nothing this client will adopt again.
      }
    }
  }

  Future<void> signIn() async {
    setState(() {
      busy = true;
      error = null;
    });
    final directory = this.directory;
    try {
      final AccountSession session;
      if (directory == null) {
        session = current!;
      } else {
        final chosen = server;
        final account = await directory.begin(
          chosen?.origin ?? hostedOrigin,
          chosen?.name ?? clientBrand.productName,
        );
        adding?.dispose();
        session = adding = _sessionFor(account);
      }
      final finished = await session.auth.start();
      if (finished == true) {
        if (directory == null) {
          await restore();
        } else {
          await _added(session);
        }
      } else if (finished == null && mounted) {
        setState(() => awaitingBrowser = true);
      }
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

  /// The account a sign-in added is the one on screen now.
  Future<void> _added(AccountSession session) async {
    final directory = this.directory!;
    final saved = await session.store.read('session');
    if (saved == null) return;
    final view = wire.AuthSessionView.fromJson(jsonDecode(saved));
    session.account = await directory.complete(
      session.account!,
      view.userId.value,
    );
    if (identical(adding, session)) adding = null;
    navigatorKey.currentState?.popUntil((route) => route.isFirst);
    _adopt(session);
    if (mounted) {
      setState(() {
        userId = view.userId.value;
        signingIn = false;
        choosingServer = false;
        server = null;
        awaitingBrowser = false;
        error = null;
      });
    }
    await restore();
  }

  /// Opens another account the app is signed in to.
  Future<void> switchTo(AccountRecord account) async {
    final directory = this.directory;
    if (directory == null || account.id == current?.account?.id) return;
    await directory.activate(account);
    navigatorKey.currentState?.popUntil((route) => route.isFirst);
    _adopt(_sessionFor(account));
    if (mounted) {
      setState(() {
        userId = account.userId;
        signingIn = false;
        error = null;
      });
    }
    await restore();
  }

  /// Signs out of the account on screen; any other goes on screen instead.
  Future<void> signOut() async {
    final session = current;
    if (session == null) return;
    try {
      await session.auth.signOut();
      session.sessions.clear();
      final account = session.account;
      final directory = this.directory;
      if (directory != null && account != null) {
        await directory.remove(account);
        final next = directory.active;
        if (next != null) {
          _adopt(_sessionFor(next));
          if (mounted) setState(() => userId = next.userId);
          await restore();
          return;
        }
        current = null;
        otherUnread.watch(const []);
      }
      if (mounted) setState(() => userId = null);
    } catch (_) {
      if (mounted) {
        setState(() {
          error = 'Couldn’t sign out. Please reconnect and try again.';
        });
      }
      messengerKey.currentState?.showSnackBar(
        const SnackBar(
          content: Text('Couldn’t sign out. Please reconnect and try again.'),
        ),
      );
    }
  }

  /// Signs out of an account that is not on screen, from the switcher.
  Future<void> signOutOf(AccountRecord account) async {
    final directory = this.directory;
    if (directory == null) return;
    if (account.id == current?.account?.id) return signOut();
    final session = _sessionFor(account);
    try {
      // The platform delivers push for one account on this build's own
      // deployment, and the one on screen took it if it is there.
      await signOutOfPushV1(
        session.api,
        session.store,
        platform: current?.account?.hosted != true,
      );
      await session.auth.signOut();
      await directory.remove(account);
      _adopt(current!);
    } catch (_) {
      messengerKey.currentState?.showSnackBar(
        SnackBar(
          content: Text(
            'Couldn’t reach ${account.serverLabel} to sign out. Check your '
            'connection and try again.',
          ),
        ),
      );
    } finally {
      session.dispose();
      if (mounted) setState(() {});
    }
  }

  /// Opens sign-in over the account on screen, to add another.
  void addAccount() {
    navigatorKey.currentState?.popUntil((route) => route.isFirst);
    setState(() {
      signingIn = true;
      choosingServer = false;
      server = null;
      error = null;
      awaitingBrowser = false;
    });
  }

  void _cancelAdding() {
    adding?.dispose();
    adding = null;
    unawaited(directory?.abandon());
    setState(() {
      signingIn = false;
      choosingServer = false;
      server = null;
      error = null;
      awaitingBrowser = false;
      busy = false;
    });
  }

  Widget? _switcher() {
    final directory = this.directory;
    final active = current?.account;
    if (directory == null || active == null) return null;
    return ListenableBuilder(
      listenable: Listenable.merge([directory, otherUnread]),
      builder: (context, _) => AccountSwitcher(
        accounts: directory.accounts,
        activeId: active.id,
        unreadOf: otherUnread.unreadOf,
        onSwitch: (account) => unawaited(switchTo(account)),
        onSignOut: (account) => unawaited(signOutOf(account)),
        onAdd: addAccount,
      ),
    );
  }

  Widget _signInDoor() {
    if (choosingServer) {
      return ServerAddressPage(
        discover: widget.discover ?? discoverServerV1,
        onFound: (found) => setState(() {
          server = found;
          choosingServer = false;
          error = null;
          awaitingBrowser = false;
        }),
        onBack: () => setState(() => choosingServer = false),
      );
    }
    return SignInPage(
      busy: busy,
      awaitingBrowser: awaitingBrowser,
      error: error,
      onSignIn: signIn,
      server: server,
      onUseAnotherServer: directory == null
          ? null
          : () => setState(() {
              choosingServer = true;
              error = null;
            }),
      onCancel: signingIn && current != null ? _cancelAdding : null,
    );
  }

  @override
  Widget build(BuildContext context) {
    final session = current;
    return MaterialApp(
      title: clientBrand.productName,
      navigatorKey: navigatorKey,
      scaffoldMessengerKey: messengerKey,
      debugShowCheckedModeBanner: false,
      theme: FrockTheme.theme(Brightness.light),
      darkTheme: FrockTheme.theme(Brightness.dark),
      themeMode: ThemeMode.dark,
      builder: (context, child) {
        final framed = UpdateReadyFrame(controller: updates, child: child!);
        final desktop = desktopUpdates;
        return desktop == null
            ? framed
            : DesktopUpdateFrame(controller: desktop, child: framed);
      },
      home: userId == null || session == null || signingIn
          ? _signInDoor()
          : AppShell(
              key: ValueKey('${session.account?.id}/$userId'),
              api: session.api,
              store: session.store,
              sessions: session.sessions,
              userId: userId!,
              botLinks: botLinks,
              onSignOut: signOut,
              version: updates.version,
              accountSwitcher: _switcher(),
              elsewhere: directory == null ? null : elsewhere,
            ),
    );
  }

  @override
  void dispose() {
    unawaited(links?.cancel());
    botLinks.dispose();
    otherUnread.removeListener(_countElsewhere);
    otherUnread.dispose();
    elsewhere.dispose();
    current?.dispose();
    adding?.dispose();
    updates.dispose();
    desktopUpdates?.dispose();
    super.dispose();
  }
}
