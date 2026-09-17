/// The client half of the Card routes (ADR 0030).
///
/// A Card is durable state, not a stream: the Bot Durable Object folds the
/// A2UI messages a send carried into one record, and this reads that record.
/// So a client that reconnects, or a transcript scrolled back to a month ago,
/// draws the surface as it stands rather than replaying what built it.
///
/// Two things a client does with a Card: read one by id, and post one press.
/// The backend also lists a Bot's surfaces; nothing in the app needs that yet,
/// so it is not decoded here. Nothing here decides what a press means — the
/// kernel routes it — and nothing here folds; the receipt carries the card
/// back.
library;

import '../client/transport.dart';
import 'json.dart';

String _bot(String botId) => Uri.encodeComponent(botId);
String _surface(String surfaceId) => Uri.encodeComponent(surfaceId);

/// One Card as the backend reports it: `CardViewV1` in `app/shell/cards.ts`.
///
/// Decoded by hand and exactly, like the Applet views next door: this is a
/// view the shell owns rather than a wire shape the native protocol declares,
/// and an unexpected answer is a `FormatException` rather than half a card.
class CardView {
  final String surfaceId;
  final int revision;

  /// The adjacency list, in the order the components were first seen.
  final List<Map<String, Object?>> components;
  final Map<String, Object?> dataModel;
  final String createdAt;
  final String updatedAt;
  final String? catalogId;

  /// Whether a press carries the data model back with it.
  final bool sendDataModel;

  /// The surface's own properties, under 1.0's name. v0.9's `theme`.
  final Map<String, Object?>? surfaceProperties;

  /// Set by `deleteSurface`: the record stays, the surface is gone.
  final bool deleted;

  /// Why the last fold changed nothing — a budget, or a Session with no slot
  /// left. A card carrying one is never drawn: the host says so instead.
  final String? refusal;

  /// The record exactly as it arrived. Kept so that two records can be asked
  /// whether they are the same record without that question having to be
  /// re-answered every time the shell grows a field — a field this decoder has
  /// no use for can still be the reason a card must be redrawn.
  final Map<String, Object?> source;
  const CardView({
    required this.surfaceId,
    required this.revision,
    required this.components,
    required this.dataModel,
    required this.createdAt,
    required this.updatedAt,
    this.catalogId,
    this.sendDataModel = false,
    this.surfaceProperties,
    this.deleted = false,
    this.refusal,
    this.source = const {},
  });

  /// Whether this is the same record. Not the same revision: the shell writes
  /// a refusal onto a record without folding it, so a card that has stopped
  /// updating comes back at the revision already drawn.
  @override
  bool operator ==(Object other) =>
      other is CardView && sameJsonV1(other.source, source);

  @override
  int get hashCode => Object.hash(surfaceId, revision);

  factory CardView.fromJson(Object? value) {
    if (value is! Map) throw const FormatException('Invalid card');
    final json = value.cast<String, Object?>();
    if (json['schemaVersion'] != 1) {
      throw const FormatException('Unsupported card schemaVersion');
    }
    final revision = json['revision'];
    if (revision is! int || revision < 0) {
      throw const FormatException('Invalid card revision');
    }
    return CardView(
      surfaceId: json['surfaceId']! as String,
      revision: revision,
      components: [
        for (final component in (json['components']! as List))
          if (component is Map)
            component.cast<String, Object?>()
          else
            throw const FormatException('Invalid card component'),
      ],
      dataModel: (json['dataModel']! as Map).cast<String, Object?>(),
      createdAt: json['createdAt']! as String,
      updatedAt: json['updatedAt']! as String,
      catalogId: json['catalogId'] as String?,
      sendDataModel: json['sendDataModel'] == true,
      surfaceProperties: (json['surfaceProperties'] as Map?)
          ?.cast<String, Object?>(),
      deleted: json['deleted'] == true,
      refusal: json['refusal'] as String?,
      source: json,
    );
  }
}

/// What the action route answered: what the kernel did with the press, the
/// card as it stands after it, and why a Plugin handler changed nothing.
class CardActionReceipt {
  final String routed;
  final CardView card;
  final String? failure;
  const CardActionReceipt({
    required this.routed,
    required this.card,
    this.failure,
  });

  factory CardActionReceipt.fromJson(Object? value) {
    if (value is! Map) throw const FormatException('Invalid card receipt');
    final json = value.cast<String, Object?>();
    if (json['schemaVersion'] != 1) {
      throw const FormatException('Unsupported receipt schemaVersion');
    }
    return CardActionReceipt(
      routed: json['routed']! as String,
      card: CardView.fromJson(json['card']),
      failure: json['failure'] as String?,
    );
  }
}

class CardsApi {
  final NativeApi api;
  const CardsApi(this.api);

  Future<CardView> read(String botId, String surfaceId) async {
    final answer = await api.request(
      '/api/bots/${_bot(botId)}/cards/${_surface(surfaceId)}',
    );
    return CardView.fromJson(answer);
  }

  /// One press. The `commandId` is the client's own id for it: a retry that
  /// keeps it is the same press, so a disconnect between the POST and its
  /// answer cannot record a decision twice.
  Future<CardActionReceipt> act(
    String botId, {
    required String surfaceId,
    required int revision,
    required String name,
    Map<String, Object?>? context,
    Map<String, Object?>? dataModel,
    required String commandId,
  }) async {
    final answer = await api.request(
      '/api/bots/${_bot(botId)}/cards',
      body: {
        'schemaVersion': 1,
        'surfaceId': surfaceId,
        'revision': revision,
        'event': {'name': name, 'context': ?context},
        'dataModel': ?dataModel,
        'commandId': commandId,
      },
    );
    return CardActionReceipt.fromJson(answer);
  }
}
