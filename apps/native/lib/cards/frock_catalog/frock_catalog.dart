/// The Frock catalog: FrockBot's own A2UI components, drawn by the host.
///
/// One family is one file here, beside the file under `schemas/` that declares
/// its schemas. Each component is a `CatalogItem` whose `dataSchema` comes
/// from that declaration — the schema is never written twice — and whose
/// widget is ordinary app code in the app's theme. That is the whole of the
/// protocol's security model on this side: a Card names a component and binds
/// values to it, and what appears on the screen is code this build compiled
/// in.
///
/// The catalog is larger than the standard eighteen on purpose (ADR 0030): a
/// Bot composing a card out of `Row`s and `Text`s spends components on layout
/// the app already knows how to do, and drifts from the rest of the product
/// the first time it guesses a padding. A family here is a thing chat cards
/// really show — a frame, a table, a body of prose, an attachment, a control
/// that takes an answer — and the Skill has a reference per family so a Turn
/// pays only for the vocabulary it uses.
///
/// `ApprovalActions` is the one with a rule of its own. The buttons are the
/// host's, the labels are the only thing a card may choose, and the action
/// names are minted from the `approvalId` the kernel issued — a Plugin may
/// compose the component into a card, and may never restyle it or name its own
/// action. Trust chrome is a component only the host draws.
library;

import 'package:genui/genui.dart';

import 'core.dart';
import 'data.dart';
import 'input.dart';
import 'media.dart';
import 'rich_text.dart';
import 'structure.dart';

export 'common.dart';
export 'core.dart';
export 'data.dart';
export 'input.dart';
export 'links.dart';
export 'media.dart';
export 'rich_text.dart';
export 'schemas.dart';
export 'structure.dart';
export 'tone.dart';

/// One component, declared to take a share of the flex it is in.
///
/// The rule lives here for every component this build registers, Frock or
/// standard: `catalog.dart` re-registers the standard `Text` through it too,
/// so a sentence beside a pill in a `Row` wraps rather than pushing the pill
/// off the edge of the card.
///
/// `genui`'s `Row` and `Column` wrap a child in a `Flexible` only when the
/// model wrote a `weight` on it or the component declares itself implicitly
/// flexible; a child they do not wrap is laid out at unbounded width. A Frock
/// component is not a `Text`: it has an `Expanded`, a stretched `Column` or a
/// scroller inside it, and unbounded width is not a layout it survives. Put
/// `ImageGallery` beside something in a `Row` — a composition the Skill
/// invites — and the card would fail to draw at all.
///
/// So every one of them is flexible, here rather than 24 times. The fit
/// `genui` gives an implicit weight is `FlexFit.loose`, which is what makes
/// this safe in both axes: a `Row` hands the child a width it may use and a
/// `Column` still lets it be exactly as tall as it wants to be.
CatalogItem frockFlexibleV1(CatalogItem item) => CatalogItem(
  name: item.name,
  dataSchema: item.dataSchema,
  widgetBuilder: item.widgetBuilder,
  exampleData: item.exampleData,
  isImplicitlyFlexible: true,
);

/// Every Frock component this build draws, family by family.
final List<CatalogItem> frockCatalogItemsV1 = List.unmodifiable([
  for (final item in [
    ...frockCoreItemsV1,
    ...frockDataItemsV1,
    ...frockInputItemsV1,
    ...frockMediaItemsV1,
    ...frockRichTextItemsV1,
    ...frockStructureItemsV1,
  ])
    frockFlexibleV1(item),
]);
