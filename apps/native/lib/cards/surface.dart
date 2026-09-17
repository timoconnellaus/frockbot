/// What a Card record has to pass before the renderer sees it, and what the
/// renderer is handed once it has.
///
/// **Admission.** The budgets here mirror `A2UI_LIMITS_V1` in
/// `core/contracts/a2ui.ts`, which is the seam that already refused anything
/// past them on the way in. They are checked again because a client draws
/// whatever a route hands it, and a record past a budget, naming a component
/// this build does not have, or carrying a `refusal` is drawn as the host's
/// own unavailable region — never as half a card. That is the same bargain
/// `ViewDocumentView` makes with a plugin's document next door.
///
/// One count is deliberately wider here than at the seam. `a2uiActionCountV1`
/// counts a component whose `action` carries a `name`, which is A2UI 1.0's
/// spelling; the renderer this build has speaks v0.9, where the name is
/// nested under `action.event`. Both are counted, because the budget's
/// question — how many things one surface may ask the kernel to do — is about
/// the presses the renderer will actually raise.
///
/// **Translation.** The record is the *folded* surface: its component set, its
/// data model, its revision. `genui` 0.10.3 on `a2ui_core` 0.1.1 speaks v0.9,
/// where `createSurface` carries neither components nor a data model — it sets
/// up the surface and nothing else — and where the surface's properties are
/// spelled `theme` and the envelope's version is literally `v0.9`. So one
/// record becomes three messages: create the surface under its catalog, put
/// the whole component set on it, write the whole data model at the root. That
/// is the only translation the client does, and when the renderer catches up
/// to 1.0 it is the only thing that changes.
library;

import 'dart:convert';

import 'catalog.dart';
import 'client.dart';
import 'json.dart';
import 'frock_catalog/schemas.dart';

/// The bounds, from `A2UI_LIMITS_V1`. The module comment says why they are
/// checked twice and where the one deliberate difference is.
const maxCardComponentsV1 = 128;
const maxCardActionsV1 = 32;
const maxCardDataModelBytesV1 = 16000;
const maxCardRecordBytesV1 = 131072;
const maxCardComponentIdV1 = 128;
const maxCardComponentNameV1 = 128;

/// The version the renderer writes and reads. The record is 1.0.
const a2uiRendererVersionV09 = 'v0.9';

/// Why a card is not drawn, in the host's words.
class CardRefusal implements Exception {
  final String message;
  const CardRefusal(this.message);
  @override
  String toString() => message;
}

/// Refuses a record the renderer must not be handed. Returns nothing; the
/// refusal is the exception, so a caller that gets past it has a drawable
/// surface.
void admitCardV1(CardView card) {
  if (card.refusal != null) throw CardRefusal(card.refusal!);
  if (card.deleted) {
    throw const CardRefusal('This card was withdrawn.');
  }
  if (utf8.encode(jsonEncode(_recordJson(card))).length >
      maxCardRecordBytesV1) {
    throw const CardRefusal('This card is larger than the app draws.');
  }
  if (card.components.length > maxCardComponentsV1) {
    throw const CardRefusal('This card has more parts than the app draws.');
  }
  if (utf8.encode(jsonEncode(card.dataModel)).length >
      maxCardDataModelBytesV1) {
    throw const CardRefusal('This card carries more data than the app draws.');
  }
  final ids = <String>{};
  var actions = 0;
  for (final component in card.components) {
    final id = component['id'];
    final name = component['component'];
    if (id is! String ||
        id.isEmpty ||
        id.length > maxCardComponentIdV1 ||
        !ids.add(id)) {
      throw const CardRefusal('This card names a part twice, or not at all.');
    }
    if (name is! String ||
        name.isEmpty ||
        name.length > maxCardComponentNameV1) {
      throw const CardRefusal('This card has a part with no component name.');
    }
    if (!cardComponentNamesV1.contains(name)) {
      throw CardRefusal(
        'This card needs a “$name”, which this app can’t draw.',
      );
    }
    if (_raisesAction(component['action'])) actions++;
    // "Images load over https only" is the ADR's, and it is asked of every
    // link a component carries, at whatever depth: the standard catalog's
    // Image, Video and AudioPlayer take a `url`, and the Frock families take
    // an `imageUrl`, a `href`, and lists of rows that each carry one. A
    // literal link is checked here; a link bound to the data model resolves
    // after this and is left to the deployment's own content policy, which is
    // where a fetch is stopped.
    if (_carriesInsecureUrl(component)) {
      throw const CardRefusal('This card loads media over an insecure link.');
    }
  }
  if (actions > maxCardActionsV1) {
    throw const CardRefusal(
      'This card asks for more actions than the app allows.',
    );
  }
  if (!ids.contains('root')) {
    throw const CardRefusal('This card has no root part.');
  }
}

/// Whether any literal link anywhere in one component is not `https://`.
///
/// A property is a link by its name — `url`, or anything ending in `Url` or
/// `Uri`, which is how both catalogs spell one — and the walk goes through
/// lists and maps because a gallery's images and a table's rows carry theirs
/// inside. A non-string value is a binding or a number and is not a link this
/// side can read.
bool _carriesInsecureUrl(Object? node) {
  if (node is List) return node.any(_carriesInsecureUrl);
  if (node is! Map) return false;
  for (final entry in node.entries) {
    final key = entry.key;
    final value = entry.value;
    final named =
        key is String &&
        (key == 'url' || key.endsWith('Url') || key.endsWith('Uri'));
    if (named && value is String && !value.startsWith('https://')) return true;
    if (_carriesInsecureUrl(value)) return true;
  }
  return false;
}

/// Whether one component's `action` property raises a named action, in either
/// spelling. See the module comment.
bool _raisesAction(Object? action) {
  if (action is! Map) return false;
  if (action['name'] is String) return true;
  final event = action['event'];
  return event is Map && event['name'] is String;
}

Map<String, Object?> _recordJson(CardView card) => {
  'components': card.components,
  'dataModel': card.dataModel,
  if (card.surfaceProperties != null)
    'surfaceProperties': card.surfaceProperties,
};

/// The record as the messages that rebuild it, in the version the renderer
/// speaks. Admit the card first: this assumes a drawable one.
///
/// [dataModel] replaces the record's own, which is how a rebuild keeps what a
/// person had half-typed or half-ticked: the caller hands back the model the
/// old renderer held, having established that the durable one has not moved
/// (`chat_card.dart`).
List<Map<String, Object?>> cardMessagesV1(
  CardView card, {
  Map<String, Object?>? dataModel,
}) {
  // A surface created under a catalog this build does not register would draw
  // nothing, so the record's own id is honoured only when it is one of ours;
  // anything else is the Frock catalog, which is every component either
  // catalog declares.
  final catalogId =
      card.catalogId != null && cardCatalogV1.matchesId(card.catalogId!)
      ? card.catalogId!
      : frockCatalogIdV1;
  return [
    {
      'version': a2uiRendererVersionV09,
      'createSurface': {
        'surfaceId': card.surfaceId,
        'catalogId': catalogId,
        'sendDataModel': card.sendDataModel,
        if (card.surfaceProperties != null) 'theme': card.surfaceProperties,
      },
    },
    {
      'version': a2uiRendererVersionV09,
      'updateComponents': {
        'surfaceId': card.surfaceId,
        'components': card.components,
      },
    },
    {
      'version': a2uiRendererVersionV09,
      // The renderer writes what a person types straight into the data model
      // it was handed, so it is handed a copy: the record is what was read and
      // has to keep saying so.
      'updateDataModel': {
        'surfaceId': card.surfaceId,
        'value': copyJsonV1(dataModel ?? card.dataModel),
      },
    },
  ];
}
