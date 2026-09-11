import 'package:flutter/material.dart';

import '../client/transport.dart';
import '../shell/semantics.dart';
import '../settings/page.dart';
import '../view/surface.dart';
import 'controller.dart';

/// Connectors: the accounts and services a User authorizes once for every Bot
/// they own — a model provider's key, a hosted grant, a Package's own account.
///
/// The connector half is the Marketplace: every service a Bot can be given,
/// and the accounts already on it. On a phone it is a page and a list; on a
/// desktop the same document is a dialog and a grid of cards
/// ([MarketplaceDialog]), and nothing about the document, its identifiers or
/// its actions changes between the two.
///
/// It is a host over `ViewDocumentView`, not a renderer of its own: the server
/// projects the `ConnectionsFrame` it already produces as a `ViewDocument`, so
/// the widgets, the budgets and the retained command envelope here are the
/// ones every plugin-described view gets. Authorizing and revoking happen in
/// the app; the browser is opened only for a provider whose door is a web
/// flow, and only after the destination has been checked.
class ConnectionsPage extends StatelessWidget {
  final NativeApi api;
  final LocalStore store;
  final String userId;
  final bool models;
  final String? packageId;
  final Future<bool> Function(Uri)? openBrowser;

  /// Whether the providers are a grid of cards rather than a list: the
  /// Marketplace as a desktop draws it.
  final bool grid;

  /// Set where the page is drawn inside a dialog, which has no back gesture:
  /// the way out is then a control the page draws.
  final VoidCallback? onClose;

  const ConnectionsPage({
    super.key,
    required this.api,
    required this.store,
    required this.userId,
    this.openBrowser,
    this.models = false,
    this.packageId,
    this.grid = false,
    this.onClose,
  });

  /// What the connector half is called wherever it is drawn.
  static const marketplaceTitle = 'Marketplace';

  @override
  Widget build(BuildContext context) => ViewSurfacePage(
    title: models ? 'Provider accounts' : marketplaceTitle,
    banner: models
        ? null
        : (context) => ListTile(
            leading: const Icon(Icons.message_outlined),
            title: const Text('Messages on your Mac'),
            subtitle: const Text(
              'Allow access to Messages through a connected Mac',
            ),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => SettingsPage(
                  api: api,
                  store: store,
                  userId: userId,
                  section: 'package.machine-messages',
                  title: 'Messages on your Mac',
                ),
              ),
            ),
          ),
    store: store,
    userId: userId,
    documentId: ConnectorIds.document,
    refreshId: ConnectorIds.refresh,
    gridGroups: grid,
    maxWidth: grid ? marketplaceDialogWidth : 680,
    onClose: onClose,
    controller: ConnectionsController(
      api,
      userId,
      openBrowser: openBrowser,
      models: models,
      packageId: packageId,
    ),
  );
}

/// How wide the Marketplace dialog gets, which is room for three cards.
const marketplaceDialogWidth = 960.0;

/// The Marketplace as a desktop draws it: a dialog over the shell, holding the
/// same document a phone pushes as a page, laid out as a grid of cards.
///
/// A dialog rather than a page because on a desktop the list of Bots and the
/// conversation stay where they are; connecting a service is a visit, not a
/// departure. The way out is the close control in its bar, or the scrim.
class MarketplaceDialog extends StatelessWidget {
  final NativeApi api;
  final LocalStore store;
  final String userId;
  final Future<bool> Function(Uri)? openBrowser;

  const MarketplaceDialog({
    super.key,
    required this.api,
    required this.store,
    required this.userId,
    this.openBrowser,
  });

  @override
  Widget build(BuildContext context) => Dialog(
    insetPadding: const EdgeInsets.all(24),
    clipBehavior: Clip.antiAlias,
    child: identified(
      ConnectorIds.marketplaceDialog,
      ConstrainedBox(
        constraints: const BoxConstraints(
          maxWidth: marketplaceDialogWidth + 40,
          maxHeight: 760,
        ),
        child: ConnectionsPage(
          api: api,
          store: store,
          userId: userId,
          openBrowser: openBrowser,
          grid: true,
          onClose: () => Navigator.of(context).pop(),
        ),
      ),
    ),
  );
}
