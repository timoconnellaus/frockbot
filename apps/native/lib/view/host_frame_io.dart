/// A host frame on the phone: a hardened WebView.
///
/// The web build has an iframe and the browser's own sandbox attribute; a
/// phone has neither, so every one of those guarantees is set by hand here —
/// no file or content access, no geolocation, no permission grant, no file
/// picker, no mixed content, no link preview, and a navigation delegate that
/// admits exactly the one URL the host asked for.
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart'
    show TargetPlatform, defaultTargetPlatform, kDebugMode, kProfileMode;
import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';
import 'package:webview_flutter_wkwebview/webview_flutter_wkwebview.dart';

import '../client/desktop_build.dart';
import '../client/ios_build.dart';

/// Whether a framed page can be inspected: Safari's Develop menu on Apple
/// platforms, `chrome://inspect` over ADB on Android. Debug and profile builds
/// and the Dev apps only (ADR 0036): no frame holds a credential, but a
/// release build is still the production app on a person's device.
const hostFrameInspectableV1 =
    kDebugMode ||
    kProfileMode ||
    desktopDevelopmentBuild ||
    iosDevelopmentBuild ||
    bool.fromEnvironment('FROCKBOT_LOCAL_DEV') ||
    bool.fromEnvironment('FROCKBOT_PAGE_INSPECTION');

/// A loaded page kept after its frame left the screen, so showing the frame
/// again reattaches the same document rather than loading it anew (ADR 0036,
/// amended 2026-09-25). Whoever shows it now hears what it says.
class _KeptPage {
  final WebViewController web;
  final String url;
  bool loaded = false;
  _HostFrameViewState? owner;
  _KeptPage(this.web, this.url);
}

/// At most two, the same bound as live HTML Cards; the oldest is let go.
const _keptPagesMaxV1 = 2;
final _keptPages = <String, _KeptPage>{};

void _keep(String key, _KeptPage page) {
  _keptPages.remove(key);
  _keptPages[key] = page;
  while (_keptPages.length > _keptPagesMaxV1) {
    final oldest = _keptPages.keys.first;
    if (_keptPages[oldest]?.owner != null) break;
    _keptPages.remove(oldest);
  }
}

class HostFrameView extends StatefulWidget {
  final String url;

  /// Whether the framed document keeps its own origin. Off for untrusted
  /// pages, which is the phone's equivalent of omitting `allow-same-origin`.
  final bool allowSameOrigin;
  final String label;
  final ValueChanged<Map<String, Object?>>? onMessage;
  final Stream<Map<String, Object?>>? outbox;
  final VoidCallback? onLoaded;

  /// Keeps the loaded page under this key when the frame leaves, and shows
  /// it again when a frame with the same key and URL comes back.
  final String? keepAs;
  const HostFrameView({
    super.key,
    required this.url,
    required this.label,
    this.allowSameOrigin = false,
    this.onMessage,
    this.outbox,
    this.onLoaded,
    this.keepAs,
  });

  @override
  State<HostFrameView> createState() => _HostFrameViewState();
}

class _HostFrameViewState extends State<HostFrameView> {
  WebViewController? _web;
  _KeptPage? _page;
  int _epoch = 0;
  bool _loaded = false;
  StreamSubscription<Map<String, Object?>>? _outbox;
  final _waiting = <Map<String, Object?>>[];

  /// The channel a page's messages arrive on; one WebView carries one page.
  static const _channel = 'frockbotHostFrame';

  @override
  void initState() {
    super.initState();
    _outbox = widget.outbox?.listen(_send);
    unawaited(_open());
  }

  @override
  void didUpdateWidget(HostFrameView old) {
    super.didUpdateWidget(old);
    if (old.url != widget.url) unawaited(_open());
  }

  void _send(Map<String, Object?> message) {
    final web = _web;
    if (_loaded && web != null) {
      unawaited(_post(web, _epoch, message));
    } else if (_waiting.length < 64) {
      _waiting.add(message);
    }
  }

  /// The page is the top document in a WebView, so it is its own `parent`.
  /// The host's message is dispatched as an untrusted event from the page's
  /// own window — the one the page's listener accepts — which is also what
  /// keeps it from being forwarded back as if the page had said it.
  Future<void> _post(
    WebViewController web,
    int epoch,
    Map<String, Object?> message,
  ) async {
    if (epoch != _epoch) return;
    try {
      await web.runJavaScript(
        'window.dispatchEvent(new MessageEvent("message", '
        '{data: ${jsonEncode(message)}, source: window}))',
      );
    } catch (_) {
      // A page that has gone missed nothing it could still read.
    }
  }

  /// Forwards what the page posts to its parent. Only a trusted event is the
  /// page's own `postMessage`; the host's deliveries are synthetic. Once per
  /// document, whichever frame shows it by then.
  static Future<void> _forward(WebViewController web) async {
    try {
      await web.runJavaScript('''
window.addEventListener("message", (event) => {
  if (!event.isTrusted || !event.data || typeof event.data !== "object") return;
  try { $_channel.postMessage(JSON.stringify(event.data)); } catch (_) {}
});
''');
    } catch (_) {
      // A page the listener cannot reach has said nothing.
    }
  }

  /// A frame that cannot be made inspectable, as on iOS before 16.4, still
  /// loads.
  Future<void> _inspectable(WebViewController web) async {
    try {
      switch (web.platform) {
        case final WebKitWebViewController webkit:
          await webkit.setInspectable(true);
        case AndroidWebViewController():
          await AndroidWebViewController.enableDebugging(true);
      }
    } catch (_) {}
  }

  /// The document is loaded and its messages are heard: deliver what
  /// waited, then say so.
  void _ready() {
    final web = _web;
    if (!mounted || web == null) return;
    _loaded = true;
    final epoch = _epoch;
    final waiting = [..._waiting];
    _waiting.clear();
    unawaited(() async {
      for (final message in waiting) {
        await _post(web, epoch, message);
      }
      if (mounted && epoch == _epoch) widget.onLoaded?.call();
    }());
  }

  void _letGo() {
    final page = _page;
    if (page != null && page.owner == this) page.owner = null;
    _page = null;
  }

  Future<void> _open() async {
    final epoch = ++_epoch;
    _loaded = false;
    _letGo();
    if (mounted) setState(() => _web = null);
    final keepAs = widget.keepAs;
    final kept = keepAs == null ? null : _keptPages[keepAs];
    if (kept != null && kept.url == widget.url && kept.owner == null) {
      kept.owner = this;
      _keep(keepAs!, kept);
      setState(() {
        _page = kept;
        _web = kept.web;
      });
      // Already loaded, it is greeted again at once with what it missed.
      if (kept.loaded) {
        WidgetsBinding.instance.addPostFrameCallback((_) => _ready());
      }
      return;
    }
    try {
      final params =
          defaultTargetPlatform == TargetPlatform.macOS ||
              defaultTargetPlatform == TargetPlatform.iOS
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
      if (web.platform case final AndroidWebViewController android) {
        await android.setAllowFileAccess(false);
        await android.setAllowContentAccess(false);
        await android.setGeolocationEnabled(false);
        await android.setMediaPlaybackRequiresUserGesture(true);
        await android.setOnShowFileSelector((_) async => []);
        await android.setMixedContentMode(MixedContentMode.neverAllow);
      }
      if (web.platform case final WebKitWebViewController webkit) {
        await webkit.setAllowsBackForwardNavigationGestures(false);
        await webkit.setAllowsLinkPreview(false);
      }
      if (hostFrameInspectableV1) await _inspectable(web);
      final page = _KeptPage(web, widget.url)..owner = this;
      final hasChannel = widget.onMessage != null;
      if (hasChannel) {
        await web.addJavaScriptChannel(
          _channel,
          onMessageReceived: (message) {
            // Whoever shows the page now hears it; a page nobody shows, or
            // one its frame has moved on from, says nothing.
            final owner = page.owner;
            if (owner == null || owner._page != page) return;
            try {
              final decoded = jsonDecode(message.message);
              if (decoded is Map) {
                owner.widget.onMessage?.call(decoded.cast<String, Object?>());
              }
            } catch (_) {
              // A page that says something unreadable has said nothing.
            }
          },
        );
      }
      await web.setNavigationDelegate(
        NavigationDelegate(
          // One document, named by the host. Anything else — a link the page
          // draws, a redirect it follows — is refused rather than opened, and
          // never handed to the OS from inside an untrusted frame.
          onNavigationRequest: (request) => request.url == widget.url
              ? NavigationDecision.navigate
              : NavigationDecision.prevent,
          onHttpAuthRequest: (request) => request.onCancel(),
          onPageFinished: (url) async {
            if (url != page.url || page.loaded) return;
            final owner = page.owner;
            if (hasChannel) await _forward(web);
            page.loaded = true;
            if (owner == null || owner._page != page) return;
            owner._ready();
          },
        ),
      );
      if (!mounted || epoch != _epoch) return;
      final keepAs = widget.keepAs;
      if (keepAs != null) _keep(keepAs, page);
      setState(() {
        _page = page;
        _web = web;
      });
      // Anonymous: no session header ever accompanies a framed page.
      await web.loadRequest(Uri.parse(widget.url));
    } catch (_) {
      // A frame that cannot open stays empty; the host's chrome around it is
      // still drawn.
    }
  }

  @override
  void dispose() {
    ++_epoch;
    _letGo();
    unawaited(_outbox?.cancel());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final web = _web;
    return Semantics(
      label: widget.label,
      child: web == null
          ? const SizedBox.expand()
          : WebViewWidget(controller: web),
    );
  }
}
