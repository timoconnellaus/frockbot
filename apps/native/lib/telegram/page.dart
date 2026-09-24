/// Telegram: talking to a Bot from the deployment's Telegram bot.
///
/// A host over `ViewDocumentView`, like Your computers. The server projects the
/// link (`app/telegram/telegram-document.ts`) and this carries each action to
/// the route that owns it: linking to `/api/telegram/link`, the Bot choice to
/// `/api/telegram/bot`, unlinking to `/api/telegram/unlink`.
///
/// The link itself is the one thing here that is not in the document. It
/// carries a one-time code the server keeps only as a digest, so it exists on
/// the receipt and nowhere else; the host holds it in the banner while the
/// person is looking at it, and a second look means a second link.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import '../client/transport.dart';
import '../machines/page.dart' show pairingWindowV1;
import '../protocol/client_wire.generated.dart' as wire;
import '../shell/semantics.dart';
import '../view/surface.dart';

/// The kinds `TELEGRAM_ACTION_KINDS_V1` declares.
const telegramActionKindsV1 = <String>{
  'telegram-link',
  'telegram-bot',
  'telegram-unlink',
};

/// The field the Bot choice carries.
const telegramBotFieldV1 = 'telegram.bot';

String? telegramActionKindV1(Map<String, Object?> command) {
  final kind = ((command['input'] as Map?)?['kind']) as String?;
  return telegramActionKindsV1.contains(kind) ? kind : null;
}

class TelegramController extends ViewSurfaceController {
  final NativeApi api;
  TelegramController(this.api);

  wire.ViewDocument? _document;
  bool _busy = false;
  bool _closed = false;
  String? _message;

  /// The link the authority just minted: a `t.me` URL carrying a one-time
  /// code, and when it stops working. Held here and never read again.
  Map<String, Object?>? offer;

  @override
  void adoptCachedDocument(wire.ViewDocument cached) {
    if (_closed || _document != null) return;
    if (cached.surfaceId.value != surfaceId) return;
    _document = cached;
    _changed();
  }

  @override
  wire.ViewDocument? get document => _document;
  @override
  bool get busy => _busy;
  @override
  String? get message => _message;
  @override
  String get surfaceId => 'telegram';

  void _changed() {
    if (!_closed) notifyListeners();
  }

  @override
  Future<void> load() async {
    if (_busy) return;
    _busy = true;
    _message = null;
    _changed();
    try {
      final next = wire.ViewDocument.fromJson(
        await api.request('/api/telegram?as=document'),
      );
      if (next.surfaceId.value != surfaceId) {
        throw const FormatException('Telegram surface mismatch');
      }
      _document = next;
      // Linked now — the person pressed Start and came back — so the link
      // they were given has done its one job.
      if (next.actions.any((action) => action['id'] == 'telegram-unlink')) {
        offer = null;
      }
    } on RequestFailure catch (failure) {
      _message = failure.message;
    } catch (_) {
      _message = 'Couldn’t load Telegram. Check your connection and try again.';
    } finally {
      _busy = false;
      _changed();
    }
  }

  @override
  Future<Map<String, Object?>> dispatch(Map<String, Object?> command) async {
    final kind = telegramActionKindV1(command);
    final input = ((command['input'] as Map?) ?? const {})
        .cast<String, Object?>();
    switch (kind) {
      case 'telegram-link':
        offer = ((await api.request(
          '/api/telegram/link',
          body: const <String, Object?>{},
        )) as Map).cast<String, Object?>();
      case 'telegram-bot':
        final botId = input[telegramBotFieldV1] as String?;
        if (botId == null) {
          throw const FormatException('Choose a Bot first.');
        }
        await api.request('/api/telegram/bot', body: {'botId': botId});
      case 'telegram-unlink':
        offer = null;
        await api.request(
          '/api/telegram/unlink',
          body: const <String, Object?>{},
        );
      default:
        throw const FormatException('That action is not a Telegram command.');
    }
    return {'commandId': command['commandId'], 'status': 'applied'};
  }

  void forgetOffer() {
    offer = null;
    _changed();
  }

  @override
  void dispose() {
    _closed = true;
    super.dispose();
  }
}

class TelegramPage extends StatefulWidget {
  final NativeApi api;
  final LocalStore store;
  final String userId;

  /// How the link is opened. The system's own handler for a `t.me` link is
  /// Telegram, wherever it is installed.
  final Future<bool> Function(Uri url)? open;
  const TelegramPage({
    super.key,
    required this.api,
    required this.store,
    required this.userId,
    this.open,
  });

  @override
  State<TelegramPage> createState() => _TelegramPageState();
}

class _TelegramPageState extends State<TelegramPage> {
  late TelegramController controller;

  @override
  void initState() {
    super.initState();
    controller = TelegramController(widget.api);
  }

  @override
  void didUpdateWidget(TelegramPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.api == widget.api) return;
    final previous = controller;
    controller = TelegramController(widget.api);
    previous.dispose();
  }

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ViewSurfacePage(
    title: 'Telegram',
    store: widget.store,
    userId: widget.userId,
    documentId: TelegramIds.document,
    refreshId: TelegramIds.refresh,
    controller: controller,
    banner: (context) => TelegramLinkCard(
      controller: controller,
      open:
          widget.open ??
          (url) => launchUrl(url, mode: LaunchMode.externalApplication),
    ),
    cacheScope: 'account',
  );
}

/// The link, the one time it exists.
class TelegramLinkCard extends StatelessWidget {
  final TelegramController controller;
  final Future<bool> Function(Uri url) open;
  const TelegramLinkCard({
    super.key,
    required this.controller,
    required this.open,
  });

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: controller,
    builder: (context, _) {
      final offer = controller.offer;
      final url = Uri.tryParse(offer?['url'] as String? ?? '');
      if (offer == null ||
          url == null ||
          url.scheme != 'https' ||
          url.host != 't.me') {
        return const SizedBox.shrink();
      }
      final theme = Theme.of(context);
      return identified(
        TelegramIds.offer,
        Card(
          margin: const EdgeInsets.only(bottom: 12),
          color: theme.colorScheme.secondaryContainer,
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Semantics(
                  header: true,
                  child: Text(
                    'Finish in Telegram',
                    style: theme.textTheme.titleSmall,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  'Open the link where you use Telegram and press Start. It works once, and expires ${pairingWindowV1(offer['expiresAt'] as String? ?? '')}.',
                  style: theme.textTheme.bodySmall,
                ),
                const SizedBox(height: 12),
                Wrap(
                  spacing: 12,
                  runSpacing: 8,
                  children: [
                    identified(
                      TelegramIds.open,
                      FilledButton(
                        onPressed: () async {
                          final opened = await open(url)
                              .catchError((_) => false);
                          if (!opened && context.mounted) {
                            ScaffoldMessenger.of(context).showSnackBar(
                              const SnackBar(
                                content: Text(
                                  'Couldn’t open Telegram. Copy the link instead.',
                                ),
                              ),
                            );
                          }
                        },
                        child: const Text('Open Telegram'),
                      ),
                    ),
                    identified(
                      TelegramIds.copy,
                      FilledButton.tonal(
                        onPressed: () async {
                          await Clipboard.setData(
                            ClipboardData(text: url.toString()),
                          );
                          if (context.mounted) {
                            ScaffoldMessenger.of(context).showSnackBar(
                              const SnackBar(content: Text('Link copied.')),
                            );
                          }
                        },
                        child: const Text('Copy link'),
                      ),
                    ),
                    identified(
                      TelegramIds.dismiss,
                      TextButton(
                        onPressed: controller.forgetOffer,
                        child: const Text('Done'),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      );
    },
  );
}
