import 'package:flutter/material.dart';

import '../client/transport.dart';
import '../shell/semantics.dart';
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
  final Future<bool> Function(Uri)? openBrowser;

  const ConnectionsPage({
    super.key,
    required this.api,
    required this.store,
    required this.userId,
    this.openBrowser,
  });

  @override
  Widget build(BuildContext context) => ViewSurfacePage(
    title: 'Connectors',
    store: store,
    userId: userId,
    documentId: ConnectorIds.document,
    refreshId: ConnectorIds.refresh,
    controller: ConnectionsController(api, userId, openBrowser: openBrowser),
  );
}
