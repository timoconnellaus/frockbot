/// A web page the host frames but does not draw.
///
/// Two implementations, one seam. In the browser the frame is a platform view
/// over an iframe under the `sandbox` attribute `host_frame_web.dart` sets; on
/// the phone it is a WebView with every one of those guarantees set by hand.
/// Both take the same things — the URL, whether the document keeps its own
/// origin, and the page's messages both ways — because everything above this
/// line is about which page is shown, never about how.
library;

import 'package:flutter/material.dart';

import 'host_frame_io.dart' if (dart.library.js_interop) 'host_frame_web.dart';

/// The frame, with the host's own border around it and nothing of the page's
/// outside it.
class HostFrame extends StatelessWidget {
  final String url;
  final bool allowSameOrigin;
  final String label;
  final BorderRadius borderRadius;

  /// What the page posted, decoded from JSON and proved to have come from this
  /// frame. The host decides what any of it means.
  final ValueChanged<Map<String, Object?>>? onMessage;

  /// Messages for the page, posted once each after the document has loaded;
  /// one sent before that waits for it.
  final Stream<Map<String, Object?>>? outbox;

  /// Told each time a document has loaded and the page's messages are being
  /// heard. A page may speak before then, and what it says is lost, so the
  /// host greets it here rather than waiting to be asked.
  final VoidCallback? onLoaded;

  /// Keeps the loaded page when the frame leaves the screen, so showing it
  /// again is instant. Only for a page whose document is worth keeping and
  /// which gives up everything it holds when it leaves.
  final bool keepAlive;

  /// The frame is remade rather than reused when this changes: a new
  /// generation, or a new viewer session, is a new document.
  final String identity;
  const HostFrame({
    super.key,
    required this.url,
    required this.label,
    required this.identity,
    this.allowSameOrigin = false,
    this.onMessage,
    this.outbox,
    this.onLoaded,
    this.keepAlive = false,
    this.borderRadius = const BorderRadius.all(Radius.circular(12)),
  });

  @override
  Widget build(BuildContext context) => ClipRRect(
    borderRadius: borderRadius,
    child: ColoredBox(
      color: Theme.of(context).colorScheme.surface,
      child: HostFrameView(
        key: ValueKey(identity),
        url: url,
        label: label,
        allowSameOrigin: allowSameOrigin,
        onMessage: onMessage,
        outbox: outbox,
        onLoaded: onLoaded,
        keepAs: keepAlive ? identity : null,
      ),
    ),
  );
}
