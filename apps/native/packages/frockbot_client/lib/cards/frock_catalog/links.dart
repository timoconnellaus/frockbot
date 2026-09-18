/// How a Card opens a link, which is the host's business and never the card's.
///
/// ADR 0030: "Images load over https only; `openUrl` opens through the host's
/// own link handling, never directly." That is one function, here, and every
/// component that can follow a link calls it — so there is one place the
/// scheme is checked a second time, one place a deployment would change what
/// opening means, and no component that can be talked into opening something
/// else by a value in a data model.
library;

import 'package:url_launcher/url_launcher.dart';

/// Opens [url] the way the rest of the app opens an external link.
///
/// It is a variable rather than a function so that a test can put something
/// else there: a widget test has no browser to hand a link to, and what is
/// worth asserting is that the component asked the host rather than opening
/// anything itself.
Future<bool> Function(String url) frockOpenLinkV1 = _openExternally;

Future<bool> _openExternally(String url) async {
  // The seam refused a non-https link before the card was drawn, and this
  // refuses it again at the moment of opening: a link can also arrive through
  // the data model, which admission never sees.
  if (!url.startsWith('https://')) return false;
  final uri = Uri.tryParse(url);
  if (uri == null) return false;
  return launchUrl(uri, mode: LaunchMode.externalApplication);
}
