/// One user-facing send, drawn in the thread on the Bot's side.
///
/// Two payloads are drawn here now: `text` and a Card.
/// A card is an A2UI surface, drawn by the renderer in `../cards/` from the
/// two catalogs this build compiled in. The surface is durable and read over
/// REST, so the card in the thread is the surface as it stands; a later send
/// naming the same `surfaceId` updates it in place rather than adding a second
/// one (ADR 0030).
///
/// The other five — `approval`, `widget`, `attachment`, `secret-request` and
/// `agent-card` — used to have a widget each in this file. They are Cards now
/// (ADR 0030 step 7), drawn by five locked seeded Plugins from the Frock
/// catalog, and this client draws nothing for them: the send is still on the
/// Turn's log, because that log is where an Approval record is minted and
/// where a notification finds its words, but its *face* is the Card the seam
/// drew beside it. Drawing both is the duplicate step 5 reported.
///
/// So they render as nothing at all rather than as "this client cannot
/// display that message": there is a card in the thread saying it, and one
/// send must not be two bubbles. A deployment that cannot run a Plugin at all
/// draws no card, and the seam records a plain line beside the send instead —
/// which arrives here as `text`.
///
/// Anything this client cannot draw — a payload shape newer than this build,
/// or one the decoder refused — becomes a plain line saying so. A Turn's
/// history has to render on a client older than the Bot that produced it.
library;

import 'package:flutter/material.dart';

import '../cards/chat_card.dart';
import 'markdown.dart';
import 'transcript_model.dart';

/// The payload types a locked first-party Plugin draws as a Card, so this
/// client draws nothing for them. Named rather than defaulted, so a payload
/// this build has genuinely never heard of still says so.
const drawnAsCardsV1 = {
  'approval',
  'widget',
  'attachment',
  'secret-request',
  'agent-card',
};

/// Whether this send has no face of its own: a locked Plugin's Card beside it
/// is what the person reads. The transcript asks before it builds a bubble, so
/// a send drawn as a Card leaves no empty one behind it.
bool sendDrawnAsCardV1(SendPayloadLine send) {
  final type = send.payload?['type'];
  return type is String && drawnAsCardsV1.contains(type);
}

/// Draws one send.
class SendPayloadView extends StatelessWidget {
  final SendPayloadLine send;
  final void Function(String url)? onOpenLink;
  const SendPayloadView({super.key, required this.send, this.onOpenLink});

  @override
  Widget build(BuildContext context) {
    final payload = send.payload;
    if (payload == null) return const _Unsupported();
    final type = payload['type'];
    if (type is String && drawnAsCardsV1.contains(type)) {
      return const SizedBox.shrink();
    }
    switch (type) {
      case 'text':
        return ShellMarkdown(
          text: '${payload['text'] ?? ''}',
          onOpenLink: onOpenLink,
        );
      case 'card':
        final surfaceId = payload['surfaceId'];
        if (surfaceId is! String || surfaceId.isEmpty) {
          return const _Unsupported();
        }
        return CardChatCard(key: ValueKey(surfaceId), surfaceId: surfaceId);
      default:
        return const _Unsupported();
    }
  }
}

class _Unsupported extends StatelessWidget {
  const _Unsupported();

  @override
  Widget build(BuildContext context) => Text(
    'This client cannot display that message.',
    style: Theme.of(context).textTheme.bodySmall?.copyWith(
      color: Theme.of(context).colorScheme.onSurfaceVariant,
      fontStyle: FontStyle.italic,
    ),
  );
}
