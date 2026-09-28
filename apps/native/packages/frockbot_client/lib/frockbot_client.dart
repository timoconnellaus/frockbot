/// What an application needs to run the client: its brand and the entry
/// point it passes that brand to (ADR 0038).
library;

export 'app.dart' show runFrockbot;
export 'brand.dart'
    show
        CharacterDefinition,
        CharacterInk,
        ClientBrand,
        ClientLooks,
        ClientReleaseChannel;
export 'theme/document.dart'
    show BotBubble, MeBubble, ThemeSurfaces, ThemeTokens, ThemeTypeface;
