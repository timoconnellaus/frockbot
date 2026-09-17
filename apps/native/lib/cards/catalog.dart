/// The catalogs a Card may be drawn from, and nothing else.
///
/// A2UI 1.0 lets catalogs mix on one surface; the renderer this build has
/// speaks v0.9, where a surface names exactly one catalog. So the two catalogs
/// ADR 0030 compiles in — A2UI's standard eighteen and the Frock family — are
/// registered as one catalog here, under the Frock id, with the standard
/// catalog's id as an alias so a surface created under either id resolves. The
/// Bot never sees the difference: it writes component names, and every name
/// either catalog declares is in this one.
library;

import 'package:genui/genui.dart';

import 'frock_catalog/frock_catalog.dart';

/// The standard catalog plus the Frock families, as one registered catalog.
final Catalog cardCatalogV1 = BasicCatalogItems.asCatalog().copyWith(
  newItems: [
    for (final item in BasicCatalogItems.asCatalog().items)
      if (item.name == 'Text') frockFlexibleV1(item),
    ...frockCatalogItemsV1,
  ],
  catalogId: frockCatalogIdV1,
  catalogIdAliases: [basicCatalogId],
);

/// Every component name this build can draw. A surface naming anything else is
/// refused whole rather than drawn with a hole in it.
final Set<String> cardComponentNamesV1 = Set.unmodifiable({
  for (final item in cardCatalogV1.items) item.name,
});
