/// A web page the host frames but does not draw.
///
/// Two implementations, one seam. In the browser the frame is a platform view
/// over an iframe under the `sandbox` attribute `host_frame_web.dart` sets; on
/// the phone it is a WebView with every one of those guarantees set by hand.
/// Both
/// take the same three things — the URL, the messages the host hands the
/// page, and whether the document keeps its own origin — because everything
/// above this line is about which page is shown, never about how.
library;

import 'package:flutter/material.dart';

import 'host_frame_io.dart' if (dart.library.js_interop) 'host_frame_web.dart';

/// The frame, with the host's own border around it and nothing of the page's
/// outside it.
class HostFrame extends StatelessWidget {
  final String url;
  final List<Map<String, Object?>> messages;
  final bool allowSameOrigin;
  final String label;
  final ValueChanged<String>? onFailure;

  /// What the page said, decoded from JSON and proved to have come from this
  /// frame. The host decides what any of it means.
  final ValueChanged<Map<String, Object?>>? onMessage;

  /// The frame is remade rather than reused when this changes: a new
  /// generation, or a new viewer session, is a new document.
  final String identity;
  const HostFrame({
    super.key,
    required this.url,
    required this.label,
    required this.identity,
    this.messages = const [],
    this.allowSameOrigin = false,
    this.onFailure,
    this.onMessage,
  });

  @override
  Widget build(BuildContext context) => ClipRRect(
    borderRadius: BorderRadius.circular(12),
    child: ColoredBox(
      color: Theme.of(context).colorScheme.surface,
      child: HostFrameView(
        key: ValueKey(identity),
        url: url,
        label: label,
        messages: messages,
        allowSameOrigin: allowSameOrigin,
        onFailure: onFailure,
        onMessage: onMessage,
      ),
    ),
  );
}
