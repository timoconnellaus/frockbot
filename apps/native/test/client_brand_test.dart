import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_client/app.dart';
import 'package:frockbot_client/auth/sign_in_page.dart';
import 'package:frockbot_client/brand.dart';
import 'package:frockbot_client/client/auth_io.dart';
import 'package:frockbot_client/client/transport.dart';
import 'package:frockbot_client/connections/document.dart';
import 'package:frockbot_client/flock/avatar.dart';
import 'package:frockbot_client/flock/create.dart';
import 'package:frockbot_client/theme/document.dart';
import 'package:frockbot_client/theme/frock_theme.dart';
import 'package:frockbot_client/voice/appearance.dart';
import 'package:frockbot_native/brand.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'widget_test.dart' show MemoryStore;

/// A white-label's brand: another name, one still-only character of its own,
/// its own scheme and looks, no sign-in provider and no release channel. Its
/// looks are DexBot's navy with an accent only dark type reads on. Its
/// character borrows a still this application bundles, under an id FrockBot
/// does not have.
const coinfolk = ClientBrand(
  productName: 'Coinfolk',
  builtInModelName: 'Coin AI',
  defaultCharacterId: 'coin',
  nativeScheme: 'coinfolk',
  looks: ClientLooks(
    ink: ThemeTokens(
      surfaces: ThemeSurfaces(
        window: Color(0xff111d28),
        surface: Color(0xff152231),
        raised: Color(0xff1c2d41),
        text: Color(0xffffffff),
        muted: Color(0xff91a2af),
        line: Color(0xff25394f),
        accent: Color(0xff4d9edc),
        onAccent: Color(0xff111d28),
      ),
      type: ThemeTypeface.manrope,
      botBubble: BotBubble.raised,
      meBubble: MeBubble.accent,
    ),
    paper: ThemeTokens(
      surfaces: _coinfolkPaper,
      type: ThemeTypeface.manrope,
      botBubble: BotBubble.raised,
      meBubble: MeBubble.tint,
    ),
    studio: ThemeTokens(
      surfaces: _coinfolkPaper,
      type: ThemeTypeface.manrope,
      botBubble: BotBubble.plain,
      meBubble: MeBubble.tint,
    ),
  ),
  accentSoft: Color(0xff9dc0ff),
  accentDeep: Color(0xff123a80),
  characters: [
    CharacterDefinition(
      'coin',
      'Coin',
      Color(0xffe0b43c),
      Color(0xffa07c1c),
      Color(0xfffff6df),
      ink: CharacterInk(
        canvasWidth: 457,
        canvasHeight: 615,
        left: 11,
        top: 146,
        width: 421,
        height: 438,
      ),
      still: 'assets/characters/sunny.png',
      voice: 'Kore',
    ),
  ],
);

const _coinfolkPaper = ThemeSurfaces(
  window: Color(0xfff4f7fa),
  surface: Color(0xffffffff),
  raised: Color(0xffe8eef3),
  text: Color(0xff111d28),
  muted: Color(0xff52616d),
  line: Color(0xffd8e1e8),
  accent: Color(0xff2a6fb0),
  onAccent: Color(0xffffffff),
);

ClientBrand coinfolkWith({String? nativeScheme, ClientLooks? looks}) =>
    ClientBrand(
      productName: coinfolk.productName,
      builtInModelName: coinfolk.builtInModelName,
      characters: coinfolk.characters,
      defaultCharacterId: coinfolk.defaultCharacterId,
      nativeScheme: nativeScheme ?? coinfolk.nativeScheme,
      looks: looks ?? coinfolk.looks,
      accentSoft: coinfolk.accentSoft,
      accentDeep: coinfolk.accentDeep,
    );

void wearing(ClientBrand brand) {
  installClientBrand(brand);
  addTearDown(() => installClientBrand(frockbotBrand));
}

/// Every asset key an [Image] on screen is drawing.
Set<String> stills(WidgetTester tester) => {
  for (final image in tester.widgetList<Image>(find.byType(Image)))
    if (image.image case final AssetImage asset) asset.assetName,
};

void withoutDeepLinks(WidgetTester tester) {
  final messenger = tester.binding.defaultBinaryMessenger;
  for (final channel in const [
    MethodChannel('com.llfbandit.app_links/events'),
    MethodChannel('com.llfbandit.app_links/messages'),
  ]) {
    messenger.setMockMethodCallHandler(channel, (_) async => null);
    addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
  }
}

Widget signInIn({bool awaitingBrowser = false}) => MaterialApp(
  theme: FrockTheme.theme(Brightness.dark),
  home: SignInPage(
    busy: false,
    awaitingBrowser: awaitingBrowser,
    error: null,
    onSignIn: () {},
  ),
);

Future<void> answer(WidgetTester tester) async {
  for (var round = 0; round < 4; round++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 20)),
    );
    await tester.pumpAndSettle();
  }
}

void main() {
  test('the catalog, the default and the voices are the brand’s', () {
    wearing(coinfolk);

    expect(characterCatalogV1.keys, ['coin']);
    expect(defaultCharacterIdV1, 'coin');
    expect(defaultAvatarAppearanceV1(), {
      'schemaVersion': 1,
      'characterId': 'coin',
      'primary': '#e0b43c',
    });
    // A FrockBot id this build lacks is drawn as the brand's own default.
    expect(defaultAvatarAppearanceV1('pixel')['characterId'], 'coin');
    expect(defaultGeminiVoiceForCharacterV1('coin'), 'Kore');
  });

  testWidgets('sign-in names the brand and draws its character', (
    tester,
  ) async {
    wearing(coinfolk);
    withoutDeepLinks(tester);
    final store = MemoryStore();
    final offline = NativeApi(
      store,
      client: MockClient((_) async => throw http.ClientException('offline')),
    );

    await tester.pumpWidget(FrockBotApp(store: store, api: offline));
    await answer(tester);

    expect(
      tester.widget<MaterialApp>(find.byType(MaterialApp)).title,
      'Coinfolk',
    );
    expect(find.byKey(const ValueKey('sign-in')), findsOneWidget);
    expect(find.text('Coinfolk'), findsOneWidget);
    expect(find.textContaining('Couldn’t reach Coinfolk'), findsOneWidget);
    expect(stills(tester), {'assets/characters/sunny.png'});
    expect(find.textContaining('FrockBot'), findsNothing);
    expect(find.bySemanticsLabel(RegExp('FrockBot')), findsNothing);
    expect(find.textContaining('Google'), findsNothing);
  });

  testWidgets('sign-in names no provider the brand does not', (tester) async {
    wearing(coinfolk);
    await tester.pumpWidget(signInIn());
    expect(find.text('Continue to sign in'), findsOneWidget);
    expect(find.textContaining('Secure sign-in.'), findsOneWidget);

    await tester.pumpWidget(signInIn(awaitingBrowser: true));
    await tester.pumpAndSettle();
    expect(find.textContaining('Complete sign-in, then'), findsOneWidget);
    expect(find.textContaining('Google'), findsNothing);
    expect(find.bySemanticsLabel(RegExp('Google')), findsNothing);
    expect(find.textContaining('FrockBot'), findsNothing);
  });

  testWidgets('FrockBot’s sign-in still names Google', (tester) async {
    await tester.pumpWidget(signInIn());
    expect(find.text('Continue with Google'), findsOneWidget);
    expect(find.textContaining('Secure sign-in with Google.'), findsOneWidget);

    await tester.pumpWidget(signInIn(awaitingBrowser: true));
    await tester.pumpAndSettle();
    expect(
      find.textContaining('Complete Google sign-in, then'),
      findsOneWidget,
    );
  });

  test('the looks and the accent are the brand’s', () {
    wearing(coinfolk);

    expect(ThemeDocument.ink.tokens, same(coinfolk.looks.ink));
    expect(ThemeDocument.paper.tokens, same(coinfolk.looks.paper));
    expect(ThemeDocument.studio.tokens, same(coinfolk.looks.studio));
    expect(
      namedLookDocument(
        resolveAccountNamedLook(AccountLook.system, Brightness.dark),
      ).tokens,
      same(coinfolk.looks.ink),
    );
    final dark = FrockTheme.theme(Brightness.dark);
    expect(dark.scaffoldBackgroundColor, const Color(0xff111d28));
    expect(dark.colorScheme.surface, const Color(0xff152231));
    expect(dark.colorScheme.primary, const Color(0xff4d9edc));
    expect(dark.colorScheme.onPrimary, const Color(0xff111d28));
    expect(
      FrockTheme.theme(Brightness.light).scaffoldBackgroundColor,
      const Color(0xfff4f7fa),
    );
    expect(FrockTheme.accent, const Color(0xff4d9edc));
    expect(FrockTheme.accentSoft, coinfolk.accentSoft);
    expect(FrockTheme.accentDeep, coinfolk.accentDeep);
  });

  test('a brand’s looks meet the contrast floor', () {
    final white = coinfolk.looks.ink.copyWith(
      surfaces: coinfolk.looks.ink.surfaces.copyWith(
        onAccent: const Color(0xffffffff),
      ),
    );
    final faint = coinfolk.looks.paper.copyWith(
      surfaces: coinfolk.looks.paper.surfaces.copyWith(
        muted: const Color(0xffc8d0d6),
      ),
    );
    for (final looks in [
      ClientLooks(
        ink: white,
        paper: coinfolk.looks.paper,
        studio: coinfolk.looks.studio,
      ),
      ClientLooks(
        ink: coinfolk.looks.ink,
        paper: coinfolk.looks.paper,
        studio: faint,
      ),
    ]) {
      expect(
        () => installClientBrand(coinfolkWith(looks: looks)),
        throwsArgumentError,
      );
    }
    expect(clientBrand.productName, 'FrockBot');
  });

  test('FrockBot’s looks are the server’s and its accent is unchanged', () {
    final source = File('../../core/theme/document.ts').readAsStringSync();
    Map<String, Object> server(String name) {
      final block = RegExp(
        'export const ${name}_TOKENS_V1: ThemeTokensV1 = \\{([\\s\\S]*?)\\n\\};',
      ).firstMatch(source)!.group(1)!;
      String field(String key) =>
          RegExp('$key: "([^"]+)"').firstMatch(block)!.group(1)!;
      return {
        'surfaces': {
          for (final surface in themeSurfaceFields)
            surface.name: field(surface.name),
        },
        'type': field('type'),
        'bubbles': {'bot': field('bot'), 'me': field('me')},
      };
    }

    expect(encodeThemeTokens(frockbotBrand.looks.ink), server('INK'));
    expect(encodeThemeTokens(frockbotBrand.looks.paper), server('PAPER'));
    expect(encodeThemeTokens(frockbotBrand.looks.studio), server('STUDIO'));
    expect(FrockTheme.accent, const Color(0xffd92d71));
    expect(FrockTheme.accentSoft, const Color(0xfffc85ae));
    expect(FrockTheme.accentDeep, const Color(0xff9a124c));
  });

  test('the app comes back on the brand’s scheme', () {
    expect(NativeSignIn.macosScheme, 'frockbot');
    expect(NativeSignIn.iosScheme, 'frockbot');
    expect(
      isConnectReturnV1(
        Uri.parse('frockbot://bot.frockbot.com/api/connect/callback/macos'),
      ),
      isTrue,
    );

    wearing(coinfolk);
    expect(NativeSignIn.macosScheme, 'coinfolk');
    expect(NativeSignIn.iosScheme, 'coinfolk');
    expect(
      isConnectReturnV1(
        Uri.parse('coinfolk://coinfolk.example/api/connect/callback/macos'),
      ),
      isTrue,
    );
    expect(
      isConnectReturnV1(
        Uri.parse('frockbot://coinfolk.example/api/connect/callback/macos'),
      ),
      isFalse,
    );
  });

  test(
    'FrockBot’s projects and server register the scheme its brand names',
    () {
      final scheme = frockbotBrand.nativeScheme;
      for (final path in const [
        'ios/Runner/Configs/AppInfo.xcconfig',
        'macos/Runner/Configs/AppInfo.xcconfig',
      ]) {
        expect(
          File(path).readAsStringSync(),
          contains('FROCKBOT_URL_SCHEME = $scheme\$('),
          reason: path,
        );
      }
      expect(
        File('android/app/src/debug/AndroidManifest.xml').readAsStringSync(),
        contains('android:scheme="$scheme-dev"'),
      );
      expect(
        File('../cloudflare/src/brand.ts').readAsStringSync(),
        contains('nativeScheme: "$scheme",'),
      );
    },
  );

  test('a brand names a scheme of its own', () {
    for (final scheme in ['https', 'Coin', '1coin', 'coin folk', '']) {
      expect(
        () => installClientBrand(coinfolkWith(nativeScheme: scheme)),
        throwsArgumentError,
        reason: scheme,
      );
    }
    expect(clientBrand.nativeScheme, 'frockbot');
  });

  testWidgets('a still-only character is drawn as its still', (tester) async {
    wearing(coinfolk);
    expect(coinfolk.characters.single.rive, isNull);

    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: const Scaffold(body: CharacterAvatar(characterId: 'coin')),
      ),
    );
    await tester.pumpAndSettle();

    expect(tester.takeException(), isNull);
    expect(stills(tester), {'assets/characters/sunny.png'});
  });

  testWidgets('the character picker offers only the brand’s cast', (
    tester,
  ) async {
    wearing(coinfolk);
    final store = MemoryStore();

    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: Scaffold(
          body: AvatarPickerSheet(
            api: NativeApi(store),
            botId: 'bot-1',
            botName: 'Penny',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.bySemanticsLabel('Coin'), findsOneWidget);
    expect(find.bySemanticsLabel('Pixel'), findsNothing);
    expect(stills(tester), {'assets/characters/sunny.png'});
    expect(find.textContaining('FrockBot'), findsNothing);
  });
}
