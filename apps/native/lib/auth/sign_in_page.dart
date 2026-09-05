import 'package:flutter/material.dart';

import '../theme/frock_theme.dart';

class SignInPage extends StatelessWidget {
  final bool busy;
  final bool awaitingBrowser;
  final String? error;
  final VoidCallback onSignIn;
  const SignInPage({
    super.key,
    required this.busy,
    required this.awaitingBrowser,
    required this.error,
    required this.onSignIn,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      body: DecoratedBox(
        decoration: BoxDecoration(
          gradient: RadialGradient(
            center: const Alignment(0, -0.7),
            radius: 1.1,
            colors: [
              FrockTheme.accent.withValues(alpha: 0.12),
              theme.scaffoldBackgroundColor,
            ],
          ),
        ),
        child: SafeArea(
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
                          const Center(child: SheepAvatar(size: 112)),
                          const SizedBox(height: 24),
                          Text(
                            'FrockBot',
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
                                    child: FilledButton.icon(
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
                                            : 'Continue with Google',
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
                                              error ?? 'Complete Google sign-in, then return here. If you closed the browser, you can open sign-in again.',
                                              style: theme.textTheme.bodyMedium,
                                            ),
                                          ],
                                        ),
                                      ),
                                    ),
                                  )
                                : const SizedBox.shrink(),
                          ),
                          const SizedBox(height: 24),
                          Text(
                            'Secure sign-in with Google.\nYour conversations stay with your account.',
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
