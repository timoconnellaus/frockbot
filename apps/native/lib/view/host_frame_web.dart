/// A host frame in the browser: a platform view over an iframe, with the same
/// CSP posture a Package page is given.
///
/// `sandbox` is the whole of the guarantee. An untrusted page gets
/// `allow-scripts` and nothing else, so it runs in an opaque origin with no
/// storage, no top-level navigation and no form submission; the Computer's own
/// viewer keeps its origin because noVNC is first-party and needs it.
library;

import 'dart:convert';
import 'dart:js_interop';
import 'dart:ui_web' as ui_web;

import 'package:flutter/material.dart';
import 'package:web/web.dart' as web;

@JS('JSON.parse')
external JSAny? _parseJson(JSString text);

@JS('JSON.stringify')
external JSString? _stringifyJson(JSAny? value);

/// One view type per frame, so a rebuilt frame never adopts another's element.
int _nextFrame = 0;

class HostFrameView extends StatefulWidget {
  final String url;
  final List<Map<String, Object?>> messages;
  final bool allowSameOrigin;
  final String label;
  final ValueChanged<String>? onFailure;

  /// What the page said, once it is known to have come from this frame.
  final ValueChanged<Map<String, Object?>>? onMessage;
  const HostFrameView({
    super.key,
    required this.url,
    required this.label,
    this.messages = const [],
    this.allowSameOrigin = false,
    this.onFailure,
    this.onMessage,
  });

  @override
  State<HostFrameView> createState() => _HostFrameViewState();
}

class _HostFrameViewState extends State<HostFrameView> {
  late final String _viewType = 'frockbot-host-frame-${_nextFrame++}';
  late final web.HTMLIFrameElement _frame;
  bool _loaded = false;

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
    _frame.addEventListener(
      'load',
      ((web.Event _) {
        _loaded = true;
        _deliver();
      }).toJS,
    );
    ui_web.platformViewRegistry.registerViewFactory(
      _viewType,
      (int _) => _frame,
    );
    web.window.addEventListener('message', _listener);
    _frame.src = widget.url;
  }

  late final JSFunction _listener = ((web.MessageEvent event) {
    // Provenance first: a message is this page's only if the browser says the
    // source window is this frame's. Anything else on the app's own window —
    // another frame, an extension — is not this page speaking.
    final source = event.source;
    final frame = _frame.contentWindow;
    if (widget.onMessage == null ||
        source == null ||
        frame == null ||
        !source.equals(frame).toDart) {
      return;
    }
    final text = _stringifyJson(event.data);
    if (text == null) return;
    final decoded = jsonDecode(text.toDart);
    if (decoded is Map) {
      widget.onMessage!(decoded.cast<String, Object?>());
    }
  }).toJS;

  @override
  void didUpdateWidget(HostFrameView old) {
    super.didUpdateWidget(old);
    if (old.url != widget.url) {
      _loaded = false;
      _frame.src = widget.url;
      return;
    }
    if (jsonEncode(old.messages) != jsonEncode(widget.messages)) _deliver();
  }

  void _deliver() {
    if (!_loaded || widget.messages.isEmpty) return;
    final target = _frame.contentWindow;
    if (target == null) {
      widget.onFailure?.call('This page couldn’t be opened.');
      return;
    }
    for (final message in widget.messages) {
      final encoded = _parseJson(jsonEncode(message).toJS);
      if (encoded == null) continue;
      // A sandboxed frame has an opaque origin, so `*` is the only target that
      // reaches it. The message carries no session — only the scoped viewer
      // credential the page is entitled to.
      target.postMessage(encoded, '*'.toJS);
    }
  }

  @override
  void dispose() {
    web.window.removeEventListener('message', _listener);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Semantics(
    label: widget.label,
    child: HtmlElementView(viewType: _viewType),
  );
}
