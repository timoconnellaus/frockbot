/// A Card in the transcript: the A2UI renderer, with the host around it.
///
/// The card owns its own read and its own renderer, the way an Applet card
/// owns its viewer. It reads the surface over REST when it mounts, re-reads it
/// when the Bot's durable state is invalidated — a `shell:card:` record
/// changing is one of the notices the state channel carries — and stays alive
/// in the transcript, because a card is a live surface and not a picture of
/// one. A later send naming the same surface updates the record, and this card
/// redraws in place; the transcript never grows a second one (the dedupe lives
/// in `transcript_model.dart`, where the thread's order is decided).
///
/// Three things are the host's and never the card's.
///
///  * **What is drawn.** `admitCardV1` refuses a record past a budget, naming
///    a component this build has not compiled in, or carrying a refusal, and
///    the host draws its own unavailable region — never half a card. The same
///    region answers a renderer that reports a validation error against the
///    catalog's schema, which is the case a budget cannot catch.
///  * **What a press means.** A press becomes one POST against the surface and
///    the revision it was drawn at. The kernel decides whether that is an
///    approval, a Plugin handler or the Bot's next input; the card is frozen
///    until the receipt lands, so two taps cannot mint two commands against
///    one revision, and the command id is minted once per press so a retry is
///    the same press.
///  * **What a stale answer costs.** A 409 means the surface moved under the
///    person. It is not a failure: the card re-reads and redraws, and says so.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:genui/genui.dart';
import 'package:a2ui_core/a2ui_core.dart' as core;

import '../client/transport.dart';
import '../theme/frock_theme.dart';
import '../view/embed.dart';
import 'catalog.dart';
import 'client.dart';
import 'press.dart';
import 'surface.dart';

/// The transport, the Bot whose transcript the cards are in, and the signal
/// that the Bot's durable state has moved. A card is read as that Bot.
class CardChatScope extends InheritedWidget {
  final NativeApi api;
  final String botId;

  /// Bumped once per state-channel notice, after the refresh it caused landed.
  /// Null in a context with no live Bot session — a test, or a preview — where
  /// the card is simply read once.
  final Listenable? invalidations;
  const CardChatScope({
    super.key,
    required this.api,
    required this.botId,
    this.invalidations,
    required super.child,
  });

  @override
  bool updateShouldNotify(CardChatScope old) =>
      api != old.api ||
      botId != old.botId ||
      invalidations != old.invalidations;
}

class CardChatCard extends StatefulWidget {
  final String surfaceId;
  const CardChatCard({super.key, required this.surfaceId});

  @override
  State<CardChatCard> createState() => _CardChatCardState();
}

class _CardChatCardState extends State<CardChatCard>
    with AutomaticKeepAliveClientMixin {
  CardsApi? api;
  String? botId;
  Listenable? invalidations;
  SurfaceController? controller;
  StreamSubscription<ChatMessage>? interactions;
  CardView? card;

  /// Why the card is not drawn, when it is not.
  String? refusal;

  /// What went wrong that a retry might mend — a read that could not reach the
  /// backend, or a press the kernel refused.
  String? failure;

  /// The press in flight. One at a time.
  CardPress? pending;

  /// The command id of a press that never got its answer, kept with the press
  /// it belongs to until that press is proven to have landed — a receipt for
  /// this very command id, or a read showing the surface has moved — so
  /// making that same press again is the same command and not a second one.
  /// A re-read that shows the same revision proves nothing and keeps it: an
  /// input-routed press never moves the revision, so dropping the id there
  /// would let one press reach the Bot twice. The press is kept whole, because
  /// only an identical press may reuse the id: the kernel drops a repeated
  /// command id without reading it, so reusing one for a press carrying
  /// different values would lose that press in silence.
  String? retryCommandId;
  CardPress? retryPress;
  int? retryRevision;
  int epoch = 0;

  @override
  bool get wantKeepAlive => true;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final scope = context.dependOnInheritedWidgetOfExactType<CardChatScope>();
    if (scope != null &&
        (api?.api != scope.api ||
            botId != scope.botId ||
            invalidations != scope.invalidations)) {
      invalidations?.removeListener(_invalidated);
      api = CardsApi(scope.api);
      botId = scope.botId;
      invalidations = scope.invalidations;
      invalidations?.addListener(_invalidated);
      unawaited(load());
    }
  }

  @override
  void didUpdateWidget(CardChatCard old) {
    super.didUpdateWidget(old);
    if (old.surfaceId != widget.surfaceId) unawaited(load());
  }

  /// A notice says something of this Bot's durable state moved, never which
  /// record. A card that is answering a press is left alone: its receipt
  /// carries the surface back, and re-reading under it would redraw twice.
  void _invalidated() {
    if (pending == null) unawaited(load());
  }

  Future<void> load() async {
    final client = api;
    final bot = botId;
    if (client == null || bot == null) return;
    final read = ++epoch;
    try {
      final answer = await client.read(bot, widget.surfaceId);
      if (!mounted || read != epoch) return;
      adopt(answer);
    } catch (error) {
      if (!mounted || read != epoch) return;
      // A read that could not be made says nothing about the card, so a card
      // already drawn keeps its frame and its interaction; only a card with
      // nothing on screen becomes the failure.
      setState(() {
        failure = error is RequestFailure
            ? error.message
            : 'This card couldn’t be read.';
      });
    }
  }

  /// Takes a record on: admitted, translated, and fed to a renderer of its
  /// own. The record is the whole of the surface's state, so a fresh
  /// controller per read is a redraw and never a loss.
  void adopt(CardView answer) {
    final previous = controller;
    final previousInteractions = interactions;
    SurfaceController? next;
    String? said;
    try {
      admitCardV1(answer);
      next = SurfaceController(catalogs: [cardCatalogV1]);
      for (final message in cardMessagesV1(answer)) {
        next.handleMessage(core.A2uiMessage.fromJson(message));
      }
    } on CardRefusal catch (refused) {
      said = refused.message;
    } catch (_) {
      // Anything the renderer would not take is the same answer as a budget:
      // the host says it cannot draw this, rather than drawing part of it.
      said = 'This card can’t be drawn by this app.';
    }
    unawaited(previousInteractions?.cancel());
    interactions = next?.onSubmit.listen(_interaction);
    if (retryCommandId != null && answer.revision != retryRevision) {
      retryCommandId = null;
      retryPress = null;
      retryRevision = null;
    }
    setState(() {
      card = answer;
      refusal = said;
      failure = null;
      controller = next;
    });
    previous?.dispose();
  }

  /// What the renderer sends back: a press, or its own refusal to draw.
  void _interaction(ChatMessage message) {
    for (final part in message.parts.uiInteractionParts) {
      final Object? decoded;
      try {
        decoded = decodeBoundedJson(part.interaction, maxBytes: 64000);
      } catch (_) {
        continue;
      }
      if (decoded is! Map) continue;
      final action = decoded['action'];
      if (action is Map && action['name'] is String) {
        unawaited(
          press(
            CardPress(
              name: action['name']! as String,
              componentId: action['sourceComponentId'] as String?,
              context: (action['context'] as Map?)?.cast<String, Object?>(),
            ),
          ),
        );
        continue;
      }
      final error = decoded['error'];
      if (error is Map && mounted) {
        setState(() => refusal = 'This card can’t be drawn by this app.');
      }
    }
  }

  /// One press, to the kernel, against the revision it was drawn at.
  Future<void> press(CardPress action) async {
    final client = api;
    final bot = botId;
    final drawn = card;
    if (client == null || bot == null || drawn == null || pending != null) {
      return;
    }
    final commandId = retryPress == action
        ? retryCommandId ?? randomId()
        : randomId();
    setState(() {
      pending = action;
      failure = null;
    });
    try {
      final receipt = await client.act(
        bot,
        surfaceId: drawn.surfaceId,
        revision: drawn.revision,
        name: action.name,
        context: action.context,
        dataModel: drawn.sendDataModel ? drawn.dataModel : null,
        commandId: commandId,
      );
      if (!mounted) return;
      pending = null;
      if (retryCommandId == commandId) {
        retryCommandId = null;
        retryPress = null;
        retryRevision = null;
      }
      adopt(receipt.card);
      if (receipt.failure != null) {
        setState(() => failure = receipt.failure);
      }
    } catch (error) {
      if (!mounted) return;
      setState(() => pending = null);
      // A surface that moved under the person is not a fault: the card they
      // answered is gone, so it is read again and redrawn, and the words say
      // what happened rather than blaming the press.
      if (error is RequestFailure && error.status == 409) {
        retryCommandId = null;
        retryPress = null;
        retryRevision = null;
        // Read first, then say so: adopting a record clears whatever the last
        // press said about itself, and this is the one line that has to
        // survive the redraw it caused.
        await load();
        if (mounted && failure == null) {
          setState(() => failure = 'This card changed. It has been refreshed.');
        }
        return;
      }
      // The POST may have been delivered and only its answer lost, so the id
      // is kept against this control: pressing it again repeats the command
      // the kernel may already hold rather than minting a second one.
      retryCommandId = commandId;
      retryPress = action;
      retryRevision = drawn.revision;
      setState(() {
        failure = error is RequestFailure
            ? error.message
            : 'That couldn’t be sent.';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    final theme = Theme.of(context);
    // No scope is no transport: the card is being drawn somewhere with no Bot
    // to read it as — a preview, or a thread rebuilt outside a session — and
    // the host says so rather than spinning on a read that will never be made.
    final said = api == null ? 'Cards are unavailable here.' : refusal;
    if (said != null) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: ViewRegion(
          label: 'This card can’t be shown',
          detail: said,
          icon: Icons.block_outlined,
          aspectRatio: 2.4,
        ),
      );
    }
    final live = controller;
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 4),
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerHighest,
        border: Border.all(color: FrockTheme.hairline(theme.colorScheme)),
        borderRadius: BorderRadius.circular(FrockTheme.radiusCard),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          if (live == null)
            const SizedBox(
              height: 72,
              child: Center(child: CircularProgressIndicator()),
            )
          else
            CardPressScope(
              pending: pending,
              // A card answering a press is held still: a genui control the
              // host does not draw itself cannot be disabled one button at a
              // time, and a second press against a revision the first one is
              // about to move would be refused anyway.
              child: AbsorbPointer(
                absorbing: pending != null,
                child: AnimatedOpacity(
                  opacity: pending == null ? 1 : 0.6,
                  duration: FrockTheme.motion(context, FrockTheme.fast),
                  child: Surface(
                    surfaceContext: live.contextFor(widget.surfaceId),
                  ),
                ),
              ),
            ),
          if (failure != null)
            Padding(
              padding: const EdgeInsets.only(top: 10),
              child: Semantics(
                liveRegion: true,
                child: Text(
                  failure!,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.error,
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }

  @override
  void dispose() {
    epoch++;
    invalidations?.removeListener(_invalidated);
    unawaited(interactions?.cancel());
    controller?.dispose();
    super.dispose();
  }
}
