/// A host frame in the browser: a platform view over an iframe.
///
/// `sandbox` is the whole of the guarantee. An untrusted page gets
/// `allow-scripts` and nothing else, so it runs in an opaque origin with no
/// storage, no top-level navigation and no form submission; the Computer's own
/// viewer keeps its origin because the viewer page is first-party and needs it.
library;

import 'dart:ui_web' as ui_web;

import 'package:flutter/material.dart';
import 'package:web/web.dart' as web;

/// One view type per frame, so a rebuilt frame never adopts another's element.
int _nextFrame = 0;

class HostFrameView extends StatefulWidget {
  final String url;
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
  late final String _viewType = 'frockbot-host-frame-${_nextFrame++}';
  late final web.HTMLIFrameElement _frame;

  @override
  void initState() {
    super.initState();
    _frame = web.HTMLIFrameElement()
      ..title = widget.label
      ..style.border = '0'
      ..style.width = '100%'
      ..style.height = '100%'
      ..style.display = 'block'
      ..referrerPolicy = 'no-referrer';
    _frame.setAttribute(
      'sandbox',
      widget.allowSameOrigin
          ? 'allow-same-origin allow-scripts'
          : 'allow-scripts',
    );
    // Credentialless: the document loads in an ephemeral, unpartitioned store,
    // so the request that fetches an untrusted page carries none of the
    // viewer's cookies for the serving origin and leaves nothing behind for
    // the next page to read. `sandbox` alone does not say that, and the Vue
    // host said both.
    _frame.setAttribute('credentialless', '');
    ui_web.platformViewRegistry.registerViewFactory(
      _viewType,
      (int _) => _frame,
    );
    _frame.src = widget.url;
  }

  @override
  void didUpdateWidget(HostFrameView old) {
    super.didUpdateWidget(old);
    if (old.url != widget.url) _frame.src = widget.url;
  }

  @override
  Widget build(BuildContext context) => Semantics(
    label: widget.label,
    child: HtmlElementView(viewType: _viewType),
  );
}
