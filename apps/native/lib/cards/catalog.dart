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

/// One standard component, registered again with a share of the row it is in.
///
/// `genui`'s `Row` gives a child a `Flexible` only when the model wrote a
/// `weight` on it or the component declares itself implicitly flexible, and
/// `Text` declares neither. So a `Row` holding a sentence and a pill lays the
/// sentence out at its natural width and pushes the pill off the edge of the
/// card, which is exactly what step 5's phone screenshot caught. A card is
/// read at 412 logical pixels first, and prose in the Skill can only ask a
/// model to remember; this is the host deciding instead. Text in a row wraps
/// rather than overflows, and every Frock component that could be squeezed
/// declares the same thing.
CatalogItem _flexible(CatalogItem item) => CatalogItem(
  name: item.name,
  dataSchema: item.dataSchema,
  widgetBuilder: item.widgetBuilder,
  exampleData: item.exampleData,
  isImplicitlyFlexible: true,
);

/// The standard catalog plus the Frock families, as one registered catalog.
final Catalog cardCatalogV1 = BasicCatalogItems.asCatalog().copyWith(
  newItems: [
    for (final item in BasicCatalogItems.asCatalog().items)
      if (item.name == 'Text') _flexible(item),
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
