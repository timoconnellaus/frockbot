import '../character/catalog.dart';
import '../client/auth.dart';
import '../product_config.dart';
import '../theme/tokens.dart';

/// FrockBot's own product. A second product writes a different [ProductConfig];
/// this one is what `main.dart` passes so the pixels do not move.
const frockbotProduct = ProductConfig(
  name: 'FrockBot',
  origin: '',
  theme: ProductThemeTokens.frockbot,
  characters: frockbotCharacterCatalogV1,
  defaultCharacterId: defaultFrockbotCharacterIdV1,
  strings: ProductStrings(
    tagline: 'Your Bots, with you.',
    pitch:
        'A little help. A lot of possibility.\nPick up right where you left off.',
    unreachable: 'Couldn’t reach FrockBot. Please try again.',
    signInFailed: 'Couldn’t finish signing in. Please try again.',
    signInOpenFailed: 'Couldn’t open sign-in. Please try again.',
    signOutFailed: 'Couldn’t sign out. Please reconnect and try again.',
    deepLinkFailed: 'Couldn’t open that sign-in link. Please try again.',
  ),
  signIn: signInV1,
);
