/// A host frame on the phone: a hardened WebView.
///
/// The web build has an iframe and the browser's own sandbox attribute; a
/// phone has neither, so every one of those guarantees is set by hand here —
/// no file or content access, no geolocation, no permission grant, no file
/// picker, no mixed content, no link preview, and a navigation delegate that
/// admits exactly the one URL the host asked for.
library;

import 'dart:async';

import 'package:flutter/foundation.dart'
    show TargetPlatform, defaultTargetPlatform;
import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';
import 'package:webview_flutter_wkwebview/webview_flutter_wkwebview.dart';

class HostFrameView extends StatefulWidget {
  final String url;

  /// Whether the framed document keeps its own origin. Off for untrusted
  /// pages, which is the phone's equivalent of omitting `allow-same-origin`.
  final bool allowSameOrigin;
  final String label;
  const HostFrameView({
    super.key,
    required this.url,
    required this.label,
    this.allowSameOrigin = false,
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
    if (old.url != widget.url) unawaited(_open());
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
      await web.setNavigationDelegate(
        NavigationDelegate(
          // One document, named by the host. Anything else — a link the page
          // draws, a redirect it follows — is refused rather than opened, and
          // never handed to the OS from inside an untrusted frame.
          onNavigationRequest: (request) => request.url == widget.url
              ? NavigationDecision.navigate
              : NavigationDecision.prevent,
          onHttpAuthRequest: (request) => request.onCancel(),
        ),
      );
      if (!mounted || epoch != _epoch) return;
      setState(() => _web = web);
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
