# WebKit qualification adapter

Upstream: `webview_flutter_wkwebview` **3.26.1**, as resolved by `webview_flutter` **4.14.1**. Copied from the pub.dev archive (license, pubspec, Dart and Darwin source). No executable code is fetched from an extension.

One reviewed change in `WebViewConfigurationProxyAPIDelegate.swift`: initialize each `WKWebViewConfiguration` with its own `WKWebsiteDataStore.nonPersistent()` before constructing the WebView. The published Dart creation parameters do not expose this setting. All WebViews in this prototype are untrusted extension regions; application authentication uses the system browser and protected native transport.

This is a candidate adapter change, not a claim that nonpersistent storage proves isolation. Synthetic-cookie, nested-frame, navigation and network inspection on each OS remain acceptance gates. The protocol/plugin pins stay exact; the override and its source are committed so qualification can name the actual build.
