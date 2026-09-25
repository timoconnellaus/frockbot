/// A host frame in the browser: a platform view over an iframe.
///
/// `sandbox` is the whole of the guarantee. An untrusted page gets
/// `allow-scripts` and nothing else, so it runs in an opaque origin with no
/// storage, no top-level navigation and no form submission; the Computer's own
/// viewer keeps its origin because the viewer page is first-party and needs it.
library;

import 'dart:async';
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
  final bool allowSameOrigin;
  final String label;
  final ValueChanged<Map<String, Object?>>? onMessage;
  final Stream<Map<String, Object?>>? outbox;
  final VoidCallback? onLoaded;
  const HostFrameView({
    super.key,
    required this.url,
    required this.label,
    this.allowSameOrigin = false,
    this.onMessage,
    this.outbox,
    this.onLoaded,
  });

  @override
  State<HostFrameView> createState() => _HostFrameViewState();
}

class _HostFrameViewState extends State<HostFrameView> {
  late final String _viewType = 'frockbot-host-frame-${_nextFrame++}';
  late final web.HTMLIFrameElement _frame;
  bool _loaded = false;
  StreamSubscription<Map<String, Object?>>? _outbox;
  final _waiting = <Map<String, Object?>>[];

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
        final waiting = [..._waiting];
        _waiting.clear();
        waiting.forEach(_post);
        if (mounted) widget.onLoaded?.call();
      }).toJS,
    );
    if (widget.onMessage != null) {
      web.window.addEventListener('message', _listener);
    }
    _outbox = widget.outbox?.listen(_send);
    ui_web.platformViewRegistry.registerViewFactory(
      _viewType,
      (int _) => _frame,
    );
    _frame.src = widget.url;
  }

  /// A message is this page's only if the browser says it came from this
  /// frame's window. Anything else on the app's own window — another frame,
  /// an extension — is not this page speaking.
  late final JSFunction _listener = ((web.MessageEvent event) {
    final source = event.source;
    final frame = _frame.contentWindow;
    if (source == null || frame == null || !source.equals(frame).toDart) {
      return;
    }
    final text = _stringifyJson(event.data);
    if (text == null) return;
    final decoded = jsonDecode(text.toDart);
    if (decoded is Map) widget.onMessage?.call(decoded.cast<String, Object?>());
  }).toJS;

  void _send(Map<String, Object?> message) {
    if (_loaded) {
      _post(message);
    } else if (_waiting.length < 64) {
      _waiting.add(message);
    }
  }

  void _post(Map<String, Object?> message) {
    final target = _frame.contentWindow;
    final data = _parseJson(jsonEncode(message).toJS);
    // A sandboxed frame has an opaque origin, so `*` is the only target that
    // reaches it; nothing posted carries a credential.
    if (target != null && data != null) target.postMessage(data, '*'.toJS);
  }

  @override
  void didUpdateWidget(HostFrameView old) {
    super.didUpdateWidget(old);
    if (old.url != widget.url) {
      _loaded = false;
      _frame.src = widget.url;
    }
  }

  @override
  void dispose() {
    unawaited(_outbox?.cancel());
    web.window.removeEventListener('message', _listener);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Semantics(
    label: widget.label,
    child: HtmlElementView(viewType: _viewType),
  );
}
