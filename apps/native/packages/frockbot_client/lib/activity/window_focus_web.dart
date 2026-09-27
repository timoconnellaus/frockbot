import 'dart:js_interop';

import 'package:web/web.dart' as web;

class WindowFocus {
  JSFunction? _listener;
  bool get focused =>
      web.document.visibilityState == 'visible' && web.document.hasFocus();
  void start(void Function(bool) changed) {
    final listener = ((web.Event _) => changed(focused)).toJS;
    _listener = listener;
    web.window.addEventListener('focus', listener);
    web.window.addEventListener('blur', listener);
    web.document.addEventListener('visibilitychange', listener);
    changed(focused);
  }

  void dispose() {
    final listener = _listener;
    if (listener == null) return;
    web.window.removeEventListener('focus', listener);
    web.window.removeEventListener('blur', listener);
    web.document.removeEventListener('visibilitychange', listener);
    _listener = null;
  }
}
