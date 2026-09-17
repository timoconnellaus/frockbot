/// The Frock catalog's component schemas — the one place they are written.
///
/// A2UI's security model is that a catalog is JSON Schema only and its
/// implementation is host code (ADR 0030). So two things have to agree about
/// every Frock component: the Dart that draws it, and the JSON the model is
/// taught to write. They agree here and nowhere else: the files under
/// `schemas/` are the source of truth, the widget files build each
/// `CatalogItem` from them, and `scripts/generate-frock-catalog.ts` wraps them
/// in the A2UI catalog definition and writes
/// `core/protocol-schemas/schema/frock-catalog.json`, which the `typecheck`
/// gate refuses to let go stale.
///
/// The schemas are JSON in raw strings rather than Dart map literals, for one
/// reason: the generator has to read them without a Dart toolchain — the
/// `typecheck` gate runs under bun, where Flutter is not installed — and a
/// string it lifts and hands to `JSON.parse` cannot be read two ways. A Dart
/// literal would need a Dart parser in the script, and a parser is a second
/// opinion about what the source says. The Dart pays one `jsonDecode` per
/// family.
///
/// One family is one file under `schemas/`, beside the widgets that draw it.
/// The generator reads that directory in filename order and merges what it
/// finds; the list below is in the same order for the same reason, so the two
/// can never disagree about which component a name belongs to.
///
/// Each entry is the component's own properties, as `CatalogItem.dataSchema`
/// wants them: no `component` discriminator and no `id`, which A2UI's common
/// types already carry. A value a settled card changes is declared a
/// `DynamicString`, so the Bot may bind it to the data model by pointer
/// rather than resend the layout.
library;

import 'dart:convert';

import 'schemas/core.dart';
import 'schemas/data.dart';
import 'schemas/structure.dart';

/// The catalog the Frock components are named under. Reverse-domain and
/// versioned, as A2UI asks; it is also the id a Card's record carries, and the
/// alias list in `frock_catalog.dart` is what lets a surface created under the
/// standard catalog's id still find these components.
const frockCatalogIdV1 = 'https://frockbot.com/a2ui/catalogs/frock/v1.json';

/// The A2UI common types every catalog's components are defined against.
const a2uiCommonTypesIdV1 =
    'https://a2ui.org/specification/v0_9/common_types.json';

/// Every family's schemas, in the filename order the generator reads them in.
const List<String> frockCatalogSchemaFamiliesV1 = [
  frockCoreSchemasJsonV1,
  frockDataSchemasJsonV1,
  frockStructureSchemasJsonV1,
];

/// The schemas, decoded once, by component name. A name declared by two
/// families is a mistake the generator refuses as well; it is caught here too,
/// because the Dart would otherwise quietly draw whichever one came last.
final Map<String, Map<String, Object?>> frockCatalogSchemasV1 = () {
  final all = <String, Map<String, Object?>>{};
  for (final family in frockCatalogSchemaFamiliesV1) {
    (jsonDecode(family) as Map<String, Object?>).forEach((name, schema) {
      if (all.containsKey(name)) {
        throw StateError('two Frock families declare "$name"');
      }
      all[name] = (schema! as Map).cast<String, Object?>();
    });
  }
  return Map<String, Map<String, Object?>>.unmodifiable(all);
}();
