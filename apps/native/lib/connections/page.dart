import 'dart:async';

import 'package:flutter/material.dart';

import '../client/transport.dart';
import '../protocol/client_wire.generated.dart' as wire;
import '../settings/page.dart';
import '../shell/desktop_layout.dart';
import '../shell/semantics.dart';
import '../theme/caret.dart';
import '../theme/frock_theme.dart';
import '../theme/states.dart';
import 'document.dart';
import 'door.dart';
import 'icon_tile.dart';

/// Which half of the Marketplace is showing.
enum MarketplaceSection { catalog, installed }

/// Connectors: the accounts and services a User authorizes once for every Bot
/// they own — a model provider's key, a hosted grant, a Package's own account.
///
/// One page for every kind of connector, drawn by the host over the
/// `ConnectionsFrame` the server produces: a card per provider with its icon,
/// what connecting it gives a Bot, the accounts held against it and the one
/// way to add another. Authorizing and revoking happen in the app; the
/// browser is opened only for a provider whose door is a web flow, and only
/// after the destination has been checked.
///
/// The requests a press becomes are the ones in `document.dart`, so the
/// contract a command is sent under has one home whatever draws the page.
class ConnectionsPage extends StatefulWidget {
  final NativeApi api;
  final LocalStore store;
  final String userId;
  final bool models;
  final String? packageId;
  final Future<bool> Function(Uri)? openBrowser;
  final VoidCallback? onFeaturesChanged;

  /// Whether the cards are laid out three across: the Marketplace as a desktop
  /// dialog draws it. A phone is always one column, a tablet two.
  final bool grid;

  /// Set where the page is drawn inside a dialog, which has no back gesture:
  /// the way out is then a control the page draws.
  final VoidCallback? onClose;

  /// Off when Marketplace owns the title and the search chrome.
  final bool chrome;

  /// The Marketplace storefront: every model and connector, including ones
  /// nobody has added yet, read a page at a time as the person scrolls.
  /// Manage provider stays on the installed-only read.
  final bool catalog;

  /// Marketplace search, matched by the server against name and description.
  final String query;

  /// Marketplace kind checkboxes. Ignored when [catalog] is off.
  final bool showModels;
  final bool showConnectors;

  /// Installed half of the Marketplace: added models and connected apps.
  final bool installed;

  const ConnectionsPage({
    super.key,
    required this.api,
    required this.store,
    required this.userId,
    this.openBrowser,
    this.onFeaturesChanged,
    this.models = false,
    this.packageId,
    this.grid = false,
    this.onClose,
    this.chrome = true,
    this.catalog = false,
    this.query = '',
    this.showModels = true,
    this.showConnectors = true,
    this.installed = false,
  });

  /// What the connector half is called wherever it is drawn.
  static const marketplaceTitle = 'Marketplace';

  @override
  State<ConnectionsPage> createState() => _ConnectionsPageState();
}

class _ConnectionsPageState extends State<ConnectionsPage>
    with
        WidgetsBindingObserver,
        AutomaticKeepAliveClientMixin<ConnectionsPage> {
  /// Cards in a Marketplace page, as the server counts them.
  static const catalogPage = 50;

  wire.ConnectionsFrame? frame;
  bool loading = false;

  /// The Marketplace rows read so far, every page in order. The server
  /// searches and filters them; the client only draws what it was sent.
  List<Map<String, Object?>> catalogRows = const [];

  /// Where the next Marketplace page starts, while there is one.
  int? nextCursor;

  /// Cards a full read covers: one page, or every card already drawn, so a
  /// read that settles a press keeps the list where it was.
  int window = catalogPage;

  bool loadingMore = false;
  bool moreFailed = false;

  /// Bumped by every full read, so a page asked for before it is dropped.
  int generation = 0;
  Timer? searchDebounce;

  /// The row whose command is in flight, if one is. One command at a time,
  /// but only the row that was pressed shows it: the rest stay as they are,
  /// and a press on them while this one settles simply does nothing.
  String? pendingRow;

  /// The account this client just turned on or off, and which way.
  ///
  /// `connection/set-enabled` is a boolean this client chose and sent, and the
  /// pill and the dot read it straight off the account, so the row says it at
  /// once rather than a round trip later. Nothing else here is the client's to
  /// say: a key has to be checked, a door has to be opened, a disconnection
  /// has a `revoking` state of the authority's own — those wait for the read.
  String? toggledConnection;
  bool toggledOn = false;

  String? loadFailure;
  String? notice;
  int commands = 0;

  /// A read asked for while one was already in flight. The answer in flight
  /// was taken before the thing that asked — a return link landing during
  /// the resume read — so it is taken again once that one settles.
  bool reread = false;

  String get title =>
      widget.models ? 'Provider accounts' : ConnectionsPage.marketplaceTitle;
  String get kind => widget.models ? 'model' : 'connector';

  @override
  bool get wantKeepAlive => true;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    connectReturns.addListener(_returned);
    unawaited(load());
  }

  @override
  void dispose() {
    searchDebounce?.cancel();
    connectReturns.removeListener(_returned);
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  /// A new search, kind box or half is a new list from its first page. The
  /// search waits for typing to pause; a box or a half is read at once, and
  /// its old rows go, since they would be drawn as the wrong half.
  @override
  void didUpdateWidget(ConnectionsPage old) {
    super.didUpdateWidget(old);
    if (!widget.catalog) return;
    if (old.showModels != widget.showModels ||
        old.showConnectors != widget.showConnectors ||
        old.installed != widget.installed) {
      catalogRows = const [];
      nextCursor = null;
      window = catalogPage;
      unawaited(load());
    } else if (old.query != widget.query) {
      window = catalogPage;
      searchDebounce?.cancel();
      searchDebounce = Timer(
        const Duration(milliseconds: 300),
        () => unawaited(load()),
      );
    }
  }

  /// A person comes back from the app's own sign-in: the read settles what
  /// they did there.
  @override
  void didChangeAppLifecycleState(AppLifecycleState phase) {
    if (phase == AppLifecycleState.resumed) unawaited(load());
  }

  /// The hosted door closed straight into the app, on its verified link or
  /// its own scheme: the same read, without waiting on the window to resume.
  void _returned() => unawaited(load());

  /// The Marketplace read for the current search, boxes and half, starting
  /// at [cursor]. The ordinary read carries no query.
  String _path({int cursor = 0, int limit = catalogPage}) {
    if (!widget.catalog) return '/api/settings/connections';
    final query = widget.query.trim();
    final kinds = [
      if (widget.showModels) 'model',
      if (widget.showConnectors) 'connector',
    ];
    return Uri(
      path: '/api/settings/connections',
      queryParameters: {
        'catalog': '1',
        if (query.isNotEmpty)
          'q': query.length > 100 ? query.substring(0, 100) : query,
        if (kinds.length < 2) 'kinds': kinds.join(','),
        if (widget.installed) 'installed': '1',
        if (cursor > 0) 'cursor': '$cursor',
        if (limit != catalogPage) 'limit': '$limit',
      },
    ).toString();
  }

  Future<void> load() async {
    searchDebounce?.cancel();
    if (loading) {
      reread = true;
      return;
    }
    generation++;
    setState(() {
      loading = true;
      loadingMore = false;
      moreFailed = false;
      loadFailure = null;
    });
    try {
      do {
        reread = false;
        try {
          final next = wire.ConnectionsFrame.fromJson(
            await widget.api.request(_path(limit: window)),
          );
          if (!mounted) return;
          // Something asked for a newer read while this one was out: this
          // answer is already stale, so the next one is drawn instead.
          if (reread) continue;
          setState(() {
            frame = next;
            catalogRows = next.providers;
            nextCursor = next.nextCursor;
            loadFailure = null;
          });
        } catch (_) {
          if (!mounted) return;
          const message =
              'Couldn’t load your connectors. Check your connection and try again.';
          setState(() => loadFailure = message);
        }
      } while (reread);
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  String _commandId() =>
      'cx-${DateTime.now().microsecondsSinceEpoch}-${commands++}';

  /// One press, one request, one read back. What the command did is what the
  /// frame says afterwards, so the frame is read again whether it applied or
  /// refused. `row` is the row that was pressed, the one that shows the wait.
  Future<void> _send(Map<String, Object?> command, String row) async {
    if (pendingRow != null) return;
    final input = ((command['input'] as Map?) ?? const {})
        .cast<String, Object?>();
    setState(() {
      pendingRow = row;
      notice = null;
      if (input['kind'] == 'set-enabled') {
        toggledConnection = input['connectionId'] as String?;
        toggledOn = input['enabled'] == true;
      }
    });
    try {
      if (connectionActionKindV1(command) == 'authorize') {
        await _authorize(command);
      } else {
        final request = connectionRequestV1(command);
        await widget.api.request(request.path, body: request.body);
      }
    } on FormatException catch (error) {
      if (mounted) {
        setState(() {
          notice = error.message;
          toggledConnection = null;
        });
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          notice =
              'That didn’t go through. Check your connection and try again.';
          toggledConnection = null;
        });
      }
    } finally {
      if (mounted) setState(() => pendingRow = null);
      await load();
      // The read is the authority on what the command did, so what this client
      // drew for itself stops being drawn the moment that read lands.
      if (mounted) setState(() => toggledConnection = null);
    }
  }

  /// Starts a hosted grant and sends the person to it in the system browser.
  Future<void> _authorize(Map<String, Object?> command) => openConnectionDoorV1(
    widget.api,
    command,
    openBrowser: widget.openBrowser,
  );

  /// The next Marketplace page, once the list is scrolled to its end.
  Future<void> _more() async {
    final cursor = nextCursor;
    if (cursor == null || loading || loadingMore || moreFailed) return;
    final ticket = generation;
    setState(() => loadingMore = true);
    try {
      final next = wire.ConnectionsFrame.fromJson(
        await widget.api.request(_path(cursor: cursor)),
      );
      if (!mounted || ticket != generation) return;
      setState(() {
        frame = next;
        catalogRows = [...catalogRows, ...next.providers];
        nextCursor = next.nextCursor;
        window = cards.length;
        loadingMore = false;
      });
    } catch (_) {
      if (!mounted || ticket != generation) return;
      setState(() {
        loadingMore = false;
        moreFailed = true;
      });
    }
  }

  void _retryMore() {
    setState(() => moreFailed = false);
    unawaited(_more());
  }

  List<Map<String, Object?>> get providers {
    // The Marketplace is searched and filtered where it is read.
    if (widget.catalog) return catalogRows;
    return (frame?.providers ?? const [])
        .where(
          (provider) =>
              provider['kind'] == kind &&
              (widget.packageId == null ||
                  provider['packageId'] == widget.packageId),
        )
        .toList();
  }

  /// A model is added when its Package is, whatever keys it still holds; a
  /// connected app is added when an account is connected.
  bool _isInstalled(Map<String, Object?> provider) =>
      provider['kind'] == 'model'
      ? provider['installed'] == true
      : ((provider['connected'] as num?)?.toInt() ?? 0) > 0;

  bool _needsAdd(Map<String, Object?> provider) =>
      widget.catalog &&
      !widget.installed &&
      provider['kind'] == 'model' &&
      provider['installed'] != true;

  /// Adds a model provider to the account, and says whether it landed: a key
  /// is what the person is asked for next, and only an added provider takes
  /// one.
  Future<bool> _addProvider(Map<String, Object?> provider) async {
    final packageId = provider['packageId'] as String;
    final row = _rowKey(provider);
    if (pendingRow != null) return false;
    setState(() {
      pendingRow = row;
      notice = null;
    });
    var added = false;
    try {
      final receipt = await widget.api.request(
        '/api/settings',
        body: {
          'schemaVersion': 1,
          'commandId': _commandId(),
          'expectedRevision': frame!.revision,
          'type': 'user/choose-model-provider',
          'packageId': packageId,
        },
      );
      added = receipt is Map && receipt['status'] == 'applied';
      if (added) {
        widget.onFeaturesChanged?.call();
      } else if (mounted) {
        setState(() {
          notice = receipt is Map && receipt['failure'] is String
              ? receipt['failure'] as String
              : 'Couldn’t add ${provider['displayName']}. Refresh and try again.';
        });
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          notice =
              'That didn’t go through. Check your connection and try again.';
        });
      }
    } finally {
      if (mounted) setState(() => pendingRow = null);
      await load();
    }
    return added;
  }

  /// Where a connected model provider leads: the account's model choice, which
  /// is the step after the key and the one the Marketplace cannot take itself.
  void _chooseModel() => Navigator.of(context).push(
    MaterialPageRoute<void>(
      builder: (_) => SettingsPage(
        onFeaturesChanged: widget.onFeaturesChanged,
        api: widget.api,
        store: widget.store,
        userId: widget.userId,
        home: 'models',
      ),
    ),
  );

  Future<void> _removeProvider(Map<String, Object?> provider) async {
    final packageId = provider['packageId'] as String;
    final name = provider['displayName'] as String;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('Remove $name?'),
        content: const Text(
          'Bots using this model go back to Frock AI. You can add it again from the catalog.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Remove'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    final row = _rowKey(provider);
    if (pendingRow != null) return;
    setState(() {
      pendingRow = row;
      notice = null;
    });
    try {
      await widget.api.request(
        '/api/settings',
        body: {
          'schemaVersion': 1,
          'commandId': _commandId(),
          'expectedRevision': frame!.revision,
          'type': 'user/uninstall-package',
          'packageId': packageId,
        },
      );
      widget.onFeaturesChanged?.call();
    } catch (_) {
      if (mounted) {
        setState(() {
          notice =
              'That didn’t go through. Check your connection and try again.';
        });
      }
    } finally {
      if (mounted) setState(() => pendingRow = null);
      await load();
    }
  }

  /// The card a row is drawn on. A model provider is one card however many
  /// ways it connects — a key, a sign-in — and a connector app is one card of
  /// its own, so a model row is keyed by its Package alone.
  String _rowKey(Map<String, Object?> provider) => provider['kind'] == 'model'
      ? '${provider['packageId']}'
      : '${provider['packageId']}/${provider['connectionTypeId']}';

  /// The listed rows as cards, in the order the first of each was listed.
  List<List<Map<String, Object?>>> get cards {
    final grouped = <String, List<Map<String, Object?>>>{};
    for (final row in providers) {
      (grouped[_rowKey(row)] ??= []).add(row);
    }
    return grouped.values.toList();
  }

  List<Map<String, Object?>> accountsOf(Map<String, Object?> provider) {
    final packageId = provider['packageId'] as String;
    final connectionTypeId = provider['connectionTypeId'] as String;
    return (frame?.accounts ?? const [])
        .where(
          (account) =>
              account['packageId'] as String == packageId &&
              account['connectionTypeId'] as String == connectionTypeId,
        )
        .map(
          (account) => account['id'] == toggledConnection
              ? {...account, 'state': toggledOn ? 'ready' : 'disabled'}
              : account,
        )
        .toList();
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    final theme = Theme.of(context);
    final frame = this.frame;
    final banner = notice ?? loadFailure;
    final Widget body;
    if (frame == null) {
      body = loading || loadFailure == null
          ? FrockLoading(label: 'Loading ${title.toLowerCase()}')
          : FrockEmptyState(
              icon: Icons.cloud_off_rounded,
              title: '$title couldn’t load',
              detail: loadFailure!,
              action: 'Try again',
              onAction: load,
            );
    } else {
      final rows = cards;
      body = RefreshIndicator(
        onRefresh: load,
        child: widget.catalog && !widget.installed
            ? _catalogScroll(theme, frame, rows, banner)
            : _installedScroll(theme, frame, rows, banner),
      );
    }
    final content = identified(
      ConnectorIds.document,
      SafeArea(top: false, child: body),
    );
    if (!widget.chrome) return content;
    return Scaffold(
      appBar: DesktopHeader(
        child: AppBar(
          title: Text(title),
          automaticallyImplyLeading: widget.onClose == null,
          leading: widget.onClose == null
              ? null
              : identified(
                  ShellIds.rightPanelClose,
                  IconButton(
                    tooltip: 'Close ${title.toLowerCase()}',
                    onPressed: widget.onClose,
                    icon: const Icon(Icons.close),
                  ),
                ),
          actions: [
            identified(
              ConnectorIds.refresh,
              IconButton(
                tooltip: 'Refresh ${title.toLowerCase()}',
                onPressed: loading ? null : load,
                icon: const Icon(Icons.refresh_rounded),
              ),
            ),
          ],
        ),
      ),
      body: content,
    );
  }

  Widget _banners(
    ThemeData theme,
    wire.ConnectionsFrame frame,
    String? banner,
  ) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (loading)
          const Padding(
            padding: EdgeInsets.only(bottom: 12),
            child: LinearProgressIndicator(minHeight: 2),
          ),
        if (banner case final String line)
          _Notice(
            line: line,
            onDismiss: () => setState(() {
              notice = null;
              loadFailure = null;
            }),
          ),
        if (widget.models && frame.modelInUse != null)
          _Centered(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(4, 4, 4, 12),
              child: Text(
                'Model in use: ${frame.modelInUse}',
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ),
          ),
      ],
    );
  }

  Widget _providerCard(List<Map<String, Object?>> ways, int index) {
    final provider = ways.first;
    // The semantics identifier is the provider's name. A filter that swaps
    // the card in this slot has to build a new element: Flutter keeps the
    // previous identifier on a reused one, so the visible Ollama card was
    // still `view-group-amazon-bedrock`.
    return _ProviderRow(
      key: ValueKey(_rowKey(provider)),
      index: index,
      provider: provider,
      ways: ways,
      accounts: [for (final way in ways) ...accountsOf(way)],
      models: widget.catalog || widget.models,
      catalog: widget.catalog,
      busy: pendingRow == _rowKey(provider),
      send: (command) => _send(command, _rowKey(provider)),
      commandId: _commandId,
      onAdd: _needsAdd(provider) ? () => _addProvider(provider) : null,
      onChooseModel:
          widget.catalog &&
              provider['kind'] == 'model' &&
              _isInstalled(provider)
          ? _chooseModel
          : null,
      onRemove:
          widget.installed &&
              provider['kind'] == 'model' &&
              _isInstalled(provider)
          ? () => _removeProvider(provider)
          : null,
    );
  }

  Widget _moreRow() => _MoreRow(
    failed: moreFailed,
    onShown: () => unawaited(_more()),
    onRetry: _retryMore,
  );

  Widget _installedScroll(
    ThemeData theme,
    wire.ConnectionsFrame frame,
    List<List<Map<String, Object?>>> rows,
    String? banner,
  ) {
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
      children: [
        _banners(theme, frame, banner),
        _Centered(
          maxWidth: widget.grid ? marketplaceDialogWidth : 680,
          child: LayoutBuilder(
            builder: (context, constraints) {
              final columns = widget.grid && constraints.maxWidth >= 900
                  ? 3
                  : constraints.maxWidth >= 640
                  ? 2
                  : 1;
              const gap = 8.0;
              final width =
                  (constraints.maxWidth - gap * (columns - 1)) / columns;
              return Wrap(
                spacing: gap,
                runSpacing: gap,
                children: [
                  if (!widget.installed &&
                      !widget.models &&
                      widget.packageId == null)
                    SizedBox(
                      width: width,
                      child: _MacMessagesRow(page: widget),
                    ),
                  for (final (index, provider) in rows.indexed)
                    SizedBox(
                      width: width,
                      child: _providerCard(provider, index),
                    ),
                ],
              );
            },
          ),
        ),
        if (nextCursor != null && widget.catalog) _moreRow(),
        if (rows.isEmpty && !loading)
          _Centered(
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Text(
                widget.installed
                    ? 'Nothing installed yet. Add a model or connect an app in Catalog.'
                    : widget.models
                    ? 'No model providers are turned on. Add one in the Marketplace.'
                    : 'Nothing to connect yet.',
                style: theme.textTheme.bodyMedium,
              ),
            ),
          ),
      ],
    );
  }

  Widget _catalogScroll(
    ThemeData theme,
    wire.ConnectionsFrame frame,
    List<List<Map<String, Object?>>> rows,
    String? banner,
  ) {
    final showMac =
        widget.showConnectors &&
        !widget.installed &&
        widget.packageId == null &&
        widget.query.trim().isEmpty;
    return LayoutBuilder(
      builder: (context, viewport) {
        final maxWidth = widget.grid ? marketplaceDialogWidth : 680.0;
        final columns = widget.grid && viewport.maxWidth >= 932
            ? 3
            : viewport.maxWidth >= 672
            ? 2
            : 1;
        const gap = 8.0;
        final extras = showMac ? 1 : 0;
        final count = rows.length + extras;
        final lines = (count / columns).ceil();
        return CustomScrollView(
          physics: const AlwaysScrollableScrollPhysics(),
          slivers: [
            SliverPadding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
              sliver: SliverToBoxAdapter(
                child: _Centered(
                  maxWidth: maxWidth,
                  child: _banners(theme, frame, banner),
                ),
              ),
            ),
            if (count == 0)
              SliverFillRemaining(
                hasScrollBody: false,
                // A new half or kind is read with its old rows gone, and is
                // not empty until the read says so.
                child: loading
                    ? const SizedBox.shrink()
                    : _Centered(
                        child: Padding(
                          padding: const EdgeInsets.all(24),
                          child: Text(
                            widget.query.trim().isEmpty
                                ? 'Nothing matches this filter.'
                                : 'No matches. Try a different name.',
                            style: theme.textTheme.bodyMedium,
                          ),
                        ),
                      ),
              )
            else
              SliverPadding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
                sliver: SliverLayoutBuilder(
                  builder: (context, constraints) {
                    final width = constraints.crossAxisExtent > maxWidth
                        ? maxWidth
                        : constraints.crossAxisExtent;
                    return SliverPadding(
                      padding: EdgeInsets.symmetric(
                        horizontal: ((constraints.crossAxisExtent - width) / 2)
                            .clamp(0, double.infinity),
                      ),
                      // Rows of cards rather than a fixed-height grid: a card
                      // opens in place to take a key or show its accounts,
                      // and a grid cell would clip what it opened to.
                      sliver: SliverList.builder(
                        itemCount: lines + (nextCursor == null ? 0 : 1),
                        itemBuilder: (context, row) {
                          if (row == lines) return _moreRow();
                          Widget card(int index) => showMac && index == 0
                              ? _MacMessagesRow(page: widget)
                              : _providerCard(
                                  rows[index - extras],
                                  index - extras,
                                );
                          final first = row * columns;
                          return Padding(
                            padding: const EdgeInsets.only(bottom: gap),
                            child: Row(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                for (
                                  var column = 0;
                                  column < columns;
                                  column++
                                ) ...[
                                  if (column > 0) const SizedBox(width: gap),
                                  Expanded(
                                    child: first + column < count
                                        ? card(first + column)
                                        : const SizedBox.shrink(),
                                  ),
                                ],
                              ],
                            ),
                          );
                        },
                      ),
                    );
                  },
                ),
              ),
          ],
        );
      },
    );
  }
}

class _Centered extends StatelessWidget {
  final Widget child;
  final double maxWidth;
  const _Centered({required this.child, this.maxWidth = 680});
  @override
  Widget build(BuildContext context) => Center(
    child: ConstrainedBox(
      constraints: BoxConstraints(maxWidth: maxWidth),
      child: child,
    ),
  );
}

class _Notice extends StatelessWidget {
  final String line;
  final VoidCallback onDismiss;
  const _Notice({required this.line, required this.onDismiss});
  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return _Centered(
      child: Card(
        margin: const EdgeInsets.only(bottom: 12),
        color: scheme.errorContainer.withValues(alpha: 0.24),
        child: ListTile(
          leading: Icon(Icons.error_outline, color: scheme.error),
          title: Text(line),
          trailing: IconButton(
            tooltip: 'Dismiss',
            onPressed: onDismiss,
            icon: const Icon(Icons.close),
          ),
        ),
      ),
    );
  }
}

/// One compact row: a mark, a name, one line on what it is, and at the end
/// the state or the way in. Everything else — the accounts, the form — is
/// below the row once it is opened.
class _Row extends StatelessWidget {
  final Widget mark;
  final String title;
  final String? subtitle;
  final Widget? trailing;
  final VoidCallback? onTap;
  final Widget? below;
  final bool open;
  const _Row({
    required this.mark,
    required this.title,
    this.subtitle,
    this.trailing,
    this.onTap,
    this.below,
    this.open = false,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      margin: EdgeInsets.zero,
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          InkWell(
            onTap: onTap,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 10, 10, 10),
              child: LayoutBuilder(
                builder: (context, constraints) => Row(
                  children: [
                    mark,
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Semantics(
                            header: true,
                            child: Text(
                              title,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: theme.textTheme.titleSmall,
                            ),
                          ),
                          if (subtitle case final String line)
                            Text(
                              line,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: theme.textTheme.bodySmall?.copyWith(
                                color: theme.colorScheme.onSurfaceVariant,
                              ),
                            ),
                        ],
                      ),
                    ),
                    if (trailing != null) ...[
                      const SizedBox(width: 10),
                      // The pill takes what it needs and never more than
                      // half the row, so the name keeps its width and a large
                      // text size never pushes past the edge.
                      ConstrainedBox(
                        constraints: BoxConstraints(
                          maxWidth: constraints.maxWidth * 0.5,
                        ),
                        child: trailing!,
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ),
          if (open && below != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
              child: below,
            ),
        ],
      ),
    );
  }
}

/// The end of what the Marketplace has read so far. The next page is asked
/// for as this comes into view; a page that failed waits for a press.
class _MoreRow extends StatelessWidget {
  final bool failed;
  final VoidCallback onShown;
  final VoidCallback onRetry;
  const _MoreRow({
    required this.failed,
    required this.onShown,
    required this.onRetry,
  });

  @override
  Widget build(BuildContext context) {
    if (failed) {
      return Padding(
        padding: const EdgeInsets.all(8),
        child: Center(
          child: TextButton(
            onPressed: onRetry,
            child: const Text('Couldn’t load more. Try again'),
          ),
        ),
      );
    }
    WidgetsBinding.instance.addPostFrameCallback((_) => onShown());
    return const Padding(
      padding: EdgeInsets.all(16),
      child: Center(
        child: SizedBox.square(
          dimension: 24,
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
      ),
    );
  }
}

class _MacMessagesRow extends StatelessWidget {
  final ConnectionsPage page;
  const _MacMessagesRow({required this.page});
  @override
  Widget build(BuildContext context) => _Row(
    mark: const ConnectorIconTile(icon: Icons.message_outlined),
    title: 'Messages on your Mac',
    subtitle: 'Allow access to Messages through a connected Mac',
    trailing: Icon(
      Icons.chevron_right,
      color: Theme.of(context).colorScheme.onSurfaceVariant,
    ),
    onTap: () => Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => SettingsPage(
          onFeaturesChanged: page.onFeaturesChanged,
          api: page.api,
          store: page.store,
          userId: page.userId,
          section: 'package.machine-messages',
          title: 'Messages on your Mac',
        ),
      ),
    ),
  );
}

/// The small pill at the end of a row: the way in when nothing is
/// connected, the state once something is.
///
/// A pressed pill keeps its colour and shows a spinner in place of its label
/// until the command settles: the wait belongs to the row that was pressed,
/// not to the page.
class _Pill extends StatelessWidget {
  final String label;
  final IconData? icon;
  final bool primary;
  final bool busy;
  final VoidCallback? onPressed;
  const _Pill({
    required this.label,
    this.icon,
    this.primary = false,
    this.busy = false,
    this.onPressed,
  });

  /// The pill's height, and so the spinner's, in both states.
  static const height = 30.0;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    // Quiet by default: the row's name is the loud part. Every pill stands on
    // the same faint neutral, and the primary one writes its word in the
    // accent: a column of accent slabs read as a column of alarms, and a wash
    // of the accent reads as mauve.
    final accent = FrockTheme.accentInk(Theme.of(context));
    final style = ButtonStyle(
      visualDensity: VisualDensity.standard,
      shape: WidgetStatePropertyAll(
        RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(FrockTheme.radiusRow),
        ),
      ),
      backgroundColor: WidgetStatePropertyAll(
        scheme.onSurface.withValues(alpha: 0.07),
      ),
      foregroundColor: WidgetStatePropertyAll(
        primary ? accent : scheme.onSurface,
      ),
      overlayColor: WidgetStatePropertyAll(
        scheme.onSurface.withValues(alpha: 0.08),
      ),
      // A fixed height with the label centred on its cap height: the line
      // box the theme's label style carries leaves more room below the
      // letters than above, and the word sat low in the pill.
      padding: const WidgetStatePropertyAll(
        EdgeInsets.symmetric(horizontal: 14),
      ),
      minimumSize: const WidgetStatePropertyAll(Size(0, height)),
      maximumSize: const WidgetStatePropertyAll(Size.fromHeight(height)),
      fixedSize: const WidgetStatePropertyAll(Size.fromHeight(height)),
      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
      textStyle: WidgetStatePropertyAll(
        Theme.of(context).textTheme.labelMedium?.copyWith(
          fontWeight: FontWeight.w600,
          height: 1.0,
          leadingDistribution: TextLeadingDistribution.even,
        ),
      ),
    );
    if (onPressed == null) {
      return Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icon != null) ...[
            Icon(icon, size: 16, color: scheme.onSurfaceVariant),
            const SizedBox(width: 4),
          ],
          Flexible(
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: Theme.of(context).textTheme.labelMedium
                  ?.copyWith(color: scheme.onSurfaceVariant),
            ),
          ),
        ],
      );
    }
    final text = Text(label, maxLines: 1, overflow: TextOverflow.ellipsis);
    // While busy the label stays in the layout, unseen, so the pill keeps
    // its width; the spinner takes the foreground colour the label had.
    final child = busy
        ? Stack(
            alignment: Alignment.center,
            children: [
              Opacity(opacity: 0, child: text),
              Semantics(
                label: 'Connecting',
                child: SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    color: primary ? scheme.primary : scheme.onSurface,
                  ),
                ),
              ),
            ],
          )
        : text;
    // A busy pill is still enabled, so it keeps its colour; the press it
    // would take is the one already in flight.
    final press = busy ? () {} : onPressed;
    return primary
        ? FilledButton(onPressed: press, style: style, child: child)
        : FilledButton.tonal(onPressed: press, style: style, child: child);
  }
}

class _ProviderRow extends StatefulWidget {
  final int index;

  /// The row the card is named and described by: the first of [ways].
  final Map<String, Object?> provider;

  /// Every row this card draws, one per Connection Type: a model provider that
  /// takes a key and a sign-in has two, and everything else has one.
  final List<Map<String, Object?>> ways;
  final List<Map<String, Object?>> accounts;
  final bool models;
  final bool catalog;
  final bool busy;
  final Future<void> Function(Map<String, Object?> command) send;
  final String Function() commandId;

  /// Adds the provider, answering whether it landed; set only while it is not.
  final Future<bool> Function()? onAdd;

  /// Opens the model choice, once a connected account makes one possible.
  final VoidCallback? onChooseModel;
  final VoidCallback? onRemove;
  const _ProviderRow({
    super.key,
    required this.index,
    required this.provider,
    required this.ways,
    required this.accounts,
    required this.models,
    this.catalog = false,
    required this.busy,
    required this.send,
    required this.commandId,
    this.onAdd,
    this.onChooseModel,
    this.onRemove,
  });

  @override
  State<_ProviderRow> createState() => _ProviderRowState();
}

class _ProviderRowState extends State<_ProviderRow> {
  bool open = false;

  /// The Connection Type whose key form is open, if one is.
  String? adding;

  Map<String, Object?> get provider => widget.provider;
  String get displayName => provider['displayName'] as String;

  /// The ways in this card still offers, one per Connection Type.
  List<Map<String, Object?>> get ways =>
      widget.ways.where((way) => way['mayConnect'] == true).toList();
  bool get mayConnect => ways.isNotEmpty;
  bool get hasAccounts => widget.accounts.isNotEmpty;
  int get connected => widget.ways.fold(
    0,
    (sum, way) => sum + ((way['connected'] as num?)?.toInt() ?? 0),
  );

  /// More than one way in, so the card opens on all of them rather than
  /// choosing one for the person.
  bool get choices => ways.length > 1;

  String _authorization(Map<String, Object?> way) =>
      way['authorization'] as String;

  /// A remote MCP server: its own form, whatever its authorization says.
  bool _mcp(Map<String, Object?> way) => way['packageId'] == mcpPackageIdV1;

  Map<String, Object?> _command(
    String kind,
    Map<String, Object?> input,
    Map<String, Object?> way,
  ) => {
    'commandId': widget.commandId(),
    'input': {
      'kind': kind,
      'packageId': way['packageId'],
      'connectionTypeId': way['connectionTypeId'],
      ...input,
    },
  };

  /// One way in, taken: a hosted grant opens the app's sign-in at once, a
  /// keyed provider opens its form, and one that needs nothing is simply
  /// turned on.
  void _take(Map<String, Object?> way) {
    if (_mcp(way)) {
      setState(() {
        open = true;
        adding = way['connectionTypeId'] as String;
      });
      return;
    }
    switch (_authorization(way)) {
      case 'grant':
        unawaited(widget.send(_command('authorize', const {}, way)));
      case 'api-key':
        setState(() {
          open = true;
          adding = way['connectionTypeId'] as String;
        });
      case 'none':
        unawaited(
          widget.send(
            _command('enable-connection', {'label': displayName}, way),
          ),
        );
    }
  }

  /// The way in, when the card is not yet connected: the one there is, or the
  /// card opened on each of them.
  void _begin() {
    if (choices) {
      setState(() => open = true);
    } else if (mayConnect) {
      _take(ways.single);
    }
  }

  /// Adds the provider and opens what comes next: its key form when a key is
  /// the only way in, or the card itself when there is a choice to make. A
  /// sign-in alone waits for its Connect, which is what leaves the app.
  Future<void> _add() async {
    final added = await widget.onAdd!();
    if (!mounted || !added) return;
    if (widget.ways.length > 1) {
      setState(() => open = true);
    } else if (_authorization(widget.ways.single) == 'api-key') {
      setState(() {
        open = true;
        adding = widget.ways.single['connectionTypeId'] as String;
      });
    }
  }

  /// The state of the accounts held, as one pill.
  Widget _state() {
    final ready = widget.accounts.where((a) => a['state'] == 'ready').length;
    final failed = widget.accounts.any(
      (a) => a['state'] == 'failed' || a['state'] == 'reconciliation-required',
    );
    if (failed) {
      return const _Pill(label: 'Needs attention', icon: Icons.error_outline);
    }
    if (widget.accounts.length > 1) {
      return _Pill(
        label: '${widget.accounts.length} accounts',
        icon: ready > 0 ? Icons.check_rounded : Icons.hourglass_top_rounded,
      );
    }
    switch (widget.accounts.single['state']) {
      case 'ready':
        return const _Pill(label: 'Connected', icon: Icons.check_rounded);
      case 'disabled':
        return const _Pill(
          label: 'Turned off',
          icon: Icons.pause_circle_outline,
        );
      case 'revoking':
        return const _Pill(
          label: 'Disconnecting…',
          icon: Icons.hourglass_top_rounded,
        );
      default:
        return const _Pill(
          label: 'Connecting…',
          icon: Icons.hourglass_top_rounded,
        );
    }
  }

  /// Whether the row opens on a tap to show its accounts and the way to add
  /// another; a keyed provider with nothing yet opens straight to its form.
  bool get opens =>
      widget.onAdd == null &&
      (hasAccounts ||
          choices ||
          ways.any((way) => _authorization(way) == 'api-key') ||
          widget.onRemove != null);

  Widget? _trailing(BuildContext context) {
    // A provider that is not added offers Add even while it still holds a key
    // from before it was removed: adding it again is what brings that back.
    if (widget.onAdd != null) {
      return identified(
        ConnectorIds.action('add-${provider['packageId']}'),
        _Pill(
          label: 'Add',
          primary: true,
          busy: widget.busy,
          onPressed: () => unawaited(_add()),
        ),
      );
    }
    if (hasAccounts) {
      // The state, and beside it the sign that the row opens: the accounts
      // and "Add another account" are one tap away, not hidden.
      return Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Flexible(child: _state()),
          const SizedBox(width: 6),
          Icon(
            open ? Icons.expand_less_rounded : Icons.expand_more_rounded,
            size: 20,
            color: Theme.of(context).colorScheme.onSurfaceVariant,
          ),
        ],
      );
    }
    if (!mayConnect && widget.onRemove == null) return null;
    if (!mayConnect) {
      return Icon(
        open ? Icons.expand_less_rounded : Icons.expand_more_rounded,
        size: 20,
        color: Theme.of(context).colorScheme.onSurfaceVariant,
      );
    }
    // A press on a Connect while another row's command is settling does
    // nothing; the page's send refuses it, and this pill stays as it is.
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        _Pill(
          label: 'Connect',
          primary: true,
          busy:
              widget.busy &&
              !choices &&
              _authorization(ways.single) != 'api-key',
          onPressed: _begin,
        ),
        if (widget.onRemove != null) ...[
          const SizedBox(width: 6),
          Icon(
            open ? Icons.expand_less_rounded : Icons.expand_more_rounded,
            size: 20,
            color: Theme.of(context).colorScheme.onSurfaceVariant,
          ),
        ],
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final description = provider['description'] as String?;
    final kindLabel = provider['kind'] == 'model' ? 'Model' : 'Connector';
    final subtitle = widget.catalog
        ? [kindLabel, ?description].join(' · ')
        : description ??
              (connected == 0
                  ? null
                  : connected == 1
                  ? '1 account connected'
                  : '$connected accounts connected');
    return identified(
      ConnectorIds.group(displayName),
      _Row(
        mark: ConnectorIconTile(
          asset: provider['icon'] as String?,
          label: displayName,
          icon: widget.models
              ? Icons.auto_awesome_outlined
              : Icons.link_rounded,
        ),
        title: displayName,
        subtitle: subtitle,
        trailing: _trailing(context),
        onTap: opens ? () => setState(() => open = !open) : null,
        open: open,
        below: _details(context),
      ),
    );
  }

  /// What one way in draws inside the open card. On its own it is the
  /// existing account's "Add another account"; beside another way it is named
  /// for what it is — a key, a sign-in — so the person picks between them.
  List<Widget> _wayIn(Map<String, Object?> way) {
    final id = way['connectionTypeId'] as String;
    Widget press(String action, IconData icon, String label, VoidCallback go) =>
        Align(
          alignment: Alignment.centerLeft,
          child: Padding(
            padding: const EdgeInsets.only(top: 4),
            child: identified(
              ConnectorIds.action(action),
              TextButton.icon(
                onPressed: widget.busy ? null : go,
                icon: Icon(icon, size: 18),
                label: Text(label),
              ),
            ),
          ),
        );
    if (_mcp(way)) {
      if (adding == id) {
        return [
          _McpServerForm(
            index: widget.index,
            busy: widget.busy,
            onCancel: () => setState(() => adding = null),
            onSubmit: (address, name, token) async {
              await widget.send(
                mcpServerActionV1(
                  commandId: widget.commandId(),
                  index: widget.index,
                  connectionTypeId: id,
                  address: address,
                  name: name,
                  token: token,
                ),
              );
              if (mounted) setState(() => adding = null);
            },
          ),
        ];
      }
      if (!hasAccounts && !choices) return const [];
      return [
        press(
          'mcp-add-${widget.index}',
          Icons.add_rounded,
          'Add another server',
          () => setState(() => adding = id),
        ),
      ];
    }
    switch (_authorization(way)) {
      case 'api-key':
        if (adding == id) {
          final connected = (way['connected'] as num?)?.toInt() ?? 0;
          return [
            _ApiKeyForm(
              index: widget.index,
              provider: way,
              submitLabel: connected == 0
                  ? 'Connect account'
                  : 'Add another account',
              busy: widget.busy,
              onCancel: () => setState(() => adding = null),
              onSubmit: (values) async {
                await widget.send(_command('connect-api-key', values, way));
                if (mounted) setState(() => adding = null);
              },
            ),
          ];
        }
        if (!hasAccounts && !choices) return const [];
        return [
          press(
            'api-key-${widget.index}',
            choices ? Icons.key_rounded : Icons.add_rounded,
            choices ? 'Use an API key' : 'Add another account',
            () => setState(() => adding = id),
          ),
        ];
      case 'grant':
        if (!hasAccounts && !choices) return const [];
        return [
          press(
            'authorize-${widget.index}',
            choices ? Icons.login_rounded : Icons.add_rounded,
            choices ? 'Sign in' : 'Add another account',
            () => widget.send(_command('authorize', const {}, way)),
          ),
        ];
      default:
        if (!choices) return const [];
        return [
          press(
            'enable-${widget.index}',
            Icons.power_settings_new_rounded,
            'Turn on',
            () => _take(way),
          ),
        ];
    }
  }

  Widget _details(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final account in widget.accounts)
          _AccountRow(
            account: account,
            models: widget.models,
            busy: widget.busy,
            onCommand: (kind, input) => widget.send({
              'commandId': widget.commandId(),
              'input': {'kind': kind, ...input},
            }),
          ),
        for (final way in ways) ..._wayIn(way),
        if (widget.accounts.isEmpty && adding == null)
          Text(
            'Nothing connected yet.',
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
        if (widget.onChooseModel != null &&
            widget.accounts.any((account) => account['state'] == 'ready'))
          Align(
            alignment: Alignment.centerLeft,
            child: Padding(
              padding: const EdgeInsets.only(top: 4),
              child: identified(
                ConnectorIds.action('choose-model-${provider['packageId']}'),
                FilledButton.tonalIcon(
                  onPressed: widget.onChooseModel,
                  icon: const Icon(Icons.auto_awesome_rounded, size: 18),
                  label: const Text('Choose a model'),
                ),
              ),
            ),
          ),
        if (widget.onRemove != null)
          Align(
            alignment: Alignment.centerLeft,
            child: Padding(
              padding: const EdgeInsets.only(top: 4),
              child: identified(
                ConnectorIds.action('remove-${provider['packageId']}'),
                TextButton(
                  onPressed: widget.busy ? null : widget.onRemove,
                  style: TextButton.styleFrom(
                    foregroundColor: theme.colorScheme.error,
                  ),
                  child: const Text('Remove'),
                ),
              ),
            ),
          ),
      ],
    );
  }
}

class _AccountRow extends StatelessWidget {
  final Map<String, Object?> account;
  final bool models;
  final bool busy;
  final Future<void> Function(String kind, Map<String, Object?> input)
  onCommand;
  const _AccountRow({
    required this.account,
    required this.models,
    required this.busy,
    required this.onCommand,
  });

  Color _dot(ColorScheme scheme) => switch (account['state']) {
    'ready' => FrockTheme.success,
    'disabled' => scheme.onSurfaceVariant,
    'failed' || 'reconciliation-required' => scheme.error,
    _ => FrockTheme.accentSoft,
  };

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final state = account['state'] as String;
    final authorization = account['authorization'] as String;
    final ambient = authorization == 'ambient-native';
    final mcp = account['packageId'] == mcpPackageIdV1;
    final id = account['id'] as String;
    final failure = account['failure'] as String?;
    final items = <PopupMenuEntry<String>>[
      // A server's tools are listed again on the hour; this asks now.
      if (mcp && (state == 'ready' || state == 'disabled'))
        const PopupMenuItem(
          value: 'refresh-models',
          child: Text('Refresh tools'),
        ),
      if (!mcp &&
          models &&
          (authorization == 'api-key' || authorization == 'grant') &&
          state == 'ready')
        const PopupMenuItem(
          value: 'refresh-models',
          child: Text('Refresh models'),
        ),
      if (state == 'ready' || state == 'disabled')
        PopupMenuItem(
          value: 'set-enabled',
          child: Text(state == 'ready' ? 'Turn off' : 'Turn on'),
        ),
      if (state != 'revoking')
        PopupMenuItem(
          value: mcp || authorization == 'api-key' || models
              ? 'disconnect'
              : 'revoke',
          child: Text(
            mcp ? 'Remove' : 'Disconnect',
            style: TextStyle(color: scheme.error),
          ),
        ),
    ];
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 7),
            child: Container(
              width: 10,
              height: 10,
              decoration: BoxDecoration(
                color: _dot(scheme),
                shape: BoxShape.circle,
              ),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  account['label'] as String,
                  style: theme.textTheme.titleSmall,
                ),
                if (account['detail'] case final String detail)
                  Text(
                    detail,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: scheme.onSurfaceVariant,
                    ),
                  ),
                if (ambient)
                  Text(
                    'Included with FrockBot',
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: scheme.onSurfaceVariant,
                    ),
                  ),
                if (failure != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: Text(
                      failure,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: scheme.error,
                      ),
                    ),
                  ),
              ],
            ),
          ),
          if (!ambient && items.isNotEmpty)
            PopupMenuButton<String>(
              tooltip: 'Manage ${account['label']}',
              enabled: !busy,
              icon: const Icon(Icons.more_horiz_rounded),
              onSelected: (kind) => onCommand(kind, {
                'connectionId': id,
                if (kind == 'set-enabled') 'enabled': state != 'ready',
                if (kind == 'revoke') 'packageId': account['packageId'],
              }),
              itemBuilder: (_) => items,
            ),
        ],
      ),
    );
  }
}

/// The connect form for a keyed provider: a name, the key, and whatever the
/// Connection Type declares beside it. The key exists only between a person
/// typing it and the request that carries it; nothing here reads it back.
class _ApiKeyForm extends StatefulWidget {
  final int index;
  final Map<String, Object?> provider;
  final String submitLabel;
  final bool busy;
  final VoidCallback onCancel;
  final Future<void> Function(Map<String, Object?> values) onSubmit;
  const _ApiKeyForm({
    required this.index,
    required this.provider,
    required this.submitLabel,
    required this.busy,
    required this.onCancel,
    required this.onSubmit,
  });

  @override
  State<_ApiKeyForm> createState() => _ApiKeyFormState();
}

class _ApiKeyFormState extends State<_ApiKeyForm> {
  late final TextEditingController name = TextEditingController(
    text: widget.provider['displayName'] as String,
  );
  final key = TextEditingController();
  final settings = <String, TextEditingController>{};
  bool advanced = false;

  List<wire.SettingField> get fields =>
      ((widget.provider['settings'] as List?) ?? const [])
          .map((field) => wire.SettingField.fromJson(field))
          .toList();

  @override
  void dispose() {
    name.dispose();
    key.dispose();
    for (final controller in settings.values) {
      controller.dispose();
    }
    super.dispose();
  }

  Future<void> _submit() async {
    final prefix = 'c${widget.index}';
    final values = <String, Object?>{
      '$prefix.label': name.text,
      '$prefix.key': key.text,
      for (final entry in settings.entries)
        '$prefix.s.${entry.key}': entry.value.text,
    };
    await widget.onSubmit(values);
    // The key is never kept once the request has left.
    if (mounted) key.clear();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final declared = fields;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Divider(height: 24),
        SteadyCaret(
          child: TextField(
            controller: name,
            enabled: !widget.busy,
            decoration: const InputDecoration(
              labelText: 'Account name',
              counterText: '',
            ),
            maxLength: 120,
            textInputAction: TextInputAction.next,
          ),
        ),
        const SizedBox(height: 12),
        SteadyCaret(
          child: TextField(
            controller: key,
            enabled: !widget.busy,
            obscureText: true,
            autocorrect: false,
            enableSuggestions: false,
            decoration: const InputDecoration(labelText: 'API key'),
            textInputAction: TextInputAction.done,
            onSubmitted: (_) => _submit(),
          ),
        ),
        if (declared.isNotEmpty) ...[
          const SizedBox(height: 4),
          InkWell(
            onTap: () => setState(() => advanced = !advanced),
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 8),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      'Advanced — custom server',
                      style: theme.textTheme.titleSmall,
                    ),
                  ),
                  Icon(advanced ? Icons.expand_less : Icons.expand_more),
                ],
              ),
            ),
          ),
          if (advanced)
            for (final field in declared)
              Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: SteadyCaret(
                  child: TextField(
                    controller: settings.putIfAbsent(
                      field.id.value,
                      () => TextEditingController(
                        text: field.value.value is String
                            ? field.value.value as String
                            : '',
                      ),
                    ),
                    enabled: !widget.busy,
                    decoration: InputDecoration(
                      labelText: field.label,
                      helperText: field.hint,
                      helperMaxLines: 4,
                    ),
                  ),
                ),
              ),
        ],
        const SizedBox(height: 8),
        Text(
          'Your API provider may bill you for usage. The key stays on the server and is never shown to your Bots.',
          style: theme.textTheme.bodySmall?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: 12),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            identified(
              ConnectorIds.action('connect-${widget.index}'),
              FilledButton(
                onPressed: widget.busy ? null : _submit,
                child: Text(widget.submitLabel),
              ),
            ),
            TextButton(
              onPressed: widget.busy ? null : widget.onCancel,
              child: const Text('Cancel'),
            ),
          ],
        ),
      ],
    );
  }
}

/// The form that adds a remote MCP server: where it is, what to call it, and
/// a token only when the server asks for one. Like a key, the token exists
/// only between a person typing it and the request that carries it.
class _McpServerForm extends StatefulWidget {
  final int index;
  final bool busy;
  final VoidCallback onCancel;
  final Future<void> Function(Uri address, String name, String token) onSubmit;
  const _McpServerForm({
    required this.index,
    required this.busy,
    required this.onCancel,
    required this.onSubmit,
  });

  @override
  State<_McpServerForm> createState() => _McpServerFormState();
}

class _McpServerFormState extends State<_McpServerForm> {
  final address = TextEditingController();
  final name = TextEditingController();
  final token = TextEditingController();
  String? problem;

  @override
  void dispose() {
    address.dispose();
    name.dispose();
    token.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final checked = mcpServerAddressV1(address.text);
    if (checked.uri == null) {
      setState(() => problem = checked.problem);
      return;
    }
    setState(() => problem = null);
    await widget.onSubmit(checked.uri!, name.text, token.text.trim());
    if (mounted) token.clear();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Divider(height: 24),
        SteadyCaret(
          child: TextField(
            controller: address,
            enabled: !widget.busy,
            keyboardType: TextInputType.url,
            autocorrect: false,
            enableSuggestions: false,
            decoration: InputDecoration(
              labelText: 'Server address',
              hintText: 'https://mcp.example.com/mcp',
              errorText: problem,
              errorMaxLines: 3,
            ),
            // What was wrong with the last address is not said about the next.
            onChanged: (_) {
              if (problem != null) setState(() => problem = null);
            },
            textInputAction: TextInputAction.next,
          ),
        ),
        const SizedBox(height: 12),
        SteadyCaret(
          child: TextField(
            controller: name,
            enabled: !widget.busy,
            decoration: const InputDecoration(
              labelText: 'Name (optional)',
              helperText: 'Leave blank to use the server’s address.',
              counterText: '',
            ),
            maxLength: 120,
            textInputAction: TextInputAction.next,
          ),
        ),
        const SizedBox(height: 12),
        SteadyCaret(
          child: TextField(
            controller: token,
            enabled: !widget.busy,
            obscureText: true,
            autocorrect: false,
            enableSuggestions: false,
            decoration: const InputDecoration(
              labelText: 'Access token (optional)',
              helperText: 'Only if the server asks for one.',
            ),
            textInputAction: TextInputAction.done,
            onSubmitted: (_) => _submit(),
          ),
        ),
        const SizedBox(height: 8),
        Text(
          'Every Bot you own can use this server’s tools. The token stays on the server and is never shown to your Bots.',
          style: theme.textTheme.bodySmall?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: 12),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            identified(
              ConnectorIds.action('mcp-connect-${widget.index}'),
              FilledButton(
                onPressed: widget.busy ? null : _submit,
                child: const Text('Add server'),
              ),
            ),
            TextButton(
              onPressed: widget.busy ? null : widget.onCancel,
              child: const Text('Cancel'),
            ),
          ],
        ),
      ],
    );
  }
}

/// How wide the Marketplace dialog gets, which is room for three cards across.
const marketplaceDialogWidth = 960.0;

/// The Marketplace as a desktop draws it: a dialog over the shell, holding the
/// same page a phone pushes, laid out three cards across.
///
/// A dialog rather than a page because on a desktop the list of Bots and the
/// conversation stay where they are; connecting a service is a visit, not a
/// departure. The way out is the close control in its bar, or the scrim.
class MarketplaceDialog extends StatelessWidget {
  final NativeApi api;
  final LocalStore store;
  final String userId;
  final Future<bool> Function(Uri)? openBrowser;
  final VoidCallback? onFeaturesChanged;

  const MarketplaceDialog({
    super.key,
    required this.api,
    required this.store,
    required this.userId,
    this.openBrowser,
    this.onFeaturesChanged,
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
        child: MarketplacePage(
          onFeaturesChanged: onFeaturesChanged,
          api: api,
          store: store,
          userId: userId,
          openBrowser: openBrowser,
          onClose: () => Navigator.of(context).pop(),
        ),
      ),
    ),
  );
}

/// The account Marketplace: one searchable catalog of models and connectors.
///
/// Add a model here first; then connect a key and choose it in Models.
/// Installed is the same list, limited to what is already added, for
/// configure and remove. Kind checkboxes sit under the search box.
class MarketplacePage extends StatefulWidget {
  final NativeApi api;
  final LocalStore store;
  final String userId;
  final Future<bool> Function(Uri)? openBrowser;
  final VoidCallback? onFeaturesChanged;
  final VoidCallback? onClose;
  final bool initialShowModels;
  final bool initialShowConnectors;

  const MarketplacePage({
    super.key,
    required this.api,
    required this.store,
    required this.userId,
    this.openBrowser,
    this.onFeaturesChanged,
    this.onClose,
    this.initialShowModels = true,
    this.initialShowConnectors = true,
  });

  @override
  State<MarketplacePage> createState() => _MarketplacePageState();
}

class _MarketplacePageState extends State<MarketplacePage> {
  final connectorsKey = GlobalKey<_ConnectionsPageState>();
  late bool showModels = widget.initialShowModels;
  late bool showConnectors = widget.initialShowConnectors;
  MarketplaceSection section = MarketplaceSection.catalog;
  String query = '';
  bool refreshing = false;

  Future<void> _refresh() async {
    if (refreshing) return;
    setState(() => refreshing = true);
    try {
      await connectorsKey.currentState?.load();
    } finally {
      if (mounted) setState(() => refreshing = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: const Text(ConnectionsPage.marketplaceTitle),
      automaticallyImplyLeading: widget.onClose == null,
      leading: widget.onClose == null
          ? null
          : identified(
              ShellIds.rightPanelClose,
              IconButton(
                tooltip: 'Close marketplace',
                onPressed: widget.onClose,
                icon: const Icon(Icons.close),
              ),
            ),
      actions: [
        identified(
          ConnectorIds.marketplaceRefresh,
          IconButton(
            tooltip: 'Refresh marketplace',
            onPressed: refreshing ? null : _refresh,
            icon: const Icon(Icons.refresh_rounded),
          ),
        ),
      ],
      bottom: PreferredSize(
        preferredSize: const Size.fromHeight(160),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              identified(
                ConnectorIds.marketplaceSearch,
                SteadyCaret(
                  child: TextField(
                    decoration: const InputDecoration(
                      prefixIcon: Icon(Icons.search),
                      hintText: 'Find a model or connector',
                    ),
                    onChanged: (value) => setState(() => query = value),
                  ),
                ),
              ),
              const SizedBox(height: 4),
              identified(
                ConnectorIds.marketplaceFilter,
                Wrap(
                  spacing: 8,
                  children: [
                    _KindCheck(
                      id: ConnectorIds.marketplaceFilterModels,
                      label: 'Models',
                      value: showModels,
                      onChanged: (value) => setState(() => showModels = value),
                    ),
                    _KindCheck(
                      id: ConnectorIds.marketplaceFilterConnectors,
                      label: 'Connectors',
                      value: showConnectors,
                      onChanged: (value) =>
                          setState(() => showConnectors = value),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 8),
              Align(
                alignment: AlignmentDirectional.centerStart,
                child: SegmentedButton<MarketplaceSection>(
                  segments: [
                    ButtonSegment(
                      value: MarketplaceSection.catalog,
                      label: identified(
                        ConnectorIds.marketplaceCatalog,
                        const Text('Catalog'),
                      ),
                      tooltip: 'Browse models and connectors',
                    ),
                    ButtonSegment(
                      value: MarketplaceSection.installed,
                      label: identified(
                        ConnectorIds.marketplaceInstalled,
                        const Text('Installed'),
                      ),
                      tooltip: 'Configure or remove what you have added',
                    ),
                  ],
                  selected: {section},
                  onSelectionChanged: (value) =>
                      setState(() => section = value.single),
                  showSelectedIcon: false,
                ),
              ),
            ],
          ),
        ),
      ),
    ),
    body: ConnectionsPage(
      key: connectorsKey,
      api: widget.api,
      store: widget.store,
      userId: widget.userId,
      openBrowser: widget.openBrowser,
      onFeaturesChanged: widget.onFeaturesChanged,
      grid: widget.onClose != null,
      chrome: false,
      catalog: true,
      query: query,
      showModels: showModels,
      showConnectors: showConnectors,
      installed: section == MarketplaceSection.installed,
    ),
  );
}

/// One Marketplace kind checkbox, label included in the tap target.
class _KindCheck extends StatelessWidget {
  final String id;
  final String label;
  final bool value;
  final ValueChanged<bool> onChanged;
  const _KindCheck({
    required this.id,
    required this.label,
    required this.value,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    return identified(
      id,
      InkWell(
        onTap: () => onChanged(!value),
        borderRadius: BorderRadius.circular(8),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Checkbox(
              value: value,
              visualDensity: VisualDensity.compact,
              materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
              onChanged: (next) => onChanged(next == true),
            ),
            Text(label, style: Theme.of(context).textTheme.bodyMedium),
            const SizedBox(width: 4),
          ],
        ),
      ),
    );
  }
}
