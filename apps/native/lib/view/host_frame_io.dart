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
    show TargetPlatform, defaultTargetPlatform;
import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';
import 'package:webview_flutter_wkwebview/webview_flutter_wkwebview.dart';

class HostFrameView extends StatefulWidget {
  final String url;

  /// Delivered to the page in order once its document has loaded, as the
  /// `message` events the page's own listener waits for. Empty where the page
  /// needs nothing from the host.
  final List<Map<String, Object?>> messages;

  /// Whether the framed document keeps its own origin. Off for untrusted
  /// pages, which is the phone's equivalent of omitting `allow-same-origin`.
  final bool allowSameOrigin;
  final String label;
  final ValueChanged<String>? onFailure;
  final VoidCallback? onLoaded;

  /// What the page said. A WebView's top document is its own `parent`, so a
  /// page posting to `window.parent` raises a `message` event on the same
  /// window; the listener installed below forwards those over a channel.
  final ValueChanged<Map<String, Object?>>? onMessage;
  const HostFrameView({
    super.key,
    required this.url,
    required this.label,
    this.messages = const [],
    this.allowSameOrigin = false,
    this.onFailure,
    this.onLoaded,
    this.onMessage,
  });

  @override
  State<HostFrameView> createState() => _HostFrameViewState();
}

class _HostFrameViewState extends State<HostFrameView> {
  WebViewController? _web;
  int _epoch = 0;

  @override
  void initState() {
    super.initState();
    unawaited(_open());
  }

  @override
  void didUpdateWidget(HostFrameView old) {
    super.didUpdateWidget(old);
    if (old.url != widget.url) {
      unawaited(_open());
    } else if (jsonEncode(old.messages) != jsonEncode(widget.messages)) {
      unawaited(_deliver(_web, _epoch));
    }
  }

  Future<void> _open() async {
    final epoch = ++_epoch;
    if (mounted) setState(() => _web = null);
    try {
      final params = defaultTargetPlatform == TargetPlatform.macOS
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
      if (widget.onMessage != null) {
        await web.addJavaScriptChannel(
          _channel,
          onMessageReceived: (message) {
            if (epoch != _epoch) return;
            try {
              final decoded = jsonDecode(message.message);
              if (decoded is Map) {
                widget.onMessage!(decoded.cast<String, Object?>());
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
          onPageFinished: (url) {
            if (url != widget.url) return;
            if (epoch == _epoch) widget.onLoaded?.call();
            unawaited(_forward(web, epoch));
            unawaited(_deliver(web, epoch));
          },
          onWebResourceError: (error) {
            if (error.isForMainFrame == true) _fail(epoch);
          },
          onHttpAuthRequest: (request) => request.onCancel(),
        ),
      );
      if (!mounted || epoch != _epoch) return;
      setState(() => _web = web);
      // Anonymous: no session header ever accompanies a framed page.
      await web.loadRequest(Uri.parse(widget.url));
    } catch (_) {
      _fail(epoch);
    }
  }

  /// The channel a forwarded page message arrives on. One name, because one
  /// WebView carries one page.
  static const _channel = 'frockbotHostFrame';

  /// Forwards what the page posts to its parent, which in a WebView is itself.
  /// Host messages raise the same event, so anything carrying a host `type` is
  /// dropped here rather than handed back to the host as if a page had said it.
  Future<void> _forward(WebViewController web, int epoch) async {
    if (widget.onMessage == null || epoch != _epoch) return;
    try {
      await web.runJavaScript('''
window.addEventListener("message", (event) => {
  const data = event && event.data;
  if (!data || typeof data !== "object") return;
  if (data.type === "init" || data.type === "state") return;
  try { $_channel.postMessage(JSON.stringify(data)); } catch (_) {}
});
''');
    } catch (_) {
      _fail(epoch);
    }
  }

  /// The page is the top document in a WebView, so it is its own `parent` and
  /// `window.postMessage` reaches the listener the SDK installed.
  Future<void> _deliver(WebViewController? web, int epoch) async {
    if (web == null || epoch != _epoch) return;
    try {
      for (final message in widget.messages) {
        await web.runJavaScript(
          'window.postMessage(${jsonEncode(message)}, "*")',
        );
      }
    } catch (_) {
      _fail(epoch);
    }
  }

  void _fail(int epoch) {
    if (!mounted || epoch != _epoch) return;
    widget.onFailure?.call('This page couldn’t be opened.');
  }

  @override
  void dispose() {
    ++_epoch;
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
