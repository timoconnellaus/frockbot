import 'package:flutter/material.dart';

import '../brand.dart';
import '../client/auth.dart';
import '../client/discovery.dart';
import '../flock/avatar.dart';
import '../shell/semantics.dart';

import '../theme/frock_theme.dart';

class SignInPage extends StatelessWidget {
  final bool busy;
  final bool awaitingBrowser;
  final String? error;
  final VoidCallback onSignIn;

  /// The server a person chose under "Use another server", which this page
  /// then signs in to; null is the deployment the build names.
  final ServerDiscovery? server;

  /// Opens the server address page. Null where there is no choice to make:
  /// a browser is signed in to the origin that served it.
  final VoidCallback? onUseAnotherServer;

  /// Goes back to the account on screen, when this page is adding another.
  final VoidCallback? onCancel;
  const SignInPage({
    super.key,
    required this.busy,
    required this.awaitingBrowser,
    required this.error,
    required this.onSignIn,
    this.server,
    this.onUseAnotherServer,
    this.onCancel,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final server = this.server;
    // Who the person signs in with is known for the build's own deployment
    // alone; another server's is whatever its owner set up.
    final provider = server == null ? clientBrand.signInProvider : null;
    return Scaffold(
      appBar: onCancel == null
          ? null
          : AppBar(
              automaticallyImplyLeading: false,
              backgroundColor: Colors.transparent,
              leading: identified(
                SignInIds.cancel,
                IconButton(
                  tooltip: 'Back',
                  icon: const Icon(Icons.close_rounded),
                  onPressed: onCancel,
                ),
              ),
            ),
      body: identified(
        SignInIds.page,
        SafeArea(
          child: LayoutBuilder(
            builder: (context, constraints) => SingleChildScrollView(
              child: ConstrainedBox(
                constraints: BoxConstraints(minHeight: constraints.maxHeight),
                child: Center(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 28,
                      vertical: 40,
                    ),
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 400),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          Center(
                            child: switch (clientBrand.signInIcon) {
                              final icon? => Image(
                                image: icon,
                                width: 112,
                                height: 112,
                                excludeFromSemantics: true,
                              ),
                              null => const CharacterAvatar(size: 112),
                            },
                          ),
                          const SizedBox(height: 24),
                          Text(
                            clientBrand.productName,
                            textAlign: TextAlign.center,
                            style: theme.textTheme.displaySmall,
                          ),
                          const SizedBox(height: 12),
                          Text(
                            'Your Bots, with you.',
                            textAlign: TextAlign.center,
                            style: theme.textTheme.titleLarge,
                          ),
                          const SizedBox(height: 12),
                          Text(
                            'A little help. A lot of possibility.\nPick up right where you left off.',
                            textAlign: TextAlign.center,
                            style: theme.textTheme.bodyLarge?.copyWith(
                              color: theme.colorScheme.onSurfaceVariant,
                            ),
                          ),
                          if (server != null) ...[
                            const SizedBox(height: 24),
                            ServerCard(server: server),
                          ],
                          const SizedBox(height: 36),
                          AnimatedSwitcher(
                            duration: FrockTheme.motion(context),
                            child: busy
                                ? Semantics(
                                    key: ValueKey('sign-in-loading'),
                                    label: 'Preparing secure sign-in',
                                    liveRegion: true,
                                    child: FrockSkeleton(height: 52),
                                  )
                                : SizedBox(
                                    width: double.infinity,
                                    child: identified(
                                      SignInIds.submit,
                                      FilledButton.icon(
                                        key: const ValueKey('sign-in'),
                                        onPressed: onSignIn,
                                        icon: const Icon(
                                          Icons.open_in_new_rounded,
                                          size: 18,
                                        ),
                                        label: Text(
                                          error != null
                                              ? 'Try sign-in again'
                                              : awaitingBrowser
                                              ? 'Open sign-in again'
                                              : developmentAuth
                                              ? 'Continue as local developer'
                                              : provider == null
                                              ? 'Continue to sign in'
                                              : 'Continue with $provider',
                                        ),
                                      ),
                                    ),
                                  ),
                          ),
                          AnimatedSwitcher(
                            duration: FrockTheme.motion(context),
                            child: error != null || awaitingBrowser
                                ? Padding(
                                    padding: const EdgeInsets.only(top: 20),
                                    child: Semantics(
                                      identifier: SignInIds.note,
                                      liveRegion: true,
                                      child: Container(
                                        padding: const EdgeInsets.all(16),
                                        decoration: BoxDecoration(
                                          color: theme.colorScheme.surface,
                                          borderRadius: BorderRadius.circular(
                                            14,
                                          ),
                                          border: Border.all(
                                            color: theme
                                                .colorScheme
                                                .outlineVariant,
                                          ),
                                        ),
                                        child: Column(
                                          crossAxisAlignment:
                                              CrossAxisAlignment.start,
                                          children: [
                                            Text(
                                              error != null
                                                  ? 'Let’s get you connected'
                                                  : 'Finish in your browser',
                                              style: theme.textTheme.titleSmall,
                                            ),
                                            const SizedBox(height: 6),
                                            Text(
                                              error ??
                                                  'Complete ${provider == null ? 'sign-in' : '$provider sign-in'}, then return here. If you closed the browser, you can open sign-in again.',
                                              style: theme.textTheme.bodyMedium,
                                            ),
                                          ],
                                        ),
                                      ),
                                    ),
                                  )
                                : const SizedBox.shrink(),
                          ),
                          if (onUseAnotherServer case final VoidCallback other
                              when !busy) ...[
                            const SizedBox(height: 8),
                            identified(
                              SignInIds.otherServer,
                              TextButton(
                                onPressed: other,
                                child: Text(
                                  server == null
                                      ? 'Use another server'
                                      : 'Use a different server',
                                ),
                              ),
                            ),
                          ],
                          const SizedBox(height: 24),
                          Text(
                            '${provider == null ? 'Secure sign-in.' : 'Secure sign-in with $provider.'}\nYour conversations stay with your account.',
                            textAlign: TextAlign.center,
                            style: theme.textTheme.bodySmall,
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Which server a sign-in is going to, as the server described itself.
class ServerCard extends StatelessWidget {
  final ServerDiscovery server;
  const ServerCard({super.key, required this.server});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final version = server.version;
    return Semantics(
      container: true,
      label:
          'Signing in to ${server.name} at ${server.host}'
          '${version == null ? '' : ', version $version'}',
      excludeSemantics: true,
      child: Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: theme.colorScheme.surface,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: theme.colorScheme.outlineVariant),
        ),
        child: Row(
          children: [
            Icon(Icons.dns_outlined, color: theme.colorScheme.primary),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(server.host, style: theme.textTheme.titleSmall),
                  const SizedBox(height: 2),
                  Text(
                    version == null ? server.name : '${server.name} $version',
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
