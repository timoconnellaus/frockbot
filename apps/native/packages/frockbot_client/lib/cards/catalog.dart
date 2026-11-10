/// The catalogs a Card may be drawn from, and nothing else.
///
/// A2UI 1.0 lets catalogs mix on one surface; the renderer this build has
/// speaks v0.9, where a surface names exactly one catalog. So the two catalogs
/// ADR 0030 compiles in — A2UI's standard eighteen and the Frock family — are
/// registered as one catalog here, under the Frock id, and again under the
/// standard catalog's id so a surface created under either id resolves. The
/// Bot never sees the difference: it writes component names, and every name
/// either catalog declares is in this one.
library;

import 'package:a2ui_core/a2ui_core.dart';
import 'package:a2ui_flutter/a2ui_flutter.dart';
import 'package:a2ui_flutter/v0_9/basic_catalog.dart' as v0_9;

import 'frock_catalog/frock_catalog.dart';

/// The standard catalog plus the Frock families, under [id]. The standard
/// catalog's functions come with it, and its `openUrl` opens through the
/// host's own link handling (`frock_catalog/links.dart`), never directly.
CatalogImplementation _cardCatalog(String id) => v0_9
    .basicCatalog(openUrl: (url) => frockOpenLinkV1(url.toString()))
    .derive(catalogId: id, addComponents: frockCatalogItemsV1);

/// The standard catalog plus the Frock families, as one registered catalog.
final CatalogImplementation cardCatalogV1 = _cardCatalog(frockCatalogIdV1);

/// Every catalog a surface may be created under: [cardCatalogV1], and the same
/// components again under the standard catalog's id.
final List<CatalogImplementation> cardCatalogsV1 = List.unmodifiable([
  cardCatalogV1,
  _cardCatalog(BasicCatalog.v0_9Id),
]);

/// Every component name this build can draw. A surface naming anything else is
/// refused whole rather than drawn with a hole in it.
final Set<String> cardComponentNamesV1 = Set.unmodifiable(
  cardCatalogV1.components.keys,
);
