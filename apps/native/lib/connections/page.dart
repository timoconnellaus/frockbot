import 'package:flutter/material.dart';

import '../client/transport.dart';
import '../shell/semantics.dart';
import '../settings/page.dart';
import '../view/surface.dart';
import 'controller.dart';

/// Connectors: the accounts and services a User authorizes once for every Bot
/// they own — a model provider's key, a hosted grant, a Package's own account.
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

  const ConnectionsPage({
    super.key,
    required this.api,
    required this.store,
    required this.userId,
    this.openBrowser,
    this.models = false,
    this.packageId,
  });

  @override
  Widget build(BuildContext context) => ViewSurfacePage(
    title: models ? 'Provider accounts' : 'Connected apps',
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
    controller: ConnectionsController(
      api,
      userId,
      openBrowser: openBrowser,
      models: models,
      packageId: packageId,
    ),
  );
}
