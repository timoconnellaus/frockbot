# WebKit adapter qualification patch

This is the source of `webview_flutter_wkwebview` **3.26.1** from pub.dev, with its upstream LICENSE retained. The only behavioral patch is the default `WKWebViewConfiguration` constructor in `WebViewConfigurationProxyAPIDelegate.swift`: it sets `websiteDataStore = .nonPersistent()` before returning the configuration. Dart's public `webview_flutter` API does not expose that construction choice.

The native app overrides the exact transitive package with this directory. No runtime downloaded native code is loaded. The adapter remains reviewed compiled base code. Do not infer cookie isolation or absence of bridge authority from the name of this option: the malicious frame/network/credential fixture still has to run on the actual Mac. The override must be retested whenever either WebView pin changes.
