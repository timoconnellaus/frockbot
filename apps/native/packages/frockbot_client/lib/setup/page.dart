/// Setup: the account's one place for its plan, Computer, AI, web search,
/// connected apps and accounts, drawn by the web page `/setup` and framed
/// here.
///
/// The frame carries no session. The app mints a reader credential for this
/// one opening (`POST /api/setup/frame`), which the page reads the account
/// with; when it runs out the page asks, and the app mints another. The page
/// cannot open a browser or come back to the app by itself, so it asks for
/// those too: an app's sign-in, a server's, a payment page, and leaving.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../client/transport.dart';
import '../connections/document.dart';
import '../connections/door.dart';
import '../shell/semantics.dart';
import '../theme/states.dart';
import '../view/host_frame.dart';

/// The pages `/setup` draws, as its addresses name them.
enum SetupPageId { overview, plan, computer, ai, search, apps, accounts }

/// The credential out of a minted address, which carries it in its fragment.
String? setupReaderOfV1(String url) {
  final fragment = Uri.tryParse(url)?.fragment ?? '';
  final token = Uri.splitQueryString(fragment)['reader'];
  return token != null && RegExp(r'^[A-Za-z0-9_.-]{1,1024}$').hasMatch(token)
      ? token
      : null;
}

/// An address the page may ask the app to open: the deployment's own, or an
/// https page on a host that is not an IP literal with credentials in it.
Uri? setupOutboundUriV1(Object? value) {
  if (value is! String) return null;
  final uri = Uri.tryParse(value);
  if (uri == null || uri.userInfo.isNotEmpty || uri.host.isEmpty) return null;
  final origin = Uri.parse(hostedOrigin);
  if (uri.origin == origin.origin) return uri;
  return uri.scheme == 'https' ? uri : null;
}

class SetupPage extends StatefulWidget {
  final NativeApi api;
  final SetupPageId page;

  /// Leaving Setup: back to the Bots.
  final VoidCallback? onClose;

  /// Something the page changed may change what a Bot offers.
  final VoidCallback? onChanged;

  /// For tests: how an outside page opens.
  final Future<bool> Function(Uri)? openBrowser;

  /// For tests: the frame, given its address and the page's messages.
  final Widget Function(
    String url,
    Future<void> Function(Map<String, Object?>) onMessage,
    Stream<Map<String, Object?>> outbox,
  )?
  frameBuilder;

  const SetupPage({
    super.key,
    required this.api,
    this.page = SetupPageId.overview,
    this.onClose,
    this.onChanged,
    this.openBrowser,
    this.frameBuilder,
  });

  @override
  State<SetupPage> createState() => _SetupPageState();
}

class _SetupPageState extends State<SetupPage> with WidgetsBindingObserver {
  final outbox = StreamController<Map<String, Object?>>.broadcast();
  String? url;
  String? problem;
  bool changed = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    connectReturns.addListener(_refresh);
    unawaited(_open());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    connectReturns.removeListener(_refresh);
    unawaited(outbox.close());
    if (changed) widget.onChanged?.call();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // Back from a sign-in or a payment in the browser: what it did is read
    // again rather than waited for.
    if (state == AppLifecycleState.resumed) _refresh();
  }

  void _refresh() => _post({'type': 'refresh'});

  void _post(Map<String, Object?> message) {
    if (outbox.isClosed) return;
    outbox.add({'frockbotSetupHost': 1, ...message});
  }

  Future<String> _mint() async {
    final answer = await widget.api.request(
      '/api/setup/frame',
      body: {
        'schemaVersion': 1,
        if (widget.page != SetupPageId.overview) 'page': widget.page.name,
      },
    );
    final minted = answer is Map ? answer['url'] : null;
    if (minted is! String || setupReaderOfV1(minted) == null) {
      throw const FormatException('Setup is unavailable');
    }
    return minted;
  }

  Future<void> _open() async {
    setState(() => problem = null);
    try {
      final minted = await _mint();
      if (mounted) setState(() => url = minted);
    } catch (_) {
      if (mounted) {
        setState(
          () => problem =
              'Setup couldn’t open. Check your connection and try again.',
        );
      }
    }
  }

  Future<void> _onMessage(Map<String, Object?> message) async {
    if (message['frockbotSetup'] != 1) return;
    switch (message['type']) {
      case 'close':
        _close();
      case 'renew':
        try {
          final token = setupReaderOfV1(await _mint());
          if (token != null) _post({'type': 'reader', 'token': token});
        } catch (_) {
          // Unanswered, the page says it has expired.
        }
      case 'open':
        final uri = setupOutboundUriV1(message['url']);
        if (uri != null) {
          await (widget.openBrowser?.call(uri) ??
              launchUrl(uri, mode: LaunchMode.externalApplication));
        }
        _post({'type': 'opened'});
      case 'connect':
        changed = true;
        await _door(
          () => openConnectionDoorV1(widget.api, {
            'commandId': message['commandId'],
            'input': {
              'kind': 'authorize',
              'packageId': message['packageId'],
              'connectionTypeId': message['connectionTypeId'],
            },
          }, openBrowser: widget.openBrowser),
        );
      case 'mcp-sign-in':
        changed = true;
        await _door(
          () => openMcpSignInV1(widget.api, {
            'commandId': message['commandId'],
            'input': {
              'kind': 'sign-in',
              'packageId': mcpPackageIdV1,
              'connectionId': message['connectionId'],
            },
          }, openBrowser: widget.openBrowser),
        );
      case 'ready':
        changed = true;
    }
  }

  Future<void> _door(Future<bool> Function() open) async {
    try {
      await open();
      _post({'type': 'door', 'ok': true});
    } on FormatException catch (error) {
      _post({'type': 'door', 'ok': false, 'message': error.message});
    } catch (_) {
      _post({
        'type': 'door',
        'ok': false,
        'message': 'The sign-in didn’t open. Try again.',
      });
    }
  }

  void _close() {
    final close = widget.onClose;
    if (close != null) {
      close();
    } else {
      unawaited(Navigator.of(context).maybePop());
    }
  }

  @override
  Widget build(BuildContext context) {
    final address = url;
    if (address == null) {
      // Until the page draws its own way out, the app offers one.
      return Semantics(
        identifier: SetupIds.page,
        container: true,
        child: Scaffold(
          appBar: AppBar(
            title: const Text('Setup'),
            leading: IconButton(
              tooltip: 'Close',
              icon: const Icon(Icons.close_rounded),
              onPressed: _close,
            ),
          ),
          body: problem == null
              ? const FrockLoading(label: 'Opening Setup')
              : FrockEmptyState(
                  icon: Icons.cloud_off_rounded,
                  title: 'Setup couldn’t open',
                  detail: problem!,
                  action: 'Try again',
                  onAction: () => unawaited(_open()),
                ),
        ),
      );
    }
    final body =
        widget.frameBuilder?.call(address, _onMessage, outbox.stream) ??
        HostFrame(
          url: address,
          label: 'Setup',
          identity: address,
          allowSameOrigin: true,
          borderRadius: BorderRadius.zero,
          onMessage: (message) => unawaited(_onMessage(message)),
          outbox: outbox.stream,
        );
    return Semantics(
      identifier: SetupIds.page,
      container: true,
      child: Scaffold(body: SafeArea(child: body)),
    );
  }
}
