import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';
import 'package:webview_flutter_wkwebview/webview_flutter_wkwebview.dart';

import '../client/transport.dart';
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
  late final Future<wire.AppletDirectory> directory = widget.api
      .request('/api/applets')
      .then(wire.AppletDirectory.fromJson);
  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Your Applets')),
    body: FutureBuilder(
      future: directory,
      builder: (context, snapshot) {
        if (snapshot.hasError) {
          return const Center(
            child: Text('Couldn’t load your Applets. Please try again.'),
          );
        }
        if (!snapshot.hasData) {
          return const Center(child: CircularProgressIndicator());
        }
        final applets = snapshot.data!.applets
            .where((a) => a.status == 'published')
            .toList();
        if (applets.isEmpty) {
          return const Center(
            child: Text('Your published Applets will appear here.'),
          );
        }
        return ListView(
          children: [
            for (final applet in applets)
              ListTile(
                leading: const Icon(Icons.widgets_outlined),
                title: Text(applet.displayName),
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
        _ready = false;
        _web = null;
      });
    }
    try {
      final lease = await _fetch(randomId());
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
        await android.setAllowFileAccess(false);
        await android.setAllowContentAccess(false);
        await android.setGeolocationEnabled(false);
        await android.setMediaPlaybackRequiresUserGesture(true);
        await android.setOnShowFileSelector((_) async => []);
        await android.setMixedContentMode(MixedContentMode.neverAllow);
      }
      if (web.platform is WebKitWebViewController) {
        final webkit = web.platform as WebKitWebViewController;
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
      await web.loadRequest(lease.bootstrap);
    } catch (_) {
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
        final ready = await web.runJavaScriptReturningResult(
          'JSON.stringify(window.frockbotFallback?.ready() ?? null)',
        );
        // WebKit and Android return JS strings differently; compare bounded values.
        if (ready == jsonEncode(lease.epoch) || ready == lease.epoch) {
          await _provide(web, lease, epoch);
          return;
        }
        await Future<void>.delayed(const Duration(milliseconds: 100));
      }
      _fail(epoch);
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

  void _fail(int epoch) {
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
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: Text(widget.name),
      actions: [
        IconButton(
          tooltip: 'Reopen Applet',
          onPressed: _open,
          icon: const Icon(Icons.refresh),
        ),
      ],
    ),
    body: Column(
      children: [
        // Compiled host attribution always sits outside the untrusted region.
        ListTile(
          leading: const Icon(Icons.widgets_outlined),
          title: Text('Applet · ${widget.name}'),
        ),
        if (_externalLink != null)
          ListTile(
            title: const Text('Open this link in your browser?'),
            subtitle: Text(
              _externalLink.toString(),
              maxLines: 3,
              overflow: TextOverflow.ellipsis,
            ),
            trailing: TextButton(
              onPressed: () {
                final link = _externalLink!;
                setState(() {
                  _externalLink = null;
                });
                unawaited(
                  launchUrl(link, mode: LaunchMode.externalApplication),
                );
              },
              child: const Text('Open'),
            ),
          ),
        if (_error != null)
          Padding(padding: const EdgeInsets.all(24), child: Text(_error!)),
        if (_error == null && !_ready) const LinearProgressIndicator(),
        if (_web != null) Expanded(child: WebViewWidget(controller: _web!)),
      ],
    ),
  );
}
