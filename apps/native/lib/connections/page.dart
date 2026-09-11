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
      setState(
        () => loadFailure = 'Couldn’t load your connectors. Check your connection and try again.',
      );
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

  List<Map<String, Object?>> accountsOf(Map<String, Object?> provider) =>
      (frame?.accounts ?? const [])
          .where(
            (account) =>
                account['packageId'] == provider['packageId'] &&
                (account['connectionTypeId'] == null ||
                    account['connectionTypeId'] ==
                        provider['connectionTypeId']),
          )
          .toList();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final frame = this.frame;
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
            if (notice case final String line)
              _Notice(
                line: line,
                onDismiss: () => setState(() => notice = null),
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
            if (!widget.models && widget.packageId == null)
              _Centered(child: _MacMessagesTile(page: widget)),
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
            for (final (index, provider) in rows.indexed)
              _Centered(
                child: _ProviderCard(
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

class _MacMessagesTile extends StatelessWidget {
  final ConnectionsPage page;
  const _MacMessagesTile({required this.page});
  @override
  Widget build(BuildContext context) => Card(
    margin: const EdgeInsets.only(bottom: 12),
    child: ListTile(
      leading: const _IconTile(icon: Icons.message_outlined),
      title: const Text('Messages on your Mac'),
      subtitle: const Text('Allow access to Messages through a connected Mac'),
      trailing: const Icon(Icons.chevron_right),
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
    ),
  );
}

/// The 44-point mark at the head of a card: the app's own logo when the
/// deployment bundles one, otherwise a glyph — never a broken image.
class _IconTile extends StatelessWidget {
  final String? asset;
  final IconData icon;
  const _IconTile({this.asset, this.icon = Icons.link_rounded});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final Widget mark = asset == null
        ? Icon(icon, size: 24, color: scheme.onSurface)
        : Image.asset(
            'assets/connectors/$asset.png',
            width: 28,
            height: 28,
            filterQuality: FilterQuality.medium,
            errorBuilder: (_, _, _) =>
                Icon(icon, size: 24, color: scheme.onSurface),
          );
    // Brand marks are drawn for a light ground, so the tile is one in both
    // themes; a glyph of our own takes the surface colour instead.
    return Container(
      width: 44,
      height: 44,
      decoration: BoxDecoration(
        color: asset == null ? scheme.surfaceContainerHighest : Colors.white,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: scheme.outlineVariant),
      ),
      alignment: Alignment.center,
      child: ExcludeSemantics(child: mark),
    );
  }
}

class _ProviderCard extends StatefulWidget {
  final int index;
  final Map<String, Object?> provider;
  final List<Map<String, Object?>> accounts;
  final bool models;
  final bool busy;
  final Future<void> Function(Map<String, Object?> command) send;
  final String Function() commandId;
  const _ProviderCard({
    required this.index,
    required this.provider,
    required this.accounts,
    required this.models,
    required this.busy,
    required this.send,
    required this.commandId,
  });

  @override
  State<_ProviderCard> createState() => _ProviderCardState();
}

class _ProviderCardState extends State<_ProviderCard> {
  bool adding = false;

  Map<String, Object?> get provider => widget.provider;
  String get displayName => provider['displayName'] as String;
  String get authorization => provider['authorization'] as String;
  bool get mayConnect => provider['mayConnect'] == true;
  int get connected => (provider['connected'] as num?)?.toInt() ?? 0;

  Map<String, Object?> _command(String kind, Map<String, Object?> input) => {
    'commandId': widget.commandId(),
    'input': {
      'kind': kind,
      'packageId': provider['packageId'],
      'connectionTypeId': provider['connectionTypeId'],
      ...input,
    },
  };

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final description = provider['description'] as String?;
    final countLine = connected == 0
        ? 'No account connected'
        : connected == 1
        ? '1 account connected'
        : '$connected accounts connected';
    return identified(
      ConnectorIds.group(displayName),
      Card(
        margin: const EdgeInsets.only(bottom: 12),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _IconTile(
                    asset: provider['icon'] as String?,
                    icon: widget.models
                        ? Icons.auto_awesome_outlined
                        : Icons.link_rounded,
                  ),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Semantics(
                          header: true,
                          child: Text(
                            displayName,
                            style: theme.textTheme.titleMedium,
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          description ?? countLine,
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: theme.colorScheme.onSurfaceVariant,
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
              if (widget.accounts.isNotEmpty) ...[
                const SizedBox(height: 12),
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
              ] else if (description != null) ...[
                const SizedBox(height: 8),
                Text(
                  countLine,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
              const SizedBox(height: 12),
              ..._footer(context),
            ],
          ),
        ),
      ),
    );
  }

  List<Widget> _footer(BuildContext context) {
    if (!mayConnect) return const [];
    switch (authorization) {
      case 'grant':
        final button = connected == 0
            ? FilledButton.icon(
                onPressed: widget.busy
                    ? null
                    : () => widget.send(_command('authorize', const {})),
                icon: const Icon(Icons.open_in_new_rounded, size: 18),
                label: const Text('Connect'),
              )
            : FilledButton.tonalIcon(
                onPressed: widget.busy
                    ? null
                    : () => widget.send(_command('authorize', const {})),
                icon: const Icon(Icons.add_rounded, size: 18),
                label: const Text('Add another account'),
              );
        return [
          Align(
            alignment: Alignment.centerLeft,
            child: identified(
              ConnectorIds.action('authorize-${widget.index}'),
              button,
            ),
          ),
        ];
      case 'api-key':
        final label = connected == 0
            ? 'Connect account'
            : 'Add another account';
        if (!adding) {
          return [
            Align(
              alignment: Alignment.centerLeft,
              child: FilledButton.tonalIcon(
                onPressed: widget.busy
                    ? null
                    : () => setState(() => adding = true),
                icon: Icon(
                  connected == 0 ? Icons.key_rounded : Icons.add_rounded,
                  size: 18,
                ),
                label: Text(label),
              ),
            ),
          ];
        }
        return [
          _ApiKeyForm(
            index: widget.index,
            provider: provider,
            submitLabel: label,
            busy: widget.busy,
            onCancel: () => setState(() => adding = false),
            onSubmit: (values) async {
              await widget.send(_command('connect-api-key', values));
              if (mounted) setState(() => adding = false);
            },
          ),
        ];
      case 'none':
        if (connected > 0) return const [];
        return [
          Align(
            alignment: Alignment.centerLeft,
            child: FilledButton.tonal(
              onPressed: widget.busy
                  ? null
                  : () => widget.send(
                      _command('enable-connection', {'label': displayName}),
                    ),
              child: const Text('Turn on for every Bot'),
            ),
          ),
        ];
      default:
        return const [];
    }
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
        Row(
          children: [
            identified(
              ConnectorIds.action('connect-${widget.index}'),
              FilledButton(
                onPressed: widget.busy ? null : _submit,
                child: Text(widget.submitLabel),
              ),
            ),
            const SizedBox(width: 8),
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
