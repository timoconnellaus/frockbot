import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';
import 'package:webview_flutter_wkwebview/webview_flutter_wkwebview.dart';

import '../client/transport.dart';
import '../theme/states.dart';
import '../ui/frock_page.dart';
import '../ui/frock_tokens.dart';
import '../ui/frock_widgets.dart';
import '../protocol/client_wire.generated.dart' as wire;

const artifactOrigin = 'https://ui.bot.frockbot.com';

/// Policy is independent of WebView so every inbound binding is testable.
class FallbackLease {
  final Map<String, dynamic> value;
  FallbackLease(Object? input, String userId, String appletId, String epoch)
    : value =
          wire.FallbackBootstrap.fromJson(input).toJson()
              as Map<String, dynamic> {
    final artifact = value['artifact'] as Map;
    final expected = Uri.parse('$artifactOrigin/native-fallback').replace(
      queryParameters: {
        'artifact': artifact['contentHash'] as String,
        'epoch': epoch,
      },
    );
    final viewer = value['viewer'] as Map;
    if (value['userId'] != userId ||
        value['appletId'] != appletId ||
        value['navigationEpoch'] != epoch ||
        value['artifactOrigin'] != artifactOrigin ||
        Uri.parse(value['bootstrapUrl'] as String) != expected ||
        viewer['socketUrl'] !=
            'wss://bot.frockbot.com/api/applets/${Uri.encodeComponent(appletId)}/socket' ||
        DateTime.parse(viewer['expiresAt'] as String)
                .difference(DateTime.now())
                .inSeconds <
            15 ||
        DateTime.parse(viewer['expiresAt'] as String)
                .difference(DateTime.now())
                .inMinutes >
            6) {
      throw const FormatException('Invalid viewer binding');
    }
  }
  String get epoch => value['navigationEpoch'] as String;
  String get generation => value['generationId'] as String;
  Uri get bootstrap => Uri.parse(value['bootstrapUrl'] as String);
  String get artifactUrl =>
      '$artifactOrigin/packages/${(value['artifact'] as Map)['contentHash']}.html';
  DateTime get expiresAt =>
      DateTime.parse((value['viewer'] as Map)['expiresAt'] as String);
  Map<String, Object?> get init => {
    'appletId': value['appletId'],
    'generationId': generation,
    'token': (value['viewer'] as Map)['token'],
    'socketUrl': (value['viewer'] as Map)['socketUrl'],
    'tokenTransport': 'subprotocol-v1',
  };
  Future<bool> isReady(WebViewController web) async {
    // Return a JS boolean. Android's bridge JSON-encodes strings once more
    // than WebKit; comparing an epoch string in Dart rejects valid Android pages.
    final ready = await web.runJavaScriptReturningResult(
      'window.frockbotFallback?.ready() === ${jsonEncode(epoch)}',
    );
    return ready == true || ready == 'true';
  }

  bool allows(String url, bool mainFrame) =>
      mainFrame ? url == bootstrap.toString() : url == artifactUrl;
}

class AppletDirectoryPage extends StatefulWidget {
  final NativeApi api;
  final String userId;
  const AppletDirectoryPage({
    super.key,
    required this.api,
    required this.userId,
  });
  @override
  State<AppletDirectoryPage> createState() => _AppletDirectoryPageState();
}

class _AppletDirectoryPageState extends State<AppletDirectoryPage> {
  late Future<wire.AppletDirectory> directory = loadDirectory();
  Future<wire.AppletDirectory> loadDirectory() =>
      widget.api.request('/api/applets').then(wire.AppletDirectory.fromJson);
  void reload() => setState(() => directory = loadDirectory());
  @override
  Widget build(BuildContext context) => FrockPage(
    title: 'Your Applets',
    trailing: FrockIconButton(
      Icons.refresh_rounded,
      semanticLabel: 'Refresh Applets',
      onTap: reload,
    ),
    child: FutureBuilder(
      future: directory,
      builder: (context, snapshot) {
        if (snapshot.hasError) {
          return FrockEmptyState(
            title: 'Couldn’t load your Applets',
            detail: 'Check your connection and try again.',
            action: 'Try again',
            onAction: reload,
            icon: Icons.wifi_off_rounded,
          );
        }
        if (!snapshot.hasData) {
          return const FrockLoading(label: 'Loading your Applets');
        }
        final applets = snapshot.data!.applets
            .where((a) => a.status == 'published')
            .toList();
        if (applets.isEmpty) {
          return FrockEmptyState(
            title: 'A space for your Applets',
            detail: 'Ask a Bot to make an Applet. Once published, it will appear here.',
            action: 'Back to your Bots',
            onAction: () => Navigator.of(context).pop(),
            icon: Icons.widgets_outlined,
          );
        }
        return ListView(
          padding: EdgeInsets.zero,
          children: [
            const FrockLead(
              'Small apps your Bots have built for you. Each one runs in its own space.',
            ),
            const FrockEyebrow('Published'),
            const SizedBox(height: FrockTokens.eyebrowToGroup),
            FrockGroup(
              children: [
                for (final applet in applets)
                  FrockRow(
                    key: ValueKey('applet-${applet.appletId}'),
                    leading: const FrockIconTile(Icons.widgets_rounded),
                    title: applet.displayName,
                    chevron: true,
                    onTap: () => Navigator.of(context).push(
                      MaterialPageRoute<void>(
                        builder: (_) => AppletPage(
                          api: widget.api,
                          userId: widget.userId,
                          appletId: applet.appletId,
                          name: applet.displayName,
                        ),
                      ),
                    ),
                  ),
              ],
            ),
          ],
        );
      },
    ),
  );
}

class AppletPage extends StatefulWidget {
  final NativeApi api;
  final String userId;
  final String appletId;
  final String name;
  const AppletPage({
    super.key,
    required this.api,
    required this.userId,
    required this.appletId,
    required this.name,
  });
  @override
  State<AppletPage> createState() => _AppletPageState();
}

class _AppletPageState extends State<AppletPage> with WidgetsBindingObserver {
  WebViewController? _web;
  Timer? _renewal;
  String? _error;
  bool _pageUnavailable = false;
  Uri? _externalLink;
  int _epoch = 0;
  bool _ready = false;
  bool _providing = false;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(_open());
  }

  Future<FallbackLease> _fetch(String epoch) async => FallbackLease(
    await widget.api.request(
      '/api/native/applets/${Uri.encodeComponent(widget.appletId)}/bootstrap?epoch=$epoch',
    ),
    widget.userId,
    widget.appletId,
    epoch,
  );
  Future<void> _open() async {
    final epoch = ++_epoch;
    _renewal?.cancel();
    if (mounted) {
      setState(() {
        _error = null;
        _pageUnavailable = false;
        _ready = false;
        _web = null;
      });
    }
    var stage = 'viewer-lease';
    try {
      final lease = await _fetch(randomId());
      stage = 'webview-configuration';
      if (!mounted || epoch != _epoch) return;
      final params = Platform.isMacOS
          ? WebKitWebViewControllerCreationParams(
              mediaTypesRequiringUserAction: {
                PlaybackMediaTypes.audio,
                PlaybackMediaTypes.video,
              },
            )
          : const PlatformWebViewControllerCreationParams();
      final web = WebViewController.fromPlatformCreationParams(
        params,
        onPermissionRequest: (request) => request.deny(),
      );
      await web.setJavaScriptMode(JavaScriptMode.unrestricted);
      if (web.platform is AndroidWebViewController) {
        final android = web.platform as AndroidWebViewController;
        if (const bool.fromEnvironment('NATIVE_ACCEPTANCE')) {
          await AndroidWebViewController.enableDebugging(true);
        }
        await android.setAllowFileAccess(false);
        await android.setAllowContentAccess(false);
        await android.setGeolocationEnabled(false);
        await android.setMediaPlaybackRequiresUserGesture(true);
        await android.setOnShowFileSelector((_) async => []);
        await android.setMixedContentMode(MixedContentMode.neverAllow);
      }
      if (web.platform is WebKitWebViewController) {
        final webkit = web.platform as WebKitWebViewController;
        if (const bool.fromEnvironment('NATIVE_ACCEPTANCE')) {
          await webkit.setInspectable(true);
        }
        await webkit.setAllowsBackForwardNavigationGestures(false);
        await webkit.setAllowsLinkPreview(false);
      }
      await web.setNavigationDelegate(
        NavigationDelegate(
          onNavigationRequest: (request) {
            if (epoch != _epoch) return NavigationDecision.prevent;
            if (lease.allows(request.url, request.isMainFrame)) {
              return NavigationDecision.navigate;
            }
            // No headers or viewer token accompany a system-browser navigation.
            final uri = Uri.tryParse(request.url);
            if (uri != null && uri.scheme == 'https' && uri.host.isNotEmpty) {
              // Navigation callbacks do not prove a user gesture. The reviewed
              // host requires a tap before handing an untrusted link to the OS.
              setState(() {
                _externalLink = uri;
              });
            }
            if (request.isMainFrame) _fail(epoch);
            return NavigationDecision.prevent;
          },
          onPageFinished: (url) {
            if (url == lease.bootstrap.toString()) {
              unawaited(_handshake(web, lease, epoch));
            }
          },
          onWebResourceError: (error) {
            if (error.isForMainFrame == true) _fail(epoch);
          },
          onHttpAuthRequest: (request) => request.onCancel(),
        ),
      );
      if (!mounted || epoch != _epoch) return;
      setState(() {
        _web = web;
      });
      // Anonymous request: never use NativeApi headers in a WebView.
      stage = 'anonymous-bootstrap';
      await web.loadRequest(lease.bootstrap);
    } catch (failure) {
      if (const bool.fromEnvironment('NATIVE_ACCEPTANCE')) {
        // No URL, response, identifier, or credential enters device diagnostics.
        // ignore: avoid_print -- compile-time local qualification instrumentation.
        print(
          'FROCKBOT_FALLBACK $stage ${failure.runtimeType} ${failure is RequestFailure ? failure.status : ""}',
        );
      }
      _fail(epoch);
    }
  }

  Future<void> _handshake(
    WebViewController web,
    FallbackLease lease,
    int epoch,
  ) async {
    if (_providing) return;
    _providing = true;
    try {
      for (var attempt = 0; attempt < 40; attempt++) {
        if (!mounted || epoch != _epoch) return;
        if (await web.currentUrl() != lease.bootstrap.toString()) {
          throw const FormatException('Navigation changed');
        }
        if (await lease.isReady(web)) {
          await _provide(web, lease, epoch);
          return;
        }
        await Future<void>.delayed(const Duration(milliseconds: 100));
      }
      _fail(epoch, pageUnavailable: true);
    } catch (_) {
      _fail(epoch);
    } finally {
      _providing = false;
    }
  }

  Future<void> _provide(
    WebViewController web,
    FallbackLease lease,
    int epoch,
  ) async {
    if (!mounted ||
        epoch != _epoch ||
        await web.currentUrl() != lease.bootstrap.toString()) {
      return;
    }
    final accepted = await web.runJavaScriptReturningResult(
      'window.frockbotFallback.provide(${jsonEncode(lease.epoch)},${jsonEncode(lease.init)})',
    );
    if (accepted != true && accepted != 'true') {
      throw const FormatException('Viewer refused');
    }
    if (!mounted || epoch != _epoch) return;
    setState(() {
      _ready = true;
    });
    _renewal?.cancel();
    _renewal = Timer(
      lease.expiresAt.difference(DateTime.now()) - const Duration(seconds: 30),
      () async {
        try {
          final next = await _fetch(lease.epoch);
          if (epoch != _epoch) return;
          if (next.generation != lease.generation ||
              next.artifactUrl != lease.artifactUrl) {
            _fail(epoch);
            return;
          }
          await _provide(web, next, epoch);
        } catch (_) {
          _fail(epoch);
        }
      },
    );
  }

  void _fail(int epoch, {bool pageUnavailable = false}) {
    if (!mounted || epoch != _epoch) return;
    ++_epoch;
    _renewal?.cancel();
    final old = _web;
    if (old != null) {
      unawaited(
        old
            .runJavaScript('window.frockbotFallback?.close()')
            .catchError((Object _) {}),
      );
    }
    setState(() {
      _web = null;
      _ready = false;
      _pageUnavailable = pageUnavailable;
      _error = 'This Applet couldn’t be opened. Your conversation is still available.';
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) {
      _fail(_epoch);
    }
  }

  @override
  void dispose() {
    ++_epoch;
    _renewal?.cancel();
    final old = _web;
    if (old != null) {
      unawaited(
        old
            .runJavaScript('window.frockbotFallback?.close()')
            .catchError((Object _) {}),
      );
    }
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = FrockTokens.of(context);
    return FrockPage(
      title: widget.name,
      padded: false,
      maxWidth: double.infinity,
      trailing: FrockIconButton(
        Icons.refresh_rounded,
        semanticLabel: 'Reopen Applet',
        onTap: _open,
      ),
      child: Column(
        children: [
          // Compiled host attribution always sits outside the untrusted region.
          Padding(
            padding: const EdgeInsets.fromLTRB(
              FrockTokens.edge,
              0,
              FrockTokens.edge,
              8,
            ),
            child: Row(
              children: [
                Icon(
                  Icons.widgets_rounded,
                  size: FrockTokens.iconSm,
                  color: t.ink3,
                ),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    'Applet · ${widget.name} · runs in its own space',
                    style: t.caption,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ],
            ),
          ),
          if (_externalLink != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(
                FrockTokens.edge,
                0,
                FrockTokens.edge,
                8,
              ),
              child: FrockGroup(
                needsYou: true,
                children: [
                  FrockNotice(
                    title: 'Open this link in your browser?',
                    body: _externalLink.toString(),
                    actions: [
                      FrockPill(
                        'Open',
                        size: PillSize.sm,
                        icon: Icons.open_in_new_rounded,
                        onTap: () {
                          final link = _externalLink!;
                          setState(() {
                            _externalLink = null;
                          });
                          unawaited(
                            launchUrl(
                              link,
                              mode: LaunchMode.externalApplication,
                            ),
                          );
                        },
                      ),
                      FrockPill(
                        'Not now',
                        kind: PillKind.ghost,
                        size: PillSize.sm,
                        color: t.ink2,
                        onTap: () => setState(() => _externalLink = null),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          if (_error != null)
            Expanded(
              child: FrockEmptyState(
                title: _pageUnavailable
                    ? 'Applet couldn’t start'
                    : 'Couldn’t open this Applet',
                detail: _pageUnavailable
                    ? 'The page opened, but couldn’t connect to FrockBot. Try reopening it. If it still won’t connect, ask your Bot to publish it again.'
                    : 'Your conversation is still available. Check your connection, then try opening the Applet again.',
                action: 'Try again',
                onAction: _open,
                icon: Icons.widgets_outlined,
              ),
            ),
          if (_error == null && !_ready)
            const FrockLoading(label: 'Opening Applet'),
          if (_web != null)
            Expanded(
              child: ClipRRect(
                borderRadius: const BorderRadius.vertical(
                  top: Radius.circular(FrockTokens.radiusGroup),
                ),
                child: WebViewWidget(controller: _web!),
              ),
            ),
        ],
      ),
    );
  }
}
