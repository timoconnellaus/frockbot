import 'dart:async';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../client/transport.dart';
import '../protocol/client_wire.generated.dart' as wire;
import '../settings/page.dart';
import '../shell/semantics.dart';
import '../theme/frock_theme.dart';
import '../theme/states.dart';
import 'document.dart';

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
  State<ConnectionsPage> createState() => _ConnectionsPageState();
}

class _ConnectionsPageState extends State<ConnectionsPage>
    with WidgetsBindingObserver {
  wire.ConnectionsFrame? frame;
  bool loading = false;
  bool pending = false;
  String? loadFailure;
  String? notice;
  int commands = 0;

  String get title => widget.models ? 'Provider accounts' : 'Connected apps';
  String get kind => widget.models ? 'model' : 'connector';

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(load());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  /// A person comes back from the app's own sign-in: the read settles what
  /// they did there.
  @override
  void didChangeAppLifecycleState(AppLifecycleState phase) {
    if (phase == AppLifecycleState.resumed) unawaited(load());
  }

  Future<void> load() async {
    if (loading) return;
    setState(() {
      loading = true;
      loadFailure = null;
    });
    try {
      final next = wire.ConnectionsFrame.fromJson(
        await widget.api.request('/api/settings/connections'),
      );
      if (!mounted) return;
      setState(() => frame = next);
    } catch (_) {
      if (!mounted) return;
      const message =
          'Couldn’t load your connectors. Check your connection and try again.';
      setState(() => loadFailure = message);
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  String _commandId() =>
      'cx-${DateTime.now().microsecondsSinceEpoch}-${commands++}';

  /// One press, one request, one read back. What the command did is what the
  /// frame says afterwards, so the frame is read again whether it applied or
  /// refused.
  Future<void> _send(Map<String, Object?> command) async {
    if (pending) return;
    setState(() {
      pending = true;
      notice = null;
    });
    try {
      if (connectionActionKindV1(command) == 'authorize') {
        await _authorize(command);
      } else {
        final request = connectionRequestV1(command);
        await widget.api.request(request.path, body: request.body);
      }
    } on FormatException catch (error) {
      if (mounted) setState(() => notice = error.message);
    } catch (_) {
      if (mounted) {
        setState(
          () => notice =
              'That didn’t go through. Check your connection and try again.',
        );
      }
    } finally {
      if (mounted) setState(() => pending = false);
      await load();
    }
  }

  /// Starts a hosted grant and sends the person to it in the system browser.
  /// The destination is checked before it is opened, so a tampered answer
  /// cannot send them somewhere else wearing our name.
  Future<void> _authorize(Map<String, Object?> command) async {
    final request = startConnectionRequestV1(command);
    final answer =
        ((await widget.api.request(request.path, body: request.body) as Map?) ??
                const {})
            .cast<String, Object?>();
    if (answer['status'] == 'ready') return;
    final url = answer['redirectUrl'];
    if (url is! String) throw const FormatException('No authorization door');
    final uri = Uri.parse(url);
    if (uri.scheme != 'https' || uri.host.isEmpty || uri.userInfo.isNotEmpty) {
      throw const FormatException('Invalid authorization destination');
    }
    final opened =
        await (widget.openBrowser?.call(uri) ??
            launchUrl(uri, mode: LaunchMode.externalApplication));
    if (!opened) throw const FormatException('Browser unavailable');
  }

  List<Map<String, Object?>> get providers {
    final all = frame?.providers ?? const [];
    return all
        .where(
          (provider) =>
              provider['kind'] == kind &&
              (widget.packageId == null ||
                  provider['packageId'] == widget.packageId),
        )
        .toList();
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
        .toList();
  }

  @override
  Widget build(BuildContext context) {
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
      final rows = providers;
      body = RefreshIndicator(
        onRefresh: load,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
          children: [
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
            _Centered(
              child: LayoutBuilder(
                builder: (context, constraints) {
                  // Two columns once there is room for two readable rows,
                  // as on a tablet or the desktop window; one on a phone.
                  final columns = constraints.maxWidth >= 640 ? 2 : 1;
                  const gap = 8.0;
                  final width =
                      (constraints.maxWidth - gap * (columns - 1)) / columns;
                  return Wrap(
                    spacing: gap,
                    runSpacing: gap,
                    children: [
                      if (!widget.models && widget.packageId == null)
                        SizedBox(
                          width: width,
                          child: _MacMessagesRow(page: widget),
                        ),
                      for (final (index, provider) in rows.indexed)
                        SizedBox(
                          width: width,
                          child: _ProviderRow(
                            index: index,
                            provider: provider,
                            accounts: accountsOf(provider),
                            models: widget.models,
                            busy: pending,
                            send: _send,
                            commandId: _commandId,
                          ),
                        ),
                    ],
                  );
                },
              ),
            ),
            if (rows.isEmpty)
              _Centered(
                child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Text(
                    widget.models
                        ? 'No model providers are turned on. Turn one on under Plugins to add an account.'
                        : 'Nothing to connect yet.',
                    style: theme.textTheme.bodyMedium,
                  ),
                ),
              ),
          ],
        ),
      );
    }
    return Scaffold(
      appBar: AppBar(
        title: Text(title),
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
      body: identified(
        ConnectorIds.document,
        SafeArea(top: false, child: body),
      ),
    );
  }
}

class _Centered extends StatelessWidget {
  final Widget child;
  const _Centered({required this.child});
  @override
  Widget build(BuildContext context) => Center(
    child: ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 680),
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

class _MacMessagesRow extends StatelessWidget {
  final ConnectionsPage page;
  const _MacMessagesRow({required this.page});
  @override
  Widget build(BuildContext context) => _Row(
    mark: const _IconTile(icon: Icons.message_outlined),
    title: 'Messages on your Mac',
    subtitle: 'Allow access to Messages through a connected Mac',
    trailing: Icon(
      Icons.chevron_right,
      color: Theme.of(context).colorScheme.onSurfaceVariant,
    ),
    onTap: () => Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => SettingsPage(
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

/// The 40-point mark at the head of a row: the app's own logo when the
/// deployment bundles one, otherwise a glyph — never a broken image.
class _IconTile extends StatelessWidget {
  final String? asset;
  final IconData icon;
  const _IconTile({this.asset, this.icon = Icons.link_rounded});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final Widget mark = asset == null
        ? Icon(icon, size: 22, color: scheme.onSurface)
        : Image.asset(
            'assets/connectors/$asset.png',
            width: 26,
            height: 26,
            filterQuality: FilterQuality.medium,
            errorBuilder: (_, _, _) =>
                Icon(icon, size: 22, color: scheme.onSurface),
          );
    // Brand marks are drawn for a light ground, so the tile is one in both
    // themes; a glyph of our own takes the surface colour instead.
    return Container(
      width: 40,
      height: 40,
      decoration: BoxDecoration(
        color: asset == null ? scheme.surfaceContainerHighest : Colors.white,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: scheme.outlineVariant),
      ),
      alignment: Alignment.center,
      child: ExcludeSemantics(child: mark),
    );
  }
}

/// The small pill at the end of a row: the way in when nothing is
/// connected, the state once something is.
class _Pill extends StatelessWidget {
  final String label;
  final IconData? icon;
  final bool primary;
  final VoidCallback? onPressed;
  const _Pill({
    required this.label,
    this.icon,
    this.primary = false,
    this.onPressed,
  });

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final style = ButtonStyle(
      visualDensity: VisualDensity.compact,
      padding: const WidgetStatePropertyAll(
        EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      ),
      minimumSize: const WidgetStatePropertyAll(Size(0, 32)),
      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
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
    return primary
        ? FilledButton(onPressed: onPressed, style: style, child: text)
        : FilledButton.tonal(onPressed: onPressed, style: style, child: text);
  }
}

class _ProviderRow extends StatefulWidget {
  final int index;
  final Map<String, Object?> provider;
  final List<Map<String, Object?>> accounts;
  final bool models;
  final bool busy;
  final Future<void> Function(Map<String, Object?> command) send;
  final String Function() commandId;
  const _ProviderRow({
    required this.index,
    required this.provider,
    required this.accounts,
    required this.models,
    required this.busy,
    required this.send,
    required this.commandId,
  });

  @override
  State<_ProviderRow> createState() => _ProviderRowState();
}

class _ProviderRowState extends State<_ProviderRow> {
  bool open = false;
  bool adding = false;

  Map<String, Object?> get provider => widget.provider;
  String get displayName => provider['displayName'] as String;
  String get authorization => provider['authorization'] as String;
  bool get mayConnect => provider['mayConnect'] == true;
  int get connected => (provider['connected'] as num?)?.toInt() ?? 0;
  bool get hasAccounts => widget.accounts.isNotEmpty;

  Map<String, Object?> _command(String kind, Map<String, Object?> input) => {
    'commandId': widget.commandId(),
    'input': {
      'kind': kind,
      'packageId': provider['packageId'],
      'connectionTypeId': provider['connectionTypeId'],
      ...input,
    },
  };

  /// The way in, when the row is not yet connected: a hosted grant opens the
  /// app's sign-in at once, a keyed provider opens its form, and one that
  /// needs nothing is simply turned on.
  void _begin() {
    switch (authorization) {
      case 'grant':
        unawaited(widget.send(_command('authorize', const {})));
      case 'api-key':
        setState(() {
          open = true;
          adding = true;
        });
      case 'none':
        unawaited(
          widget.send(_command('enable-connection', {'label': displayName})),
        );
    }
  }

  Widget? _trailing() {
    if (hasAccounts) {
      final ready = widget.accounts.where((a) => a['state'] == 'ready').length;
      final failed = widget.accounts.any(
        (a) =>
            a['state'] == 'failed' || a['state'] == 'reconciliation-required',
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
    if (!mayConnect) return null;
    return _Pill(
      label: 'Connect',
      primary: true,
      onPressed: widget.busy ? null : _begin,
    );
  }

  @override
  Widget build(BuildContext context) {
    final description = provider['description'] as String?;
    final subtitle =
        description ??
        (connected == 0
            ? null
            : connected == 1
            ? '1 account connected'
            : '$connected accounts connected');
    return identified(
      ConnectorIds.group(displayName),
      _Row(
        mark: _IconTile(
          asset: provider['icon'] as String?,
          icon: widget.models
              ? Icons.auto_awesome_outlined
              : Icons.link_rounded,
        ),
        title: displayName,
        subtitle: subtitle,
        trailing: _trailing(),
        onTap: hasAccounts || (mayConnect && authorization == 'api-key')
            ? () => setState(() => open = !open)
            : null,
        open: open,
        below: _details(context),
      ),
    );
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
        if (mayConnect && authorization == 'grant' && hasAccounts)
          Align(
            alignment: Alignment.centerLeft,
            child: Padding(
              padding: const EdgeInsets.only(top: 4),
              child: identified(
                ConnectorIds.action('authorize-${widget.index}'),
                TextButton.icon(
                  onPressed: widget.busy
                      ? null
                      : () => widget.send(_command('authorize', const {})),
                  icon: const Icon(Icons.add_rounded, size: 18),
                  label: const Text('Add another account'),
                ),
              ),
            ),
          ),
        if (mayConnect && authorization == 'api-key')
          if (adding)
            _ApiKeyForm(
              index: widget.index,
              provider: provider,
              submitLabel: connected == 0
                  ? 'Connect account'
                  : 'Add another account',
              busy: widget.busy,
              onCancel: () => setState(() => adding = false),
              onSubmit: (values) async {
                await widget.send(_command('connect-api-key', values));
                if (mounted) setState(() => adding = false);
              },
            )
          else if (hasAccounts)
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton.icon(
                onPressed: widget.busy
                    ? null
                    : () => setState(() => adding = true),
                icon: const Icon(Icons.add_rounded, size: 18),
                label: const Text('Add another account'),
              ),
            ),
        if (widget.accounts.isEmpty && !adding)
          Text(
            'Nothing connected yet.',
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
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
    'ready' => const Color(0xff46c184),
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
    final id = account['id'] as String;
    final failure = account['failure'] as String?;
    final items = <PopupMenuEntry<String>>[
      if (models &&
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
          value: authorization == 'api-key' || models ? 'disconnect' : 'revoke',
          child: Text('Disconnect', style: TextStyle(color: scheme.error)),
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
        TextField(
          controller: name,
          enabled: !widget.busy,
          decoration: const InputDecoration(
            labelText: 'Account name',
            counterText: '',
          ),
          maxLength: 120,
          textInputAction: TextInputAction.next,
        ),
        const SizedBox(height: 12),
        TextField(
          controller: key,
          enabled: !widget.busy,
          obscureText: true,
          autocorrect: false,
          enableSuggestions: false,
          decoration: const InputDecoration(labelText: 'API key'),
          textInputAction: TextInputAction.done,
          onSubmitted: (_) => _submit(),
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
