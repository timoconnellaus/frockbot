import 'package:flutter/material.dart';

import '../brand.dart';
import '../client/discovery.dart';
import '../shell/semantics.dart';

/// "Use another server": the person types a server's address, and the app
/// reads what that server is before offering to sign in to it.
class ServerAddressPage extends StatefulWidget {
  /// Reads the server at an address, or throws [ServerRefused] saying why
  /// this app cannot sign in to it.
  final Future<ServerDiscovery> Function(String address) discover;
  final void Function(ServerDiscovery server) onFound;
  final VoidCallback onBack;
  const ServerAddressPage({
    super.key,
    required this.discover,
    required this.onFound,
    required this.onBack,
  });

  @override
  State<ServerAddressPage> createState() => _ServerAddressPageState();
}

class _ServerAddressPageState extends State<ServerAddressPage> {
  final address = TextEditingController();
  bool busy = false;
  String? error;

  Future<void> check() async {
    if (busy) return;
    setState(() {
      busy = true;
      error = null;
    });
    try {
      final server = await widget.discover(address.text);
      if (mounted) widget.onFound(server);
    } on ServerRefused catch (refused) {
      if (mounted) setState(() => error = refused.message);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  void dispose() {
    address.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(
        automaticallyImplyLeading: false,
        backgroundColor: Colors.transparent,
        leading: IconButton(
          tooltip: 'Back',
          icon: const Icon(Icons.arrow_back_rounded),
          onPressed: busy ? null : widget.onBack,
        ),
      ),
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 400),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    'Use another server',
                    style: theme.textTheme.headlineSmall,
                  ),
                  const SizedBox(height: 8),
                  Text(
                    'Sign in to a ${clientBrand.productName} server someone '
                    'runs themselves. You can switch between it and your '
                    'other accounts at any time.',
                    style: theme.textTheme.bodyMedium?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                  const SizedBox(height: 24),
                  identified(
                    SignInIds.serverAddress,
                    TextField(
                      controller: address,
                      enabled: !busy,
                      autofocus: true,
                      autocorrect: false,
                      enableSuggestions: false,
                      keyboardType: TextInputType.url,
                      textInputAction: TextInputAction.go,
                      onSubmitted: (_) => check(),
                      decoration: InputDecoration(
                        labelText: 'Server address',
                        hintText: 'bot.example.com',
                        errorText: error,
                        errorMaxLines: 4,
                      ),
                    ),
                  ),
                  const SizedBox(height: 20),
                  identified(
                    SignInIds.serverCheck,
                    FilledButton(
                      onPressed: busy ? null : check,
                      child: Text(busy ? 'Checking…' : 'Continue'),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
