import 'package:flutter/material.dart';

import '../theme/frock_theme.dart' show FrockSkeleton;
import '../ui/frock_tokens.dart';
import '../ui/frock_widgets.dart';

/// The door: the sheep under its glow, the name in the display face, one pink
/// pill. Everything else stays quiet until something needs saying.
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
    final t = FrockTokens.of(context);
    final motion = MediaQuery.disableAnimationsOf(context)
        ? Duration.zero
        : FrockTokens.enter;
    final notice = error != null || awaitingBrowser;
    return Scaffold(
      backgroundColor: t.window,
      body: SafeArea(
        child: LayoutBuilder(
          builder: (context, constraints) => SingleChildScrollView(
            child: ConstrainedBox(
              constraints: BoxConstraints(minHeight: constraints.maxHeight),
              child: Center(
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: FrockTokens.edge + 6,
                    vertical: 40,
                  ),
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 380),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        const SizedBox(
                          height: 140,
                          child: Stack(
                            alignment: Alignment.center,
                            clipBehavior: Clip.none,
                            children: [
                              FrockGlow(),
                              FrockSheep(size: FrockTokens.avatarHero),
                            ],
                          ),
                        ),
                        const SizedBox(height: 8),
                        Text(
                          'FrockBot',
                          textAlign: TextAlign.center,
                          style: t.displayStyle,
                        ),
                        const SizedBox(height: 8),
                        Text(
                          'Your Bots, with you.',
                          textAlign: TextAlign.center,
                          style: t.body.copyWith(color: t.ink2),
                        ),
                        const SizedBox(height: 32),
                        AnimatedSwitcher(
                          duration: motion,
                          child: busy
                              ? Semantics(
                                  key: const ValueKey('sign-in-loading'),
                                  label: 'Preparing secure sign-in',
                                  liveRegion: true,
                                  child: const FrockSkeleton(
                                    height: FrockTokens.controlLg,
                                  ),
                                )
                              : FrockPill(
                                  error != null
                                      ? 'Try sign-in again'
                                      : awaitingBrowser
                                      ? 'Open sign-in again'
                                      : 'Continue with Google',
                                  key: const ValueKey('sign-in'),
                                  kind: PillKind.primary,
                                  size: PillSize.lg,
                                  expand: true,
                                  onTap: onSignIn,
                                ),
                        ),
                        AnimatedSwitcher(
                          duration: motion,
                          child: notice
                              ? Padding(
                                  padding: const EdgeInsets.only(top: 16),
                                  child: Semantics(
                                    liveRegion: true,
                                    child: Container(
                                      padding: const EdgeInsets.fromLTRB(
                                        14,
                                        12,
                                        14,
                                        12,
                                      ),
                                      decoration: BoxDecoration(
                                        color: t.sheet,
                                        borderRadius: BorderRadius.circular(
                                          FrockTokens.radiusField,
                                        ),
                                        border: Border.all(
                                          color: error != null
                                              ? t.danger.withValues(alpha: 0.35)
                                              : t.line,
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
                                            style: t.row,
                                          ),
                                          const SizedBox(height: 4),
                                          Text(
                                            error ?? 'Complete Google sign-in, then return here. If you closed the browser, you can open sign-in again.',
                                            style: t.body,
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
                          style: t.caption,
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
    );
  }
}
